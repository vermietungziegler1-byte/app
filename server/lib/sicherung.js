'use strict';

const express = require('express');
const { Database, path, fs, DATENORDNER, db, holen, einstellung, einstellungSetzen, berlinJetzt } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const { googleEinstellungen, googleToken } = require('./google');
const { webpush, mitteilungSenden } = require('./push');

const app = express.Router();

// ---------------- Sicherung ----------------
// Einmal am Tag eine Kopie der Datenbank in daten/sicherung, die letzten 14 bleiben liegen.
// Die Kopie entsteht im laufenden Betrieb und ist trotzdem in sich stimmig (SQLite-Backup).
const SICHERUNGSORDNER = path.join(DATENORDNER, 'sicherung');
fs.mkdirSync(SICHERUNGSORDNER, { recursive: true });

// Zusätzlich wandert jede Tagessicherung in Google Drive (Ordner „Vermietung – Sicherungen“),
// damit die Daten auch einen Ausfall des ganzen Servers überstehen. Dort bleiben die letzten 30.
// In der Drive-Kopie sind Zugangsschlüssel und Anmeldungen entfernt — die liegen nur auf dem Server.

const DRIVE_BEHALTEN = 30;
const GEHEIME_EINSTELLUNGEN = ['todoist_token', 'google_client_secret', 'google_refresh',
  'openai_token', 'anthropic_token', 'gkal_ics', 'vapid_schluessel'];

function sicherungStatus() {
  try { return JSON.parse(einstellung('sicherung_status') || '{}'); } catch (e) { return {}; }
}
function sicherungStatusSetzen(teil) {
  einstellungSetzen('sicherung_status', JSON.stringify(Object.assign(sicherungStatus(), teil)));
}

async function drive(token, pfad, optionen) {
  const o = Object.assign({}, optionen || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {});
  const antwort = await holen('https://www.googleapis.com/drive/v3' + pfad, o);
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    let text = '';
    try { text = ((JSON.parse(grund) || {}).error || {}).message || ''; } catch (x) { text = grund; }
    // Häufigster Fall beim Einrichten: die Drive-Schnittstelle ist im Google-Projekt noch aus
    const e = new Error(/has not been used|is disabled|accessNotConfigured/i.test(grund)
      ? 'Die Google Drive API ist im Google-Cloud-Projekt nicht aktiviert — dort unter APIs & Dienste → Bibliothek → Google Drive API → Aktivieren'
      : 'Drive antwortet mit ' + antwort.status + (text ? ': ' + String(text).slice(0, 160) : ''));
    e.status = antwort.status;
    throw e;
  }
  return antwort.status === 204 ? null : antwort.json();
}

// Den Sicherungsordner finden oder anlegen
async function driveOrdner(token) {
  const id = einstellung('sicherung_drive_ordner');
  if (id) {
    try {
      const o = await drive(token, '/files/' + encodeURIComponent(id) + '?fields=id,trashed');
      if (o && !o.trashed) return id;
    } catch (e) { if (e.status !== 404) throw e; }
  }
  const neu = await drive(token, '/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Vermietung – Sicherungen', mimeType: 'application/vnd.google-apps.folder' })
  });
  einstellungSetzen('sicherung_drive_ordner', neu.id);
  return neu.id;
}

// Hochladen in zwei Schritten (resumable), das klappt auch bei großen Dateien
async function driveHochladen(token, ordner, name, puffer) {
  const start = await holen('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(puffer.length)
    },
    body: JSON.stringify({ name: name, parents: [ordner] })
  });
  if (!start.ok) throw new Error('Drive lehnt das Hochladen ab (' + start.status + ')');
  const ziel = start.headers.get('location');
  if (!ziel) throw new Error('Drive hat keine Upload-Adresse geliefert');
  const antwort = await holen(ziel, {
    signal: AbortSignal.timeout(300000),
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: puffer
  });
  if (!antwort.ok) throw new Error('Drive hat die Datei nicht angenommen (' + antwort.status + ')');
  return antwort.json();
}

// Nur die letzten DRIVE_BEHALTEN Sicherungen im Ordner behalten
async function driveAufraeumen(token, ordner) {
  const q = "'" + ordner + "' in parents and trashed = false and name contains 'vermietung-'";
  const liste = await drive(token, '/files?pageSize=200&orderBy=' + encodeURIComponent('name desc,createdTime desc')
    + '&fields=files(id,name)&q=' + encodeURIComponent(q));
  // Je Tag nur die neueste behalten (bei „Jetzt sichern“ entstehen sonst Doppelte), insgesamt DRIVE_BEHALTEN Tage
  const gesehen = {};
  const alt = (liste.files || []).filter(function (f) {
    if (gesehen[f.name]) return true;
    gesehen[f.name] = true;
    return Object.keys(gesehen).length > DRIVE_BEHALTEN;
  });
  for (const f of alt) {
    try { await drive(token, '/files/' + encodeURIComponent(f.id), { method: 'DELETE' }); } catch (e) { /* nächstes Mal */ }
  }
}

// Kopie ohne Geheimnisse bauen und nach Drive schicken
async function nachDrive(datei, datum) {
  const sauber = datei + '.drive';
  try {
    fs.copyFileSync(datei, sauber);
    const kopie = new Database(sauber);
    kopie.prepare('DELETE FROM einstellungen WHERE schluessel IN (' + GEHEIME_EINSTELLUNGEN.map(function () { return '?'; }).join(',') + ')')
      .run(GEHEIME_EINSTELLUNGEN);
    kopie.prepare('DELETE FROM sitzungen').run();
    kopie.exec('VACUUM');
    kopie.close();
    const puffer = fs.readFileSync(sauber);
    const token = await googleToken();
    const ordner = await driveOrdner(token);
    await driveHochladen(token, ordner, 'vermietung-' + datum + '.db', puffer);
    await driveAufraeumen(token, ordner);
  } finally {
    try { fs.unlinkSync(sauber); } catch (e) { /* schon weg */ }
  }
}

let sicherungLaeuft = false;
async function sichern(erzwingen) {
  if (sicherungLaeuft) return;
  sicherungLaeuft = true;
  const datum = berlinJetzt().datum;
  const ziel = path.join(SICHERUNGSORDNER, 'vermietung-' + datum + '.db');
  try {
    // 1. Auf dem Server
    if (!fs.existsSync(ziel) || erzwingen) {
      try {
        if (fs.existsSync(ziel)) fs.unlinkSync(ziel);
        await db.backup(ziel);
        fs.readdirSync(SICHERUNGSORDNER)
          .filter(function (n) { return /^vermietung-\d{4}-\d{2}-\d{2}\.db$/.test(n); })
          .sort().reverse().slice(14)
          .forEach(function (n) { fs.unlinkSync(path.join(SICHERUNGSORDNER, n)); });
        sicherungStatusSetzen({ lokal: Date.now(), lokalFehler: null });
      } catch (e) {
        console.log('Sicherung fehlgeschlagen:', e.message);
        try { fs.unlinkSync(ziel); } catch (x) { /* halbe Datei weg */ }
        sicherungStatusSetzen({ lokalFehler: e.message });
        return;
      }
    }

    // 2. In Google Drive — einmal am Tag, sobald das Postfach verbunden ist
    const status = sicherungStatus();
    if (!googleEinstellungen().refresh) {
      sicherungStatusSetzen({ driveFehler: 'Google ist nicht verbunden' });
      return;
    }
    if (status.driveDatum === datum && !erzwingen) return;
    // Nach einem Fehler nicht jede Stunde neu versuchen, sondern alle drei Stunden
    if (!erzwingen && status.driveVersuch && Date.now() - status.driveVersuch < 3 * 3600 * 1000 && status.driveFehler) return;
    sicherungStatusSetzen({ driveVersuch: Date.now() });
    try {
      await nachDrive(ziel, datum);
      sicherungStatusSetzen({ drive: Date.now(), driveDatum: datum, driveFehler: null, gemeldet: null });
    } catch (e) {
      console.log('Sicherung nach Drive fehlgeschlagen:', e.message);
      sicherungStatusSetzen({ driveFehler: e.message });
      // Einmal am Tag Bescheid geben, wenn Mitteilungen eingerichtet sind
      if (webpush && sicherungStatus().gemeldet !== datum) {
        sicherungStatusSetzen({ gemeldet: datum });
        const zeilen = db.prepare('SELECT * FROM push_abos').all();
        if (zeilen.length) {
          await mitteilungSenden(zeilen, {
            titel: 'Sicherung nicht in Drive',
            text: 'Die Kopie in Google Drive hat heute nicht geklappt: ' + e.message.slice(0, 120),
            url: '/', tag: 'sicherung'
          }).catch(function () { /* egal */ });
        }
      }
    }
  } finally {
    sicherungLaeuft = false;
  }
}
sichern();
setInterval(sichern, 60 * 60 * 1000).unref();

// Stand der Sicherungen für die Oberfläche
app.get('/api/sicherung', nurAngemeldet, nurVerwalter, function (req, res) {
  const s = sicherungStatus();
  let dateien = [];
  try {
    dateien = fs.readdirSync(SICHERUNGSORDNER)
      .filter(function (n) { return /^vermietung-\d{4}-\d{2}-\d{2}\.db$/.test(n); })
      .sort().reverse()
      .map(function (n) { return { name: n, groesse: fs.statSync(path.join(SICHERUNGSORDNER, n)).size }; });
  } catch (e) { /* leer */ }
  // Ohne gemerkten Zeitpunkt (z. B. Sicherungen aus der Zeit davor) zählt die neueste Datei
  let lokal = s.lokal || null;
  if (!lokal && dateien.length) {
    try { lokal = fs.statSync(path.join(SICHERUNGSORDNER, dateien[0].name)).mtimeMs; } catch (e) { /* egal */ }
  }
  res.json({
    lokal: lokal, lokalFehler: s.lokalFehler || null,
    drive: s.drive || null, driveFehler: s.driveFehler || null,
    googleVerbunden: !!googleEinstellungen().refresh,
    dateien: dateien, laeuft: sicherungLaeuft
  });
});

// Jetzt sofort sichern (Server und Drive)
app.post('/api/sicherung', nurAngemeldet, nurVerwalter, async function (req, res) {
  if (sicherungLaeuft) return res.status(409).json({ fehler: 'Eine Sicherung läuft gerade' });
  await sichern(true);
  const s = sicherungStatus();
  res.json({ lokal: s.lokal || null, drive: s.drive || null, driveFehler: s.driveFehler || null, lokalFehler: s.lokalFehler || null });
});

module.exports = { router: app };
