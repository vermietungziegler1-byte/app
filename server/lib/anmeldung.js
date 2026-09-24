'use strict';

// -------------------------------------------------------------
//  Anmeldung: Passwörter, Sitzungen, Zugänge und die Prüfungen
//  nurAngemeldet / nurVerwalter, die alle Bausteine benutzen.
// -------------------------------------------------------------

const express = require('express');
const { db, crypto } = require('./kern');

const app = express.Router();

// ---------------- Passwörter ----------------
// scrypt kommt in Node mit, dadurch keine zusätzliche Abhängigkeit.
// Asynchron, damit eine Anmeldung nicht den ganzen Server anhält.
const SCRYPT_OPTIONEN = { N: 16384, r: 8, p: 1 };
function hashen(passwort, salz) {
  return new Promise(function (ok, fehler) {
    crypto.scrypt(passwort, salz, 64, SCRYPT_OPTIONEN, function (e, schluessel) {
      if (e) fehler(e); else ok(schluessel.toString('hex'));
    });
  });
}
async function passwortSetzen(name, passwort, rolle) {
  const salz = crypto.randomBytes(16).toString('hex');
  const hash = await hashen(passwort, salz);
  db.prepare('INSERT OR REPLACE INTO nutzer (name, salz, hash, angelegt, rolle) VALUES (?,?,?,?,?)')
    .run(name, salz, hash, Date.now(), rolle || 'nutzer');
}
// Nur das Passwort tauschen — Rolle und Anlagedatum bleiben
async function passwortAendern(name, passwort) {
  const salz = crypto.randomBytes(16).toString('hex');
  const hash = await hashen(passwort, salz);
  db.prepare('UPDATE nutzer SET salz = ?, hash = ? WHERE lower(name) = lower(?)').run(salz, hash, name);
}

function rolleVon(name) {
  const n = db.prepare('SELECT rolle FROM nutzer WHERE lower(name) = lower(?)').get(name);
  return n ? n.rolle : 'nutzer';
}

// Nur der Verwalter darf Zugänge vergeben oder entziehen.
function nurVerwalter(req, res, next) {
  if (rolleVon(req.nutzer) !== 'verwalter') {
    return res.status(403).json({ fehler: 'Das darf nur der Verwalter' });
  }
  next();
}
// Auch bei unbekanntem Namen wird gerechnet, sonst verrät die Antwortzeit, welche Namen es gibt.
const BLIND_SALZ = crypto.randomBytes(16).toString('hex');
async function passwortPruefen(name, passwort) {
  const n = db.prepare('SELECT * FROM nutzer WHERE lower(name) = lower(?)').get(name);
  const versuch = Buffer.from(await hashen(passwort, n ? n.salz : BLIND_SALZ), 'hex');
  if (!n) return null;
  const echt = Buffer.from(n.hash, 'hex');
  if (versuch.length !== echt.length) return null;
  return crypto.timingSafeEqual(versuch, echt) ? n : null;
}

// ---------------- Sitzungen ----------------
const DAUER = 1000 * 60 * 60 * 24 * 30; // 30 Tage

function sitzungAnlegen(nutzer) {
  const id = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sitzungen (id, nutzer, laeuft) VALUES (?,?,?)')
    .run(id, nutzer, Date.now() + DAUER);
  return id;
}
function sitzungLesen(id) {
  if (!id) return null;
  const s = db.prepare('SELECT * FROM sitzungen WHERE id = ?').get(id);
  if (!s) return null;
  if (s.laeuft < Date.now()) {
    db.prepare('DELETE FROM sitzungen WHERE id = ?').run(id);
    return null;
  }
  return s;
}
setInterval(function () {
  db.prepare('DELETE FROM sitzungen WHERE laeuft < ?').run(Date.now());
  // Alte Fehlversuche vergessen, sonst wächst die Liste endlos
  const grenze = Date.now() - 15 * 60 * 1000;
  versuche.forEach(function (eintrag, ip) { if (eintrag.zeit < grenze) versuche.delete(ip); });
}, 1000 * 60 * 60).unref();

// Einfacher Bremsklotz gegen Durchprobieren von Passwörtern.
const versuche = new Map();
function zuVieleVersuche(ip) {
  const eintrag = versuche.get(ip);
  if (!eintrag) return false;
  if (Date.now() - eintrag.zeit > 15 * 60 * 1000) { versuche.delete(ip); return false; }
  return eintrag.anzahl >= 10;
}
function versuchZaehlen(ip) {
  const eintrag = versuche.get(ip) || { anzahl: 0, zeit: Date.now() };
  eintrag.anzahl++; eintrag.zeit = Date.now();
  versuche.set(ip, eintrag);
}

function keksLesen(req, name) {
  const roh = req.headers.cookie || '';
  const treffer = roh.split(';').map(function (t) { return t.trim(); })
    .find(function (t) { return t.indexOf(name + '=') === 0; });
  return treffer ? decodeURIComponent(treffer.slice(name.length + 1)) : null;
}
function keksSetzen(res, id) {
  res.setHeader('Set-Cookie',
    'sid=' + id + '; HttpOnly; Path=/; Max-Age=' + (DAUER / 1000) + '; SameSite=Lax; Secure');
}
function keksLoeschen(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
}

function nurAngemeldet(req, res, next) {
  const s = sitzungLesen(keksLesen(req, 'sid'));
  if (!s) return res.status(401).json({ fehler: 'nicht angemeldet' });
  req.nutzer = s.nutzer;
  next();
}

const anzahlNutzer = function () {
  return db.prepare('SELECT COUNT(*) AS n FROM nutzer').get().n;
};

// ---------------- Schnittstellen ----------------
app.get('/api/status', function (req, res) {
  const s = sitzungLesen(keksLesen(req, 'sid'));
  res.json({
    eingerichtet: anzahlNutzer() > 0,
    angemeldet: !!s,
    nutzer: s ? s.nutzer : null,
    rolle: s ? rolleVon(s.nutzer) : null
  });
});

// Erster Zugang — geht nur, solange es noch keinen gibt.
let setupLaeuft = false;
app.post('/api/setup', async function (req, res) {
  if (setupLaeuft || anzahlNutzer() > 0) return res.status(403).json({ fehler: 'schon eingerichtet' });
  const { name, passwort } = req.body || {};
  if (!name || typeof passwort !== 'string' || passwort.length < 8) {
    return res.status(400).json({ fehler: 'Name und Passwort mit mindestens acht Zeichen nötig' });
  }
  setupLaeuft = true;
  try {
    await passwortSetzen(String(name).trim(), passwort, 'verwalter');
    const id = sitzungAnlegen(String(name).trim());
    keksSetzen(res, id);
    res.json({ ok: true, nutzer: String(name).trim() });
  } catch (e) {
    res.status(500).json({ fehler: e.message });
  } finally { setupLaeuft = false; }
});

app.post('/api/login', async function (req, res) {
  const ip = req.ip;
  if (zuVieleVersuche(ip)) {
    return res.status(429).json({ fehler: 'Zu viele Versuche. Warte 15 Minuten.' });
  }
  // Schon vor dem Rechnen zählen, damit viele gleichzeitige Versuche nicht an der Bremse vorbeikommen
  versuchZaehlen(ip);
  const { name, passwort } = req.body || {};
  try {
    const n = await passwortPruefen(String(name || '').trim(), String(passwort || ''));
    if (!n) return res.status(401).json({ fehler: 'Falsche Zugangsdaten' });
    versuche.delete(ip);
    keksSetzen(res, sitzungAnlegen(n.name));
    res.json({ ok: true, nutzer: n.name, rolle: n.rolle || 'nutzer' });
  } catch (e) {
    res.status(500).json({ fehler: e.message });
  }
});

// Eigenes Passwort ändern — mit dem alten als Nachweis
app.post('/api/passwort', nurAngemeldet, async function (req, res) {
  const { alt, neu } = req.body || {};
  if (typeof neu !== 'string' || neu.length < 8) {
    return res.status(400).json({ fehler: 'Das neue Passwort braucht mindestens acht Zeichen' });
  }
  try {
    if (!(await passwortPruefen(req.nutzer, String(alt || '')))) {
      return res.status(403).json({ fehler: 'Das bisherige Passwort stimmt nicht' });
    }
    await passwortAendern(req.nutzer, neu);
    // Alle anderen Sitzungen dieses Zugangs beenden, die eigene bleibt
    db.prepare('DELETE FROM sitzungen WHERE lower(nutzer) = lower(?) AND id != ?')
      .run(req.nutzer, keksLesen(req, 'sid'));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ fehler: e.message }); }
});

app.post('/api/logout', function (req, res) {
  const id = keksLesen(req, 'sid');
  if (id) db.prepare('DELETE FROM sitzungen WHERE id = ?').run(id);
  keksLoeschen(res);
  res.json({ ok: true });
});

app.get('/api/users', nurAngemeldet, function (req, res) {
  res.json(db.prepare('SELECT name, angelegt, rolle FROM nutzer ORDER BY angelegt').all());
});

app.post('/api/users', nurAngemeldet, nurVerwalter, async function (req, res) {
  const { name, passwort } = req.body || {};
  if (!name || typeof passwort !== 'string' || passwort.length < 8) {
    return res.status(400).json({ fehler: 'Name und Passwort mit mindestens acht Zeichen nötig' });
  }
  const da = db.prepare('SELECT 1 FROM nutzer WHERE lower(name) = lower(?)').get(String(name).trim());
  if (da) return res.status(409).json({ fehler: 'Diesen Benutzernamen gibt es schon' });
  try {
    await passwortSetzen(String(name).trim(), passwort, 'nutzer');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ fehler: e.message }); }
});

// Verwalter setzt das Passwort eines anderen Zugangs neu (z. B. wenn es vergessen wurde)
app.put('/api/users/:name/passwort', nurAngemeldet, nurVerwalter, async function (req, res) {
  const neu = (req.body || {}).passwort;
  if (typeof neu !== 'string' || neu.length < 8) {
    return res.status(400).json({ fehler: 'Das Passwort braucht mindestens acht Zeichen' });
  }
  const da = db.prepare('SELECT name FROM nutzer WHERE lower(name) = lower(?)').get(req.params.name);
  if (!da) return res.status(404).json({ fehler: 'Diesen Zugang gibt es nicht' });
  try {
    await passwortAendern(da.name, neu);
    // Dort überall abmelden — nur die eigene, gerade laufende Sitzung bleibt
    db.prepare('DELETE FROM sitzungen WHERE lower(nutzer) = lower(?) AND id != ?')
      .run(da.name, keksLesen(req, 'sid'));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ fehler: e.message }); }
});

app.delete('/api/users/:name', nurAngemeldet, nurVerwalter, function (req, res) {
  const name = req.params.name;
  if (name.toLowerCase() === req.nutzer.toLowerCase()) {
    return res.status(400).json({ fehler: 'Der eigene Zugang bleibt' });
  }
  if (anzahlNutzer() < 2) return res.status(400).json({ fehler: 'Der letzte Zugang bleibt' });
  db.prepare('DELETE FROM nutzer WHERE lower(name) = lower(?)').run(name);
  db.prepare('DELETE FROM sitzungen WHERE lower(nutzer) = lower(?)').run(name);
  res.json({ ok: true });
});

module.exports = { router: app, nurAngemeldet, nurVerwalter, rolleVon, keksLesen };
