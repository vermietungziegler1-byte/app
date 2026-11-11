'use strict';

// -------------------------------------------------------------
//  Dateien aus Google Drive Objekten, Wohnungen und Mietern zuordnen — am Pfad und Dateinamen.
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

// „Maybachstraße“ steht in Ordnern oft als „Maybachstr.“ — und umgekehrt
function strassenVarianten(merkmal) {
  const v = [];
  if (/strasse( |$)/.test(merkmal)) v.push(merkmal.replace(/strasse( |$)/g, 'str$1'));
  else if (/str( |$)/.test(merkmal)) v.push(merkmal.replace(/str( |$)/g, 'strasse$1'));
  return v;
}

// Aus dem Datenstand: Objekte mit Erkennungsmerkmalen, Wohnungen, Mieter.
// eigentuemer: Namen des Vermieters („Louis Ziegler“) — sein Name steht auf fast jedem Dokument und sagt nichts über die
// Wohnung. Ist er selbst irgendwo Mieter, zählt das nicht; Mieter mit seinem Nachnamen zählen nur mit Vornamen.
function woerterbuch(stand, eigentuemer) {
  const objekte = [], einheiten = [], mieter = [];
  const eigene = (eigentuemer || []).map(function (n) { return normal(n).trim(); }).filter(Boolean);
  const eigeneNachnamen = eigene.map(function (n) { return n.split(' ').pop(); });
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
    merkmale.slice().forEach(function (mk) {
      strassenVarianten(mk).forEach(function (v) { if (v.length >= 5 && merkmale.indexOf(v) === -1) merkmale.push(v); });
    });
    objekte.push({ id: o.id, name: name, merkmale: merkmale });
    (o.units || []).forEach(function (x) {
      const n = normal(x.name).trim();
      if (n) einheiten.push({ id: x.id, objekt: o.id, name: x.name || '', merkmal: n });
      String(x.tenant || '').split(/\s*(?:,|&|\/|\bund\b|\+)\s*/).forEach(function (person) {
        const voll = normal(person).trim();
        if (!voll || eigene.indexOf(voll) !== -1) return;
        const teile = voll.split(' ').filter(function (t) { return t.length >= 4 && ALLGEMEIN.indexOf(t) === -1; });
        const nachname = teile[teile.length - 1];
        if (!nachname) return;
        // Gleicher Nachname wie der Vermieter: nur der volle Name ist ein Hinweis
        const nurVoll = eigeneNachnamen.indexOf(nachname) !== -1;
        if (nurVoll && voll.indexOf(' ') === -1) return;
        mieter.push({ name: person.trim(), nachname: nachname, voll: nurVoll ? voll : '', objekt: o.id, einheit: x.id });
      });
    });
  });
  return { objekte: objekte, einheiten: einheiten, mieter: mieter };
}

// Art des Dokuments — erst am Namen, sonst am nächsten Ordner, der etwas verrät („03 Rechnungen“, „04 Verträge“)
const ARTEN = [
  ['Mietvertrag', ['mietvertrag', 'mietvertraege', 'mv']],
  ['Nebenkosten', ['nebenkosten', 'nebenkostenabrechnung', 'betriebskosten', 'betriebskostenabrechnung', 'nka', 'bka', 'heizkosten', 'heizkostenabrechnung', 'einzelabrechnung', 'ista', 'techem', 'brunata']],
  ['Kaution', ['kaution', 'mietkaution', 'kautionsbescheinigung', 'kautionskonto']],
  ['Kündigung', ['kuendigung', 'kuendigungsbestaetigung']],
  ['Übergabeprotokoll', ['uebergabeprotokoll', 'uebergabe', 'abnahmeprotokoll', 'wohnungsuebergabe']],
  ['Selbstauskunft', ['selbstauskunft', 'mieterselbstauskunft', 'schufa', 'gehaltsnachweis', 'lohnabrechnung', 'einkommensnachweis', 'gehaltsabrechnung']],
  ['Versicherung', ['versicherung', 'police', 'versicherungsschein', 'gebaeudeversicherung', 'wohngebaeudeversicherung']],
  ['Plan', ['grundriss', 'grundrisse', 'plan', 'plaene', 'energieausweis', 'flaechenberechnung', 'wohnflaechenberechnung', 'teilungserklaerung', 'grundbuch']],
  ['Angebot', ['angebot', 'kostenvoranschlag', 'kva']],
  ['Rechnung', ['rechnung', 'rechnungen', 'invoice', 'gutschrift', 'quittung', 'beleg', 'belege']],
  ['Protokoll', ['protokoll', 'eigentuemerversammlung', 'wartungsprotokoll', 'pruefbericht']],
  ['Schriftverkehr', ['schreiben', 'brief', 'mahnung', 'mieterhoehung', 'anschreiben']],
  ['Kontoauszug', ['kontoauszug', 'kontoauszuege']],
  ['Vertrag', ['vertrag', 'vertraege', 'kaufvertrag', 'wartungsvertrag', 'stromvertrag', 'liefervertrag']],
  ['Steuer', ['steuer', 'steuern', 'grundsteuer', 'steuerbescheid', 'steuererklaerung', 'grundsteuerbescheid']],
  // Umlagefähige Rechnung (kommt in die Nebenkostenabrechnung) — nicht am Wort zu erkennen, sondern an Rechnung + Ordner
  // „Nebenkosten“ oder von Louis bzw. dem Assistenten beim Ablegen vergeben
  ['Nebenkosten-Rechnung', []]
];
const BILD = /\.(jpe?g|png|heic|heif|gif|webp)$/i;
function artAusText(text) {
  const n = normal(text);
  for (const a of ARTEN) { if (a[1].some(function (w) { return enthaelt(n, w) || (w.length >= 8 && n.indexOf(w) !== -1); })) return a[0]; }
  return '';
}
function artVon(name, mime, pfad) {
  const ausName = artAusText(String(name || '').replace(/\.[a-z0-9]+$/i, ''));
  // Eine Rechnung im Ordner „Nebenkosten“ ist eine umlagefähige Rechnung
  if (ausName === 'Rechnung' && /nebenkosten|betriebskosten/i.test(normal(pfad))) return 'Nebenkosten-Rechnung';
  if (ausName) return ausName;
  if (BILD.test(name || '') || /^image\//.test(mime || '')) return 'Foto';
  const ordner = String(pfad || '').split('/').filter(Boolean).reverse();
  for (const o of ordner) { const a = artAusText(o); if (a) return a; }
  return 'Sonstiges';
}
// Diese Arten gehören zum Mieter, die übrigen zur Wohnung bzw. zum Objekt
const MIETER_ARTEN = ['Mietvertrag', 'Kaution', 'Kündigung', 'Übergabeprotokoll', 'Selbstauskunft', 'Schriftverkehr'];

// Welche Dateien überhaupt in Frage kommen: Dokumente und Fotos, nicht in Ordnern, die erkennbar privat oder technisch sind.
// Google-Dokumente und -Tabellen haben keine Endung — die erkennt man am Typ.
const TYPEN = /\.(pdf|docx?|odt|rtf|xlsx?|ods|txt|jpe?g|png|heic|heif)$/i;
const TYP_OHNE_ENDUNG = /^(application\/pdf|application\/vnd\.google-apps\.(document|spreadsheet)|image\/(jpeg|png|heic|heif))$/;
const AUSSEN_VOR = /(^|\/)(camera roll|eigene aufnahmen|screenshots|whatsapp( images)?|node_modules|\.git|appdata|programme|program files|\.trash|papierkorb)(\/|$)/i;
function kommtInFrage(pfad, name, mime) {
  return (TYPEN.test(String(name || '')) || TYP_OHNE_ENDUNG.test(String(mime || ''))) && !AUSSEN_VOR.test(String(pfad || '') + '/');
}

// Zuordnung am Pfad + Namen. regeln: gelernte Ordner (pfad → objekt/einheit), längster passender Pfad gewinnt.
// Liefert { objekt, einheit, art, sicher, grund } — objekt/einheit leer, wenn nichts passt.
function zuordnen(pfad, name, wb, regeln, mime) {
  const art = artVon(name, mime, pfad);
  const ganz = normal(String(pfad || '') + ' ' + String(name || '').replace(/\.[a-z0-9]+$/i, ''));

  // Hinweise aus Pfad und Namen: Mieternamen (nur eindeutig je Wohnung) und Objekte an Adresse oder Kurzname
  const mieterIn = function (text) {
    return wb.mieter.filter(function (m) { return m.voll ? text.indexOf(' ' + m.voll + ' ') !== -1 : enthaelt(text, m.nachname); });
  };
  const mieterTreffer = mieterIn(ganz);
  const verschiedene = mieterTreffer.filter(function (m, i) { return mieterTreffer.findIndex(function (x) { return x.einheit === m.einheit; }) === i; });
  const objektTreffer = wb.objekte.filter(function (o) {
    return o.merkmale.some(function (mk) { return mk.indexOf(' ') !== -1 ? ganz.indexOf(' ' + mk + ' ') !== -1 : enthaelt(ganz, mk); });
  });
  // Wohnung im Objekt: der Name wörtlich („eg links“) — sonst alle seine Wörter in beliebiger Reihenfolge, wenn eines davon
  // unverwechselbar ist („Werkstatt Kalhamer“ in „Nebenkosten Frank Kalhamer Werkstatt“) und nur eine Wohnung so passt
  const wohnungIm = function (objektId) {
    const hier = wb.einheiten.filter(function (e) { return e.objekt === objektId; });
    const genau = hier.filter(function (e) { return ganz.indexOf(' ' + e.merkmal + ' ') !== -1; })
      .sort(function (a, b) { return b.merkmal.length - a.merkmal.length; })[0];
    if (genau) return genau;
    const lose = hier.filter(function (e) {
      const w = e.merkmal.split(' ');
      return w.some(function (t) { return t.length >= 5 && ALLGEMEIN.indexOf(t) === -1; }) && w.every(function (t) { return enthaelt(ganz, t); });
    });
    return lose.length === 1 ? lose[0] : null;
  };

  // 1. Feste Ordner: von Louis gelernt oder beim Objekt als Beleg-Ordner hinterlegt
  const p = String(pfad || '').toLowerCase();
  const regel = (regeln || []).filter(function (r) { return r.pfad && (p === r.pfad.toLowerCase() || p.indexOf(r.pfad.toLowerCase() + '/') === 0); })
    .sort(function (a, b) { return b.pfad.length - a.pfad.length; })[0];
  if (regel && regel.objekt) {
    // Liegt die Datei tiefer, darf der Pfad die Wohnung verraten — oder ein Mietername dieses Objekts
    let einheit = regel.einheit || '';
    if (!einheit) {
      const w = wohnungIm(regel.objekt);
      const m = verschiedene.filter(function (x) { return x.objekt === regel.objekt; });
      if (w) einheit = w.id;
      else if (m.length === 1) einheit = m[0].einheit;
    }
    // Nennen die Ordner unterhalb oder der Dateiname ausdrücklich ein anderes Objekt (oder einen Mieter von dort), lieber nachfragen
    const rest = normal(String(pfad || '').slice(regel.pfad.length) + ' ' + String(name || '').replace(/\.[a-z0-9]+$/i, ''));
    const objekteRest = wb.objekte.filter(function (o) {
      return o.merkmale.some(function (mk) { return mk.indexOf(' ') !== -1 ? rest.indexOf(' ' + mk + ' ') !== -1 : enthaelt(rest, mk); });
    });
    const mieterRest = mieterIn(rest);
    const anderes = objekteRest.length && !objekteRest.some(function (o) { return o.id === regel.objekt; });
    const andererMieter = mieterRest.length && !mieterRest.some(function (m) { return m.objekt === regel.objekt; });
    if (anderes || andererMieter) {
      const kandidaten = [regel.objekt].concat(objekteRest.map(function (o) { return o.id; }), mieterRest.map(function (m) { return m.objekt; }));
      return { objekt: regel.objekt, einheit: einheit, art: art, sicher: false, grund: 'Ordner, aber der Name spricht für ein anderes Objekt',
        kandidaten: kandidaten.filter(function (k, i) { return kandidaten.indexOf(k) === i; }) };
    }
    return { objekt: regel.objekt, einheit: einheit, art: art, sicher: true, grund: 'Ordner' };
  }

  if (verschiedene.length === 1) {
    const m = verschiedene[0];
    // Passt ein genanntes Objekt nicht zum Mieter, lieber nachfragen
    const widerspruch = objektTreffer.length && !objektTreffer.some(function (o) { return o.id === m.objekt; });
    return { objekt: m.objekt, einheit: m.einheit, art: art, sicher: !widerspruch, grund: 'Mieter ' + m.name };
  }
  if (objektTreffer.length === 1) {
    const o = objektTreffer[0];
    // Wohnung innerhalb des Objekts: „eg links“, „1 og rechts“ …
    const w = wohnungIm(o.id);
    // Mehrere Mieter genannt, aber alle aus diesem Objekt (z. B. ein Mieter mit Wohnung und Gewerbe): das Objekt ist sicher
    const alleHier = verschiedene.every(function (m) { return m.objekt === o.id; });
    return { objekt: o.id, einheit: w ? w.id : '', art: art, sicher: alleHier, grund: 'Objekt ' + o.name.split(',')[0] };
  }
  if (!objektTreffer.length && verschiedene.length > 1 && verschiedene.every(function (m) { return m.objekt === verschiedene[0].objekt; })) {
    const w = wohnungIm(verschiedene[0].objekt);
    return { objekt: verschiedene[0].objekt, einheit: w ? w.id : '', art: art, sicher: true, grund: 'Mieter ' + verschiedene[0].name };
  }
  if (objektTreffer.length > 1 || verschiedene.length > 1) {
    const kandidaten = objektTreffer.map(function (o) { return o.id; }).concat(verschiedene.map(function (m) { return m.objekt; }));
    return { objekt: '', einheit: '', art: art, sicher: false, grund: 'mehrdeutig', kandidaten: kandidaten.filter(function (k, i) { return kandidaten.indexOf(k) === i; }) };
  }
  return { objekt: '', einheit: '', art: art, sicher: false, grund: '' };
}

module.exports = { normal, woerterbuch, artVon, zuordnen, kommtInFrage, MIETER_ARTEN, ARTEN };
