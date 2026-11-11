'use strict';

// -------------------------------------------------------------
//  Anhänge aus dem Postfach in Google Drive ablegen
//
//  Alle zehn Minuten schaut die App im Suchverzeichnis des Postfachs nach Mails mit Anhängen, die zur Vermietung
//  gehören könnten, holt deren Anhangliste vom Mailserver (ohne eine Mail als gelesen zu markieren) und merkt sich
//  jeden Anhang, der noch nicht in Google Drive liegt. Der Assistent liest ihn und schlägt vor: Objekt, Wohnung, Art
//  (Nebenkosten-Rechnung oder sonstige Rechnung, Vertrag, Bescheid …), Kostenart, Jahr, Betrag und einen Dateinamen.
//  Louis prüft und tippt „Ablegen“: Die App legt die Datei im Objektordner ab — „02 Nebenkosten/2025“,
//  „03 Rechnungen/2026“ … — und legt fehlende Ordner an. Dafür braucht sie das Recht, Drive zu bearbeiten.
// -------------------------------------------------------------

const express = require('express');
const { db, holen, einstellung, einstellungSetzen, standInhalt, mitFehler } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const google = require('./google');
const regeln = require('./dokumente-regeln');
const ar = require('./anhaenge-regeln');
const namen = require('./dokumente-namen');
const { intern } = require('./gdrive');

// Woher die Mails kommen: das Postfach. Die Tests setzen eine Attrappe ein.
function quelle() { return process.env.ANHANG_TESTQUELLE ? require(process.env.ANHANG_TESTQUELLE) : require('./postfach'); }

const app = express.Router();
const TAKT_MS = 10 * 60 * 1000;
const SEIT = Date.parse('2019-01-01T00:00:00Z');
const MAILS_JE_LAUF = 300, LESEN_JE_LAUF = 20, LESEN_JE_TAG = 250, INHALT_HOECHSTENS = 3 * 1024 * 1024;
const UPLOAD = process.env.GDRIVE_UPLOAD_BASIS || 'https://www.googleapis.com/upload/drive/v3';
const ORDNER_TYP = 'application/vnd.google-apps.folder';

db.exec(`
  CREATE TABLE IF NOT EXISTS anh_mails (schluessel TEXT PRIMARY KEY, geprueft INTEGER);
  CREATE TABLE IF NOT EXISTS anh_dateien (
    id          TEXT PRIMARY KEY,
    ordner      TEXT, uid INTEGER, uidvalidity TEXT, teil TEXT, nr INTEGER,
    datum       INTEGER, von TEXT, betreff TEXT, mailtext TEXT,
    name        TEXT, typ TEXT, groesse INTEGER,
    status      TEXT,
    objekt      TEXT DEFAULT '', einheit TEXT DEFAULT '', art TEXT DEFAULT '', kostenart TEXT DEFAULT '', jahr TEXT DEFAULT '',
    betrag      REAL, dateiname TEXT DEFAULT '', quelle TEXT DEFAULT '', sicherheit TEXT DEFAULT '',
    drive_id    TEXT, fehler TEXT, erstellt INTEGER
  );
  CREATE INDEX IF NOT EXISTS anh_dateien_status ON anh_dateien (status);
`);
// status: neu (noch nicht eingeordnet) · vorschlag (wartet auf Louis) · in_drive (lag schon in Drive) · abgelegt · ignoriert · fremd

function fehler(text, status) { const e = new Error(text); e.status = status; return e; }
function woerterbuch(s) {
  const eigentuemer = String(einstellung('dok_eigentuemer') || 'Louis Ziegler').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
  return regeln.woerterbuch(s || standInhalt() || {}, eigentuemer);
}
function tageszaehler(dazu) {
  const heute = new Date().toISOString().slice(0, 10);
  const [tag, n] = String(einstellung('anh_assistent_tag') || '').split(':');
  let zahl = tag === heute ? Number(n) || 0 : 0;
  if (dazu) { zahl += dazu; einstellungSetzen('anh_assistent_tag', heute + ':' + zahl); }
  return zahl;
}

// ---------------- Neue Anhänge finden ----------------
const stand = { laeuft: false, zuletzt: 0, fehler: null };
const merkeMail = db.prepare('INSERT OR REPLACE INTO anh_mails (schluessel, geprueft) VALUES (?, ?)');
const neuerAnhang = db.prepare(`INSERT OR IGNORE INTO anh_dateien (id, ordner, uid, uidvalidity, teil, nr, datum, von, betreff, mailtext, name, typ,
  groesse, status, erstellt) VALUES (@id, @ordner, @uid, @uidvalidity, @teil, @nr, @datum, @von, @betreff, @mailtext, @name, @typ, @groesse, @status, @erstellt)`);

async function neueAnhaenge(q) {
  const wb = woerterbuch();
  const kandidaten = await q.anhangKandidaten(SEIT);
  const geprueft = new Set(db.prepare('SELECT schluessel FROM anh_mails').all().map(function (r) { return r.schluessel; }));
  const offen = [];
  for (const m of kandidaten) {
    const s = m.ordner + '|' + m.uidvalidity + '|' + m.uid;
    if (geprueft.has(s)) continue;
    // Hat erkennbar nichts mit der Vermietung zu tun: gar nicht erst den Mailserver fragen
    if (!ar.relevant(m, wb)) { merkeMail.run(s, Date.now()); continue; }
    offen.push(Object.assign({ schluessel: s }, m));
    if (offen.length >= MAILS_JE_LAUF) break;
  }
  if (!offen.length) return 0;
  const verz = ar.driveVerzeichnis(db.prepare('SELECT name, groesse FROM dok_dateien').all());
  const proOrdner = new Map();
  offen.forEach(function (m) { if (!proOrdner.has(m.ordner)) proOrdner.set(m.ordner, []); proOrdner.get(m.ordner).push(m); });
  let gefunden = 0;
  for (const [ordner, mails] of proOrdner) {
    for (let i = 0; i < mails.length; i += 50) {
      const block = mails.slice(i, i + 50);
      let teile;
      try { teile = await q.anhangListen(ordner, block.map(function (m) { return m.uid; })); }
      catch (x) { continue; }   // Ordner gerade nicht erreichbar: beim nächsten Mal
      db.transaction(function () {
        block.forEach(function (m) {
          if (!teile.has(m.uid)) return;   // Mail inzwischen weg
          let nr = 0;
          teile.get(m.uid).forEach(function (a) {
            const meineNr = a.inline ? -1 : nr++;
            if (!ar.taugt(a)) return;
            const r = neuerAnhang.run({ id: m.schluessel + '|' + a.teil, ordner: m.ordner, uid: m.uid, uidvalidity: m.uidvalidity, teil: a.teil, nr: meineNr,
              datum: m.datum || 0, von: ((m.von_name || '') + (m.von_adresse ? ' <' + m.von_adresse + '>' : '')).trim(), betreff: m.betreff || '',
              mailtext: String(m.text || '').slice(0, 1500), name: a.name, typ: a.typ, groesse: a.groesse,
              status: ar.inDrive(a, verz) ? 'in_drive' : 'neu', erstellt: Date.now() });
            gefunden += r.changes;
          });
          merkeMail.run(m.schluessel, Date.now());
        });
      })();
    }
  }
  return gefunden;
}

// ---------------- Einordnen ----------------
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    vermietung: { type: 'boolean' }, objekt: { type: 'string' }, einheit: { type: 'string' },
    art: { type: 'string', enum: ar.ARTEN }, kostenart: { type: 'string' }, jahr: { type: 'string' }, datum: { type: 'string' },
    betrag: { type: 'number' }, dateiname: { type: 'string' }, sicherheit: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] }
  },
  required: ['vermietung', 'objekt', 'einheit', 'art', 'kostenart', 'jahr', 'datum', 'betrag', 'dateiname', 'sicherheit']
};
const SYSTEM = 'Du hilfst Louis Ziegler, einem privaten Vermieter, Mail-Anhänge für seine Mietobjekte abzulegen. Bestimme für den Anhang:\n'
  + '- vermietung: gehört er zu seinen Mietobjekten? Nein bei privaten Einkäufen, privaten Versicherungen, Werbung, Newslettern.\n'
  + '- objekt und einheit: die ID aus der Liste; einheit nur, wenn es eine bestimmte Wohnung betrifft, sonst leer.\n'
  + '- art: „Nebenkosten-Rechnung“ = umlagefähige Betriebskosten nach der Betriebskostenverordnung (Grundsteuer, Wasser und Abwasser, '
  + 'Heizung und Warmwasser samt Wartung und Messdienst, Aufzug, Straßenreinigung, Müllabfuhr, Gebäudereinigung, Gartenpflege, '
  + 'Allgemeinstrom und Beleuchtung, Schornsteinfeger, Gebäudeversicherung, Hausmeister, Kabel und Antenne, laufende Wartung wie '
  + 'Rauchmelder). „Rechnung“ = alle übrigen, nicht umlagefähigen Rechnungen (Reparaturen, Instandhaltung, Handwerker, Anschaffungen, '
  + 'Modernisierung, Anwalt, Verwaltung, Bank). „Nebenkostenabrechnung“ = Abrechnung für Mieter oder vom Messdienst (z. B. ista). '
  + '„Bescheid“ = Steuer-, Grundsteuer-, Abwasser- oder Gebührenbescheid. Versicherungsschein = „Versicherung“. Sonst nach Inhalt.\n'
  + '- kostenart: bei Nebenkosten-Rechnung eine von: ' + ar.KOSTENARTEN.join(', ') + '; sonst ein kurzes Stichwort (z. B. „Reparatur Heizung“) oder leer.\n'
  + '- jahr: das Jahr, auf das sich die Kosten beziehen (Leistungs- oder Abrechnungszeitraum) — eine Rechnung vom Januar für Dezember gehört '
  + 'zum Vorjahr; sonst das Jahr des Dokuments (JJJJ).\n'
  + '- datum: Datum des Dokuments (JJJJ-MM-TT) oder leer. betrag: Gesamtbetrag in Euro (brutto), unbekannt = 0.\n'
  + '- dateiname: ohne Endung, Schema „JJJJ-MM-TT Art Aussteller Stichwort“, z. B. „2026-11-01 Rechnung Hausmeister Oktober MR Hausdienstleistungen“.\n'
  + '- sicherheit: wie sicher Objekt und Art sind.\n'
  + 'Nichts erfinden: was nicht hervorgeht, leer lassen und sicherheit „niedrig“.';

async function lesen(q, a, s) {
  const pdf = /pdf/i.test(a.typ || '') || /\.pdf$/i.test(a.name);
  const bild = /\.(jpe?g|png)$/i.test(a.name) || /^image\/(jpeg|png)$/i.test(a.typ || '');
  let inhalt = null;
  if ((pdf || bild) && Number(a.groesse) * 0.73 <= INHALT_HOECHSTENS) {
    const d = await q.anhangInhalt(a.ordner, a.uid, a.name, a.nr);
    if (d && d.inhalt && d.inhalt.length <= INHALT_HOECHSTENS) inhalt = d.inhalt;
  }
  const inhaltBlock = !inhalt ? [] : [pdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: inhalt.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: /png/i.test((a.typ || '') + a.name) ? 'image/png' : 'image/jpeg', data: inhalt.toString('base64') } }];
  const datum = a.datum ? new Date(a.datum).toISOString().slice(0, 10) : '';
  return intern.claudeJson({
    max_tokens: 1500,
    system: SYSTEM + '\n\nObjekte und Wohnungen:\n' + intern.objektListe(s),
    messages: [{ role: 'user', content: inhaltBlock.concat([{ type: 'text', text: 'Mail von: ' + a.von + '\nBetreff: ' + a.betreff + '\nDatum: ' + datum
      + '\nAnhang: ' + a.name + (inhalt ? '' : ' (Inhalt nicht lesbar — nur nach Mail und Namen urteilen)') + '\nAnfang der Mail:\n' + String(a.mailtext || '').slice(0, 1200) }]) }]
  }, SCHEMA, tageszaehler);
}

const setzen = db.prepare(`UPDATE anh_dateien SET status = @status, objekt = @objekt, einheit = @einheit, art = @art, kostenart = @kostenart,
  jahr = @jahr, betrag = @betrag, dateiname = @dateiname, quelle = @quelle, sicherheit = @sicherheit WHERE id = @id AND status = 'neu'`);
function mitRegeln(a, wb) {
  const m = { betreff: a.betreff, von: a.von, text: a.mailtext, datum: a.datum };
  const r = ar.ohneAssistent(m, a, wb);
  setzen.run({ id: a.id, status: 'vorschlag', objekt: r.objekt, einheit: r.einheit, art: r.art, kostenart: '', jahr: r.jahr, betrag: null,
    dateiname: ar.dateiname('', a, m, r.art), quelle: 'regel', sicherheit: r.sicher ? 'mittel' : 'niedrig' });
}
const abbrechen = function (x) { return x && (x.status === 401 || x.status === 429 || /Guthaben/.test(x.message || '')); };

async function einordnen(q) {
  const s = standInhalt() || {};
  const wb = woerterbuch(s);
  const mitAssistent = !!einstellung('anthropic_token');
  const zeilen = db.prepare("SELECT * FROM anh_dateien WHERE status = 'neu' ORDER BY datum DESC LIMIT ?").all(mitAssistent ? LESEN_JE_LAUF : 2000);
  for (const a of zeilen) {
    if (!mitAssistent) { mitRegeln(a, wb); continue; }
    if (tageszaehler(0) >= LESEN_JE_TAG) break;   // Tageslimit: morgen weiter
    let r;
    try { r = await lesen(q, a, s); }
    catch (x) {
      if (abbrechen(x)) break;
      mitRegeln(a, wb);   // nicht lesbar: dann wenigstens nach Regeln
      continue;
    }
    const o = (s.objects || []).find(function (x) { return x.id === r.objekt; });
    const einheitOk = o && (o.units || []).some(function (x) { return x.id === r.einheit; });
    const m = { betreff: a.betreff, von: a.von, datum: a.datum };
    const art = ar.ARTEN.indexOf(r.art) !== -1 ? r.art : 'Sonstiges';
    setzen.run({ id: a.id, status: r.vermietung ? 'vorschlag' : 'fremd', objekt: o ? o.id : '', einheit: einheitOk ? r.einheit : '', art: art,
      kostenart: String(r.kostenart || '').slice(0, 60), jahr: /^(19|20)\d{2}$/.test(r.jahr || '') ? r.jahr : '',
      betrag: Number(r.betrag) > 0 ? Math.round(Number(r.betrag) * 100) / 100 : null,
      dateiname: ar.dateiname(r.dateiname, a, m, art), quelle: 'assistent', sicherheit: r.sicherheit || 'niedrig' });
  }
}

async function abgleichen() {
  if (stand.laeuft) return;
  const q = quelle();
  if (!q.postfachBereit()) return;
  stand.laeuft = true; stand.fehler = null;
  try {
    await neueAnhaenge(q);
    await einordnen(q);
  } catch (x) {
    stand.fehler = x.message;
  } finally {
    stand.laeuft = false; stand.zuletzt = Date.now();
  }
}
setTimeout(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, 90000).unref();
setInterval(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, TAKT_MS).unref();

// ---------------- Wohin in Google Drive? ----------------
function ordnerBaum() {
  const k = intern.karte();
  const nachPfad = new Map(), kinder = new Map();
  k.ordner.forEach(function (o, id) {
    const p = intern.ordnerPfad(id, k);
    if (p) nachPfad.set(p, id);
    if (!kinder.has(o.eltern)) kinder.set(o.eltern, []);
    kinder.get(o.eltern).push({ id: id, name: o.name });
  });
  return { k: k, nachPfad: nachPfad, kinder: kinder };
}
// Der Ordner eines Objekts: der Ordner, an dessen Namen die Dateien dieses Objekts erkannt werden („/Firma/Tribergle“)
function objektOrdner(objekt, b, wb) {
  // Je Anfrage nur einmal ausrechnen (die Liste fragt für jeden Anhang)
  if (!b.objekte) b.objekte = new Map();
  if (b.objekte.has(objekt)) return b.objekte.get(objekt);
  const erg = objektOrdnerSuchen(objekt, b, wb);
  b.objekte.set(objekt, erg);
  return erg;
}
function objektOrdnerSuchen(objekt, b, wb) {
  const zaehler = new Map();
  db.prepare("SELECT pfad FROM dok_dateien WHERE objekt = ? AND status = 'zugeordnet' LIMIT 400").all(objekt).forEach(function (r) {
    const teile = String(r.pfad || '').split('/').filter(Boolean);
    for (let i = 1; i <= teile.length; i++) {
      const p = '/' + teile.slice(0, i).join('/');
      if (regeln.zuordnen(p, '', wb).objekt === objekt) { zaehler.set(p, (zaehler.get(p) || 0) + 1); break; }
    }
  });
  let bester = null, n = 0;
  zaehler.forEach(function (z, p) { if (z > n && b.nachPfad.has(p)) { bester = p; n = z; } });
  if (bester) return { id: b.nachPfad.get(bester), pfad: bester };
  // Sonst über den Beleg-Ordner beim Objekt: dessen Elternordner
  const o = ((standInhalt() || {}).objects || []).find(function (x) { return x.id === objekt; });
  const beleg = o && o.ordnerId ? b.k.ordner.get(String(o.ordnerId)) : null;
  if (beleg && beleg.eltern) { const p = intern.ordnerPfad(beleg.eltern, b.k); if (p) return { id: beleg.eltern, pfad: p }; }
  return null;
}
function kindNach(b, elternId, test) { return (b.kinder.get(elternId) || []).find(function (x) { return test(x.name); }) || null; }

// Ziel eines Anhangs — mit erstellen: fehlende Ordner in Drive anlegen
async function ziel(a, b, wb, erstellen) {
  const obj = objektOrdner(a.objekt, b, wb);
  if (!obj) return { fehlt: 'Für dieses Objekt gibt es in Google Drive keinen Ordner' };
  const kat = ar.KATEGORIEN[ar.kategorie(a.art)];
  const schritte = [];
  if (kat.muster) schritte.push({ test: function (n) { return kat.muster.test(n.trim()); }, neu: kat.neu });
  if (ar.kategorie(a.art) === 'mieter' && a.einheit) {
    const o = ((standInhalt() || {}).objects || []).find(function (x) { return x.id === a.objekt; });
    const e = o && (o.units || []).find(function (x) { return x.id === a.einheit; });
    if (e) schritte.push({ test: function (n) { return regeln.normal(n).trim() === regeln.normal(e.name).trim(); }, neu: e.name });
  }
  if (kat.jahr && /^(19|20)\d{2}$/.test(a.jahr || '')) schritte.push({ test: function (n) { return n.trim() === a.jahr; }, neu: a.jahr });
  let id = obj.id, pfad = obj.pfad;
  const neu = [];
  for (const s of schritte) {
    const vorhanden = kindNach(b, id, s.test);
    if (vorhanden) { id = vorhanden.id; pfad += '/' + vorhanden.name; continue; }
    neu.push(s.neu);
    if (erstellen) {
      const angelegt = await ordnerAnlegen(s.neu, id);
      intern.ordnerMerken.run(intern.ordnerZeile({ id: angelegt.id, name: s.neu, parents: [id] }, Date.now()));
      if (!b.kinder.has(id)) b.kinder.set(id, []);
      b.kinder.get(id).push({ id: angelegt.id, name: s.neu });
      id = angelegt.id;
    } else id = null;
    pfad += '/' + s.neu;
    if (!erstellen) {
      // Ab hier gibt es nichts mehr nachzusehen — der Rest wird neu angelegt
      schritte.slice(schritte.indexOf(s) + 1).forEach(function (r) { neu.push(r.neu); pfad += '/' + r.neu; });
      break;
    }
  }
  return { id: id, pfad: pfad, neu: neu };
}

async function googleAnfrage(url, optionen) {
  const antwort = await holen(url, Object.assign({}, optionen, {
    headers: Object.assign({ Authorization: 'Bearer ' + await google.googleToken() }, (optionen && optionen.headers) || {})
  }));
  if (antwort.status === 401) google.googleZugriffVergessen();
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    throw fehler(antwort.status === 403 ? 'Google erlaubt der App das Ablegen nicht — ist „Google Drive bearbeiten erlauben“ eingeschaltet?'
      : 'Google antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 120) : ''), antwort.status);
  }
  return antwort.json();
}
function ordnerAnlegen(name, eltern) {
  return googleAnfrage(intern.DRIVE + '/files?fields=id,name', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, mimeType: ORDNER_TYP, parents: [eltern] })
  });
}
function hochladen(name, typ, inhalt, eltern) {
  const grenze = 'grenze' + Date.now() + Math.random().toString(36).slice(2);
  const koerper = Buffer.concat([
    Buffer.from('--' + grenze + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: name, parents: [eltern] }) + '\r\n'),
    Buffer.from('--' + grenze + '\r\nContent-Type: ' + (typ || 'application/octet-stream') + '\r\n\r\n'),
    inhalt,
    Buffer.from('\r\n--' + grenze + '--')
  ]);
  return googleAnfrage(UPLOAD + '/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,modifiedTime,parents', {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + grenze }, body: koerper, signal: AbortSignal.timeout(120000)
  });
}

// Einen Anhang ablegen: Ziel auflösen (Ordner anlegen), Anhang holen, hochladen, in der Dokumentliste eintragen
async function ablegen(a, b, wb) {
  if (!a.objekt) throw fehler('Erst ein Objekt wählen', 400);
  const z = await ziel(a, b, wb, true);
  if (!z.id) throw fehler(z.fehlt || 'Kein Zielordner', 409);
  const d = await quelle().anhangInhalt(a.ordner, a.uid, a.name, a.nr);
  // Gleicher Name im Zielordner? Dann eine Nummer dazu
  const e = namen.endung(a.dateiname || a.name), basis = namen.stamm(a.dateiname || a.name);
  let name = a.dateiname || a.name;
  const belegt = db.prepare('SELECT 1 FROM dok_dateien WHERE eltern = ? AND lower(name) = lower(?)');
  for (let i = 2; belegt.get(z.id, name) && i < 1000; i++) name = basis + ' ' + i + e;
  const f = await hochladen(name, d.typ || a.typ, d.inhalt, z.id);
  const jetzt = Date.now();
  db.prepare(`INSERT OR REPLACE INTO dok_dateien (id, name, pfad, eltern, mime, groesse, geaendert, url, objekt, einheit, art, titel, datum, quelle,
    status, erstmals, lauf, aufnahme) VALUES (@id, @name, @pfad, @eltern, @mime, @groesse, @geaendert, @url, @objekt, @einheit, @art, '', '', 'ablage',
    'zugeordnet', @jetzt, @jetzt, '')`).run({ id: f.id, name: f.name || name, pfad: z.pfad, eltern: z.id, mime: f.mimeType || d.typ || '',
    groesse: Number(f.size) || d.inhalt.length, geaendert: Date.parse(f.modifiedTime || '') || jetzt,
    url: f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view'), objekt: a.objekt, einheit: a.einheit || '', art: ar.dokArt(a.art), jetzt: jetzt });
  db.prepare('INSERT OR REPLACE INTO dok_meta (id, jahr, kostenart, betrag, herkunft) VALUES (?, ?, ?, ?, ?)')
    .run(f.id, a.jahr || '', a.kostenart || '', a.betrag, ('Mail: ' + a.von + ' · ' + a.betreff).slice(0, 300));
  db.prepare("UPDATE anh_dateien SET status = 'abgelegt', drive_id = ?, fehler = NULL WHERE id = ?").run(f.id, a.id);
  return { pfad: z.pfad, name: f.name || name };
}

// ---------------- Schnittstellen ----------------
function zeileAus(a, b, wb) {
  return {
    id: a.id, datum: a.datum, von: a.von, betreff: a.betreff, name: a.name, typ: a.typ, groesse: a.groesse, status: a.status,
    objekt: a.objekt || '', einheit: a.einheit || '', art: a.art || '', kostenart: a.kostenart || '', jahr: a.jahr || '', betrag: a.betrag,
    dateiname: a.dateiname || a.name, quelle: a.quelle, sicherheit: a.sicherheit, fehler: a.fehler || null,
    gruppe: a.status === 'neu' ? 'offen' : (!a.objekt ? 'offen' : ar.kategorie(a.art))
  };
}
app.get('/api/anhaenge', nurAngemeldet, nurVerwalter, async function (req, res) {
  const q = quelle();
  const s = standInhalt() || {};
  const wb = woerterbuch(s);
  const b = ordnerBaum();
  const zeilen = db.prepare("SELECT * FROM anh_dateien WHERE status IN ('neu', 'vorschlag') ORDER BY datum DESC LIMIT 3000").all();
  const liste = [];
  for (const a of zeilen) {
    const z = zeileAus(a, b, wb);
    if (a.status === 'vorschlag' && a.objekt) {
      try { const zi = await ziel(a, b, wb, false); z.ziel = zi.pfad || ''; z.zielNeu = zi.neu || []; z.zielFehlt = zi.fehlt || ''; }
      catch (x) { z.zielFehlt = x.message; }
    }
    liste.push(z);
  }
  const zahl = function (st) { return db.prepare('SELECT COUNT(*) AS n FROM anh_dateien WHERE status = ?').get(st).n; };
  res.json({
    postfach: q.postfachBereit(), drive: intern.googleVerbunden() && intern.darfLesen() && !!intern.auswahl(), bearbeiten: google.darfBearbeiten(),
    assistent: !!einstellung('anthropic_token'), heute: tageszaehler(0), grenze: LESEN_JE_TAG,
    laeuft: stand.laeuft, zuletzt: stand.zuletzt || null, fehler: stand.fehler,
    zahlen: { neu: zahl('neu'), vorschlag: zahl('vorschlag'), in_drive: zahl('in_drive'), abgelegt: zahl('abgelegt'), fremd: zahl('fremd'), ignoriert: zahl('ignoriert') },
    kostenarten: ar.KOSTENARTEN, arten: ar.ARTEN, liste: liste
  });
});

// Louis ändert den Vorschlag (oder sagt „nicht ablegen“)
app.put('/api/anhaenge/:id', nurAngemeldet, nurVerwalter, function (req, res) {
  const a = db.prepare('SELECT * FROM anh_dateien WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ fehler: 'Anhang nicht gefunden' });
  const b = req.body || {};
  if (b.ignorieren) {
    db.prepare("UPDATE anh_dateien SET status = 'ignoriert' WHERE id = ?").run(a.id);
    return res.json({ ok: true });
  }
  const s = standInhalt() || {};
  const objekt = b.objekt !== undefined ? String(b.objekt || '') : a.objekt;
  const o = (s.objects || []).find(function (x) { return x.id === objekt; });
  if (objekt && !o) return res.status(400).json({ fehler: 'Dieses Objekt gibt es nicht' });
  let einheit = b.einheit !== undefined ? String(b.einheit || '') : a.einheit;
  if (!o || (einheit && !(o.units || []).some(function (x) { return x.id === einheit; }))) einheit = '';
  const art = b.art !== undefined && ar.ARTEN.indexOf(String(b.art)) !== -1 ? String(b.art) : (a.art || 'Sonstiges');
  const jahr = b.jahr !== undefined ? (/^(19|20)\d{2}$/.test(String(b.jahr)) ? String(b.jahr) : '') : a.jahr;
  const kostenart = b.kostenart !== undefined ? String(b.kostenart || '').slice(0, 60) : a.kostenart;
  const dateiname = b.dateiname !== undefined ? ar.dateiname(String(b.dateiname || ''), a, { betreff: a.betreff, von: a.von, datum: a.datum }, art) : a.dateiname;
  db.prepare(`UPDATE anh_dateien SET status = 'vorschlag', objekt = ?, einheit = ?, art = ?, jahr = ?, kostenart = ?, dateiname = ?, quelle = 'louis'
    WHERE id = ?`).run(objekt, einheit, art, jahr, kostenart, dateiname, a.id);
  res.json({ ok: true });
});

// Ablegen — höchstens zehn auf einmal (die Oberfläche schickt den Rest nach)
app.post('/api/anhaenge/ablegen', nurAngemeldet, nurVerwalter, async function (req, res) {
  if (!google.darfBearbeiten()) return res.status(409).json({ fehler: 'Ablegen ist ausgeschaltet — erst „Google Drive bearbeiten erlauben“ einschalten' });
  if (!intern.auswahl()) return res.status(409).json({ fehler: 'Erst Google Drive einrichten (Ordner wählen)' });
  const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).slice(0, 10).map(String);
  const wb = woerterbuch();
  const b = ordnerBaum();
  const ergebnisse = [];
  for (const id of ids) {
    const a = db.prepare("SELECT * FROM anh_dateien WHERE id = ? AND status = 'vorschlag'").get(id);
    if (!a) { ergebnisse.push({ id: id, ok: false, fehler: 'Nicht (mehr) zum Ablegen vorgemerkt' }); continue; }
    try {
      const r = await ablegen(a, b, wb);
      ergebnisse.push({ id: id, ok: true, pfad: r.pfad, name: r.name });
    } catch (x) {
      db.prepare('UPDATE anh_dateien SET fehler = ? WHERE id = ?').run(String(x.message).slice(0, 300), id);
      ergebnisse.push({ id: id, ok: false, fehler: x.message, name: a.dateiname || a.name });
      if (x.status === 401 || x.status === 403) break;   // ohne Recht hat der Rest keinen Sinn
    }
  }
  res.json({ ok: true, ergebnisse: ergebnisse });
});

// Den Anhang ansehen, bevor er abgelegt wird — immer als Datei, nie im Browser ausgeführt
app.get('/api/anhaenge/:id/datei', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
  const a = db.prepare('SELECT * FROM anh_dateien WHERE id = ?').get(req.params.id);
  if (!a) throw fehler('Anhang nicht gefunden', 404);
  const d = await quelle().anhangInhalt(a.ordner, a.uid, a.name, a.nr);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(d.name || a.name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(d.inhalt);
}));

app.post('/api/anhaenge/abgleich', nurAngemeldet, nurVerwalter, function (req, res) {
  abgleichen().catch(function () { /* steht in stand.fehler */ });
  res.json({ ok: true });
});

module.exports = { router: app, abgleichen };
