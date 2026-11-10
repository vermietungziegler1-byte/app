'use strict';

// Textbausteine fürs Postfach ohne Abhängigkeiten — einzeln testbar.

// Signatur aus einer gesendeten Mail lesen: der Block ab dem letzten Gruß vor dem Zitat, so wie Outlook ihn anhängt.
const GRUSS = /^\s*(mit freundlichen grüßen|mit freundlichem gruß|freundliche grüße|beste grüße|viele grüße|liebe grüße|herzliche grüße|schöne grüße|sonnige grüße|gruß|grüße|mfg|best regards|kind regards)(?![a-zäöüß])/i;   // kein \b: „ß“ zählt für \b nicht als Buchstabe
const ZITATKOPF = /^\s*(am .{3,120} schrieb|on .{3,200} wrote|am \d{1,2}\.\s?\d{1,2}\.?\s?\d{2,4}|on \w{2,4},? .{0,20}\d{4}|von:|from:|gesendet:|sent:|-{3,}\s*(original|ursprüngliche|weitergeleitete)|_{10,})/i;

function signaturAus(text) {
  const zeilen = String(text || '').replace(/\r/g, '').split('\n');
  let ende = zeilen.length;
  for (let i = 0; i < zeilen.length; i++) { if (ZITATKOPF.test(zeilen[i]) || /^>/.test(zeilen[i])) { ende = i; break; } }
  let start = -1;
  for (let i = ende - 1; i >= 0; i--) { if (GRUSS.test(zeilen[i])) { start = i; break; } }
  if (start < 0) return '';
  const block = zeilen.slice(start, ende).join('\n')
    .replace(/<mailto:[^>]*>/gi, '').replace(/<https?:[^>]*>/gi, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (block.length > 1500 || block.split('\n').length < 2) return '';   // nur der Gruß oder unplausibel lang: lieber keine
  return block;
}

// Fürs Suchverzeichnis: nur der eigene Text einer Mail, ohne die zitierte Vorgeschichte (die steht in den
// früheren Mails ohnehin) — hält das Verzeichnis klein und die Treffer eindeutig
function ohneZitat(text) {
  const zeilen = String(text || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < zeilen.length; i++) {
    if (ZITATKOPF.test(zeilen[i]) || /^>/.test(zeilen[i])) return zeilen.slice(0, i).join('\n').trim();
  }
  return zeilen.join('\n').trim();
}

// ä/ae, ö/oe, ü/ue, ß/ss: Mailserver suchen nur nach Teilwörtern, „Müller“ findet „Mueller“ sonst nicht
function umlautVarianten(w) {
  const v = [String(w || '').trim()].filter(Boolean);
  if (!v.length) return v;
  const ersatz = v[0].replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss');
  if (ersatz !== v[0]) v.push(ersatz);
  return v;
}

// Ohne Assistent: nach den einzelnen Wörtern suchen
function einfacheKriterien(q) {
  const worte = String(q).split(/\s+/).map(function (w) { return w.replace(/^[^\wÄÖÜäöüß@]+|[^\wÄÖÜäöüß@.]+$/g, ''); })
    .filter(function (w) { return w.length >= 2; }).slice(0, 5);
  return { begriffe: worte.map(function (w) { return [w]; }), absender: [], empfaenger: [], seit: '', bis: '', nurAnhang: false, ordner: 'alle', erklaerung: '' };
}

module.exports = { signaturAus, umlautVarianten, einfacheKriterien, ohneZitat };
