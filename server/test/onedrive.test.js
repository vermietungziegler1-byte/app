'use strict';

// OneDrive: anmelden über Microsoft, Dateien abgleichen, automatisch zuordnen, korrigieren und lernen.
// Microsoft (Anmeldung und Graph) ist eine kleine Attrappe.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { serverStarten, sitzung } = require('./hilfe');

function fakeMicrosoft(dateien) {
  const abrufe = [];
  const server = http.createServer(function (req, res) {
    let koerper = '';
    req.on('data', function (d) { koerper += d; });
    req.on('end', function () {
      abrufe.push(req.method + ' ' + req.url);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/login/token') {
        return res.end(JSON.stringify({ access_token: 'zugang', refresh_token: 'dauerhaft-' + abrufe.length, expires_in: 3600 }));
      }
      if (req.url.indexOf('/graph/me/drive/root/delta') === 0 || req.url.indexOf('/graph/delta-weiter') === 0) {
        if (req.headers.authorization !== 'Bearer zugang') { res.statusCode = 401; return res.end('{}'); }
        const basis = 'http://127.0.0.1:' + server.address().port;
        return res.end(JSON.stringify({ value: dateien, '@odata.deltaLink': basis + '/graph/delta-weiter' }));
      }
      if (req.url.indexOf('/graph/me') === 0) return res.end(JSON.stringify({ mail: 'louis@example.org' }));
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      const basis = 'http://127.0.0.1:' + server.address().port;
      ok({ basis: basis, abrufe: abrufe, stoppen: function () { server.close(); } });
    });
  });
}

const datei = function (id, pfad, name) {
  return { id: id, name: name, file: { mimeType: 'application/pdf' }, size: 1000, lastModifiedDateTime: '2026-11-01T10:00:00Z',
    webUrl: 'https://onedrive.example/' + id, parentReference: { path: '/drive/root:' + pfad } };
};
const warten = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

test('OneDrive: anmelden, abgleichen, zuordnen, lernen', async function () {
  const ms = await fakeMicrosoft([
    datei('a', '/Scans', 'Mietvertrag Kirschner.pdf'),                 // Mietername → Wohnung
    datei('b', '/Hausakten/Dahlienweg', 'Grundriss.pdf'),              // Objekt am Ordner
    datei('c', '/Hausmeister', 'Stundenzettel Oktober.pdf'),           // nichts erkennbar
    datei('d', '/Hausmeister', 'Stundenzettel November.pdf'),          // derselbe Ordner
    datei('e', '/Bilder/Camera Roll', 'IMG_1.jpg'),                    // privat → gar nicht erst aufnehmen
    { id: 'f', name: 'Ordner', folder: {}, parentReference: { path: '/drive/root:' } }
  ]);
  const server = await serverStarten({ MS_LOGIN_BASIS: ms.basis + '/login', MS_GRAPH_BASIS: ms.basis + '/graph', ADRESSE: 'https://app.example' });
  try {
    const louis = sitzung(server), papa = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
    await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });
    await louis.put('/api/data', { data: { objects: [
      { id: 'o1', name: 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen', units: [{ id: 'u1', name: 'EG Links', tenant: 'Marlene Kirschner', status: 'vermietet' }] },
      { id: 'o2', name: 'Dahlienweg 7, Waiblingen', units: [] },
      { id: 'o3', name: 'Tribergle 22, 71409 Schwaikheim', units: [] }
    ], interessenten: [] } });

    assert.equal((await papa.put('/api/onedrive', { clientId: 'x', clientSecret: 'y' })).status, 403, 'einrichten darf nur der Verwalter');
    assert.equal((await louis.put('/api/onedrive', { clientId: 'app-id', clientSecret: 'geheim' })).status, 200);
    let s = (await louis.get('/api/onedrive')).json;
    assert.equal(s.eingerichtet, true);
    assert.equal(s.verbunden, false);

    // Anmelden: zu Microsoft, mit unserem Zufallswert zurück
    const start = await louis.get('/api/onedrive/start');
    assert.equal(start.status, 302);
    const ziel = new URL(start.kopf.get('location'));
    assert.equal(ziel.searchParams.get('redirect_uri'), 'https://app.example/api/onedrive/zurueck');
    assert.match(ziel.searchParams.get('scope'), /Files\.Read/);
    assert.equal((await louis.get('/api/onedrive/zurueck?code=c&state=falsch')).status, 400, 'fremder Rücksprung wird abgelehnt');
    const zurueck = await louis.get('/api/onedrive/zurueck?code=c&state=' + ziel.searchParams.get('state'));
    assert.equal(zurueck.status, 200, zurueck.text);

    // Der Abgleich startet von selbst
    let r = null;
    for (let i = 0; i < 40; i++) {
      await warten(150);
      r = (await louis.get('/api/onedrive/dateien')).json;
      if (r.dateien.length >= 2 && !r.laeuft) break;
    }
    const nach = {};
    r.dateien.forEach(function (d) { nach[d.id] = d; });
    assert.equal(nach.a.objekt, 'o1'); assert.equal(nach.a.einheit, 'u1'); assert.equal(nach.a.art, 'Mietvertrag'); assert.equal(nach.a.status, 'zugeordnet');
    assert.equal(nach.b.objekt, 'o2'); assert.equal(nach.b.art, 'Plan');
    assert.equal(nach.c, undefined, 'unklare Dateien ohne Assistent bleiben offen und tauchen nicht in den Listen auf');
    assert.equal(nach.e, undefined, 'private Fotoordner werden gar nicht aufgenommen');
    s = (await louis.get('/api/onedrive')).json;
    assert.equal(s.verbunden, true);
    assert.equal(s.konto, 'louis@example.org');
    assert.equal(s.zahlen.offen, 2);

    // Louis ordnet eine Datei aus /Hausmeister zu → der Ordner ist gelernt, die zweite Datei dort folgt
    const korrektur = await louis.put('/api/onedrive/dateien/c', { objekt: 'o3', einheit: '', art: 'Rechnung' });
    assert.equal(korrektur.status, 200, korrektur.text);
    r = (await louis.get('/api/onedrive/dateien')).json;
    const d = r.dateien.find(function (x) { return x.id === 'd'; });
    assert.equal(d.objekt, 'o3', 'gelernter Ordner gilt für die nächste Datei');
    assert.equal(d.status, 'zugeordnet');
    assert.equal((await papa.put('/api/onedrive/dateien/a', { ignorieren: true })).status, 403);

    // Trennen vergisst Zugang und Zuordnungen
    assert.equal((await louis.del('/api/onedrive')).status, 200);
    s = (await louis.get('/api/onedrive')).json;
    assert.equal(s.verbunden, false);
    assert.equal((await louis.get('/api/onedrive/dateien')).json.dateien.length, 0);
  } finally {
    await server.stoppen();
    ms.stoppen();
  }
});
