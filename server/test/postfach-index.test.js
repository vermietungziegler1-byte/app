'use strict';

// Suchverzeichnis: Wortteile, Umlaute, Absender, Zeitraum, Anhang, Ordner, Fundstelle, Top-Treffer.

const test = require('node:test');
const assert = require('node:assert/strict');
const ix = require('../lib/postfach-index');

const tag = function (s) { return new Date(s + 'T12:00:00Z').getTime(); };
function verzeichnis() {
  const v = ix.oeffnen(':memory:');
  ix.eintragen(v, { ordner: 'INBOX', uid: 1, datum: tag('2026-10-05'), vonName: 'Stadtwerke Waiblingen', vonAdresse: 'rechnung@stadtwerke-waiblingen.de',
    an: 'Louis Ziegler <louis@example.org>', betreff: 'Ihre Online-Rechnung', text: 'Ihre Stromrechnung für September liegt bei.', anhang: true, anhaenge: 'Rechnung_09.pdf' });
  ix.eintragen(v, { ordner: 'INBOX', uid: 2, datum: tag('2026-11-01'), vonName: 'Herr Müller', vonAdresse: 'mueller@example.org',
    betreff: 'Heizung', text: 'Die Therme im Keller ist ausgefallen, bitte schnell melden.' });
  ix.eintragen(v, { ordner: 'Gesendet', uid: 7, datum: tag('2025-03-10'), vonName: 'Louis Ziegler', vonAdresse: 'louis@example.org',
    an: 'Hausverwaltung <hv@example.org>', betreff: 'Nebenkostenabrechnung 2024', text: 'Anbei die Abrechnung.' });
  ix.eintragen(v, { ordner: 'INBOX', uid: 3, datum: tag('2024-01-01'), vonName: 'Amazon', vonAdresse: 'bestellung@amazon.de',
    betreff: 'Ihre Bestellung', text: 'Die Rechnung finden Sie im Kundenkonto.', gelesen: true });
  return v;
}
const uids = function (r) { return r.top.concat(r.mails).map(function (m) { return m.uid; }).sort(); };

test('Verzeichnis: Trigramme sind da und finden Wortteile', function () {
  const v = verzeichnis();
  assert.equal(v.trigram, true, 'SQLite kann FTS5 mit Trigrammen');
  // „rechnung“ steckt in Stromrechnung, Nebenkostenabrechnung, Online-Rechnung und im Text der Amazon-Mail
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['rechnung']] })), [1, 3, 7]);
  assert.equal(ix.anzahl(v), 4);
});

test('Verzeichnis: Umlaute, Absender, Empfänger', function () {
  const v = verzeichnis();
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['Müller']] })), [2], 'Müller findet auch mueller@');
  assert.deepEqual(uids(ix.suchen(v, { absender: ['stadtwerke'] })), [1]);
  assert.deepEqual(uids(ix.suchen(v, { empfaenger: ['Hausverwaltung'] })), [7]);
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['Therme', 'Heizung'], ['Keller']] })), [2], 'Gruppen: eine Schreibweise je Gruppe reicht, alle Gruppen müssen passen');
});

test('Verzeichnis: Zeitraum, Anhang, Ordner und Fundstelle', function () {
  const v = verzeichnis();
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['rechnung']], seit: tag('2026-01-01') })), [1]);
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['rechnung']], nurAnhang: true })), [1]);
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['rechnung']], nurOrdner: ['Gesendet'] })), [7]);
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['rechnung']], ohneOrdner: ['Gesendet'] })), [1, 3]);
  const r = ix.suchen(v, { gruppen: [['Therme']] });
  assert.match(r.mails[0].ausschnitt, /\u0001Therme\u0002/i, 'das Suchwort ist in der Fundstelle markiert');
  assert.equal(r.mails[0].von.name, 'Herr Müller');
});

test('Verzeichnis: Top-Treffer nach Relevanz, der Rest nach Datum', function () {
  const v = verzeichnis();
  for (let i = 0; i < 6; i++) {
    ix.eintragen(v, { ordner: 'Archiv', uid: 100 + i, datum: tag('2023-0' + (i + 1) + '-15'), vonName: 'Irgendwer', vonAdresse: 'x@example.org',
      betreff: i === 0 ? 'Rechnung Rechnung Rechnung' : 'Allerlei', text: i === 0 ? 'Rechnung' : 'Steht irgendwo: Rechnung.' });
  }
  const r = ix.suchen(v, { gruppen: [['rechnung']] });
  assert.equal(r.top.length, 3);
  assert.ok(r.top.some(function (m) { return m.uid === 100; }), 'Treffer im Betreff zählen viel');
  assert.ok(!r.top.some(function (m) { return m.uid === 101; }), 'ein Wort irgendwo im Text ist kein Top-Treffer');
  const daten = r.mails.map(function (m) { return m.datum; });
  assert.deepEqual(daten, daten.slice().sort().reverse(), 'die übrigen neueste zuerst');
  assert.equal(r.gesamt, 9);
});

test('Verzeichnis: entfernen, Merker, Ordner leeren', function () {
  const v = verzeichnis();
  ix.entfernen(v, 'INBOX', [1]);
  assert.deepEqual(uids(ix.suchen(v, { gruppen: [['rechnung']] })), [3, 7]);
  ix.merkerAendern(v, 'INBOX', [2], 'gelesen', true);
  assert.equal(ix.bekannte(v, 'INBOX').get(2).gelesen, 1);
  ix.ordnerLeeren(v, 'INBOX');
  assert.equal(ix.anzahl(v), 1);
  ix.ordnerAufraeumen(v, ['INBOX']);
  assert.equal(ix.anzahl(v), 0, 'Ordner, die es nicht mehr gibt, verschwinden');
});
