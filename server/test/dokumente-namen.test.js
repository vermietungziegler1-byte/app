'use strict';

// Dateinamen bewerten und aufräumen — ohne Google, ohne Assistent. Beispiele aus Louis' echtem Google Drive.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bewerten, aufraeumen, fotoName, dubletten, sauber, datumAusName, aufnahmeZeit } = require('../lib/dokumente-namen');

test('Was schlecht benannt ist', function () {
  assert.equal(bewerten('IMG_3654.HEIC', 'image/heif'), 'Handyfoto');
  assert.equal(bewerten('IMG_3162.jpg'), 'Handyfoto');
  assert.equal(bewerten('Scan_0418.pdf'), 'Scan');
  assert.equal(bewerten('2026-06-03 12.35 TINY SCANNER.pdf'), 'Scan');
  assert.equal(bewerten('Einzelabrechnung_047051557_2024_0002_0_Louis Ziegler_30_09_2025_1.pdf'), 'Code');
  assert.equal(bewerten('202605111257_nachmontage_zusammenfassung.pdf'), 'Code');
  assert.equal(bewerten('koelz_r_2025-05-06_07-54-28.pdf'), 'Code');
  assert.equal(bewerten('P__bergabe_Mietfl_che_D6-990_2025-08-29_unterzeichnet.pdf'), 'Umlaute');
  assert.equal(bewerten('Mietvertrag Benedikt von Bremen Kopie.pdf'), 'Kopie');
  assert.equal(bewerten('Einnahmen_und_Ausgaben_Dahlienweg7_korrigiert (3).xlsx'), 'Kopie');
  assert.equal(bewerten('Test Grok .xlsx'), 'Kleinigkeit');
  // gut benannt
  assert.equal(bewerten('Nebenkostenabrechnung Salatzki 2021.docx'), '');
  assert.equal(bewerten('Rechnung Hausverwaltung Dahlienweg 2023 003.docx'), '');
  assert.equal(bewerten('Dokument Stellplatzerhöhung Rafael Bertele.docx'), '', 'beginnt mit „Dokument“, sagt aber alles');
  assert.equal(bewerten('OG Mietvertrag 2022.pdf'), '');
});

test('Datum finden', function () {
  assert.deepEqual(datumAusName('202605111257_nachmontage_zusammenfassung'), { datum: '2026-05-11', rest: '_nachmontage_zusammenfassung' });
  assert.equal(datumAusName('Einzelabrechnung_047051557_2024_0002_0_Louis Ziegler_30_09_2025_1').datum, '2025-09-30');
  assert.equal(datumAusName('koelz_r_2025-05-06_07-54-28').datum, '2025-05-06');
  assert.equal(datumAusName('Rechnung 58 MS Ablesung').datum, '');
  assert.deepEqual(aufnahmeZeit('2025:06:14 12:35:10'), { datum: '2025-06-14', uhr: '12-35', sek: '12-35-10' });
});

test('Ohne Assistent aufräumen', function () {
  assert.equal(aufraeumen('202605111257_nachmontage_zusammenfassung.pdf'), '2026-05-11 Nachmontage zusammenfassung.pdf');
  assert.equal(aufraeumen('Test Grok .xlsx'), 'Test Grok.xlsx');
  assert.equal(aufraeumen('Mietvertrag Benedikt von Bremen Kopie.pdf', true), 'Mietvertrag Benedikt von Bremen.pdf');
  assert.equal(aufraeumen('Einnahmen_und_Ausgaben_Dahlienweg7_korrigiert (3).xlsx', false), 'Einnahmen und Ausgaben Dahlienweg7 korrigiert (3).xlsx');
});

test('Fotos: Datum vom Aufnahmetag, Ort aus Objekt und Wohnung, sprechender Ordner als Hinweis', function () {
  assert.equal(fotoName({ name: 'IMG_3654.HEIC', pfad: '/Firma/Bertha von Suttna/07 Sonstiges/Foto', aufnahme: '2025:06:14 12:35:10' }, 'Bertha-von-Suttner-Weg 4').name,
    '2025-06-14 Foto Bertha-von-Suttner-Weg 4.heic');
  assert.equal(fotoName({ name: 'IMG_1.jpg', pfad: '/Firma/Dahlienweg/Heizung', aufnahme: '' }, 'Dahlienweg 7').name, 'Foto Dahlienweg 7 Heizung.jpg');
  assert.equal(fotoName({ name: 'IMG_2.jpg', pfad: '/Firma/Dahlienweg/01 Mieteinheiten/DG Wohnung', aufnahme: '2024:01:02 08:00:00' }, 'Dahlienweg 7 DG Wohnung').name,
    '2024-01-02 Foto Dahlienweg 7 DG Wohnung.jpg');
});

test('Fast gleiche Dateien im selben Ordner', function () {
  const d = dubletten([
    { id: 'a', eltern: 'f', name: 'Einnahmen_und_Ausgaben_Dahlienweg7_korrigiert (1).xlsx' },
    { id: 'b', eltern: 'f', name: 'Einnahmen_und_Ausgaben_Dahlienweg7_korrigiert (2).xlsx' },
    { id: 'c', eltern: 'f', name: 'Mietvertrag Bremen.pdf' },
    { id: 'd', eltern: 'f', name: 'Mietvertrag Bremen Kopie.pdf' },
    { id: 'e', eltern: 'g', name: 'Mietvertrag Bremen Kopie.pdf' },
    { id: 'x', eltern: 'f', name: 'Einladung Deter.pdf' },
    { id: 'y', eltern: 'f', name: 'Einladung Deter.docx' }
  ]);
  assert.deepEqual(Array.from(d.keys()).sort(), ['a', 'b', 'd'], 'Original ohne „Kopie“ bleibt unmarkiert, anderer Ordner und andere Endung zählen nicht');
});

test('Vorschläge absichern', function () {
  assert.equal(sauber('2025-09-30 Heizkostenabrechnung 2024', 'x.pdf'), '2025-09-30 Heizkostenabrechnung 2024.pdf', 'Endung bleibt');
  assert.equal(sauber('Neu/Name.PDF', 'x.pdf'), 'Neu Name.PDF');
  assert.equal(sauber('Foto.jpg', 'IMG_1.HEIC'), 'Foto.heic', 'Bildendung nicht verwechseln');
  assert.equal(sauber('   ', 'x.pdf'), '');
  assert.equal(sauber('Übergabeprotokoll EG', 'Übergabeprotokoll'), 'Übergabeprotokoll EG', 'Google-Dokumente haben keine Endung');
});

test('Weitere echte Namen', function () {
  assert.equal(bewerten('22-01-27_18-310_BERTHA_WP-S2-VA.pdf'), 'Kleinigkeit', 'Planname, keine kaputten Umlaute');
  assert.equal(bewerten('Einnahmen_und_Ausgaben_Dahlienweg7_korrigiert.xlsx'), 'Kleinigkeit');
  assert.equal(bewerten('PHOTO-2025-08-14-18-52-45.jpg'), 'Handyfoto');
  assert.equal(fotoName({ name: 'PHOTO-2025-08-14-18-52-45.jpg', pfad: '/Firma/Tribergle', aufnahme: '' }, 'Tribergle 22').name, '2025-08-14 Foto Tribergle 22.jpg');
  assert.equal(bewerten('2020_10.pdf'), 'Scan');
  assert.equal(bewerten('Schlafzimmer002.jpg'), '');
});

test('Fotos ohne feste Zuordnung: der nächste sprechende Ordner statt einer geratenen Adresse', function () {
  assert.equal(fotoName({ name: 'IMG_1.HEIC', pfad: '/Firma/Bertha von Suttna/07 Sonstiges/Foto', aufnahme: '2025:06:14 12:35:10' }, '').name,
    '2025-06-14 Foto Bertha von Suttna.heic');
  assert.equal(fotoName({ name: 'IMG_2.jpg', pfad: '/Firma', aufnahme: '' }, '').name, 'Foto Firma.jpg');
});

test('Eine Datums-Endung ist keine Dateiendung', function () {
  assert.equal(sauber('2025-10-14 Protokoll Eigentümerversammlung', 'Protokoll 14.10.2025'), '2025-10-14 Protokoll Eigentümerversammlung');
  assert.equal(sauber('Plan V2', 'Plan v1.2'), 'Plan V2');
});
