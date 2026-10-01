'use strict';

// Kaufen: Suchauftrags-Mails aus dem Postfach holen, eigene Angebote, Annahmen.
// Gmail und die Google-Anmeldung sind hier kleine Attrappen.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { serverStarten, sitzung } = require('./hilfe');

function b64(text) { return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); }

const MAILS = {
  k1: { betreff: '1 Angebot: Wohnung kaufen, in Waiblingen', text: [
    'zu deiner gespeicherten Suche Wohnung kaufen, in Waiblingen',
    'Titel: Gepflegte 3-Zimmer-Wohnung',
    'Link: https://push.search.is24.de/email/expose/111?PID=1',
    'Adresse: Waiblingen, Rems-Murr-Kreis',
    'Kaufpreis: 249.000 €',
    'Wohnfläche: 72 m²',
    'Zimmer: 3'].join('\n') },
  m1: { betreff: '6 Angebote: Mietwohnung, in Waiblingen', text: [10, 11, 12, 13, 14, 15].map(function (qm, i) {
    return ['Titel: Mietwohnung ' + i, 'Link: https://push.search.is24.de/email/expose/90' + i + '?PID=1',
      'Adresse: Waiblingen, Rems-Murr-Kreis', 'Kaltmiete: ' + (qm * 60) + ' €', 'Wohnfläche: 60 m²', 'Zimmer: 2', ''].join('\n');
  }).join('\n') },
  werbung: { betreff: 'Tipps für deine Suche', text: 'Nichts mit Titel und Link hier.' }
};

function fakeGoogle() {
  const abrufe = [];
  const server = http.createServer(function (req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'zugriff', expires_in: 3600 }));
    const liste = /^\/gmail\/v1\/users\/me\/messages\?/.exec(req.url);
    if (liste) return res.end(JSON.stringify({ messages: Object.keys(MAILS).map(function (id) { return { id: id }; }) }));
    const eine = /^\/gmail\/v1\/users\/me\/messages\/([^?]+)\?format=full/.exec(req.url);
    if (eine && MAILS[eine[1]]) {
      abrufe.push(eine[1]);
      const m = MAILS[eine[1]];
      return res.end(JSON.stringify({
        id: eine[1], internalDate: String(Date.now()),
        payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: m.betreff }],
          parts: [{ mimeType: 'text/plain', body: { data: b64(m.text) } }, { mimeType: 'text/html', body: { data: b64('<p>html</p>') } }] }
      }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      ok({ basis: 'http://127.0.0.1:' + server.address().port, abrufe: abrufe, stoppen: function () { server.close(); } });
    });
  });
}

let server, google, louis, papa;

test.before(async function () {
  google = await fakeGoogle();
  server = await serverStarten({ GOOGLE_TOKEN_URL: google.basis + '/token', GMAIL_BASIS: google.basis });
  louis = sitzung(server);
  papa = sitzung(server);
  await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
  await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
  await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });
});
test.after(async function () {
  if (server) await server.stoppen();
  if (google) google.stoppen();
});

test('Ohne Postfach: leere Liste mit Standard-Annahmen', async function () {
  const a = await louis.get('/api/kaufen');
  assert.equal(a.status, 200);
  assert.equal(a.json.verbunden, false);
  assert.deepEqual(a.json.angebote, []);
  assert.equal(a.json.annahmen.grunderwerbsteuer, 5);
  assert.equal((await sitzung(server).get('/api/kaufen')).status, 401);
});

test('Mit Postfach: Kauf- und Mietangebote aus den Suchauftrags-Mails, jede Mail nur einmal', async function () {
  assert.equal((await louis.put('/api/google', { clientId: 'id', clientSecret: 'geheim' })).status, 200);
  const db = new Database(path.join(server.daten, 'vermietung.db'));
  db.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert) VALUES ('google_refresh', 'dauerhaft')").run();
  db.close();

  let a = await louis.get('/api/kaufen?neu=1');
  assert.equal(a.json.verbunden, true);
  assert.equal(a.json.fehler, null);
  assert.equal(a.json.angebote.length, 1);
  const k = a.json.angebote[0];
  assert.equal(k.id, 'is24:111');
  assert.equal(k.status, 'neu');
  assert.equal(k.preis, 249000);
  assert.equal(k.ort, 'Waiblingen');
  assert.equal(a.json.miete.length, 6);
  assert.deepEqual(google.abrufe.sort(), ['k1', 'm1', 'werbung']);

  a = await louis.get('/api/kaufen?neu=1');
  assert.equal(google.abrufe.length, 3, 'schon gelesene Mails werden nicht nochmal geholt');
  assert.equal(a.json.angebote.length, 1);
});

test('Eigene Angaben ergänzen, merken, verwerfen', async function () {
  let a = await papa.put('/api/kaufen/angebote/is24:111', { status: 'gemerkt', eigenes: { miete: '850', hausgeld: '95,50', notiz: 'Besichtigung Freitag' } });
  assert.equal(a.status, 200);
  assert.equal(a.json.angebot.status, 'gemerkt');
  assert.equal(a.json.angebot.miete, 850);
  assert.equal(a.json.angebot.hausgeld, 95.5);
  assert.equal(a.json.angebot.preis, 249000, 'Kaufpreis aus der Mail bleibt');

  // Feld leeren heißt: wieder der Wert aus der Mail
  a = await papa.put('/api/kaufen/angebote/is24:111', { eigenes: { preis: '230000' } });
  assert.equal(a.json.angebot.preis, 230000);
  a = await papa.put('/api/kaufen/angebote/is24:111', { eigenes: { preis: '' } });
  assert.equal(a.json.angebot.preis, 249000);

  assert.equal((await papa.put('/api/kaufen/angebote/is24:111', { status: 'gekauft' })).status, 400);
  assert.equal((await papa.put('/api/kaufen/angebote/is24:999', { status: 'gemerkt' })).status, 404);
  assert.equal((await papa.put('/api/kaufen/angebote/is24:900', { status: 'gemerkt' })).status, 404, 'Mietangebote nicht');
});

test('Angebot selbst eintragen: aus eingefügtem Exposé-Text', async function () {
  let a = await louis.post('/api/kaufen/angebote', { titel: 'Vom Makler', ort: 'Korb', typ: 'haus',
    text: 'Kaufpreis: 389.000 €\nWohnfläche ca. 118 m²\n5 Zimmer\nhttps://example.org/haus' });
  assert.equal(a.status, 200);
  const k = a.json.angebot;
  assert.match(k.id, /^eigen:/);
  assert.equal(k.preis, 389000);
  assert.equal(k.flaeche, 118);
  assert.equal(k.zimmer, 5);
  assert.equal(k.typ, 'haus');
  assert.equal(k.status, 'gemerkt');

  assert.equal((await louis.post('/api/kaufen/angebote', { titel: 'ohne Preis' })).status, 400);
  a = await louis.post('/api/kaufen/angebote', { titel: 'Böser Link', preis: '100000', url: 'javascript:alert(1)' });
  assert.equal(a.json.angebot.url, '', 'nur http(s)-Links');
  await louis.del('/api/kaufen/angebote/' + encodeURIComponent(a.json.angebot.id));

  // Ein ImmoScout-Link landet beim selben Angebot wie die Mail
  a = await louis.post('/api/kaufen/angebote', { url: 'https://www.immobilienscout24.de/expose/111', preis: '240000' });
  assert.equal(a.json.angebot.id, 'is24:111');
  assert.equal(a.json.angebot.preis, 240000);

  await louis.del('/api/kaufen/angebote/' + encodeURIComponent(k.id));
  a = await louis.get('/api/kaufen');
  assert.deepEqual(a.json.angebote.map(function (x) { return x.id; }), ['is24:111']);
});

test('Annahmen: nur der Verwalter, Unsinn wird verworfen', async function () {
  assert.equal((await papa.put('/api/kaufen/annahmen', { annahmen: { zins: 4 } })).status, 403);
  let a = await louis.put('/api/kaufen/annahmen', { annahmen: { zins: '4,1', tilgung: 'viel', ekProzent: -5 } });
  assert.equal(a.status, 200);
  assert.equal(a.json.annahmen.zins, 4.1);
  assert.equal(a.json.annahmen.tilgung, 2);
  assert.equal(a.json.annahmen.ekProzent, 20);
  a = await papa.get('/api/kaufen');
  assert.equal(a.json.annahmen.zins, 4.1);
});
