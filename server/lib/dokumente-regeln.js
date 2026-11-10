'use strict';

// -------------------------------------------------------------
//  Dateien aus OneDrive Objekten, Wohnungen und Mietern zuordnen — am Pfad und Dateinamen.
//  Ohne Abhängigkeiten, einzeln testbar. Was hier nicht sicher zugeordnet wird, liest später der Assistent.
// -------------------------------------------------------------

// Für den Vergleich: klein, Umlaute ausgeschrieben, alles außer Buchstaben und Ziffern wird zu Leerzeichen
function normal(s) {
  return ' ' + String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}
const enthaelt = function (text, wort) { return wort && text.indexOf(' ' + wort + ' ') !== -1; };

// Wörter, die allein nichts über ein Objekt oder einen Mieter sagen
const ALLGEMEIN = ['am', 'an', 'im', 'in', 'zum', 'zur', 'der', 'die', 'das', 'und', 'weg', 'strasse', 'str', 'gasse', 'platz',
  'herr', 'frau', 'familie', 'eg', 'og', 'dg', 'ug', 'links', 'rechts', 'mitte', 'wohnung', 'garage', 'stellplatz',
  'waiblingen', 'stuttgart', 'gmbh', 'co', 'kg'];

// Aus dem Datenstand: Objekte mit Erkennungsmerkmalen, Wohnungen, Mieter
function woerterbuch(stand) {
  const objekte = [], einheiten = [], mieter = [];
  ((stand && stand.objects) || []).forEach(function (o) {
    const name = String(o.name || '');
    const strasse = normal(name.split(',')[0].replace(/\d.*$/, '')).trim();      // „bertha von suttner weg“
    const mitNummer = normal(name.split(',')[0]).trim();                           // „bertha von suttner weg 4“
    const erstes = strasse.split(' ')[0] || '';
    const merkmale = [];
    if (mitNummer) merkmale.push(mitNummer);
    if (strasse && strasse !== mitNummer) merkmale.push(strasse);
    if (erstes.length >= 5 && ALLGEMEIN.indexOf(erstes) === -1) merkmale.push(erstes);   // „bertha“, „dahlienweg“
    // zusammengeschrieben: „berthavonsuttnerweg“
    if (strasse.indexOf(' ') !== -1) merkmale.push(strasse.replace(/ /g, ''));
    objekte.push({ id: o.id, name: name, merkmale: merkmale });
    (o.units || []).forEach(function (x) {
      const n = normal(x.name).trim();
      if (n) einheiten.push({ id: x.id, objekt: o.id, name: x.name || '', merkmal: n });
      String(x.tenant || '').split(/\s*(?:,|&|\/|\bund\b|\+)\s*/).forEach(function (person) {
        const teile = normal(person).trim().split(' ').filter(function (t) { return t.length >= 4 && ALLGEMEIN.indexOf(t) === -1; });
        const nachname = teile[teile.length - 1];
        if (nachname) mieter.push({ name: person.trim(), nachname: nachname, objekt: o.id, einheit: x.id });
      });
    });
  });
  return { objekte: objekte, einheiten: einheiten, mieter: mieter };
}

// Art des Dokuments am Namen erkennen
const ARTEN = [
  ['Mietvertrag', ['mietvertrag', 'mietvertraege', 'mv']],
  ['Nebenkosten', ['nebenkosten', 'nebenkostenabrechnung', 'betriebskosten', 'betriebskostenabrechnung', 'nka', 'bka', 'heizkosten', 'heizkostenabrechnung', 'ista', 'techem', 'brunata']],
  ['Kaution', ['kaution', 'mietkaution', 'kautionsbescheinigung', 'kautionskonto']],
  ['Kündigung', ['kuendigung', 'kuendigungsbestaetigung']],
  ['Übergabeprotokoll', ['uebergabeprotokoll', 'uebergabe', 'abnahmeprotokoll', 'wohnungsuebergabe']],
  ['Selbstauskunft', ['selbstauskunft', 'mieterselbstauskunft', 'schufa', 'gehaltsnachweis', 'lohnabrechnung', 'einkommensnachweis', 'gehaltsabrechnung']],
  ['Versicherung', ['versicherung', 'police', 'versicherungsschein', 'gebaeudeversicherung']],
  ['Plan', ['grundriss', 'grundrisse', 'plan', 'plaene', 'energieausweis', 'flaechenberechnung', 'wohnflaechenberechnung', 'teilungserklaerung', 'grundbuch']],
  ['Angebot', ['angebot', 'kostenvoranschlag', 'kva']],
  ['Rechnung', ['rechnung', 'rechnungen', 'invoice', 'gutschrift', 'quittung', 'beleg']],
  ['Protokoll', ['protokoll', 'eigentuemerversammlung', 'wartungsprotokoll', 'pruefbericht']],
  ['Schriftverkehr', ['schreiben', 'brief', 'mahnung', 'mieterhoehung', 'anschreiben']],
  ['Kontoauszug', ['kontoauszug', 'kontoauszuege']]
];
const BILD = /\.(jpe?g|png|heic|heif|gif|webp)$/i;
function artVon(name, mime) {
  const n = normal(String(name || '').replace(/\.[a-z0-9]+$/i, ''));
  for (const a of ARTEN) { if (a[1].some(function (w) { return enthaelt(n, w) || (w.length >= 8 && n.indexOf(w) !== -1); })) return a[0]; }
  if (BILD.test(name || '') || /^image\//.test(mime || '')) return 'Foto';
  return 'Sonstiges';
}
// Diese Arten gehören zum Mieter, die übrigen zur Wohnung bzw. zum Objekt
const MIETER_ARTEN = ['Mietvertrag', 'Kaution', 'Kündigung', 'Übergabeprotokoll', 'Selbstauskunft', 'Schriftverkehr'];

// Welche Dateien überhaupt in Frage kommen: Dokumente und Fotos, nicht in Ordnern, die erkennbar privat oder technisch sind
const TYPEN = /\.(pdf|docx?|odt|rtf|xlsx?|ods|txt|jpe?g|png|heic|heif)$/i;
const AUSSEN_VOR = /(^|\/)(camera roll|eigene aufnahmen|screenshots|whatsapp( images)?|node_modules|\.git|appdata|programme|program files|\.trash|papierkorb)(\/|$)/i;
function kommtInFrage(pfad, name) {
  return TYPEN.test(String(name || '')) && !AUSSEN_VOR.test(String(pfad || '') + '/');
}

// Zuordnung am Pfad + Namen. regeln: gelernte Ordner (pfad → objekt/einheit), längster passender Pfad gewinnt.
// Liefert { objekt, einheit, art, sicher, grund } — objekt/einheit leer, wenn nichts passt.
function zuordnen(pfad, name, wb, regeln) {
  const art = artVon(name);
  const ganz = normal(String(pfad || '') + ' ' + String(name || '').replace(/\.[a-z0-9]+$/i, ''));

  // 1. Selbst gelernt: Ordner, in denen Louis schon zugeordnet hat
  const p = String(pfad || '').toLowerCase();
  const regel = (regeln || []).filter(function (r) { return p === r.pfad.toLowerCase() || p.indexOf(r.pfad.toLowerCase() + '/') === 0; })
    .sort(function (a, b) { return b.pfad.length - a.pfad.length; })[0];
  if (regel && regel.objekt) return { objekt: regel.objekt, einheit: regel.einheit || '', art: art, sicher: true, grund: 'Ordner' };

  // 2. Mietername: legt Objekt und Wohnung fest — nur wenn der Name eindeutig ist
  const mieterTreffer = wb.mieter.filter(function (m) { return enthaelt(ganz, m.nachname); });
  const verschiedene = mieterTreffer.filter(function (m, i) { return mieterTreffer.findIndex(function (x) { return x.einheit === m.einheit; }) === i; });

  // 3. Objekt an Adresse oder Kurzname
  const objektTreffer = wb.objekte.filter(function (o) {
    return o.merkmale.some(function (mk) { return mk.indexOf(' ') !== -1 ? ganz.indexOf(' ' + mk + ' ') !== -1 : enthaelt(ganz, mk); });
  });

  if (verschiedene.length === 1) {
    const m = verschiedene[0];
    // Passt ein genanntes Objekt nicht zum Mieter, lieber nachfragen
    const widerspruch = objektTreffer.length && !objektTreffer.some(function (o) { return o.id === m.objekt; });
    return { objekt: m.objekt, einheit: m.einheit, art: art, sicher: !widerspruch, grund: 'Mieter ' + m.name };
  }
  if (objektTreffer.length === 1) {
    const o = objektTreffer[0];
    // Wohnung innerhalb des Objekts: „eg links“, „1 og rechts“ …
    const w = wb.einheiten.filter(function (e) { return e.objekt === o.id && ganz.indexOf(' ' + e.merkmal + ' ') !== -1; })
      .sort(function (a, b) { return b.merkmal.length - a.merkmal.length; })[0];
    return { objekt: o.id, einheit: w ? w.id : '', art: art, sicher: verschiedene.length === 0, grund: 'Objekt ' + o.name.split(',')[0] };
  }
  if (objektTreffer.length > 1 || verschiedene.length > 1) {
    const kandidaten = objektTreffer.map(function (o) { return o.id; }).concat(verschiedene.map(function (m) { return m.objekt; }));
    return { objekt: '', einheit: '', art: art, sicher: false, grund: 'mehrdeutig', kandidaten: kandidaten.filter(function (k, i) { return kandidaten.indexOf(k) === i; }) };
  }
  return { objekt: '', einheit: '', art: art, sicher: false, grund: '' };
}

module.exports = { normal, woerterbuch, artVon, zuordnen, kommtInFrage, MIETER_ARTEN, ARTEN };
