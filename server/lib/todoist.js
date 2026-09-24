'use strict';

const express = require('express');
const { db, holen, alsListe, mitFehler, einstellung, einstellungSetzen, berlinJetzt } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');

const app = express.Router();

// ---------------- Todoist ----------------
// Der Server spricht mit Todoist, damit das Zugangstoken den Browser nie erreicht.

async function todoist(pfad, optionen) {
  const token = einstellung('todoist_token');
  if (!token) throw new Error('Kein Todoist-Token hinterlegt');
  const antwort = await holen('https://api.todoist.com/api/v1' + pfad, Object.assign({
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }, optionen || {}));
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    throw new Error('Todoist antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 200) : ''));
  }
  const text = await antwort.text();
  return text ? JSON.parse(text) : null;
}

// Todoist-Farbnamen in die Farbtöne der Todoist-Oberfläche übersetzen
const TODOIST_FARBEN = {
  berry_red: '#b8255f', red: '#db4035', orange: '#ff9933', yellow: '#fad000', olive_green: '#afb83b',
  lime_green: '#7ecc49', green: '#299438', mint_green: '#6accbc', teal: '#158fad', sky_blue: '#14aaf5',
  light_blue: '#96c3eb', blue: '#4073ff', grape: '#884dff', violet: '#af38eb', lavender: '#eb96eb',
  magenta: '#e05194', salmon: '#ff8d85', charcoal: '#808080', grey: '#b8b8b8', taupe: '#ccac93'
};

// Eine Liste vollständig holen - Todoist liefert seitenweise und gibt dafür einen next_cursor mit
async function todoistListe(pfad) {
  let alles = [], cursor = null, runden = 0;
  do {
    const antwort = await todoist(pfad + (pfad.indexOf('?') === -1 ? '?' : '&') + 'limit=200'
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    const teil = alsListe(antwort);
    alles = alles.concat(teil);
    cursor = (antwort && !Array.isArray(antwort) && antwort.next_cursor) || null;
    runden++;
  } while (cursor && runden < 10);
  return alles;
}

// Eine Todoist-Aufgabe in die Form bringen, die die App überall benutzt
function aufgabeMappen(t, namen) {
  const roh = (t.due && (t.due.date || t.due.datetime)) || null;
  const mitZeit = (t.due && t.due.datetime) || (roh && String(roh).indexOf('T') !== -1 ? String(roh) : null);
  return {
    id: String(t.id),
    eltern: t.parent_id ? String(t.parent_id) : null,
    inhalt: t.content,
    beschreibung: t.description || '',
    projekt: (namen && namen[String(t.project_id)]) || '',
    projektId: String(t.project_id || ''),
    sektion: t.section_id ? String(t.section_id) : null,
    faellig: roh ? String(roh).slice(0, 10) : null,
    faelligZeit: mitZeit || null,
    faelligText: (t.due && t.due.string) || '',
    wiederkehrend: !!(t.due && t.due.is_recurring),
    prioritaet: t.priority || 1,
    labels: t.labels || [],
    kommentare: Number(t.note_count || t.comment_count || 0),
    reihenfolge: Number(t.child_order || 0),
    tagesreihenfolge: Number(t.day_order || 0),
    angelegt: t.added_at || t.created_at || null,
    url: t.url || ('https://app.todoist.com/app/task/' + t.id)
  };
}

app.get('/api/todoist', nurAngemeldet, function (req, res) {
  res.json({
    verbunden: !!einstellung('todoist_token'),
    zuordnung: JSON.parse(einstellung('todoist_zuordnung') || '{}')
  });
});

app.put('/api/todoist', nurAngemeldet, nurVerwalter, function (req, res) {
  const { token, zuordnung } = req.body || {};
  if (typeof token === 'string' && token.trim()) einstellungSetzen('todoist_token', token.trim());
  if (token === '') db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run('todoist_token');
  if (zuordnung) einstellungSetzen('todoist_zuordnung', JSON.stringify(zuordnung));
  res.json({ ok: true, verbunden: !!einstellung('todoist_token') });
});

app.get('/api/todoist/projekte', nurAngemeldet, mitFehler(async function (req, res) {
  const liste = await todoistListe('/projects');
  res.json(liste.map(function (p) {
    return { id: String(p.id), name: p.name, farbe: TODOIST_FARBEN[p.color] || '#808080' };
  }));
}));

// Offene Aufgaben eines Projekts holen
app.get('/api/todoist/aufgaben', nurAngemeldet, mitFehler(async function (req, res) {
  const projekt = req.query.projekt;
  const liste = await todoistListe('/tasks' + (projekt ? '?project_id=' + encodeURIComponent(projekt) : ''));
  res.json(liste.map(function (t) { return aufgabeMappen(t, null); }));
}));

// Die ganze Übersicht auf einmal: alle offenen Aufgaben, Projekte mit Farbe, Abschnitte
async function todoistUebersicht() {
  const [aufgaben, projekte, sektionen] = await Promise.all([
    todoistListe('/tasks'), todoistListe('/projects'), todoistListe('/sections')
  ]);
  const namen = {};
  projekte.forEach(function (p) { namen[String(p.id)] = p.name; });
  return {
    aufgaben: aufgaben.map(function (t) { return aufgabeMappen(t, namen); }),
    projekte: projekte.filter(function (p) { return !p.is_archived; }).map(function (p) {
      return {
        id: String(p.id), name: p.name, farbe: TODOIST_FARBEN[p.color] || '#808080',
        reihenfolge: Number(p.child_order || 0), eingang: !!p.inbox_project,
        eltern: p.parent_id ? String(p.parent_id) : null
      };
    }),
    sektionen: sektionen.filter(function (s) { return !s.is_archived; }).map(function (s) {
      return { id: String(s.id), projektId: String(s.project_id || ''), name: s.name, reihenfolge: Number(s.section_order || 0) };
    })
  };
}

app.get('/api/todoist/uebersicht', nurAngemeldet, mitFehler(async function (req, res) {
  res.json(await todoistUebersicht());
}));

// Alle offenen Aufgaben über alle Projekte hinweg (ältere Form, bleibt für alle Fälle)
app.get('/api/todoist/alle', nurAngemeldet, mitFehler(async function (req, res) {
  res.json((await todoistUebersicht()).aufgaben);
}));

// Ein Kalendertag "JJJJ-MM-TT" um n Tage verschoben
function tagPlus(datum, n) {
  const d = new Date(Date.UTC(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)) - 1, Number(datum.slice(8, 10)) + n));
  return d.toISOString().slice(0, 10);
}

// Alles, was diese Woche ansteht - über alle Projekte hinweg
app.get('/api/todoist/woche', nurAngemeldet, mitFehler(async function (req, res) {
  const [liste, pl] = await Promise.all([todoistListe('/tasks'), todoistListe('/projects')]);
  const namen = {};
  pl.forEach(function (p) { namen[String(p.id)] = p.name; });

  // Die laufende Kalenderwoche nach Berliner Zeit, Montag bis Sonntag, als reine Kalendertage.
  // So hängt nichts davon ab, in welcher Zeitzone der Server selbst läuft.
  const heute = berlinJetzt().datum;
  const wochentag = (new Date(heute + 'T00:00:00Z').getUTCDay() + 6) % 7;   // Montag = 0
  const montag = tagPlus(heute, -wochentag);
  const sonntag = tagPlus(montag, 6);

  // Diese Woche und alles, was aus früheren Wochen offen geblieben ist
  const woche = liste.map(function (t) { return aufgabeMappen(t, namen); })
    .filter(function (a) { return a.faellig && a.faellig <= sonntag; })
    .map(function (a) { a.alt = a.faellig < montag; return a; })
    .sort(function (a, b) { return a.faellig < b.faellig ? -1 : (a.faellig > b.faellig ? 1 : 0); });

  res.json(woche);
}));

// Neue Aufgabe anlegen
app.post('/api/todoist/aufgabe', nurAngemeldet, async function (req, res) {
  const { inhalt, projektId, faellig, faelligZeit, prioritaet, eltern, beschreibung, sektion, labels, dueString } = req.body || {};
  if (!inhalt) return res.status(400).json({ fehler: 'Kein Inhalt' });
  try {
    const heute = new Date().toLocaleDateString('de-DE');
    const neu = await todoist('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        content: inhalt,
        description: 'Hinzugefügt am: ' + heute + (beschreibung ? '\n' + beschreibung : ''),
        project_id: eltern ? undefined : (projektId || undefined),
        section_id: eltern ? undefined : (sektion || undefined),
        parent_id: eltern || undefined,
        due_date: (!dueString && !faelligZeit && faellig) ? faellig : undefined,
        due_datetime: (!dueString && faelligZeit) ? faelligZeit : undefined,
        due_string: dueString || undefined,
        due_lang: dueString ? 'de' : undefined,
        priority: prioritaet || undefined,
        labels: (Array.isArray(labels) && labels.length) ? labels : undefined
      })
    });
    res.json({ ok: true, id: neu && neu.id ? String(neu.id) : null });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe ändern
app.post('/api/todoist/aufgabe/:id', nurAngemeldet, async function (req, res) {
  const { inhalt, beschreibung, faellig, faelligZeit, prioritaet, labels, dueString } = req.body || {};
  const koerper = {};
  if (inhalt !== undefined) koerper.content = inhalt;
  if (beschreibung !== undefined) koerper.description = beschreibung;
  if (prioritaet !== undefined) koerper.priority = prioritaet;
  if (Array.isArray(labels)) koerper.labels = labels;
  if (dueString !== undefined) { koerper.due_string = dueString || 'no date'; koerper.due_lang = 'de'; }
  else if (faelligZeit) koerper.due_datetime = faelligZeit;
  else if (faellig !== undefined) {
    if (faellig) koerper.due_date = faellig;
    else koerper.due_string = 'no date';   // so nimmt Todoist das Datum weg
  }
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id), {
      method: 'POST', body: JSON.stringify(koerper)
    });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe löschen
app.delete('/api/todoist/aufgabe/:id', nurAngemeldet, async function (req, res) {
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id), { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Kommentare lesen
app.get('/api/todoist/aufgabe/:id/kommentare', nurAngemeldet, async function (req, res) {
  try {
    const liste = alsListe(await todoist('/comments?task_id=' + encodeURIComponent(req.params.id)));
    res.json(liste.map(function (k) {
      return {
        id: String(k.id),
        inhalt: k.content,
        wann: k.posted_at || k.posted || null,
        datei: k.file_attachment ? (k.file_attachment.file_url || null) : null
      };
    }));
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Kommentar schreiben
app.post('/api/todoist/aufgabe/:id/kommentar', nurAngemeldet, async function (req, res) {
  const inhalt = req.body && req.body.inhalt;
  if (!inhalt) return res.status(400).json({ fehler: 'Kein Text' });
  try {
    await todoist('/comments', {
      method: 'POST',
      body: JSON.stringify({ task_id: req.params.id, content: inhalt })
    });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe in ein anderes Projekt, einen Abschnitt oder unter eine andere Aufgabe schieben
app.post('/api/todoist/aufgabe/:id/verschieben', nurAngemeldet, async function (req, res) {
  const { projektId, sektion, eltern } = req.body || {};
  if (!projektId && !sektion && !eltern) return res.status(400).json({ fehler: 'Kein Ziel' });
  const ziel = eltern ? { parent_id: eltern } : (sektion ? { section_id: sektion } : { project_id: projektId });
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id) + '/move', {
      method: 'POST', body: JSON.stringify(ziel)
    });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Abgehakte Aufgabe wieder öffnen ("Rückgängig")
app.post('/api/todoist/aufgabe/:id/wieder', nurAngemeldet, async function (req, res) {
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id) + '/reopen', { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

// Aufgabe abhaken
app.post('/api/todoist/aufgabe/:id/erledigt', nurAngemeldet, async function (req, res) {
  try {
    await todoist('/tasks/' + encodeURIComponent(req.params.id) + '/close', { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ fehler: e.message }); }
});

app.post('/api/todoist/sync', nurAngemeldet, async function (req, res) {
  const aufgaben = (req.body && req.body.aufgaben) || [];
  let angelegt = 0, uebersprungen = 0;
  const fehler = [];

  for (const a of aufgaben) {
    const da = db.prepare('SELECT 1 FROM todoist_sync WHERE schluessel = ?').get(a.schluessel);
    if (da) { uebersprungen++; continue; }
    try {
      const heute = new Date().toLocaleDateString('de-DE');
      const neu = await todoist('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          content: a.inhalt,
          description: 'Hinzugefügt am: ' + heute + (a.beschreibung ? '\n' + a.beschreibung : ''),
          project_id: a.projektId || undefined,
          due_date: a.faellig || undefined
        })
      });
      db.prepare('INSERT INTO todoist_sync (schluessel, aufgabe, wann) VALUES (?,?,?)')
        .run(a.schluessel, neu && neu.id ? String(neu.id) : '', Date.now());
      angelegt++;
    } catch (e) { fehler.push(a.inhalt + ': ' + e.message); }
  }

  res.json({ angelegt: angelegt, uebersprungen: uebersprungen, fehler: fehler });
});

module.exports = { router: app, todoist, todoistListe, aufgabeMappen, TODOIST_FARBEN };
