'use strict';

// ZIP-Anhänge ansehen: Inhaltsverzeichnis lesen und einzelne Dateien herausholen, wie aus Windows, vom Mac
// oder aus anderen Programmen gepackt — und Schutz vor Passwort-Dateien und „ZIP-Bomben“.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const zip = require('../lib/zip-lesen');
const { anhangAntwort } = require('../lib/anhang-senden');

// Baut eine ZIP-Datei so, wie Packprogramme sie schreiben (lokale Köpfe, Verzeichnis am Ende)
function zipBauen(eintraege) {
  const lokale = [], zentral = [];
  let pos = 0;
  for (const e of eintraege) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const roh = Buffer.isBuffer(e.daten) ? e.daten : Buffer.from(e.daten || '');
    const gepackt = e.methode === 8 ? zlib.deflateRawSync(roh) : roh;
    const extra = e.extra || Buffer.alloc(0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags || 0, 6); lh.writeUInt16LE(e.methode || 0, 8);
    lh.writeUInt32LE(gepackt.length, 18); lh.writeUInt32LE(roh.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.flags || 0, 8); cd.writeUInt16LE(e.methode || 0, 10);
    cd.writeUInt32LE(gepackt.length, 20); cd.writeUInt32LE(e.entpacktAngabe !== undefined ? e.entpacktAngabe : roh.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(extra.length, 30); cd.writeUInt32LE(pos, 42);
    lokale.push(lh, name, gepackt);
    zentral.push(cd, name, extra);
    pos += 30 + name.length + gepackt.length;
  }
  const z = Buffer.concat(zentral);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0); ende.writeUInt16LE(eintraege.length, 8); ende.writeUInt16LE(eintraege.length, 10);
  ende.writeUInt32LE(z.length, 12); ende.writeUInt32LE(pos, 16);
  return Buffer.concat(lokale.concat([z, ende]));
}

const UTF8 = 0x800;
const PLAN = Buffer.from('%PDF-1.4\n' + 'Küche EG '.repeat(800));
const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
function unicodeFeld(name) {
  const n = Buffer.from(name, 'utf8'), f = Buffer.alloc(9);
  f.writeUInt16LE(0x7075, 0); f.writeUInt16LE(5 + n.length, 2); f.writeUInt8(1, 4);
  return Buffer.concat([f, n]);
}
const ZIP = zipBauen([
  { name: 'Küchenpläne/', flags: UTF8 },                                                       // 0 Ordner
  { name: 'Küchenpläne/Plan EG.pdf', flags: UTF8, methode: 8, daten: PLAN },                   // 1
  { name: Buffer.from([0x4b, 0x81, 0x63, 0x68, 0x65, 0x2e, 0x6a, 0x70, 0x67]), daten: FOTO },  // 2 „Küche.jpg“ aus Windows (CP437)
  { name: '__MACOSX/Küchenpläne/._Plan EG.pdf', flags: UTF8, daten: 'Mac' },                   // 3 Beiwerk vom Mac
  { name: 'Angebot.docx', methode: 8, daten: 'PK\u0003\u0004 word/document.xml' },             // 4
  { name: 'geheim.pdf', flags: UTF8 | 1, daten: 'verschluesselt' },                            // 5 mit Passwort
  { name: 'Stra_e.pdf', extra: unicodeFeld('Straße.pdf'), daten: '%PDF-1.4 Strasse' },         // 6 Name im Zusatzfeld
  { name: 'bombe.pdf', methode: 8, daten: Buffer.alloc(3 * 1024 * 1024), entpacktAngabe: 100 }, // 7 lügt bei der Größe
  { name: 'Grundriß.pdf', daten: '%PDF-1.4 G' }                                                // 8 UTF-8 ohne Kennzeichen
]);

test('ZIP: Inhaltsverzeichnis ohne Ordner und Mac-Beiwerk, Umlaute aus Windows, Mac und anderen Programmen', function () {
  assert.equal(zip.CP437.length, 128);
  const liste = zip.inhalt(ZIP);
  assert.deepEqual(liste.map(function (e) { return e.nr + ' ' + e.name; }),
    ['1 Küchenpläne/Plan EG.pdf', '2 Küche.jpg', '4 Angebot.docx', '5 geheim.pdf', '6 Straße.pdf', '7 bombe.pdf', '8 Grundriß.pdf']);
  assert.equal(liste[0].groesse, PLAN.length);
  assert.equal(liste[3].verschluesselt, true);
  assert.equal(liste[0].verschluesselt, false);
});

test('ZIP: einzelne Dateien herausholen; Passwort, Ordner, Bombe und Nicht-ZIP werden abgewiesen', function () {
  let d = zip.datei(ZIP, 1);
  assert.equal(d.datei, 'Plan EG.pdf');
  assert.equal(d.name, 'Küchenpläne/Plan EG.pdf');
  assert.ok(d.inhalt.equals(PLAN));
  d = zip.datei(ZIP, 2);
  assert.equal(d.datei, 'Küche.jpg');
  assert.ok(d.inhalt.equals(FOTO));
  assert.throws(function () { zip.datei(ZIP, 5); }, /Passwort/);
  assert.throws(function () { zip.datei(ZIP, 0); }, function (e) { return e.status === 404; }, 'Ordner sind keine Dateien');
  assert.throws(function () { zip.datei(ZIP, 3); }, function (e) { return e.status === 404; });
  assert.throws(function () { zip.datei(ZIP, 99); }, function (e) { return e.status === 404; });
  assert.throws(function () { zip.datei(ZIP, 7, 1024 * 1024); }, /zu groß/);
  assert.throws(function () { zip.inhalt(Buffer.from('%PDF-1.4 das ist ein PDF, keine ZIP-Datei')); }, /keine ZIP/);
  assert.throws(function () { zip.inhalt(Buffer.alloc(0)); }, /keine ZIP/);
});

test('ZIP über die Anhang-Adresse: zip=1 listet, eintrag=N öffnet PDFs im Browser und lädt Word herunter', function () {
  function antwort() {
    const r = { kopf: {} };
    r.setHeader = function (k, v) { r.kopf[k.toLowerCase()] = v; };
    r.end = function (b) { r.koerper = b; };
    r.json = function (x) { r.daten = x; };
    return r;
  }
  let r = antwort();
  anhangAntwort({ query: { zip: '1' } }, r, ZIP, 'Küchenpläne.zip');
  assert.equal(r.daten.name, 'Küchenpläne.zip');
  assert.equal(r.daten.eintraege.length, 7);

  r = antwort();
  anhangAntwort({ query: { eintrag: '1', ansehen: '1' } }, r, ZIP, 'Küchenpläne.zip');
  assert.equal(r.kopf['content-type'], 'application/pdf');
  assert.equal(r.kopf['content-disposition'], "inline; filename*=UTF-8''Plan%20EG.pdf");
  assert.ok(r.koerper.equals(PLAN));

  r = antwort();
  anhangAntwort({ query: { eintrag: '4', ansehen: '1' } }, r, ZIP, 'Küchenpläne.zip');
  assert.equal(r.kopf['content-type'], 'application/octet-stream');
  assert.equal(r.kopf['content-disposition'], "attachment; filename*=UTF-8''Angebot.docx");

  r = antwort();
  anhangAntwort({ query: {} }, r, ZIP, 'Küchenpläne.zip');
  assert.equal(r.kopf['content-disposition'], "attachment; filename*=UTF-8''K%C3%BCchenpl%C3%A4ne.zip", 'die ganze ZIP bleibt ein Download');

  assert.throws(function () { anhangAntwort({ query: { eintrag: '1;x' } }, antwort(), ZIP, 'a.zip'); }, function (e) { return e.status === 400; });
});
