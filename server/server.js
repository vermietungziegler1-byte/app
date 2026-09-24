'use strict';

// -------------------------------------------------------------
//  Vermietung — kleiner Server: Anmeldung, Daten, Verlauf.
//  Bewusst schlank gehalten: Express + SQLite, sonst nichts.
// -------------------------------------------------------------

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATENORDNER = process.env.DATEN || path.join(__dirname, 'daten');
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

// ---------------- Anwendung ----------------
const app = express();
app.disable('x-powered-by');
if (HINTER_PROXY) app.set('trust proxy', 1);

// Grundlegende Schutz-Kopfzeilen für alle Antworten
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json({ limit: '4mb' }));

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
  postCache.clear();   // Suchbegriffe hängen an Mietern und Objekten
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

// ---------------- Todoist ----------------
// Der Server spricht mit Todoist, damit das Zugangstoken den Browser nie erreicht.

function einstellung(schluessel) {
  const e = db.prepare('SELECT wert FROM einstellungen WHERE schluessel = ?').get(schluessel);
  return e ? e.wert : null;
}
function einstellungSetzen(schluessel, wert) {
  db.prepare('INSERT OR REPLACE INTO einstellungen (schluessel, wert) VALUES (?,?)').run(schluessel, wert);
}

async function todoist(pfad, optionen) {
  const token = einstellung('todoist_token');
  if (!token) throw new Error('Kein Todoist-Token hinterlegt');
  const antwort = await holen('https://api.todoist.com/api/v1' + pfad, Object.assign({
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }, optionen || {}));
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    throw new Error('Todoist antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 200) : ''));
  }
  const text = await antwort.text();
  return text ? JSON.parse(text) : null;
}

// Todoist-Farbnamen in die Farbtöne der Todoist-Oberfläche übersetzen
const TODOIST_FARBEN = {
  berry_red: '#b8255f', red: '#db4035', orange: '#ff9933', yellow: '#fad000', olive_green: '#afb83b',
  lime_green: '#7ecc49', green: '#299438', mint_green: '#6accbc', teal: '#158fad', sky_blue: '#14aaf5',
  light_blue: '#96c3eb', blue: '#4073ff', grape: '#884dff', violet: '#af38eb', lavender: '#eb96eb',
  magenta: '#e05194', salmon: '#ff8d85', charcoal: '#808080', grey: '#b8b8b8', taupe: '#ccac93'
};

// Eine Liste vollständig holen - Todoist liefert seitenweise und gibt dafür einen next_cursor mit
async function todoistListe(pfad) {
  let alles = [], cursor = null, runden = 0;
  do {
    const antwort = await todoist(pfad + (pfad.indexOf('?') === -1 ? '?' : '&') + 'limit=200'
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    const teil = alsListe(antwort);
    alles = alles.concat(teil);
    cursor = (antwort && !Array.isArray(antwort) && antwort.next_cursor) || null;
    runden++;
  } while (cursor && runden < 10);
  return alles;
}

// Eine Todoist-Aufgabe in die Form bringen, die die App überall benutzt
function aufgabeMappen(t, namen) {
  const roh = (t.due && (t.due.date || t.due.datetime)) || null;
  const mitZeit = (t.due && t.due.datetime) || (roh && String(roh).indexOf('T') !== -1 ? String(roh) : null);
  return {
    id: String(t.id),
    eltern: t.parent_id ? String(t.parent_id) : null,
    inhalt: t.content,
    beschreibung: t.description || '',
    projekt: (namen && namen[String(t.project_id)]) || '',
    projektId: String(t.project_id || ''),
    sektion: t.section_id ? String(t.section_id) : null,
    faellig: roh ? String(roh).slice(0, 10) : null,
    faelligZeit: mitZeit || null,
    faelligText: (t.due && t.due.string) || '',
    wiederkehrend: !!(t.due && t.due.is_recurring),
    prioritaet: t.priority || 1,
    labels: t.labels || [],
    kommentare: Number(t.note_count || t.comment_count || 0),
    reihenfolge: Number(t.child_order || 0),
    tagesreihenfolge: Number(t.day_order || 0),
    angelegt: t.added_at || t.created_at || null,
    url: t.url || ('https://app.todoist.com/app/task/' + t.id)
  };
}

app.get('/api/todoist', nurAngemeldet, function (req, res) {
  res.json({
    verbunden: !!einstellung('todoist_token'),
    zuordnung: JSON.parse(einstellung('todoist_zuordnung') || '{}')
  });
});

app.put('/api/todoist', nurAngemeldet, nurVerwalter, function (req, res) {
  const { token, zuordnung } = req.body || {};
  if (typeof token === 'string' && token.trim()) einstellungSetzen('todoist_token', token.trim());
  if (token === '') db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('todoist_token');
  if (zuordnung) einstellungSetzen('todoist_zuordnung', JSON.stringify(zuordnung));
  res.json({ ok: true, verbunden: !!einstellung('todoist_token') });
});

app.get('/api/todoist/projekte', nurAngemeldet, mitFehler(async function (req, res) {
  const liste = await todoistListe('/projects');
  res.json(liste.map(function (p) {
    return { id: String(p.id), name: p.name, farbe: TODOIST_FARBEN[p.color] || '#808080' };
  }));
}));

// Offene Aufgaben eines Projekts holen
app.get('/api/todoist/aufgaben', nurAngemeldet, mitFehler(async function (req, res) {
  const projekt = req.query.projekt;
  const liste = await todoistListe('/tasks' + (projekt ? '?project_id=' + encodeURIComponent(projekt) : ''));
  res.json(liste.map(function (t) { return aufgabeMappen(t, null); }));
}));

// Die ganze Übersicht auf einmal: alle offenen Aufgaben, Projekte mit Farbe, Abschnitte
async function todoistUebersicht() {
  const [aufgaben, projekte, sektionen] = await Promise.all([
    todoistListe('/tasks'), todoistListe('/projects'), todoistListe('/sections')
  ]);
  const namen = {};
  projekte.forEach(function (p) { namen[String(p.id)] = p.name; });
  return {
    aufgaben: aufgaben.map(function (t) { return aufgabeMappen(t, namen); }),
    projekte: projekte.filter(function (p) { return !p.is_archived; }).map(function (p) {
      return {
        id: String(p.id), name: p.name, farbe: TODOIST_FARBEN[p.color] || '#808080',
        reihenfolge: Number(p.child_order || 0), eingang: !!p.inbox_project,
        eltern: p.parent_id ? String(p.parent_id) : null
      };
    }),
    sektionen: sektionen.filter(function (s) { return !s.is_archived; }).map(function (s) {
      return { id: String(s.id), projektId: String(s.project_id || ''), name: s.name, reihenfolge: Number(s.section_order || 0) };
    })
  };
}

app.get('/api/todoist/uebersicht', nurAngemeldet, mitFehler(async function (req, res) {
  res.json(await todoistUebersicht());
}));

// Alle offenen Aufgaben über alle Projekte hinweg (ältere Form, bleibt für alle Fälle)
app.get('/api/todoist/alle', nurAngemeldet, mitFehler(async function (req, res) {
  res.json((await todoistUebersicht()).aufgaben);
}));

// Ein Kalendertag "JJJJ-MM-TT" um n Tage verschoben
function tagPlus(datum, n) {
  const d = new Date(Date.UTC(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)) - 1, Number(datum.slice(8, 10)) + n));
  return d.toISOString().slice(0, 10);
}

// Alles, was diese Woche ansteht - über alle Projekte hinweg
app.get('/api/todoist/woche', nurAngemeldet, mitFehler(async function (req, res) {
  const [liste, pl] = await Promise.all([todoistListe('/tasks'), todoistListe('/projects')]);
  const namen = {};
  pl.forEach(function (p) { namen[String(p.id)] = p.name; });

  // Die laufende Kalenderwoche nach Berliner Zeit, Montag bis Sonntag, als reine Kalendertage.
  // So hängt nichts davon ab, in welcher Zeitzone der Server selbst läuft.
  const heute = berlinJetzt().datum;
  const wochentag = (new Date(heute + 'T00:00:00Z').getUTCDay() + 6) % 7;   // Montag = 0
  const montag = tagPlus(heute, -wochentag);
  const sonntag = tagPlus(montag, 6);

  // Diese Woche und alles, was aus früheren Wochen offen geblieben ist
  const woche = liste.map(function (t) { return aufgabeMappen(t, namen); })
    .filter(function (a) { return a.faellig && a.faellig <= sonntag; })
    .map(function (a) { a.alt = a.faellig < montag; return a; })
    .sort(function (a, b) { return a.faellig < b.faellig ? -1 : (a.faellig > b.faellig ? 1 : 0); });

  res.json(woche);
}));

// Neue Aufgabe anlegen
app.post('/api/todoist/aufgabe', nurAngemeldet, async function (req, res) {
  const { inhalt, projektId, faellig, faelligZeit, prioritaet, eltern, beschreibung, sektion, labels, dueString } = req.body || {};
  if (!inhalt) return res.status(400).json({ fehler: 'Kein Inhalt' });
  try {
    const heute = new Date().toLocaleDateString('de-DE');
    const neu = await todoist('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        content: inhalt,
        description: 'Hinzugefügt am: ' + heute + (beschreibung ? '\n' + beschreibung : ''),
        project_id: eltern ? undefined : (projektId || undefined),
        section_id: eltern ? undefined : (sektion || undefined),
        parent_id: eltern || undefined,
        due_date: (!dueString && !faelligZeit && faellig) ? faellig : undefined,
        due_datetime: (!dueString && faelligZeit) ? faelligZeit : undefined,
        due_string: dueString || undefined,
        due_lang: dueString ? 'de' : undefined,
        priority: prioritaet || undefined,
        labels: (Array.isArray(labels) && labels.length) ? labels : undefined
      })
    });
    res.json({ ok: true, id: neu && neu.id ? String(neu.id) : null });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe ändern
app.post('/api/todoist/aufgabe/:id', nurAngemeldet, async function (req, res) {
  const { inhalt, beschreibung, faellig, faelligZeit, prioritaet, labels, dueString } = req.body || {};
  const koerper = {};
  if (inhalt !== undefined) koerper.content = inhalt;
  if (beschreibung !== undefined) koerper.description = beschreibung;
  if (prioritaet !== undefined) koerper.priority = prioritaet;
  if (Array.isArray(labels)) koerper.labels = labels;
  if (dueString !== undefined) { koerper.due_string = dueString || 'no date'; koerper.due_lang = 'de'; }
  else if (faelligZeit) koerper.due_datetime = faelligZeit;
  else if (faellig !== undefined) {
    if (faellig) koerper.due_date = faellig;
    else koerper.due_string = 'no date';   // so nimmt Todoist das Datum weg
  }
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id), {
      method: 'POST', body: JSON.stringify(koerper)
    });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe löschen
app.delete('/api/todoist/aufgabe/:id', nurAngemeldet, async function (req, res) {
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id), { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Kommentare lesen
app.get('/api/todoist/aufgabe/:id/kommentare', nurAngemeldet, async function (req, res) {
  try {
    const liste = alsListe(await todoist('/comments?task_id=' + encodeURIComponent(req.params.id)));
    res.json(liste.map(function (k) {
      return {
        id: String(k.id),
        inhalt: k.content,
        wann: k.posted_at || k.posted || null,
        datei: k.file_attachment ? (k.file_attachment.file_url || null) : null
      };
    }));
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Kommentar schreiben
app.post('/api/todoist/aufgabe/:id/kommentar', nurAngemeldet, async function (req, res) {
  const inhalt = req.body && req.body.inhalt;
  if (!inhalt) return res.status(400).json({ fehler: 'Kein Text' });
  try {
    await todoist('/comments', {
      method: 'POST',
      body: JSON.stringify({ task_id: req.params.id, content: inhalt })
    });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe in ein anderes Projekt, einen Abschnitt oder unter eine andere Aufgabe schieben
app.post('/api/todoist/aufgabe/:id/verschieben', nurAngemeldet, async function (req, res) {
  const { projektId, sektion, eltern } = req.body || {};
  if (!projektId && !sektion && !eltern) return res.status(400).json({ fehler: 'Kein Ziel' });
  const ziel = eltern ? { parent_id: eltern } : (sektion ? { section_id: sektion } : { project_id: projektId });
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id) + '/move', {
      method: 'POST', body: JSON.stringify(ziel)
    });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Abgehakte Aufgabe wieder öffnen ("Rückgängig")
app.post('/api/todoist/aufgabe/:id/wieder', nurAngemeldet, async function (req, res) {
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id) + '/reopen', { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe abhaken
app.post('/api/todoist/aufgabe/:id/erledigt', nurAngemeldet, async function (req, res) {
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id) + '/close', { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

app.post('/api/todoist/sync', nurAngemeldet, async function (req, res) {
  const aufgaben = (req.body && req.body.aufgaben) || [];
  let angelegt = 0, uebersprungen = 0;
  const fehler = [];

  for (const a of aufgaben) {
    const da = db.prepare('SELECT 1 FROM todoist_sync WHERE schluessel = ?').get(a.schluessel);
    if (da) { uebersprungen++; continue; }
    try {
      const heute = new Date().toLocaleDateString('de-DE');
      const neu = await todoist('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          content: a.inhalt,
          description: 'Hinzugefügt am: ' + heute + (a.beschreibung ? '\n' + a.beschreibung : ''),
          project_id: a.projektId || undefined,
          due_date: a.faellig || undefined
        })
      });
      db.prepare('INSERT INTO todoist_sync (schluessel, aufgabe, wann) VALUES (?,?,?)')
        .run(a.schluessel, neu && neu.id ? String(neu.id) : '', Date.now());
      angelegt++;
    } catch (e) { fehler.push(a.inhalt + ': ' + e.message); }
  }

  res.json({ angelegt: angelegt, uebersprungen: uebersprungen, fehler: fehler });
});

// ---------------- Google Mail ----------------
//  OAuth: Der Server kennt nur ein widerrufbares Zugriffsrecht, kein Passwort.

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
  + ' https://www.googleapis.com/auth/drive.file';

function googleEinstellungen() {
  return {
    clientId: einstellung('google_client_id'),
    clientSecret: einstellung('google_client_secret'),
    refresh: einstellung('google_refresh'),
    adresse: einstellung('google_adresse')
  };
}

// Das Zugriffs-Token gilt eine Stunde — so lange wird es wiederverwendet statt jedes Mal neu geholt
let googleZugriff = { token: null, bis: 0 };
function googleZugriffVergessen() { googleZugriff = { token: null, bis: 0 }; }

async function googleToken() {
  const g = googleEinstellungen();
  if (!g.clientId || !g.refresh) throw new Error('Google ist nicht verbunden');
  if (googleZugriff.token && Date.now() < googleZugriff.bis) return googleZugriff.token;
  const antwort = await holen('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refresh,
      grant_type: 'refresh_token'
    })
  });
  if (!antwort.ok) throw new Error('Google lehnt das Zugriffsrecht ab (' + antwort.status + ')');
  const daten = await antwort.json();
  googleZugriff = {
    token: daten.access_token,
    bis: Date.now() + Math.max(60, (Number(daten.expires_in) || 3600) - 120) * 1000
  };
  return daten.access_token;
}

// Eine Gmail-Abfrage. Wirft bei Fehlern, statt still eine leere Antwort zu liefern.
async function gmail(token, pfad) {
  const antwort = await holen('https://gmail.googleapis.com/gmail/v1/users/me' + pfad, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!antwort.ok) {
    if (antwort.status === 401) googleZugriffVergessen();
    const grund = await antwort.text().catch(function () { return ''; });
    throw new Error('Gmail antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 160) : ''));
  }
  return antwort.json();
}
const MAIL_KOPF = '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';

app.get('/api/google', nurAngemeldet, function (req, res) {
  const g = googleEinstellungen();
  res.json({
    eingerichtet: !!(g.clientId && g.clientSecret),
    verbunden: !!g.refresh,
    adresse: g.adresse || null
  });
});

app.put('/api/google', nurAngemeldet, nurVerwalter, function (req, res) {
  const { clientId, clientSecret } = req.body || {};
  if (clientId) einstellungSetzen('google_client_id', String(clientId).trim());
  if (clientSecret) einstellungSetzen('google_client_secret', String(clientSecret).trim());
  res.json({ ok: true });
});

app.put('/api/post/filter', nurAngemeldet, nurVerwalter, function (req, res) {
  const { stichworte, ausschluss } = req.body || {};
  if (stichworte !== undefined) einstellungSetzen('post_stichworte', String(stichworte));
  if (ausschluss !== undefined) einstellungSetzen('post_ausschluss', String(ausschluss));
  postCache.clear();
  res.json({ ok: true });
});

app.get('/api/post/filter', nurAngemeldet, function (req, res) {
  res.json({
    stichworte: einstellung('post_stichworte') || '',
    ausschluss: einstellung('post_ausschluss') || ''
  });
});

app.delete('/api/google', nurAngemeldet, nurVerwalter, function (req, res) {
  ['google_refresh', 'google_adresse'].forEach(function (k) {
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run(k);
  });
  googleZugriffVergessen();
  postCache.clear();
  res.json({ ok: true });
});

// Rücksprungadresse für Google. Am besten fest über die Umgebungsvariable ADRESSE
// (z. B. ADRESSE=https://zieglerverwaltung.immobilien), sonst aus der Anfrage abgeleitet.
function googleRueckweg(req) {
  const basis = process.env.ADRESSE ? process.env.ADRESSE.replace(/\/+$/, '') : 'https://' + req.get('host');
  return basis + '/api/google/zurueck';
}

// Offene Anmeldevorgänge bei Google: Zufallswert -> wer, wann.
// Nur ein Rücksprung mit einem Wert, den wir selbst vergeben haben, wird angenommen (Schutz vor CSRF).
const googleVorgaenge = new Map();

// Schritt 1: zu Google schicken
app.get('/api/google/start', nurAngemeldet, nurVerwalter, function (req, res) {
  const g = googleEinstellungen();
  if (!g.clientId) return res.status(400).send('Erst Client-ID hinterlegen');
  const grenze = Date.now() - 10 * 60 * 1000;
  googleVorgaenge.forEach(function (v, k) { if (v.zeit < grenze) googleVorgaenge.delete(k); });
  const state = crypto.randomBytes(24).toString('hex');
  googleVorgaenge.set(state, { nutzer: req.nutzer, zeit: Date.now() });
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: googleRueckweg(req),
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: state
  });
  res.redirect(url);
});

// Schritt 2: Google schickt zurück
app.get('/api/google/zurueck', nurAngemeldet, nurVerwalter, async function (req, res) {
  const g = googleEinstellungen();
  const state = String(req.query.state || '');
  const vorgang = googleVorgaenge.get(state);
  googleVorgaenge.delete(state);
  if (!vorgang || vorgang.nutzer !== req.nutzer || Date.now() - vorgang.zeit > 10 * 60 * 1000) {
    return res.status(400).send('Dieser Rücksprung gehört zu keiner laufenden Anmeldung. Bitte in der App neu verbinden.');
  }
  const code = req.query.code;
  if (!code) return res.status(400).send('Kein Code von Google');
  try {
    const ziel = googleRueckweg(req);
    const antwort = await holen('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code, client_id: g.clientId, client_secret: g.clientSecret,
        redirect_uri: ziel, grant_type: 'authorization_code'
      })
    });
    const daten = await antwort.json();
    if (!daten.refresh_token) throw new Error(daten.error_description || 'Kein dauerhaftes Zugriffsrecht erhalten');
    einstellungSetzen('google_refresh', daten.refresh_token);
    googleZugriffVergessen();
    postCache.clear();

    // Adresse merken, damit man sieht, welches Postfach hängt
    try {
      const profil = await gmail(daten.access_token, '/profile');
      if (profil.emailAddress) einstellungSetzen('google_adresse', profil.emailAddress);
    } catch (e) { /* nicht schlimm */ }

    res.send('<meta charset="utf-8"><body style="font-family:sans-serif;background:#14181e;color:#e8eaed;padding:40px">'
      + '<h2>Postfach verbunden</h2><p>Du kannst dieses Fenster schließen.</p>'
      + '<script>setTimeout(function(){ location.href = "/"; }, 1500)</script></body>');
  } catch (e) {
    res.status(502).send('<meta charset="utf-8">Fehlgeschlagen: ' + htmlSicher(e.message));
  }
});

// Direktsuche zum Nachschauen: Was liefert Google überhaupt?
app.get('/api/post/suche', nurAngemeldet, async function (req, res) {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ fehler: 'Kein Suchbegriff' });
  try {
    const token = await googleToken();

    // Welches Postfach hängt eigentlich dran?
    const profil = await gmail(token, '/profile');
    if (profil.emailAddress) einstellungSetzen('google_adresse', profil.emailAddress);

    const liste = await gmail(token, '/messages?maxResults=20&q=' + encodeURIComponent(q));

    const treffer = await Promise.all(((liste.messages || []).slice(0, 20)).map(function (m) {
      return gmail(token, '/messages/' + m.id + MAIL_KOPF).catch(function () { return null; });
    }));

    res.json({
      postfach: profil.emailAddress || null,
      gesamtImPostfach: profil.messagesTotal || null,
      gefunden: (liste.messages || []).length,
      mails: treffer.filter(Boolean).map(function (mail) {
        const h = {};
        ((mail.payload && mail.payload.headers) || []).forEach(function (x) { h[x.name] = x.value; });
        return {
          id: mail.id, von: h.From || '', betreff: h.Subject || '', wann: h.Date || null,
          labels: (mail.labelIds || []).join(', '),
          url: 'https://mail.google.com/mail/u/0/#inbox/' + mail.id
        };
      })
    });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Anhänge einer Mail auflisten
app.get('/api/post/:id/anhaenge', nurAngemeldet, async function (req, res) {
  try {
    const token = await googleToken();
    const mail = await gmail(token, '/messages/' + encodeURIComponent(req.params.id) + '?format=full');

    const gefunden = [];
    const durchgehen = function (teil) {
      if (!teil) return;
      if (teil.filename && teil.body && teil.body.attachmentId) {
        gefunden.push({
          id: teil.body.attachmentId,
          name: teil.filename,
          typ: teil.mimeType,
          groesse: teil.body.size || 0
        });
      }
      (teil.parts || []).forEach(durchgehen);
    };
    durchgehen(mail.payload);
    res.json(gefunden);
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Anhang nach Google Drive legen
app.post('/api/post/:id/ablegen', nurAngemeldet, async function (req, res) {
  const { anhangId, name, ordnerId } = req.body || {};
  if (!anhangId || !name) return res.status(400).json({ fehler: 'Angaben fehlen' });
  try {
    const token = await googleToken();

    const anhang = await gmail(token, '/messages/' + encodeURIComponent(req.params.id)
      + '/attachments/' + encodeURIComponent(anhangId));

    const daten = Buffer.from(String(anhang.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    const grenze = 'grenze' + Date.now();
    const kopf = JSON.stringify({ name: name, parents: ordnerId ? [ordnerId] : undefined });
    const koerper = Buffer.concat([
      Buffer.from('--' + grenze + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + kopf + '\r\n'),
      Buffer.from('--' + grenze + '\r\nContent-Type: application/octet-stream\r\n\r\n'),
      daten,
      Buffer.from('\r\n--' + grenze + '--')
    ]);

    const antwort = await holen('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      signal: AbortSignal.timeout(120000),   // große Anhänge brauchen länger
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + grenze
      },
      body: koerper
    });
    if (!antwort.ok) {
      const grund = await antwort.text().catch(function () { return ''; });
      throw new Error('Drive lehnt ab (' + antwort.status + ') ' + grund.slice(0, 160));
    }
    const datei = await antwort.json();
    res.json({ ok: true, id: datei.id, url: 'https://drive.google.com/file/d/' + datei.id + '/view' });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Post holen und nach Mietern und Objekten filtern
const postCache = new Map();   // Schlüssel -> { zeit, daten }
const POST_FRISCH = 3 * 60 * 1000;

// Mails, die als uninteressant weggelegt wurden — tauchen nie wieder auf
function postVersteckt() {
  try { return JSON.parse(einstellung('post_versteckt') || '[]'); }
  catch (e) { return []; }
}
function postAntwortFiltern(daten) {
  const liste = postVersteckt();
  const ids = {};
  liste.forEach(function (v) { ids[v.id] = true; });
  return Object.assign({}, daten, {
    mails: (daten.mails || []).filter(function (m) { return !ids[m.id]; }),
    rest: (daten.rest || []).filter(function (m) { return !ids[m.id]; }),
    versteckt: liste
  });
}

app.put('/api/post/ausblenden', nurAngemeldet, function (req, res) {
  const { id, betreff, von, wann } = req.body || {};
  if (!id) return res.status(400).json({ fehler: 'Keine Mail angegeben' });
  const liste = postVersteckt().filter(function (v) { return v.id !== id; });
  liste.push({
    id: String(id),
    betreff: String(betreff || '').slice(0, 200),
    von: String(von || '').slice(0, 120),
    wann: wann || null,
    seit: new Date().toISOString()
  });
  einstellungSetzen('post_versteckt', JSON.stringify(liste.slice(-300)));
  res.json({ ok: true, anzahl: Math.min(liste.length, 300) });
});

app.put('/api/post/einblenden', nurAngemeldet, function (req, res) {
  const { id } = req.body || {};
  const liste = postVersteckt().filter(function (v) { return v.id !== id; });
  einstellungSetzen('post_versteckt', JSON.stringify(liste));
  res.json({ ok: true, anzahl: liste.length });
});

app.get('/api/post', nurAngemeldet, async function (req, res) {
  try {
    const cacheKey = (req.query.tage || '90') + '|' + (req.query.modus || 'streng');
    const alt = postCache.get(cacheKey);
    if (alt && Date.now() - alt.zeit < POST_FRISCH && req.query.frisch !== '1') {
      return res.json(postAntwortFiltern(Object.assign({}, alt.daten, { ausCache: true })));
    }
    const token = await googleToken();
    const stand = db.prepare('SELECT inhalt FROM stand WHERE id = 1').get();
    const daten = stand ? JSON.parse(stand.inhalt) : { objects: [] };

    // Suchbegriffe aus den eigenen Daten
    const treffer = [];
    (daten.objects || []).forEach(function (o) {
      (o.units || []).forEach(function (x) {
        (x.tenant || '').split(',').forEach(function (name) {
          const t = name.trim();
          if (t.length > 3) treffer.push({ wort: t.toLowerCase(), objekt: o.name, einheit: x.name });
        });
        (x.contact || '').split('·').forEach(function (teil) {
          const m = teil.trim().match(/[\w.+-]+@[\w.-]+/);
          if (m) treffer.push({ wort: m[0].toLowerCase(), objekt: o.name, einheit: x.name });
        });
      });
      const kurz = o.name.split(',')[0].trim();
      if (kurz.length > 4) treffer.push({ wort: kurz.toLowerCase(), objekt: o.name, einheit: null });
    });

    const standard = ['kündigung', 'kuendigung', 'wasserschaden', 'schaden', 'heizung',
      'nebenkosten', 'mieterhöhung', 'mieterhoehung', 'kaution', 'besichtigung', 'immoscout',
      'mahnung', 'rechnung', 'wartung', 'aufzug', 'schlüssel', 'schluessel', 'zählerstand',
      'mietvertrag', 'miete', 'wohnung', 'stellplatz', 'garage', 'stadtwerke', 'strom', 'wasser',
      'handwerker', 'angebot', 'termin', 'übergabe', 'uebergabe', 'zähler', 'zaehler',
      'versicherung', 'grundsteuer', 'hausgeld', 'schornsteinfeger', 'photovoltaik', 'pv',
      'immobilienscout', 'immowelt', 'kleinanzeigen', 'anfrage', 'interessent', 'interessentin',
      'bewerbung', 'exposé', 'expose', 'objektanfrage', 'kontaktanfrage', 'mietinteresse',
      'selbstauskunft', 'schufa', 'wohnungssuche', 'mietangebot'];
    const eigene = (einstellung('post_stichworte') || '').split(',')
      .map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
    const stichworte = standard.concat(eigene);

    // Was nie in der Arbeitsansicht auftauchen soll
    const ausschluss = (einstellung('post_ausschluss') || '').split(',')
      .map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);

    const modus = req.query.modus === 'breit' ? 'breit'
      : (req.query.modus === 'roh' ? 'roh' : 'streng');

    // Wer ist eigentlich verbunden?
    let postfach = null, gesamt = null;
    try {
      const profil = await gmail(token, '/profile');
      postfach = profil.emailAddress || null;
      gesamt = profil.messagesTotal || null;
      if (postfach) einstellungSetzen('google_adresse', postfach);
    } catch (e) { /* nicht schlimm */ }

    const tage = Math.min(365, Math.max(7, Number(req.query.tage) || 90));
    // Im breiten Modus fliegen Werbung, Soziales und Foren gleich bei Google raus
    const frage = 'newer_than:' + tage + 'd -in:trash';
    const liste = await gmail(token, '/messages?maxResults=150&q=' + encodeURIComponent(frage));

    const ergebnis = [];
    const ohneTreffer = [];

    // In Zehnerblöcken gleichzeitig abrufen - deutlich schneller als einzeln
    const ids = (liste.messages || []).slice(0, 150);
    const mails = [];
    for (let i = 0; i < ids.length; i += 10) {
      const block = await Promise.all(ids.slice(i, i + 10).map(function (m) {
        return gmail(token, '/messages/' + m.id + MAIL_KOPF).catch(function () { return null; });
      }));
      block.forEach(function (b) { if (b) mails.push(b); });
    }

    for (const mail of mails) {
      const m = { id: mail.id };
      const kopf = {};
      ((mail.payload && mail.payload.headers) || []).forEach(function (h) { kopf[h.name] = h.value; });
      const text = ((kopf.From || '') + ' ' + (kopf.Subject || '') + ' ' + (mail.snippet || '')).toLowerCase();

      if (modus !== 'roh' && ausschluss.some(function (a) { return text.indexOf(a) !== -1; })) continue;

      if (modus === 'roh') {
        ergebnis.push({
          id: m.id, von: kopf.From || '', betreff: kopf.Subject || '(ohne Betreff)',
          auszug: mail.snippet || '', wann: kopf.Date || null,
          objekt: null, einheit: null, grund: null,
          url: 'https://mail.google.com/mail/u/0/#inbox/' + m.id
        });
        if (ergebnis.length >= 80) break;
        continue;
      }

      const passt = treffer.find(function (t) { return text.indexOf(t.wort) !== -1; });
      const wort = stichworte.find(function (w) { return text.indexOf(w) !== -1; });
      if (modus === 'breit' && !passt && !wort) {
        ergebnis.push({
          id: m.id, von: kopf.From || '', betreff: kopf.Subject || '(ohne Betreff)',
          auszug: mail.snippet || '', wann: kopf.Date || null, objekt: null, einheit: null,
          grund: null, url: 'https://mail.google.com/mail/u/0/#inbox/' + m.id
        });
        if (ergebnis.length >= 60) break;
        continue;
      }
      if (!passt && !wort) {
        if (ohneTreffer.length < 8) {
          ohneTreffer.push({
            id: m.id, von: kopf.From || '', betreff: kopf.Subject || '(ohne Betreff)',
            auszug: mail.snippet || '', wann: kopf.Date || null, objekt: null, einheit: null,
            grund: null, url: 'https://mail.google.com/mail/u/0/#inbox/' + m.id
          });
        }
        continue;
      }

      ergebnis.push({
        id: m.id,
        von: kopf.From || '',
        betreff: kopf.Subject || '(ohne Betreff)',
        auszug: mail.snippet || '',
        wann: kopf.Date || null,
        objekt: passt ? passt.objekt : null,
        einheit: passt ? passt.einheit : null,
        grund: passt ? passt.wort : wort,
        url: 'https://mail.google.com/mail/u/0/#inbox/' + m.id
      });
      if (ergebnis.length >= 60) break;
    }

    let neueste = null;
    mails.forEach(function (mail) {
      const h = {};
      ((mail.payload && mail.payload.headers) || []).forEach(function (x) { h[x.name] = x.value; });
      const d = h.Date ? new Date(h.Date) : null;
      if (d && !isNaN(d) && (!neueste || d > neueste)) neueste = d;
    });

    const antwortDaten = {
      postfach: postfach,
      gesamt: gesamt,
      neueste: neueste ? neueste.toISOString() : null,
      mails: ergebnis,
      tage: tage,
      modus: modus,
      geprueft: mails.length,
      suchbegriffe: treffer.length,
      rest: ohneTreffer,
      geholt: Date.now()
    };
    postCache.set(cacheKey, { zeit: Date.now(), daten: antwortDaten });
    res.json(postAntwortFiltern(antwortDaten));
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// ---------------- Mitteilungen (Web Push) ----------------
// Der Server schickt Push-Mitteilungen an angemeldete Geräte:
// morgens eine Tagesübersicht, dazu eine Probemitteilung auf Wunsch.
// Braucht das Paket web-push — fehlt es, läuft alles andere trotzdem.

let webpush = null;
try { webpush = require('web-push'); }
catch (e) { console.log('Hinweis: web-push fehlt — Mitteilungen bleiben aus. Nachrüsten mit: npm install web-push'); }

db.exec(`
  CREATE TABLE IF NOT EXISTS push_abos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nutzer    TEXT,
    geraet    TEXT,
    endpoint  TEXT UNIQUE,
    abo       TEXT NOT NULL,
    angelegt  TEXT
  );
`);

function vapid() {
  if (!webpush) return null;
  let roh = einstellung('vapid_schluessel');
  if (!roh) {
    roh = JSON.stringify(webpush.generateVAPIDKeys());
    einstellungSetzen('vapid_schluessel', roh);
  }
  const k = JSON.parse(roh);
  webpush.setVapidDetails('https://zieglerverwaltung.immobilien', k.publicKey, k.privateKey);
  return k;
}
if (webpush) vapid();

function ohneWebpush(res) {
  res.status(500).json({ fehler: 'Auf dem Server fehlt das Paket web-push. Einmalig im Ordner server ausführen: npm install web-push — danach den Dienst neu starten.' });
}

app.get('/api/push/schluessel', nurAngemeldet, function (req, res) {
  if (!webpush) return ohneWebpush(res);
  res.json({ schluessel: vapid().publicKey });
});

app.post('/api/push/anmelden', nurAngemeldet, function (req, res) {
  if (!webpush) return ohneWebpush(res);
  const { abo, geraet } = req.body || {};
  if (!abo || !abo.endpoint) return res.status(400).json({ fehler: 'Kein gültiges Abo' });
  db.prepare(`INSERT INTO push_abos (nutzer, geraet, endpoint, abo, angelegt) VALUES (?,?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET nutzer=excluded.nutzer, geraet=excluded.geraet, abo=excluded.abo`)
    .run(req.nutzer, String(geraet || 'Gerät').slice(0, 60), abo.endpoint, JSON.stringify(abo), new Date().toISOString());
  res.json({ ok: true });
});

app.post('/api/push/abmelden', nurAngemeldet, function (req, res) {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_abos WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

// Jeder sieht und entfernt seine eigenen Geräte, der Verwalter alle
app.get('/api/push/geraete', nurAngemeldet, function (req, res) {
  if (rolleVon(req.nutzer) === 'verwalter') {
    return res.json(db.prepare('SELECT id, nutzer, geraet, endpoint, angelegt FROM push_abos ORDER BY id').all());
  }
  res.json(db.prepare('SELECT id, nutzer, geraet, endpoint, angelegt FROM push_abos WHERE lower(nutzer) = lower(?) ORDER BY id')
    .all(req.nutzer));
});

app.delete('/api/push/geraete/:id', nurAngemeldet, function (req, res) {
  const abo = db.prepare('SELECT nutzer FROM push_abos WHERE id = ?').get(req.params.id);
  if (!abo) return res.json({ ok: true });
  if (rolleVon(req.nutzer) !== 'verwalter' && String(abo.nutzer || '').toLowerCase() !== req.nutzer.toLowerCase()) {
    return res.status(403).json({ fehler: 'Nur eigene Geräte lassen sich entfernen' });
  }
  db.prepare('DELETE FROM push_abos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function pushEinstellungenLesen() {
  let e = {};
  try { e = JSON.parse(einstellung('push_morgen') || '{}'); } catch (fehler) { e = {}; }
  return e;
}
function pushEinstellungenAntwort(e) {
  return {
    zeit: e.zeit || '07:00',
    morgen: e.morgen !== false,
    termine: e.termine !== false,
    anfragen: e.anfragen !== false
  };
}

app.get('/api/push/einstellungen', nurAngemeldet, function (req, res) {
  res.json(pushEinstellungenAntwort(pushEinstellungenLesen()));
});

// Gilt für alle Geräte — deshalb nur für den Verwalter
app.put('/api/push/einstellungen', nurAngemeldet, nurVerwalter, function (req, res) {
  const { zeit, morgen, termine, anfragen } = req.body || {};
  const e = pushEinstellungenLesen();
  if (typeof zeit === 'string' && /^\d{2}:\d{2}$/.test(zeit)) e.zeit = zeit;
  if (morgen !== undefined) e.morgen = !!morgen;
  if (termine !== undefined) e.termine = !!termine;
  if (anfragen !== undefined) e.anfragen = !!anfragen;
  einstellungSetzen('push_morgen', JSON.stringify(e));
  res.json(pushEinstellungenAntwort(e));
});

async function mitteilungSenden(zeilen, nachricht) {
  const nutzlast = JSON.stringify(nachricht);
  for (const z of zeilen) {
    try { await webpush.sendNotification(JSON.parse(z.abo), nutzlast); }
    catch (e) {
      // 404/410: das Gerät hat das Abo gekündigt — Eintrag aufräumen
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare('DELETE FROM push_abos WHERE id = ?').run(z.id);
      }
    }
  }
}

app.post('/api/push/test', nurAngemeldet, async function (req, res) {
  if (!webpush) return ohneWebpush(res);
  const zeilen = db.prepare('SELECT * FROM push_abos WHERE nutzer = ?').all(req.nutzer);
  if (!zeilen.length) return res.status(400).json({ fehler: 'Zuerst auf einem Gerät aktivieren' });
  await mitteilungSenden(zeilen, { titel: 'Ziegler', text: 'Probemitteilung — es funktioniert.', url: '/' });
  res.json({ ok: true, geraete: zeilen.length });
});

// ---------------- Vorlesestimme (OpenAI) ----------------
// Der Server holt die Aufnahme, damit der Schlüssel den Browser nie erreicht.
// Jede Aufnahme wird als Datei abgelegt: derselbe Text kostet kein zweites Mal.

const STIMMORDNER = path.join(DATENORDNER, 'stimme');
fs.mkdirSync(STIMMORDNER, { recursive: true });

const STIMMEN = ['onyx', 'ash', 'echo', 'ballad', 'verse', 'alloy', 'sage', 'coral', 'nova', 'shimmer'];
const STIMM_MODELLE = ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'];
// Nur wenn OpenAI ausdrücklich sagt, dass es das Modell nicht gibt, lohnt ein anderes.
// Ein gewöhnlicher 400er (z. B. wegen des Textes) darf das eingestellte Modell nicht umstellen.
function openaiModellFehlt(status, grund) {
  if (status === 404) return true;
  if (status !== 400) return false;
  try {
    const f = (JSON.parse(grund) || {}).error || {};
    return f.code === 'model_not_found' || f.param === 'model';
  } catch (e) { return false; }
}

const STIMM_ANWEISUNG = 'Sprich auf Deutsch, ruhig und freundlich, wie jemand, der morgens '
  + 'in Ruhe den Tag durchgeht. Deutliche Pausen zwischen den Punkten, keine Hektik.';

function stimmeLesen() {
  return {
    verbunden: !!einstellung('openai_token'),
    stimme: einstellung('stimme_name') || 'onyx',
    anweisung: einstellung('stimme_anweisung') || STIMM_ANWEISUNG,
    modell: einstellung('stimme_modell') || STIMM_MODELLE[0]
  };
}

// Aufnahmen, die älter als eine Woche sind, wegräumen
function stimmeAufraeumen() {
  try {
    const grenze = Date.now() - 7 * 86400000;
    fs.readdirSync(STIMMORDNER).forEach(function (name) {
      const datei = path.join(STIMMORDNER, name);
      try { if (fs.statSync(datei).mtimeMs < grenze) fs.unlinkSync(datei); }
      catch (fehler) { /* egal */ }
    });
  } catch (fehler) { /* egal */ }
}

app.get('/api/stimme', nurAngemeldet, function (req, res) {
  const e = stimmeLesen();
  res.json({ verbunden: e.verbunden, stimme: e.stimme, anweisung: e.anweisung });
});

app.put('/api/stimme', nurAngemeldet, nurVerwalter, function (req, res) {
  const { token, stimme, anweisung } = req.body || {};
  if (typeof token === 'string' && token.trim()) {
    einstellungSetzen('openai_token', token.trim());
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('stimme_modell');
  }
  if (token === '') {
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('openai_token');
  }
  if (typeof stimme === 'string' && STIMMEN.indexOf(stimme) !== -1) einstellungSetzen('stimme_name', stimme);
  if (typeof anweisung === 'string') einstellungSetzen('stimme_anweisung', anweisung.slice(0, 600));
  const e = stimmeLesen();
  res.json({ verbunden: e.verbunden, stimme: e.stimme, anweisung: e.anweisung });
});

// Text sprechen lassen — Antwort ist eine MP3-Datei
app.post('/api/stimme/sprechen', nurAngemeldet, async function (req, res) {
  const token = einstellung('openai_token');
  if (!token) return res.status(400).json({ fehler: 'Es ist noch keine Vorlesestimme eingerichtet' });

  const text = String((req.body && req.body.text) || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ fehler: 'Kein Text zum Vorlesen' });

  const e = stimmeLesen();
  const schluessel = crypto.createHash('sha256')
    .update(e.stimme + '|' + e.anweisung + '|' + text).digest('hex').slice(0, 32);
  const datei = path.join(STIMMORDNER, schluessel + '.mp3');

  if (fs.existsSync(datei)) {
    try {
      const alt = fs.readFileSync(datei);
      fs.utimesSync(datei, new Date(), new Date());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Ablage', 'ja');
      return res.send(alt);
    } catch (fehler) { /* dann eben neu holen */ }
  }

  // Modelle der Reihe nach versuchen: das beste zuerst, sonst das ältere
  const reihe = [e.modell].concat(STIMM_MODELLE.filter(function (m) { return m !== e.modell; }));
  let letzterGrund = '';
  for (const modell of reihe) {
    const koerper = { model: modell, voice: e.stimme, input: text, response_format: 'mp3' };
    if (modell.indexOf('gpt-') === 0) koerper.instructions = e.anweisung;
    let antwort;
    try {
      antwort = await holen('https://api.openai.com/v1/audio/speech', {
        signal: AbortSignal.timeout(60000),
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(koerper)
      });
    } catch (fehler) {
      return res.status(502).json({ fehler: 'Die Stimme ist nicht erreichbar: ' + fehler.message });
    }
    if (antwort.ok) {
      const puffer = Buffer.from(await antwort.arrayBuffer());
      try { fs.writeFileSync(datei, puffer); stimmeAufraeumen(); } catch (fehler) { /* egal */ }
      if (modell !== e.modell) einstellungSetzen('stimme_modell', modell);
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.send(puffer);
    }
    letzterGrund = await antwort.text().catch(function () { return ''; });
    if (antwort.status === 401) {
      return res.status(401).json({ fehler: 'Der Schlüssel wird nicht angenommen — bitte im Menü unter Vorlesestimme neu eintragen.' });
    }
    if (antwort.status === 429) {
      return res.status(429).json({ fehler: 'Das Guthaben ist aufgebraucht oder das Limit erreicht.' });
    }
    // Modell gibt es so nicht mehr — nächstes versuchen, sonst aufhören
    if (!openaiModellFehlt(antwort.status, letzterGrund)) break;
  }
  res.status(502).json({ fehler: 'Die Stimme antwortet nicht' + (letzterGrund ? ': ' + letzterGrund.slice(0, 160) : '') });
});

// ---------------- Assistent: zuhören, verstehen, eintragen ----------------
// Gesprochenes wird bei OpenAI in Text verwandelt, verstanden wird es von Claude.
// Claude darf dabei nur drei Dinge tun: Aufgaben anlegen, abhaken, verschieben.

const ASSISTENT_MODELLE = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];

function assistentLesen() {
  return {
    verbunden: !!einstellung('anthropic_token'),
    modell: einstellung('assistent_modell') || ASSISTENT_MODELLE[0],
    hoeren: !!einstellung('openai_token')
  };
}

app.get('/api/assistent', nurAngemeldet, function (req, res) {
  res.json(assistentLesen());
});

app.put('/api/assistent', nurAngemeldet, nurVerwalter, function (req, res) {
  const { token } = req.body || {};
  if (typeof token === 'string' && token.trim()) {
    einstellungSetzen('anthropic_token', token.trim());
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('assistent_modell');
  }
  if (token === '') db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('anthropic_token');
  res.json(assistentLesen());
});

// --- Gesprochenes in Text verwandeln (OpenAI) ---
app.post('/api/assistent/hoeren', nurAngemeldet,
  express.raw({ type: ['audio/*', 'video/*', 'application/octet-stream'], limit: '25mb' }),
  async function (req, res) {
    const token = einstellung('openai_token');
    if (!token) return res.status(400).json({ fehler: 'Zum Zuhören fehlt der Schlüssel der Vorlesestimme' });
    if (!req.body || !req.body.length) return res.status(400).json({ fehler: 'Nichts aufgenommen' });

    const art = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    const endung = art.indexOf('mp4') !== -1 ? 'mp4' : (art.indexOf('ogg') !== -1 ? 'ogg'
      : (art.indexOf('mpeg') !== -1 ? 'mp3' : (art.indexOf('wav') !== -1 ? 'wav' : 'webm')));

    for (const modell of ['gpt-4o-mini-transcribe', 'whisper-1']) {
      const formular = new FormData();
      formular.append('file', new Blob([req.body], { type: art }), 'aufnahme.' + endung);
      formular.append('model', modell);
      formular.append('language', 'de');
      let antwort;
      try {
        antwort = await holen('https://api.openai.com/v1/audio/transcriptions', {
          signal: AbortSignal.timeout(120000),
          method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formular
        });
      } catch (fehler) {
        return res.status(502).json({ fehler: 'Das Zuhören klappt gerade nicht: ' + fehler.message });
      }
      if (antwort.ok) {
        const ergebnis = await antwort.json();
        return res.json({ text: String((ergebnis && ergebnis.text) || '').trim() });
      }
      const grund = await antwort.text().catch(function () { return ''; });
      if (antwort.status === 401) return res.status(401).json({ fehler: 'Der Schlüssel wird nicht angenommen' });
      if (!openaiModellFehlt(antwort.status, grund)) {
        return res.status(502).json({ fehler: 'Das Zuhören klappt gerade nicht: ' + grund.slice(0, 160) });
      }
    }
    res.status(502).json({ fehler: 'Das Zuhören klappt gerade nicht' });
  });

// --- Was Claude über den Tag wissen muss ---
async function assistentLage() {
  const heute = berlinJetzt().datum;
  const d = standInhalt() || { objects: [], interessenten: [] };
  const zeilen = [];

  zeilen.push('Heute ist ' + new Date().toLocaleDateString('de-DE',
    { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    + ' (' + heute + ').');

  const objekte = (d.objects || []).map(function (o) { return o.name; });
  if (objekte.length) zeilen.push('Objekte: ' + objekte.join('; ') + '.');

  let projekte = [];
  let aufgaben = [];
  if (einstellung('todoist_token')) {
    try {
      projekte = await todoistListe('/projects');
      zeilen.push('Todoist-Projekte: ' + projekte.map(function (p) {
        return p.name + ' (id ' + p.id + ')';
      }).join('; ') + '.');
    } catch (fehler) { /* ohne Projekte geht es auch */ }
    try {
      const roh = await todoistListe('/tasks');
      aufgaben = roh.filter(function (t) {
        const f = t.due && (t.due.date || t.due.datetime);
        return f && String(f).slice(0, 10) <= heute;
      });
      zeilen.push(aufgaben.length
        ? 'Heute offen: ' + aufgaben.map(function (t) {
            return '"' + t.content + '" (id ' + t.id + ')';
          }).join('; ') + '.'
        : 'Für heute ist in Todoist nichts offen.');
    } catch (fehler) { /* egal */ }
  }

  const termine = (d.interessenten || []).filter(function (i) {
    return i.status !== 'absage' && i.termin && i.termin.slice(0, 10) === heute;
  });
  if (termine.length) {
    zeilen.push('Besichtigungen heute: ' + termine.map(function (i) {
      return (i.name || 'Interessent') + (i.termin.length > 10 ? ' um ' + i.termin.slice(11, 16) : '');
    }).join('; ') + '.');
  }

  return { text: zeilen.join('\n'), projekte: projekte, aufgaben: aufgaben };
}

const ASSISTENT_WERKZEUGE = [
  {
    name: 'aufgabe_anlegen',
    description: 'Legt eine neue Aufgabe in Todoist an.',
    input_schema: {
      type: 'object',
      properties: {
        inhalt: { type: 'string', description: 'Kurzer, tätiger Titel, z.B. "Kaminkehrer anrufen".' },
        projekt: { type: 'string', description: 'Name des Todoist-Projekts, meist der Objektname. Weglassen, wenn unklar.' },
        faellig: { type: 'string', description: 'Fälligkeit in normalem Deutsch, z.B. "morgen", "nächsten Dienstag 14 Uhr". Weglassen, wenn kein Datum genannt wurde.' },
        prioritaet: { type: 'integer', description: '4 = sehr wichtig, 3 = wichtig, 1 = normal.' },
        beschreibung: { type: 'string', description: 'Zusätzliche Einzelheiten, falls genannt.' }
      },
      required: ['inhalt']
    }
  },
  {
    name: 'aufgabe_erledigen',
    description: 'Hakt eine offene Aufgabe ab.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Die id aus der Liste der offenen Aufgaben.' } },
      required: ['id']
    }
  },
  {
    name: 'aufgabe_verschieben',
    description: 'Verschiebt eine Aufgabe auf ein anderes Datum.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Die id aus der Liste der offenen Aufgaben.' },
        faellig: { type: 'string', description: 'Neues Datum in normalem Deutsch, z.B. "morgen" oder "nächste Woche".' }
      },
      required: ['id', 'faellig']
    }
  }
];

async function assistentWerkzeug(name, eingabe, lage) {
  if (!einstellung('todoist_token')) return 'Fehler: Todoist ist nicht verbunden.';
  try {
    if (name === 'aufgabe_anlegen') {
      const projekt = (lage.projekte || []).find(function (p) {
        return eingabe.projekt && p.name.toLowerCase().indexOf(String(eingabe.projekt).toLowerCase()) !== -1;
      });
      const heute = new Date().toLocaleDateString('de-DE');
      const neu = await todoist('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          content: String(eingabe.inhalt || '').slice(0, 300),
          description: 'Hinzugefügt am: ' + heute + ' (per Sprache)'
            + (eingabe.beschreibung ? '\n' + eingabe.beschreibung : ''),
          project_id: projekt ? projekt.id : undefined,
          due_string: eingabe.faellig || undefined,
          due_lang: eingabe.faellig ? 'de' : undefined,
          priority: eingabe.prioritaet || undefined
        })
      });
      return 'Angelegt' + (projekt ? ' im Projekt ' + projekt.name : ' im Eingang')
        + (eingabe.faellig ? ', fällig ' + eingabe.faellig : '') + '. id ' + (neu && neu.id);
    }
    if (name === 'aufgabe_erledigen') {
      await todoist('/tasks/' + encodeURIComponent(eingabe.id) + '/close', { method: 'POST' });
      return 'Abgehakt.';
    }
    if (name === 'aufgabe_verschieben') {
      await todoist('/tasks/' + encodeURIComponent(eingabe.id), {
        method: 'POST',
        body: JSON.stringify({ due_string: eingabe.faellig, due_lang: 'de' })
      });
      return 'Verschoben auf ' + eingabe.faellig + '.';
    }
  } catch (fehler) {
    return 'Fehler: ' + fehler.message;
  }
  return 'Unbekannter Auftrag.';
}

async function claude(koerper) {
  const token = einstellung('anthropic_token');
  if (!token) { const e = new Error('Es ist noch kein Assistent eingerichtet'); e.status = 400; throw e; }
  const antwort = await holen('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(90000),
    method: 'POST',
    headers: {
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(koerper)
  });
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    const e = new Error(antwort.status === 401
      ? 'Der Schlüssel des Assistenten wird nicht angenommen'
      : (antwort.status === 429 ? 'Das Guthaben des Assistenten ist aufgebraucht'
        : 'Der Assistent antwortet nicht: ' + grund.slice(0, 160)));
    e.status = antwort.status;
    e.grund = grund;
    try { e.typ = ((JSON.parse(grund) || {}).error || {}).type || null; } catch (x) { e.typ = null; }
    throw e;
  }
  return antwort.json();
}

app.post('/api/assistent/sagen', nurAngemeldet, async function (req, res) {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ fehler: 'Nichts gesagt' });
  const verlauf = Array.isArray(req.body.verlauf) ? req.body.verlauf.slice(-8) : [];

  let lage;
  try { lage = await assistentLage(); }
  catch (fehler) { lage = { text: '', projekte: [], aufgaben: [] }; }

  const anweisung = 'Du bist der Assistent in der Hausverwaltungs-App von Louis, einem privaten Vermieter. '
    + 'Du hörst kurze gesprochene Sätze und antwortest gesprochen: höchstens zwei Sätze, freundlich, '
    + 'ohne Aufzählungen, ohne Sonderzeichen, ohne Rückfragen wenn es auch ohne geht. '
    + 'Wenn Louis dir eine Aufgabe gibt, legst du sie mit dem Werkzeug an und bestätigst kurz, '
    + 'was du eingetragen hast. Rate das passende Objekt aus dem Gesagten, frag nur nach, wenn es '
    + 'wirklich unklar ist. Fragen zum Tag beantwortest du aus der Lage unten. '
    + 'Erfinde nie Aufgaben oder Termine, die dort nicht stehen.\n\nLage:\n' + lage.text;

  const nachrichten = verlauf.filter(function (n) {
    return n && (n.role === 'user' || n.role === 'assistant') && typeof n.content === 'string';
  }).map(function (n) { return { role: n.role, content: n.content }; });
  nachrichten.push({ role: 'user', content: text });

  const eingestellt = assistentLesen().modell;
  const reihe = [eingestellt].concat(ASSISTENT_MODELLE.filter(function (m) { return m !== eingestellt; }));

  let modell = reihe[0];
  const getan = [];
  try {
    let antwort = null;
    for (const versuch of reihe) {
      try {
        antwort = await claude({
          model: versuch, max_tokens: 500, system: anweisung,
          tools: ASSISTENT_WERKZEUGE, messages: nachrichten
        });
        modell = versuch;
        if (versuch !== reihe[0]) einstellungSetzen('assistent_modell', versuch);
        break;
      } catch (fehler) {
        // Nur ausweichen, wenn es das Modell nicht gibt — sonst würde ein beliebiger
        // Fehler in der Anfrage das eingestellte Modell dauerhaft umstellen
        if (fehler.status === 404 || fehler.typ === 'not_found_error') continue;
        throw fehler;
      }
    }
    if (!antwort) throw new Error('Der Assistent antwortet nicht');

    // Werkzeuge ausführen, bis Claude fertig ist (höchstens drei Runden)
    for (let runde = 0; runde < 3 && antwort.stop_reason === 'tool_use'; runde++) {
      const auftraege = (antwort.content || []).filter(function (b) { return b.type === 'tool_use'; });
      nachrichten.push({ role: 'assistant', content: antwort.content });
      const ergebnisse = [];
      for (const a of auftraege) {
        const ergebnis = await assistentWerkzeug(a.name, a.input || {}, lage);
        getan.push({ was: a.name, eingabe: a.input, ergebnis: ergebnis });
        ergebnisse.push({ type: 'tool_result', tool_use_id: a.id, content: ergebnis });
      }
      nachrichten.push({ role: 'user', content: ergebnisse });
      antwort = await claude({
        model: modell, max_tokens: 500, system: anweisung,
        tools: ASSISTENT_WERKZEUGE, messages: nachrichten
      });
    }

    const gesagt = (antwort.content || []).filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join(' ').trim();
    res.json({ antwort: gesagt || 'Erledigt.', getan: getan });
  } catch (fehler) {
    res.status(fehler.status === 401 ? 401 : 502).json({ fehler: fehler.message, getan: getan });
  }
});

// --- Morgenmeldung: Tagesübersicht aus den eigenen Daten und Todoist ---

function berlinJetzt() {
  const teile = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const m = {};
  teile.forEach(function (t) { m[t.type] = t.value; });
  return { datum: m.year + '-' + m.month + '-' + m.day, zeit: m.hour + ':' + m.minute };
}

async function morgenInhalt(heute) {
  const teile = [];
  const zeile = db.prepare('SELECT inhalt FROM stand WHERE id = 1').get();
  const d = zeile ? JSON.parse(zeile.inhalt) : null;

  // Aufgaben aus Todoist: überfällig oder heute fällig
  try {
    if (einstellung('todoist_token')) {
      const liste = await todoistListe('/tasks');
      const anzahl = liste.filter(function (t) {
        const f = t.due && (t.due.date || t.due.datetime);
        return f && String(f).slice(0, 10) <= heute;
      }).length;
      if (anzahl) teile.push(anzahl + (anzahl === 1 ? ' Aufgabe fällig' : ' Aufgaben fällig'));
    }
  } catch (e) { /* Todoist gerade nicht erreichbar — Meldung geht trotzdem raus */ }

  if (d) {
    // Besichtigungen heute
    const b = (d.interessenten || []).filter(function (i) {
      return i.termin && i.termin.slice(0, 10) === heute && i.status !== 'absage';
    }).sort(function (a, c) { return a.termin < c.termin ? -1 : 1; });
    if (b.length === 1) {
      teile.push('Besichtigung ' + (b[0].termin.length > 10 ? b[0].termin.slice(11, 16) + ' ' : '') + (b[0].name || ''));
    } else if (b.length) {
      teile.push(b.length + ' Besichtigungen');
    }

    // Rückstände der letzten sechs Monate, wie in der Oberfläche
    const monate = [];
    const jetzt = new Date();
    for (let i = 5; i >= 0; i--) {
      const m = new Date(jetzt.getFullYear(), jetzt.getMonth() - i, 1);
      monate.push(m.getFullYear() + '-' + String(m.getMonth() + 1).padStart(2, '0'));
    }
    let offen = 0, frei = 0;
    (d.objects || []).forEach(function (o) {
      (o.units || []).forEach(function (x) {
        if (x.status === 'frei') frei++;
        if (x.status !== 'vermietet') return;
        const soll = (Number(x.rent) || 0) + (Number(x.parking) || 0) + (Number(x.kitchen) || 0) + (Number(x.nk) || 0);
        monate.forEach(function (m) {
          if (x.zahlungen && x.zahlungen[m] != null) offen += soll - (Number(x.zahlungen[m]) || 0);
        });
      });
    });
    if (offen > 0.5) teile.push(Math.round(offen).toLocaleString('de-DE') + ' € Rückstand');

    // Fristen: Prüfungen und Mietspiegel binnen 14 Tagen oder überfällig
    let fristen = 0;
    const bald = new Date(Date.now() + 14 * 86400000);
    (d.objects || []).forEach(function (o) {
      (o.pruefungen || []).forEach(function (p) {
        if (!p.letzte) return;
        const naechste = new Date(p.letzte);
        if (isNaN(naechste)) return;
        naechste.setMonth(naechste.getMonth() + (Number(p.intervall) || 12));
        if (naechste <= bald) fristen++;
      });
      if (o.mietspiegelBis) {
        const bis = new Date(o.mietspiegelBis);
        if (!isNaN(bis) && bis <= bald) fristen++;
      }
    });
    if (fristen) teile.push(fristen + (fristen === 1 ? ' Frist' : ' Fristen'));
    if (frei) teile.push(frei + ' frei');
  }

  return teile.length ? teile.join(' · ') : 'Nichts Dringendes. Guter Tag zum Aufräumen.';
}

function standInhalt() {
  const zeile = db.prepare('SELECT inhalt FROM stand WHERE id = 1').get();
  if (!zeile) return null;
  try { return JSON.parse(zeile.inhalt); } catch (fehler) { return null; }
}

if (webpush) {
  let anfragenZuletzt = 0;   // wann zuletzt bei Google nachgesehen wurde

  // --- Morgenmeldung zur eingestellten Zeit ---
  async function morgenTick(e, t) {
    if (e.morgen === false) return;
    // Nicht nur in genau der eingestellten Minute: Lief der Server da gerade nicht
    // (Neustart, kurz beschäftigt), wird innerhalb der folgenden Stunde nachgeholt.
    const minuten = function (hhmm) { return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)); };
    const spaeter = minuten(t.zeit) - minuten(e.zeit || '07:00');
    if (spaeter < 0 || spaeter > 60) return;
    if (einstellung('push_zuletzt') === t.datum) return;
    einstellungSetzen('push_zuletzt', t.datum);   // vor dem Senden, sonst klingelt es bei Fehlern jede halbe Minute
    const zeilen = db.prepare('SELECT * FROM push_abos').all();
    if (!zeilen.length) return;
    const text = await morgenInhalt(t.datum);
    const datum = new Date().toLocaleDateString('de-DE', {
      timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long'
    });
    await mitteilungSenden(zeilen, { titel: 'Guten Morgen — ' + datum, text: text, url: '/?memo=1' });
  }

  // --- Erinnerung eine Stunde vor jeder Besichtigung ---
  async function terminTick(e, t) {
    if (e.termine === false) return;
    const d = standInhalt();
    if (!d) return;
    const heute = (d.interessenten || []).filter(function (i) {
      return i.status !== 'absage' && i.termin && i.termin.length > 10
        && i.termin.slice(0, 10) === t.datum;
    });

    let gesendet = {};
    try { gesendet = JSON.parse(einstellung('push_termine') || '{}'); } catch (fehler) { gesendet = {}; }
    let geaendert = false;

    // Erledigtes von gestern aufräumen
    Object.keys(gesendet).forEach(function (k) {
      if (String(gesendet[k]).slice(0, 10) < t.datum) { delete gesendet[k]; geaendert = true; }
    });

    if (heute.length) {
      const jetztMin = Number(t.zeit.slice(0, 2)) * 60 + Number(t.zeit.slice(3, 5));
      for (const i of heute) {
        const zeit = i.termin.slice(11, 16);
        const terminMin = Number(zeit.slice(0, 2)) * 60 + Number(zeit.slice(3, 5));
        const abstand = terminMin - jetztMin;
        if (abstand < 0 || abstand > 60) continue;          // Erinnerung im letzten Stündchen
        if (gesendet[i.id] === i.termin) continue;          // schon erinnert
        gesendet[i.id] = i.termin; geaendert = true;

        let wo = '';
        (d.objects || []).forEach(function (o) {
          (o.units || []).forEach(function (x) {
            if (x.id === i.einheitId) wo = ' · ' + o.name.split(',')[0] + ' · ' + x.name;
          });
        });
        const zeilen = db.prepare('SELECT * FROM push_abos').all();
        if (zeilen.length) {
          await mitteilungSenden(zeilen, {
            titel: 'Besichtigung um ' + zeit,
            text: (i.name || 'Interessent') + wo,
            url: '/', tag: 'termin-' + i.id
          });
        }
      }
    }
    if (geaendert) einstellungSetzen('push_termine', JSON.stringify(gesendet));
  }

  // --- Meldung, wenn eine neue Anfrage im Postfach liegt ---
  async function anfrageTick(e) {
    if (e.anfragen === false) return;
    if (Date.now() - anfragenZuletzt < 5 * 60 * 1000) return;   // alle fünf Minuten reicht
    anfragenZuletzt = Date.now();
    if (!googleEinstellungen().refresh) return;                 // Postfach nicht verbunden
    const zeilen = db.prepare('SELECT * FROM push_abos').all();
    if (!zeilen.length) return;

    const token = await googleToken();
    const suche = 'in:inbox is:unread newer_than:1d ('
      + 'from:immobilienscout24.de OR from:immowelt.de OR from:immonet.de'
      + ' OR from:kleinanzeigen.de OR from:ebay-kleinanzeigen.de'
      + ' OR subject:Kontaktanfrage OR subject:Mietinteressent OR subject:"Anfrage zu Ihrer"'
      + ')';
    const liste = await gmail(token, '/messages?maxResults=10&q=' + encodeURIComponent(suche));

    const ids = (liste.messages || []).map(function (m) { return m.id; });
    if (!ids.length) return;

    let gesehen = [];
    try { gesehen = JSON.parse(einstellung('push_post_gesehen') || '[]'); } catch (fehler) { gesehen = []; }
    const neue = ids.filter(function (id) { return gesehen.indexOf(id) === -1; });
    if (!neue.length) return;
    einstellungSetzen('push_post_gesehen', JSON.stringify(gesehen.concat(neue).slice(-300)));

    for (const id of neue.slice(0, 3)) {
      const mail = await gmail(token, '/messages/' + id + MAIL_KOPF).catch(function () { return null; });
      if (!mail) continue;
      const h = {};
      ((mail.payload && mail.payload.headers) || []).forEach(function (x) { h[x.name] = x.value; });
      const von = String(h.From || '').replace(/<.*>/, '').replace(/"/g, '').trim();
      await mitteilungSenden(zeilen, {
        titel: 'Neue Anfrage' + (von ? ' — ' + von : ''),
        text: h.Subject || 'Im Postfach wartet eine neue Anfrage.',
        url: '/', tag: 'post-' + id
      });
    }
    if (neue.length > 3) {
      await mitteilungSenden(zeilen, {
        titel: 'Postfach',
        text: 'und ' + (neue.length - 3) + ' weitere neue Anfragen',
        url: '/', tag: 'post-mehr'
      });
    }
  }

  setInterval(async function () {
    const e = pushEinstellungenLesen();
    const t = berlinJetzt();
    try { await morgenTick(e, t); } catch (fehler) { console.log('Morgenmeldung fehlgeschlagen:', fehler.message); }
    try { await terminTick(e, t); } catch (fehler) { console.log('Terminerinnerung fehlgeschlagen:', fehler.message); }
    try { await anfrageTick(e); } catch (fehler) { console.log('Anfragen-Prüfung fehlgeschlagen:', fehler.message); }
  }, 30000).unref();
}

// ---------------- Google Kalender ----------------
//  Die App liest die private iCal-Adresse deines Google-Kalenders mit.
//  Das ist nur eine geheime Textadresse — kein Login, kein Schlüssel.
//  Der Server holt die Datei höchstens alle fünf Minuten neu.

let gkalRoh = { url: '', wann: 0, ereignisse: null };

// Lange Zeilen sind in der Kalenderdatei umgebrochen und beginnen dann mit Leerzeichen
function icsEntfalten(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}
function icsTextLesen(wert) {
  return String(wert || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',')
    .replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Versatz einer Zeitzone zur Weltzeit an einem bestimmten Zeitpunkt
function zonenVersatz(ts, zone) {
  const teile = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ts)).forEach(function (p) { teile[p.type] = p.value; });
  return Date.UTC(Number(teile.year), Number(teile.month) - 1, Number(teile.day),
    Number(teile.hour) % 24, Number(teile.minute), Number(teile.second)) - ts;
}

// Ortszeit einer Zone -> Weltzeit-Zeitstempel (zweimal, wegen der Zeitumstellung)
function ortsZeitZuTs(j, mo, t, st, mi, s, zone) {
  let ts = Date.UTC(j, mo - 1, t, st, mi, s);
  ts = Date.UTC(j, mo - 1, t, st, mi, s) - zonenVersatz(ts, zone);
  ts = Date.UTC(j, mo - 1, t, st, mi, s) - zonenVersatz(ts, zone);
  return ts;
}

// Weltzeit-Zeitstempel -> Berliner Ortszeit, in Einzelteilen
function berlinTeile(ts) {
  const teile = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin', hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(ts)).forEach(function (p) { teile[p.type] = p.value; });
  return {
    j: Number(teile.year), m: Number(teile.month), t: Number(teile.day),
    st: Number(teile.hour) % 24, mi: Number(teile.minute)
  };
}
function berlinText(ts) {
  const p = berlinTeile(ts);
  return p.j + '-' + String(p.m).padStart(2, '0') + '-' + String(p.t).padStart(2, '0')
    + 'T' + String(p.st).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0');
}

// Einen Zeitwert wie "20260901T090000", "…Z" oder ein reines Datum lesen
function icsZeit(wert, params) {
  if (!wert) return null;
  const w = String(wert).trim();
  let m = w.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || /VALUE=DATE(;|$)/.test(String(params || ''))) {
    m = m || w.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { ts: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), ganztags: true,
      datum: m[1] + '-' + m[2] + '-' + m[3] };
  }
  m = w.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const s = Number(m[6] || 0);
  if (m[7]) return { ts: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), s), ganztags: false };
  const zone = (String(params || '').match(/TZID=([^;:]+)/) || [])[1] || 'Europe/Berlin';
  let ts;
  try { ts = ortsZeitZuTs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), s, zone); }
  catch (e) { ts = ortsZeitZuTs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), s, 'Europe/Berlin'); }
  return { ts: ts, ganztags: false };
}

// Alle Einträge (VEVENT) aus der Kalenderdatei herausziehen
function icsEreignisse(text) {
  const zeilen = icsEntfalten(text).split('\n');
  const liste = [];
  let e = null;
  zeilen.forEach(function (zeile) {
    if (zeile === 'BEGIN:VEVENT') { e = { exdaten: [] }; return; }
    if (zeile === 'END:VEVENT') { if (e && e.start) liste.push(e); e = null; return; }
    if (!e) return;
    const doppel = zeile.indexOf(':');
    if (doppel === -1) return;
    const kopf = zeile.slice(0, doppel);
    const wert = zeile.slice(doppel + 1);
    const semi = kopf.indexOf(';');
    const name = (semi === -1 ? kopf : kopf.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? '' : kopf.slice(semi + 1);
    if (name === 'DTSTART') e.start = icsZeit(wert, params);
    else if (name === 'DTEND') e.ende = icsZeit(wert, params);
    else if (name === 'SUMMARY') e.titel = icsTextLesen(wert);
    else if (name === 'LOCATION') e.ort = icsTextLesen(wert);
    else if (name === 'DESCRIPTION') e.notiz = icsTextLesen(wert).slice(0, 2000);
    else if (name === 'UID') e.uid = wert.trim();
    else if (name === 'RRULE') e.regel = wert.trim();
    else if (name === 'STATUS') e.status = wert.trim().toUpperCase();
    else if (name === 'RECURRENCE-ID') e.ausnahmeVon = icsZeit(wert, params);
    else if (name === 'EXDATE') {
      wert.split(',').forEach(function (w) {
        const z = icsZeit(w, params);
        if (z) e.exdaten.push(z.ts);
      });
    }
  });
  return liste.filter(function (x) { return x.status !== 'CANCELLED'; });
}

function regelLesen(text) {
  const r = {};
  String(text || '').split(';').forEach(function (teil) {
    const gleich = teil.indexOf('=');
    if (gleich !== -1) r[teil.slice(0, gleich).toUpperCase()] = teil.slice(gleich + 1);
  });
  return r;
}

const ICS_WTAGE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Der n-te Wochentag eines Monats, z. B. der zweite Montag (n = 2) oder der letzte Freitag (n = -1)
function ntehWoche(j, mo, wtag, n) {
  const TAG = 86400000;
  if (n > 0) {
    const erster = Date.UTC(j, mo - 1, 1);
    const versch = (wtag - new Date(erster).getUTCDay() + 7) % 7;
    const k = erster + (versch + (n - 1) * 7) * TAG;
    return new Date(k).getUTCMonth() === mo - 1 ? k : null;
  }
  const letzter = Date.UTC(j, mo, 0);
  const versch = (new Date(letzter).getUTCDay() - wtag + 7) % 7;
  return letzter - (versch + (-n - 1) * 7) * TAG;
}

// Alle Anfangszeitpunkte eines Eintrags im gewünschten Fenster — Wiederholungen werden aufgelöst
function gkalVorkommen(e, vonTs, bisTs) {
  if (!e.regel) return [e.start.ts];
  const r = regelLesen(e.regel);
  const freq = String(r.FREQ || '').toUpperCase();
  const schritt = Math.max(1, Number(r.INTERVAL) || 1);
  const maxAnzahl = r.COUNT ? Number(r.COUNT) : Infinity;
  let bisRegel = Infinity;
  if (r.UNTIL) {
    const u = icsZeit(r.UNTIL, '');
    if (u) bisRegel = u.ts + 86399000;
  }
  const grenze = Math.min(bisTs, bisRegel);
  const TAG = 86400000;

  // Der erste Anfang in Berliner Ortszeit — die Wiederholung zählt in Kalendertagen weiter
  const p = e.start.ganztags
    ? { j: Number(e.start.datum.slice(0, 4)), m: Number(e.start.datum.slice(5, 7)), t: Number(e.start.datum.slice(8, 10)), st: 0, mi: 0 }
    : berlinTeile(e.start.ts);
  const anfangKal = Date.UTC(p.j, p.m - 1, p.t);
  const zuTs = function (kal) {
    const d = new Date(kal);
    return e.start.ganztags ? kal
      : ortsZeitZuTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.st, p.mi, 0, 'Europe/Berlin');
  };

  const treffer = [];
  let zaehler = 0;

  if (freq === 'DAILY') {
    for (let k = anfangKal, i = 0; i < 40000; i++, k += schritt * TAG) {
      const ts = zuTs(k);
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else if (freq === 'WEEKLY') {
    const tage = (r.BYDAY ? r.BYDAY.split(',') : [])
      .map(function (t) { return ICS_WTAGE[t.slice(-2)]; })
      .filter(function (t) { return t !== undefined; });
    if (!tage.length) tage.push(new Date(anfangKal).getUTCDay());
    const wochenNull = anfangKal - ((new Date(anfangKal).getUTCDay() + 6) % 7) * TAG;
    for (let k = anfangKal, i = 0; i < 40000; i++, k += TAG) {
      const wochen = Math.floor((k - wochenNull) / (7 * TAG));
      if (wochen % schritt !== 0) continue;
      if (tage.indexOf(new Date(k).getUTCDay()) === -1) continue;
      const ts = zuTs(k);
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else if (freq === 'MONTHLY') {
    const nth = r.BYDAY ? String(r.BYDAY).match(/^(-?\d)?([A-Z]{2})$/) : null;
    const tagImMonat = r.BYMONTHDAY ? Number(r.BYMONTHDAY.split(',')[0]) : p.t;
    for (let i = 0; i < 2400; i++) {
      const j = p.j + Math.floor((p.m - 1 + i * schritt) / 12);
      const mo = ((p.m - 1 + i * schritt) % 12) + 1;
      let k;
      if (nth && ICS_WTAGE[nth[2]] !== undefined) {
        k = ntehWoche(j, mo, ICS_WTAGE[nth[2]], Number(nth[1] || 1));
        if (k === null) continue;
      } else {
        if (tagImMonat > new Date(Date.UTC(j, mo, 0)).getUTCDate()) continue;
        k = Date.UTC(j, mo - 1, tagImMonat);
      }
      const ts = zuTs(k);
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else if (freq === 'YEARLY') {
    for (let i = 0; i < 200; i++) {
      const ts = zuTs(Date.UTC(p.j + i * schritt, p.m - 1, p.t));
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else {
    return [e.start.ts];
  }
  return treffer;
}

async function gkalHolen() {
  const url = einstellung('gkal_ics');
  if (!url) throw new Error('Keine Kalender-Adresse hinterlegt');
  const frisch = gkalRoh.ereignisse && gkalRoh.url === url && (Date.now() - gkalRoh.wann) < 5 * 60 * 1000;
  if (frisch) return gkalRoh.ereignisse;
  const antwort = await holen(url, { redirect: 'follow' });
  if (!antwort.ok) throw new Error('Google liefert den Kalender nicht (' + antwort.status + ')');
  const text = await antwort.text();
  if (text.indexOf('BEGIN:VCALENDAR') === -1) {
    throw new Error('Das ist keine Kalenderdatei — bitte die private iCal-Adresse prüfen');
  }
  gkalRoh = { url: url, wann: Date.now(), ereignisse: icsEreignisse(text) };
  return gkalRoh.ereignisse;
}

// Die fertige Terminliste für einen Zeitraum, Tag für Tag
function gkalFenster(ereignisse, von, bis) {
  const vonTs = ortsZeitZuTs(Number(von.slice(0, 4)), Number(von.slice(5, 7)), Number(von.slice(8, 10)), 0, 0, 0, 'Europe/Berlin');
  const bisTs = ortsZeitZuTs(Number(bis.slice(0, 4)), Number(bis.slice(5, 7)), Number(bis.slice(8, 10)), 23, 59, 59, 'Europe/Berlin');
  const TAG = 86400000;

  // Einzeln verschobene Wiederholungen verdrängen ihr Original
  const ersetzt = {};
  ereignisse.forEach(function (e) {
    if (e.ausnahmeVon && e.uid) ersetzt[e.uid + '@' + e.ausnahmeVon.ts] = true;
  });

  const liste = [];
  ereignisse.forEach(function (e) {
    const dauer = (e.ende && e.ende.ts > e.start.ts) ? e.ende.ts - e.start.ts
      : (e.start.ganztags ? TAG : 60 * 60000);
    gkalVorkommen(e, vonTs, bisTs).forEach(function (ts) {
      if (!e.ausnahmeVon && e.regel && ersetzt[(e.uid || '') + '@' + ts]) return;
      if (e.exdaten.indexOf(ts) !== -1) return;
      const ende = ts + dauer;
      if (ende <= vonTs || ts > bisTs) return;
      if (e.start.ganztags) {
        // Mehrtägiges bekommt je Tag eine Zeile, dann bleibt die Anzeige einfach
        for (let k = ts, i = 0; k < ende && i < 60; k += TAG, i++) {
          const tag = new Date(k).toISOString().slice(0, 10);
          if (tag < von || tag > bis) continue;
          liste.push({
            id: (e.uid || 'g') + '@' + ts + '@' + tag, titel: e.titel || 'Termin',
            ort: e.ort || '', notiz: e.notiz || '', ganztags: true,
            tag: tag, start: tag, ende: ''
          });
        }
      } else {
        const start = berlinText(ts);
        liste.push({
          id: (e.uid || 'g') + '@' + ts, titel: e.titel || 'Termin',
          ort: e.ort || '', notiz: e.notiz || '', ganztags: false,
          tag: start.slice(0, 10), start: start, ende: berlinText(ende)
        });
      }
    });
  });
  liste.sort(function (a, c) { return a.start < c.start ? -1 : 1; });
  return liste;
}

app.get('/api/gkal', nurAngemeldet, function (req, res) {
  res.json({ eingerichtet: !!einstellung('gkal_ics'), geladen: gkalRoh.wann || null });
});

app.put('/api/gkal', nurAngemeldet, nurVerwalter, async function (req, res) {
  const url = String((req.body || {}).url || '').trim();
  if (!url) {
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('gkal_ics');
    gkalRoh = { url: '', wann: 0, ereignisse: null };
    return res.json({ ok: true, eingerichtet: false });
  }
  if (url.indexOf('https://') !== 0) {
    return res.status(400).json({ fehler: 'Die Adresse muss mit https:// beginnen' });
  }
  try {
    einstellungSetzen('gkal_ics', url);
    gkalRoh = { url: '', wann: 0, ereignisse: null };
    const e = await gkalHolen();
    res.json({ ok: true, eingerichtet: true, anzahl: e.length });
  } catch (fehler) {
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('gkal_ics');
    res.status(502).json({ fehler: fehler.message });
  }
});

app.get('/api/gkal/termine', nurAngemeldet, async function (req, res) {
  const von = String(req.query.von || '').slice(0, 10);
  const bis = String(req.query.bis || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis) || bis < von) {
    return res.status(400).json({ fehler: 'von und bis als JJJJ-MM-TT angeben' });
  }
  try {
    if (req.query.frisch) gkalRoh.wann = 0;
    res.json({ termine: gkalFenster(await gkalHolen(), von, bis) });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

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
const RECHNUNG_ABSENDER_SCHLUESSEL = { as: 'rechnung_absender', nk: 'nk_absender' };

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
// Nächste freie Nummer je Art im Muster JJJJ-AS-NN (Allgemeinstrom) bzw. JJJJ-NK-NN (Nebenkosten)
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
  return { as: frei('AS'), nk: frei('NK') };
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
  const art = b.art === 'nk' ? 'nk' : 'as';
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
    const e = new Error('Drive antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 160) : ''));
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

// ---------------- Oberfläche ----------------
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.listen(PORT, '127.0.0.1', function () {
  console.log('Vermietung läuft auf 127.0.0.1:' + PORT);
});
