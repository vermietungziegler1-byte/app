'use strict';

const express = require('express');
const { db, holen, einstellung, einstellungSetzen } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');

const app = express.Router();

// ---------------- Google Kalender ----------------
//  Die App liest die private iCal-Adresse deines Google-Kalenders mit.
//  Das ist nur eine geheime Textadresse — kein Login, kein Schlüssel.
//  Der Server holt die Datei höchstens alle fünf Minuten neu.

let gkalRoh = { url: '', wann: 0, ereignisse: null };

// Lange Zeilen sind in der Kalenderdatei umgebrochen und beginnen dann mit Leerzeichen
function icsEntfalten(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}
function icsTextLesen(wert) {
  return String(wert || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',')
    .replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Versatz einer Zeitzone zur Weltzeit an einem bestimmten Zeitpunkt
function zonenVersatz(ts, zone) {
  const teile = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ts)).forEach(function (p) { teile[p.type] = p.value; });
  return Date.UTC(Number(teile.year), Number(teile.month) - 1, Number(teile.day),
    Number(teile.hour) % 24, Number(teile.minute), Number(teile.second)) - ts;
}

// Ortszeit einer Zone -> Weltzeit-Zeitstempel (zweimal, wegen der Zeitumstellung)
function ortsZeitZuTs(j, mo, t, st, mi, s, zone) {
  let ts = Date.UTC(j, mo - 1, t, st, mi, s);
  ts = Date.UTC(j, mo - 1, t, st, mi, s) - zonenVersatz(ts, zone);
  ts = Date.UTC(j, mo - 1, t, st, mi, s) - zonenVersatz(ts, zone);
  return ts;
}

// Weltzeit-Zeitstempel -> Berliner Ortszeit, in Einzelteilen
function berlinTeile(ts) {
  const teile = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin', hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(ts)).forEach(function (p) { teile[p.type] = p.value; });
  return {
    j: Number(teile.year), m: Number(teile.month), t: Number(teile.day),
    st: Number(teile.hour) % 24, mi: Number(teile.minute)
  };
}
function berlinText(ts) {
  const p = berlinTeile(ts);
  return p.j + '-' + String(p.m).padStart(2, '0') + '-' + String(p.t).padStart(2, '0')
    + 'T' + String(p.st).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0');
}

// Einen Zeitwert wie "20260901T090000", "…Z" oder ein reines Datum lesen
function icsZeit(wert, params) {
  if (!wert) return null;
  const w = String(wert).trim();
  let m = w.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || /VALUE=DATE(;|$)/.test(String(params || ''))) {
    m = m || w.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { ts: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), ganztags: true,
      datum: m[1] + '-' + m[2] + '-' + m[3] };
  }
  m = w.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const s = Number(m[6] || 0);
  if (m[7]) return { ts: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), s), ganztags: false };
  const zone = (String(params || '').match(/TZID=([^;:]+)/) || [])[1] || 'Europe/Berlin';
  let ts;
  try { ts = ortsZeitZuTs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), s, zone); }
  catch (e) { ts = ortsZeitZuTs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), s, 'Europe/Berlin'); }
  return { ts: ts, ganztags: false };
}

// Alle Einträge (VEVENT) aus der Kalenderdatei herausziehen
function icsEreignisse(text) {
  const zeilen = icsEntfalten(text).split('\n');
  const liste = [];
  let e = null;
  zeilen.forEach(function (zeile) {
    if (zeile === 'BEGIN:VEVENT') { e = { exdaten: [] }; return; }
    if (zeile === 'END:VEVENT') { if (e && e.start) liste.push(e); e = null; return; }
    if (!e) return;
    const doppel = zeile.indexOf(':');
    if (doppel === -1) return;
    const kopf = zeile.slice(0, doppel);
    const wert = zeile.slice(doppel + 1);
    const semi = kopf.indexOf(';');
    const name = (semi === -1 ? kopf : kopf.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? '' : kopf.slice(semi + 1);
    if (name === 'DTSTART') e.start = icsZeit(wert, params);
    else if (name === 'DTEND') e.ende = icsZeit(wert, params);
    else if (name === 'SUMMARY') e.titel = icsTextLesen(wert);
    else if (name === 'LOCATION') e.ort = icsTextLesen(wert);
    else if (name === 'DESCRIPTION') e.notiz = icsTextLesen(wert).slice(0, 2000);
    else if (name === 'UID') e.uid = wert.trim();
    else if (name === 'RRULE') e.regel = wert.trim();
    else if (name === 'STATUS') e.status = wert.trim().toUpperCase();
    else if (name === 'RECURRENCE-ID') e.ausnahmeVon = icsZeit(wert, params);
    else if (name === 'EXDATE') {
      wert.split(',').forEach(function (w) {
        const z = icsZeit(w, params);
        if (z) e.exdaten.push(z.ts);
      });
    }
  });
  return liste.filter(function (x) { return x.status !== 'CANCELLED'; });
}

function regelLesen(text) {
  const r = {};
  String(text || '').split(';').forEach(function (teil) {
    const gleich = teil.indexOf('=');
    if (gleich !== -1) r[teil.slice(0, gleich).toUpperCase()] = teil.slice(gleich + 1);
  });
  return r;
}

const ICS_WTAGE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Der n-te Wochentag eines Monats, z. B. der zweite Montag (n = 2) oder der letzte Freitag (n = -1)
function ntehWoche(j, mo, wtag, n) {
  const TAG = 86400000;
  if (n > 0) {
    const erster = Date.UTC(j, mo - 1, 1);
    const versch = (wtag - new Date(erster).getUTCDay() + 7) % 7;
    const k = erster + (versch + (n - 1) * 7) * TAG;
    return new Date(k).getUTCMonth() === mo - 1 ? k : null;
  }
  const letzter = Date.UTC(j, mo, 0);
  const versch = (new Date(letzter).getUTCDay() - wtag + 7) % 7;
  return letzter - (versch + (-n - 1) * 7) * TAG;
}

// Alle Anfangszeitpunkte eines Eintrags im gewünschten Fenster — Wiederholungen werden aufgelöst
function gkalVorkommen(e, vonTs, bisTs) {
  if (!e.regel) return [e.start.ts];
  const r = regelLesen(e.regel);
  const freq = String(r.FREQ || '').toUpperCase();
  const schritt = Math.max(1, Number(r.INTERVAL) || 1);
  const maxAnzahl = r.COUNT ? Number(r.COUNT) : Infinity;
  let bisRegel = Infinity;
  if (r.UNTIL) {
    const u = icsZeit(r.UNTIL, '');
    if (u) bisRegel = u.ts + 86399000;
  }
  const grenze = Math.min(bisTs, bisRegel);
  const TAG = 86400000;

  // Der erste Anfang in Berliner Ortszeit — die Wiederholung zählt in Kalendertagen weiter
  const p = e.start.ganztags
    ? { j: Number(e.start.datum.slice(0, 4)), m: Number(e.start.datum.slice(5, 7)), t: Number(e.start.datum.slice(8, 10)), st: 0, mi: 0 }
    : berlinTeile(e.start.ts);
  const anfangKal = Date.UTC(p.j, p.m - 1, p.t);
  const zuTs = function (kal) {
    const d = new Date(kal);
    return e.start.ganztags ? kal
      : ortsZeitZuTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.st, p.mi, 0, 'Europe/Berlin');
  };

  const treffer = [];
  let zaehler = 0;

  if (freq === 'DAILY') {
    for (let k = anfangKal, i = 0; i < 40000; i++, k += schritt * TAG) {
      const ts = zuTs(k);
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else if (freq === 'WEEKLY') {
    const tage = (r.BYDAY ? r.BYDAY.split(',') : [])
      .map(function (t) { return ICS_WTAGE[t.slice(-2)]; })
      .filter(function (t) { return t !== undefined; });
    if (!tage.length) tage.push(new Date(anfangKal).getUTCDay());
    const wochenNull = anfangKal - ((new Date(anfangKal).getUTCDay() + 6) % 7) * TAG;
    for (let k = anfangKal, i = 0; i < 40000; i++, k += TAG) {
      const wochen = Math.floor((k - wochenNull) / (7 * TAG));
      if (wochen % schritt !== 0) continue;
      if (tage.indexOf(new Date(k).getUTCDay()) === -1) continue;
      const ts = zuTs(k);
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else if (freq === 'MONTHLY') {
    const nth = r.BYDAY ? String(r.BYDAY).match(/^(-?\d)?([A-Z]{2})$/) : null;
    const tagImMonat = r.BYMONTHDAY ? Number(r.BYMONTHDAY.split(',')[0]) : p.t;
    for (let i = 0; i < 2400; i++) {
      const j = p.j + Math.floor((p.m - 1 + i * schritt) / 12);
      const mo = ((p.m - 1 + i * schritt) % 12) + 1;
      let k;
      if (nth && ICS_WTAGE[nth[2]] !== undefined) {
        k = ntehWoche(j, mo, ICS_WTAGE[nth[2]], Number(nth[1] || 1));
        if (k === null) continue;
      } else {
        if (tagImMonat > new Date(Date.UTC(j, mo, 0)).getUTCDate()) continue;
        k = Date.UTC(j, mo - 1, tagImMonat);
      }
      const ts = zuTs(k);
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else if (freq === 'YEARLY') {
    for (let i = 0; i < 200; i++) {
      const ts = zuTs(Date.UTC(p.j + i * schritt, p.m - 1, p.t));
      if (ts > grenze || zaehler >= maxAnzahl) break;
      zaehler++;
      if (ts >= vonTs - TAG) treffer.push(ts);
    }
  } else {
    return [e.start.ts];
  }
  return treffer;
}

async function gkalHolen() {
  const url = einstellung('gkal_ics');
  if (!url) throw new Error('Keine Kalender-Adresse hinterlegt');
  const frisch = gkalRoh.ereignisse && gkalRoh.url === url && (Date.now() - gkalRoh.wann) < 5 * 60 * 1000;
  if (frisch) return gkalRoh.ereignisse;
  const antwort = await holen(url, { redirect: 'follow' });
  if (!antwort.ok) throw new Error('Google liefert den Kalender nicht (' + antwort.status + ')');
  const text = await antwort.text();
  if (text.indexOf('BEGIN:VCALENDAR') === -1) {
    throw new Error('Das ist keine Kalenderdatei — bitte die private iCal-Adresse prüfen');
  }
  gkalRoh = { url: url, wann: Date.now(), ereignisse: icsEreignisse(text) };
  return gkalRoh.ereignisse;
}

// Die fertige Terminliste für einen Zeitraum, Tag für Tag
function gkalFenster(ereignisse, von, bis) {
  const vonTs = ortsZeitZuTs(Number(von.slice(0, 4)), Number(von.slice(5, 7)), Number(von.slice(8, 10)), 0, 0, 0, 'Europe/Berlin');
  const bisTs = ortsZeitZuTs(Number(bis.slice(0, 4)), Number(bis.slice(5, 7)), Number(bis.slice(8, 10)), 23, 59, 59, 'Europe/Berlin');
  const TAG = 86400000;

  // Einzeln verschobene Wiederholungen verdrängen ihr Original
  const ersetzt = {};
  ereignisse.forEach(function (e) {
    if (e.ausnahmeVon && e.uid) ersetzt[e.uid + '@' + e.ausnahmeVon.ts] = true;
  });

  const liste = [];
  ereignisse.forEach(function (e) {
    const dauer = (e.ende && e.ende.ts > e.start.ts) ? e.ende.ts - e.start.ts
      : (e.start.ganztags ? TAG : 60 * 60000);
    gkalVorkommen(e, vonTs, bisTs).forEach(function (ts) {
      if (!e.ausnahmeVon && e.regel && ersetzt[(e.uid || '') + '@' + ts]) return;
      if (e.exdaten.indexOf(ts) !== -1) return;
      const ende = ts + dauer;
      if (ende <= vonTs || ts > bisTs) return;
      if (e.start.ganztags) {
        // Mehrtägiges bekommt je Tag eine Zeile, dann bleibt die Anzeige einfach
        for (let k = ts, i = 0; k < ende && i < 60; k += TAG, i++) {
          const tag = new Date(k).toISOString().slice(0, 10);
          if (tag < von || tag > bis) continue;
          liste.push({
            id: (e.uid || 'g') + '@' + ts + '@' + tag, titel: e.titel || 'Termin',
            ort: e.ort || '', notiz: e.notiz || '', ganztags: true,
            tag: tag, start: tag, ende: ''
          });
        }
      } else {
        const start = berlinText(ts);
        liste.push({
          id: (e.uid || 'g') + '@' + ts, titel: e.titel || 'Termin',
          ort: e.ort || '', notiz: e.notiz || '', ganztags: false,
          tag: start.slice(0, 10), start: start, ende: berlinText(ende)
        });
      }
    });
  });
  liste.sort(function (a, c) { return a.start < c.start ? -1 : 1; });
  return liste;
}

app.get('/api/gkal', nurAngemeldet, function (req, res) {
  res.json({ eingerichtet: !!einstellung('gkal_ics'), geladen: gkalRoh.wann || null });
});

app.put('/api/gkal', nurAngemeldet, nurVerwalter, async function (req, res) {
  const url = String((req.body || {}).url || '').trim();
  if (!url) {
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('gkal_ics');
    gkalRoh = { url: '', wann: 0, ereignisse: null };
    return res.json({ ok: true, eingerichtet: false });
  }
  if (url.indexOf('https://') !== 0) {
    return res.status(400).json({ fehler: 'Die Adresse muss mit https:// beginnen' });
  }
  try {
    einstellungSetzen('gkal_ics', url);
    gkalRoh = { url: '', wann: 0, ereignisse: null };
    const e = await gkalHolen();
    res.json({ ok: true, eingerichtet: true, anzahl: e.length });
  } catch (fehler) {
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('gkal_ics');
    res.status(502).json({ fehler: fehler.message });
  }
});

app.get('/api/gkal/termine', nurAngemeldet, async function (req, res) {
  const von = String(req.query.von || '').slice(0, 10);
  const bis = String(req.query.bis || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis) || bis < von) {
    return res.status(400).json({ fehler: 'von und bis als JJJJ-MM-TT angeben' });
  }
  try {
    if (req.query.frisch) gkalRoh.wann = 0;
    res.json({ termine: gkalFenster(await gkalHolen(), von, bis) });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

module.exports = { router: app, gkalHolen, gkalFenster, ortsZeitZuTs, berlinText };
