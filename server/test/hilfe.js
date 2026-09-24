'use strict';

// Startet einen echten Server mit leerer Datenbank in einem Wegwerf-Ordner
// und bietet eine kleine Hilfe für Anfragen mit Anmelde-Keks.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

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

module.exports = { serverStarten, sitzung };
