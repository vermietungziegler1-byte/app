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

// Hat eine Mail mit der Vermietung zu tun?
//  'objekt' = ein Objekt, eine Wohnung oder ein Mieter ist erkennbar → der Assistent darf den Anhang lesen
//  'wort'   = nur ein typisches Wort (z. B. „Rechnung“) → der Assistent sieht nur Betreff, Absender und Dateiname,
//             denn hinter „Rechnung“ steckt auch mal eine Arztrechnung
//  ''       = nichts davon → bleibt außen vor
// Vermietungs-Wörter, die auch in Zusammensetzungen eindeutig sind („Nebenkostenabrechnung“, „Mietvertragsentwurf“) …
const STAEMME = ['nebenkosten', 'betriebskosten', 'heizkosten', 'grundsteuer', 'mietvertrag', 'mietkaution', 'kaution', 'wohnungsuebergabe',
  'uebergabeprotokoll', 'hausmeister', 'schornsteinfeger', 'hausgeld', 'mieterhoehung', 'mieterselbstauskunft', 'ista', 'techem', 'brunata',
  'messdienst', 'stadtwerke', 'abwasser', 'treppenhaus', 'winterdienst', 'gartenpflege', 'allgemeinstrom', 'stromabrechnung', 'stromrechnung',
  'wasserabrechnung', 'wasserrechnung', 'gasabrechnung', 'abfallgebuehr', 'muellgebuehr'];
// … und allgemeine Wörter, die nur als ganzes Wort zählen (sonst passt „Gehaltsabrechnung“ oder „Kreditkartenabrechnung“)
const WOERTER = ['rechnung', 'rechnungen', 'abrechnung', 'jahresabrechnung', 'bescheid', 'vertrag', 'angebot', 'kostenvoranschlag', 'wartung',
  'wartungsvertrag', 'mahnung', 'gutschrift', 'zaehlerstand', 'reparatur', 'kuendigung', 'selbstauskunft', 'gutachten', 'miete', 'wohnung', 'police'];
function relevant(m, wb) {
  const r = regeln.zuordnen(String(m.betreff || '') + ' ' + String(m.von_name || ''), String(m.anhaenge || '') + ' ' + String(m.text || '').slice(0, 600), wb);
  if (r.objekt || (r.kandidaten && r.kandidaten.length)) return 'objekt';
  const kopf = normal((m.betreff || '') + ' ' + (m.anhaenge || ''));
  const worte = kopf.split(' ').concat(normal(m.von_name || '').split(' '));
  if (worte.some(function (w) { return STAEMME.some(function (s) { return w.indexOf(s) === 0; }); })) return 'wort';
  if (worte.some(function (w) { return WOERTER.indexOf(w) !== -1; })) return 'wort';
  return '';
}

// Ob ein Anhang schon in Drive liegt, entscheidet anhaenge.js an der Prüfsumme (md5) — nie am Namen oder an der Größe.

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

module.exports = { taugt, relevant, ARTEN, MIETER, KOSTENARTEN, KATEGORIEN, kategorie, dokArt, ohneAssistent, dateiname };
