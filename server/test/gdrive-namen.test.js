'use strict';

// Namen aufräumen: Vorschläge, Schalter „Umbenennen erlauben“ (Bearbeiten-Recht von Google), Umbenennen nur auf Bestätigung,
// Rückgängig, Recht zurückgeben. Google (Anmeldung, Widerruf, Drive) ist eine kleine Attrappe.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { serverStarten, sitzung } = require('./hilfe');

const ORDNER_TYP = 'application/vnd.google-apps.folder';

function fakeGoogle() {
  const g = { mitBearbeiten: false, ordner: [], dateien: [], aenderungen: [], umbenannt: [], widerrufen: [] };
  g.ordnerNeu = function (id, name, eltern) { g.ordner.push({ id: id, name: name, parents: [eltern], mimeType: ORDNER_TYP }); };
  g.dateiNeu = function (id, name, eltern, mime, zeit) {
    const d = { id: id, name: name, parents: [eltern], mimeType: mime || 'application/pdf', size: '2048', modifiedTime: '2026-08-27T06:23:00Z',
      webViewLink: 'https://drive.example/' + id };
    if (zeit) d.imageMediaMetadata = { time: zeit };
    g.dateien.push(d);
  };
  const server = http.createServer(function (req, res) {
    let koerper = '';
    req.on('data', function (d) { koerper += d; });
    req.on('end', function () {
      const url = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      const json = function (x, status) { res.statusCode = status || 200; res.end(JSON.stringify(x)); };
      if (req.method === 'POST' && url.pathname === '/token') {
        const scope = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly'
          + (g.mitBearbeiten ? ' https://www.googleapis.com/auth/drive' : '');
        return json({ access_token: 'zugang', refresh_token: 'dauerhaft', expires_in: 3600, scope: scope });
      }
      if (req.method === 'POST' && url.pathname === '/revoke') { g.widerrufen.push(new URLSearchParams(koerper).get('token')); return json({}); }
      if (url.pathname === '/gmail/v1/users/me/profile') return json({ emailAddress: 'louis@example.org' });
      if (url.pathname.indexOf('/drive/') === 0) {
        if (req.headers.authorization !== 'Bearer zugang') return json({ error: 'unauthorized' }, 401);
        const p = url.pathname.slice('/drive'.length);
        if (p === '/changes/startPageToken') return json({ startPageToken: String(g.aenderungen.length) });
        if (p === '/files/root') return json({ id: 'wurzel' });
        if (p === '/files') {
          const nurOrdner = /mimeType = 'application\/vnd\.google-apps\.folder'/.test(url.searchParams.get('q') || '');
          return json({ files: nurOrdner ? g.ordner : g.dateien });
        }
        if (p === '/changes') {
          const ab = Number(url.searchParams.get('pageToken'));
          return json({ changes: g.aenderungen.slice(ab), newStartPageToken: String(g.aenderungen.length) });
        }
        const m = /^\/files\/([^/]+)$/.exec(p);
        if (m && req.method === 'PATCH') {
          if (!g.mitBearbeiten) return json({ error: { message: 'insufficientPermissions' } }, 403);
          const d = g.dateien.find(function (x) { return x.id === decodeURIComponent(m[1]); });
          if (!d) return json({}, 404);
          d.name = JSON.parse(koerper).name;
          g.umbenannt.push(d.id + '=' + d.name);
          g.aenderungen.push({ fileId: d.id, removed: false, file: d });
          return json({ id: d.id, name: d.name });
        }
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
async function fertig(s) {
  for (let i = 0; i < 60; i++) {
    const st = (await s.get('/api/dokumente')).json;
    if (!st.laeuft && st.zuletzt) return st;
    await warten(100);
  }
  throw new Error('Abgleich wurde nicht fertig');
}
async function verbinden(louis, mitBearbeiten) {
  const start = await louis.get('/api/google/start' + (mitBearbeiten ? '?bearbeiten=1' : ''));
  const ziel = new URL(start.kopf.get('location'));
  const zurueck = await louis.get('/api/google/zurueck?code=c&state=' + ziel.searchParams.get('state'));
  assert.equal(zurueck.status, 200, zurueck.text);
  return ziel;
}

test('Namen aufräumen: vorschlagen, Schalter, umbenennen, rückgängig, Recht zurückgeben', async function () {
  const g = await fakeGoogle();
  g.ordnerNeu('firma', 'Firma', 'wurzel');
  g.ordnerNeu('bertha', 'Bertha von Suttna', 'firma');
  g.dateiNeu('foto1', 'IMG_3654.HEIC', 'bertha', 'image/heif', '2025:06:14 12:35:10');
  g.dateiNeu('foto2', 'IMG_3655.HEIC', 'bertha', 'image/heif', '2025:06:14 12:40:02');
  g.dateiNeu('foto3', 'IMG_3656.HEIC', 'bertha', 'image/heif', '2025:06:14 12:40:41');   // dieselbe Minute wie foto2
  g.dateiNeu('nach', '202605111257_nachmontage_zusammenfassung.pdf', 'bertha');
  g.dateiNeu('grok', 'Test Grok .xlsx', 'bertha', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  g.dateiNeu('l1', 'Liste (1).xlsx', 'bertha', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  g.dateiNeu('l2', 'Liste (2).xlsx', 'bertha', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  g.dateiNeu('gut', 'Mietvertrag Kirschner.pdf', 'bertha');

  const server = await serverStarten({ GOOGLE_TOKEN_URL: g.basis + '/token', GOOGLE_REVOKE_URL: g.basis + '/revoke', GMAIL_BASIS: g.basis,
    GDRIVE_BASIS: g.basis + '/drive', ADRESSE: 'https://app.example' });
  try {
    const louis = sitzung(server), papa = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
    await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });
    await louis.put('/api/data', { data: { objects: [
      { id: 'o1', name: 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen', units: [{ id: 'u1', name: 'EG Links', tenant: 'Marlene Kirschner', status: 'vermietet' }] }
    ], interessenten: [] } });
    await louis.put('/api/google', { clientId: 'app-id', clientSecret: 'geheim' });

    // Verbinden nur zum Lesen; der Zugang liegt verschlüsselt in der Datenbank
    const ziel = await verbinden(louis, false);
    assert.doesNotMatch(ziel.searchParams.get('scope'), /auth\/drive(\s|$)/, 'ohne Schalter kein Bearbeiten-Recht');
    const db = new Database(path.join(server.daten, 'vermietung.db'));
    const roh = db.prepare("SELECT wert FROM einstellungen WHERE schluessel = 'google_refresh'").get().wert;
    db.close();
    assert.match(roh, /^v1:/, 'Google-Zugang verschlüsselt');
    assert.doesNotMatch(roh, /dauerhaft/);

    assert.equal((await louis.get('/api/dokumente/ordner')).status, 200);   // wie in der App: erst die Ordnerliste
    assert.equal((await louis.put('/api/dokumente/ordner', { ein: ['firma'] })).status, 200);
    await warten(150);
    await fertig(louis);

    // Vorschläge: nur für den Verwalter
    assert.equal((await papa.get('/api/dokumente/namen')).status, 403);
    let n = (await louis.get('/api/dokumente/namen')).json;
    assert.equal(n.bearbeiten, false);
    const nach = {};
    n.liste.forEach(function (z) { nach[z.id] = z; });
    assert.equal(nach.foto1.vorschlag, '2025-06-14 Foto Bertha-von-Suttner-Weg 4 12-35.heic', 'gleicher Tag, gleicher Ort: Uhrzeit hält sie auseinander');
    assert.equal(nach.foto2.vorschlag, '2025-06-14 Foto Bertha-von-Suttner-Weg 4 12-40-02.heic', 'dieselbe Minute: dann die Sekunden');
    assert.equal(nach.foto3.vorschlag, '2025-06-14 Foto Bertha-von-Suttner-Weg 4 12-40-41.heic');
    assert.equal(nach.foto1.grund, 'Handyfoto');
    assert.equal(nach.nach.vorschlag, '2026-05-11 Nachmontage zusammenfassung.pdf');
    assert.equal(nach.grok.vorschlag, 'Test Grok.xlsx');
    assert.equal(nach.l1.grund, 'doppelt'); assert.equal(nach.l1.vorschlag, '');
    assert.equal(nach.l2.grund, 'doppelt');
    assert.equal(nach.gut, undefined, 'gut benannte Dateien stehen nicht in der Liste');

    // Ohne Schalter wird nichts umbenannt
    assert.equal((await louis.put('/api/dokumente/namen', { dateien: [{ id: 'grok', name: 'Test Grok.xlsx' }] })).status, 409);
    assert.equal(g.umbenannt.length, 0);

    // Schalter an: Google fragt nach dem Bearbeiten-Recht
    g.mitBearbeiten = true;
    const ziel2 = await verbinden(louis, true);
    assert.match(ziel2.searchParams.get('scope'), /https:\/\/www\.googleapis\.com\/auth\/drive(\s|$)/);
    assert.equal((await louis.get('/api/dokumente')).json.bearbeiten, true);

    assert.equal((await papa.put('/api/dokumente/namen', { dateien: [{ id: 'grok', name: 'x.xlsx' }] })).status, 403);
    const r = await louis.put('/api/dokumente/namen', { stapel: 's1', dateien: [
      { id: 'foto1', name: nach.foto1.vorschlag },
      { id: 'nach', name: '2026-05-11 Nachmontage Zusammenfassung.pdf' },
      { id: 'grok', name: 'Test Grok' },                         // Endung vergessen: kommt von selbst dazu
      { id: 'gibtsnicht', name: 'x.pdf' }
    ] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.umbenannt, 3);
    assert.equal(r.json.fehler.length, 1);
    assert.deepEqual(g.umbenannt.sort(), ['foto1=2025-06-14 Foto Bertha-von-Suttner-Weg 4 12-35.heic', 'grok=Test Grok.xlsx',
      'nach=2026-05-11 Nachmontage Zusammenfassung.pdf']);
    assert.equal(r.json.letzte.anzahl, 3);

    // Die Zuordnung bleibt, auch nachdem Google die Änderung meldet
    await louis.post('/api/dokumente/abgleich');
    await warten(50);
    await fertig(louis);
    let dateien = (await louis.get('/api/dokumente/dateien')).json.dateien;
    const f1 = dateien.find(function (d) { return d.id === 'foto1'; });
    assert.equal(f1.name, '2025-06-14 Foto Bertha-von-Suttner-Weg 4 12-35.heic');
    assert.equal(f1.objekt, 'o1');
    assert.equal(f1.status, 'zugeordnet');
    n = (await louis.get('/api/dokumente/namen')).json;
    assert.ok(!n.liste.some(function (z) { return z.id === 'grok' || z.id === 'foto1'; }), 'Umbenanntes steht nicht mehr in der Liste');

    // Rückgängig
    const zurueck = await louis.post('/api/dokumente/namen/rueckgaengig', { stapel: 's1' });
    assert.equal(zurueck.status, 200, zurueck.text);
    assert.equal(zurueck.json.rest, 0);
    assert.equal(g.dateien.find(function (d) { return d.id === 'grok'; }).name, 'Test Grok .xlsx');
    dateien = (await louis.get('/api/dokumente/dateien')).json.dateien;
    assert.equal(dateien.find(function (d) { return d.id === 'nach'; }).name, '202605111257_nachmontage_zusammenfassung.pdf');

    // Schalter aus: Recht bei Google zurückgegeben, die App liest erst nach dem neuen Verbinden wieder
    assert.equal((await papa.post('/api/dokumente/bearbeiten/aus')).status, 403);
    assert.equal((await louis.post('/api/dokumente/bearbeiten/aus')).status, 200);
    assert.deepEqual(g.widerrufen, ['dauerhaft']);
    const s = (await louis.get('/api/dokumente')).json;
    assert.equal(s.google, false);
    assert.equal(s.bearbeiten, false);
    assert.equal((await louis.get('/api/google')).json.getrennt, true, 'die App zeigt an, dass Google getrennt ist');
    assert.equal((await louis.get('/api/dokumente/namen')).json.google, false);
    g.mitBearbeiten = false;
    await verbinden(louis, false);
    const s2 = (await louis.get('/api/dokumente')).json;
    assert.equal(s2.recht, true);
    assert.equal(s2.bearbeiten, false);
    assert.equal((await louis.get('/api/google')).json.getrennt, false);
  } finally {
    await server.stoppen();
    g.stoppen();
  }
});
