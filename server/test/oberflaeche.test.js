'use strict';

// Klickt sich im echten Browser (Chromium über Playwright) durch alle Ansichten
// und schlägt Alarm, sobald die Seite einen Programmfehler meldet.
// Ohne installiertes Playwright wird der Test übersprungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const { serverStarten, sitzung, fakeTodoist } = require('./hilfe');

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

test('Oberfläche: Tagesplan vorschlagen, übernehmen, zurücknehmen', { skip: pw ? false : 'Playwright nicht installiert' }, async function () {
  const gestern = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const aufgaben = [];
  for (let i = 1; i <= 12; i++) {
    aufgaben.push({ id: String(i), content: 'Aufgabe ' + i, priority: 1, project_id: '1', due: { date: gestern, is_recurring: false } });
  }
  const todoist = await fakeTodoist(aufgaben);
  const server = await serverStarten({ TODOIST_BASIS: todoist.basis });
  const browser = await pw.chromium.launch();
  try {
    const s = sitzung(server);
    await s.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await s.put('/api/todoist', { token: 'test' });

    const seite = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const fehler = [];
    seite.on('pageerror', function (e) { fehler.push(e.message); });
    seite.on('dialog', function (d) { d.accept(); });
    await seite.goto(server.basis + '/');
    await seite.evaluate(async function () {
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'louis', passwort: 'geheim123' }) });
    });
    await seite.reload();

    await seite.waitForSelector('[data-act="plan-zeigen"]');
    await seite.click('[data-act="plan-zeigen"]');
    await seite.waitForSelector('text=Auf die nächsten Tage');
    await seite.click('[data-act="plan-uebernehmen"]');
    await seite.waitForSelector('[data-act="plan-zurueck"]');
    assert.ok(todoist.aenderungen.length >= 12, 'alle Aufgaben wurden eingeplant oder verschoben');

    const vorher = todoist.aenderungen.length;
    await seite.click('[data-act="plan-zurueck"]');
    await seite.waitForSelector('[data-act="plan-zeigen"]');
    assert.equal(todoist.aenderungen.length, vorher * 2, 'jede Änderung wurde zurückgenommen');
    assert.ok(aufgaben.every(function (a) { return a.due.date === gestern; }));

    await seite.click('[data-act="plan-einst"]');
    await seite.waitForSelector('text=Tagesplan einstellen');
    assert.deepEqual(fehler, []);
  } finally {
    await browser.close();
    await server.stoppen();
    todoist.stoppen();
  }
});
