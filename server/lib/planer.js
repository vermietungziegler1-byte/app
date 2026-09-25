'use strict';

// -------------------------------------------------------------
//  Tagesplaner: legt fällige Aufgaben als Zeitblöcke in freie
//  Lücken des Tages und verteilt, was nicht passt, auf die
//  nächsten Arbeitstage. Übernommen wird direkt in Todoist
//  (Uhrzeit + Dauer bzw. neues Datum). Jede Übernahme wird
//  protokolliert und lässt sich rückgängig machen.
//  Die eigentliche Rechnung steckt in planer-kern.js.
// -------------------------------------------------------------

const express = require('express');
const { db, einstellung, einstellungSetzen, berlinJetzt, standInhalt, mitFehler } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const { todoist, todoistListe, aufgabeMappen } = require('./todoist');
const { gkalHolen, gkalFenster, ortsZeitZuTs, berlinText } = require('./kalender');
const kern = require('./planer-kern');
const aufgabenkalender = require('./aufgabenkalender');

const app = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS planer_protokoll (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    datum         TEXT NOT NULL,
    wann          INTEGER NOT NULL,
    wer           TEXT,
    aenderungen   TEXT NOT NULL,
    zurueck       INTEGER NOT NULL DEFAULT 0
  );
`);

function planerEinstellungen() {
  let e = {};
  try { e = JSON.parse(einstellung('planer') || '{}'); } catch (x) { e = {}; }
  return kern.einstellungenPruefen(e);
}

// "JJJJ-MM-TTTHH:MM" in Berliner Zeit → Zeitpunkt in UTC für Todoist
function berlinNachUtc(datum, hhmm) {
  const ts = ortsZeitZuTs(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)), Number(datum.slice(8, 10)),
    Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 'Europe/Berlin');
  return new Date(ts).toISOString().replace('.000Z', 'Z');
}

// Todoist liefert Uhrzeiten mal als Ortszeit ("…T09:00:00"), mal in Weltzeit ("…T07:00:00Z").
// Der Planer rechnet immer in Berliner Ortszeit.
function inOrtszeit(a) {
  if (!a.faelligZeit || !/Z$|[+-]\d\d:\d\d$/.test(a.faelligZeit)) return a;
  const d = new Date(a.faelligZeit);
  if (isNaN(d)) return a;
  const t = berlinText(d.getTime());
  return Object.assign({}, a, { faelligZeit: t, faellig: t.slice(0, 10) });
}

// Belegte Zeiten eines Tages: Google-Kalender und Besichtigungen
async function belegteZeiten(datum) {
  const belegt = [];
  if (einstellung('gkal_ics')) {
    try {
      gkalFenster(await gkalHolen(), datum, datum).forEach(function (g) {
        if (g.ganztags) return;
        const von = kern.minuten(g.start.slice(11, 16));
        let bis = g.ende && g.ende.slice(0, 10) === datum ? kern.minuten(g.ende.slice(11, 16)) : 24 * 60;
        if (bis <= von) bis = von + 30;
        belegt.push({ von: von, bis: bis });
      });
    } catch (e) { /* ohne Kalender geht es auch */ }
  }
  const d = standInhalt() || {};
  (d.interessenten || []).forEach(function (i) {
    if (i.status === 'absage' || !i.termin || i.termin.slice(0, 10) !== datum || i.termin.length <= 10) return;
    const von = kern.minuten(i.termin.slice(11, 16));
    if (von !== null) belegt.push({ von: von, bis: von + 45 });
  });
  return belegt;
}

// Letzte, nicht zurückgenommene Übernahme für einen Tag
function letzteUebernahme(datum) {
  const z = db.prepare('SELECT * FROM planer_protokoll WHERE datum = ? AND zurueck = 0 ORDER BY id DESC LIMIT 1').get(datum);
  if (!z) return null;
  let aenderungen = [];
  try { aenderungen = JSON.parse(z.aenderungen); } catch (e) { /* leer */ }
  return { id: z.id, datum: z.datum, wann: z.wann, wer: z.wer, aenderungen: aenderungen };
}

// Den Plan für einen Tag ausrechnen (ohne etwas zu ändern)
async function vorschlag(datum, roh) {
  const heute = berlinJetzt();
  datum = /^\d{4}-\d{2}-\d{2}$/.test(datum || '') ? datum : heute.datum;
  const aufgaben = (roh || await todoistListe('/tasks')).map(function (t) { return inOrtszeit(aufgabeMappen(t, null)); });
  const letzte = letzteUebernahme(datum);
  const plan = kern.planen({
    datum: datum,
    jetztMin: datum === heute.datum ? kern.minuten(heute.zeit) : null,
    aufgaben: aufgaben,
    termine: { [datum]: await belegteZeiten(datum) },
    einstellungen: planerEinstellungen(),
    vomPlaner: letzte ? letzte.aenderungen.filter(function (a) { return a.art === 'block'; }).map(function (a) { return a.id; }) : []
  });
  // Feste Uhrzeiten für die Anzeige als HH:MM wie die Blöcke
  plan.fest = plan.fest.map(function (f) {
    return { id: f.id, inhalt: f.inhalt, von: kern.uhrzeit(f.von), bis: kern.uhrzeit(f.bis) };
  });
  plan.aenderungen = plan.bloecke.filter(function (b) {
    // Steht schon genau so in Todoist? Dann nichts ändern.
    return !(b.vorher.faelligZeit && String(b.vorher.faelligZeit).slice(0, 16) === datum + 'T' + b.von);
  }).length + plan.verschoben.length + plan.eingeplant.length;
  plan.letzteUebernahme = letzte ? { wann: letzte.wann, wer: letzte.wer, anzahl: letzte.aenderungen.length } : null;
  return plan;
}

// Mehrere Todoist-Anfragen, höchstens drei gleichzeitig
async function nacheinander(liste, fn) {
  const fehler = [];
  let i = 0;
  async function arbeiter() {
    while (i < liste.length) {
      const e = liste[i++];
      try { await fn(e); } catch (x) { fehler.push({ id: e.id, inhalt: e.inhalt, fehler: x.message }); }
    }
  }
  await Promise.all([arbeiter(), arbeiter(), arbeiter()]);
  return fehler;
}

// Plan ausrechnen und in Todoist eintragen
async function uebernehmen(datum, wer) {
  const roh = await todoistListe('/tasks');
  const plan = await vorschlag(datum, roh);
  const aufgaben = {};   // so, wie sie vorher in Todoist standen — für Rückgängig
  roh.forEach(function (t) { aufgaben[String(t.id)] = aufgabeMappen(t, null); });

  const auftraege = [];
  plan.bloecke.forEach(function (b) {
    if (b.vorher.faelligZeit && String(b.vorher.faelligZeit).slice(0, 16) === plan.datum + 'T' + b.von) return;
    auftraege.push({ art: 'block', id: b.id, inhalt: b.inhalt,
      koerper: { due_datetime: berlinNachUtc(plan.datum, b.von), duration: b.dauer, duration_unit: 'minute' } });
  });
  plan.verschoben.forEach(function (v) {
    auftraege.push({ art: 'verschoben', id: v.id, inhalt: v.inhalt, koerper: { due_date: v.nach } });
  });
  plan.eingeplant.forEach(function (v) {
    auftraege.push({ art: 'eingeplant', id: v.id, inhalt: v.inhalt, koerper: { due_date: v.nach } });
  });

  const erledigt = [];
  const fehler = await nacheinander(auftraege, async function (a) {
    const vorher = aufgaben[a.id] || {};
    await todoist('/tasks/' + encodeURIComponent(a.id), { method: 'POST', body: JSON.stringify(a.koerper) });
    erledigt.push({ art: a.art, id: a.id, inhalt: a.inhalt,
      vorher: { faellig: vorher.faellig || null, faelligZeit: vorher.faelligZeit || null, dauer: vorher.dauer || null } });
  });

  if (erledigt.length) {
    db.prepare('INSERT INTO planer_protokoll (datum, wann, wer, aenderungen) VALUES (?,?,?,?)')
      .run(plan.datum, Date.now(), wer || null, JSON.stringify(erledigt));
  }

  // In den Google-Kalender „Aufgaben“: jeder Block mit Uhrzeit; wer auf einen anderen Tag wandert, fliegt raus
  const url = {};
  roh.forEach(function (t) { url[String(t.id)] = aufgabeMappen(t, null).url; });
  const kalender = await aufgabenkalender.planEintragen(
    plan.bloecke.map(function (b) { return { id: b.id, inhalt: b.inhalt, datum: plan.datum, von: b.von, dauer: b.dauer, url: url[b.id] }; }),
    plan.verschoben.map(function (v) { return v.id; }));

  return { plan: plan, geaendert: erledigt.length, fehler: fehler, kalender: kalender };
}

// Die letzte Übernahme eines Tages zurücknehmen
async function rueckgaengig(datum) {
  datum = /^\d{4}-\d{2}-\d{2}$/.test(datum || '') ? datum : berlinJetzt().datum;
  const letzte = letzteUebernahme(datum);
  if (!letzte) { const e = new Error('Für diesen Tag gibt es nichts zurückzunehmen'); e.status = 400; throw e; }
  const fehler = await nacheinander(letzte.aenderungen, async function (a) {
    const v = a.vorher || {};
    let koerper;
    if (v.faelligZeit && v.faelligZeit.length > 10) {
      // Todoist liefert Uhrzeiten entweder mit Z (UTC) oder ohne Zone (Ortszeit)
      const zeit = String(v.faelligZeit);
      koerper = { due_datetime: /Z$|[+-]\d\d:\d\d$/.test(zeit) ? zeit : berlinNachUtc(zeit.slice(0, 10), zeit.slice(11, 16)) };
      if (v.dauer) { koerper.duration = v.dauer; koerper.duration_unit = 'minute'; }
    } else if (v.faellig) {
      koerper = { due_date: v.faellig };
    } else {
      koerper = { due_string: 'no date' };
    }
    await todoist('/tasks/' + encodeURIComponent(a.id), { method: 'POST', body: JSON.stringify(koerper) });
  });
  db.prepare('UPDATE planer_protokoll SET zurueck = 1 WHERE id = ?').run(letzte.id);
  aufgabenkalender.spaeterEntfernen(letzte.aenderungen.filter(function (a) { return a.art === 'block'; }).map(function (a) { return a.id; }));
  return { zurueck: letzte.aenderungen.length - fehler.length, fehler: fehler };
}

// ---------------- Automatik ----------------
// Ist "jeden Morgen automatisch" eingeschaltet, plant der Server einmal am Tag
// selbst — spätestens eine Stunde vor Arbeitsbeginn, die Morgenmitteilung wartet darauf.

let automatikLaeuft = null;
async function automatischPlanen(datum) {
  const e = planerEinstellungen();
  if (!e.automatisch || !einstellung('todoist_token')) return null;
  // Läuft die Planung gerade? Dann auf dasselbe Ergebnis warten statt ein zweites Mal zu planen
  if (automatikLaeuft) return automatikLaeuft;
  if (einstellung('planer_auto_datum') === datum) {
    try { return JSON.parse(einstellung('planer_auto_ergebnis') || 'null'); } catch (x) { return null; }
  }
  automatikLaeuft = (async function () {
    einstellungSetzen('planer_auto_datum', datum);   // vorher setzen: bei Fehlern nicht jede Minute neu versuchen
    const r = await uebernehmen(datum, 'Automatik');
    const kurz = { bloecke: r.plan.bloecke, verschoben: r.plan.verschoben.length, eingeplant: r.plan.eingeplant.length, fehler: r.fehler.length };
    einstellungSetzen('planer_auto_ergebnis', JSON.stringify(kurz));
    return kurz;
  })();
  try { return await automatikLaeuft; } finally { automatikLaeuft = null; }
}

setInterval(function () {
  const t = berlinJetzt();
  const e = planerEinstellungen();
  if (!e.automatisch) return;
  if (kern.minuten(t.zeit) < kern.minuten(e.start) - 60 || kern.minuten(t.zeit) >= kern.minuten(e.ende)) return;
  automatischPlanen(t.datum).catch(function (fehler) { console.log('Automatische Tagesplanung fehlgeschlagen:', fehler.message); });
}, 60 * 1000).unref();

// Eine Zeile für die Morgenmitteilung: "08:00 Stadtwerke anrufen · 08:25 Nebenkosten … (+3) · 5 auf die nächsten Tage"
function planKurztext(bloecke, verschoben, eingeplant) {
  const teile = [];
  if (bloecke.length) {
    const erste = bloecke.slice(0, 3).map(function (b) { return b.von + ' ' + b.inhalt; }).join(' · ');
    teile.push(erste + (bloecke.length > 3 ? ' (+' + (bloecke.length - 3) + ')' : ''));
  }
  if (verschoben) teile.push(verschoben + (verschoben === 1 ? ' Aufgabe' : ' Aufgaben') + ' auf die nächsten Tage verteilt');
  if (eingeplant) teile.push(eingeplant + (eingeplant === 1 ? ' Aufgabe ohne Datum' : ' Aufgaben ohne Datum') + ' eingeplant');
  return teile.join(' · ');
}

// ---------------- Schnittstellen ----------------

app.get('/api/plan', nurAngemeldet, mitFehler(async function (req, res) {
  res.json(await vorschlag(req.query.datum));
}));

app.post('/api/plan', nurAngemeldet, mitFehler(async function (req, res) {
  res.json(await uebernehmen((req.body || {}).datum, req.nutzer));
}));

app.post('/api/plan/rueckgaengig', nurAngemeldet, mitFehler(async function (req, res) {
  res.json(await rueckgaengig((req.body || {}).datum));
}));

app.get('/api/plan/einstellungen', nurAngemeldet, function (req, res) {
  res.json(Object.assign({}, planerEinstellungen(), { kalender: aufgabenkalender.stand() }));
});

app.put('/api/plan/einstellungen', nurAngemeldet, nurVerwalter, function (req, res) {
  const e = kern.einstellungenPruefen(Object.assign({}, planerEinstellungen(), req.body || {}));
  einstellungSetzen('planer', JSON.stringify(e));
  res.json(Object.assign({}, e, { kalender: aufgabenkalender.stand() }));
});

module.exports = { router: app, vorschlag, uebernehmen, rueckgaengig, planerEinstellungen, automatischPlanen, planKurztext };
