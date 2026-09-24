'use strict';

// -------------------------------------------------------------
//  Datenstand der App (Objekte, Mieter, Interessenten …) und Verlauf
// -------------------------------------------------------------

const express = require('express');
const { db, datenGeaendert } = require('./kern');
const { nurAngemeldet } = require('./anmeldung');

const app = express.Router();

app.get('/api/data', nurAngemeldet, function (req, res) {
  const s = db.prepare('SELECT * FROM stand WHERE id = 1').get();
  res.json(s
    ? { data: JSON.parse(s.inhalt), wer: s.wer, wann: s.wann }
    : { data: null });
});

// Speichern in einem Rutsch: Stand und Verlauf gemeinsam oder gar nicht
const standSpeichern = db.transaction(function (inhalt, wer, jetzt) {
  db.prepare('INSERT OR REPLACE INTO stand (id, inhalt, wer, wann) VALUES (1,?,?,?)').run(inhalt, wer, jetzt);
  db.prepare('INSERT INTO verlauf (inhalt, wer, wann) VALUES (?,?,?)').run(inhalt, wer, jetzt);
  // Verlauf auf die letzten 50 Stände begrenzen
  db.prepare('DELETE FROM verlauf WHERE id NOT IN (SELECT id FROM verlauf ORDER BY id DESC LIMIT 50)').run();
});

app.put('/api/data', nurAngemeldet, function (req, res) {
  const body = req.body || {};
  const inhalt = JSON.stringify(body.data);
  if (!inhalt || inhalt === 'undefined' || inhalt === 'null') return res.status(400).json({ fehler: 'keine Daten' });

  // Schutz vor gegenseitigem Überschreiben: Der Browser schickt mit, auf welchem Stand
  // (basis = dessen "wann") seine Änderung aufbaut. Ist der Server inzwischen weiter, gibt es 409.
  // Ältere Oberflächen schicken keine basis mit — die werden wie bisher durchgelassen.
  if (body.basis !== undefined && !body.erzwingen) {
    const aktuell = db.prepare('SELECT wer, wann FROM stand WHERE id = 1').get();
    if (aktuell && aktuell.wann !== body.basis) {
      return res.status(409).json({
        fehler: 'Inzwischen hat ' + (aktuell.wer || 'jemand') + ' gespeichert',
        wer: aktuell.wer, wann: aktuell.wann
      });
    }
  }

  // Nie denselben Zeitstempel zweimal vergeben, er dient als Versionsnummer
  const vorher = db.prepare('SELECT wann FROM stand WHERE id = 1').get();
  const jetzt = Math.max(Date.now(), vorher ? vorher.wann + 1 : 0);
  standSpeichern(inhalt, req.nutzer, jetzt);
  datenGeaendert();   // z. B. hängen die Suchbegriffe der Post an Mietern und Objekten
  res.json({ ok: true, wann: jetzt, wer: req.nutzer });
});

app.get('/api/verlauf', nurAngemeldet, function (req, res) {
  res.json(db.prepare('SELECT id, wer, wann, length(inhalt) AS groesse FROM verlauf ORDER BY id DESC').all());
});

app.get('/api/verlauf/:id', nurAngemeldet, function (req, res) {
  const e = db.prepare('SELECT * FROM verlauf WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ fehler: 'nicht gefunden' });
  let daten;
  try { daten = JSON.parse(e.inhalt); }
  catch (fehler) { return res.status(500).json({ fehler: 'Dieser Stand ist beschädigt' }); }
  res.json({ data: daten, wer: e.wer, wann: e.wann });
});

module.exports = { router: app };
