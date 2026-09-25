'use strict';

// Der Tagesplan trägt seine Blöcke in den Google-Kalender „Aufgaben“ ein —
// hier gegen ein nachgebautes Google (Anmeldung und Kalender-Schnittstelle).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { serverStarten, sitzung, fakeTodoist } = require('./hilfe');

const MONTAG = '2030-01-07';

function fakeGoogle() {
  const kalender = {};      // id -> { summary, ereignisse: { id -> ereignis } }
  let nr = 0;
  const server = http.createServer(function (req, res) {
    let koerper = '';
    req.on('data', function (d) { koerper += d; });
    req.on('end', function () {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'zugriff', expires_in: 3600 }));
      const k = koerper ? JSON.parse(koerper) : {};
      if (req.method === 'POST' && req.url === '/cal/calendars') {
        const id = 'kal' + (++nr);
        kalender[id] = { summary: k.summary, ereignisse: {} };
        return res.end(JSON.stringify({ id: id, summary: k.summary }));
      }
      const m = /^\/cal\/calendars\/([^/]+)\/events(?:\/([^/?]+))?$/.exec(req.url);
      if (m && kalender[decodeURIComponent(m[1])]) {
        const ev = kalender[decodeURIComponent(m[1])].ereignisse;
        const eid = m[2] && decodeURIComponent(m[2]);
        if (req.method === 'POST') { const id = 'ev' + (++nr); ev[id] = Object.assign({ id: id }, k); return res.end(JSON.stringify(ev[id])); }
        if (!ev[eid]) { res.statusCode = 404; return res.end('{}'); }
        if (req.method === 'PATCH') { Object.assign(ev[eid], k); return res.end(JSON.stringify(ev[eid])); }
        if (req.method === 'DELETE') { delete ev[eid]; res.statusCode = 204; return res.end(); }
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      ok({ basis: 'http://127.0.0.1:' + server.address().port, kalender: kalender, stoppen: function () { server.close(); } });
    });
  });
}

const warten = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

test('Aufgaben-Kalender: Plan trägt Blöcke ein, Rückgängig und Erledigt räumen sie wieder weg', async function () {
  const aufgaben = [
    { id: '1', content: 'Stadtwerke anrufen', priority: 4, due: { date: '2030-01-02', is_recurring: false } },
    { id: '2', content: 'Nebenkosten wegschicken', priority: 1, due: { date: '2030-01-03', is_recurring: false } }
  ];
  const todoist = await fakeTodoist(aufgaben);
  const google = await fakeGoogle();
  const server = await serverStarten({ TODOIST_BASIS: todoist.basis, GOOGLE_TOKEN_URL: google.basis + '/token', GKAL_API: google.basis + '/cal' });
  try {
    const louis = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.put('/api/todoist', { token: 'test' });

    // Ohne Kalender-Recht wird nichts eingetragen, der Plan klappt trotzdem
    let a = await louis.post('/api/plan', { datum: MONTAG });
    assert.equal(a.status, 200, a.text);
    assert.equal(Object.keys(google.kalender).length, 0);
    await louis.post('/api/plan/rueckgaengig', { datum: MONTAG });

    // Google verbunden, mit Kalender-Recht
    const db = new Database(path.join(server.daten, 'vermietung.db'));
    const setzen = db.prepare('INSERT OR REPLACE INTO einstellungen (schluessel, wert) VALUES (?,?)');
    setzen.run('google_client_id', 'id'); setzen.run('google_client_secret', 'geheim'); setzen.run('google_refresh', 'dauerhaft');
    setzen.run('google_scope', 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.app.created');
    db.close();
    a = await louis.get('/api/plan/einstellungen');
    assert.equal(a.json.kalender.erlaubt, true);

    a = await louis.post('/api/plan', { datum: MONTAG });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.kalender.eingetragen, 2);
    const ids = Object.keys(google.kalender);
    assert.equal(ids.length, 1);
    assert.equal(google.kalender[ids[0]].summary, 'Aufgaben');
    const ev = function () { return Object.values(google.kalender[ids[0]].ereignisse); };
    const stadtwerke = ev().find(function (e) { return e.summary === 'Stadtwerke anrufen'; });
    assert.deepEqual(stadtwerke.start, { dateTime: MONTAG + 'T08:00:00', timeZone: 'Europe/Berlin' });
    assert.deepEqual(stadtwerke.end, { dateTime: MONTAG + 'T08:15:00', timeZone: 'Europe/Berlin' });

    // Erledigt: der Block verschwindet
    await louis.post('/api/todoist/aufgabe/1/erledigt');
    await warten(300);
    assert.deepEqual(ev().map(function (e) { return e.summary; }), ['Nebenkosten wegschicken']);

    // Rückgängig: auch der Rest verschwindet
    await louis.post('/api/plan/rueckgaengig', { datum: MONTAG });
    await warten(300);
    assert.equal(ev().length, 0);
  } finally {
    await server.stoppen();
    todoist.stoppen();
    google.stoppen();
  }
});
