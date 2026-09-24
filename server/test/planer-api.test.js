'use strict';

// Tagesplaner von außen: Vorschlag, Übernehmen in (nachgebautes) Todoist, Rückgängig.

const test = require('node:test');
const assert = require('node:assert/strict');
const { serverStarten, sitzung, fakeTodoist } = require('./hilfe');

// Montag, 7. Januar 2030 — weit weg von "jetzt", damit der Plan den ganzen Tag nutzen kann
const MONTAG = '2030-01-07';

test('Tagesplan: Vorschlag, Übernehmen und Rückgängig', async function () {
  const aufgaben = [
    { id: '1', content: 'Stadtwerke anrufen', priority: 4, due: { date: '2030-01-02', is_recurring: false } },
    { id: '2', content: 'Nebenkosten wegschicken', priority: 1, due: { date: '2030-01-03', is_recurring: false } },
    { id: '3', content: 'Müllmarken jeden Montag', priority: 1, due: { date: '2030-01-07', is_recurring: true, string: 'jeden Montag' } },
    { id: '4', content: 'Termin Handwerker', priority: 1, due: { date: '2030-01-07T09:00:00', is_recurring: false }, duration: { amount: 60, unit: 'minute' } },
    { id: '5', content: 'Irgendwann', priority: 1, due: null }
  ];
  const todoist = await fakeTodoist(aufgaben);
  const server = await serverStarten({ TODOIST_BASIS: todoist.basis });
  try {
    const louis = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.put('/api/todoist', { token: 'test' });

    // Vorschlag ändert nichts
    let a = await louis.get('/api/plan?datum=' + MONTAG);
    assert.equal(a.status, 200, a.text);
    assert.equal(todoist.aenderungen.length, 0);
    assert.deepEqual(a.json.bloecke.map(function (b) { return [b.id, b.von, b.bis]; }), [
      ['1', '08:00', '08:15'],     // wichtig und Anruf → 15 Minuten, zuerst
      ['2', '08:25', '08:40']      // danach mit 10 Minuten Puffer; "wegschicken" → 15 Minuten
    ]);
    assert.deepEqual(a.json.fest.map(function (f) { return f.id; }), ['4']);
    assert.deepEqual(a.json.wiederkehrend.map(function (w) { return w.id; }), ['3']);

    // Übernehmen: Uhrzeit in UTC (Januar: Berlin = UTC+1) und Dauer landen in Todoist
    a = await louis.post('/api/plan', { datum: MONTAG });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.geaendert, 2);
    assert.deepEqual(a.json.fehler, []);
    const zu1 = todoist.aenderungen.find(function (x) { return x.id === '1'; }).koerper;
    assert.deepEqual(zu1, { due_datetime: '2030-01-07T07:00:00Z', duration: 15, duration_unit: 'minute' });
    assert.ok(!todoist.aenderungen.some(function (x) { return x.id === '3' || x.id === '4'; }), 'Wiederkehrendes und Festes bleiben');

    // Nochmal planen: die Blöcke stehen schon so in Todoist → nichts zu tun
    a = await louis.get('/api/plan?datum=' + MONTAG);
    assert.equal(a.json.aenderungen, 0);
    assert.ok(a.json.letzteUebernahme);

    // Rückgängig: alte Daten zurück
    a = await louis.post('/api/plan/rueckgaengig', { datum: MONTAG });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.zurueck, 2);
    assert.equal(aufgaben[0].due.date, '2030-01-02');
    assert.equal(aufgaben[1].due.date, '2030-01-03');

    // Ein zweites Rückgängig gibt es nicht
    a = await louis.post('/api/plan/rueckgaengig', { datum: MONTAG });
    assert.equal(a.status, 400);
  } finally {
    await server.stoppen();
    todoist.stoppen();
  }
});

test('Tagesplan-Einstellungen: nur der Verwalter ändert sie, Unsinn wird abgefangen', async function () {
  const server = await serverStarten();
  try {
    const louis = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    let a = await louis.put('/api/plan/einstellungen', { start: '07:30', maxMinuten: 240, puffer: 999, automatisch: true });
    assert.equal(a.status, 200);
    assert.equal(a.json.start, '07:30');
    assert.equal(a.json.puffer, 60);
    assert.equal(a.json.automatisch, true);
    await louis.post('/api/users', { name: 'papa', passwort: 'papa12345' });
    const papa = sitzung(server);
    await papa.post('/api/login', { name: 'papa', passwort: 'papa12345' });
    assert.equal((await papa.put('/api/plan/einstellungen', { start: '05:00' })).status, 403);
    assert.equal((await papa.get('/api/plan/einstellungen')).json.start, '07:30');
  } finally {
    await server.stoppen();
  }
});

test('Automatik plant einmal am Tag, die Mitteilung bekommt eine kurze Zeile', async function () {
  const fs = require('fs'), os = require('os'), path = require('path');
  const aufgaben = [
    { id: '1', content: 'Stadtwerke anrufen', priority: 4, due: { date: '2030-01-02', is_recurring: false } },
    { id: '2', content: 'Nebenkosten wegschicken', priority: 1, due: { date: '2030-01-03', is_recurring: false } }
  ];
  const todoist = await fakeTodoist(aufgaben);
  // Den Baustein direkt laden — mit eigener Wegwerf-Datenbank und dem nachgebauten Todoist
  process.env.DATEN = fs.mkdtempSync(path.join(os.tmpdir(), 'vermietung-auto-'));
  process.env.TODOIST_BASIS = todoist.basis;
  try {
    const { einstellungSetzen } = require('../lib/kern');
    const planer = require('../lib/planer');
    einstellungSetzen('todoist_token', 'test');

    assert.equal(await planer.automatischPlanen(MONTAG), null, 'ohne Automatik passiert nichts');
    einstellungSetzen('planer', JSON.stringify({ automatisch: true }));

    const [a, b] = await Promise.all([planer.automatischPlanen(MONTAG), planer.automatischPlanen(MONTAG)]);
    assert.equal(a.bloecke.length, 2);
    assert.deepEqual(b, a);
    assert.equal(todoist.aenderungen.length, 2, 'gleichzeitige Aufrufe planen nur einmal');
    await planer.automatischPlanen(MONTAG);
    assert.equal(todoist.aenderungen.length, 2, 'am selben Tag kein zweites Mal');

    assert.equal(planer.planKurztext(a.bloecke, 5),
      '08:00 Stadtwerke anrufen · 08:25 Nebenkosten wegschicken · 5 Aufgaben auf die nächsten Tage verteilt');
  } finally {
    todoist.stoppen();
  }
});
