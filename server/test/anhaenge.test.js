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
        // Wie Google: ein Dateityp ohne „/“ (manche Mails sagen nur „pdf“) wird abgelehnt
        const typ = (text.match(/Content-Type: ([^\r]*)\r\n/g) || [])[1].replace(/^Content-Type: |\r\n$/g, '');
        if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(typ)) return json({ error: { code: 400, message: "Media type '" + typ + "' is not supported. Valid media types: [*/*]" } }, 400);
        const d = { id: 'datei' + (++g.neu), name: meta.name, parents: meta.parents, mimeType: typ, size: String(inhalt.length),
          webViewLink: 'https://drive.example/neu', modifiedTime: '2026-11-11T10:00:00Z' };
        g.hochgeladen.push({ name: meta.name, eltern: meta.parents[0], inhalt: inhalt, typ: typ });
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
        // Manche Absender schreiben als Dateityp nur „pdf“ — Google würde das ablehnen
        { name: 'Rechnung.pdf', typ: 'pdf', groesse: 41000, inhalt: '%PDF Muell' }] },
    // Dieselbe Stromabrechnung noch einmal, weitergeleitet (älter als uid 1): wird nur einmal angeboten
    { ordner: 'INBOX', uid: 6, datum: Date.parse('2026-02-20T09:00:00Z'), von_name: 'Michael Ziegler', von_adresse: 'michael@familie.example',
      betreff: 'Fwd: Stromabrechnung 2025 Tribergle 22', text: 'Siehe Anhang', anhaenge: [{ name: 'Rechnung_Strom.pdf', typ: 'application/pdf', groesse: 50000, inhalt: '%PDF Strom' }] }
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
    assert.equal(r.zahlen.doppelt, 1, 'die weitergeleitete Stromabrechnung ist derselbe Anhang wie in uid 1');
    assert.equal(r.liste.filter(function (z) { return z.name === 'Rechnung_Strom.pdf'; }).length, 1);
    let a = r.liste.find(function (z) { return z.name === 'Rechnung_Strom.pdf'; });
    assert.equal(a.name, 'Rechnung_Strom.pdf');
    assert.equal(a.objekt, 't', 'Objekt aus dem Betreff');
    assert.equal(a.art, 'Rechnung');
    assert.equal(a.jahr, '2026');
    assert.equal(a.ziel, '/Firma/Tribergle/03 Rechnungen/2026');
    assert.deepEqual(a.zielNeu, ['03 Rechnungen', '2026']);

    // Ansehen: ein PDF geht im Browser auf, ohne es erst speichern zu müssen; ohne „ansehen“ bleibt es ein Download
    const pfadDatei = '/api/anhaenge/' + encodeURIComponent(a.id) + '/datei';
    let d = await louis.get(pfadDatei + '?ansehen=1');
    assert.equal(d.status, 200);
    assert.equal(d.text, '%PDF Strom');
    assert.equal(d.kopf.get('content-type'), 'application/pdf');
    assert.equal(d.kopf.get('content-disposition'), "inline; filename*=UTF-8''Rechnung_Strom.pdf");
    assert.equal(d.kopf.get('x-content-type-options'), 'nosniff');
    assert.match(d.kopf.get('content-security-policy'), /object-src 'self'/, 'sonst zeigt Chrome das PDF nicht');
    assert.doesNotMatch(d.kopf.get('content-security-policy'), /sandbox/);
    d = await louis.get(pfadDatei);
    assert.equal(d.kopf.get('content-type'), 'application/octet-stream');
    assert.match(d.kopf.get('content-disposition'), /^attachment; /);
    assert.equal((await papa.get(pfadDatei + '?ansehen=1')).status, 403);
    // Ein Inhaltsverzeichnis gibt es nur für ZIP-Dateien
    d = await louis.get(pfadDatei + '?zip=1');
    assert.equal(d.status, 422);
    assert.match(d.json.fehler, /keine ZIP/);

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

    // Die zwei gleichnamigen Rechnungen mit verschiedenem Inhalt: die erste wird abgelegt, die zweite nicht still als
    // „… 2.pdf“ — Louis soll sie ansehen. Der freie Name steht dann als Vorschlag da; beim zweiten Ablegen geht sie durch.
    r = (await louis.get('/api/anhaenge')).json;
    const zwei = r.liste.filter(function (z) { return z.name === 'Rechnung.pdf'; });
    assert.equal(zwei.length, 2);
    assert.equal(zwei[0].dateiname, zwei[1].dateiname, 'beide bekommen denselben Namen vorgeschlagen');
    const ab2 = await louis.post('/api/anhaenge/ablegen', { ids: zwei.map(function (z) { return z.id; }) });
    assert.equal(ab2.json.ergebnisse[0].ok, true, JSON.stringify(ab2.json));
    assert.equal(ab2.json.ergebnisse[1].ok, false);
    assert.match(ab2.json.ergebnisse[1].fehler, /Im Ordner liegt schon „.+“, aber mit anderem Inhalt — bitte ansehen/);
    assert.equal(g.hochgeladen.length, 2, 'die zweite ist noch nicht hochgeladen');
    r = (await louis.get('/api/anhaenge')).json;
    const offen = r.liste.find(function (z) { return z.id === zwei[1].id; });
    assert.equal(offen.dateiname, zwei[1].dateiname.replace(/\.pdf$/, ' 2.pdf'), 'freier Name als Vorschlag');
    assert.equal(offen.sicherheit, 'niedrig', 'gilt als unsicher und ist damit nicht von selbst angehakt');
    assert.match(offen.fehler, /bitte ansehen/);
    const ab3 = await louis.post('/api/anhaenge/ablegen', { ids: [zwei[1].id] });
    assert.equal(ab3.json.ergebnisse[0].ok, true, JSON.stringify(ab3.json));
    assert.deepEqual(g.hochgeladen.slice(1).map(function (h) { return h.inhalt; }).sort(), ['%PDF Muell', '%PDF Wasser']);
    assert.deepEqual(g.hochgeladen.map(function (h) { return h.typ; }), ['application/pdf', 'application/pdf', 'application/pdf'], 'Dateityp „pdf“ als application/pdf hochgeladen');
    assert.equal(g.angelegt.length, 3, JSON.stringify(g.angelegt));
    assert.equal(g.angelegt[1].indexOf('03 Rechnungen in tri'), 0);
    assert.equal(g.angelegt[2].indexOf('2026 in '), 0);
    const namenHochgeladen = g.hochgeladen.slice(1).map(function (h) { return h.name; });
    assert.notEqual(namenHochgeladen[0], namenHochgeladen[1], 'gleicher Name im Ordner bekommt eine Nummer');

    r = (await louis.get('/api/anhaenge')).json;
    assert.equal(r.liste.length, 0);
    assert.equal(r.zahlen.abgelegt, 3);

    // Steht ein Anhang zum Ablegen an, dessen Inhalt inzwischen schon in Drive liegt (hier: die Stromabrechnung,
    // die eben abgelegt wurde): nicht noch einmal hochladen, sondern als „lag schon in Drive“ abhaken
    const Database = require('better-sqlite3');
    const roh = new Database(path.join(server.daten, 'vermietung.db'));
    roh.prepare(`INSERT INTO anh_dateien (id, ordner, uid, uidvalidity, teil, nr, datum, von, betreff, mailtext, name, typ, groesse, status, objekt, art, jahr, dateiname, erstellt)
      VALUES ('kopie', 'INBOX', 1, '', '2', 0, ?, 'Stadtwerke', 'Kopie', '', 'Rechnung_Strom.pdf', 'application/pdf', 50000, 'vorschlag', 't', 'Rechnung', '2026',
      'Ganz anderer Name.pdf', ?)`).run(Date.now(), Date.now());
    roh.close();
    const hochVorher = g.hochgeladen.length;
    const ab4 = await louis.post('/api/anhaenge/ablegen', { ids: ['kopie'] });
    assert.equal(ab4.json.ergebnisse[0].ok, true, JSON.stringify(ab4.json));
    assert.equal(ab4.json.ergebnisse[0].schonDa, true);
    assert.equal(ab4.json.ergebnisse[0].name, '2026-03-03 Stromabrechnung 2025 Allgemeinstrom.pdf', 'die vorhandene Datei wird genannt');
    assert.equal(g.hochgeladen.length, hochVorher, 'nichts doppelt hochgeladen');
    assert.equal((await louis.get('/api/anhaenge')).json.zahlen.in_drive, 2);
  } finally {
    await server.stoppen();
    g.stoppen();
    fs.rmSync(ordner, { recursive: true, force: true });
  }
});

test('Anhang ansehen: nur echte PDFs und Fotos gehen im Browser auf, getarnte Dateien werden heruntergeladen', function () {
  const { anzeigeTyp, anhangSenden } = require('../lib/anhang-senden');
  assert.equal(anzeigeTyp(Buffer.from('%PDF-1.7\n1 0 obj')), 'application/pdf');
  assert.equal(anzeigeTyp(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR')])), 'image/png');
  assert.equal(anzeigeTyp(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'image/jpeg');
  assert.equal(anzeigeTyp(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(anzeigeTyp(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
  // Was sich nur „rechnung.pdf“ nennt, aber eine Seite oder ein Bild mit Skript ist, öffnet der Browser nie
  assert.equal(anzeigeTyp(Buffer.from('<html><script>fetch("/api/data")</script></html>')), null);
  assert.equal(anzeigeTyp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')), null);
  assert.equal(anzeigeTyp(Buffer.from('PK\x03\x04 word/document.xml', 'latin1')), null, 'Word-Datei: Download');
  assert.equal(anzeigeTyp(Buffer.alloc(0)), null);

  const kopf = {};
  let gesendet = null;
  const res = { setHeader: function (k, v) { kopf[k.toLowerCase()] = v; }, end: function (b) { gesendet = b; } };
  anhangSenden(res, Buffer.from('<html><script>alert(1)</script>'), 'rechnung.pdf', true);
  assert.equal(kopf['content-type'], 'application/octet-stream');
  assert.equal(kopf['content-disposition'], "attachment; filename*=UTF-8''rechnung.pdf");
  assert.equal(kopf['x-content-type-options'], 'nosniff');
  assert.equal(kopf['content-security-policy'], undefined);
  assert.equal(gesendet.toString(), '<html><script>alert(1)</script>');
});
