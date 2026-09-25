'use strict';

// -------------------------------------------------------------
//  Aufgaben-Kalender: Der Tagesplaner trägt seine Blöcke in einen
//  eigenen Google-Kalender „Aufgaben“ ein. Die App darf nur diesen
//  Kalender anfassen (Zugriff „calendar.app.created“), nie deine
//  anderen Termine. Jede Aufgabe hat höchstens einen Eintrag; wird
//  sie neu geplant, zieht der Eintrag mit, wird sie erledigt oder
//  verschoben, verschwindet er.
// -------------------------------------------------------------

const { db, holen, einstellung, einstellungSetzen } = require('./kern');
const { googleEinstellungen, googleToken } = require('./google');

const API = process.env.GKAL_API || 'https://www.googleapis.com/calendar/v3';
const RECHT = 'https://www.googleapis.com/auth/calendar.app.created';

db.exec(`
  CREATE TABLE IF NOT EXISTS gkal_bloecke (
    aufgabe   TEXT PRIMARY KEY,
    ereignis  TEXT NOT NULL,
    datum     TEXT NOT NULL
  );
`);

// Darf die App schreiben? Google verbunden und das Kalender-Recht erteilt
function bereit() {
  const g = googleEinstellungen();
  return !!(g.refresh && String(einstellung('google_scope') || '').indexOf(RECHT) !== -1);
}

function fehlerMerken(text) {
  einstellungSetzen('gkal_schreiben_fehler', text || '');
}

async function anfrage(pfad, optionen) {
  const token = await googleToken();
  const antwort = await holen(API + pfad, Object.assign({}, optionen, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (optionen || {}).headers || {})
  }));
  if (antwort.status === 204) return null;
  const text = await antwort.text();
  let daten = null;
  try { daten = text ? JSON.parse(text) : null; } catch (e) { daten = null; }
  if (!antwort.ok) {
    const grund = (daten && daten.error && (daten.error.message || daten.error.status)) || text.slice(0, 200);
    const e = new Error(/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(grund)
      ? 'Die Google Calendar API ist im Google-Cloud-Projekt nicht aktiviert — dort unter APIs & Dienste → Bibliothek → Google Calendar API → Aktivieren'
      : (antwort.status === 403 || antwort.status === 401
        ? 'Google erlaubt das Eintragen in den Kalender nicht — bitte unter Menü → Postfach neu verbinden'
        : 'Google-Kalender: ' + grund));
    e.status = antwort.status;
    throw e;
  }
  return daten;
}

// Der eigene Kalender „Aufgaben“ — beim ersten Mal anlegen
async function kalenderId() {
  const vorhanden = einstellung('gkal_aufgaben_id');
  if (vorhanden) return vorhanden;
  const k = await anfrage('/calendars', { method: 'POST', body: JSON.stringify({ summary: 'Aufgaben', timeZone: 'Europe/Berlin' }) });
  einstellungSetzen('gkal_aufgaben_id', k.id);
  return k.id;
}

function plusMinuten(datum, hhmm, dauer) {
  const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + dauer;
  const tag = new Date(Date.UTC(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)) - 1, Number(datum.slice(8, 10)) + Math.floor(m / 1440)));
  const rest = ((m % 1440) + 1440) % 1440;
  return tag.toISOString().slice(0, 10) + 'T' + String(Math.floor(rest / 60)).padStart(2, '0') + ':' + String(rest % 60).padStart(2, '0') + ':00';
}

// Einen Block eintragen oder, wenn es ihn schon gibt, verschieben
async function blockEintragen(b) {
  const id = await kalenderId();
  const ereignis = {
    summary: b.inhalt,
    description: (b.url ? b.url + '\n\n' : '') + 'Vom Tagesplan eingetragen.',
    start: { dateTime: b.datum + 'T' + b.von + ':00', timeZone: 'Europe/Berlin' },
    end: { dateTime: plusMinuten(b.datum, b.von, b.dauer || 30), timeZone: 'Europe/Berlin' },
    reminders: { useDefault: false, overrides: [] }   // erinnert wird per Mitteilung aus der App
  };
  const alt = db.prepare('SELECT * FROM gkal_bloecke WHERE aufgabe = ?').get(String(b.id));
  if (alt) {
    try {
      await anfrage('/calendars/' + encodeURIComponent(id) + '/events/' + encodeURIComponent(alt.ereignis),
        { method: 'PATCH', body: JSON.stringify(ereignis) });
      db.prepare('UPDATE gkal_bloecke SET datum = ? WHERE aufgabe = ?').run(b.datum, String(b.id));
      return;
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;   // in Google gelöscht: neu anlegen
    }
  }
  const neu = await anfrage('/calendars/' + encodeURIComponent(id) + '/events', { method: 'POST', body: JSON.stringify(ereignis) });
  db.prepare('INSERT OR REPLACE INTO gkal_bloecke (aufgabe, ereignis, datum) VALUES (?,?,?)').run(String(b.id), neu.id, b.datum);
}

// Den Eintrag einer Aufgabe entfernen (erledigt, verschoben, zurückgenommen)
async function blockEntfernen(aufgabeId) {
  const alt = db.prepare('SELECT * FROM gkal_bloecke WHERE aufgabe = ?').get(String(aufgabeId));
  if (!alt) return;
  const id = einstellung('gkal_aufgaben_id');
  if (id) {
    try {
      await anfrage('/calendars/' + encodeURIComponent(id) + '/events/' + encodeURIComponent(alt.ereignis), { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
  db.prepare('DELETE FROM gkal_bloecke WHERE aufgabe = ?').run(String(aufgabeId));
}

// Einen ganzen Plan abgleichen. Fehler brechen den Plan nie ab, sie werden gemerkt und angezeigt.
async function planEintragen(bloecke, weg) {
  if (!bereit()) return { eingetragen: 0, fehler: null };
  let eingetragen = 0;
  try {
    for (const b of bloecke) { await blockEintragen(b); eingetragen++; }
    for (const id of weg) await blockEntfernen(id);
    fehlerMerken('');
    return { eingetragen: eingetragen, fehler: null };
  } catch (e) {
    fehlerMerken(e.message);
    return { eingetragen: eingetragen, fehler: e.message };
  }
}

// Für Erledigt/Rückgängig: still im Hintergrund, ohne die eigentliche Aktion aufzuhalten
function spaeterEntfernen(ids) {
  if (!bereit()) return;
  (async function () {
    for (const id of ids) await blockEntfernen(id);
  })().catch(function (e) { fehlerMerken(e.message); });
}

// Eine einzelne Aufgabe nach einer Änderung: mit Uhrzeit → Eintrag, sonst weg. Still im Hintergrund.
function aufgabeAbgleichen(a) {
  if (!bereit() || !a || !a.id) return;
  (async function () {
    let zeit = a.faelligZeit ? String(a.faelligZeit) : '';
    if (/Z$|[+-]\d\d:\d\d$/.test(zeit)) {
      const d = new Date(zeit);
      if (!isNaN(d)) zeit = require('./kalender').berlinText(d.getTime());
    }
    if (zeit.length >= 16) {
      await blockEintragen({ id: a.id, inhalt: a.inhalt, datum: zeit.slice(0, 10), von: zeit.slice(11, 16), dauer: a.dauer || 30, url: a.url });
    } else {
      await blockEntfernen(a.id);
    }
  })().catch(function (e) { fehlerMerken(e.message); });
}

function stand() {
  const g = googleEinstellungen();
  return {
    verbunden: !!g.refresh,
    erlaubt: bereit(),
    fehler: einstellung('gkal_schreiben_fehler') || null
  };
}

module.exports = { RECHT, bereit, planEintragen, blockEntfernen, spaeterEntfernen, aufgabeAbgleichen, stand };
