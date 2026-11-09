'use strict';

// Zweiter Faktor beim Anmelden: Einmalcodes aus einer Authenticator-App, Ersatzcodes, Ausschalten, Zurücksetzen.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { serverStarten, sitzung } = require('./hilfe');

// Eigene, knappe Umsetzung von RFC 6238 — unabhängig vom Server, damit ein Rechenfehler dort auffällt
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Lesen(text) {
  let bits = '';
  for (const z of text.toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(z).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function einmalcode(geheimnis, schritt) {
  const zaehler = Buffer.alloc(8);
  zaehler.writeUInt32BE(Math.floor(schritt / 0x100000000), 0);
  zaehler.writeUInt32BE(schritt >>> 0, 4);
  const mac = crypto.createHmac('sha1', base32Lesen(geheimnis)).update(zaehler).digest();
  const o = mac[19] & 0x0f;
  const zahl = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(zahl % 1000000).padStart(6, '0');
}
const schrittJetzt = function () { return Math.floor(Date.now() / 30000); };

let server, louis, papa;
let geheimnis = '';
let ersatz = [];

test.before(async function () {
  server = await serverStarten();
  louis = sitzung(server);
  papa = sitzung(server);
  await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
  await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
  await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });
});
test.after(async function () { if (server) await server.stoppen(); });

test('Prüfwert aus RFC 6238: das Rechenwerk des Tests stimmt', function () {
  // Anhang B des RFC: Geheimnis "12345678901234567890", Zeit 59 s → Schritt 1 → Code 287082 (die letzten sechs von 94287082)
  const geheimnisRfc = (function () {
    const bytes = Buffer.from('12345678901234567890', 'ascii');
    let bits = '', aus = '';
    for (const b of bytes) bits += b.toString(2).padStart(8, '0');
    for (let i = 0; i + 5 <= bits.length; i += 5) aus += B32[parseInt(bits.slice(i, i + 5), 2)];
    return aus;
  })();
  assert.equal(einmalcode(geheimnisRfc, 1), '287082');
});

test('Einrichten: erst mit einem richtigen Code wird der zweite Faktor scharf', async function () {
  let a = await louis.post('/api/zweiter-faktor/einschalten', { code: '123456' });
  assert.equal(a.status, 400, 'ohne Einrichtung nichts einzuschalten');

  a = await louis.post('/api/zweiter-faktor/start', {});
  assert.equal(a.status, 200);
  geheimnis = a.json.geheimnis.replace(/\s/g, '');
  assert.match(geheimnis, /^[A-Z2-7]{32}$/, '20 Bytes als Base32');
  assert.match(a.json.uri, /^otpauth:\/\/totp\/Ziegler%20Verwaltung%3Alouis\?secret=[A-Z2-7]{32}&issuer=Ziegler%20Verwaltung&algorithm=SHA1&digits=6&period=30$/);
  assert.equal((await louis.get('/api/status')).json.zweiterFaktor, false, 'noch nicht scharf');

  a = await louis.post('/api/zweiter-faktor/einschalten', { code: einmalcode(geheimnis, schrittJetzt() - 5) });
  assert.equal(a.status, 400, 'ein alter Code zählt nicht');
  assert.equal((await louis.get('/api/status')).json.zweiterFaktor, false);

  a = await louis.post('/api/zweiter-faktor/einschalten', { code: einmalcode(geheimnis, schrittJetzt()) });
  assert.equal(a.status, 200);
  ersatz = a.json.ersatzcodes;
  assert.equal(ersatz.length, 8);
  ersatz.forEach(function (c) { assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/); });
  assert.equal((await louis.get('/api/status')).json.zweiterFaktor, true);
  assert.equal((await louis.get('/api/data')).status, 200, 'die eigene Sitzung bleibt');

  const liste = (await louis.get('/api/users')).json;
  assert.equal(liste.find(function (n) { return n.name === 'louis'; }).zweiterFaktor, true);
  assert.equal(liste.find(function (n) { return n.name === 'papa'; }).zweiterFaktor, false);

  a = await louis.post('/api/zweiter-faktor/start', {});
  assert.equal(a.status, 400, 'eingeschaltet lässt sich nicht einfach neu einrichten');
});

test('Anmelden: Passwort allein reicht nicht mehr, ein Code gilt nur einmal', async function () {
  const s = sitzung(server);
  let a = await s.post('/api/login', { name: 'louis', passwort: 'geheim123' });
  assert.equal(a.status, 200);
  assert.equal(a.json.zweiterFaktor, true);
  assert.ok(a.json.ticket, 'ein Ticket statt einer Sitzung');
  assert.equal(a.json.ok, undefined);
  assert.equal((await s.get('/api/data')).status, 401, 'ohne Code keine Sitzung');
  const ticket = a.json.ticket;

  a = await s.post('/api/login/code', { ticket: ticket, code: einmalcode(geheimnis, schrittJetzt() - 5) });
  assert.equal(a.status, 401);
  assert.equal((await s.get('/api/data')).status, 401);

  // Der Code der Einrichtung ist verbraucht — der nächste Zeitschritt gilt (eine halbe Minute Uhrabweichung ist erlaubt)
  const code = einmalcode(geheimnis, schrittJetzt() + 1);
  a = await s.post('/api/login/code', { ticket: ticket, code: code.slice(0, 3) + ' ' + code.slice(3) });
  assert.equal(a.status, 200);
  assert.equal(a.json.nutzer, 'louis');
  assert.equal(a.json.zweiterFaktor, true);
  assert.equal((await s.get('/api/data')).status, 200);

  // Derselbe Code noch einmal: abgelehnt
  const t = sitzung(server);
  a = await t.post('/api/login', { name: 'louis', passwort: 'geheim123' });
  a = await t.post('/api/login/code', { ticket: a.json.ticket, code: code });
  assert.equal(a.status, 401, 'ein Code gilt nur einmal');

  // Erfundenes Ticket
  a = await t.post('/api/login/code', { ticket: 'gibtsnicht', code: code });
  assert.equal(a.status, 401);
  assert.match(a.json.fehler, /Passwort/);
});

test('Ersatzcode: gilt genau einmal, Groß- und Kleinschreibung egal', async function () {
  const s = sitzung(server);
  let a = await s.post('/api/login', { name: 'louis', passwort: 'geheim123' });
  a = await s.post('/api/login/code', { ticket: a.json.ticket, code: ersatz[0].toLowerCase() });
  assert.equal(a.status, 200);
  assert.equal((await s.get('/api/data')).status, 200);

  const t = sitzung(server);
  a = await t.post('/api/login', { name: 'louis', passwort: 'geheim123' });
  a = await t.post('/api/login/code', { ticket: a.json.ticket, code: ersatz[0] });
  assert.equal(a.status, 401, 'verbraucht');
});

test('Ausschalten nur mit Passwort; der Verwalter setzt fremde Zugänge zurück', async function () {
  let a = await louis.post('/api/zweiter-faktor/ausschalten', { passwort: 'falsch' });
  assert.equal(a.status, 403);
  assert.equal((await louis.get('/api/status')).json.zweiterFaktor, true);

  // papa richtet ein, louis setzt zurück
  a = await papa.post('/api/zweiter-faktor/start', {});
  const g = a.json.geheimnis.replace(/\s/g, '');
  a = await papa.post('/api/zweiter-faktor/einschalten', { code: einmalcode(g, schrittJetzt()) });
  assert.equal(a.status, 200);
  assert.equal((await papa.get('/api/status')).json.zweiterFaktor, true);
  assert.equal((await papa.del('/api/users/louis/zweiter-faktor')).status, 403, 'nur der Verwalter');
  assert.equal((await louis.del('/api/users/louis/zweiter-faktor')).status, 400, 'den eigenen nur mit Passwort');
  assert.equal((await louis.del('/api/users/gibtsnicht/zweiter-faktor')).status, 404);
  assert.equal((await louis.del('/api/users/papa/zweiter-faktor')).status, 200);
  assert.equal((await papa.get('/api/status')).json.zweiterFaktor, false);

  a = await louis.post('/api/zweiter-faktor/ausschalten', { passwort: 'geheim123' });
  assert.equal(a.status, 200);
  assert.equal((await louis.get('/api/status')).json.zweiterFaktor, false);
  const s = sitzung(server);
  a = await s.post('/api/login', { name: 'louis', passwort: 'geheim123' });
  assert.equal(a.json.ok, true, 'wieder ohne Code');
  assert.equal((await s.get('/api/data')).status, 200);
});
