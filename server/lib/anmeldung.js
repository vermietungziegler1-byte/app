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
  wartend.forEach(function (w, ticket) { if (w.bis < Date.now()) wartend.delete(ticket); });
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
function nutzerLesen(name) {
  return db.prepare('SELECT * FROM nutzer WHERE lower(name) = lower(?)').get(name);
}

// ---------------- Zweiter Faktor: Einmalcode aus einer Authenticator-App ----------------
// Zeitbasierte Einmalcodes (TOTP, RFC 6238): sechs Ziffern, alle 30 Sekunden neu, aus einem geteilten Geheimnis.
// Dazu acht Ersatzcodes für den Fall, dass das Handy weg ist. Alles mit Bordmitteln von Node, keine Abhängigkeit.
// Notfall (Handy und Ersatzcodes weg, kein anderer Verwalter): auf dem Server in der Datenbank
// UPDATE nutzer SET zweiter = NULL, zweiter_aktiv = 0, ersatzcodes = NULL WHERE name = '…';
['zweiter TEXT', 'zweiter_aktiv INTEGER NOT NULL DEFAULT 0', 'zweiter_zuletzt INTEGER', 'ersatzcodes TEXT']
  .forEach(function (spalte) {
    try { db.exec('ALTER TABLE nutzer ADD COLUMN ' + spalte); } catch (e) { /* gibt es schon */ }
  });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let bits = '', aus = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) aus += B32[parseInt(bits.slice(i, i + 5), 2)];
  return aus;
}
function base32Lesen(text) {
  let bits = '';
  for (const z of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(z).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const SCHRITT_MS = 30000;
function einmalcode(geheimnis, schritt) {
  const zaehler = Buffer.alloc(8);
  zaehler.writeUInt32BE(Math.floor(schritt / 0x100000000), 0);
  zaehler.writeUInt32BE(schritt >>> 0, 4);
  const mac = crypto.createHmac('sha1', base32Lesen(geheimnis)).update(zaehler).digest();
  const o = mac[19] & 0x0f;
  const zahl = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(zahl % 1000000).padStart(6, '0');
}
// Passt der Code zu einem Zeitschritt um jetzt herum (eine halbe Minute Uhrabweichung in jede Richtung)? Liefert
// den Schritt oder null. Ein Schritt gilt nur einmal — sonst ließe sich ein abgefangener Code in seinen 30 Sekunden
// noch einmal verwenden.
function codePruefen(n, code) {
  const sauber = String(code || '').replace(/\s+/g, '');
  if (!n || !n.zweiter || !/^\d{6}$/.test(sauber)) return null;
  const jetzt = Math.floor(Date.now() / SCHRITT_MS);
  for (const s of [jetzt, jetzt - 1, jetzt + 1]) {
    if (s <= (n.zweiter_zuletzt || 0)) continue;
    if (crypto.timingSafeEqual(Buffer.from(einmalcode(n.zweiter, s)), Buffer.from(sauber))) return s;
  }
  return null;
}
function ersatzHash(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
}
function ersatzcodesAnlegen() {
  const codes = [];
  while (codes.length < 8) {
    const roh = base32(crypto.randomBytes(5));   // acht Zeichen, als 4-4 lesbar
    codes.push(roh.slice(0, 4) + '-' + roh.slice(4));
  }
  return codes;
}
// Ein Ersatzcode gilt genau einmal: Treffer werden aus der Liste gestrichen
function ersatzPruefen(n, code) {
  let liste;
  try { liste = JSON.parse(n.ersatzcodes || '[]'); } catch (e) { liste = []; }
  const i = liste.indexOf(ersatzHash(code));
  if (i === -1) return false;
  liste.splice(i, 1);
  db.prepare('UPDATE nutzer SET ersatzcodes = ? WHERE name = ?').run(JSON.stringify(liste), n.name);
  return true;
}
function zweitenLoeschen(name) {
  db.prepare('UPDATE nutzer SET zweiter = NULL, zweiter_aktiv = 0, zweiter_zuletzt = NULL, ersatzcodes = NULL WHERE name = ?').run(name);
}
// Passwort schon geprüft, Code steht noch aus: ein kurzlebiges Ticket statt einer Sitzung
const wartend = new Map();   // ticket → { nutzer, bis, versuche }
const TICKET_MS = 5 * 60 * 1000;
const HERAUSGEBER = 'Ziegler Verwaltung';

// Welche Fassung der Oberfläche der Server gerade ausliefert: die Dateien mit Prüfsumme aus index.html. Die Oberfläche
// vergleicht das mit dem, was sie selbst geladen hat, und bietet „Neu laden“ an, sobald etwas Neues eingespielt ist.
const INDEX = require('path').join(__dirname, '..', '..', 'public', 'index.html');
let fassungMerker = { zeit: -1, wert: '' };
function appFassung() {
  try {
    const fs = require('fs');
    const zeit = fs.statSync(INDEX).mtimeMs;
    if (zeit !== fassungMerker.zeit) {
      const html = fs.readFileSync(INDEX, 'utf8');
      fassungMerker = { zeit: zeit, wert: (html.match(/[a-z]+\.(?:css|js)\?v=[0-9a-f]+/g) || []).sort().join(' ') };
    }
    return fassungMerker.wert;
  } catch (e) { return ''; }
}

// ---------------- Schnittstellen ----------------
app.get('/api/status', function (req, res) {
  const s = sitzungLesen(keksLesen(req, 'sid'));
  const n = s ? nutzerLesen(s.nutzer) : null;
  res.json({
    eingerichtet: anzahlNutzer() > 0,
    angemeldet: !!s,
    nutzer: s ? s.nutzer : null,
    rolle: s ? rolleVon(s.nutzer) : null,
    zweiterFaktor: !!(n && n.zweiter_aktiv),
    fassung: appFassung()
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
    if (n.zweiter_aktiv) {
      // Passwort stimmt — jetzt noch der Code aus der Authenticator-App; bis dahin gibt es keine Sitzung.
      // Die Fehlversuche je Adresse laufen weiter, damit auch Codes nicht durchprobiert werden können
      const ticket = crypto.randomBytes(32).toString('hex');
      wartend.set(ticket, { nutzer: n.name, bis: Date.now() + TICKET_MS, versuche: 0 });
      return res.json({ zweiterFaktor: true, ticket: ticket });
    }
    versuche.delete(ip);
    keksSetzen(res, sitzungAnlegen(n.name));
    res.json({ ok: true, nutzer: n.name, rolle: n.rolle || 'nutzer', zweiterFaktor: false });
  } catch (e) {
    res.status(500).json({ fehler: e.message });
  }
});

// Zweiter Schritt der Anmeldung: Einmalcode oder Ersatzcode zum Ticket
app.post('/api/login/code', function (req, res) {
  const ip = req.ip;
  if (zuVieleVersuche(ip)) return res.status(429).json({ fehler: 'Zu viele Versuche. Warte 15 Minuten.' });
  versuchZaehlen(ip);
  const ticket = String((req.body || {}).ticket || '');
  const w = wartend.get(ticket);
  const n = w && w.bis >= Date.now() ? nutzerLesen(w.nutzer) : null;
  if (!n || !n.zweiter_aktiv) {
    wartend.delete(ticket);
    return res.status(401).json({ fehler: 'Bitte noch einmal mit Passwort anmelden' });
  }
  const schritt = codePruefen(n, (req.body || {}).code);
  if (schritt === null && !ersatzPruefen(n, (req.body || {}).code)) {
    w.versuche++;
    if (w.versuche >= 5) wartend.delete(ticket);   // fünf Fehlversuche, dann wieder von vorn mit dem Passwort
    return res.status(401).json({ fehler: 'Der Code stimmt nicht' });
  }
  if (schritt !== null) db.prepare('UPDATE nutzer SET zweiter_zuletzt = ? WHERE name = ?').run(schritt, n.name);
  wartend.delete(ticket);
  versuche.delete(ip);
  keksSetzen(res, sitzungAnlegen(n.name));
  res.json({ ok: true, nutzer: n.name, rolle: n.rolle || 'nutzer', zweiterFaktor: true });
});

// Einrichten in zwei Schritten: Geheimnis erzeugen (noch nicht scharf), dann mit einem gültigen Code einschalten —
// so sperrt sich niemand aus, dessen App das Geheimnis nicht richtig übernommen hat
app.post('/api/zweiter-faktor/start', nurAngemeldet, function (req, res) {
  const n = nutzerLesen(req.nutzer);
  if (n.zweiter_aktiv) return res.status(400).json({ fehler: 'Der zweite Faktor ist schon eingeschaltet' });
  const geheimnis = base32(crypto.randomBytes(20));
  db.prepare('UPDATE nutzer SET zweiter = ?, zweiter_aktiv = 0, zweiter_zuletzt = NULL WHERE name = ?').run(geheimnis, n.name);
  res.json({
    geheimnis: geheimnis.replace(/(.{4})/g, '$1 ').trim(),
    uri: 'otpauth://totp/' + encodeURIComponent(HERAUSGEBER + ':' + n.name) + '?secret=' + geheimnis
      + '&issuer=' + encodeURIComponent(HERAUSGEBER) + '&algorithm=SHA1&digits=6&period=30'
  });
});
app.post('/api/zweiter-faktor/einschalten', nurAngemeldet, function (req, res) {
  const n = nutzerLesen(req.nutzer);
  if (n.zweiter_aktiv) return res.status(400).json({ fehler: 'Der zweite Faktor ist schon eingeschaltet' });
  if (!n.zweiter) return res.status(400).json({ fehler: 'Erst „Einrichten“ antippen' });
  const schritt = codePruefen(n, (req.body || {}).code);
  if (schritt === null) return res.status(400).json({ fehler: 'Der Code stimmt nicht — bitte den aktuellen Code aus der App eingeben' });
  const codes = ersatzcodesAnlegen();
  db.prepare('UPDATE nutzer SET zweiter_aktiv = 1, zweiter_zuletzt = ?, ersatzcodes = ? WHERE name = ?')
    .run(schritt, JSON.stringify(codes.map(ersatzHash)), n.name);
  // Andere Sitzungen dieses Zugangs beenden — ab jetzt gilt der zweite Faktor überall, die eigene bleibt
  db.prepare('DELETE FROM sitzungen WHERE lower(nutzer) = lower(?) AND id != ?').run(n.name, keksLesen(req, 'sid'));
  res.json({ ok: true, ersatzcodes: codes });
});
// Ausschalten nur mit dem Passwort als Nachweis
app.post('/api/zweiter-faktor/ausschalten', nurAngemeldet, async function (req, res) {
  try {
    const n = await passwortPruefen(req.nutzer, String((req.body || {}).passwort || ''));
    if (!n) return res.status(403).json({ fehler: 'Das Passwort stimmt nicht' });
    zweitenLoeschen(n.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ fehler: e.message }); }
});
// Verwalter setzt den zweiten Faktor eines anderen Zugangs zurück (Handy weg, Ersatzcodes auch)
app.delete('/api/users/:name/zweiter-faktor', nurAngemeldet, nurVerwalter, function (req, res) {
  const da = db.prepare('SELECT name FROM nutzer WHERE lower(name) = lower(?)').get(req.params.name);
  if (!da) return res.status(404).json({ fehler: 'Diesen Zugang gibt es nicht' });
  if (da.name.toLowerCase() === req.nutzer.toLowerCase()) {
    return res.status(400).json({ fehler: 'Den eigenen schaltest du mit deinem Passwort aus' });
  }
  zweitenLoeschen(da.name);
  res.json({ ok: true });
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
  res.json(db.prepare('SELECT name, angelegt, rolle, zweiter_aktiv FROM nutzer ORDER BY angelegt').all()
    .map(function (n) { return { name: n.name, angelegt: n.angelegt, rolle: n.rolle, zweiterFaktor: !!n.zweiter_aktiv }; }));
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
