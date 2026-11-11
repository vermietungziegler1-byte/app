'use strict';

// -------------------------------------------------------------
//  Dateinamen in Google Drive aufräumen
//
//  Vorschläge: Fotos und Kleinigkeiten nach Regeln (dokumente-namen.js), alles Unklare schlägt der Assistent vor —
//  nur am Namen, Ordner und an der Zuordnung, bei Scans ohne sprechenden Namen liest er vorher den Inhalt.
//  Umbenannt wird nur, wenn Louis in der App bestätigt, und nur, solange er „Umbenennen erlauben“ eingeschaltet hat
//  (dann hat die App von Google das Recht, Dateien zu bearbeiten). Jeder alte Name bleibt gemerkt: „Rückgängig“.
// -------------------------------------------------------------

const express = require('express');
const { db, holen, einstellung, standInhalt, mitFehler } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const google = require('./google');
const namen = require('./dokumente-namen');
const { intern } = require('./gdrive');

const app = express.Router();
const JE_ANFRAGE = 25;                      // so viele Dateien benennt eine Anfrage um — die Oberfläche schickt den Rest nach
const NAMEN_JE_LAUF = 60, SCANS_JE_LAUF = 10;
const GRUENDE = ['Code', 'Umlaute', 'Tippfehler', 'Kleinigkeit', 'Kopie', 'am Inhalt erkannt', 'Scan', 'unverändert'];

db.exec(`
  CREATE TABLE IF NOT EXISTS dok_namen (id TEXT PRIMARY KEY, alt TEXT, vorschlag TEXT, grund TEXT, erstellt INTEGER, ort TEXT);
  CREATE TABLE IF NOT EXISTS dok_umbenannt (nr INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, alt TEXT, neu TEXT, stapel TEXT, wann INTEGER,
    zurueck INTEGER DEFAULT 0);
`);

// Objekt- und Wohnungsnamen für den Ort im Namen
function orte() {
  const s = standInhalt() || {};
  const o = {}, u = {};
  (s.objects || []).forEach(function (x) {
    o[x.id] = String(x.name || '').split(',')[0].trim();
    (x.units || []).forEach(function (e) { u[e.id] = { name: String(e.name || ''), mieter: String(e.tenant || '') }; });
  });
  return { o: o, u: u, s: s };
}
// Ort (Objekt und Wohnung) kommt nur in den Namen, wenn die Zuordnung feststeht — sonst schriebe ein Rateversuch
// sich selbst in den Dateinamen und sähe beim nächsten Abgleich wie eine sichere Zuordnung aus
function sicher(d) { return d.status === 'zugeordnet'; }
function ortVon(d, k) {
  if (!sicher(d)) return '';
  const obj = k.o[d.objekt] || '';
  const e = d.einheit && k.u[d.einheit] ? k.u[d.einheit].name : '';
  return (obj + (e ? ' ' + e : '')).trim();
}
function mieterVon(d, k) { return sicher(d) && d.einheit && k.u[d.einheit] ? k.u[d.einheit].mieter : ''; }
function dateienJetzt() {
  return db.prepare("SELECT id, name, pfad, eltern, mime, groesse, objekt, einheit, art, titel, datum, aufnahme, url, status FROM dok_dateien "
    + "WHERE status IN ('zugeordnet', 'pruefen', 'offen', 'unklar')").all();
}

// ---------------- Vorschläge ----------------
// Gleiche Vorschläge im selben Ordner auseinanderhalten: bei Fotos erst die Uhrzeit, sonst eine Nummer
function eindeutig(liste, dateien) {
  const belegt = new Map();
  dateien.forEach(function (d) {
    if (!belegt.has(d.eltern)) belegt.set(d.eltern, new Map());
    belegt.get(d.eltern).set(d.name.toLowerCase(), d.id);
  });
  const zaehlen = function () {
    const m = new Map();
    liste.forEach(function (z) { if (z.vorschlag) { const k = z.eltern + '|' + z.vorschlag.toLowerCase(); m.set(k, (m.get(k) || 0) + 1); } });
    return m;
  };
  // Fotos vom selben Tag am selben Ort: erst die Minute dazu, gibt es die auch mehrfach, die Sekunden
  let anzahl = zaehlen();
  liste.forEach(function (z) {
    if (z.vorschlag && z.uhr && anzahl.get(z.eltern + '|' + z.vorschlag.toLowerCase()) > 1) {
      z.ohneUhr = z.vorschlag;
      z.vorschlag = namen.stamm(z.vorschlag) + ' ' + z.uhr + namen.endung(z.vorschlag);
    }
  });
  anzahl = zaehlen();
  liste.forEach(function (z) {
    if (z.ohneUhr && z.sek && anzahl.get(z.eltern + '|' + z.vorschlag.toLowerCase()) > 1) {
      z.vorschlag = namen.stamm(z.ohneUhr) + ' ' + z.sek + namen.endung(z.ohneUhr);
    }
  });
  const vergeben = new Map();
  liste.forEach(function (z) {
    if (!z.vorschlag) return;
    if (!vergeben.has(z.eltern)) vergeben.set(z.eltern, new Set());
    const schon = vergeben.get(z.eltern), hier = belegt.get(z.eltern) || new Map();
    const frei = function (n) { const l = n.toLowerCase(); return !schon.has(l) && (!hier.has(l) || hier.get(l) === z.id); };
    const e = namen.endung(z.vorschlag);
    let n = z.vorschlag;
    const basis = namen.stamm(n);
    for (let i = 2; !frei(n) && i < 1000; i++) n = basis + ' ' + i + e;
    schon.add(n.toLowerCase());
    z.vorschlag = n;
    delete z.ohneUhr;
  });
}

function vorschlaege() {
  const k = orte();
  const dateien = dateienJetzt();
  const gespeichert = new Map(db.prepare('SELECT * FROM dok_namen').all().map(function (r) { return [r.id, r]; }));
  const doppelt = namen.dubletten(dateien);
  const mitAssistent = !!einstellung('anthropic_token');
  const liste = [];
  dateien.forEach(function (d) {
    const zeile = { id: d.id, alt: d.name, pfad: d.pfad, eltern: d.eltern, mime: d.mime, url: d.url, objekt: d.objekt || '', einheit: d.einheit || '',
      ort: ortVon(d, k) };
    if (doppelt.has(d.id)) { liste.push(Object.assign(zeile, { grund: 'doppelt', vorschlag: '', gruppe: doppelt.get(d.id) })); return; }
    const grund = namen.bewerten(d.name, d.mime);
    if (!grund) return;
    if (grund === 'Handyfoto') {
      const f = namen.fotoName(d, zeile.ort);
      liste.push(Object.assign(zeile, { grund: grund, vorschlag: f.name, uhr: f.uhr, sek: f.sek, quelle: 'regel' }));
      return;
    }
    const g = gespeichert.get(d.id);
    // Gilt nur, solange Name und Zuordnung noch dieselben sind wie beim Vorschlag
    if (g && g.alt === d.name && (g.ort || '') === zeile.ort) {
      // Der Assistent hat geantwortet — leer heißt: der Name ist in Ordnung
      if (g.vorschlag && g.vorschlag !== d.name) liste.push(Object.assign(zeile, { grund: g.grund || grund, vorschlag: g.vorschlag, quelle: 'assistent' }));
      return;
    }
    const v = namen.aufraeumen(d.name, grund === 'Kopie');
    liste.push(Object.assign(zeile, { grund: grund, vorschlag: v !== d.name ? v : '', quelle: 'regel', wartet: mitAssistent }));
  });
  const brauchbar = liste.filter(function (z) { return z.grund === 'doppelt' || z.vorschlag || z.wartet; });
  eindeutig(brauchbar, dateien);
  return brauchbar;
}

// ---------------- Assistent: Namen vorschlagen ----------------
const SYSTEM = 'Du schlägst bessere Dateinamen für die Unterlagen eines privaten Vermieters vor. Schema: „JJJJ-MM-TT Art Ort Stichwort.endung“.\n'
  + '- Die Endung genau beibehalten; hat der Name keine, keine anfügen.\n'
  + '- Das Datum nur vorn, wenn es aus Name, Titel oder „datum“ sicher hervorgeht (JJJJ-MM-TT, nur Monat bekannt: JJJJ-MM). '
  + 'Ein reines Jahr bleibt im Text, z. B. „Nebenkostenabrechnung 2023“.\n'
  + '- Die Art auf Deutsch, z. B. Mietvertrag, Nebenkostenabrechnung, Heizkostenabrechnung, Rechnung, Angebot, Übergabeprotokoll, Kaution, '
  + 'Schreiben, Plan, Vertrag, Protokoll, Gutachten.\n'
  + '- Wohnung oder Mieter nennen, wenn bekannt („ort“, „mieter“); das Objekt nur, wenn keine Wohnung bekannt ist und der Name sonst nichtssagend wäre.\n'
  + '- Personennamen genau so übernehmen, wie sie im Namen stehen. Nichts erfinden — was nicht aus den Angaben hervorgeht, weglassen.\n'
  + '- Interne Nummern, Zeitstempel, Unterstriche, „Kopie“, doppelte Leerzeichen entfernen; kaputte Umlaute reparieren '
  + '(„P__bergabe“ → „Übergabe“, „Mietfl_che“ → „Mietfläche“); Tippfehler korrigieren. Höchstens etwa 80 Zeichen.\n'
  + '- Ist ein Name schon klar und ordentlich, gib ihn unverändert zurück und schreibe als grund „unverändert“.\n'
  + 'Gib für jede Datei die id, den Vorschlag und den Hauptgrund an.';
const NAMEN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    namen: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, vorschlag: { type: 'string' }, grund: { type: 'string', enum: GRUENDE } },
      required: ['id', 'vorschlag', 'grund']
    } }
  },
  required: ['namen']
};
const abbrechen = function (x) { return x && (x.status === 401 || x.status === 429 || /Guthaben/.test(x.message || '')); };

let laeuft = false;
async function namenAssistent() {
  if (laeuft || !einstellung('anthropic_token') || intern.tagesZaehler(0) >= intern.ASSISTENT_JE_TAG) return;
  laeuft = true;
  try {
    // Gemerkte Vorschläge für verschwundene, anders benannte oder anders zugeordnete Dateien wegwerfen
    db.prepare('DELETE FROM dok_namen WHERE id NOT IN (SELECT id FROM dok_dateien)').run();
    const s = standInhalt() || {}, k = orte();
    const dateien = dateienJetzt();
    const doppelt = namen.dubletten(dateien);
    const gemerkt = new Map(db.prepare('SELECT id, alt, ort FROM dok_namen').all().map(function (r) { return [r.id, r]; }));
    const schon = new Set();
    const weg = db.prepare('DELETE FROM dok_namen WHERE id = ?');
    dateien.forEach(function (d) {
      const g = gemerkt.get(d.id);
      if (!g) return;
      if (g.alt === d.name && (g.ort || '') === ortVon(d, k)) schon.add(d.id); else weg.run(d.id);
    });
    const offen = dateien.filter(function (d) {
      const g = namen.bewerten(d.name, d.mime);
      return g && g !== 'Handyfoto' && !doppelt.has(d.id) && !schon.has(d.id);
    });
    if (!offen.length) return;
    const auswahlVorher = einstellung('dok_auswahl');
    const weiter = function () { return !intern.stand.nochmal && einstellung('dok_auswahl') === auswahlVorher && intern.tagesZaehler(0) < intern.ASSISTENT_JE_TAG; };

    // 1. Scans ohne sprechenden Namen: erst den Inhalt lesen (Titel und Datum)
    const scans = offen.filter(function (d) {
      return namen.bewerten(d.name, d.mime) === 'Scan' && !d.titel && (d.mime === 'application/pdf' || /\.pdf$/i.test(d.name))
        && d.groesse > 0 && d.groesse <= intern.PDF_HOECHSTENS;
    }).slice(0, SCANS_JE_LAUF);
    for (const d of scans) {
      if (!weiter()) return;
      try {
        const r = await intern.pdfLesen(d, s);
        d.titel = String(r.titel || '').slice(0, 120);
        d.datum = /^\d{4}-\d{2}-\d{2}$/.test(r.datum || '') ? r.datum : '';
        db.prepare("UPDATE dok_dateien SET titel = ?, datum = ? WHERE id = ? AND (titel IS NULL OR titel = '')").run(d.titel, d.datum, d.id);
      } catch (x) { if (abbrechen(x)) return; }
    }

    // 2. Namen in einem Rutsch vorschlagen lassen — nur Text, günstig
    if (!weiter()) return;
    const stapel = offen.slice(0, NAMEN_JE_LAUF);
    const eintraege = stapel.map(function (d) {
      // Ort und Mieter nur bei feststehender Zuordnung (sonst leer: der Assistent soll nichts Geratenes in den Namen schreiben)
      return { id: d.id, name: d.name, ordner: d.pfad, ort: ortVon(d, k), mieter: mieterVon(d, k),
        art: sicher(d) ? (d.art || '') : '', titel: d.titel || '', datum: d.datum || '' };
    });
    let r;
    try {
      r = await intern.claudeJson({ max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(eintraege) }] }, NAMEN_SCHEMA);
    } catch (x) { return; }
    if (einstellung('dok_auswahl') !== auswahlVorher) return;
    const nachId = new Map((r.namen || []).map(function (n) { return [String(n.id), n]; }));
    const merken = db.prepare('INSERT OR REPLACE INTO dok_namen (id, alt, vorschlag, grund, erstellt, ort) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(function () {
      stapel.forEach(function (d) {
        const n = nachId.get(d.id);
        if (!n) return;
        const v = namen.sauber(n.vorschlag, d.name);
        const gleich = !v || v === d.name || n.grund === 'unverändert';
        merken.run(d.id, d.name, gleich ? '' : v, gleich ? '' : (GRUENDE.indexOf(n.grund) !== -1 ? n.grund : namen.bewerten(d.name, d.mime)),
          Date.now(), ortVon(d, k));
      });
    })();
  } finally {
    laeuft = false;
  }
}

// ---------------- Umbenennen bei Google ----------------
// Google sagt bei 403 genauer, warum: zu viele Anfragen (kurz warten, nochmal), fehlendes Recht für die ganze App
// (Schalter aus → alles abbrechen) oder nur diese eine Datei (z. B. gehört jemand anderem → nur sie auslassen)
const warte = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function beiGoogleUmbenennen(id, neu) {
  for (let versuch = 0; ; versuch++) {
    const antwort = await holen(intern.DRIVE + '/files/' + encodeURIComponent(id) + '?fields=id,name', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + await google.googleToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: neu })
    });
    if (antwort.ok) return antwort.json();
    if (antwort.status === 401) google.googleZugriffVergessen();
    const grund = await antwort.text().catch(function () { return ''; });
    const zuViel = antwort.status === 429 || (antwort.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(grund));
    if (zuViel && versuch < 4) { await warte(1000 * Math.pow(2, versuch)); continue; }
    const ohneRecht = antwort.status === 401 || (antwort.status === 403 && /insufficientPermissions|SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(grund));
    const e = new Error(ohneRecht ? 'Google erlaubt der App das Umbenennen nicht — ist „Umbenennen erlauben“ eingeschaltet?'
      : antwort.status === 403 ? 'Diese Datei darf die App nicht umbenennen (gehört sie jemand anderem?)'
      : zuViel ? 'Google ist gerade überlastet — bitte gleich noch einmal'
      : 'Google antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 120) : ''));
    e.status = antwort.status;
    e.ohneRecht = ohneRecht;
    throw e;
  }
}
// Im selben Ordner darf es den Namen noch nicht geben (Google würde ihn erlauben, aber das stiftet nur Verwirrung)
function freierName(d, neu) {
  const e = namen.endung(neu), basis = namen.stamm(neu);
  const belegt = db.prepare('SELECT 1 FROM dok_dateien WHERE eltern = ? AND lower(name) = lower(?) AND id <> ?');
  let n = neu;
  for (let i = 2; belegt.get(d.eltern, n, d.id) && i < 1000; i++) n = basis + ' ' + i + e;
  return n;
}
function letzte() {
  return db.prepare('SELECT stapel, COUNT(*) AS anzahl, MAX(wann) AS wann FROM dok_umbenannt WHERE zurueck = 0 GROUP BY stapel ORDER BY wann DESC LIMIT 1').get() || null;
}

// ---------------- Schnittstellen ----------------
app.get('/api/dokumente/namen', nurAngemeldet, nurVerwalter, function (req, res) {
  res.json({ google: !!google.googleEinstellungen().refresh, bearbeiten: google.darfBearbeiten(), liste: vorschlaege(), letzte: letzte(),
    assistent: !!einstellung('anthropic_token') });
});

// Louis hat bestätigt: diese Dateien so umbenennen (höchstens 25 auf einmal)
app.put('/api/dokumente/namen', nurAngemeldet, nurVerwalter, async function (req, res) {
  if (!google.darfBearbeiten()) return res.status(409).json({ fehler: 'Umbenennen ist ausgeschaltet — erst „Umbenennen erlauben“ einschalten' });
  const b = req.body || {};
  const stapel = String(b.stapel || Date.now()).replace(/[^\w-]/g, '').slice(0, 40) || String(Date.now());
  const liste = Array.isArray(b.dateien) ? b.dateien.slice(0, JE_ANFRAGE) : [];
  let umbenannt = 0;
  const ids = [];
  const fehler = [];
  for (const w of liste) {
    const d = intern.dateiHolen.get(String((w && w.id) || ''));
    if (!d) { fehler.push({ id: w && w.id, grund: 'Datei nicht gefunden' }); continue; }
    let neu = namen.sauber(w.name, d.name);
    if (!neu || neu === d.name) continue;
    neu = freierName(d, neu);
    try {
      const r = await beiGoogleUmbenennen(d.id, neu);
      const jetzt = String((r && r.name) || neu);
      db.prepare('UPDATE dok_dateien SET name = ? WHERE id = ?').run(jetzt, d.id);
      db.prepare('INSERT INTO dok_umbenannt (id, alt, neu, stapel, wann) VALUES (?, ?, ?, ?, ?)').run(d.id, d.name, jetzt, stapel, Date.now());
      db.prepare('DELETE FROM dok_namen WHERE id = ?').run(d.id);
      umbenannt++;
      ids.push(d.id);
    } catch (x) {
      fehler.push({ id: d.id, name: d.name, grund: x.message });
      if (x.ohneRecht) break;   // ohne Recht hat der Rest keinen Sinn — eine einzelne gesperrte Datei hält den Rest nicht auf
    }
  }
  res.json({ ok: true, umbenannt: umbenannt, ids: ids, fehler: fehler, letzte: letzte() });
});

// Rückgängig: die alten Namen zurück (höchstens 25 auf einmal; „rest“ sagt, wie viele noch fehlen)
app.post('/api/dokumente/namen/rueckgaengig', nurAngemeldet, nurVerwalter, async function (req, res) {
  if (!google.darfBearbeiten()) return res.status(409).json({ fehler: 'Für Rückgängig muss „Umbenennen erlauben“ eingeschaltet sein' });
  const stapel = String((req.body || {}).stapel || '');
  const zeilen = db.prepare('SELECT * FROM dok_umbenannt WHERE stapel = ? AND zurueck = 0 ORDER BY nr DESC LIMIT ?').all(stapel, JE_ANFRAGE);
  const fertig = db.prepare('UPDATE dok_umbenannt SET zurueck = 1 WHERE nr = ?');
  const fehler = [];
  for (const z of zeilen) {
    const d = intern.dateiHolen.get(z.id);
    // Weg oder inzwischen anders benannt: dann nicht dazwischenfunken
    if (!d || d.name !== z.neu) { fertig.run(z.nr); continue; }
    try {
      await beiGoogleUmbenennen(z.id, z.alt);
      db.prepare('UPDATE dok_dateien SET name = ? WHERE id = ?').run(z.alt, z.id);
      fertig.run(z.nr);
    } catch (x) {
      fehler.push({ id: z.id, name: z.neu, grund: x.message });
      if (x.ohneRecht) break;
    }
  }
  const rest = db.prepare('SELECT COUNT(*) AS n FROM dok_umbenannt WHERE stapel = ? AND zurueck = 0').get(stapel).n;
  res.json({ ok: true, rest: rest, fehler: fehler, letzte: letzte() });
});

// Schalter aus: das Recht bei Google zurückgeben. Die Oberfläche verbindet danach gleich wieder nur zum Lesen.
app.post('/api/dokumente/bearbeiten/aus', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
  await google.zugangZurueckgeben();
  res.json({ ok: true });
}));

module.exports = { router: app, namenAssistent, vorschlaege };
