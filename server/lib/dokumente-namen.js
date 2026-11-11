'use strict';

// -------------------------------------------------------------
//  Dateinamen aufräumen: erkennen, was schlecht benannt ist, und einen besseren Namen vorschlagen.
//  Ohne Abhängigkeiten, einzeln testbar. Umbenannt wird hier nichts — das entscheidet Louis in der App.
//
//  Schema: „JJJJ-MM-TT Art Ort Stichwort.endung“ — das Datum nur, wenn es wirklich bekannt ist.
// -------------------------------------------------------------

const BILD = /\.(jpe?g|png|heic|heif|gif|webp)$/i;
function endung(name) { const m = /\.[a-z0-9]{1,5}$/i.exec(String(name || '')); return m ? m[0] : ''; }
function stamm(name) { const e = endung(name); return e ? String(name).slice(0, -e.length) : String(name || ''); }
function istBild(name, mime) { return BILD.test(String(name || '')) || /^image\//.test(String(mime || '')); }

// Kamera-, Scanner- und Platzhalternamen: „IMG_3654“, „Scan_0418“, „Dokument (2)“, nur Ziffern
const KRYPTISCH = /^(img|dsc|dscn|dscf|pxl|mvimg|photo|foto|bild|image|scan|scanned|dokument|document|unbenannt|untitled|neu|new|datei|file|whatsapp image|screenshot|bildschirmfoto)(?![a-zäöüß])[\s_\-.]*(\(?\d[\d\s_\-.:()a-z]{0,30})?$/i;
const SCANNER = /tiny ?scanner|scanned|camscanner|genius ?scan|^scan[\s_\-]?\d/i;
const KOPIE = /[\s_\-–]*(\(\d+\)|kopie|copy|– kopie)\s*$/i;

// Was stimmt mit dem Namen nicht? Leer heißt: ist in Ordnung.
function bewerten(name, mime) {
  const s = stamm(name);
  if (!s.trim()) return 'Kleinigkeit';
  if (KRYPTISCH.test(s.trim()) || /^[\d\s_\-.:()]+$/.test(s) || SCANNER.test(s)) return istBild(name, mime) ? 'Handyfoto' : 'Scan';
  if (/\d{6,}/.test(s) || /\d{4}[-_.]\d{2}[-_.]\d{2}[_ T]\d{2}[-_.:]\d{2}/.test(s)) return 'Code';
  // Kaputte Umlaute aus fremden Programmen: „P__bergabe_Mietfl_che“, Ersatzzeichen, Fragezeichen
  // (klein geschrieben: „_BERTHA“ in Plannamen ist kein kaputtes „Über“)
  const KAPUTT = new RegExp('__|fl_che|_bergabe|_ffn|_nder|\\uFFFD|\\?');
  if (KAPUTT.test(s)) return 'Umlaute';
  if (KOPIE.test(s)) return 'Kopie';
  if (/\s$|^\s|\s{2,}|_{1}.*_/.test(s)) return 'Kleinigkeit';
  return '';
}

// Datum im Namen finden → JJJJ-MM-TT, dazu der Name ohne das Datum
function datumAusName(s) {
  s = String(s || '');
  const muster = [
    // 2025-06-14, 20250614, 202605111257, 2025-11-28_10-35-27
    [/(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_. T]?(?:[01]\d|2[0-3])[-_.:]?[0-5]\d(?:[-_.:]?[0-5]\d)?)?(?!\d)/, function (m) { return [m[1], m[2], m[3]]; }],
    // 30_09_2025, 14.10.2025
    [/(?<!\d)(0[1-9]|[12]\d|3[01])[._-](0[1-9]|1[0-2])[._-]((?:19|20)\d{2})(?!\d)/, function (m) { return [m[3], m[2], m[1]]; }]
  ];
  for (const [re, teile] of muster) {
    const m = re.exec(s);
    if (m) {
      const [j, mo, t] = teile(m);
      return { datum: j + '-' + mo + '-' + t, rest: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim() };
    }
  }
  return { datum: '', rest: s };
}
// EXIF-Zeit von Google („2025:06:14 12:35:10“) → { datum, uhr }
function aufnahmeZeit(t) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})/.exec(String(t || ''));
  return m ? { datum: m[1] + '-' + m[2] + '-' + m[3], uhr: m[4] + '-' + m[5] } : { datum: '', uhr: '' };
}

const gross = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

// Ohne Assistent: Leerzeichen, Unterstriche, Kopie-Endungen, Datum nach vorn
function aufraeumen(name, mitKopie) {
  const e = endung(name);
  let s = stamm(name);
  if (mitKopie) s = s.replace(KOPIE, '');
  if ((s.match(/_/g) || []).length >= 1) s = s.replace(/_+/g, ' ');
  const d = datumAusName(s);
  s = d.rest.replace(/\s*-\s*$/, '').replace(/^\s*-\s*/, '').replace(/\s{2,}/g, ' ').trim();
  s = gross(s);
  const neu = ((d.datum ? d.datum + ' ' : '') + s).trim() || stamm(name).trim();
  return neu + e.toLowerCase();
}

// Allgemeine Ordnernamen sagen nichts über das Foto
const ALLGEMEINE_ORDNER = /^(\d+\s*)?(fotos?|bilder?|images?|pictures?|camera roll|sonstiges|diverses|neu|scans?|dokumente|mieteinheiten|unterlagen)$/i;
function normal(s) {
  return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Fotos: „JJJJ-MM-TT Foto Ort Hinweis.heic“ — Ort aus Objekt und Wohnung, Hinweis aus einem sprechenden Ordnernamen
function fotoName(d, ort) {
  const z = aufnahmeZeit(d.aufnahme);
  const datum = z.datum || datumAusName(stamm(d.name)).datum;
  const teile = String(d.pfad || '').split('/').filter(Boolean);
  const letzter = teile[teile.length - 1] || '';
  const n = normal(letzter);
  const imOrt = normal(ort);
  let hinweis = '';
  if (letzter && !ALLGEMEINE_ORDNER.test(letzter.trim()) && n && imOrt.indexOf(n) === -1 && !/^\d+$/.test(n)) {
    hinweis = letzter.replace(/^\d+\s+/, '').trim();
    // Ordner, der nur Haus oder Wohnung wiederholt („Bertha von Suttna“, „EG Links“), bringt nichts
    if (n.split(' ').some(function (w) { return w.length >= 5 && imOrt.indexOf(w.slice(0, 5)) !== -1; })) hinweis = '';
  }
  const wo = (ort || hinweis || 'ohne Ort').trim();
  const text = (datum ? datum + ' ' : '') + 'Foto ' + wo + (ort && hinweis ? ' ' + hinweis : '');
  return { name: text + endung(d.name).toLowerCase(), uhr: z.uhr };
}

// Fast gleiche Dateien im selben Ordner: gleicher Name ohne „(1)“ / „Kopie“, gleiche Endung
function dubletten(dateien) {
  const gruppen = new Map();
  dateien.forEach(function (d) {
    const schluessel = d.eltern + '|' + normal(stamm(d.name).replace(KOPIE, '')) + '|' + endung(d.name).toLowerCase();
    if (!gruppen.has(schluessel)) gruppen.set(schluessel, []);
    gruppen.get(schluessel).push(d);
  });
  const doppelt = new Map();   // id → Anzahl in der Gruppe
  gruppen.forEach(function (g) {
    if (g.length < 2) return;
    // Das „Original“ (ohne Kopie-Endung) bleibt unmarkiert, wenn es eins gibt
    const original = g.find(function (d) { return !KOPIE.test(stamm(d.name)); });
    g.forEach(function (d) { if (d !== original) doppelt.set(d.id, g.length); });
  });
  return doppelt;
}

// Vom Assistenten oder von Hand vorgeschlagenen Namen absichern: keine Schrägstriche, Länge, Endung bleibt
function sauber(vorschlag, altName) {
  let s = String(vorschlag || '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const e = endung(altName);
  if (e && !s.toLowerCase().endsWith(e.toLowerCase())) {
    // Endung vergessen oder verändert: die alte gilt
    if (endung(s) && endung(s).toLowerCase() !== e.toLowerCase() && BILD.test(e) === BILD.test(endung(s))) s = stamm(s);
    s = s.replace(/\.+$/, '') + e.toLowerCase();
  }
  if (s.length > 180) s = stamm(s).slice(0, 180 - e.length).trim() + e.toLowerCase();
  return stamm(s).trim() ? s : '';
}

module.exports = { bewerten, aufraeumen, fotoName, dubletten, sauber, datumAusName, aufnahmeZeit, endung, stamm, istBild };
