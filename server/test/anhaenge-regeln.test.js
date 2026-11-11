'use strict';

// Anhänge aus dem Postfach: was zählt, was liegt schon in Drive, wohin gehört welche Art — ohne Postfach, ohne Google.

const test = require('node:test');
const assert = require('node:assert/strict');
const ar = require('../lib/anhaenge-regeln');
const { woerterbuch } = require('../lib/dokumente-regeln');

const wb = woerterbuch({ objects: [
  { id: 't', name: 'Tribergle 22, 71409 Schwaikheim', units: [{ id: 'teg', name: 'EG Wohnung', tenant: 'Simone Krötz' }] },
  { id: 'b', name: 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen', units: [] }
] }, ['Louis Ziegler']);

test('Welche Anhänge taugen', function () {
  assert.equal(ar.taugt({ name: 'Rechnung 2026110205.pdf', typ: 'application/pdf', groesse: 80000 }), true);
  assert.equal(ar.taugt({ name: 'image001.png', typ: 'image/png', groesse: 4000 }), false, 'Logo in der Signatur');
  assert.equal(ar.taugt({ name: 'Foto Wasserschaden.jpg', typ: 'image/jpeg', groesse: 900000 }), true);
  assert.equal(ar.taugt({ name: 'Foto.jpg', typ: 'image/jpeg', groesse: 900000, inline: true }), false, 'eingebettet');
  assert.equal(ar.taugt({ name: 'einladung.ics', typ: 'text/calendar', groesse: 3000 }), false);
  assert.equal(ar.taugt({ name: 'smime.p7s', typ: 'application/pkcs7-signature', groesse: 5000 }), false);
});

test('Welche Mails zur Vermietung gehören könnten', function () {
  assert.equal(ar.relevant({ betreff: 'Rechnung – 2026110205', anhaenge: 'RE_2026110205.pdf', text: '' }, wb), 'wort', 'nur das Wort: der Assistent liest den Inhalt nicht');
  assert.equal(ar.relevant({ betreff: 'Ihre Gehaltsabrechnung', anhaenge: 'Gehaltsabrechnung_Oktober.pdf', text: '' }, wb), '', 'Abrechnung nur als ganzes Wort');
  assert.equal(ar.relevant({ betreff: 'Ihre Unterlagen', von_name: 'Stadtwerke Waiblingen', anhaenge: 'Dokument.pdf', text: '' }, wb), 'wort');
  assert.equal(ar.relevant({ betreff: 'Nebenkostenabrechnung 2025', anhaenge: 'NKA.pdf', text: '' }, wb), 'wort');
  assert.equal(ar.relevant({ betreff: 'Unterlagen', anhaenge: 'scan.pdf', text: 'für das Haus Tribergle 22' }, wb), 'objekt', 'Objekt im Text');
  assert.equal(ar.relevant({ betreff: 'Fotos vom Urlaub', anhaenge: 'IMG_1.jpg', text: 'Liebe Grüße aus Italien' }, wb), '');
});

test('Arten, Kategorien und Ordner', function () {
  assert.equal(ar.kategorie('Nebenkosten-Rechnung'), 'nk');
  assert.equal(ar.kategorie('Rechnung'), 'rechnung');
  assert.equal(ar.kategorie('Nebenkostenabrechnung'), 'abr');
  assert.equal(ar.kategorie('Mietvertrag'), 'mieter');
  assert.equal(ar.KATEGORIEN.nk.neu, '02 Nebenkosten');
  assert.equal(ar.KATEGORIEN.rechnung.neu, '03 Rechnungen');
  assert.ok(ar.KATEGORIEN.nk.muster.test('02 Nebenkosten'));
  assert.ok(ar.KATEGORIEN.rechnung.muster.test('03 Rechnungen'));
  assert.equal(ar.dokArt('Nebenkostenabrechnung'), 'Nebenkosten');
  assert.equal(ar.dokArt('Bescheid'), 'Steuer');
  assert.equal(ar.dokArt('Nebenkosten-Rechnung'), 'Nebenkosten-Rechnung');
});

test('Ohne Assistent: Objekt aus Betreff, Art aus dem Namen, Jahr aus Datum', function () {
  const m = { betreff: 'Stromabrechnung Tribergle 22', von: 'Stadtwerke <info@stadtwerke.de>', text: '', datum: Date.parse('2026-03-03T10:00:00Z') };
  const r = ar.ohneAssistent(m, { name: 'Rechnung_Strom.pdf' }, wb);
  assert.equal(r.objekt, 't');
  assert.equal(r.art, 'Rechnung');
  assert.equal(r.jahr, '2026');
  assert.equal(ar.dateiname('2026-03-03 Stromabrechnung 2025', { name: 'Rechnung_Strom.pdf' }, m, 'Rechnung'), '2026-03-03 Stromabrechnung 2025.pdf');
  assert.equal(ar.dateiname('', { name: 'RE_123.pdf' }, m, 'Rechnung'), '2026-03-03 Rechnung Stadtwerke RE_123.pdf');
});
