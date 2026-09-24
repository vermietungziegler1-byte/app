'use strict';

// Prüft den Rechenkern des Tagesplaners ohne Todoist.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planen, einstellungenPruefen, dauerSchaetzen, luecken } = require('../lib/planer-kern');

const DONNERSTAG = '2026-09-24';
const E = { start: '08:00', ende: '17:00', pauseVon: '12:00', pauseBis: '13:00', puffer: 10, maxMinuten: 360, standardDauer: 30 };

function aufgabe(id, extra) {
  return Object.assign({ id: String(id), inhalt: 'Aufgabe ' + id, faellig: DONNERSTAG, prioritaet: 1, dauer: 30 }, extra || {});
}

test('Lücken: Arbeitszeit minus Termine, mit Puffer danach', function () {
  assert.deepEqual(luecken(480, 1020, [{ von: 600, bis: 660 }], 10), [[480, 600], [670, 1020]]);
  assert.deepEqual(luecken(480, 600, [{ von: 400, bis: 700 }], 10), []);
});

test('Dauer: Todoist-Dauer zuerst, sonst nach Worten geschätzt', function () {
  const e = einstellungenPruefen({});
  assert.deepEqual(dauerSchaetzen({ inhalt: 'irgendwas', dauer: 45 }, e), { dauer: 45, geschaetzt: false });
  assert.equal(dauerSchaetzen({ inhalt: 'Markus anrufen wegen Boot' }, e).dauer, 15);
  assert.equal(dauerSchaetzen({ inhalt: 'Lampe aus dem Häusle mitbringen' }, e).dauer, 60);
  assert.equal(dauerSchaetzen({ inhalt: 'Nebenkosten' }, e).dauer, 30);
});

test('Blöcke beginnen um 8, halten Puffer ein und respektieren die Mittagspause', function () {
  const p = planen({ datum: DONNERSTAG, einstellungen: E, aufgaben: [
    aufgabe(1, { dauer: 120 }), aufgabe(2, { dauer: 120 }), aufgabe(3, { dauer: 60 })
  ] });
  // 1 passt ab 8 Uhr; 2 (zwei Stunden) passt nicht mehr vor die Pause und kommt um 13 Uhr;
  // 3 füllt die Lücke nach dem ersten Block (10 Minuten Puffer)
  assert.deepEqual(p.bloecke.map(function (b) { return [b.id, b.von, b.bis]; }), [
    ['1', '08:00', '10:00'],
    ['3', '10:10', '11:10'],
    ['2', '13:00', '15:00']
  ]);
  assert.equal(p.verschoben.length, 0);
});

test('Termine aus dem Kalender und feste Uhrzeiten werden umgangen', function () {
  const p = planen({ datum: DONNERSTAG, einstellungen: E,
    termine: { [DONNERSTAG]: [{ von: 8 * 60, bis: 9 * 60 }] },
    aufgaben: [aufgabe(1, { faelligZeit: DONNERSTAG + 'T09:30', dauer: 60 }), aufgabe(2, { dauer: 30 })] });
  assert.deepEqual(p.fest.map(function (f) { return f.id; }), ['1']);
  assert.equal(p.bloecke[0].id, '2');
  // 09:10–09:30 ist zu kurz für 30 Minuten, also nach der festen Aufgabe (bis 10:30) plus Puffer
  assert.equal(p.bloecke[0].von, '10:40');
});

test('Wichtigstes zuerst: Priorität, dann am längsten überfällig', function () {
  const p = planen({ datum: DONNERSTAG, einstellungen: Object.assign({}, E, { maxMinuten: 60 }), aufgaben: [
    aufgabe('neu', { faellig: DONNERSTAG }),
    aufgabe('alt', { faellig: '2026-09-10' }),
    aufgabe('wichtig', { faellig: DONNERSTAG, prioritaet: 4 })
  ] });
  assert.deepEqual(p.bloecke.map(function (b) { return b.id; }).sort(), ['alt', 'wichtig']);
  assert.deepEqual(p.verschoben.map(function (v) { return [v.id, v.nach]; }), [['neu', '2026-09-25']]);
});

test('Überfälliges wird auf Arbeitstage verteilt, das Wochenende bleibt frei', function () {
  const viele = [];
  for (let i = 0; i < 30; i++) viele.push(aufgabe('a' + i, { faellig: '2026-09-1' + (i % 9), dauer: 60 }));
  const p = planen({ datum: DONNERSTAG, einstellungen: E, aufgaben: viele });
  assert.equal(p.bloecke.length, 6);                         // 6 Stunden heute
  const tage = {};
  p.verschoben.forEach(function (v) { tage[v.nach] = (tage[v.nach] || 0) + 1; });
  assert.deepEqual(tage, { '2026-09-25': 6, '2026-09-28': 6, '2026-09-29': 6, '2026-09-30': 6 });
  assert.equal(p.ohnePlatz.length, 0);
});

test('Tage, an denen schon Aufgaben fällig sind, bekommen entsprechend weniger dazu', function () {
  const p = planen({ datum: DONNERSTAG, einstellungen: Object.assign({}, E, { maxMinuten: 60 }), aufgaben: [
    aufgabe('heute', { dauer: 60 }),
    aufgabe('morgenSchon', { faellig: '2026-09-25', dauer: 60 }),
    aufgabe('zuViel', { faellig: '2026-09-20', dauer: 60 })
  ] });
  // Die ältere Aufgabe bekommt heute den Platz; Freitag ist mit der dort fälligen schon voll → Montag
  assert.deepEqual(p.bloecke.map(function (b) { return b.id; }), ['zuViel']);
  assert.deepEqual(p.verschoben.map(function (v) { return [v.id, v.nach]; }), [['heute', '2026-09-28']]);
});

test('Wiederkehrende Aufgaben werden nie verplant oder verschoben', function () {
  const p = planen({ datum: DONNERSTAG, einstellungen: E, aufgaben: [
    aufgabe('routine', { wiederkehrend: true, faellig: '2026-09-20' }), aufgabe(2)
  ] });
  assert.deepEqual(p.wiederkehrend.map(function (w) { return w.id; }), ['routine']);
  assert.equal(p.bloecke.length, 1);
  assert.ok(!p.verschoben.some(function (v) { return v.id === 'routine'; }));
});

test('Am Wochenende wird nichts verplant, alles geht auf Montag', function () {
  const p = planen({ datum: '2026-09-26', einstellungen: E, aufgaben: [aufgabe(1, { faellig: '2026-09-26' })] });
  assert.equal(p.bloecke.length, 0);
  assert.deepEqual(p.verschoben.map(function (v) { return v.nach; }), ['2026-09-28']);
});

test('Heute ab jetzt: nichts wird in die Vergangenheit gelegt', function () {
  const p = planen({ datum: DONNERSTAG, jetztMin: 14 * 60 + 7, einstellungen: E, aufgaben: [aufgabe(1)] });
  assert.equal(p.bloecke[0].von, '14:15');
});

test('Vom Planer gelegte Blöcke dürfen neu gelegt werden, selbst gesetzte Uhrzeiten nicht', function () {
  const aufgaben = [
    aufgabe('meins', { faelligZeit: DONNERSTAG + 'T09:00' }),
    aufgabe('planer', { faelligZeit: DONNERSTAG + 'T08:00' })
  ];
  const p = planen({ datum: DONNERSTAG, jetztMin: 10 * 60, einstellungen: E, aufgaben: aufgaben, vomPlaner: ['planer'] });
  assert.deepEqual(p.fest.map(function (f) { return f.id; }), ['meins']);
  assert.equal(p.bloecke[0].id, 'planer');
  assert.equal(p.bloecke[0].von, '10:00');
});

test('Einstellungen: Unsinn wird abgefangen', function () {
  const e = einstellungenPruefen({ start: '18:00', ende: '08:00', puffer: -5, maxMinuten: 99999, arbeitstage: [9, 1, 1] });
  assert.equal(e.start, '08:00');
  assert.equal(e.puffer, 0);
  assert.equal(e.maxMinuten, 16 * 60);
  assert.deepEqual(e.arbeitstage, [1]);
});
