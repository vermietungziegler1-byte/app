'use strict';

// Anhänge ablegen: finden, mit Drive abgleichen, einordnen (hier ohne Assistent, nach Regeln), Louis korrigiert,
// ablegen in Objekt › 02 Nebenkosten › Jahr (Jahresordner wird angelegt), danach beim Objekt mit Art und Jahr.
// Postfach und Google sind Attrappen.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { serverStarten, sitzung } = require('./hilfe');
const md5 = function (s) { return crypto.createHash('md5').update(Buffer.from(s)).digest('hex'); };

const ORDNER_TYP = 'application/vnd.google-apps.folder';

function fakeGoogle() {
  const g = { mitBearbeiten: false, ordner: [], dateien: [], hochgeladen: [], angelegt: [], neu: 0 };
  const server = http.createServer(function (req, res) {
    const stuecke = [];
    req.on('data', function (d) { stuecke.push(d); });
    req.on('end', function () {
      const koerper = Buffer.concat(stuecke);
      const url = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      const json = function (x, status) { res.statusCode = status || 200; res.end(JSON.stringify(x)); };
      if (req.method === 'POST' && url.pathname === '/token') {
        return json({ access_token: 'zugang', refresh_token: 'dauerhaft', expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly' + (g.mitBearbeiten ? ' https://www.googleapis.com/auth/drive' : '') });
      }
      if (url.pathname === '/gmail/v1/users/me/profile') return json({ emailAddress: 'louis@example.org' });
      if (req.headers.authorization !== 'Bearer zugang') return json({}, 401);
      if (url.pathname === '/drive/changes/startPageToken') return json({ startPageToken: '0' });
      if (url.pathname === '/drive/changes') return json({ changes: [], newStartPageToken: '0' });
      if (url.pathname === '/drive/files/root') return json({ id: 'wurzel' });
      if (url.pathname === '/drive/files' && req.method === 'GET') {
        // Wie Google: „'x' in parents“ und „name = '…'“ schränken ein (die App fragt so, bevor sie einen Ordner anlegt)
        const q = url.searchParams.get('q') || '';
        const nurOrdner = /mimeType = 'application\/vnd\.google-apps\.folder'/.test(q);
        const eltern = (/'([^']+)' in parents/.exec(q) || [])[1], name = (/name = '([^']+)'/.exec(q) || [])[1];
        return json({ files: (nurOrdner ? g.ordner : g.dateien).filter(function (x) {
          return (!eltern || x.parents[0] === eltern) && (!name || x.name === name);
        }) });
      }
      if (url.pathname === '/drive/files' && req.method === 'POST') {
        if (!g.mitBearbeiten) return json({ error: 'insufficientPermissions' }, 403);
        const b = JSON.parse(koerper.toString('utf8'));
        const o = { id: 'ordner' + (++g.neu), name: b.name, parents: b.parents, mimeType: ORDNER_TYP };
        g.ordner.push(o); g.angelegt.push(b.name + ' in ' + b.parents[0]);
        return json({ id: o.id, name: o.name });
      }
      if (url.pathname === '/upload/files' && req.method === 'POST') {
        if (!g.mitBearbeiten) return json({ error: 'insufficientPermissions' }, 403);
        const text = koerper.toString('latin1');
        const meta = JSON.parse(/\r\n\r\n(\{[^\r]*\})\r\n/.exec(text)[1]);
        const inhalt = text.split('\r\n\r\n')[2].split('\r\n--')[0];
        const d = { id: 'datei' + (++g.neu), name: meta.name, parents: meta.parents, mimeType: 'application/pdf', size: String(inhalt.length),
          webViewLink: 'https://drive.example/neu', modifiedTime: '2026-11-11T10:00:00Z' };
        g.hochgeladen.push({ name: meta.name, eltern: meta.parents[0], inhalt: inhalt });
        return json(d);
      }
      json({}, 404);
    });
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      g.basis = 'http://127.0.0.1:' + server.address().port;
      g.stoppen = function () { server.close(); };
      ok(g);
    });
  });
}
const warten = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function fertig(s, pfad) {
  for (let i = 0; i < 80; i++) {
    const st = (await s.get(pfad)).json;
    if (st && !st.laeuft && st.zuletzt) return st;
    await warten(100);
  }
  throw new Error('nicht fertig: ' + pfad);
}
async function verbinden(louis) {
  const ziel = new URL((await louis.get('/api/google/start')).kopf.get('location'));
  assert.equal((await louis.get('/api/google/zurueck?code=c&state=' + ziel.searchParams.get('state'))).status, 200);
}

test('Anhänge: finden, einordnen, korrigieren, in Objekt › 02 Nebenkosten › 2025 ablegen', async function () {
  const g = await fakeGoogle();
  g.ordner.push({ id: 'firma', name: 'Firma', parents: ['wurzel'], mimeType: ORDNER_TYP });
  g.ordner.push({ id: 'tri', name: 'Tribergle', parents: ['firma'], mimeType: ORDNER_TYP });
  g.ordner.push({ id: 'nk', name: '02 Nebenkosten', parents: ['tri'], mimeType: ORDNER_TYP });
  g.dateien.push({ id: 'alt1', name: 'Nebenkostenabrechnung 2023.pdf', parents: ['nk'], mimeType: 'application/pdf', size: '5000',
    modifiedTime: '2024-01-01T00:00:00Z', webViewLink: 'https://drive.example/alt1' });
  g.dateien.push({ id: 'alt2', name: 'Stromrechnung 2024 Tribergle.pdf', parents: ['nk'], mimeType: 'application/pdf', size: '10000',
    modifiedTime: '2025-01-01T00:00:00Z', webViewLink: 'https://drive.example/alt2', md5Checksum: md5('Strom 2024') });

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'anhaenge-'));
  const datei = path.join(ordner, 'mails.json');
  fs.writeFileSync(datei, JSON.stringify({ mails: [
    { ordner: 'INBOX', uid: 1, datum: Date.parse('2026-03-03T09:00:00Z'), von_name: 'Stadtwerke', von_adresse: 'info@stadtwerke.example',
      betreff: 'Stromabrechnung 2025 Tribergle 22', text: 'Anbei die Abrechnung für den Allgemeinstrom.',
      anhaenge: [{ name: 'Rechnung_Strom.pdf', typ: 'application/pdf', groesse: 50000, inhalt: '%PDF Strom' },
                 { name: 'image001.png', typ: 'image/png', groesse: 4000, inline: true }] },
    { ordner: 'INBOX', uid: 2, datum: Date.parse('2026-02-01T09:00:00Z'), von_name: 'Shop', von_adresse: 'news@shop.example',
      betreff: 'Unser Newsletter', text: 'Neue Angebote für Sie', anhaenge: [{ name: 'Gutschein.pdf', typ: 'application/pdf', groesse: 30000 }] },
    { ordner: 'INBOX', uid: 3, datum: Date.parse('2025-01-05T09:00:00Z'), von_name: 'Stadtwerke', von_adresse: 'info@stadtwerke.example',
      betreff: 'Stromrechnung 2024', text: '', anhaenge: [{ name: 'SR_2024.pdf', typ: 'application/pdf', groesse: 13700, inhalt: 'Strom 2024' }] },
    // Zwei Anhänge mit demselben Namen in einer Mail: jeder Teil für sich
    { ordner: 'INBOX', uid: 4, datum: Date.parse('2026-04-10T09:00:00Z'), von_name: 'Gemeinde', von_adresse: 'kasse@gemeinde.example',
      betreff: 'Rechnungen Tribergle 22', text: '', anhaenge: [{ name: 'Rechnung.pdf', typ: 'application/pdf', groesse: 40000, inhalt: '%PDF Wasser' },
        { name: 'Rechnung.pdf', typ: 'application/pdf', groesse: 41000, inhalt: '%PDF Muell' }] }
  ] }));

  const server = await serverStarten({ GOOGLE_TOKEN_URL: g.basis + '/token', GMAIL_BASIS: g.basis, GDRIVE_BASIS: g.basis + '/drive',
    GDRIVE_UPLOAD_BASIS: g.basis + '/upload', ADRESSE: 'https://app.example',
    ANHANG_TESTQUELLE: path.join(__dirname, 'attrappe-postfach.js'), ANHANG_TESTDATEN: datei });
  try {
    const louis = sitzung(server), papa = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
    await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });
    await louis.put('/api/data', { data: { objects: [
      { id: 't', name: 'Tribergle 22, 71409 Schwaikheim', units: [{ id: 'teg', name: 'EG Wohnung', tenant: 'Louis Ziegler', status: 'vermietet' }] }
    ], interessenten: [] } });
    await louis.put('/api/google', { clientId: 'app-id', clientSecret: 'geheim' });
    await verbinden(louis);
    assert.equal((await louis.get('/api/dokumente/ordner')).status, 200);
    assert.equal((await louis.put('/api/dokumente/ordner', { ein: ['firma'] })).status, 200);
    await warten(150);
    await fertig(louis, '/api/dokumente');

    // Nur für den Verwalter
    assert.equal((await papa.get('/api/anhaenge')).status, 403);

    await louis.post('/api/anhaenge/abgleich');
    await warten(100);
    let r = await fertig(louis, '/api/anhaenge');
    assert.equal(r.fehler, null);
    assert.equal(r.liste.length, 3, 'Logo, Newsletter und schon abgelegte Rechnung fallen weg: ' + JSON.stringify(r.liste.map(function (z) { return z.name; })));
    assert.equal(r.zahlen.in_drive, 1, 'gleiche Prüfsumme wie eine Datei in Drive — auch unter anderem Namen');
    let a = r.liste.find(function (z) { return z.name === 'Rechnung_Strom.pdf'; });
    assert.equal(a.name, 'Rechnung_Strom.pdf');
    assert.equal(a.objekt, 't', 'Objekt aus dem Betreff');
    assert.equal(a.art, 'Rechnung');
    assert.equal(a.jahr, '2026');
    assert.equal(a.ziel, '/Firma/Tribergle/03 Rechnungen/2026');
    assert.deepEqual(a.zielNeu, ['03 Rechnungen', '2026']);

    // Louis: das ist eine Nebenkosten-Rechnung (Allgemeinstrom) für 2025
    const k = await louis.put('/api/anhaenge/' + encodeURIComponent(a.id), { art: 'Nebenkosten-Rechnung', kostenart: 'Allgemeinstrom', jahr: '2025',
      dateiname: '2026-03-03 Stromabrechnung 2025 Allgemeinstrom' });
    assert.equal(k.status, 200, k.text);
    r = (await louis.get('/api/anhaenge')).json;
    a = r.liste.find(function (z) { return z.id === a.id; });
    assert.equal(a.ziel, '/Firma/Tribergle/02 Nebenkosten/2025', 'vorhandener Ordner „02 Nebenkosten“, Jahresordner neu');
    assert.deepEqual(a.zielNeu, ['2025']);
    assert.equal(a.dateiname, '2026-03-03 Stromabrechnung 2025 Allgemeinstrom.pdf', 'Endung kommt dazu');

    // Ohne Bearbeiten-Recht wird nichts abgelegt
    assert.equal((await louis.post('/api/anhaenge/ablegen', { ids: [a.id] })).status, 409);
    assert.equal(g.hochgeladen.length, 0);

    g.mitBearbeiten = true;
    const ziel = new URL((await louis.get('/api/google/start?bearbeiten=1')).kopf.get('location'));
    assert.equal((await louis.get('/api/google/zurueck?code=c&state=' + ziel.searchParams.get('state'))).status, 200);
    const ab = await louis.post('/api/anhaenge/ablegen', { ids: [a.id] });
    assert.equal(ab.status, 200, ab.text);
    assert.equal(ab.json.ergebnisse[0].ok, true, JSON.stringify(ab.json));
    assert.deepEqual(g.angelegt, ['2025 in nk']);
    assert.equal(g.hochgeladen.length, 1);
    assert.equal(g.hochgeladen[0].name, '2026-03-03 Stromabrechnung 2025 Allgemeinstrom.pdf');
    assert.equal(g.hochgeladen[0].inhalt, '%PDF Strom');

    // Beim Objekt: Nebenkosten-Rechnung 2025 mit Kostenart
    const dateien = (await louis.get('/api/dokumente/dateien')).json.dateien;
    const neu = dateien.find(function (d) { return d.name === '2026-03-03 Stromabrechnung 2025 Allgemeinstrom.pdf'; });
    assert.ok(neu, 'in der Dokumentliste');
    assert.equal(neu.objekt, 't');
    assert.equal(neu.art, 'Nebenkosten-Rechnung');
    assert.equal(neu.jahr, '2025');
    assert.equal(neu.kostenart, 'Allgemeinstrom');
    assert.equal(neu.pfad, '/Firma/Tribergle/02 Nebenkosten/2025');
    // Ältere Datei im Nebenkosten-Ordner: Jahr aus dem Namen
    assert.equal(dateien.find(function (d) { return d.id === 'alt1'; }).jahr, '2023');

    // Schon abgelegt: Ändern geht nicht mehr (sonst würde er wieder angeboten)
    assert.equal((await louis.put('/api/anhaenge/' + encodeURIComponent(a.id), { jahr: '2024' })).status, 409);
    assert.equal((await louis.post('/api/anhaenge/ablegen', { ids: [a.id] })).json.ergebnisse[0].ok, false, 'kein zweites Mal');

    // Die zwei gleichnamigen Rechnungen: jede mit ihrem Inhalt; „03 Rechnungen“ und „2026“ werden einmal angelegt
    r = (await louis.get('/api/anhaenge')).json;
    const zwei = r.liste.filter(function (z) { return z.name === 'Rechnung.pdf'; });
    assert.equal(zwei.length, 2);
    const ab2 = await louis.post('/api/anhaenge/ablegen', { ids: zwei.map(function (z) { return z.id; }) });
    assert.ok(ab2.json.ergebnisse.every(function (e) { return e.ok; }), JSON.stringify(ab2.json));
    assert.deepEqual(g.hochgeladen.slice(1).map(function (h) { return h.inhalt; }).sort(), ['%PDF Muell', '%PDF Wasser']);
    assert.equal(g.angelegt.length, 3, JSON.stringify(g.angelegt));
    assert.equal(g.angelegt[1].indexOf('03 Rechnungen in tri'), 0);
    assert.equal(g.angelegt[2].indexOf('2026 in '), 0);
    const namenHochgeladen = g.hochgeladen.slice(1).map(function (h) { return h.name; });
    assert.notEqual(namenHochgeladen[0], namenHochgeladen[1], 'gleicher Name im Ordner bekommt eine Nummer');

    r = (await louis.get('/api/anhaenge')).json;
    assert.equal(r.liste.length, 0);
    assert.equal(r.zahlen.abgelegt, 3);
  } finally {
    await server.stoppen();
    g.stoppen();
    fs.rmSync(ordner, { recursive: true, force: true });
  }
});
