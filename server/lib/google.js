'use strict';

const express = require('express');
const { db, crypto, holen, htmlSicher, einstellung, einstellungSetzen, beiDatenAenderung } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');

const app = express.Router();

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
  if (!antwort.ok) {
    let grund = '';
    try { grund = ((await antwort.json()) || {}).error || ''; } catch (e) { /* egal */ }
    // invalid_grant: das dauerhafte Zugriffsrecht ist abgelaufen oder wurde zurückgezogen
    // (im Testmodus des Google-Projekts passiert das automatisch nach 7 Tagen)
    if (grund === 'invalid_grant') {
      throw new Error('Die Google-Verbindung ist abgelaufen — bitte unter Menü → Postfach trennen und neu verbinden');
    }
    throw new Error('Google lehnt das Zugriffsrecht ab (' + antwort.status + (grund ? ', ' + grund : '') + ')');
  }
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

// Suchbegriffe hängen an Mietern und Objekten — nach jedem Speichern neu holen
beiDatenAenderung(function () { postCache.clear(); });

module.exports = { router: app, googleEinstellungen, googleToken, gmail, MAIL_KOPF };
