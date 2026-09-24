'use strict';

// -------------------------------------------------------------
//  Kern: Einstellungen, Datenbank und kleine Hilfen, die alle
//  anderen Bausteine gemeinsam benutzen.
// -------------------------------------------------------------

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATENORDNER = process.env.DATEN || path.join(__dirname, '..', 'daten');
const HINTER_PROXY = process.env.PROXY !== '0';

fs.mkdirSync(DATENORDNER, { recursive: true });
const db = new Database(path.join(DATENORDNER, 'vermietung.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS nutzer (
    name      TEXT PRIMARY KEY,
    salz      TEXT NOT NULL,
    hash      TEXT NOT NULL,
    angelegt  INTEGER NOT NULL,
    rolle     TEXT NOT NULL DEFAULT 'nutzer'
  );
  CREATE TABLE IF NOT EXISTS sitzungen (
    id      TEXT PRIMARY KEY,
    nutzer  TEXT NOT NULL,
    laeuft  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stand (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    inhalt    TEXT NOT NULL,
    wer       TEXT,
    wann      INTEGER
  );
  CREATE TABLE IF NOT EXISTS einstellungen (
    schluessel TEXT PRIMARY KEY,
    wert       TEXT
  );
  CREATE TABLE IF NOT EXISTS todoist_sync (
    schluessel TEXT PRIMARY KEY,
    aufgabe    TEXT,
    wann       INTEGER
  );
  CREATE TABLE IF NOT EXISTS verlauf (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    inhalt  TEXT NOT NULL,
    wer     TEXT,
    wann    INTEGER NOT NULL
  );
`);

// Ältere Datenbanken nachrüsten, falls die Spalte noch fehlt.
try { db.exec("ALTER TABLE nutzer ADD COLUMN rolle TEXT NOT NULL DEFAULT 'nutzer'"); }
catch (e) { /* Spalte ist schon da */ }

// ---------------- Hilfen ----------------
// Anfragen an fremde Dienste bekommen ein Zeitlimit, sonst hängt die App mit, wenn ein Dienst hängt.
const ZEITLIMIT = 20000;
function holen(url, optionen) {
  return fetch(url, Object.assign({ signal: AbortSignal.timeout(ZEITLIMIT) }, optionen || {}));
}

// Todoist liefert Listen mal direkt, mal als { results: [...] }
function alsListe(antwort) {
  return Array.isArray(antwort) ? antwort : (antwort && antwort.results) || [];
}

function htmlSicher(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Für Schnittstellen, die fremde Dienste fragen: Fehler landen als 502 mit Klartext beim Browser.
function mitFehler(fn) {
  return async function (req, res) {
    try { await fn(req, res); }
    catch (e) { res.status(e.status && e.status < 500 ? e.status : 502).json({ fehler: e.message }); }
  };
}

// ---------------- Einstellungen ----------------
function einstellung(schluessel) {
  const e = db.prepare('SELECT wert FROM einstellungen WHERE schluessel = ?').get(schluessel);
  return e ? e.wert : null;
}
function einstellungSetzen(schluessel, wert) {
  db.prepare('INSERT OR REPLACE INTO einstellungen (schluessel, wert) VALUES (?,?)').run(schluessel, wert);
}

// ---------------- Zeit und Datenstand ----------------
function berlinJetzt() {
  const teile = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const m = {};
  teile.forEach(function (t) { m[t.type] = t.value; });
  return { datum: m.year + '-' + m.month + '-' + m.day, zeit: m.hour + ':' + m.minute };
}

function standInhalt() {
  const zeile = db.prepare('SELECT inhalt FROM stand WHERE id = 1').get();
  if (!zeile) return null;
  try { return JSON.parse(zeile.inhalt); } catch (fehler) { return null; }
}

// Wer wissen muss, dass sich der Datenstand geändert hat (z. B. der Post-Cache),
// meldet sich hier an; daten.js ruft datenGeaendert() nach jedem Speichern.
const beiAenderung = [];
function beiDatenAenderung(fn) { beiAenderung.push(fn); }
function datenGeaendert() {
  beiAenderung.forEach(function (fn) { try { fn(); } catch (e) { /* egal */ } });
}

module.exports = { Database, crypto, path, fs, PORT, DATENORDNER, HINTER_PROXY, db, holen, alsListe, htmlSicher, mitFehler, einstellung, einstellungSetzen, berlinJetzt, standInhalt, beiDatenAenderung, datenGeaendert };
