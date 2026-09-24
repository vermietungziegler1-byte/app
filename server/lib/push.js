'use strict';

const express = require('express');
const { db, einstellung, einstellungSetzen, berlinJetzt, standInhalt } = require('./kern');
const { nurAngemeldet, nurVerwalter, rolleVon } = require('./anmeldung');
const { todoistListe } = require('./todoist');
const { googleEinstellungen, googleToken, gmail, MAIL_KOPF } = require('./google');

const app = express.Router();

// ---------------- Mitteilungen (Web Push) ----------------
// Der Server schickt Push-Mitteilungen an angemeldete Geräte:
// morgens eine Tagesübersicht, dazu eine Probemitteilung auf Wunsch.
// Braucht das Paket web-push — fehlt es, läuft alles andere trotzdem.

let webpush = null;
try { webpush = require('web-push'); }
catch (e) { console.log('Hinweis: web-push fehlt — Mitteilungen bleiben aus. Nachrüsten mit: npm install web-push'); }

db.exec(`
  CREATE TABLE IF NOT EXISTS push_abos (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nutzer    TEXT,
    geraet    TEXT,
    endpoint  TEXT UNIQUE,
    abo       TEXT NOT NULL,
    angelegt  TEXT
  );
`);

function vapid() {
  if (!webpush) return null;
  let roh = einstellung('vapid_schluessel');
  if (!roh) {
    roh = JSON.stringify(webpush.generateVAPIDKeys());
    einstellungSetzen('vapid_schluessel', roh);
  }
  const k = JSON.parse(roh);
  webpush.setVapidDetails('https://zieglerverwaltung.immobilien', k.publicKey, k.privateKey);
  return k;
}
if (webpush) vapid();

function ohneWebpush(res) {
  res.status(500).json({ fehler: 'Auf dem Server fehlt das Paket web-push. Einmalig im Ordner server ausführen: npm install web-push — danach den Dienst neu starten.' });
}

app.get('/api/push/schluessel', nurAngemeldet, function (req, res) {
  if (!webpush) return ohneWebpush(res);
  res.json({ schluessel: vapid().publicKey });
});

app.post('/api/push/anmelden', nurAngemeldet, function (req, res) {
  if (!webpush) return ohneWebpush(res);
  const { abo, geraet } = req.body || {};
  if (!abo || !abo.endpoint) return res.status(400).json({ fehler: 'Kein gültiges Abo' });
  db.prepare(`INSERT INTO push_abos (nutzer, geraet, endpoint, abo, angelegt) VALUES (?,?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET nutzer=excluded.nutzer, geraet=excluded.geraet, abo=excluded.abo`)
    .run(req.nutzer, String(geraet || 'Gerät').slice(0, 60), abo.endpoint, JSON.stringify(abo), new Date().toISOString());
  res.json({ ok: true });
});

app.post('/api/push/abmelden', nurAngemeldet, function (req, res) {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_abos WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

// Jeder sieht und entfernt seine eigenen Geräte, der Verwalter alle
app.get('/api/push/geraete', nurAngemeldet, function (req, res) {
  if (rolleVon(req.nutzer) === 'verwalter') {
    return res.json(db.prepare('SELECT id, nutzer, geraet, endpoint, angelegt FROM push_abos ORDER BY id').all());
  }
  res.json(db.prepare('SELECT id, nutzer, geraet, endpoint, angelegt FROM push_abos WHERE lower(nutzer) = lower(?) ORDER BY id')
    .all(req.nutzer));
});

app.delete('/api/push/geraete/:id', nurAngemeldet, function (req, res) {
  const abo = db.prepare('SELECT nutzer FROM push_abos WHERE id = ?').get(req.params.id);
  if (!abo) return res.json({ ok: true });
  if (rolleVon(req.nutzer) !== 'verwalter' && String(abo.nutzer || '').toLowerCase() !== req.nutzer.toLowerCase()) {
    return res.status(403).json({ fehler: 'Nur eigene Geräte lassen sich entfernen' });
  }
  db.prepare('DELETE FROM push_abos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function pushEinstellungenLesen() {
  let e = {};
  try { e = JSON.parse(einstellung('push_morgen') || '{}'); } catch (fehler) { e = {}; }
  return e;
}
function pushEinstellungenAntwort(e) {
  return {
    zeit: e.zeit || '07:00',
    morgen: e.morgen !== false,
    termine: e.termine !== false,
    anfragen: e.anfragen !== false
  };
}

app.get('/api/push/einstellungen', nurAngemeldet, function (req, res) {
  res.json(pushEinstellungenAntwort(pushEinstellungenLesen()));
});

// Gilt für alle Geräte — deshalb nur für den Verwalter
app.put('/api/push/einstellungen', nurAngemeldet, nurVerwalter, function (req, res) {
  const { zeit, morgen, termine, anfragen } = req.body || {};
  const e = pushEinstellungenLesen();
  if (typeof zeit === 'string' && /^\d{2}:\d{2}$/.test(zeit)) e.zeit = zeit;
  if (morgen !== undefined) e.morgen = !!morgen;
  if (termine !== undefined) e.termine = !!termine;
  if (anfragen !== undefined) e.anfragen = !!anfragen;
  einstellungSetzen('push_morgen', JSON.stringify(e));
  res.json(pushEinstellungenAntwort(e));
});

async function mitteilungSenden(zeilen, nachricht) {
  const nutzlast = JSON.stringify(nachricht);
  for (const z of zeilen) {
    try { await webpush.sendNotification(JSON.parse(z.abo), nutzlast); }
    catch (e) {
      // 404/410: das Gerät hat das Abo gekündigt — Eintrag aufräumen
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare('DELETE FROM push_abos WHERE id = ?').run(z.id);
      }
    }
  }
}

app.post('/api/push/test', nurAngemeldet, async function (req, res) {
  if (!webpush) return ohneWebpush(res);
  const zeilen = db.prepare('SELECT * FROM push_abos WHERE nutzer = ?').all(req.nutzer);
  if (!zeilen.length) return res.status(400).json({ fehler: 'Zuerst auf einem Gerät aktivieren' });
  await mitteilungSenden(zeilen, { titel: 'Ziegler', text: 'Probemitteilung — es funktioniert.', url: '/' });
  res.json({ ok: true, geraete: zeilen.length });
});

// --- Morgenmeldung: Tagesübersicht aus den eigenen Daten und Todoist ---

async function morgenInhalt(heute) {
  const teile = [];
  const zeile = db.prepare('SELECT inhalt FROM stand WHERE id = 1').get();
  const d = zeile ? JSON.parse(zeile.inhalt) : null;

  // Aufgaben aus Todoist: überfällig oder heute fällig
  try {
    if (einstellung('todoist_token')) {
      const liste = await todoistListe('/tasks');
      const anzahl = liste.filter(function (t) {
        const f = t.due && (t.due.date || t.due.datetime);
        return f && String(f).slice(0, 10) <= heute;
      }).length;
      if (anzahl) teile.push(anzahl + (anzahl === 1 ? ' Aufgabe fällig' : ' Aufgaben fällig'));
    }
  } catch (e) { /* Todoist gerade nicht erreichbar — Meldung geht trotzdem raus */ }

  if (d) {
    // Besichtigungen heute
    const b = (d.interessenten || []).filter(function (i) {
      return i.termin && i.termin.slice(0, 10) === heute && i.status !== 'absage';
    }).sort(function (a, c) { return a.termin < c.termin ? -1 : 1; });
    if (b.length === 1) {
      teile.push('Besichtigung ' + (b[0].termin.length > 10 ? b[0].termin.slice(11, 16) + ' ' : '') + (b[0].name || ''));
    } else if (b.length) {
      teile.push(b.length + ' Besichtigungen');
    }

    // Rückstände der letzten sechs Monate, wie in der Oberfläche
    const monate = [];
    const jetzt = new Date();
    for (let i = 5; i >= 0; i--) {
      const m = new Date(jetzt.getFullYear(), jetzt.getMonth() - i, 1);
      monate.push(m.getFullYear() + '-' + String(m.getMonth() + 1).padStart(2, '0'));
    }
    let offen = 0, frei = 0;
    (d.objects || []).forEach(function (o) {
      (o.units || []).forEach(function (x) {
        if (x.status === 'frei') frei++;
        if (x.status !== 'vermietet') return;
        const soll = (Number(x.rent) || 0) + (Number(x.parking) || 0) + (Number(x.kitchen) || 0) + (Number(x.nk) || 0);
        monate.forEach(function (m) {
          if (x.zahlungen && x.zahlungen[m] != null) offen += soll - (Number(x.zahlungen[m]) || 0);
        });
      });
    });
    if (offen > 0.5) teile.push(Math.round(offen).toLocaleString('de-DE') + ' € Rückstand');

    // Fristen: Prüfungen und Mietspiegel binnen 14 Tagen oder überfällig
    let fristen = 0;
    const bald = new Date(Date.now() + 14 * 86400000);
    (d.objects || []).forEach(function (o) {
      (o.pruefungen || []).forEach(function (p) {
        if (!p.letzte) return;
        const naechste = new Date(p.letzte);
        if (isNaN(naechste)) return;
        naechste.setMonth(naechste.getMonth() + (Number(p.intervall) || 12));
        if (naechste <= bald) fristen++;
      });
      if (o.mietspiegelBis) {
        const bis = new Date(o.mietspiegelBis);
        if (!isNaN(bis) && bis <= bald) fristen++;
      }
    });
    if (fristen) teile.push(fristen + (fristen === 1 ? ' Frist' : ' Fristen'));
    if (frei) teile.push(frei + ' frei');
  }

  return teile.length ? teile.join(' · ') : 'Nichts Dringendes. Guter Tag zum Aufräumen.';
}

if (webpush) {
  let anfragenZuletzt = 0;   // wann zuletzt bei Google nachgesehen wurde

  // --- Morgenmeldung zur eingestellten Zeit ---
  async function morgenTick(e, t) {
    if (e.morgen === false) return;
    // Nicht nur in genau der eingestellten Minute: Lief der Server da gerade nicht
    // (Neustart, kurz beschäftigt), wird innerhalb der folgenden Stunde nachgeholt.
    const minuten = function (hhmm) { return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)); };
    const spaeter = minuten(t.zeit) - minuten(e.zeit || '07:00');
    if (spaeter < 0 || spaeter > 60) return;
    if (einstellung('push_zuletzt') === t.datum) return;
    einstellungSetzen('push_zuletzt', t.datum);   // vor dem Senden, sonst klingelt es bei Fehlern jede halbe Minute
    const zeilen = db.prepare('SELECT * FROM push_abos').all();
    if (!zeilen.length) return;
    const text = await morgenInhalt(t.datum);
    const datum = new Date().toLocaleDateString('de-DE', {
      timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long'
    });
    await mitteilungSenden(zeilen, { titel: 'Guten Morgen — ' + datum, text: text, url: '/?memo=1' });
  }

  // --- Erinnerung eine Stunde vor jeder Besichtigung ---
  async function terminTick(e, t) {
    if (e.termine === false) return;
    const d = standInhalt();
    if (!d) return;
    const heute = (d.interessenten || []).filter(function (i) {
      return i.status !== 'absage' && i.termin && i.termin.length > 10
        && i.termin.slice(0, 10) === t.datum;
    });

    let gesendet = {};
    try { gesendet = JSON.parse(einstellung('push_termine') || '{}'); } catch (fehler) { gesendet = {}; }
    let geaendert = false;

    // Erledigtes von gestern aufräumen
    Object.keys(gesendet).forEach(function (k) {
      if (String(gesendet[k]).slice(0, 10) < t.datum) { delete gesendet[k]; geaendert = true; }
    });

    if (heute.length) {
      const jetztMin = Number(t.zeit.slice(0, 2)) * 60 + Number(t.zeit.slice(3, 5));
      for (const i of heute) {
        const zeit = i.termin.slice(11, 16);
        const terminMin = Number(zeit.slice(0, 2)) * 60 + Number(zeit.slice(3, 5));
        const abstand = terminMin - jetztMin;
        if (abstand < 0 || abstand > 60) continue;          // Erinnerung im letzten Stündchen
        if (gesendet[i.id] === i.termin) continue;          // schon erinnert
        gesendet[i.id] = i.termin; geaendert = true;

        let wo = '';
        (d.objects || []).forEach(function (o) {
          (o.units || []).forEach(function (x) {
            if (x.id === i.einheitId) wo = ' · ' + o.name.split(',')[0] + ' · ' + x.name;
          });
        });
        const zeilen = db.prepare('SELECT * FROM push_abos').all();
        if (zeilen.length) {
          await mitteilungSenden(zeilen, {
            titel: 'Besichtigung um ' + zeit,
            text: (i.name || 'Interessent') + wo,
            url: '/', tag: 'termin-' + i.id
          });
        }
      }
    }
    if (geaendert) einstellungSetzen('push_termine', JSON.stringify(gesendet));
  }

  // --- Meldung, wenn eine neue Anfrage im Postfach liegt ---
  async function anfrageTick(e) {
    if (e.anfragen === false) return;
    if (Date.now() - anfragenZuletzt < 5 * 60 * 1000) return;   // alle fünf Minuten reicht
    anfragenZuletzt = Date.now();
    if (!googleEinstellungen().refresh) return;                 // Postfach nicht verbunden
    const zeilen = db.prepare('SELECT * FROM push_abos').all();
    if (!zeilen.length) return;

    const token = await googleToken();
    const suche = 'in:inbox is:unread newer_than:1d ('
      + 'from:immobilienscout24.de OR from:immowelt.de OR from:immonet.de'
      + ' OR from:kleinanzeigen.de OR from:ebay-kleinanzeigen.de'
      + ' OR subject:Kontaktanfrage OR subject:Mietinteressent OR subject:"Anfrage zu Ihrer"'
      + ')';
    const liste = await gmail(token, '/messages?maxResults=10&q=' + encodeURIComponent(suche));

    const ids = (liste.messages || []).map(function (m) { return m.id; });
    if (!ids.length) return;

    let gesehen = [];
    try { gesehen = JSON.parse(einstellung('push_post_gesehen') || '[]'); } catch (fehler) { gesehen = []; }
    const neue = ids.filter(function (id) { return gesehen.indexOf(id) === -1; });
    if (!neue.length) return;
    einstellungSetzen('push_post_gesehen', JSON.stringify(gesehen.concat(neue).slice(-300)));

    for (const id of neue.slice(0, 3)) {
      const mail = await gmail(token, '/messages/' + id + MAIL_KOPF).catch(function () { return null; });
      if (!mail) continue;
      const h = {};
      ((mail.payload && mail.payload.headers) || []).forEach(function (x) { h[x.name] = x.value; });
      const von = String(h.From || '').replace(/<.*>/, '').replace(/"/g, '').trim();
      await mitteilungSenden(zeilen, {
        titel: 'Neue Anfrage' + (von ? ' — ' + von : ''),
        text: h.Subject || 'Im Postfach wartet eine neue Anfrage.',
        url: '/', tag: 'post-' + id
      });
    }
    if (neue.length > 3) {
      await mitteilungSenden(zeilen, {
        titel: 'Postfach',
        text: 'und ' + (neue.length - 3) + ' weitere neue Anfragen',
        url: '/', tag: 'post-mehr'
      });
    }
  }

  setInterval(async function () {
    const e = pushEinstellungenLesen();
    const t = berlinJetzt();
    try { await morgenTick(e, t); } catch (fehler) { console.log('Morgenmeldung fehlgeschlagen:', fehler.message); }
    try { await terminTick(e, t); } catch (fehler) { console.log('Terminerinnerung fehlgeschlagen:', fehler.message); }
    try { await anfrageTick(e); } catch (fehler) { console.log('Anfragen-Prüfung fehlgeschlagen:', fehler.message); }
  }, 30000).unref();
}

module.exports = { router: app, webpush, mitteilungSenden };
