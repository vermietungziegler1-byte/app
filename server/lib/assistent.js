'use strict';

const express = require('express');
const { db, holen, einstellung, einstellungSetzen, berlinJetzt, standInhalt } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const { todoist, todoistListe } = require('./todoist');
const { openaiModellFehlt } = require('./stimme');

const app = express.Router();

// ---------------- Assistent: zuhören, verstehen, eintragen ----------------
// Gesprochenes wird bei OpenAI in Text verwandelt, verstanden wird es von Claude.
// Claude darf dabei nur drei Dinge tun: Aufgaben anlegen, abhaken, verschieben.

const ASSISTENT_MODELLE = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];

function assistentLesen() {
  return {
    verbunden: !!einstellung('anthropic_token'),
    modell: einstellung('assistent_modell') || ASSISTENT_MODELLE[0],
    hoeren: !!einstellung('openai_token')
  };
}

app.get('/api/assistent', nurAngemeldet, function (req, res) {
  res.json(assistentLesen());
});

app.put('/api/assistent', nurAngemeldet, nurVerwalter, function (req, res) {
  const { token } = req.body || {};
  if (typeof token === 'string' && token.trim()) {
    einstellungSetzen('anthropic_token', token.trim());
    db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('assistent_modell');
  }
  if (token === '') db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('anthropic_token');
  res.json(assistentLesen());
});

// --- Gesprochenes in Text verwandeln (OpenAI) ---
app.post('/api/assistent/hoeren', nurAngemeldet,
  express.raw({ type: ['audio/*', 'video/*', 'application/octet-stream'], limit: '25mb' }),
  async function (req, res) {
    const token = einstellung('openai_token');
    if (!token) return res.status(400).json({ fehler: 'Zum Zuhören fehlt der Schlüssel der Vorlesestimme' });
    if (!req.body || !req.body.length) return res.status(400).json({ fehler: 'Nichts aufgenommen' });

    const art = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    const endung = art.indexOf('mp4') !== -1 ? 'mp4' : (art.indexOf('ogg') !== -1 ? 'ogg'
      : (art.indexOf('mpeg') !== -1 ? 'mp3' : (art.indexOf('wav') !== -1 ? 'wav' : 'webm')));

    for (const modell of ['gpt-4o-mini-transcribe', 'whisper-1']) {
      const formular = new FormData();
      formular.append('file', new Blob([req.body], { type: art }), 'aufnahme.' + endung);
      formular.append('model', modell);
      formular.append('language', 'de');
      let antwort;
      try {
        antwort = await holen('https://api.openai.com/v1/audio/transcriptions', {
          signal: AbortSignal.timeout(120000),
          method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formular
        });
      } catch (fehler) {
        return res.status(502).json({ fehler: 'Das Zuhören klappt gerade nicht: ' + fehler.message });
      }
      if (antwort.ok) {
        const ergebnis = await antwort.json();
        return res.json({ text: String((ergebnis && ergebnis.text) || '').trim() });
      }
      const grund = await antwort.text().catch(function () { return ''; });
      if (antwort.status === 401) return res.status(401).json({ fehler: 'Der Schlüssel wird nicht angenommen' });
      if (!openaiModellFehlt(antwort.status, grund)) {
        return res.status(502).json({ fehler: 'Das Zuhören klappt gerade nicht: ' + grund.slice(0, 160) });
      }
    }
    res.status(502).json({ fehler: 'Das Zuhören klappt gerade nicht' });
  });

// --- Was Claude über den Tag wissen muss ---
async function assistentLage() {
  const heute = berlinJetzt().datum;
  const d = standInhalt() || { objects: [], interessenten: [] };
  const zeilen = [];

  zeilen.push('Heute ist ' + new Date().toLocaleDateString('de-DE',
    { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    + ' (' + heute + ').');

  const objekte = (d.objects || []).map(function (o) { return o.name; });
  if (objekte.length) zeilen.push('Objekte: ' + objekte.join('; ') + '.');

  let projekte = [];
  let aufgaben = [];
  if (einstellung('todoist_token')) {
    try {
      projekte = await todoistListe('/projects');
      zeilen.push('Todoist-Projekte: ' + projekte.map(function (p) {
        return p.name + ' (id ' + p.id + ')';
      }).join('; ') + '.');
    } catch (fehler) { /* ohne Projekte geht es auch */ }
    try {
      const roh = await todoistListe('/tasks');
      aufgaben = roh.filter(function (t) {
        const f = t.due && (t.due.date || t.due.datetime);
        return f && String(f).slice(0, 10) <= heute;
      });
      zeilen.push(aufgaben.length
        ? 'Heute offen: ' + aufgaben.map(function (t) {
            return '"' + t.content + '" (id ' + t.id + ')';
          }).join('; ') + '.'
        : 'Für heute ist in Todoist nichts offen.');
    } catch (fehler) { /* egal */ }
  }

  const termine = (d.interessenten || []).filter(function (i) {
    return i.status !== 'absage' && i.termin && i.termin.slice(0, 10) === heute;
  });
  if (termine.length) {
    zeilen.push('Besichtigungen heute: ' + termine.map(function (i) {
      return (i.name || 'Interessent') + (i.termin.length > 10 ? ' um ' + i.termin.slice(11, 16) : '');
    }).join('; ') + '.');
  }

  return { text: zeilen.join('\n'), projekte: projekte, aufgaben: aufgaben };
}

const ASSISTENT_WERKZEUGE = [
  {
    name: 'aufgabe_anlegen',
    description: 'Legt eine neue Aufgabe in Todoist an.',
    input_schema: {
      type: 'object',
      properties: {
        inhalt: { type: 'string', description: 'Kurzer, tätiger Titel, z.B. "Kaminkehrer anrufen".' },
        projekt: { type: 'string', description: 'Name des Todoist-Projekts, meist der Objektname. Weglassen, wenn unklar.' },
        faellig: { type: 'string', description: 'Fälligkeit in normalem Deutsch, z.B. "morgen", "nächsten Dienstag 14 Uhr". Weglassen, wenn kein Datum genannt wurde.' },
        prioritaet: { type: 'integer', description: '4 = sehr wichtig, 3 = wichtig, 1 = normal.' },
        beschreibung: { type: 'string', description: 'Zusätzliche Einzelheiten, falls genannt.' }
      },
      required: ['inhalt']
    }
  },
  {
    name: 'aufgabe_erledigen',
    description: 'Hakt eine offene Aufgabe ab.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Die id aus der Liste der offenen Aufgaben.' } },
      required: ['id']
    }
  },
  {
    name: 'aufgabe_verschieben',
    description: 'Verschiebt eine Aufgabe auf ein anderes Datum.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Die id aus der Liste der offenen Aufgaben.' },
        faellig: { type: 'string', description: 'Neues Datum in normalem Deutsch, z.B. "morgen" oder "nächste Woche".' }
      },
      required: ['id', 'faellig']
    }
  }
];

async function assistentWerkzeug(name, eingabe, lage) {
  if (!einstellung('todoist_token')) return 'Fehler: Todoist ist nicht verbunden.';
  try {
    if (name === 'aufgabe_anlegen') {
      const projekt = (lage.projekte || []).find(function (p) {
        return eingabe.projekt && p.name.toLowerCase().indexOf(String(eingabe.projekt).toLowerCase()) !== -1;
      });
      const heute = new Date().toLocaleDateString('de-DE');
      const neu = await todoist('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          content: String(eingabe.inhalt || '').slice(0, 300),
          description: 'Hinzugefügt am: ' + heute + ' (per Sprache)'
            + (eingabe.beschreibung ? '\n' + eingabe.beschreibung : ''),
          project_id: projekt ? projekt.id : undefined,
          due_string: eingabe.faellig || undefined,
          due_lang: eingabe.faellig ? 'de' : undefined,
          priority: eingabe.prioritaet || undefined
        })
      });
      return 'Angelegt' + (projekt ? ' im Projekt ' + projekt.name : ' im Eingang')
        + (eingabe.faellig ? ', fällig ' + eingabe.faellig : '') + '. id ' + (neu && neu.id);
    }
    if (name === 'aufgabe_erledigen') {
      await todoist('/tasks/' + encodeURIComponent(eingabe.id) + '/close', { method: 'POST' });
      return 'Abgehakt.';
    }
    if (name === 'aufgabe_verschieben') {
      await todoist('/tasks/' + encodeURIComponent(eingabe.id), {
        method: 'POST',
        body: JSON.stringify({ due_string: eingabe.faellig, due_lang: 'de' })
      });
      return 'Verschoben auf ' + eingabe.faellig + '.';
    }
  } catch (fehler) {
    return 'Fehler: ' + fehler.message;
  }
  return 'Unbekannter Auftrag.';
}

async function claude(koerper) {
  const token = einstellung('anthropic_token');
  if (!token) { const e = new Error('Es ist noch kein Assistent eingerichtet'); e.status = 400; throw e; }
  const antwort = await holen('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(90000),
    method: 'POST',
    headers: {
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(koerper)
  });
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    const e = new Error(antwort.status === 401
      ? 'Der Schlüssel des Assistenten wird nicht angenommen'
      : (antwort.status === 429 ? 'Das Guthaben des Assistenten ist aufgebraucht'
        : 'Der Assistent antwortet nicht: ' + grund.slice(0, 160)));
    e.status = antwort.status;
    e.grund = grund;
    try { e.typ = ((JSON.parse(grund) || {}).error || {}).type || null; } catch (x) { e.typ = null; }
    throw e;
  }
  return antwort.json();
}

app.post('/api/assistent/sagen', nurAngemeldet, async function (req, res) {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ fehler: 'Nichts gesagt' });
  const verlauf = Array.isArray(req.body.verlauf) ? req.body.verlauf.slice(-8) : [];

  let lage;
  try { lage = await assistentLage(); }
  catch (fehler) { lage = { text: '', projekte: [], aufgaben: [] }; }

  const anweisung = 'Du bist der Assistent in der Hausverwaltungs-App von Louis, einem privaten Vermieter. '
    + 'Du hörst kurze gesprochene Sätze und antwortest gesprochen: höchstens zwei Sätze, freundlich, '
    + 'ohne Aufzählungen, ohne Sonderzeichen, ohne Rückfragen wenn es auch ohne geht. '
    + 'Wenn Louis dir eine Aufgabe gibt, legst du sie mit dem Werkzeug an und bestätigst kurz, '
    + 'was du eingetragen hast. Rate das passende Objekt aus dem Gesagten, frag nur nach, wenn es '
    + 'wirklich unklar ist. Fragen zum Tag beantwortest du aus der Lage unten. '
    + 'Erfinde nie Aufgaben oder Termine, die dort nicht stehen.\n\nLage:\n' + lage.text;

  const nachrichten = verlauf.filter(function (n) {
    return n && (n.role === 'user' || n.role === 'assistant') && typeof n.content === 'string';
  }).map(function (n) { return { role: n.role, content: n.content }; });
  nachrichten.push({ role: 'user', content: text });

  const eingestellt = assistentLesen().modell;
  const reihe = [eingestellt].concat(ASSISTENT_MODELLE.filter(function (m) { return m !== eingestellt; }));

  let modell = reihe[0];
  const getan = [];
  try {
    let antwort = null;
    for (const versuch of reihe) {
      try {
        antwort = await claude({
          model: versuch, max_tokens: 500, system: anweisung,
          tools: ASSISTENT_WERKZEUGE, messages: nachrichten
        });
        modell = versuch;
        if (versuch !== reihe[0]) einstellungSetzen('assistent_modell', versuch);
        break;
      } catch (fehler) {
        // Nur ausweichen, wenn es das Modell nicht gibt — sonst würde ein beliebiger
        // Fehler in der Anfrage das eingestellte Modell dauerhaft umstellen
        if (fehler.status === 404 || fehler.typ === 'not_found_error') continue;
        throw fehler;
      }
    }
    if (!antwort) throw new Error('Der Assistent antwortet nicht');

    // Werkzeuge ausführen, bis Claude fertig ist (höchstens drei Runden)
    for (let runde = 0; runde < 3 && antwort.stop_reason === 'tool_use'; runde++) {
      const auftraege = (antwort.content || []).filter(function (b) { return b.type === 'tool_use'; });
      nachrichten.push({ role: 'assistant', content: antwort.content });
      const ergebnisse = [];
      for (const a of auftraege) {
        const ergebnis = await assistentWerkzeug(a.name, a.input || {}, lage);
        getan.push({ was: a.name, eingabe: a.input, ergebnis: ergebnis });
        ergebnisse.push({ type: 'tool_result', tool_use_id: a.id, content: ergebnis });
      }
      nachrichten.push({ role: 'user', content: ergebnisse });
      antwort = await claude({
        model: modell, max_tokens: 500, system: anweisung,
        tools: ASSISTENT_WERKZEUGE, messages: nachrichten
      });
    }

    const gesagt = (antwort.content || []).filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join(' ').trim();
    res.json({ antwort: gesagt || 'Erledigt.', getan: getan });
  } catch (fehler) {
    res.status(fehler.status === 401 ? 401 : 502).json({ fehler: fehler.message, getan: getan });
  }
});

module.exports = { router: app };
