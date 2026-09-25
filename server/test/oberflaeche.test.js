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
    await seite.click('#dialog button.primaer');
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

test('Oberfläche: Solarstrom-Rechnung anlegen und fürs nächste Jahr vorbereiten', { skip: pw ? false : 'Playwright nicht installiert' }, async function () {
  const server = await serverStarten();
  const browser = await pw.chromium.launch();
  try {
    await sitzung(server).post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    const seite = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const fehler = [];
    seite.on('pageerror', function (e) { fehler.push(e.message); });
    await seite.goto(server.basis + '/');
    await seite.evaluate(async function () {
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'louis', passwort: 'geheim123' }) });
    });
    await seite.reload();
    await seite.waitForSelector('[data-act="zu-rechnungen"]', { state: 'attached' });
    await seite.evaluate(function () { document.querySelector('[data-act="zu-rechnungen"]').click(); });
    await seite.click('[data-act="rg-tab"][data-tab="pv"]');
    await seite.waitForSelector('text=Solarstrom');

    // Erste Rechnung: Vorjahr, PV-Nummer
    const vorjahr = new Date().getFullYear() - 1;
    assert.equal(await seite.inputValue('[data-rg="von"]'), vorjahr + '-01-01');
    assert.match(await seite.inputValue('[data-rg="nummer"]'), /-PV-01$/);
    await seite.fill('[data-rg="standAlt"]', '1000');
    await seite.fill('[data-rg="standNeu"]', '2500');
    await seite.fill('[data-rg="preis"]', '25');
    await seite.click('[data-act="rg-speichern"]');
    await seite.waitForSelector('[data-act="rg-folgejahr"]');

    // Vorschau zeigt den Solarstrom-Text
    await seite.click('[data-act="rg-vorschau"]');
    await seite.waitForSelector('#druck:not([hidden]) >> text=Rechnung über die Lieferung von Solarstrom');
    await seite.click('[data-dk="zu"]');

    // Fürs nächste Jahr: Zeitraum +1, alter Stand = letzter neuer, Preis bleibt
    await seite.click('[data-act="rg-folgejahr"]');
    assert.equal(await seite.inputValue('[data-rg="von"]'), (vorjahr + 1) + '-01-01');
    assert.equal(await seite.inputValue('[data-rg="standAlt"]'), '2500');
    assert.equal(await seite.inputValue('[data-rg="standNeu"]'), '');
    assert.equal(await seite.inputValue('[data-rg="preis"]'), '25');
    assert.match(await seite.inputValue('[data-rg="nummer"]'), /-PV-02$/);

    // Allgemeinstrom bleibt davon unberührt
    await seite.click('[data-act="rg-tab"][data-tab="as"]');
    assert.match(await seite.inputValue('[data-rg="nummer"]'), /-AS-01$/);
    assert.deepEqual(fehler, []);
  } finally {
    await browser.close();
    await server.stoppen();
  }
});

test('Oberfläche: Suche für alles und Wischen am Handy', { skip: pw ? false : 'Playwright nicht installiert' }, async function () {
  const heute = new Date().toISOString().slice(0, 10);
  const aufgaben = [
    { id: '1', content: 'Heizung Holzgasse prüfen', priority: 1, project_id: '1', due: { date: heute, is_recurring: false } },
    { id: '2', content: 'Rauchmelder tauschen', priority: 1, project_id: '1', due: { date: heute, is_recurring: false } }
  ];
  const todoist = await fakeTodoist(aufgaben);
  const server = await serverStarten({ TODOIST_BASIS: todoist.basis });
  const browser = await pw.chromium.launch();
  try {
    const s = sitzung(server);
    await s.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await s.put('/api/todoist', { token: 'test' });

    const seite = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    const fehler = [];
    seite.on('pageerror', function (e) { fehler.push(e.message); });
    await seite.goto(server.basis + '/');
    await seite.evaluate(async function () {
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'louis', passwort: 'geheim123' }) });
    });
    await seite.reload();
    const zuAufgaben = async function () {
      await seite.waitForSelector('[data-act="zu-aufgaben"]', { state: 'attached' });
      await seite.evaluate(function () { document.querySelector('[data-act="zu-aufgaben"]').click(); });
      await seite.waitForSelector('.td-zeile[data-tid="2"]');
    };
    await zuAufgaben();

    // Suche: findet Objekt und Aufgabe, Enter springt zum ersten Treffer
    await seite.click('[data-act="suche"]');
    await seite.fill('#suche-q', 'holzgasse');
    await seite.waitForSelector('.such-treffer[data-typ="objekt"]');
    await seite.waitForSelector('.such-treffer[data-typ="aufgabe"][data-id="1"]');
    await seite.press('#suche-q', 'Enter');
    await seite.waitForSelector('.obj.offen >> text=Holzgasse 23');
    assert.equal(await seite.$('#suche-q'), null, 'Suchfenster ist zu');

    // Wischen nach rechts hakt die Aufgabe ab
    await zuAufgaben();
    await seite.evaluate(function () {
      const z = document.querySelector('.td-zeile[data-tid="2"] .td-titel');
      const r = z.getBoundingClientRect();
      const punkt = function (x) { return new Touch({ identifier: 1, target: z, clientX: x, clientY: r.top + 5 }); };
      const senden = function (typ, x) {
        const t = punkt(x);
        z.dispatchEvent(new TouchEvent(typ, { bubbles: true, touches: typ === 'touchend' ? [] : [t], changedTouches: [t] }));
      };
      senden('touchstart', 60); senden('touchmove', 100); senden('touchmove', 220); senden('touchend', 220);
    });
    await seite.waitForFunction(function () { return !document.querySelector('.td-zeile[data-tid="2"]'); });
    await seite.waitForSelector('text=Rückgängig');
    assert.ok(todoist.aenderungen.some(function (a) { return a.id === '2' && a.aktion === 'close'; }), 'Aufgabe 2 wurde erledigt');
    assert.deepEqual(fehler, []);
  } finally {
    await browser.close();
    await server.stoppen();
    todoist.stoppen();
  }
});

test('Oberfläche: Darstellung folgt dem Gerät, Fußzeile meldet stilles Speichern', { skip: pw ? false : 'Playwright nicht installiert' }, async function () {
  const server = await serverStarten();
  const browser = await pw.chromium.launch();
  try {
    await sitzung(server).post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    const seite = await (await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 900 } })).newPage();
    const fehler = [];
    seite.on('pageerror', function (e) { fehler.push(e.message); });
    await seite.goto(server.basis + '/');
    await seite.evaluate(async function () {
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'louis', passwort: 'geheim123' }) });
    });
    await seite.reload();
    await seite.waitForSelector('[data-act="seite"]');
    const thema = function () { return seite.getAttribute('#app', 'data-theme'); };
    const umschalten = async function () {
      await seite.evaluate(function () { document.querySelector('[data-act="seite"]').click(); });
      await seite.evaluate(function () { document.querySelector('.seitenleiste [data-act="theme"]').click(); });
      const zusatz = await seite.textContent('.seitenleiste [data-act="theme"] .sl-zusatz');
      await seite.evaluate(function () { document.querySelector('[data-act="seite-zu"]').click(); });
      return zusatz;
    };

    assert.equal(await thema(), 'dark', 'ohne Wahl wie das Gerät');
    assert.equal(await seite.$('.top [data-act="theme"]'), null, 'kein Knopf mehr oben');
    assert.equal(await umschalten(), 'hell');
    assert.equal(await thema(), 'light');
    assert.equal(await umschalten(), 'dunkel');
    assert.equal(await umschalten(), 'wie das Gerät');
    await seite.emulateMedia({ colorScheme: 'light' });
    await seite.waitForFunction(function () { return document.getElementById('app').getAttribute('data-theme') === 'light'; });

    // Stilles Speichern (Status einer Einheit weiterschalten) zeigt kurz „Gespeichert“
    assert.equal((await seite.textContent('.foot')).trim(), '');
    await seite.evaluate(function () { document.querySelector('[data-act="zu-objekte"]').click(); });
    await seite.click('.obj-head');
    await seite.click('[data-act="status"]');
    await seite.waitForSelector('.foot-frisch');
    await seite.waitForSelector('.foot-frisch.weg', { state: 'attached', timeout: 9000 });
    assert.deepEqual(fehler, []);
  } finally {
    await browser.close();
    await server.stoppen();
  }
});

test('Oberfläche Aufgaben: Filter, Wartet, Verlauf und Ziehen in den Zeitplan', { skip: pw ? false : 'Playwright nicht installiert' }, async function () {
  const heute = new Date().toISOString().slice(0, 10);
  const aufgaben = [
    { id: '1', content: 'Stadtwerke anrufen', priority: 1, project_id: '1', labels: ['Technik'], description: 'Rechnung zu hoch', due: { date: heute, is_recurring: false } },
    { id: '2', content: 'Aldo nachfragen', priority: 1, project_id: '1', labels: ['Wartet-auf-Antwort'], due: { date: '2099-01-01', is_recurring: false } },
    { id: '3', content: 'Nebenkosten wegschicken', priority: 1, project_id: '1', labels: [], due: { date: heute, is_recurring: false } }
  ];
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
    await seite.goto(server.basis + '/');
    await seite.evaluate(async function () {
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'louis', passwort: 'geheim123' }) });
    });
    await seite.reload();
    await seite.waitForSelector('.tagkarte [data-zieh="1"]');

    // Ziehen: „Stadtwerke anrufen“ auf 16 Uhr im Zeitplan
    const achse = await seite.$('.tagkarte .zeitachse');
    const box = await achse.boundingBox();
    const hoehe = await seite.evaluate(function () { return parseFloat(document.querySelector('.tagkarte .zstunde:nth-child(2)').style.top); });
    await seite.dragAndDrop('.tagkarte [data-zieh="1"]', '.tagkarte .zeitachse', { targetPosition: { x: box.width / 2, y: hoehe * 16 + 2 } });
    await seite.waitForFunction(function () { return document.querySelector('.toast') && /16:00/.test(document.querySelector('.toast').textContent); });
    const zeit = todoist.aenderungen.find(function (a) { return a.id === '1'; });
    assert.equal(zeit.koerper.due_datetime, heute + 'T16:00:00');

    // Aufgaben-Seite: Wartet-Liste und Filter
    await seite.evaluate(function () { document.querySelector('[data-act="zu-aufgaben"]').click(); });
    await seite.click('.td-seite [data-a="wartet"]');
    await seite.waitForSelector('text=Aldo nachfragen');
    await seite.click('.td-seite [data-a="alle"]');
    await seite.click('.td-fchip[data-wert="Technik"]');
    assert.equal(await seite.$('.td-zeile[data-tid="3"]'), null, 'Filter Technik blendet Nebenkosten aus');
    await seite.click('.td-fchip[data-wert="Technik"]');
    await seite.waitForSelector('.td-zeile[data-tid="3"]');

    // Wartet setzen: Label dazu, Datum in 3 Tagen
    await seite.click('.td-zeile[data-tid="3"] [data-act="td-menue"][data-typ="mehr"]');
    await seite.click('[data-act="td-menue"][data-typ="warten"]');
    await seite.click('[data-act="td-warten"][data-tage="3"]');
    await seite.waitForFunction(function () { return /Wartet — nachfassen/.test((document.querySelector('.toast') || {}).textContent || ''); });
    const warten = todoist.aenderungen.filter(function (a) { return a.id === '3'; }).pop().koerper;
    assert.deepEqual(warten.labels, ['Wartet-auf-Antwort']);
    assert.ok(warten.due_date > heute);

    // Verlauf: Datum kommt automatisch davor
    await seite.click('.td-zeile[data-tid="1"] .td-mitte');
    await seite.waitForSelector('#t-verlauf');
    await seite.fill('#t-verlauf', 'Mail an Stadtwerke geschickt');
    await seite.click('[data-act="t-verlauf"]');
    await seite.waitForFunction(function () { return /Verlauf:/.test(document.querySelector('#t-besch').value); });
    const besch = todoist.aenderungen.filter(function (a) { return a.id === '1' && a.koerper.description; }).pop().koerper.description;
    assert.match(besch, /^Rechnung zu hoch\n\nVerlauf:\n\d\d\.\d\d\. Mail an Stadtwerke geschickt$/);
    assert.deepEqual(fehler, []);
  } finally {
    await browser.close();
    await server.stoppen();
    todoist.stoppen();
  }
});
