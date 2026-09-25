'use strict';

// „Jetzt dran“: Beginnt ein Block mit Uhrzeit, geht eine Mitteilung ans Handy —
// hier an ein nachgebautes Gerät, das die verschlüsselte Nachricht entgegennimmt.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { serverStarten, sitzung, fakeTodoist } = require('./hilfe');

let webpushDa = true;
try { require('web-push'); } catch (e) { webpushDa = false; }

// Mitteilungen gehen immer über https — das Testgerät bekommt ein Wegwerf-Zertifikat
function zertifikat() {
  try {
    const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'zert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-keyout', path.join(ordner, 'k.pem'), '-out', path.join(ordner, 'c.pem')], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(ordner, 'k.pem')), cert: fs.readFileSync(path.join(ordner, 'c.pem')) };
  } catch (e) { return null; }
}
const zert = webpushDa ? zertifikat() : null;

function berlinJetzt() {
  const t = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date()).replace(' ', 'T');
  return t.slice(0, 16);
}

test('Erinnerung zu Beginn eines Blocks — genau einmal', { skip: !webpushDa ? 'web-push fehlt' : (!zert ? 'openssl fehlt' : false) }, async function () {
  const jetzt = berlinJetzt();
  const aufgaben = [
    { id: '1', content: 'Stadtwerke anrufen', priority: 1, due: { date: jetzt + ':00', datetime: jetzt + ':00', is_recurring: false }, duration: { amount: 15, unit: 'minute' } },
    { id: '2', content: 'Später am Tag', priority: 1, due: { date: '2099-01-01T10:00:00', datetime: '2099-01-01T10:00:00', is_recurring: false } }
  ];
  const todoist = await fakeTodoist(aufgaben);
  const empfangen = [];
  const geraet = https.createServer(zert, function (req, res) {
    req.on('data', function () {});
    req.on('end', function () { empfangen.push(req.headers); res.statusCode = 201; res.end(); });
  });
  await new Promise(function (ok) { geraet.listen(0, '127.0.0.1', ok); });
  const server = await serverStarten({ TODOIST_BASIS: todoist.basis, PUSH_TAKT_MS: '300', NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  try {
    const louis = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.put('/api/todoist', { token: 'test' });
    // Andere Meldungen aus, damit nur „Jetzt dran“ zählt
    await louis.put('/api/push/einstellungen', { morgen: false, termine: false, anfragen: false, abends: false });
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const abo = {
      endpoint: 'https://127.0.0.1:' + geraet.address().port + '/push/1',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
    };
    const a = await louis.post('/api/push/anmelden', { abo: abo, geraet: 'Test' });
    assert.equal(a.status, 200, a.text);

    for (let i = 0; i < 40 && !empfangen.length; i++) await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(empfangen.length, 1, 'eine Mitteilung für den Block, der jetzt beginnt\n' + server.ausgabe());
    await new Promise(function (r) { setTimeout(r, 1200); });
    assert.equal(empfangen.length, 1, 'und nicht noch einmal');
  } finally {
    await server.stoppen();
    todoist.stoppen();
    geraet.close();
  }
});
