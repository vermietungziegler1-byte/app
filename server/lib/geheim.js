'use strict';

// -------------------------------------------------------------
//  Geheimnisse verschlüsselt ablegen (AES-256-GCM): das Passwort des Mailkontos, der Google-Zugang.
//  Der Schlüssel liegt als eigene Datei neben der Datenbank — die Sicherungen in Google Drive enthalten ihn nicht.
// -------------------------------------------------------------

const { crypto, path, fs, DATENORDNER } = require('./kern');

// Der Dateiname stammt noch aus der Zeit, als nur das Mailkonto verschlüsselt wurde — bleibt so, damit nichts verloren geht
const SCHLUESSELDATEI = process.env.POSTFACH_SCHLUESSEL || path.join(DATENORDNER, 'postfach.schluessel');
function schluessel() {
  try { const k = fs.readFileSync(SCHLUESSELDATEI); if (k.length === 32) return k; } catch (e) { /* noch keiner da */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(SCHLUESSELDATEI, k, { mode: 0o600 });
  return k;
}
function verschluesseln(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel(), iv);
  const inhalt = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), inhalt]).toString('base64');
}
function entschluesseln(wert) {
  if (!wert || String(wert).indexOf('v1:') !== 0) return null;
  const roh = Buffer.from(String(wert).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', schluessel(), roh.subarray(0, 12));
  d.setAuthTag(roh.subarray(12, 28));
  return Buffer.concat([d.update(roh.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { verschluesseln, entschluesseln };
