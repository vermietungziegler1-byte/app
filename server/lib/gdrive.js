'use strict';

// -------------------------------------------------------------
//  Google Drive: Dateien bei Objekten, Wohnungen und Mietern
//
//  Die App nutzt die Google-Verbindung, die schon fürs Postfach besteht — mit dem zusätzlichen Recht, Dateien zu
//  lesen (drive.readonly). Sie kopiert keine Dateien, sondern merkt sich Name, Ort, Link und wozu die Datei gehört.
//
//  Louis wählt einmal aus, welche Ordner die App ansehen darf. Bis dahin kennt sie nur die Ordnernamen.
//  Danach fragt sie alle fünf Minuten nach Änderungen (Changes-API): Neues kommt dazu, Gelöschtes verschwindet.
//  Wird ein Ordner umbenannt, verschoben oder gelöscht, liest sie alles einmal neu ein — das sind nur wenige Abrufe.
//
//  Zuordnen in drei Stufen:
//    1. am Pfad und Namen (dokumente-regeln.js), dazu der Beleg-Ordner, der beim Objekt hinterlegt ist — kostenlos
//    2. was dabei offen bleibt und ein PDF ist, liest der Assistent (Objekt, Wohnung, Art, Datum)
//    3. was unsicher ist, steht unter „Bitte prüfen“; Louis' Antwort merkt sich die App für den ganzen Ordner
// -------------------------------------------------------------

const express = require('express');
const { db, holen, einstellung, einstellungSetzen, standInhalt } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const google = require('./google');
const regeln = require('./dokumente-regeln');

const app = express.Router();
const DRIVE = process.env.GDRIVE_BASIS || 'https://www.googleapis.com/drive/v3';
const LESEN = 'https://www.googleapis.com/auth/drive.readonly';
const ORDNER_TYP = 'application/vnd.google-apps.folder';
const TAKT_MS = 5 * 60 * 1000;
// Große PDFs (viele Seiten) liest der Assistent nicht — das kostet viel und sagt selten mehr als der Name
const ASSISTENT_JE_LAUF = 25, ASSISTENT_JE_TAG = 300, PDF_HOECHSTENS = 3 * 1024 * 1024;
// Sammelordner: Hier lernt die App nichts aus einer einzelnen Zuordnung, sonst landete jeder Scan beim selben Objekt
const SAMMELORDNER = /^(scans?|dokumente|documents|downloads?|desktop|bilder|pictures|fotos|rechnungen|belege|eingang|neu|sonstiges|ablage|temp|privat|anhaenge|attachments)$/;

db.exec(`
  CREATE TABLE IF NOT EXISTS dok_ordner (id TEXT PRIMARY KEY, name TEXT, eltern TEXT, lauf INTEGER);
  CREATE TABLE IF NOT EXISTS dok_dateien (
    id        TEXT PRIMARY KEY,
    name      TEXT,
    pfad      TEXT,
    eltern    TEXT,
    mime      TEXT,
    groesse   INTEGER,
    geaendert INTEGER,
    url       TEXT,
    objekt    TEXT DEFAULT '',
    einheit   TEXT DEFAULT '',
    art       TEXT DEFAULT '',
    titel     TEXT DEFAULT '',
    datum     TEXT DEFAULT '',
    quelle    TEXT DEFAULT '',
    status    TEXT DEFAULT 'neu',
    erstmals  INTEGER,
    lauf      INTEGER
  );
  CREATE INDEX IF NOT EXISTS dok_dateien_objekt ON dok_dateien (objekt);
  -- Gelernte Ordner hängen an der Ordner-ID: Umbenennen oder Verschieben ändert nichts an der Regel
  CREATE TABLE IF NOT EXISTS dok_regeln (ordner TEXT PRIMARY KEY, pfad TEXT, objekt TEXT, einheit TEXT);
  -- Der erste Versuch lief über OneDrive und kam nie zustande (Microsoft verlangte ein Firmenverzeichnis): aufräumen
  DROP TABLE IF EXISTS od_dateien;
  DROP TABLE IF EXISTS od_regeln;
`);
db.prepare("DELETE FROM einstellungen WHERE schluessel IN ('od_client_id', 'od_client_secret', 'od_refresh', 'od_konto', 'od_delta', 'od_assistent_tag')").run();
// status: neu (noch nicht angesehen) · zugeordnet · pruefen (Vorschlag, unsicher) · offen (keine Ahnung, wartet auf den
// Assistenten) · unklar (auch der Assistent weiß es nicht) · fremd (hat nichts mit der Vermietung zu tun) · ignoriert (Louis: keins)

function fehler(text, status) { const e = new Error(text); e.status = status; return e; }

// ---------------- Zugriff ----------------
function googleVerbunden() { const g = google.googleEinstellungen(); return !!(g.clientId && g.refresh); }
function darfLesen() {
  return String(einstellung('google_scope') || '').split(/\s+/).some(function (s) { return s === LESEN || s === 'https://www.googleapis.com/auth/drive'; });
}
function auswahl() {
  try {
    const a = JSON.parse(einstellung('dok_auswahl') || 'null');
    return a && Array.isArray(a.ein) ? { ein: new Set(a.ein), aus: new Set(Array.isArray(a.aus) ? a.aus : []) } : null;
  } catch (e) { return null; }
}

async function drive(pfad, roh) {
  const antwort = await holen(DRIVE + pfad, { headers: { Authorization: 'Bearer ' + await google.googleToken() } });
  if (antwort.status === 401) google.googleZugriffVergessen();
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    if (antwort.status === 403 && /insufficient|scope/i.test(grund)) {
      throw fehler('Google erlaubt der App noch nicht, Dateien zu lesen — bitte Google neu verbinden', 403);
    }
    throw fehler('Google Drive antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 160) : ''), antwort.status);
  }
  return roh ? antwort : antwort.json();
}
const q = encodeURIComponent;

// Alle Seiten einer Liste (files.list liefert höchstens 1000 auf einmal)
async function alleSeiten(pfad) {
  const liste = [];
  let weiter = '';
  for (let i = 0; i < 300; i++) {
    const r = await drive(pfad + (weiter ? '&pageToken=' + q(weiter) : ''));
    (r.files || []).forEach(function (f) { liste.push(f); });
    if (!r.nextPageToken) break;
    weiter = r.nextPageToken;
  }
  return liste;
}

// ---------------- Ordner, Pfade, Auswahl ----------------
const ordnerMerken = db.prepare(`INSERT INTO dok_ordner (id, name, eltern, lauf) VALUES (@id, @name, @eltern, @lauf)
  ON CONFLICT(id) DO UPDATE SET name = @name, eltern = @eltern, lauf = @lauf`);
function ordnerZeile(o, lauf) {
  return { id: o.id, name: String(o.name || '').trim().replace(/\//g, '-'), eltern: (o.parents || [])[0] || '', lauf: lauf };
}

function karte() {
  const m = new Map();
  db.prepare('SELECT id, name, eltern FROM dok_ordner').all().forEach(function (o) { m.set(o.id, o); });
  return { ordner: m, wurzel: einstellung('dok_wurzel') || '', pfade: new Map() };
}
// Pfad eines Ordners („/Firma/Dahlienweg“), '' für „Meine Ablage“ selbst, null wenn er dort nicht hängt
function ordnerPfad(id, k) {
  if (id === k.wurzel) return '';
  if (k.pfade.has(id)) return k.pfade.get(id);
  const kette = [];
  let x = id;
  for (let tiefe = 0; x && x !== k.wurzel && tiefe < 60; tiefe++) {
    const o = k.ordner.get(x);
    if (!o) { x = null; break; }
    kette.unshift(o.name);
    x = o.eltern;
  }
  const p = x && x === k.wurzel ? '/' + kette.join('/') : null;
  k.pfade.set(id, p);
  return p;
}
// Darf die App in diesen Ordner schauen? Der nächste Ordner nach oben, für den Louis etwas gewählt hat, entscheidet.
// „Meine Ablage“ selbst gilt nur für die losen Dateien darin — nie für Ordner, die später oben dazukommen.
function erlaubt(id, k, a) {
  let x = id;
  for (let tiefe = 0; x && tiefe < 60; tiefe++) {
    if (x === k.wurzel) return x === id && a.ein.has(x);
    if (a.aus.has(x)) return false;
    if (a.ein.has(x)) return true;
    const o = k.ordner.get(x);
    if (!o) return false;
    x = o.eltern;
  }
  return false;
}

// ---------------- Dateien merken ----------------
const dateiHolen = db.prepare('SELECT * FROM dok_dateien WHERE id = ?');
const dateiLoeschen = db.prepare('DELETE FROM dok_dateien WHERE id = ?');
const dateiNeu = db.prepare(`INSERT INTO dok_dateien (id, name, pfad, eltern, mime, groesse, geaendert, url, status, erstmals, lauf)
  VALUES (@id, @name, @pfad, @eltern, @mime, @groesse, @geaendert, @url, 'neu', @erstmals, @lauf)`);
const dateiAuffrischen = db.prepare(`UPDATE dok_dateien SET name = @name, pfad = @pfad, eltern = @eltern, mime = @mime, groesse = @groesse,
  geaendert = @geaendert, url = @url, lauf = @lauf WHERE id = @id`);
const dateiZuruecksetzen = db.prepare(`UPDATE dok_dateien SET name = @name, pfad = @pfad, eltern = @eltern, mime = @mime, groesse = @groesse,
  geaendert = @geaendert, url = @url, lauf = @lauf, status = 'neu', objekt = '', einheit = '', art = '', titel = '', datum = '', quelle = '' WHERE id = @id`);

// Eine Datei aus Google übernehmen — oder vergessen, wenn sie nicht (mehr) in einem gewählten Ordner liegt
function dateiMerken(f, k, a, lauf, erstmals) {
  const eltern = (f.parents || [])[0] || '';
  const pfad = eltern ? ordnerPfad(eltern, k) : null;
  if (pfad === null || !erlaubt(eltern, k, a) || !regeln.kommtInFrage(pfad, f.name, f.mimeType)) { dateiLoeschen.run(f.id); return false; }
  const zeile = { id: f.id, name: String(f.name || ''), pfad: pfad || '/', eltern: eltern, mime: f.mimeType || '', groesse: Number(f.size) || 0,
    geaendert: Date.parse(f.modifiedTime || '') || 0, url: f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view'), lauf: lauf };
  const alt = dateiHolen.get(f.id);
  if (!alt) { dateiNeu.run(Object.assign({ erstmals: erstmals }, zeile)); return true; }
  // Die Datei selbst umbenannt oder in einen anderen Ordner gelegt: neu zuordnen — außer Louis hat selbst entschieden.
  // Hat sich nur der Name eines Ordners weiter oben geändert, bleibt die Zuordnung; der Pfad zieht einfach nach.
  if ((alt.name !== zeile.name || alt.eltern !== zeile.eltern) && alt.quelle !== 'louis') dateiZuruecksetzen.run(zeile);
  else dateiAuffrischen.run(zeile);
  return false;
}

// ---------------- Abgleich ----------------
const stand = { laeuft: false, zuletzt: 0, fehler: null, neu: 0 };

// Ordner immer, Dateien erst, wenn Louis ausgewählt hat. Was dabei nicht mehr auftaucht, ist weg.
async function allesEinlesen(a) {
  const lauf = Date.now();
  const auswahlVorher = einstellung('dok_auswahl');
  // Den Stand für spätere Änderungen vorher holen — was während des Einlesens passiert, kommt dann beim nächsten Mal
  const start = (await drive('/changes/startPageToken?fields=startPageToken')).startPageToken;
  const wurzel = (await drive('/files/root?fields=id')).id;
  einstellungSetzen('dok_wurzel', wurzel);
  const ordner = await alleSeiten('/files?pageSize=1000&spaces=drive&fields=' + q('nextPageToken,files(id,name,parents)')
    // Ohne Filter auf den Besitzer: Was andere in Louis' Ordner legen, gehört auch dazu (die Änderungen melden es ebenso).
    // Was nur mit ihm geteilt ist und nicht in „Meine Ablage“ hängt, fällt beim Pfad heraus.
    + '&q=' + q("mimeType = '" + ORDNER_TYP + "' and trashed = false"));
  db.transaction(function () {
    ordner.forEach(function (o) { ordnerMerken.run(ordnerZeile(o, lauf)); });
    db.prepare('DELETE FROM dok_ordner WHERE lauf < ?').run(lauf);
  })();
  if (!a) return;
  const dateien = await alleSeiten('/files?pageSize=1000&spaces=drive&fields='
    + q('nextPageToken,files(id,name,mimeType,parents,modifiedTime,size,webViewLink)')
    + '&q=' + q("mimeType != '" + ORDNER_TYP + "' and trashed = false"));
  if (auswahlGeaendert(auswahlVorher)) return;
  // Beim allerersten Einlesen ist nichts „neu“ — sonst stünde an jeder Datei zwei Tage lang NEU
  const erstesMal = !db.prepare('SELECT 1 FROM dok_dateien LIMIT 1').get();
  const k = karte();
  let neu = 0;
  db.transaction(function () {
    dateien.forEach(function (f) { if (dateiMerken(f, k, a, lauf, erstesMal ? 0 : lauf)) neu++; });
    db.prepare('DELETE FROM dok_dateien WHERE lauf < ?').run(lauf);
  })();
  stand.neu = erstesMal ? 0 : neu;
  einstellungSetzen('dok_seite', start);
}

// Nur die Änderungen seit dem letzten Mal. Liefert false, wenn alles neu eingelesen werden muss.
async function aenderungenHolen(a) {
  let seite = einstellung('dok_seite');
  const auswahlVorher = einstellung('dok_auswahl');
  const felder = 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,modifiedTime,size,webViewLink,trashed))';
  for (let runde = 0; seite && runde < 200; runde++) {
    let r;
    try {
      r = await drive('/changes?pageSize=1000&spaces=drive&restrictToMyDrive=true&includeRemoved=true&fields=' + q(felder) + '&pageToken=' + q(seite));
    } catch (x) {
      if (x.status === 400 || x.status === 404 || x.status === 410) return false;   // Stand zu alt oder ungültig
      throw x;
    }
    if (auswahlGeaendert(auswahlVorher)) return true;
    const lauf = Date.now();
    const liste = r.changes || [];
    const k = karte();
    // Ordner zuerst: neue merken; wurde einer umbenannt, verschoben oder gelöscht, stimmen Pfade und Auswahl nicht mehr
    for (const c of liste) {
      const bekannt = k.ordner.get(c.fileId);
      if (c.file && c.file.mimeType === ORDNER_TYP) {
        const z = ordnerZeile(c.file, lauf);
        if (c.file.trashed) { if (bekannt) return false; continue; }
        if (!bekannt) { ordnerMerken.run(z); k.ordner.set(z.id, z); continue; }
        if (bekannt.name !== z.name || bekannt.eltern !== z.eltern) return false;
      } else if ((c.removed || !c.file) && bekannt) {
        return false;
      }
    }
    k.pfade.clear();
    let neu = 0;
    db.transaction(function () {
      liste.forEach(function (c) {
        if (c.file && c.file.mimeType === ORDNER_TYP) return;
        if (c.removed || !c.file || c.file.trashed) { dateiLoeschen.run(c.fileId); return; }
        if (dateiMerken(c.file, k, a, lauf, lauf)) neu++;
      });
    })();
    stand.neu += neu;
    if (r.newStartPageToken) { einstellungSetzen('dok_seite', r.newStartPageToken); seite = null; }
    else { seite = r.nextPageToken; if (seite) einstellungSetzen('dok_seite', seite); }
  }
  return true;
}

async function abgleichen() {
  if (!googleVerbunden() || !darfLesen()) return;
  // Läuft schon einer (z. B. während Louis die Auswahl ändert): danach gleich noch einmal
  if (stand.laeuft) { stand.nochmal = true; return; }
  stand.laeuft = true; stand.fehler = null; stand.nochmal = false;
  try {
    const a = auswahl();
    stand.neu = 0;
    const geschafft = a && einstellung('dok_seite') ? await aenderungenHolen(a) : false;
    if (!geschafft) await allesEinlesen(a);
    if (a && !stand.nochmal) {
      regelnAnwenden();
      await assistentAnwenden();
    }
  } catch (x) {
    stand.fehler = x.message;
  } finally {
    stand.laeuft = false; stand.zuletzt = Date.now();
    if (stand.nochmal) { stand.nochmal = false; setTimeout(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, 50).unref(); }
  }
}
// Hat Louis während des Abrufs die Auswahl geändert oder zurückgesetzt? Dann nichts schreiben — der nächste Lauf macht es richtig.
function auswahlGeaendert(vorher) {
  if (einstellung('dok_auswahl') === vorher) return false;
  stand.nochmal = true;
  return true;
}

// Stufe 1: am Pfad und Namen — für alles, was neu ist oder dessen Zuordnung nicht von Louis stammt
function festeOrdner() {
  // Gelernte Ordner zuerst: bei gleich langem Pfad gewinnt, was Louis selbst gesagt hat
  const k = karte();
  // Der Pfad kommt aus der Ordner-ID — so überlebt die Regel ein Umbenennen oder Verschieben
  const liste = db.prepare('SELECT ordner, pfad, objekt, einheit FROM dok_regeln').all().map(function (r) {
    return { pfad: ordnerPfad(r.ordner, k) || r.pfad, objekt: r.objekt, einheit: r.einheit };
  });
  const s = standInhalt() || {};
  (s.objects || []).forEach(function (o) {
    if (!o.ordnerId) return;
    const p = ordnerPfad(String(o.ordnerId), k);
    if (p) liste.push({ pfad: p, objekt: o.id, einheit: '' });
  });
  return liste;
}
function regelnAnwenden() {
  const wb = regeln.woerterbuch(standInhalt() || {});
  const fest = festeOrdner();
  const setzen = db.prepare('UPDATE dok_dateien SET objekt = ?, einheit = ?, art = ?, quelle = ?, status = ? WHERE id = ?');
  db.transaction(function () {
    // Neue immer; offene und unklare nur, wenn jetzt eine Regel greift (z. B. nach einem neuen Mieter oder gelernten Ordner)
    db.prepare("SELECT id, name, pfad, mime, status FROM dok_dateien WHERE status IN ('neu', 'offen', 'unklar')").all().forEach(function (d) {
      const r = regeln.zuordnen(d.pfad, d.name, wb, fest, d.mime);
      if (r.objekt) setzen.run(r.objekt, r.einheit || '', r.art, 'regel', r.sicher ? 'zugeordnet' : 'pruefen', d.id);
      else if (d.status === 'neu') setzen.run('', '', r.art, 'regel', r.kandidaten && r.kandidaten.length ? 'pruefen' : 'offen', d.id);
    });
  })();
}

// Stufe 2: offene PDFs liest der Assistent — die neuesten zuerst, mit Tageslimit
const ARTEN = regeln.ARTEN.map(function (a) { return a[0]; }).concat(['Foto', 'Sonstiges']);
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    vermietung: { type: 'boolean' },
    objekt: { type: 'string' }, einheit: { type: 'string' },
    art: { type: 'string', enum: ARTEN },
    titel: { type: 'string' }, datum: { type: 'string' },
    sicherheit: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] }
  },
  required: ['vermietung', 'objekt', 'einheit', 'art', 'titel', 'datum', 'sicherheit']
};
function tagesZaehler(dazu) {
  const heute = new Date().toISOString().slice(0, 10);
  const [tag, n] = String(einstellung('dok_assistent_tag') || '').split(':');
  let zahl = tag === heute ? Number(n) || 0 : 0;
  if (dazu) { zahl += dazu; einstellungSetzen('dok_assistent_tag', heute + ':' + zahl); }
  return zahl;
}
async function assistentAnwenden() {
  if (!einstellung('anthropic_token')) return;
  const frei = Math.min(ASSISTENT_JE_LAUF, ASSISTENT_JE_TAG - tagesZaehler(0));
  if (frei <= 0) return;
  const offen = db.prepare("SELECT * FROM dok_dateien WHERE status = 'offen' AND (mime = 'application/pdf' OR lower(name) LIKE '%.pdf') "
    + 'AND groesse > 0 AND groesse <= ? ORDER BY geaendert DESC LIMIT ?').all(PDF_HOECHSTENS, frei);
  if (!offen.length) return;
  const s = standInhalt() || {};
  const liste = (s.objects || []).map(function (o) {
    return '- ' + o.id + ': ' + o.name + '\n' + (o.units || []).map(function (x) {
      return '    - ' + x.id + ': ' + (x.name || '') + (x.tenant ? ' (Mieter: ' + x.tenant + ')' : '');
    }).join('\n');
  }).join('\n');
  const { claude } = require('./assistent');
  const auswahlVorher = einstellung('dok_auswahl');
  for (const d of offen) {
    // Jede Datei kostet ein paar Sekunden: hat Louis inzwischen die Auswahl geändert, zurückgesetzt oder selbst
    // zugeordnet, geht nichts mehr an Claude
    if (einstellung('dok_auswahl') !== auswahlVorher || stand.nochmal) break;
    const jetzt = dateiHolen.get(d.id);
    if (!jetzt || jetzt.status !== 'offen') continue;
    let r = null;
    try {
      const antwort = await fetch(DRIVE + '/files/' + q(d.id) + '?alt=media', {
        headers: { Authorization: 'Bearer ' + await google.googleToken() }, signal: AbortSignal.timeout(30000)
      });
      if (!antwort.ok) throw new Error('Datei nicht lesbar (' + antwort.status + ')');
      const daten = Buffer.from(await antwort.arrayBuffer());
      const koerper = {
        max_tokens: 1500,
        system: 'Du hilfst Louis Ziegler, einem privaten Vermieter, Dateien aus seinem Google Drive zu ordnen. Bestimme für das Dokument: '
          + 'gehört es zur Vermietung (vermietung), zu welchem Objekt (objekt = die ID aus der Liste, sonst leer) und welcher Wohnung '
          + '(einheit = die ID, sonst leer — leer lassen, wenn es das ganze Haus betrifft), welche Art es ist, einen kurzen Titel '
          + '(z. B. „Nebenkostenabrechnung 2025“ oder „Rechnung Gartenpflege“), das Datum des Dokuments (JJJJ-MM-TT oder leer) und wie '
          + 'sicher du dir bei Objekt und Wohnung bist. Adresse, Mietername oder Wohnungsbezeichnung im Text sind die besten Hinweise. '
          + 'Rate nicht: lieber leer und sicherheit „niedrig“.\n\nObjekte und Wohnungen:\n' + liste,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: daten.toString('base64') } },
          { type: 'text', text: 'Dateiname: ' + d.name + '\nOrdner: ' + d.pfad }
        ] }]
      };
      let antwortClaude = null;
      for (const v of [{ model: 'claude-haiku-5-5', output_config: { format: { type: 'json_schema', schema: SCHEMA } } },
                       { model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } }]) {
        try { antwortClaude = await claude(Object.assign({}, koerper, v), null, 60000); break; }
        catch (x) { if (x.status && x.status !== 400 && x.status !== 404) throw x; }
      }
      if (!antwortClaude) throw new Error('Kein Modell erreichbar');
      tagesZaehler(1);
      const block = (antwortClaude.content || []).find(function (x) { return x.type === 'text'; });
      r = JSON.parse(block.text);
    } catch (x) {
      if (x.status === 401 || x.status === 429 || /Guthaben/.test(x.message || '')) break;   // Schlüssel, Auslastung, Guthaben: später weiter
      db.prepare("UPDATE dok_dateien SET status = 'unklar', quelle = 'assistent' WHERE id = ? AND status = 'offen'").run(d.id);
      continue;
    }
    const objektOk = (s.objects || []).some(function (o) { return o.id === r.objekt; });
    const einheitOk = objektOk && (s.objects || []).some(function (o) { return o.id === r.objekt && (o.units || []).some(function (x) { return x.id === r.einheit; }); });
    const status = !r.vermietung ? 'fremd' : (!objektOk ? 'unklar' : (r.sicherheit === 'hoch' ? 'zugeordnet' : 'pruefen'));
    // Nur, wenn Louis in der Zwischenzeit nicht selbst entschieden hat
    db.prepare("UPDATE dok_dateien SET objekt = ?, einheit = ?, art = ?, titel = ?, datum = ?, quelle = ?, status = ? WHERE id = ? AND status = 'offen'")
      .run(objektOk ? r.objekt : '', einheitOk ? r.einheit : '', ARTEN.indexOf(r.art) !== -1 ? r.art : 'Sonstiges', String(r.titel || '').slice(0, 120),
        /^\d{4}-\d{2}-\d{2}$/.test(r.datum || '') ? r.datum : '', 'assistent', status, d.id);
  }
}

setTimeout(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, 30000).unref();
setInterval(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, TAKT_MS).unref();

// ---------------- Schnittstellen ----------------
function zahlen() {
  const z = {};
  db.prepare('SELECT status, COUNT(*) AS n FROM dok_dateien GROUP BY status').all().forEach(function (r) { z[r.status] = r.n; });
  return z;
}
function status() {
  const g = googleVerbunden(), recht = g && darfLesen(), gewaehlt = !!auswahl();
  return { google: g, recht: recht, gewaehlt: gewaehlt, verbunden: recht && gewaehlt,
    zahlen: zahlen(), laeuft: stand.laeuft, zuletzt: stand.zuletzt || null, fehler: stand.fehler, assistentHeute: tagesZaehler(0) };
}
app.get('/api/dokumente', nurAngemeldet, function (req, res) { res.json(status()); });

// Die Ordner zum Auswählen: zwei Ebenen unter „Meine Ablage“, mit dem, was gerade gewählt ist
app.get('/api/dokumente/ordner', nurAngemeldet, nurVerwalter, async function (req, res) {
  if (!googleVerbunden() || !darfLesen()) return res.status(409).json({ fehler: 'Google erlaubt der App noch nicht, Dateien zu lesen' });
  try {
    const frisch = req.query.frisch === '1';
    if (!einstellung('dok_wurzel') || frisch) {
      for (let i = 0; i < 100 && stand.laeuft; i++) await new Promise(function (r) { setTimeout(r, 200); });
      if ((!einstellung('dok_wurzel') || frisch) && !stand.laeuft) {
        stand.laeuft = true;
        try { await allesEinlesen(null); } finally { stand.laeuft = false; }
        // Ordner neu gelesen: beim nächsten Abgleich auch die Dateien, damit Pfade und Auswahl zusammenpassen
        if (frisch) db.prepare("DELETE FROM einstellungen WHERE schluessel = 'dok_seite'").run();
      }
    }
    const k = karte();
    const a = auswahl() || { ein: new Set(), aus: new Set() };
    const kinder = new Map();
    k.ordner.forEach(function (o) { if (!kinder.has(o.eltern)) kinder.set(o.eltern, []); kinder.get(o.eltern).push(o); });
    const sortiert = function (l) { return (l || []).slice().sort(function (x, y) { return x.name.localeCompare(y.name, 'de'); }); };
    const zeile = function (o, ebene) {
      return { id: o.id, name: o.name, eltern: o.eltern, ebene: ebene, an: erlaubt(o.id, k, a), unterordner: (kinder.get(o.id) || []).length };
    };
    const liste = [];
    sortiert(kinder.get(k.wurzel)).forEach(function (o) {
      liste.push(zeile(o, 1));
      sortiert(kinder.get(o.id)).forEach(function (u) { liste.push(zeile(u, 2)); });
    });
    // ein/aus vollständig — auch für tiefere Ordner, die hier nicht stehen, damit beim Speichern nichts verloren geht
    res.json({ wurzel: k.wurzel, gewaehlt: !!auswahl(), ein: Array.from(a.ein), aus: Array.from(a.aus), ordner: liste });
  } catch (x) {
    res.status(x.status === 403 || x.status === 409 ? 409 : 502).json({ fehler: x.message });
  }
});

// Louis' Auswahl: angehakte und ausdrücklich ausgenommene Ordner. Danach liest die App alles neu ein.
app.put('/api/dokumente/ordner', nurAngemeldet, nurVerwalter, function (req, res) {
  const b = req.body || {};
  const k = karte();
  const gueltig = function (l) {
    return (Array.isArray(l) ? l : []).map(String).filter(function (id, i, alle) { return id && (k.ordner.has(id) || id === k.wurzel) && alle.indexOf(id) === i; });
  };
  const ein = gueltig(b.ein), aus = gueltig(b.aus).filter(function (id) { return ein.indexOf(id) === -1; });
  einstellungSetzen('dok_auswahl', JSON.stringify({ ein: ein, aus: aus }));
  // Was jetzt nicht mehr gewählt ist, sofort vergessen; der Rest kommt beim Einlesen
  const a = auswahl();
  db.transaction(function () {
    db.prepare('SELECT id, eltern FROM dok_dateien').all().forEach(function (d) { if (!erlaubt(d.eltern, k, a)) dateiLoeschen.run(d.id); });
  })();
  db.prepare("DELETE FROM einstellungen WHERE schluessel = 'dok_seite'").run();
  setTimeout(function () { abgleichen().catch(function () { /* steht in stand.fehler */ }); }, 50).unref();
  res.json({ ok: true, status: status() });
});

app.delete('/api/dokumente', nurAngemeldet, nurVerwalter, function (req, res) {
  ['dok_auswahl', 'dok_seite', 'dok_wurzel'].forEach(function (k) { db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run(k); });
  db.prepare('DELETE FROM dok_dateien').run();
  db.prepare('DELETE FROM dok_ordner').run();
  db.prepare('DELETE FROM dok_regeln').run();
  res.json({ ok: true });
});

app.post('/api/dokumente/abgleich', nurAngemeldet, nurVerwalter, function (req, res) {
  abgleichen().catch(function () { /* steht in stand.fehler */ });
  res.json({ ok: true });
});

// Alle zugeordneten, zu prüfenden und offenen Dateien — schlank, die App filtert selbst nach Objekt und Wohnung
app.get('/api/dokumente/dateien', nurAngemeldet, function (req, res) {
  const zeilen = db.prepare("SELECT id, name, pfad, mime, groesse, geaendert, url, objekt, einheit, art, titel, datum, quelle, status, erstmals AS gesehen "
    + "FROM dok_dateien WHERE status IN ('zugeordnet', 'pruefen', 'unklar', 'offen') ORDER BY geaendert DESC LIMIT 8000").all();
  res.json({ dateien: zeilen, zahlen: zahlen(), laeuft: stand.laeuft, zuletzt: stand.zuletzt || null, fehler: stand.fehler });
});

// Louis ordnet zu (oder sagt „gehört zu keinem“). Mit merken: gilt künftig für den ganzen Ordner
app.put('/api/dokumente/dateien/:id', nurAngemeldet, nurVerwalter, function (req, res) {
  const d = dateiHolen.get(req.params.id);
  if (!d) return res.status(404).json({ fehler: 'Datei nicht gefunden' });
  const b = req.body || {};
  if (b.ignorieren) {
    db.prepare("UPDATE dok_dateien SET status = 'ignoriert', quelle = 'louis', objekt = '', einheit = '' WHERE id = ?").run(d.id);
  } else {
    const objekt = String(b.objekt || d.objekt || '');
    const s = standInhalt() || {};
    const o = (s.objects || []).find(function (x) { return x.id === objekt; });
    if (!o) return res.status(400).json({ fehler: 'Zu welchem Objekt?' });
    let einheit = b.einheit !== undefined ? String(b.einheit || '') : (d.einheit || '');
    if (einheit && !(o.units || []).some(function (x) { return x.id === einheit; })) einheit = '';
    const art = ARTEN.indexOf(String(b.art || '')) !== -1 ? String(b.art) : (d.art || 'Sonstiges');
    db.prepare("UPDATE dok_dateien SET objekt = ?, einheit = ?, art = ?, quelle = 'louis', status = 'zugeordnet' WHERE id = ?").run(objekt, einheit, art, d.id);
    // Lernen — aber nicht in Sammelordnern wie „Scans“ oder „03 Rechnungen“ (sonst landete dort alles beim selben Objekt)
    // und nicht, wenn der Ordner selbst schon ein anderes Objekt nennt (dann war nur diese eine Datei falsch abgelegt)
    const letzter = regeln.normal(d.pfad.split('/').filter(Boolean).pop() || '').trim().replace(/^\d+\s+/, '');
    const ordnerSagt = regeln.zuordnen(d.pfad, '', regeln.woerterbuch(s), []).objekt;
    if (b.merken !== false && d.eltern && d.pfad !== '/' && letzter && !SAMMELORDNER.test(letzter) && (!ordnerSagt || ordnerSagt === objekt)) {
      db.prepare('INSERT OR REPLACE INTO dok_regeln (ordner, pfad, objekt, einheit) VALUES (?, ?, ?, ?)').run(d.eltern, d.pfad, objekt, b.ordnerMitWohnung ? einheit : '');
      // Was im selben Ordner noch offen ist, gleich mitnehmen
      db.prepare("UPDATE dok_dateien SET status = 'neu' WHERE eltern = ? AND status IN ('offen', 'unklar', 'pruefen') AND id <> ?").run(d.eltern, d.id);
      regelnAnwenden();
    }
  }
  res.json({ ok: true, datei: dateiHolen.get(d.id), zahlen: zahlen() });
});

module.exports = { router: app, abgleichen, regelnAnwenden };
