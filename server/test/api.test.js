'use strict';

// Prüft die Schnittstellen des Servers von außen, so wie der Browser sie benutzt.
// Aufruf: npm test (im Ordner server)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { serverStarten, sitzung } = require('./hilfe');

let server;
let louis;   // Verwalter
let papa;    // normaler Nutzer

test.before(async function () {
  server = await serverStarten();
  louis = sitzung(server);
  papa = sitzung(server);
});
test.after(async function () { if (server) await server.stoppen(); });

test('Einrichten: erster Zugang wird Verwalter, danach ist Einrichten gesperrt', async function () {
  let a = await louis.get('/api/status');
  assert.equal(a.json.eingerichtet, false);

  a = await louis.post('/api/setup', { name: 'louis', passwort: 'kurz' });
  assert.equal(a.status, 400);

  a = await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
  assert.equal(a.status, 200);

  a = await louis.get('/api/status');
  assert.equal(a.json.angemeldet, true);
  assert.equal(a.json.rolle, 'verwalter');

  a = await papa.post('/api/setup', { name: 'dieb', passwort: 'geheim123' });
  assert.equal(a.status, 403);
});

test('Ohne Anmeldung gibt es keine Daten', async function () {
  const fremd = sitzung(server);
  assert.equal((await fremd.get('/api/data')).status, 401);
  assert.equal((await fremd.put('/api/data', { data: {} })).status, 401);
});

test('Anmelden: falsches Passwort, richtiges Passwort, Abmelden', async function () {
  const s = sitzung(server);
  let a = await s.post('/api/login', { name: 'louis', passwort: 'falsch' });
  assert.equal(a.status, 401);
  a = await s.post('/api/login', { name: 'LOUIS', passwort: 'geheim123' });
  assert.equal(a.status, 200);
  assert.equal(a.json.nutzer, 'louis');
  a = await s.post('/api/logout');
  assert.equal(a.status, 200);
  assert.equal((await s.get('/api/data')).status, 401);
});

test('Speichern: Konflikt wird erkannt, erzwingen und alte Oberflächen gehen durch', async function () {
  let a = await louis.put('/api/data', { data: { objects: [] }, basis: null });
  assert.equal(a.status, 200);
  const erster = a.json.wann;

  a = await louis.put('/api/data', { data: { objects: [1] }, basis: erster });
  assert.equal(a.status, 200);
  const zweiter = a.json.wann;
  assert.ok(zweiter > erster);

  // Jemand baut noch auf dem ersten Stand auf
  a = await louis.put('/api/data', { data: { objects: [2] }, basis: erster });
  assert.equal(a.status, 409);
  assert.equal(a.json.wann, zweiter);

  a = await louis.put('/api/data', { data: { objects: [2] }, basis: erster, erzwingen: true });
  assert.equal(a.status, 200);

  a = await louis.put('/api/data', { data: { objects: [3] } });   // ohne basis
  assert.equal(a.status, 200);

  a = await louis.get('/api/data');
  assert.deepEqual(a.json.data, { objects: [3] });

  a = await louis.get('/api/verlauf');
  assert.equal(a.json.length, 4);
  const alt = await louis.get('/api/verlauf/' + a.json[3].id);
  assert.deepEqual(alt.json.data, { objects: [] });
});

test('Nutzer: anlegen, Rechte, Passwort ändern und zurücksetzen', async function () {
  let a = await louis.post('/api/users', { name: 'papa', passwort: 'papa12345' });
  assert.equal(a.status, 200);
  a = await louis.post('/api/users', { name: 'Papa', passwort: 'papa12345' });
  assert.equal(a.status, 409);

  a = await papa.post('/api/login', { name: 'papa', passwort: 'papa12345' });
  assert.equal(a.status, 200);
  assert.equal(a.json.rolle, 'nutzer');

  // Verwalter-Sachen sind für normale Nutzer gesperrt
  for (const [m, p, k] of [
    ['POST', '/api/users', { name: 'x', passwort: 'xxxxxxxx' }],
    ['PUT', '/api/push/einstellungen', { zeit: '08:00' }],
    ['PUT', '/api/rechnungen/absender', { name: 'x' }],
    ['PUT', '/api/todoist', { token: 'x' }],
    ['GET', '/api/sicherung'],
    ['GET', '/api/google/start']
  ]) {
    a = await papa.anfrage(m, p, k);
    assert.equal(a.status, 403, m + ' ' + p);
  }

  // Eigenes Passwort
  a = await papa.post('/api/passwort', { alt: 'falsch', neu: 'neuesPW123' });
  assert.equal(a.status, 403);
  a = await papa.post('/api/passwort', { alt: 'papa12345', neu: 'neuesPW123' });
  assert.equal(a.status, 200);
  a = await sitzung(server).post('/api/login', { name: 'papa', passwort: 'neuesPW123' });
  assert.equal(a.status, 200);

  // Verwalter setzt zurück — papa wird dabei abgemeldet
  a = await louis.put('/api/users/papa/passwort', { passwort: 'zurueck123' });
  assert.equal(a.status, 200);
  assert.equal((await papa.get('/api/data')).status, 401);
  a = await papa.post('/api/login', { name: 'papa', passwort: 'zurueck123' });
  assert.equal(a.status, 200);

  // Sich selbst und den letzten Zugang löscht man nicht
  assert.equal((await louis.del('/api/users/louis')).status, 400);
});

test('Rechnungen: Nummern sind eindeutig', async function () {
  let a = await louis.post('/api/rechnungen', { nummer: '2026-AS-01', art: 'as', brutto: 10 });
  assert.equal(a.status, 200);
  assert.equal(a.json.naechste.as.endsWith('-AS-02'), true);
  a = await louis.post('/api/rechnungen', { nummer: '2026-AS-01', art: 'as' });
  assert.equal(a.status, 400);
  const id = (await louis.get('/api/rechnungen')).json.liste[0].id;
  a = await louis.del('/api/rechnungen/' + id);
  assert.equal(a.json.liste.length, 0);
});

test('Rechnungen: Solarstrom hat eigene Nummern (JJJJ-PV-NN)', async function () {
  let a = await louis.get('/api/rechnungen');
  const nummer = a.json.naechste.pv;
  assert.match(nummer, /^\d{4}-PV-01$/);
  a = await louis.post('/api/rechnungen', { nummer: nummer, art: 'pv', objekt: 'Tribergle 22', brutto: 120.5,
    inhalt: { standAlt: '1000', standNeu: '2500', preis: '8' } });
  assert.equal(a.status, 200);
  assert.equal(a.json.liste[0].art, 'pv');
  assert.match(a.json.naechste.pv, /-PV-02$/);
  assert.match(a.json.naechste.as, /-AS-01$/, 'Allgemeinstrom zählt getrennt');
  await louis.del('/api/rechnungen/' + a.json.id);
});

test('Google: Rücksprung ohne passenden state wird abgelehnt', async function () {
  const a = await louis.get('/api/google/zurueck?code=abc&state=erfunden');
  assert.equal(a.status, 400);
});

test('Todoist ohne Schlüssel meldet einen verständlichen Fehler', async function () {
  const a = await louis.get('/api/todoist/woche');
  assert.equal(a.status, 502);
  assert.match(a.json.fehler, /Todoist-Token/);
});

test('Sicherung: liegt auf dem Server, Drive meldet fehlende Verbindung', async function () {
  const a = await louis.get('/api/sicherung');
  assert.equal(a.status, 200);
  assert.ok(a.json.dateien.length >= 1);
  assert.equal(a.json.googleVerbunden, false);
  assert.ok(fs.existsSync(path.join(server.daten, 'sicherung')));
});

test('Oberfläche wird ausgeliefert, mit Schutz-Kopfzeilen und ohne Google Fonts', async function () {
  const a = await louis.get('/');
  assert.equal(a.status, 200);
  assert.match(a.text, /<div id="app">/);
  // Alle eingebundenen Dateien sind erreichbar und laden nichts von Google
  const verweise = a.text.match(/(?:href|src)="([a-z]+\.(?:css|js)\?v=[0-9a-f]+)"/g) || [];
  assert.equal(verweise.length, 4);
  for (const v of verweise) {
    const datei = await louis.get('/' + v.split('"')[1]);
    assert.equal(datei.status, 200, v);
    assert.doesNotMatch(datei.text, /fonts\.googleapis|fonts\.gstatic/, v);
  }
  assert.equal(a.kopf.get('x-frame-options'), 'DENY');
  assert.equal(a.kopf.get('x-content-type-options'), 'nosniff');
  assert.equal(a.kopf.get('x-powered-by'), null);
});

test('Zu viele falsche Anmeldungen werden gebremst', async function () {
  const s = sitzung(server);
  let letzter;
  for (let i = 0; i < 11; i++) letzter = await s.post('/api/login', { name: 'niemand', passwort: 'x' });
  assert.equal(letzter.status, 429);
});

test('index.html verweist mit aktuellen Prüfsummen auf CSS und JS', function () {
  const { gebaut } = require('../../werkzeuge/bauen');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  assert.equal(html, gebaut(), 'Bitte "node werkzeuge/bauen.js" ausführen');
});
