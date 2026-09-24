'use strict';

const express = require('express');
const { db, einstellung, einstellungSetzen } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');

const app = express.Router();

// ---------------- Rechnungen (Allgemeinstrom) ----------------
db.exec(`
  CREATE TABLE IF NOT EXISTS rechnungen (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nummer  TEXT NOT NULL,
    objekt  TEXT,
    datum   TEXT,
    brutto  REAL,
    inhalt  TEXT NOT NULL,
    wer     TEXT,
    wann    INTEGER NOT NULL
  );
`);

try { db.exec("ALTER TABLE rechnungen ADD COLUMN art TEXT NOT NULL DEFAULT 'as'"); } catch (e) { /* schon da */ }

// Jede Rechnungsnummer nur einmal — auch wenn zwei gleichzeitig speichern
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS rechnungen_nummer ON rechnungen (nummer)'); }
catch (e) { console.log('Hinweis: Es gibt doppelte Rechnungsnummern, deshalb fehlt die Eindeutigkeitsprüfung in der Datenbank:', e.message); }

const RECHNUNG_ABSENDER_FELDER = {
  as: ['name', 'strasse', 'ort', 'steuernummer', 'ustId', 'kontoinhaber', 'iban', 'bank', 'kontakt', 'empfaenger'],
  nk: ['vermieter', 'strasse', 'ort', 'telefon', 'unterschrift', 'kontoText', 'anlage']
};
// Solarstrom-Rechnungen (pv) haben denselben Absender wie die Allgemeinstrom-Rechnungen
const RECHNUNG_ABSENDER_SCHLUESSEL = { as: 'rechnung_absender', pv: 'rechnung_absender', nk: 'nk_absender' };
const RECHNUNG_ARTEN = { as: 'AS', pv: 'PV', nk: 'NK' };

function rechnungAbsender(art) {
  try { return JSON.parse(einstellung(RECHNUNG_ABSENDER_SCHLUESSEL[art] || 'rechnung_absender') || '{}'); } catch (e) { return {}; }
}
function rechnungenListe() {
  return db.prepare('SELECT * FROM rechnungen ORDER BY datum DESC, id DESC').all().map(function (r) {
    let inhalt = {};
    try { inhalt = JSON.parse(r.inhalt); } catch (e) { /* egal */ }
    return { id: r.id, art: r.art || 'as', nummer: r.nummer, objekt: r.objekt, datum: r.datum, brutto: r.brutto,
      wer: r.wer, wann: r.wann, inhalt: inhalt };
  });
}
// Nächste freie Nummer je Art im Muster JJJJ-AS-NN (Allgemeinstrom), JJJJ-PV-NN (Solarstrom) bzw. JJJJ-NK-NN (Nebenkosten)
function rechnungNaechste() {
  const jahr = String(new Date().getFullYear());
  const frei = function (kuerzel) {
    let max = 0;
    db.prepare('SELECT nummer FROM rechnungen WHERE nummer LIKE ?').all(jahr + '-' + kuerzel + '-%').forEach(function (r) {
      const m = new RegExp('-' + kuerzel + '-(\\d+)$').exec(r.nummer);
      if (m) max = Math.max(max, Number(m[1]));
    });
    return jahr + '-' + kuerzel + '-' + String(max + 1).padStart(2, '0');
  };
  return { as: frei('AS'), pv: frei('PV'), nk: frei('NK') };
}

app.get('/api/rechnungen', nurAngemeldet, function (req, res) {
  res.json({ stamm: rechnungAbsender('as'), nkStamm: rechnungAbsender('nk'), liste: rechnungenListe(), naechste: rechnungNaechste() });
});

// Absender mit IBAN und Steuernummer — nur der Verwalter darf das ändern
app.put('/api/rechnungen/absender/:art?', nurAngemeldet, nurVerwalter, function (req, res) {
  const art = RECHNUNG_ABSENDER_FELDER[req.params.art] ? req.params.art : 'as';
  const b = req.body || {};
  const stamm = {};
  RECHNUNG_ABSENDER_FELDER[art].forEach(function (k) {
    stamm[k] = typeof b[k] === 'string' ? b[k].trim().slice(0, 400) : '';
  });
  einstellungSetzen(RECHNUNG_ABSENDER_SCHLUESSEL[art], JSON.stringify(stamm));
  res.json({ ok: true, stamm: stamm });
});

app.post('/api/rechnungen', nurAngemeldet, function (req, res) {
  const b = req.body || {};
  const art = RECHNUNG_ARTEN[b.art] ? b.art : 'as';
  const nummer = String(b.nummer || '').trim().slice(0, 60);
  if (!nummer) return res.status(400).json({ fehler: 'Rechnungsnummer fehlt' });
  let id = Number(b.id) || 0;
  const doppelt = db.prepare('SELECT id FROM rechnungen WHERE nummer = ? AND id != ?').get(nummer, id);
  if (doppelt) return res.status(400).json({ fehler: 'Die Nummer ' + nummer + ' ist schon vergeben' });
  const objekt = String(b.objekt || '').slice(0, 200);
  const datum = String(b.datum || '').slice(0, 10);
  const brutto = Math.round((Number(b.brutto) || 0) * 100) / 100;
  const inhalt = JSON.stringify(b.inhalt || {}).slice(0, 20000);
  const jetzt = Date.now();
  try {
    if (id && db.prepare('SELECT id FROM rechnungen WHERE id = ?').get(id)) {
      db.prepare('UPDATE rechnungen SET art = ?, nummer = ?, objekt = ?, datum = ?, brutto = ?, inhalt = ?, wer = ?, wann = ? WHERE id = ?')
        .run(art, nummer, objekt, datum, brutto, inhalt, req.nutzer, jetzt, id);
    } else {
      id = Number(db.prepare('INSERT INTO rechnungen (art, nummer, objekt, datum, brutto, inhalt, wer, wann) VALUES (?,?,?,?,?,?,?,?)')
        .run(art, nummer, objekt, datum, brutto, inhalt, req.nutzer, jetzt).lastInsertRowid);
    }
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ fehler: 'Die Nummer ' + nummer + ' ist schon vergeben' });
    throw e;
  }
  res.json({ ok: true, id: id, liste: rechnungenListe(), naechste: rechnungNaechste() });
});

app.delete('/api/rechnungen/:id', nurAngemeldet, function (req, res) {
  db.prepare('DELETE FROM rechnungen WHERE id = ?').run(Number(req.params.id) || 0);
  res.json({ ok: true, liste: rechnungenListe(), naechste: rechnungNaechste() });
});

module.exports = { router: app };
