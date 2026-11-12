'use strict';

// ZIP-Dateien aus Mails ansehen, ohne sie irgendwo auszupacken: das Inhaltsverzeichnis lesen und einzelne Dateien
// herausholen. Nur was Mail-Anhänge brauchen: „gespeichert“ (0) und „Deflate“ (8), kein ZIP64, kein Passwort.
// Ohne zusätzliches Paket — zlib bringt Node selbst mit.

const zlib = require('zlib');

const MAX_DATEI = 80 * 1024 * 1024;   // ausgepackt; eine „ZIP-Bombe“ bricht hier ab statt den Server zu füllen
const MAX_EINTRAEGE = 3000;

function fehler(text, status) { const e = new Error(text); e.status = status || 422; return e; }

// Windows (Explorer, ältere Programme) schreibt Namen ohne UTF-8-Kennzeichen in der DOS-Codepage: ä = 0x84, ü = 0x81 …
const CP437 = ['ÇüéâäàåçêëèïîìÄÅ', 'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ', 'áíóúñÑªº¿⌐¬½¼¡«»', '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐',
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧', '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀', 'αßΓπΣσµτΦΘΩδ∞φε∩', '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '].join('');

function nameLesen(roh, flags, extra) {
  if (flags & 0x800) return roh.toString('utf8');
  // Info-ZIP legt den Namen manchmal zusätzlich als UTF-8 ab (Zusatzfeld 0x7075)
  for (let i = 0; i + 4 <= extra.length;) {
    const id = extra.readUInt16LE(i), laenge = extra.readUInt16LE(i + 2);
    if (id === 0x7075 && laenge > 5 && i + 4 + laenge <= extra.length) return extra.subarray(i + 9, i + 4 + laenge).toString('utf8');
    i += 4 + laenge;
  }
  // Manche Programme schreiben UTF-8, ohne es zu kennzeichnen — gültiges UTF-8 mit Umlauten ist dann fast sicher UTF-8
  const utf8 = roh.toString('utf8');
  if (roh.some(function (b) { return b > 0x7f; }) && Buffer.from(utf8, 'utf8').equals(roh)) return utf8;
  let s = '';
  for (const b of roh) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
  return s;
}

function alsPuffer(b) { return Buffer.isBuffer(b) ? b : Buffer.from(b || ''); }

// Alle Einträge aus dem zentralen Verzeichnis am Ende der Datei
function verzeichnis(b) {
  if (b.length < 22) throw fehler('Das ist keine ZIP-Datei');
  let e = -1;
  for (let i = b.length - 22, min = Math.max(0, b.length - 22 - 65535); i >= min; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw fehler('Das ist keine ZIP-Datei oder sie ist beschädigt');
  const anzahl = b.readUInt16LE(e + 10);
  let pos = b.readUInt32LE(e + 16);
  if (anzahl === 0xffff || pos === 0xffffffff) throw fehler('Diese ZIP-Datei ist zu groß für die Vorschau — bitte herunterladen');
  const liste = [];
  for (let nr = 0; nr < anzahl && nr < MAX_EINTRAEGE; nr++) {
    if (pos + 46 > b.length || b.readUInt32LE(pos) !== 0x02014b50) throw fehler('Das Inhaltsverzeichnis der ZIP-Datei ist beschädigt');
    const flags = b.readUInt16LE(pos + 8);
    const nl = b.readUInt16LE(pos + 28), xl = b.readUInt16LE(pos + 30), kl = b.readUInt16LE(pos + 32);
    const name = nameLesen(b.subarray(pos + 46, pos + 46 + nl), flags, b.subarray(pos + 46 + nl, pos + 46 + nl + xl));
    liste.push({ nr: nr, name: name.split(String.fromCharCode(92)).join('/').replace(/^\/+/, ''), flags: flags, methode: b.readUInt16LE(pos + 10),
      gepackt: b.readUInt32LE(pos + 20), entpackt: b.readUInt32LE(pos + 24), lokal: b.readUInt32LE(pos + 42) });
    pos += 46 + nl + xl + kl;
  }
  return liste;
}

// Ordner und Mac-Beiwerk (__MACOSX, ._Datei, .DS_Store) zeigt niemand gern
function unwichtig(name) {
  const datei = name.split('/').pop();
  return name.endsWith('/') || /(^|\/)__MACOSX\//.test(name) || /^\._/.test(datei) || /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(datei);
}

// Was in der ZIP steckt: [{ nr, name (mit Ordnern), groesse, verschluesselt }]
function inhalt(puffer) {
  return verzeichnis(alsPuffer(puffer)).filter(function (e) { return !unwichtig(e.name); }).map(function (e) {
    return { nr: e.nr, name: e.name, groesse: e.entpackt, verschluesselt: !!(e.flags & 1) };
  });
}

// Eine Datei aus der ZIP: { name, datei (ohne Ordner), inhalt }
function datei(puffer, nr, max) {
  const b = alsPuffer(puffer);
  const grenze = max || MAX_DATEI;
  const e = verzeichnis(b).find(function (x) { return x.nr === nr; });
  if (!e || unwichtig(e.name)) throw fehler('Diese Datei gibt es in der ZIP nicht', 404);
  if (e.flags & 1) throw fehler('Diese Datei in der ZIP ist mit einem Passwort geschützt — bitte die ganze ZIP herunterladen');
  if (e.entpackt > grenze) throw fehler('Diese Datei ist ausgepackt zu groß für die Vorschau — bitte die ganze ZIP herunterladen');
  const l = e.lokal;
  if (l + 30 > b.length || b.readUInt32LE(l) !== 0x04034b50) throw fehler('Die ZIP-Datei ist beschädigt');
  const start = l + 30 + b.readUInt16LE(l + 26) + b.readUInt16LE(l + 28);
  const daten = b.subarray(start, start + e.gepackt);
  if (daten.length < e.gepackt) throw fehler('Die ZIP-Datei ist unvollständig');
  let roh;
  if (e.methode === 0) roh = Buffer.from(daten);
  else if (e.methode === 8) {
    try { roh = zlib.inflateRawSync(daten, { maxOutputLength: grenze }); }
    catch (x) { throw fehler(x instanceof RangeError ? 'Diese Datei ist ausgepackt zu groß für die Vorschau — bitte die ganze ZIP herunterladen' : 'Die ZIP-Datei ist beschädigt'); }
  } else throw fehler('Diese Datei ist auf eine Art gepackt, die die Vorschau nicht kennt — bitte die ganze ZIP herunterladen');
  return { name: e.name, datei: e.name.split('/').pop() || 'datei', inhalt: roh };
}

module.exports = { inhalt, datei, CP437 };
