'use strict';

// -------------------------------------------------------------
//  Suchverzeichnis fürs Mailkonto
//
//  Der Mailserver hat keinen Suchindex und liest bei jeder Suche alle Mails einzeln — das dauert. Deshalb führt
//  die App ein eigenes Verzeichnis: eine SQLite-Datei mit Volltextindex (FTS5). Mit dem Trigramm-Zerleger findet
//  es auch Wortteile („rechnung“ in „Stromrechnung“), ohne Rücksicht auf Groß-/Kleinschreibung und Akzente.
//
//  Die Datei liegt im Datenordner, aber getrennt von der Datenbank: Sie geht nicht mit in die Google-Drive-
//  Sicherung und lässt sich jederzeit aus dem Mailserver neu aufbauen. Gefüllt wird sie von postfach.js.
// -------------------------------------------------------------

const Database = require('better-sqlite3');
const { umlautVarianten } = require('./postfach-text');

function oeffnen(datei) {
  const db = new Database(datei);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (schluessel TEXT PRIMARY KEY, wert TEXT);
    CREATE TABLE IF NOT EXISTS ordner_stand (ordner TEXT PRIMARY KEY, uidvalidity TEXT);
    CREATE TABLE IF NOT EXISTS mails (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ordner      TEXT NOT NULL,
      uid         INTEGER NOT NULL,
      datum       INTEGER,
      von_name    TEXT,
      von_adresse TEXT,
      an          TEXT,
      betreff     TEXT,
      anhang      INTEGER DEFAULT 0,
      gelesen     INTEGER DEFAULT 0,
      markiert    INTEGER DEFAULT 0,
      beantwortet INTEGER DEFAULT 0,
      UNIQUE (ordner, uid)
    );
    CREATE INDEX IF NOT EXISTS mails_datum ON mails (datum);
  `);
  let art = (db.prepare("SELECT wert FROM meta WHERE schluessel = 'zerleger'").get() || {}).wert;
  if (!art) {
    // Trigramme mit Akzent-Faltung (SQLite ab 3.45), sonst ohne, sonst wortweise
    for (const t of ['trigram remove_diacritics 1', 'trigram', 'unicode61 remove_diacritics 2']) {
      try {
        db.exec("CREATE VIRTUAL TABLE mails_fts USING fts5(betreff, von, an, text, anhaenge, tokenize = '" + t + "')");
        art = t; break;
      } catch (e) { /* nächster Zerleger */ }
    }
    if (!art) throw new Error('Der Volltextindex (FTS5) fehlt in SQLite');
    db.prepare("INSERT OR REPLACE INTO meta (schluessel, wert) VALUES ('zerleger', ?)").run(art);
  }
  return { db: db, trigram: art.indexOf('trigram') === 0 };
}

function anzahl(ix) { return ix.db.prepare('SELECT COUNT(*) AS n FROM mails').get().n; }

function uidValidity(ix, ordner) { const z = ix.db.prepare('SELECT uidvalidity FROM ordner_stand WHERE ordner = ?').get(ordner); return z ? z.uidvalidity : null; }
function uidValiditySetzen(ix, ordner, wert) { ix.db.prepare('INSERT OR REPLACE INTO ordner_stand (ordner, uidvalidity) VALUES (?, ?)').run(ordner, String(wert)); }

// Was zu einem Ordner schon im Verzeichnis steht: uid → Merker
function bekannte(ix, ordner) {
  const m = new Map();
  ix.db.prepare('SELECT uid, gelesen, markiert, beantwortet FROM mails WHERE ordner = ?').all(ordner).forEach(function (z) { m.set(z.uid, z); });
  return m;
}

function eintragen(ix, m) {
  const db = ix.db;
  db.transaction(function () {
    const alt = db.prepare('SELECT id FROM mails WHERE ordner = ? AND uid = ?').get(m.ordner, m.uid);
    if (alt) { db.prepare('DELETE FROM mails_fts WHERE rowid = ?').run(alt.id); db.prepare('DELETE FROM mails WHERE id = ?').run(alt.id); }
    const r = db.prepare('INSERT INTO mails (ordner, uid, datum, von_name, von_adresse, an, betreff, anhang, gelesen, markiert, beantwortet) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(m.ordner, m.uid, m.datum || 0, m.vonName || '', m.vonAdresse || '', m.an || '', m.betreff || '',
        m.anhang ? 1 : 0, m.gelesen ? 1 : 0, m.markiert ? 1 : 0, m.beantwortet ? 1 : 0);
    db.prepare('INSERT INTO mails_fts (rowid, betreff, von, an, text, anhaenge) VALUES (?,?,?,?,?,?)')
      .run(r.lastInsertRowid, m.betreff || '', ((m.vonName || '') + ' ' + (m.vonAdresse || '')).trim(), m.an || '', m.text || '', m.anhaenge || '');
  })();
}

function entfernen(ix, ordner, uids) {
  const db = ix.db;
  db.transaction(function () {
    uids.forEach(function (uid) {
      const z = db.prepare('SELECT id FROM mails WHERE ordner = ? AND uid = ?').get(ordner, uid);
      if (!z) return;
      db.prepare('DELETE FROM mails_fts WHERE rowid = ?').run(z.id);
      db.prepare('DELETE FROM mails WHERE id = ?').run(z.id);
    });
  })();
}

function ordnerLeeren(ix, ordner) {
  const db = ix.db;
  db.transaction(function () {
    db.prepare('DELETE FROM mails_fts WHERE rowid IN (SELECT id FROM mails WHERE ordner = ?)').run(ordner);
    db.prepare('DELETE FROM mails WHERE ordner = ?').run(ordner);
    db.prepare('DELETE FROM ordner_stand WHERE ordner = ?').run(ordner);
  })();
}

// Ordner, die es auf dem Mailserver nicht mehr gibt, verschwinden auch aus dem Verzeichnis
function ordnerAufraeumen(ix, vorhanden) {
  ix.db.prepare('SELECT DISTINCT ordner FROM mails').all().forEach(function (z) {
    if (vorhanden.indexOf(z.ordner) === -1) ordnerLeeren(ix, z.ordner);
  });
}

function alleLeeren(ix) {
  ix.db.exec('DELETE FROM mails_fts; DELETE FROM mails; DELETE FROM ordner_stand;');
}

function merkerSetzen(ix, ordner, liste) {
  const s = ix.db.prepare('UPDATE mails SET gelesen = ?, markiert = ?, beantwortet = ? WHERE ordner = ? AND uid = ?');
  ix.db.transaction(function () {
    liste.forEach(function (x) { s.run(x.gelesen ? 1 : 0, x.markiert ? 1 : 0, x.beantwortet ? 1 : 0, ordner, x.uid); });
  })();
}
function merkerAendern(ix, ordner, uids, feld, wert) {
  if (['gelesen', 'markiert', 'beantwortet'].indexOf(feld) === -1) return;
  const s = ix.db.prepare('UPDATE mails SET ' + feld + ' = ? WHERE ordner = ? AND uid = ?');
  ix.db.transaction(function () { uids.forEach(function (uid) { s.run(wert ? 1 : 0, ordner, uid); }); })();
}

// Suchausdruck für FTS5: jede Gruppe muss vorkommen, innerhalb einer Gruppe reicht eine Schreibweise.
// Trigramme brauchen mindestens drei Zeichen; wortweise wird mit * nach Wortanfängen gesucht
function ausdruck(gruppen, trigram) {
  const teile = [];
  (gruppen || []).forEach(function (g) {
    const varianten = [];
    (g || []).forEach(function (w) {
      umlautVarianten(String(w || '').trim()).forEach(function (v) {
        if (trigram ? v.length < 3 : v.length < 2) return;
        const p = '"' + v.replace(/"/g, '""') + '"' + (trigram ? '' : '*');
        if (varianten.indexOf(p) === -1) varianten.push(p);
      });
    });
    if (varianten.length) teile.push('(' + varianten.join(' OR ') + ')');
  });
  return teile.join(' AND ');
}

function zeileAus(z) {
  return {
    uid: z.uid, ordner: z.ordner, datum: z.datum ? new Date(z.datum).toISOString() : null,
    betreff: z.betreff || '(ohne Betreff)', von: { name: z.von_name || '', adresse: z.von_adresse || '' },
    // „Name <adresse>; Name2 <adresse2>“ zurück in Einzelne
    an: (z.an || '').split(/\s*;\s*/).filter(Boolean).map(function (x) {
      const t = /^(.*?)\s*<([^>]+)>$/.exec(x);
      return t ? { name: t[1], adresse: t[2] } : { name: '', adresse: x };
    }),
    gelesen: !!z.gelesen, markiert: !!z.markiert, beantwortet: !!z.beantwortet, anhang: !!z.anhang,
    ausschnitt: z.ausschnitt || ''
  };
}

// k: { gruppen, absender, empfaenger, seit, bis (ms), nurAnhang, nurOrdner: [], ohneOrdner: [] }
// Liefert die drei besten Treffer (nach Relevanz) und alle weiteren nach Datum, neueste zuerst.
function suchen(ix, k) {
  const filter = [], werte = {};
  if (k.seit) { filter.push('m.datum >= @seit'); werte.seit = k.seit; }
  if (k.bis) { filter.push('m.datum < @bis'); werte.bis = k.bis; }
  if (k.nurAnhang) filter.push('m.anhang = 1');
  const liste = function (name, ordner) {
    return ordner.map(function (o, i) { werte[name + i] = o; return '@' + name + i; }).join(',');
  };
  if (k.nurOrdner && k.nurOrdner.length) filter.push('m.ordner IN (' + liste('nur', k.nurOrdner) + ')');
  if (k.ohneOrdner && k.ohneOrdner.length) filter.push('m.ordner NOT IN (' + liste('ohne', k.ohneOrdner) + ')');

  const fts = [];
  const g = ausdruck(k.gruppen, ix.trigram); if (g) fts.push(g);
  const a = ausdruck([k.absender || []], ix.trigram); if (a) fts.push('von : ' + a);
  const e = ausdruck([k.empfaenger || []], ix.trigram); if (e) fts.push('an : ' + e);
  const hatText = !!g;
  const grenze = Math.min(1000, k.grenze || 400);

  let zeilen;
  if (fts.length) {
    werte.q = fts.join(' AND ');
    // Fundstelle immer aus dem Mailtext (Spalte 3): passt das Wort nur im Absender, zeigt sie den Anfang der Mail
    zeilen = ix.db.prepare('SELECT m.*, snippet(mails_fts, 3, char(1), char(2), \' … \', 14) AS ausschnitt, '
      + 'bm25(mails_fts, 10.0, 6.0, 2.0, 1.0, 4.0) AS rang '
      + 'FROM mails_fts JOIN mails m ON m.id = mails_fts.rowid WHERE mails_fts MATCH @q'
      + (filter.length ? ' AND ' + filter.join(' AND ') : '') + ' ORDER BY rang LIMIT ' + grenze).all(werte);
  } else if (filter.length) {
    zeilen = ix.db.prepare('SELECT m.* FROM mails m WHERE ' + filter.join(' AND ') + ' ORDER BY m.datum DESC LIMIT ' + grenze).all(werte);
  } else {
    zeilen = [];
  }
  // Top-Treffer nur, wenn nach Begriffen gesucht wurde und es mehr als eine Handvoll gibt — sonst reicht die Zeitfolge
  const top = hatText && zeilen.length > 5 ? zeilen.slice(0, 3) : [];
  const rest = zeilen.filter(function (z) { return top.indexOf(z) === -1; }).sort(function (x, y) { return (y.datum || 0) - (x.datum || 0); });
  return { top: top.map(zeileAus), mails: rest.slice(0, 150).map(zeileAus), gesamt: zeilen.length, mehr: zeilen.length >= grenze };
}

// Mails mit Anhang (für „Anhänge ablegen“): Kopf, Anhangnamen und der Anfang des Textes — ohne den Mailserver zu fragen
function mitAnhang(ix, k) {
  const werte = { seit: (k && k.seit) || 0 };
  const ohne = ((k && k.ohneOrdner) || []).map(function (o, i) { werte['o' + i] = o; return '@o' + i; });
  return ix.db.prepare('SELECT m.id, m.ordner, m.uid, m.datum, m.von_name, m.von_adresse, m.betreff, f.anhaenge, substr(f.text, 1, 1500) AS text '
    + 'FROM mails m JOIN mails_fts f ON f.rowid = m.id WHERE m.anhang = 1 AND m.datum >= @seit'
    + (ohne.length ? ' AND m.ordner NOT IN (' + ohne.join(',') + ')' : '') + ' ORDER BY m.datum DESC LIMIT 6000').all(werte);
}

module.exports = {
  oeffnen, anzahl, uidValidity, uidValiditySetzen, bekannte, eintragen, entfernen, ordnerLeeren, ordnerAufraeumen,
  alleLeeren, merkerSetzen, merkerAendern, ausdruck, suchen, mitAnhang
};
