'use strict';

const express = require('express');
const { crypto, path, fs, DATENORDNER, db, holen, einstellung, einstellungSetzen } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');

const app = express.Router();

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

module.exports = { router: app, openaiModellFehlt };
