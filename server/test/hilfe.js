'use strict';

// Startet einen echten Server mit leerer Datenbank in einem Wegwerf-Ordner
// und bietet eine kleine Hilfe für Anfragen mit Anmelde-Keks.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

function freierPort() {
  return new Promise(function (ok, fehler) {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', function () {
      const port = s.address().port;
      s.close(function () { ok(port); });
    });
    s.on('error', fehler);
  });
}

async function serverStarten(zusatz) {
  const port = await freierPort();
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), 'vermietung-test-'));
  const kind = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATEN: daten }, zusatz || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let ausgabe = '';
  kind.stdout.on('data', function (d) { ausgabe += d; });
  kind.stderr.on('data', function (d) { ausgabe += d; });

  const basis = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { const a = await fetch(basis + '/api/status'); if (a.ok) break; } catch (e) { /* startet noch */ }
    await new Promise(function (r) { setTimeout(r, 100); });
    if (kind.exitCode !== null) throw new Error('Server ist beim Start abgestürzt:\n' + ausgabe);
  }

  return {
    basis: basis,
    daten: daten,
    ausgabe: function () { return ausgabe; },
    async stoppen() {
      kind.kill();
      await new Promise(function (r) { kind.once('exit', r); setTimeout(r, 2000); });
      fs.rmSync(daten, { recursive: true, force: true });
    }
  };
}

// Ein "Browser": merkt sich den Anmelde-Keks
function sitzung(server) {
  let keks = '';
  return {
    async anfrage(methode, pfad, koerper) {
      const optionen = { method: methode, headers: {}, redirect: 'manual' };
      if (keks) optionen.headers.Cookie = keks;
      if (koerper !== undefined) {
        optionen.headers['Content-Type'] = 'application/json';
        optionen.body = JSON.stringify(koerper);
      }
      const antwort = await fetch(server.basis + pfad, optionen);
      const gesetzt = antwort.headers.get('set-cookie');
      if (gesetzt) {
        const m = gesetzt.match(/sid=([^;]*)/);
        if (m) keks = m[1] ? 'sid=' + m[1] : '';
      }
      const text = await antwort.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* kein JSON */ }
      return { status: antwort.status, json: json, text: text, kopf: antwort.headers };
    },
    get: function (p) { return this.anfrage('GET', p); },
    post: function (p, k) { return this.anfrage('POST', p, k === undefined ? {} : k); },
    put: function (p, k) { return this.anfrage('PUT', p, k); },
    del: function (p) { return this.anfrage('DELETE', p); }
  };
}

// Ein kleines Todoist zum Testen: kennt nur Aufgaben lesen und ändern
function fakeTodoist(aufgaben) {
  const aenderungen = [];
  const server = http.createServer(function (req, res) {
    let koerper = '';
    req.on('data', function (d) { koerper += d; });
    req.on('end', function () {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/tasks')) {
        return res.end(JSON.stringify({ results: aufgaben, next_cursor: null }));
      }
      if (req.method === 'GET' && req.url.startsWith('/projects')) {
        return res.end(JSON.stringify({ results: [{ id: '1', name: 'Eingang', color: 'grey', inbox_project: true }], next_cursor: null }));
      }
      if (req.method === 'GET' && req.url.startsWith('/sections')) {
        return res.end(JSON.stringify({ results: [], next_cursor: null }));
      }
      const z = /^\/tasks\/([^/?]+)\/(close|reopen)$/.exec(req.url);
      if (req.method === 'POST' && z) {
        aenderungen.push({ id: z[1], aktion: z[2] });
        res.statusCode = 204; return res.end();
      }
      const m = /^\/tasks\/([^/?]+)$/.exec(req.url);
      if (req.method === 'POST' && m) {
        const a = aufgaben.find(function (x) { return String(x.id) === m[1]; });
        if (!a) { res.statusCode = 404; return res.end('{}'); }
        const k = JSON.parse(koerper || '{}');
        aenderungen.push({ id: a.id, koerper: k });
        if (k.due_datetime) a.due = { date: k.due_datetime, is_recurring: false, string: '' };
        else if (k.due_date) a.due = { date: k.due_date, is_recurring: false, string: '' };
        else if (k.due_string === 'no date') a.due = null;
        if (k.duration) a.duration = { amount: k.duration, unit: k.duration_unit };
        if (Array.isArray(k.labels)) a.labels = k.labels;
        if (k.description !== undefined) a.description = k.description;
        return res.end(JSON.stringify(a));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      ok({ basis: 'http://127.0.0.1:' + server.address().port, aenderungen: aenderungen, aufgaben: aufgaben,
        stoppen: function () { server.close(); } });
    });
  });
}

module.exports = { serverStarten, sitzung, fakeTodoist };
