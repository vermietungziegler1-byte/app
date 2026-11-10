'use strict';

// Dateien aus Google Drive am Pfad und Namen zuordnen — ohne Google.

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

test('So wie Louis Google Drive sortiert hat: Objektordner, Wohnungsordner, Sachordner', function () {
  const stand = { objects: STAND.objects.concat([
    { id: 'o4', name: 'Maybachstraße', units: [] },
    { id: 'o5', name: 'Heinkelstraße 7, Berglen', units: [{ id: 'u9', name: 'Wohnung Blessing', tenant: 'Anna Blessing' }] }
  ]) };
  const w = woerterbuch(stand);
  // Tippfehler im Ordnernamen („Suttna“): der Kurzname „Bertha“ reicht
  assert.equal(kurz(zuordnen('/Firma/Bertha von Suttna/01 Mieteinheiten/1.OG Rechts', 'Scan 0815.pdf', w)), 'o1|u2|Sonstiges|true');
  // Die Art steht oft nur am Ordner
  assert.equal(kurz(zuordnen('/Firma/Bertha von Suttna/03 Rechnungen', 'Scan 0816.pdf', w)), 'o1||Rechnung|true');
  assert.equal(kurz(zuordnen('/Firma/Bertha von Suttna/04 Verträge/PV Verträge', 'Syna 2024.pdf', w)), 'o1||Vertrag|true');
  assert.equal(kurz(zuordnen('/Firma/Heinkelstraße 7/06 Steuer/2021', 'Bescheid.pdf', w)), 'o5||Steuer|true');
  // „Maybachstr.“ im Ordner, „Maybachstraße“ in der App
  assert.equal(kurz(zuordnen('/Firma/Maybachstr.', 'Grundriss EG.pdf', w)), 'o4||Plan|true');
  // Ein Mietvertrag im Wohnungsordner ist trotzdem ein Mietvertrag
  assert.equal(artVon('Mietvertrag.pdf', '', '/Firma/Bertha von Suttna/04 Verträge'), 'Mietvertrag');
});

test('Fester Ordner (Beleg-Ordner beim Objekt): tiefer liegende Wohnungsordner zählen trotzdem', function () {
  const fest = [{ pfad: '/Firma/Belege', objekt: 'o1', einheit: '' }];
  assert.equal(kurz(zuordnen('/Firma/Belege/EG Links', 'Wasserzähler.pdf', wb, fest)), 'o1|u1|Rechnung|true', 'Art kommt hier vom Ordner „Belege“');
  assert.equal(kurz(zuordnen('/Firma/Belege-Alt', 'X.pdf', wb, fest)), '||Rechnung|false', 'nur der Ordner selbst und seine Unterordner');
});

test('Google-Dokumente ohne Endung kommen in Frage, Systemdateien nicht', function () {
  assert.equal(kommtInFrage('/Firma', 'Übergabeprotokoll EG', 'application/vnd.google-apps.document'), true);
  assert.equal(kommtInFrage('/Firma', 'Scan vom Montag', 'application/pdf'), true);
  assert.equal(kommtInFrage('/Firma', '.DS_Store', 'application/octet-stream'), false);
  assert.equal(kommtInFrage('/Vermietung – Sicherungen', 'vermietung-2026-11-10.db', 'application/octet-stream'), false);
});
