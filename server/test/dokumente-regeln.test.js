'use strict';

// Dateien aus OneDrive am Pfad und Namen zuordnen — ohne OneDrive.

const test = require('node:test');
const assert = require('node:assert/strict');
const { woerterbuch, zuordnen, artVon, kommtInFrage } = require('../lib/dokumente-regeln');

const STAND = { objects: [
  { id: 'o1', name: 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen', units: [
    { id: 'u1', name: 'EG Links', tenant: 'Marlene Kirschner' },
    { id: 'u2', name: '1.OG Rechts', tenant: '' },
    { id: 'u3', name: 'Penthouse Links', tenant: 'John Quattelbaum, Paula Manega' }
  ] },
  { id: 'o2', name: 'Dahlienweg 7, Waiblingen', units: [{ id: 'u4', name: 'EG Wohnung', tenant: 'Jirka Salatzki' }] },
  { id: 'o3', name: 'Tribergle 22, 71409 Schwaikheim', units: [] }
] };
const wb = woerterbuch(STAND);
const kurz = function (r) { return [r.objekt, r.einheit, r.art, r.sicher].join('|'); };

test('Mietername legt Objekt und Wohnung fest, auch der zweite Mieter einer Wohnung', function () {
  assert.equal(kurz(zuordnen('/Dokumente/Scans', 'Mietvertrag Kirschner.pdf', wb)), 'o1|u1|Mietvertrag|true');
  assert.equal(kurz(zuordnen('/Scans', 'Kaution Manega.pdf', wb)), 'o1|u3|Kaution|true');
});

test('Objekt an Adresse oder Kurzname, Wohnung im Pfad', function () {
  assert.equal(kurz(zuordnen('/Vermietung/Dahlienweg', 'Nebenkostenabrechnung 2025.pdf', wb)), 'o2||Nebenkosten|true');
  assert.equal(kurz(zuordnen('/Bertha von Suttner Weg 4/1.OG Rechts', 'Uebergabe.pdf', wb)), 'o1|u2|Übergabeprotokoll|true');
  assert.equal(kurz(zuordnen('/Hausakten', 'Bertha Grundriss.pdf', wb)), 'o1||Plan|true');
  assert.equal(kurz(zuordnen('/Tribergle', 'Gebäudeversicherung Police 2026.pdf', wb)), 'o3||Versicherung|true');
});

test('Nichts erkennbar oder mehrdeutig: offen lassen, Kandidaten nennen', function () {
  assert.equal(kurz(zuordnen('/Scans', 'Scan_0412.pdf', wb)), '||Sonstiges|false');
  const r = zuordnen('/Rechnungen', 'Angebot Dach Bertha und Dahlienweg.pdf', wb);
  assert.equal(r.objekt, '');
  assert.deepEqual(r.kandidaten.sort(), ['o1', 'o2']);
  assert.equal(r.art, 'Angebot');
});

test('Gelernte Ordner gehen vor, der längste passende Pfad gewinnt', function () {
  const regeln = [{ pfad: '/Dokumente/Hausmeister', objekt: 'o3', einheit: '' }, { pfad: '/Dokumente', objekt: 'o2', einheit: '' }];
  assert.equal(kurz(zuordnen('/Dokumente/Hausmeister/2026', 'Stundenzettel.pdf', wb, regeln)), 'o3||Sonstiges|true');
  assert.equal(kurz(zuordnen('/Dokumente', 'Irgendwas.pdf', wb, regeln)), 'o2||Sonstiges|true');
});

test('Art und Auswahl der Dateien', function () {
  assert.equal(artVon('IMG_2207.jpg'), 'Foto');
  assert.equal(artVon('Rechnung 19454 Gartenpflege.pdf'), 'Rechnung');
  assert.equal(artVon('Selbstauskunft Müller.pdf'), 'Selbstauskunft');
  assert.equal(kommtInFrage('/Dokumente', 'Vertrag.pdf'), true);
  assert.equal(kommtInFrage('/Bilder/Camera Roll', 'IMG_1.jpg'), false);
  assert.equal(kommtInFrage('/Desktop/update', 'app.js'), false);
});
