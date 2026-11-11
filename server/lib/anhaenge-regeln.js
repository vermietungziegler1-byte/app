'use strict';

// -------------------------------------------------------------
//  Anhänge aus dem Postfach: welche zählen, welche liegen schon in Google Drive, welche Art gehört in welchen Ordner.
//  Ohne Abhängigkeiten außer den Dokument-Regeln, einzeln testbar.
// -------------------------------------------------------------

const regeln = require('./dokumente-regeln');
const namen = require('./dokumente-namen');

const normal = function (s) { return regeln.normal(s).trim(); };

// Dateitypen, die als Unterlage taugen — Kalender, Visitenkarten, Signaturen, Archive und Logos nicht
const TAUGT = /\.(pdf|docx?|odt|rtf|xlsx?|ods|jpe?g|png|heic|heif|tiff?)$/i;
const NIE = /^(image\d{2,}|logo|signatur|signature|banner|facebook|instagram|linkedin|twitter|xing|outlook|winmail|smime)/i;
function taugt(a) {
  const name = String(a.name || '');
  if (!TAUGT.test(name) && !/^application\/pdf$/i.test(a.typ || '')) return false;
  if (NIE.test(name)) return false;
  // Bilder: eingebettete und kleine (Logos, Icons) weg — echte Fotos und Scans sind größer
  if (namen.istBild(name, a.typ)) return !a.inline && Number(a.groesse) >= 60000;
  return Number(a.groesse) >= 2000;
}

// Hat eine Mail mit der Vermietung zu tun? Ein Objekt, ein Mieter oder ein typisches Wort in Betreff, Anhang oder Text
const WORTE = ['rechnung', 'rechnungen', 'abrechnung', 'nebenkosten', 'betriebskosten', 'heizkosten', 'bescheid', 'vertrag', 'vertraege',
  'versicherung', 'police', 'angebot', 'kostenvoranschlag', 'wartung', 'ista', 'techem', 'brunata', 'stadtwerke', 'grundsteuer', 'abwasser',
  'kaution', 'mietvertrag', 'uebergabe', 'uebergabeprotokoll', 'protokoll', 'mahnung', 'gutschrift', 'zaehlerstand', 'schornsteinfeger',
  'hausmeister', 'reparatur', 'auftrag', 'auftragsbestaetigung', 'lastschrift', 'jahresabrechnung', 'messdienst', 'mieterhoehung',
  'kuendigung', 'selbstauskunft', 'gutachten', 'handwerker', 'wohnung', 'miete'];
function relevant(m, wb) {
  const kopf = normal((m.betreff || '') + ' ' + (m.anhaenge || ''));
  const text = normal(m.text || '');
  const wort = WORTE.some(function (w) { return kopf.indexOf(w) !== -1 || (' ' + text + ' ').indexOf(' ' + w + ' ') !== -1; });
  if (wort) return true;
  const r = regeln.zuordnen(String(m.betreff || '') + ' ' + String(m.von_name || ''), String(m.anhaenge || '') + ' ' + String(m.text || '').slice(0, 600), wb);
  return !!(r.objekt || (r.kandidaten && r.kandidaten.length));
}

// Liegt der Anhang schon in Drive? Gleicher Name (ohne Endung, Groß/klein, Zeichen) — oder gleiche Endung und fast
// gleiche Größe (Mails tragen Anhänge in Base64, also gut ein Drittel größer)
function driveVerzeichnis(dateien) {
  const namenSet = new Set(), groessen = new Map();
  (dateien || []).forEach(function (d) {
    namenSet.add(normal(namen.stamm(d.name)));
    const e = namen.endung(d.name).toLowerCase();
    if (!groessen.has(e)) groessen.set(e, []);
    if (d.groesse) groessen.get(e).push(Number(d.groesse));
  });
  return { namen: namenSet, groessen: groessen };
}
function inDrive(a, verz) {
  const n = normal(namen.stamm(a.name));
  if (n && verz.namen.has(n)) return true;
  const roh = Number(a.groesse) || 0;
  if (roh < 20000) return false;
  const geschaetzt = roh * 0.73;
  return (verz.groessen.get(namen.endung(a.name).toLowerCase()) || []).some(function (g) { return Math.abs(g - geschaetzt) / g < 0.03; });
}

// Arten, die der Assistent vergeben darf — und wohin sie in Drive gehören
const ARTEN = ['Nebenkosten-Rechnung', 'Nebenkostenabrechnung', 'Rechnung', 'Angebot', 'Vertrag', 'Versicherung', 'Bescheid',
  'Mietvertrag', 'Kaution', 'Kündigung', 'Übergabeprotokoll', 'Selbstauskunft', 'Schriftverkehr', 'Plan', 'Protokoll', 'Foto', 'Sonstiges'];
const MIETER = ['Mietvertrag', 'Kaution', 'Kündigung', 'Übergabeprotokoll', 'Selbstauskunft', 'Schriftverkehr'];
const KOSTENARTEN = ['Grundsteuer', 'Wasser und Abwasser', 'Heizung', 'Warmwasser', 'Aufzug', 'Straßenreinigung', 'Müllabfuhr', 'Gebäudereinigung',
  'Gartenpflege', 'Allgemeinstrom', 'Schornsteinfeger', 'Versicherung', 'Hausmeister', 'Kabel und Antenne', 'Wartung', 'Messdienst',
  'Sonstige Betriebskosten'];

// Kategorie: Ordner im Objekt (vorhandener nach Muster, sonst neu nach Louis' Nummerierung), mit Jahresordner?
const KATEGORIEN = {
  nk:       { label: 'Nebenkosten-Rechnungen', muster: /^\d*\s*nebenkosten/i, neu: '02 Nebenkosten', jahr: true },
  abr:      { label: 'Nebenkostenabrechnungen', muster: /^\d*\s*nebenkosten/i, neu: '02 Nebenkosten', jahr: true },
  rechnung: { label: 'Sonstige Rechnungen', muster: /^\d*\s*rechnung/i, neu: '03 Rechnungen', jahr: true },
  vertrag:  { label: 'Verträge & Versicherung', muster: /^\d*\s*(vertr|versicherung)/i, neu: '04 Verträge', jahr: false },
  bescheid: { label: 'Bescheide', muster: /^\d*\s*(steuer|bescheid|finanzen)/i, neu: '06 Finanzen', jahr: true },
  mieter:   { label: 'Mieter-Unterlagen', muster: /^\d*\s*mieteinheiten/i, neu: '01 Mieteinheiten', jahr: false },
  sonst:    { label: 'Sonstiges', muster: /^\d*\s*sonstig/i, neu: '07 Sonstiges', jahr: false }
};
function kategorie(art) {
  if (art === 'Nebenkosten-Rechnung') return 'nk';
  if (art === 'Nebenkostenabrechnung') return 'abr';
  if (art === 'Rechnung' || art === 'Angebot') return 'rechnung';
  if (art === 'Vertrag' || art === 'Versicherung') return 'vertrag';
  if (art === 'Bescheid') return 'bescheid';
  if (MIETER.indexOf(art) !== -1) return 'mieter';
  return 'sonst';
}
// Art für die Dokumentliste beim Objekt (dieselben Arten wie bei den Drive-Dateien)
function dokArt(art) {
  if (art === 'Nebenkostenabrechnung') return 'Nebenkosten';
  if (art === 'Bescheid') return 'Steuer';
  return ARTEN.indexOf(art) !== -1 ? art : 'Sonstiges';
}

// Ohne Assistent: Objekt, Wohnung und Art aus Betreff, Absender, Anhangname und Text — vorsichtig, Louis prüft
function ohneAssistent(m, a, wb, eigentlich) {
  const r = regeln.zuordnen(String(m.betreff || '') + ' ' + String(m.von || ''), String(a.name || '') + ' ' + String(m.text || '').slice(0, 600), wb, eigentlich || []);
  let art = regeln.artVon(a.name);
  if (art === 'Sonstiges') art = regeln.artVon(m.betreff || '');
  const umgesetzt = { Nebenkosten: 'Nebenkostenabrechnung', Steuer: 'Bescheid' }[art] || art;
  const jahr = (namen.datumAusName(namen.stamm(a.name)).datum || '').slice(0, 4) || (m.datum ? new Date(m.datum).toISOString().slice(0, 4) : '');
  return { objekt: r.objekt || '', einheit: r.einheit || '', art: ARTEN.indexOf(umgesetzt) !== -1 ? umgesetzt : 'Sonstiges', jahr: jahr, sicher: !!r.sicher };
}

// Dateiname für die Ablage: Vorschlag des Assistenten (ohne Endung) oder „JJJJ-MM-TT Art Absender“, Endung vom Anhang
function dateiname(vorschlag, a, m, art) {
  const e = namen.endung(a.name).toLowerCase();
  let s = String(vorschlag || '').trim();
  if (!s) {
    const datum = m.datum ? new Date(m.datum).toISOString().slice(0, 10) : '';
    const von = String(m.von || '').replace(/<.*>/, '').replace(/["']/g, '').trim().split(/\s+/).slice(0, 3).join(' ');
    s = [datum, art && art !== 'Sonstiges' ? art : '', von, namen.stamm(a.name)].filter(Boolean).join(' ');
  }
  // sauber() hängt die Endung des Anhangs an, wenn sie fehlt
  return namen.sauber(s, a.name) || (namen.stamm(a.name) + e);
}

module.exports = { taugt, relevant, driveVerzeichnis, inDrive, ARTEN, MIETER, KOSTENARTEN, KATEGORIEN, kategorie, dokArt, ohneAssistent, dateiname };
