'use strict';

// Klickt sich im echten Browser (Chromium über Playwright) durch alle Ansichten
// und schlägt Alarm, sobald die Seite einen Programmfehler meldet.
// Ohne installiertes Playwright wird der Test übersprungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const { serverStarten, sitzung } = require('./hilfe');

function playwrightLaden() {
  try { return require('playwright'); } catch (e) { /* lokal nicht da */ }
  try {
    const global = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(global, 'playwright'));
  } catch (e) { return null; }
}
const pw = playwrightLaden();

test('Oberfläche: alle Ansichten ohne Programmfehler', { skip: pw ? false : 'Playwright nicht installiert' }, async function () {
  const server = await serverStarten();
  const browser = await pw.chromium.launch();
  try {
    await sitzung(server).post('/api/setup', { name: 'louis', passwort: 'geheim123' });

    for (const [breite, hoehe] of [[1280, 900], [390, 844]]) {
      const seite = await (await browser.newContext({ viewport: { width: breite, height: hoehe } })).newPage();
      const fehler = [];
      seite.on('pageerror', function (e) { fehler.push(e.message); });
      seite.on('request', function (r) {
        if (!r.url().startsWith(server.basis)) fehler.push('Anfrage nach außen: ' + r.url());
      });

      await seite.goto(server.basis + '/');
      await seite.evaluate(async function () {
        await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'louis', passwort: 'geheim123' }) });
      });
      await seite.reload();
      await seite.waitForSelector('[data-act="zu-objekte"]', { state: 'attached' });

      for (const ziel of ['zu-heute', 'zu-aufgaben', 'zu-objekte', 'zu-mieten', 'zu-interessenten', 'zu-post', 'zu-rechnungen']) {
        await seite.evaluate(function (z) {
          const el = document.querySelector('[data-act="' + z + '"]');
          if (el) el.click();
        }, ziel);
        await seite.waitForTimeout(250);
      }

      // Menü → Server-Sicherung öffnet das richtige Fenster
      await seite.evaluate(function () { document.querySelector('[data-act="seite"]').click(); });
      await seite.waitForSelector('[data-act="server-sicherung"]', { state: 'attached' });
      await seite.evaluate(function () { document.querySelector('[data-act="server-sicherung"]').click(); });
      await seite.waitForSelector('text=Auf dem Server');

      assert.deepEqual(fehler, [], breite + 'px: ' + fehler.join(' | '));
      await seite.context().close();
    }
  } finally {
    await browser.close();
    await server.stoppen();
  }
});
