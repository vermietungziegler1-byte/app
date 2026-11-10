'use strict';

// Postfach (IMAP/SMTP): Einrichten nur mit gültiger Anmeldung, nur für den Verwalter,
// das Passwort liegt nie im Klartext in der Datenbank. Der Mailserver ist eine kleine Attrappe,
// die nur Anmelden und Abmelden kann.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { serverStarten, sitzung } = require('./hilfe');

const PASSWORT = 'Sehr-geheim-42!';

function fakeImap() {
  const anmeldungen = [];
  const server = net.createServer(function (s) {
    let rest = '';
    s.write('* OK [CAPABILITY IMAP4rev1] Attrappe bereit\r\n');
    s.on('data', function (d) {
      rest += d.toString('utf8');
      let i;
      while ((i = rest.indexOf('\r\n')) !== -1) {
        const zeile = rest.slice(0, i); rest = rest.slice(i + 2);
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(zeile);
        if (!m) continue;
        const tag = m[1], befehl = m[2].toUpperCase(), rest2 = m[3] || '';
        if (befehl === 'CAPABILITY') { s.write('* CAPABILITY IMAP4rev1\r\n' + tag + ' OK fertig\r\n'); }
        else if (befehl === 'LOGIN') {
          const w = /^"?([^" ]+)"? "?(.*?)"?$/.exec(rest2) || [];
          anmeldungen.push(w[1]);
          if (w[2] === PASSWORT) s.write(tag + ' OK angemeldet\r\n');
          else s.write(tag + ' NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
        } else if (befehl === 'LOGOUT') { s.write('* BYE tschuess\r\n' + tag + ' OK fertig\r\n'); s.end(); }
        else s.write(tag + ' OK fertig\r\n');
      }
    });
    s.on('error', function () { /* egal */ });
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      ok({ port: server.address().port, anmeldungen: anmeldungen, stoppen: function () { server.close(); } });
    });
  });
}

let pakete = true;
try { require.resolve('imapflow'); } catch (e) { pakete = false; }

test('Postfach: nur der Verwalter, Anmeldung wird geprüft, Passwort liegt verschlüsselt', { skip: pakete ? false : 'imapflow nicht installiert' }, async function () {
  const imap = await fakeImap();
  const server = await serverStarten({ POSTFACH_SERVER: '127.0.0.1', POSTFACH_IMAP_PORT: String(imap.port), POSTFACH_TLS: '0' });
  try {
    const louis = sitzung(server), papa = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
    await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });

    assert.equal((await papa.get('/api/postfach')).status, 403, 'das Postfach sieht nur der Verwalter');
    let a = await louis.get('/api/postfach');
    assert.equal(a.json.eingerichtet, false);
    assert.equal(a.json.pakete, true);
    assert.equal((await louis.get('/api/postfach/ordner')).status, 409, 'ohne Einrichtung gibt es keine Ordner');

    // Falsches Passwort: wird beim Mailserver probiert und nicht gespeichert
    a = await louis.put('/api/postfach', { benutzer: 'louis.ziegler@mzer.de', passwort: 'falsch', server: '127.0.0.1' });
    assert.equal(a.status, 400);
    assert.match(a.json.fehler, /Passwort stimmt nicht/);
    assert.equal((await louis.get('/api/postfach')).json.eingerichtet, false);

    // Richtiges Passwort: gespeichert — aber nur verschlüsselt, der Schlüssel liegt daneben in einer eigenen Datei
    a = await louis.put('/api/postfach', { benutzer: 'louis.ziegler@mzer.de', passwort: PASSWORT, server: '127.0.0.1' });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    a = await louis.get('/api/postfach');
    assert.equal(a.json.eingerichtet, true);
    assert.equal(a.json.benutzer, 'louis.ziegler@mzer.de');
    assert.equal(JSON.stringify(a.json).indexOf(PASSWORT), -1, 'das Passwort geht nie zurück an den Browser');
    assert.deepEqual(imap.anmeldungen, ['louis.ziegler@mzer.de', 'louis.ziegler@mzer.de']);

    const datei = new Database(path.join(server.daten, 'vermietung.db'), { readonly: true });
    const wert = datei.prepare("SELECT wert FROM einstellungen WHERE schluessel = 'postfach_passwort'").get().wert;
    datei.close();
    assert.ok(wert.startsWith('v1:'));
    assert.equal(wert.indexOf(PASSWORT), -1);
    assert.equal(fs.readFileSync(path.join(server.daten, 'postfach.schluessel')).length, 32);

    // Trennen löscht die Zugangsdaten
    assert.equal((await papa.del('/api/postfach')).status, 403);
    assert.equal((await louis.del('/api/postfach')).status, 200);
    assert.equal((await louis.get('/api/postfach')).json.eingerichtet, false);
  } finally {
    await server.stoppen();
    imap.stoppen();
  }
});
