'use strict';

// Anhänge aus Mails ausliefern: PDFs und Fotos gehen direkt im Browser auf, alles andere wird heruntergeladen.
//
// Ob eine Datei angezeigt wird, entscheidet ihr Inhalt, nicht was Absender oder Dateiname behaupten. Der Browser
// bekommt nur einen Typ aus der Liste unten und darf nicht selbst raten (nosniff). So läuft eine als „rechnung.pdf“
// getarnte HTML-Seite nie als Seite dieser App — sie hätte sonst Louis' Anmeldung und damit alle Daten.

const ANZEIGBAR = [
  { typ: 'application/pdf', passt: function (b) { return b.subarray(0, 1024).includes('%PDF'); } },
  { typ: 'image/png', passt: function (b) { return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); } },
  { typ: 'image/jpeg', passt: function (b) { return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; } },
  { typ: 'image/gif', passt: function (b) { return /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')); } },
  { typ: 'image/webp', passt: function (b) { return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'; } }
];

// Wie die Schutz-Kopfzeile der App, nur darf der PDF-Betrachter des Browsers die Datei einbetten (object-src):
// Chrome zeigt ein PDF sonst nicht an. Kein „sandbox“ — damit blockiert Chrome PDFs ganz.
const CSP_ANSEHEN = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'self'; "
  + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function alsPuffer(inhalt) { return Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(inhalt || ''); }

// Der Typ, unter dem die Datei angezeigt werden darf, oder null (dann nur als Download)
function anzeigeTyp(inhalt) {
  const b = alsPuffer(inhalt);
  const f = ANZEIGBAR.find(function (x) { return x.passt(b); });
  return f ? f.typ : null;
}

// ansehen = true: wenn möglich im Browser öffnen, sonst (Word, Excel, ZIP …) wie bisher herunterladen
function anhangSenden(res, inhalt, name, ansehen) {
  const b = alsPuffer(inhalt);
  const typ = ansehen ? anzeigeTyp(b) : null;
  res.setHeader('Content-Type', typ || 'application/octet-stream');
  res.setHeader('Content-Disposition', (typ ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name || 'anhang'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (typ) res.setHeader('Content-Security-Policy', CSP_ANSEHEN);
  res.end(b);
}

module.exports = { anzeigeTyp, anhangSenden };
