'use strict';

// -------------------------------------------------------------
//  Kaufen: Angebote aus den Suchaufträgen von ImmoScout24
//
//  Die Suchauftrags-Mails landen im verbundenen Postfach. Der Server
//  liest sie regelmäßig, merkt sich jedes Angebot einmal und meldet
//  sich aufs Handy, wenn ein Kaufangebot richtig gut aussieht.
//  Mietangebote aus denselben Mails zeigen, was Wohnungen im Ort
//  gerade kosten — damit rechnet der Kaufrechner die Miete.
// -------------------------------------------------------------

const express = require('express');
const path = require('path');
const { db, crypto, einstellung, einstellungSetzen, mitFehler } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const { googleEinstellungen, googleToken, gmail } = require('./google');
const { webpush, mitteilungSenden } = require('./push');
const rechner = require(path.join(__dirname, '..', '..', 'public', 'kaufrechner.js'));

const app = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS kaufangebote (
    id        TEXT PRIMARY KEY,
    art       TEXT NOT NULL,              -- kauf | miete
    inhalt    TEXT NOT NULL,              -- was in der Mail stand
    eigenes   TEXT,                       -- eigene Ergänzungen (Ist-Miete, Hausgeld, Notiz …)
    status    TEXT NOT NULL DEFAULT 'neu', -- neu | gemerkt | verworfen
    gefunden  INTEGER NOT NULL,
    mail      TEXT,
    gemeldet  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS kauf_mails (
    id    TEXT PRIMARY KEY,
    wann  INTEGER
  );
`);

const STATUS = ['neu', 'gemerkt', 'verworfen'];
const EIGENE_FELDER = ['titel', 'ort', 'typ', 'url', 'preis', 'flaeche', 'zimmer', 'miete', 'hausgeld', 'renovierung', 'makler', 'notiz'];

function annahmen() {
  let a = {};
  try { a = JSON.parse(einstellung('kauf_annahmen') || '{}'); } catch (e) { a = {}; }
  return rechner.annahmenMitStandard(a);
}

function zeileLesen(z) {
  let inhalt = {}, eigenes = {};
  try { inhalt = JSON.parse(z.inhalt); } catch (e) { /* leer */ }
  try { eigenes = JSON.parse(z.eigenes || '{}'); } catch (e) { /* leer */ }
  const a = Object.assign({}, inhalt);
  Object.keys(eigenes).forEach(function (k) {
    if (eigenes[k] !== '' && eigenes[k] !== null && eigenes[k] !== undefined) a[k] = eigenes[k];
  });
  a.id = z.id;
  a.art = z.art;
  a.status = z.status;
  a.gefunden = z.gefunden;
  a.mail = z.mail;
  a.eigenes = eigenes;
  a.original = inhalt;
  return a;
}

function alleLesen(art) {
  return db.prepare('SELECT * FROM kaufangebote WHERE art = ? ORDER BY gefunden DESC').all(art).map(zeileLesen);
}

// Textteil einer Gmail-Nachricht (format=full) heraussuchen
function textTeil(teil) {
  if (!teil) return '';
  if (teil.mimeType === 'text/plain' && teil.body && teil.body.data) {
    return Buffer.from(String(teil.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  for (const t of teil.parts || []) {
    const text = textTeil(t);
    if (text) return text;
  }
  return '';
}

function eigenesBereinigen(roh) {
  const e = {};
  EIGENE_FELDER.forEach(function (k) {
    if (!(k in (roh || {}))) return;
    const v = roh[k];
    if (k === 'url') e[k] = /^https?:\/\//i.test(String(v || '').trim()) ? String(v).trim().slice(0, 500) : '';   // nur echte Links
    else if (['titel', 'ort', 'notiz'].indexOf(k) !== -1) e[k] = String(v == null ? '' : v).slice(0, k === 'notiz' ? 2000 : 300);
    else if (k === 'typ') e[k] = v === 'haus' ? 'haus' : 'wohnung';
    else if (v === '' || v === null) e[k] = '';
    else { const z = rechner.zahl(v); e[k] = z === null ? '' : z; }
  });
  return e;
}

// ---------------- Postfach abgleichen ----------------
let laeuft = null;
let letzterAbgleich = 0;
let letzterFehler = null;

async function abgleichen() {
  if (laeuft) return laeuft;
  laeuft = (async function () {
    const token = await googleToken();
    const ids = [];
    let seite = '';
    do {
      const liste = await gmail(token, '/messages?maxResults=100&q='
        + encodeURIComponent('from:immobilienscout24.de newer_than:120d') + (seite ? '&pageToken=' + seite : ''));
      (liste.messages || []).forEach(function (m) { ids.push(m.id); });
      seite = liste.nextPageToken || '';
    } while (seite && ids.length < 400);

    const bekannt = db.prepare('SELECT 1 FROM kauf_mails WHERE id = ?');
    const offen = ids.filter(function (id) { return !bekannt.get(id); }).slice(0, 120);
    const neu = [];
    const eintragen = db.prepare('INSERT OR IGNORE INTO kaufangebote (id, art, inhalt, gefunden, mail) VALUES (?,?,?,?,?)');
    const erledigt = db.prepare('INSERT OR IGNORE INTO kauf_mails (id, wann) VALUES (?,?)');

    for (let i = 0; i < offen.length; i += 5) {
      const block = await Promise.all(offen.slice(i, i + 5).map(function (id) {
        return gmail(token, '/messages/' + encodeURIComponent(id) + '?format=full').catch(function () { return null; });
      }));
      block.forEach(function (mail) {
        if (!mail) return;
        const kopf = {};
        ((mail.payload && mail.payload.headers) || []).forEach(function (h) { kopf[h.name] = h.value; });
        const wann = Number(mail.internalDate) || Date.now();
        rechner.mailLesen(textTeil(mail.payload), kopf.Subject || '').forEach(function (a) {
          const r = eintragen.run(a.id, a.art, JSON.stringify(a), wann, mail.id);
          if (r.changes && a.art === 'kauf') neu.push(a.id);
        });
        erledigt.run(mail.id, Date.now());
      });
    }
    letzterAbgleich = Date.now();
    letzterFehler = null;
    return neu;
  })();
  try { return await laeuft; }
  catch (e) { letzterFehler = e.message; throw e; }
  finally { laeuft = null; }
}

function euro(x) { return Math.round(x).toLocaleString('de-DE') + ' €'; }

// Gute neue Angebote aufs Handy — nur frische (nicht beim ersten Einlesen alter Mails)
async function gutesMelden() {
  if (!webpush) return;
  const a = annahmen();
  const kauf = alleLesen('kauf');
  const miete = alleLesen('miete');
  const grenze = Date.now() - 2 * 86400000;
  const kandidaten = db.prepare("SELECT id FROM kaufangebote WHERE art = 'kauf' AND gemeldet = 0 AND status = 'neu' AND gefunden > ?")
    .all(grenze).map(function (z) { return z.id; });
  const merken = db.prepare('UPDATE kaufangebote SET gemeldet = 1 WHERE id = ?');
  const abos = db.prepare('SELECT * FROM push_abos').all();
  for (const id of kandidaten) {
    merken.run(id);
    const angebot = kauf.find(function (k) { return k.id === id; });
    if (!angebot || !abos.length) continue;
    const r = rechner.bewerten(angebot, a, miete, kauf);
    if (!r.vollstaendig || r.punkte < a.meldenAb) continue;
    await mitteilungSenden(abos, {
      titel: 'Kaufangebot: ' + r.punkte + ' Punkte',
      text: (angebot.titel || 'Angebot') + ' · ' + euro(angebot.preis) + ' · '
        + r.brutto.toFixed(1).replace('.', ',') + ' % Rendite · '
        + (r.cashflowNachSteuer >= 0 ? '+' : '') + euro(r.cashflowNachSteuer) + ' im Monat',
      url: '/?kaufen=1'
    });
  }
}

async function imHintergrund() {
  const g = googleEinstellungen();
  if (!g.clientId || !g.refresh) return;
  try { await abgleichen(); await gutesMelden(); }
  catch (e) { /* beim nächsten Mal */ }
}
setTimeout(imHintergrund, 60 * 1000).unref();
setInterval(imHintergrund, 30 * 60 * 1000).unref();

// ---------------- Schnittstellen ----------------
app.get('/api/kaufen', nurAngemeldet, mitFehler(async function (req, res) {
  const g = googleEinstellungen();
  const verbunden = !!(g.clientId && g.refresh);
  if (verbunden && (req.query.neu === '1' || Date.now() - letzterAbgleich > 10 * 60 * 1000)) {
    try { await abgleichen(); } catch (e) { /* steht in letzterFehler */ }
  }
  const miete = alleLesen('miete').map(function (m) {
    return { ort: m.ort, preis: m.preis, flaeche: m.flaeche, gefunden: m.gefunden };
  });
  res.json({
    annahmen: annahmen(),
    standard: rechner.STANDARD,
    verbunden: verbunden,
    abgleich: letzterAbgleich || null,
    fehler: letzterFehler,
    angebote: alleLesen('kauf'),
    miete: miete
  });
}));

app.put('/api/kaufen/annahmen', nurAngemeldet, nurVerwalter, function (req, res) {
  const roh = (req.body && req.body.annahmen) || {};
  const sauber = {};
  Object.keys(rechner.STANDARD).forEach(function (k) {
    const z = rechner.zahl(roh[k]);
    if (z !== null && z >= 0 && z <= 100000) sauber[k] = z;
  });
  einstellungSetzen('kauf_annahmen', JSON.stringify(sauber));
  res.json({ annahmen: annahmen() });
});

// Selbst eingetragenes Angebot: Felder oder eingefügter Text aus einem Exposé
app.post('/api/kaufen/angebote', nurAngemeldet, function (req, res) {
  const body = req.body || {};
  let felder = eigenesBereinigen(body);
  if (body.text) {
    const gelesen = eigenesBereinigen(rechner.freiLesen(body.text));
    Object.keys(gelesen).forEach(function (k) { if (felder[k] === undefined || felder[k] === '') felder[k] = gelesen[k]; });
  }
  if (!felder.preis) return res.status(400).json({ fehler: 'Ohne Kaufpreis lässt sich nichts rechnen' });
  const is24 = /immobilienscout24\.de\/expose\/(\d+)/.exec(felder.url || '');
  const id = is24 ? 'is24:' + is24[1] : 'eigen:' + crypto.randomBytes(5).toString('hex');
  const vorhanden = db.prepare('SELECT * FROM kaufangebote WHERE id = ?').get(id);
  if (vorhanden) {
    const alt = JSON.parse(vorhanden.eigenes || '{}');
    db.prepare("UPDATE kaufangebote SET eigenes = ?, status = 'gemerkt' WHERE id = ?")
      .run(JSON.stringify(Object.assign(alt, felder)), id);
  } else {
    const inhalt = {
      id: id, quelle: is24 ? 'ImmoScout24' : 'selbst eingetragen', art: 'kauf',
      typ: felder.typ || 'wohnung', titel: felder.titel || '', ort: felder.ort || '', url: felder.url || ''
    };
    db.prepare("INSERT INTO kaufangebote (id, art, inhalt, eigenes, status, gefunden, gemeldet) VALUES (?, 'kauf', ?, ?, 'gemerkt', ?, 1)")
      .run(id, JSON.stringify(inhalt), JSON.stringify(felder), Date.now());
  }
  res.json({ angebot: zeileLesen(db.prepare('SELECT * FROM kaufangebote WHERE id = ?').get(id)) });
});

app.put('/api/kaufen/angebote/:id', nurAngemeldet, function (req, res) {
  const z = db.prepare("SELECT * FROM kaufangebote WHERE id = ? AND art = 'kauf'").get(req.params.id);
  if (!z) return res.status(404).json({ fehler: 'Angebot nicht gefunden' });
  const body = req.body || {};
  if (body.status !== undefined) {
    if (STATUS.indexOf(body.status) === -1) return res.status(400).json({ fehler: 'Unbekannter Stand' });
    db.prepare('UPDATE kaufangebote SET status = ? WHERE id = ?').run(body.status, z.id);
  }
  if (body.eigenes) {
    const alt = JSON.parse(z.eigenes || '{}');
    db.prepare('UPDATE kaufangebote SET eigenes = ? WHERE id = ?')
      .run(JSON.stringify(Object.assign(alt, eigenesBereinigen(body.eigenes))), z.id);
  }
  res.json({ angebot: zeileLesen(db.prepare('SELECT * FROM kaufangebote WHERE id = ?').get(z.id)) });
});

app.delete('/api/kaufen/angebote/:id', nurAngemeldet, function (req, res) {
  db.prepare("DELETE FROM kaufangebote WHERE id = ? AND id LIKE 'eigen:%'").run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router: app, abgleichen, gutesMelden, textTeil };
