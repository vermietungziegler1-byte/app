'use strict';

// Kaufrechner: Suchauftrags-Mails lesen und Angebote durchrechnen

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const K = require(path.join(__dirname, '..', '..', 'public', 'kaufrechner.js'));

// So sieht der Textteil einer Suchauftrags-Mail von ImmoScout24 aus
const KAUFMAIL = [
  'Ihre Suche:',
  '-------------------------------------------------------------',
  '2 neue Angebote',
  'zu deiner gespeicherten Suche Wohnung kaufen, in Waiblingen',
  '-------------------------------------------------------------',
  'Titel: Gepflegte 3-Zimmer-Wohnung mit Balkon',
  '',
  'Link: https://push.search.is24.de/email/expose/111222333?PID=1&savedSearchId=2&referrer=ff_listing',
  'Adresse: Musterweg 3, Waiblingen, Rems-Murr-Kreis',
  'Kaufpreis: 249.000 €',
  'Wohnfläche: 72,5 m²',
  'Zimmer: 3',
  'Balkon/Terrasse, Keller',
  '',
  'Titel: Doppelhaushälfte mit Garten',
  '',
  'Link: https://push.search.is24.de/email/expose/444555666?PID=1',
  'Adresse: Korb, Rems-Murr-Kreis',
  'Kaufpreis: 549.000 €',
  'Wohnfläche: 128 m²',
  'Zimmer: 5',
  'Grundstück: 310 m²',
  '',
  '-------------------------------------------------------------',
  'Alle Angebote ansehen'
].join('\n');

const MIETMAIL = [
  'zu deiner gespeicherten Suche Mietwohnung, in Waiblingen',
  'Titel: Zuhause mit 4,5 Zimmern in Waiblingen',
  'Link: https://push.search.is24.de/email/expose/170000001?PID=1',
  'Adresse: Waiblingen, Rems-Murr-Kreis',
  'Kaltmiete: 997–1.103 €',
  'Wohnfläche: 113 m²',
  'Zimmer: 4,5'
].join('\n');

test('Zahlen wie in Anzeigen: Tausenderpunkt, Komma, Spannen', function () {
  assert.equal(K.zahl('249.000 €'), 249000);
  assert.equal(K.zahl('72,5 m²'), 72.5);
  assert.equal(K.zahl('997–1.103 €'), 1050);
  assert.equal(K.zahl('3.57'), 3.57);
  assert.equal(K.zahl('3,57'), 3.57);
  assert.equal(K.zahl(''), null);
});

test('Suchauftrags-Mail: Kaufangebote mit allen Angaben', function () {
  const a = K.mailLesen(KAUFMAIL, '2 Angebote: Wohnung kaufen, in Waiblingen');
  assert.equal(a.length, 2);
  assert.deepEqual(
    { id: a[0].id, art: a[0].art, typ: a[0].typ, ort: a[0].ort, preis: a[0].preis, flaeche: a[0].flaeche, zimmer: a[0].zimmer, url: a[0].url },
    { id: 'is24:111222333', art: 'kauf', typ: 'wohnung', ort: 'Waiblingen', preis: 249000, flaeche: 72.5, zimmer: 3,
      url: 'https://www.immobilienscout24.de/expose/111222333' });
  assert.equal(a[0].merkmale, 'Balkon/Terrasse, Keller');
  assert.equal(a[1].typ, 'haus');
  assert.equal(a[1].ort, 'Korb');
  assert.equal(a[1].grundstueck, 310);
});

test('Suchauftrags-Mail: Mietangebote werden als Miete erkannt', function () {
  const a = K.mailLesen(MIETMAIL, '1 Angebot: Mietwohnung, in Waiblingen');
  assert.equal(a.length, 1);
  assert.equal(a[0].art, 'miete');
  assert.equal(a[0].preis, 1050);
  assert.equal(a[0].zimmer, 4.5);
});

test('Marktmiete: Mitte der Angebote im Ort, Ausreißer bleiben draußen', function () {
  const miete = [10, 11, 12, 13, 14].map(function (qm) { return { ort: 'Waiblingen', preis: qm * 50, flaeche: 50 }; })
    .concat([{ ort: 'Waiblingen', preis: 631000, flaeche: 26 }, { ort: 'Korb', preis: 500, flaeche: 50 }]);
  const mm = K.marktmiete(miete, 'Waiblingen');
  assert.equal(mm.proQm, 12);
  assert.equal(mm.anzahl, 5);
  assert.equal(mm.ort, 'Waiblingen');
  // In Korb zu wenig — dann alle Orte zusammen
  assert.equal(K.marktmiete(miete, 'Korb').ort, null);
  assert.equal(K.marktmiete([], 'Korb'), null);
});

test('Durchrechnen: Kennzahlen einer typischen Wohnung', function () {
  const r = K.rechnen({ preis: 290000, flaeche: 72, typ: 'wohnung' }, {}, { mieteProQm: 13.5 });
  assert.equal(r.vollstaendig, true);
  assert.equal(r.mieteGeschaetzt, true);
  assert.equal(Math.round(r.miete), 875);                 // 72 m² × 13,50 € − 10 %
  assert.equal(Math.round(r.nebenkosten), 30653);         // 10,57 %
  assert.equal(Math.round(r.darlehen), 232000);           // 80 % finanziert
  assert.equal(Math.round(r.eigenkapital), 88653);        // 20 % + Nebenkosten
  assert.equal(r.brutto.toFixed(2), '3.62');
  assert.equal(r.faktor.toFixed(1), '27.6');
  assert.equal(Math.round(r.cashflow), -366);
  assert.ok(r.steuerJahr < 0, 'Verlust bringt Steuererstattung');
  assert.equal(Math.round(r.cashflowNachSteuer), -206);
  assert.equal(r.urteil, 'schwach');
});

test('Durchrechnen: echte Miete, Hausgeld und provisionsfrei', function () {
  const r = K.rechnen({ preis: 200000, flaeche: 70, miete: 1000, hausgeld: 120, makler: 0 }, {}, {});
  assert.equal(r.mieteGeschaetzt, false);
  assert.equal(r.nebenkostenProzent, 7);
  assert.equal(r.laufend, 1440);
  assert.equal(r.brutto, 6);
  assert.equal(r.urteil, 'gut');
});

test('Durchrechnen: ohne Preis oder Fläche keine Punkte', function () {
  const r = K.rechnen({ preis: 200000 }, {}, {});
  assert.equal(r.vollstaendig, false);
  assert.deepEqual(r.fehlt, ['Wohnfläche']);
  assert.equal(r.punkte, null);
});

test('Zielpreis: bis wohin es ein gutes Angebot wäre', function () {
  const a = { preis: 290000, flaeche: 72 };
  const ziel = K.zielpreis(a, {}, { mieteProQm: 13.5 });
  assert.ok(ziel > 100000 && ziel < 290000, String(ziel));
  assert.ok(K.rechnen(Object.assign({}, a, { preis: ziel }), {}, { mieteProQm: 13.5 }).punkte >= 70);
  assert.ok(K.rechnen(Object.assign({}, a, { preis: ziel + 5000 }), {}, { mieteProQm: 13.5 }).punkte < 70);
});

test('Annahmen: eigene Werte gelten, Unsinn fällt auf den Standard zurück', function () {
  const p = K.annahmenMitStandard({ zins: 4.2, tilgung: '', ekProzent: 'abc' });
  assert.equal(p.zins, 4.2);
  assert.equal(p.tilgung, K.STANDARD.tilgung);
  assert.equal(p.ekProzent, K.STANDARD.ekProzent);
});

test('Automatisch ergänzen: Fläche, Renovierung, provisionsfrei, Miete und Neubau aus der Anzeige', function () {
  const b = function (titel, x) { return K.bewerten(Object.assign({ titel: titel, preis: 250000, zimmer: 3, ort: 'Waiblingen' }, x || {}), {}, [], []); };

  let r = b('Renovierungsbedürftige 3-Zimmer-Wohnung, provisionsfrei');
  assert.equal(r.vollstaendig, true, 'ohne Fläche in der Mail trotzdem durchgerechnet');
  assert.equal(r.flaeche, 81);                         // 3 Zimmer × 27 m²
  assert.equal(r.ergaenzt.renovierung, 32000);         // 81 m² × 400 €
  assert.equal(r.renovierung, 32000);
  assert.equal(r.ergaenzt.makler, 0);
  assert.equal(r.nebenkostenProzent, 7);

  assert.equal(b('Neubau-Erstbezug 85 m² mit Balkon').flaeche, 85);
  assert.equal(b('Neubau-Erstbezug 85 m² mit Balkon').ergaenzt.afa, 3);
  assert.equal(b('Erstbezug nach Sanierung').ergaenzt.afa, undefined);
  assert.equal(b('Kapitalanlage: Mieteinnahmen 780 € mtl.').miete, 780);
  assert.equal(b('Kapitalanlage: Jahresmiete 9.600 € p.a.').miete, 800);
  assert.equal(b('Kapitalanlage mit 4,2 % Rendite').miete, 875);
  assert.ok(b('Kapitalanlage, vermietet').warum.vermietet);

  // Selbst Eingetragenes schlägt jede Schätzung
  r = b('Renovierungsbedürftig, provisionsfrei', { flaeche: 60, renovierung: 0, makler: 3.57 });
  assert.deepEqual(r.ergaenzt, {});
  assert.equal(r.renovierung, 0);
});

test('Automatisch ergänzen: m² pro Zimmer aus den Angeboten im Ort', function () {
  const umfeld = [1, 2, 3, 4, 5].map(function () { return { ort: 'Korb', flaeche: 100, zimmer: 4 }; });
  assert.equal(K.qmProZimmer(umfeld, 'Korb'), 25);
  const r = K.bewerten({ titel: 'Wohnung', preis: 200000, zimmer: 2, ort: 'Korb' }, {}, umfeld, []);
  assert.equal(r.flaeche, 50);
});

test('Renovierung drückt Rendite und Punkte', function () {
  const ohne = K.rechnen({ preis: 200000, flaeche: 80 }, {}, { mieteProQm: 14 });
  const mit = K.rechnen({ preis: 200000, flaeche: 80, renovierung: 40000 }, {}, { mieteProQm: 14 });
  assert.equal(mit.brutto.toFixed(2), (ohne.brutto * 200000 / 240000).toFixed(2));
  assert.ok(mit.punkte < ohne.punkte);
});
