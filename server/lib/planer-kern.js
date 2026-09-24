'use strict';

// -------------------------------------------------------------
//  Planer-Kern: rechnet aus offenen Aufgaben einen Tagesplan.
//
//  Reine Rechnung ohne Todoist, Datenbank oder Uhr — alles, was er
//  braucht, bekommt er übergeben. Dadurch lässt er sich genau testen.
//
//  1. Aus Arbeitszeit, Pause und festen Terminen entstehen freie Lücken.
//  2. Fällige und überfällige Aufgaben werden nach Wichtigkeit sortiert
//     und nacheinander in die früheste passende Lücke gelegt.
//  3. Was heute nicht mehr hineinpasst, wird auf die nächsten Arbeitstage
//     verteilt — so, dass kein Tag mehr als die eingestellte Zeit bekommt.
//  Wiederkehrende Aufgaben werden nie angefasst (sonst ginge die
//  Wiederholung in Todoist verloren).
// -------------------------------------------------------------

const STANDARD = {
  start: '08:00',
  ende: '17:00',
  pauseVon: '12:00',
  pauseBis: '13:00',
  puffer: 10,            // Minuten Luft nach jedem Block
  maxMinuten: 360,       // höchstens so viel Aufgabenzeit pro Tag
  arbeitstage: [1, 2, 3, 4, 5],   // Mo–Fr (0 = Sonntag)
  standardDauer: 30,
  automatisch: false
};

function minuten(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function uhrzeit(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function tagPlus(datum, n) {
  const d = new Date(Date.UTC(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)) - 1, Number(datum.slice(8, 10)) + n));
  return d.toISOString().slice(0, 10);
}
function wochentag(datum) {
  return new Date(datum + 'T00:00:00Z').getUTCDay();
}

// Einstellungen prüfen und mit Vorgaben auffüllen
function einstellungenPruefen(e) {
  const r = Object.assign({}, STANDARD);
  e = e || {};
  ['start', 'ende', 'pauseVon', 'pauseBis'].forEach(function (k) {
    if (e[k] === '' && (k === 'pauseVon' || k === 'pauseBis')) r[k] = '';
    else if (minuten(e[k]) !== null) r[k] = e[k];
  });
  if (minuten(r.ende) <= minuten(r.start)) { r.start = STANDARD.start; r.ende = STANDARD.ende; }
  if (r.pauseVon && r.pauseBis && minuten(r.pauseBis) <= minuten(r.pauseVon)) { r.pauseVon = ''; r.pauseBis = ''; }
  const zahl = function (k, min, max) {
    const n = Number(e[k]);
    if (e[k] !== undefined && e[k] !== null && e[k] !== '' && isFinite(n)) r[k] = Math.max(min, Math.min(max, Math.round(n)));
  };
  zahl('puffer', 0, 60);
  zahl('maxMinuten', 30, 16 * 60);
  zahl('standardDauer', 5, 240);
  if (Array.isArray(e.arbeitstage)) {
    const t = e.arbeitstage.map(Number).filter(function (x) { return x >= 0 && x <= 6; });
    if (t.length) r.arbeitstage = Array.from(new Set(t)).sort();
  }
  if (e.automatisch !== undefined) r.automatisch = !!e.automatisch;
  return r;
}

// Wie lange dauert das wohl? Todoist-Dauer zuerst, sonst ein Blick auf die Worte.
const SCHAETZUNG = [
  [/anruf|anrufen|telefon|zurückrufen|rückruf/i, 15],
  [/mail|e-mail|schreiben|schicken|senden|antworten|nachfragen|whatsapp|nachricht/i, 15],
  [/überweis|bezahlen|zahlen/i, 15],
  [/vor ort|besichtig|fahren|abholen|mitbringen|vorbeifahren|vorbei |montieren|anbringen|tauschen|reparier/i, 60],
  [/klären|prüfen|anschauen|ansehen|raussuchen|suchen|vergleichen|angebot/i, 30]
];
function dauerSchaetzen(a, e) {
  if (a.dauer && a.dauer > 0) return { dauer: Math.round(a.dauer), geschaetzt: false };
  for (const [muster, min] of SCHAETZUNG) {
    if (muster.test(a.inhalt || '')) return { dauer: min, geschaetzt: true };
  }
  return { dauer: e.standardDauer, geschaetzt: true };
}

// Freie Lücken eines Tages: Arbeitszeit minus Pause minus belegte Zeiten (jeweils mit Puffer danach)
function luecken(von, bis, belegt, puffer) {
  const teile = belegt
    .map(function (b) { return [b.von, b.bis + puffer]; })
    .filter(function (b) { return b[1] > von && b[0] < bis; })
    .sort(function (a, b) { return a[0] - b[0]; });
  const frei = [];
  let zeiger = von;
  teile.forEach(function (b) {
    if (b[0] > zeiger) frei.push([zeiger, Math.min(b[0], bis)]);
    zeiger = Math.max(zeiger, b[1]);
  });
  if (zeiger < bis) frei.push([zeiger, bis]);
  return frei.filter(function (l) { return l[1] > l[0]; });
}

// Wichtigstes zuerst: Priorität, dann am längsten überfällig, dann Todoist-Reihenfolge
function reihenfolge(a, b) {
  return (b.prioritaet || 1) - (a.prioritaet || 1)
    || String(a.faellig).localeCompare(String(b.faellig))
    || (a.tagesreihenfolge || 0) - (b.tagesreihenfolge || 0)
    || String(a.angelegt || '').localeCompare(String(b.angelegt || ''))
    || String(a.id).localeCompare(String(b.id));
}

/**
 * @param {object} p
 * @param {string} p.datum         Tag, der geplant wird (JJJJ-MM-TT, Berliner Zeit)
 * @param {number} [p.jetztMin]    aktuelle Minute des Tages, wenn datum heute ist
 * @param {Array}  p.aufgaben      offene Aufgaben (Form wie aufgabeMappen, dazu dauer in Minuten)
 * @param {object} [p.termine]     belegte Zeiten je Tag: { 'JJJJ-MM-TT': [{ von, bis }] } in Minuten
 * @param {object} [p.einstellungen]
 * @param {Array}  [p.vomPlaner]   ids, deren heutige Uhrzeit vom Planer stammt (dürfen neu gelegt werden)
 */
function planen(p) {
  const e = einstellungenPruefen(p.einstellungen);
  const datum = p.datum;
  const termine = p.termine || {};
  // Blöcke, die der Planer selbst schon gelegt hat, darf er beim Neuplanen verschieben
  const vomPlaner = (p.vomPlaner || []).map(String);
  const start = minuten(e.start), ende = minuten(e.ende);
  const istArbeitstag = function (d) { return e.arbeitstage.indexOf(wochentag(d)) !== -1; };

  const ergebnis = { datum: datum, bloecke: [], fest: [], verschoben: [], wiederkehrend: [], ohnePlatz: [], einstellungen: e };

  // Aufgaben einteilen
  const kandidaten = [];
  const spaeter = {};   // Tag -> schon verplante Minuten (Aufgaben, die ohnehin an dem Tag fällig sind)
  (p.aufgaben || []).forEach(function (a) {
    if (!a.faellig) return;
    const d = dauerSchaetzen(a, e);
    const zeitHeute = a.faelligZeit && a.faellig === datum ? minuten(String(a.faelligZeit).slice(11, 16)) : null;
    if (a.wiederkehrend) {
      if (a.faellig <= datum) ergebnis.wiederkehrend.push({ id: a.id, inhalt: a.inhalt });
      if (zeitHeute !== null) ergebnis.fest.push({ id: a.id, inhalt: a.inhalt, von: zeitHeute, bis: zeitHeute + d.dauer });
      return;
    }
    if (zeitHeute !== null && vomPlaner.indexOf(String(a.id)) === -1) {
      // Hat schon eine Uhrzeit heute, die du selbst gesetzt hast: bleibt, wo sie ist
      ergebnis.fest.push({ id: a.id, inhalt: a.inhalt, von: zeitHeute, bis: zeitHeute + d.dauer, dauer: d.dauer });
      return;
    }
    if (a.faellig <= datum) {
      kandidaten.push(Object.assign({}, a, { _dauer: d.dauer, _geschaetzt: d.geschaetzt }));
    } else {
      spaeter[a.faellig] = (spaeter[a.faellig] || 0) + d.dauer;
    }
  });
  kandidaten.sort(reihenfolge);

  // Heute: in die Lücken legen
  let rest = kandidaten;
  if (istArbeitstag(datum)) {
    let von = start;
    if (typeof p.jetztMin === 'number') von = Math.max(von, Math.ceil(p.jetztMin / 15) * 15);
    const belegt = (termine[datum] || []).slice()
      .concat(ergebnis.fest.map(function (f) { return { von: f.von, bis: f.bis }; }));
    if (e.pauseVon && e.pauseBis) belegt.push({ von: minuten(e.pauseVon), bis: minuten(e.pauseBis) - e.puffer });
    let budget = e.maxMinuten - ergebnis.fest.reduce(function (s, f) { return s + (f.dauer || 0); }, 0);
    rest = [];
    kandidaten.forEach(function (a) {
      if (a._dauer > budget) { rest.push(a); return; }
      const frei = luecken(von, ende, belegt, e.puffer);
      const luecke = frei.find(function (l) { return l[1] - l[0] >= a._dauer; });
      if (!luecke) { rest.push(a); return; }
      const bis = luecke[0] + a._dauer;
      ergebnis.bloecke.push({
        id: a.id, inhalt: a.inhalt, projekt: a.projekt || '', prioritaet: a.prioritaet || 1,
        von: uhrzeit(luecke[0]), bis: uhrzeit(bis), dauer: a._dauer, geschaetzt: a._geschaetzt,
        vorher: { faellig: a.faellig, faelligZeit: a.faelligZeit || null }
      });
      belegt.push({ von: luecke[0], bis: bis });
      budget -= a._dauer;
    });
    ergebnis.bloecke.sort(function (a, b) { return a.von.localeCompare(b.von); });
  }

  // Der Rest: auf die nächsten Arbeitstage verteilen
  const tage = [];
  for (let i = 1; tage.length < 30 && i < 120; i++) {
    const d = tagPlus(datum, i);
    if (istArbeitstag(d)) tage.push({ datum: d, frei: e.maxMinuten - (spaeter[d] || 0) });
  }
  rest.forEach(function (a) {
    // Erster Tag mit genug Platz — eine Aufgabe, die länger als ein ganzer Tag ist, bekommt einen leeren Tag
    const tag = tags(tage, a._dauer, e.maxMinuten);
    if (!tag) {
      ergebnis.ohnePlatz.push({ id: a.id, inhalt: a.inhalt, faellig: a.faellig });
      return;
    }
    tag.frei -= a._dauer;
    ergebnis.verschoben.push({
      id: a.id, inhalt: a.inhalt, prioritaet: a.prioritaet || 1, dauer: a._dauer,
      nach: tag.datum, vorher: { faellig: a.faellig, faelligZeit: a.faelligZeit || null }
    });
  });

  return ergebnis;
}

function tags(tage, dauer, max) {
  return tage.find(function (t) { return t.frei >= dauer; })
    || (dauer > max ? tage.find(function (t) { return t.frei === max; }) : null);
}

module.exports = { planen, einstellungenPruefen, dauerSchaetzen, luecken, minuten, uhrzeit, tagPlus, STANDARD };
