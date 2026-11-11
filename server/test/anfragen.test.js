'use strict';

// Anfragen: Mietanfragen aus dem Postfach lesen, von Claude bewerten lassen, verwalten.
// Gmail, die Google-Anmeldung und der Anthropic-Dienst sind hier kleine Attrappen.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { serverStarten, sitzung } = require('./hilfe');

function b64(text) { return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); }

const JETZT = Date.now();
const ABSENDER = 'ImmobilienScout24 <noreply@immobilienscout24.de>';

// Was im Postfach liegt. anfrage2 ist jünger als anfrage1 und hat nur einen HTML-Teil.
const MAILS = {
  anfrage1: {
    betreff: 'Neue Kontaktanfrage zu Ihrer Immobilie', wann: JETZT - 2 * 3600000,
    text: [
      'Guten Tag Louis Ziegler,',
      'Sie haben eine neue Kontaktanfrage zu Ihrer Immobilie "Helle 3-Zimmer-Wohnung mit Balkon in Waiblingen".',
      '',
      'Name: Anna Muster',
      'E-Mail: anna.muster@example.org',
      'Telefon: 0171 1234567',
      'Haushalt: 2 Erwachsene, keine Kinder',
      'Haustiere: keine Haustiere',
      'Beruf: Ingenieurin, unbefristet angestellt',
      'Einkommen: 4.800 € netto im Monat',
      'Gewünschter Einzug: 1. Januar',
      '',
      'Nachricht:',
      'Sehr geehrter Herr Ziegler, mein Partner und ich suchen eine ruhige Wohnung in Waiblingen und würden uns',
      'über einen Besichtigungstermin freuen. Gehaltsnachweise und Schufa-Auskunft bringen wir gern mit.'
    ].join('\n')
  },
  anfrage2: {
    betreff: 'Neue Kontaktanfrage: 3-Zimmer-Wohnung in Waiblingen', wann: JETZT - 3600000,
    html: '<html><head><style>body { font-family: sans-serif }</style></head><body><div>'
      + '<p>Guten Tag Herr Ziegler,</p>'
      + '<p>mein Name ist <b>Max Beispiel</b>, ich interessiere mich für Ihre Wohnung in Waiblingen.</p>'
      + '<table><tr><td>Haushalt</td><td>2 Erwachsene</td></tr>'
      + '<tr><td>Haustiere</td><td>ein Hund (Labrador)</td></tr>'
      + '<tr><td>Beruf</td><td>Kfz-Mechatroniker</td></tr></table>'
      + '<p>Erreichbar unter max.beispiel@example.org<br>oder 0151 2345678.</p>'
      + '<p>Viele Grüße<br>Max Beispiel</p></div></body></html>'
  },
  // Diese zwei sortiert der Vorfilter am Betreff aus, ohne Claude zu fragen …
  suche: {
    betreff: '3 Angebote: Wohnung mieten, in Waiblingen', wann: JETZT - 4 * 3600000,
    text: 'zu deiner gespeicherten Suche Wohnung mieten, in Waiblingen\nTitel: Mietwohnung\nLink: https://push.search.is24.de/email/expose/901?PID=1'
  },
  statistik: {
    betreff: 'Ihre Wochenstatistik', wann: JETZT - 5 * 3600000,
    text: 'Ihre Anzeige wurde diese Woche 120-mal aufgerufen.'
  },
  // … diese kommt durch den Vorfilter, und erst Claude erkennt: keine Anfrage einer Person
  rueckblick: {
    betreff: 'Ihr Wochenrückblick', wann: JETZT - 6 * 3600000,
    text: 'Ihre Wochenstatistik: 120 Aufrufe, 4 Merklisten, 2 Kontaktanfragen. Verlängern Sie jetzt Ihre Anzeige.'
  },
  // Antwort einer Interessentin über ImmoScout: Absender ist ihre Weiterleitungsadresse, der Text steht in der Mail
  antwort1: {
    von: 'Renate Schäfer <sucher.48cb78a3af99465aa6aad15cf5e4cef2@nachrichten.immobilienscout24.de>',
    betreff: 'Neue Nachricht: Frau Schäfer hat Ihnen geantwortet. (Objekt 158460832)', wann: JETZT - 7 * 3600000,
    text: 'Sie haben eine neue Nachricht zu Ihrem Objekt (Scout-ID: 158460832)\n\n> Guten Morgen Herr Ziegler,\n'
      + '> ist die Wohnung noch zu mieten? Wir sind zu zweit, beide berufstätig.\n> Viele Grüße\n> Renate Schäfer\n\n'
      + 'Der Interessent\nAnrede: Frau\nVorname: Renate\nNachname: Schäfer\nPhone: 0172 1067372\n\nScout-ID: 158460832\nAdresse: 71334 Waiblingen'
  },
  // Nur eine Benachrichtigung: ImmoScout nennt die Anzeige, aber weder Person noch Nachricht — die stehen im Nachrichten-Manager.
  // Der Klartext-Teil hat eine Zeile, alles Weitere steht im HTML
  hinweis: {
    von: 'anfrage@immobilienscout24.de', replyTo: 'noreply@immobilienscout24.de',
    betreff: 'Anfrage zu Ihrem Objekt 158460832', wann: JETZT - 8 * 3600000,
    text: 'Anfrage zu Objekt 158460832',
    html: '<html><body><h1>Anfrage zu Ihrem Objekt 158460832</h1><p>Guten Tag Louis Ziegler,</p>'
      + '<p>Sie haben eine neue Anfrage erhalten. Sie können nun direkt über den <a href="https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/158460832/contact-request/4059af1f395448edaa64e4132e84a361?utm_medium=email&amp;utm_source=system">Nachrichten-Manager</a> antworten.</p>'
      + '<h2>Daten zu Ihrer Immobilie 158460832</h2><p>Erstbezug 2025: 3-Zimmer-Wohnung mit Balkon, EBK und Tiefgarage</p>'
      + '<table><tr><td>Scout-ID:</td><td>158460832</td></tr><tr><td>Zimmer:</td><td>3,00</td></tr><tr><td>Kaltmiete:</td><td>1.347,20 €</td></tr></table>'
      + '<p>Adresse:</p><p>Bertha-von-Suttner-Weg 4,<br>71334 Waiblingen</p><p><a href="https://www.immobilienscout24.de/expose/158460832">Direkt zum Exposé</a></p>'
      + '<p>Nachricht Ihrer Interessent:innen</p><p><a href="https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/158460832/contact-request/4059af1f395448edaa64e4132e84a361">Nachrichtenverlauf anzeigen</a></p></body></html>'
  },
  // Frau Schäfer schreibt noch einmal und reicht nach, was fehlte — danach passt sie
  antwort2: {
    von: 'Renate Schäfer <sucher.48cb78a3af99465aa6aad15cf5e4cef2@nachrichten.immobilienscout24.de>',
    betreff: 'Neue Nachricht: Frau Schäfer hat Ihnen geantwortet. (Objekt 158460832)', wann: JETZT - 6.5 * 3600000,
    text: 'Sie haben eine neue Nachricht zu Ihrem Objekt (Scout-ID: 158460832)\n\n> Guten Tag Herr Ziegler,\n'
      + '> gern ergänze ich: Wir haben zusammen 5.200 € netto im Monat, beide unbefristet angestellt, keine Haustiere.\n'
      + '> Einziehen würden wir gern zum 1. Februar.\n> Viele Grüße\n> Renate Schäfer'
  }
};
const RELAIS = 'sucher.48cb78a3af99465aa6aad15cf5e4cef2@nachrichten.immobilienscout24.de';

function fakeGoogle() {
  const abrufe = [];   // welche Mails vollständig geholt wurden, in Reihenfolge
  const server = http.createServer(function (req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'zugriff', expires_in: 3600 }));
    const liste = /^\/gmail\/v1\/users\/me\/messages\?/.exec(req.url);
    if (liste) return res.end(JSON.stringify({ messages: Object.keys(MAILS).map(function (id) { return { id: id }; }) }));
    const eine = /^\/gmail\/v1\/users\/me\/messages\/([^?]+)\?format=full/.exec(req.url);
    if (eine && MAILS[eine[1]]) {
      abrufe.push(eine[1]);
      const m = MAILS[eine[1]];
      const teile = [];
      if (m.text) teile.push({ mimeType: 'text/plain', body: { data: b64(m.text) } });
      if (m.html) teile.push({ mimeType: 'text/html', body: { data: b64(m.html) } });
      const kopf = [{ name: 'From', value: m.von || ABSENDER }, { name: 'Subject', value: m.betreff }];
      if (m.replyTo) kopf.push({ name: 'Reply-To', value: m.replyTo });
      return res.end(JSON.stringify({
        id: eine[1], internalDate: String(m.wann),
        payload: { mimeType: 'multipart/alternative', headers: kopf, parts: teile }
      }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      ok({ basis: 'http://127.0.0.1:' + server.address().port, abrufe: abrufe, stoppen: function () { server.close(); } });
    });
  });
}

// Was „Claude“ aus einer Mail herausliest — je nachdem, was im Mailtext steht.
// Alle Felder des Schemas sind dabei, damit ergebnisBereinigen() etwas zu tun hat.
function ergebnisFuer(text) {
  if (text.indexOf('Familie Ibrom') !== -1) {
    return { istAnfrage: true, name: 'Familie Ibrom', email: '', telefon: '',
      objekt: 'Scout-ID 158460832', einheitId: '', personen: '2 Erwachsene, 2 Kinder', erwachsene: 2, kinder: 2,
      haustiere: '', beruf: '', einkommen: '', einkommenNetto: null, einzug: '',
      nachricht: 'Junge Familie mit zwei Kindern sucht eine Wohnung und bittet um einen Besichtigungstermin.',
      urteil: 'unklar', punkte: 40, gruende: ['Familie mit zwei Kindern', 'Einkommen und Beruf fehlen'],
      fehlt: ['monatliches Haushaltsnettoeinkommen', 'Beruf und Art der Beschäftigung'],
      antwort: 'Guten Tag Familie Ibrom,\n\nvielen Dank für Ihre Nachricht.' };
  }
  if (text.indexOf('Wochenstatistik') !== -1) {
    return { istAnfrage: false, name: '', email: '', telefon: '', objekt: '', einheitId: '', personen: '',
      erwachsene: null, kinder: null, haustiere: '', beruf: '', einkommen: '', einkommenNetto: null, einzug: '',
      nachricht: '', urteil: 'unklar', punkte: 0, gruende: [], fehlt: [], antwort: '' };
  }
  if (text.indexOf('5.200') !== -1) {
    return { istAnfrage: true, name: 'Renate Schäfer', email: '', telefon: '0172 1067372',
      objekt: 'Scout-ID 158460832', einheitId: '', personen: '2 Erwachsene', erwachsene: 2, kinder: 0,
      haustiere: 'keine', beruf: 'beide unbefristet angestellt', einkommen: '5.200 € netto im Monat', einkommenNetto: 5200,
      einzug: '1. Februar', nachricht: 'Reicht Einkommen, Beschäftigung, Haustiere und Einzug nach.',
      urteil: 'passt', punkte: 85, gruende: ['Zwei Erwachsene', '5.200 € netto, beide unbefristet'], fehlt: [],
      antwort: 'Sehr geehrte Frau Schäfer,\n\nvielen Dank für die Ergänzung. Gern lade ich Sie zur Besichtigung ein, bitte nennen Sie mir zwei oder drei Terminvorschläge.' };
  }
  if (text.indexOf('Schäfer') !== -1) {
    return { istAnfrage: true, name: 'Renate Schäfer', email: '', telefon: '0172 1067372',
      objekt: 'Scout-ID 158460832', einheitId: '', personen: '2 Erwachsene', erwachsene: 2, kinder: null,
      haustiere: '', beruf: 'beide berufstätig', einkommen: '', einkommenNetto: null, einzug: '',
      nachricht: 'Fragt, ob die Wohnung noch frei ist; zwei Berufstätige.',
      urteil: 'vielleicht', punkte: 60, gruende: ['Zwei Erwachsene', 'Einkommen fehlt'], fehlt: ['Einkommen'],
      antwort: 'Sehr geehrte Frau Schäfer, ja, die Wohnung ist noch frei.' };
  }
  if (text.indexOf('Hund') !== -1) {
    return { istAnfrage: true, name: 'Max Beispiel', email: 'max.beispiel@example.org', telefon: '0151 2345678',
      objekt: '3-Zimmer-Wohnung in Waiblingen', einheitId: '', personen: '2 Erwachsene', erwachsene: 2, kinder: null,
      haustiere: 'Hund', beruf: 'Kfz-Mechatroniker', einkommen: '', einkommenNetto: null, einzug: '',
      nachricht: 'Zwei Erwachsene mit Labrador interessieren sich für die Wohnung.',
      urteil: 'passt nicht', punkte: 20, gruende: ['Hund'], fehlt: ['Einkommen', 'Einzugstermin'],
      antwort: 'Sehr geehrter Herr Beispiel, vielen Dank für Ihr Interesse. Leider kann ich Ihnen die Wohnung nicht anbieten. Louis Ziegler' };
  }
  return { istAnfrage: true, name: 'Anna Muster', email: 'anna.muster@example.org', telefon: '0171 1234567',
    objekt: 'Helle 3-Zimmer-Wohnung mit Balkon in Waiblingen', einheitId: '', personen: '2 Erwachsene', erwachsene: 2, kinder: 0,
    haustiere: 'keine', beruf: 'Ingenieurin', einkommen: '4.800 € netto', einkommenNetto: 4800, einzug: '1. Januar',
    nachricht: 'Ein Paar sucht eine ruhige Wohnung in Waiblingen und bringt die Unterlagen zur Besichtigung mit.',
    urteil: 'passt', punkte: 88, gruende: ['Zwei Erwachsene ohne Kinder', 'Sicheres Einkommen von 4.800 € netto'], fehlt: [],
    antwort: 'Sehr geehrte Frau Muster, vielen Dank für Ihre Anfrage. Gern lade ich Sie zur Besichtigung ein — bitte nennen Sie mir zwei oder drei Terminvorschläge. Louis Ziegler' };
}

function fakeAnthropic() {
  const anfragen = [];   // jede Anfrage an /v1/messages: { headers, body }
  const zustand = { stoerung: 0 };   // ein HTTP-Status (z. B. 529): so lange antwortet der Dienst mit diesem Fehler
  const server = http.createServer(function (req, res) {
    let roh = '';
    req.on('data', function (d) { roh += d; });
    req.on('end', function () {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
      }
      if (zustand.stoerung) {
        res.statusCode = zustand.stoerung;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      }
      let body = {};
      try { body = JSON.parse(roh); } catch (e) { body = {}; }
      anfragen.push({ headers: req.headers, body: body });
      const text = String((((body.messages || [])[0] || {}).content) || '');
      res.end(JSON.stringify({
        id: 'msg_' + anfragen.length, type: 'message', role: 'assistant', model: body.model,
        stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(ergebnisFuer(text)) }],
        usage: { input_tokens: 1200, output_tokens: 300 }
      }));
    });
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      ok(Object.assign(zustand, { basis: 'http://127.0.0.1:' + server.address().port, anfragen: anfragen, stoppen: function () { server.close(); } }));
    });
  });
}

const ids = function (liste) { return liste.map(function (a) { return a.id; }); };

let server, google, anthropic, louis, papa;

test.before(async function () {
  google = await fakeGoogle();
  anthropic = await fakeAnthropic();
  server = await serverStarten({ GOOGLE_TOKEN_URL: google.basis + '/token', GMAIL_BASIS: google.basis, ANTHROPIC_BASIS: anthropic.basis });
  louis = sitzung(server);
  papa = sitzung(server);
  await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
  await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
  await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });
});
test.after(async function () {
  if (server) await server.stoppen();
  if (google) google.stoppen();
  if (anthropic) anthropic.stoppen();
});

test('Ohne Postfach und Assistent: leere Liste, Standardkriterien', async function () {
  const a = await louis.get('/api/anfragen');
  assert.equal(a.status, 200);
  assert.equal(a.json.postfach, false);
  assert.equal(a.json.assistent, false);
  assert.equal(a.json.abgleich, null);
  assert.equal(a.json.fehler, null);
  assert.deepEqual(a.json.anfragen, []);
  assert.match(a.json.einstellungen.standardKriterien, /Höchstens zwei Erwachsene/);
  assert.equal(a.json.einstellungen.kriterien, a.json.einstellungen.standardKriterien);
  assert.equal(a.json.einstellungen.zeit, '07:00');
  assert.equal(a.json.einstellungen.melden, true);
  assert.equal((await sitzung(server).get('/api/anfragen')).status, 401);

  // Neu bewerten geht ohne Assistent nicht — und Claude wurde nie gefragt
  const b = await louis.post('/api/anfragen/bewerten', {});
  assert.equal(b.status, 400);
  assert.match(b.json.fehler, /Assistent/);
  assert.equal(anthropic.anfragen.length, 0);
});

test('Kriterien: nur der Verwalter, Standard setzt zurück', async function () {
  assert.equal((await papa.put('/api/anfragen/einstellungen', { kriterien: 'Nur Nichtraucher.' })).status, 403);

  let a = await louis.put('/api/anfragen/einstellungen', { kriterien: 'Nur Nichtraucher.', zeit: '06:30', melden: false });
  assert.equal(a.status, 200);
  assert.equal(a.json.einstellungen.kriterien, 'Nur Nichtraucher.');
  assert.equal(a.json.einstellungen.zeit, '06:30');
  assert.equal(a.json.einstellungen.melden, false);
  assert.match(a.json.einstellungen.standardKriterien, /Höchstens zwei Erwachsene/, 'der Standard bleibt sichtbar');

  // Keine gültige Uhrzeit HH:MM (00:00–23:59) — dann bleibt die alte
  a = await louis.put('/api/anfragen/einstellungen', { zeit: '6:30' });
  assert.equal(a.json.einstellungen.zeit, '06:30');
  a = await louis.put('/api/anfragen/einstellungen', { zeit: 7 });
  assert.equal(a.json.einstellungen.zeit, '06:30');
  a = await louis.put('/api/anfragen/einstellungen', { zeit: '25:99' });
  assert.equal(a.json.einstellungen.zeit, '06:30', 'richtige Form, aber keine Uhrzeit');

  // Lesen darf jeder
  a = await papa.get('/api/anfragen');
  assert.equal(a.json.einstellungen.kriterien, 'Nur Nichtraucher.');
  assert.equal(a.json.einstellungen.melden, false);

  // Den Standardtext zu speichern heißt: zurück zum Standard — der Eintrag verschwindet, statt als Kopie zu bleiben
  const standard = a.json.einstellungen.standardKriterien;
  a = await louis.put('/api/anfragen/einstellungen', { kriterien: standard });
  assert.equal(a.json.einstellungen.kriterien, standard);
  const db = new Database(path.join(server.daten, 'vermietung.db'));
  assert.equal(db.prepare("SELECT wert FROM einstellungen WHERE schluessel = 'anfragen_kriterien'").get(), undefined);
  db.close();
  a = await louis.put('/api/anfragen/einstellungen', { kriterien: '' });
  assert.equal(a.json.einstellungen.kriterien, standard, 'leer heißt ebenfalls Standard');

  // Eigene Kriterien wieder setzen — der nächste Test erwartet sie in der Anweisung an Claude
  a = await louis.put('/api/anfragen/einstellungen', { kriterien: 'Nur Nichtraucher.' });
  assert.equal(a.json.einstellungen.kriterien, 'Nur Nichtraucher.');
});

test('Mit Postfach und Assistent: Anfragen werden gelesen, bewertet und nur einmal geholt', async function () {
  // Erst der Assistent …
  assert.equal((await papa.put('/api/assistent', { token: 'sk-ant-test' })).status, 403);
  assert.equal((await louis.put('/api/assistent', { token: 'sk-ant-test' })).status, 200);
  let a = await louis.get('/api/anfragen?neu=1');
  assert.equal(a.json.assistent, true);
  assert.equal(a.json.postfach, false);
  assert.deepEqual(a.json.anfragen, [], 'ohne Postfach gibt es nichts zu lesen');
  a = await louis.post('/api/anfragen/bewerten', {});
  assert.equal(a.status, 400);
  assert.match(a.json.fehler, /Postfach/);
  assert.equal(anthropic.anfragen.length, 0);

  // … dann das Postfach (die Google-Anmeldung läuft im Browser — hier wird ihr Ergebnis hinterlegt)
  assert.equal((await louis.put('/api/google', { clientId: 'id', clientSecret: 'geheim' })).status, 200);
  const db = new Database(path.join(server.daten, 'vermietung.db'));
  db.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert) VALUES ('google_refresh', 'dauerhaft')").run();
  db.close();

  a = await louis.get('/api/anfragen?neu=1');
  assert.equal(a.status, 200);
  assert.equal(a.json.postfach, true);
  assert.equal(a.json.assistent, true);
  assert.equal(a.json.fehler, null, server.ausgabe());
  assert.ok(a.json.abgleich > 0);
  assert.deepEqual(ids(a.json.anfragen), ['anfrage2', 'anfrage1', 'antwort2', 'antwort1', 'hinweis'], 'nur echte Anfragen, die neueste zuerst');
  const anfrageVon = function (id) { return a.json.anfragen.find(function (x) { return x.id === id; }); };

  const anna = a.json.anfragen[1];
  assert.equal(anna.status, 'neu');
  assert.equal(anna.fehler, null);
  assert.equal(anna.von, ABSENDER);
  assert.equal(anna.betreff, MAILS.anfrage1.betreff);
  assert.equal(anna.wann, MAILS.anfrage1.wann);
  assert.equal(anna.einheitId, '');
  assert.equal(anna.inhalt.name, 'Anna Muster');
  assert.equal(anna.inhalt.email, 'anna.muster@example.org');
  assert.equal(anna.inhalt.erwachsene, 2);
  assert.equal(anna.inhalt.kinder, 0);
  assert.equal(anna.inhalt.einkommenNetto, 4800);
  assert.equal(anna.bewertung.urteil, 'passt');
  assert.equal(anna.bewertung.punkte, 88);
  assert.equal(anna.bewertung.gruende.length, 2);
  assert.deepEqual(anna.bewertung.fehlt, []);
  assert.match(anna.bewertung.antwort, /^Sehr geehrte Frau Muster/);
  assert.equal(anna.url, 'https://mail.google.com/mail/u/0/#inbox/anfrage1');

  const max = a.json.anfragen[0];
  assert.equal(max.inhalt.name, 'Max Beispiel');
  assert.equal(max.inhalt.haustiere, 'Hund');
  assert.equal(max.inhalt.kinder, null, 'unbekannte Zahlen bleiben null');
  assert.equal(max.inhalt.einkommenNetto, null);
  assert.equal(max.bewertung.urteil, 'passt nicht');
  assert.equal(max.bewertung.punkte, 20);
  assert.deepEqual(max.bewertung.gruende, ['Hund']);
  assert.ok(max.url.endsWith('/anfrage2'));

  // Bei einer Absage wird nichts erfragt, auch wenn etwas fehlt
  assert.doesNotMatch(max.bewertung.antwort, /folgende Angaben/);

  // Die Antwort einer Interessentin: Antwortweg ist ihre Weiterleitungsadresse, und die hält ihre Mails zusammen
  const renate = anfrageVon('antwort1');
  assert.equal(renate.inhalt.name, 'Renate Schäfer');
  assert.equal(renate.inhalt.email, RELAIS, 'ohne eigene Adresse gilt die Weiterleitungsadresse von ImmoScout');
  assert.equal(renate.person, RELAIS);
  assert.equal(renate.bewertung.urteil, 'vielleicht');
  assert.equal(renate.bewertung.punkte, 60);
  // Der Vorschlag des Modells fragt nicht nach dem Einkommen — die App ergänzt die Frage, damit die Antwort fertig ist
  assert.match(renate.bewertung.antwort, /^Sehr geehrte Frau Schäfer, ja, die Wohnung ist noch frei\.\n\nDamit ich Ihre Anfrage vollständig prüfen kann, bitte ich Sie noch um folgende Angaben:\n- Einkommen$/);

  // Ihre zweite Nachricht reicht das Fehlende nach: bewertet zusammen mit der ersten, jetzt passt sie
  const nachtrag = anfrageVon('antwort2');
  assert.equal(nachtrag.person, RELAIS, 'dieselbe Person');
  assert.equal(nachtrag.bewertung.urteil, 'passt');
  assert.equal(nachtrag.bewertung.punkte, 85);
  assert.deepEqual(nachtrag.bewertung.fehlt, []);
  assert.doesNotMatch(nachtrag.bewertung.antwort, /folgende Angaben/, 'nichts fehlt, also wird nichts erfragt');
  const anClaude = function (enthaelt) {
    return anthropic.anfragen.filter(function (r) { return r.body.messages[0].content.indexOf(enthaelt) !== -1; })
      .map(function (r) { return r.body.messages[0].content; });
  };
  const zweite = anClaude('5.200 € netto')[0];
  assert.match(zweite, /Frühere Mails derselben Person, schon bewertet/);
  assert.match(zweite, /damals: vielleicht \(60 Punkte\)/);
  const erste = anClaude('ist die Wohnung noch zu mieten')[0];
  assert.doesNotMatch(erste, /Frühere Mails/, 'die erste Nachricht hatte noch keine Vorgeschichte');

  // Die bloße Benachrichtigung: Karte ohne Bewertung durch Claude, mit dem Weg in den Nachrichten-Manager
  const hinweis = anfrageVon('hinweis');
  assert.equal(hinweis.id, 'hinweis');
  assert.equal(hinweis.inhalt.hinweis, 'nachrichten-manager');
  assert.equal(hinweis.inhalt.name, '');
  assert.equal(hinweis.inhalt.link, 'https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/158460832/contact-request/4059af1f395448edaa64e4132e84a361?utm_medium=email&utm_source=system');
  assert.equal(hinweis.inhalt.objekt, 'Erstbezug 2025: 3-Zimmer-Wohnung mit Balkon, EBK und Tiefgarage · Bertha-von-Suttner-Weg 4, 71334 Waiblingen (Scout-ID 158460832)');
  assert.equal(hinweis.bewertung.urteil, 'unklar');
  assert.equal(hinweis.fehler, null);
  // Die Kennung im Link ergibt die Weiterleitungsadresse der Person: Antwortweg und Schlüssel ihrer Karte.
  // anfrage@immobilienscout24.de selbst ist kein Schlüssel — sonst wären alle Benachrichtigungen eine Karte
  const HINWEIS_RELAIS = 'sucher.4059af1f395448edaa64e4132e84a361@nachrichten.immobilienscout24.de';
  assert.equal(hinweis.inhalt.email, HINWEIS_RELAIS);
  assert.equal(hinweis.person, HINWEIS_RELAIS);
  // Die fertige Nachfrage: alles, was bei einer Benachrichtigung fehlt, als Aufzählung
  assert.equal(hinweis.bewertung.fehlt.length, 5);
  assert.match(hinweis.bewertung.antwort, /^Guten Tag,\n\nvielen Dank für Ihre Nachricht/);
  assert.match(hinweis.bewertung.antwort, /folgende Angaben:\n- Zahl der Erwachsenen und Kinder\n- monatliches Haushaltsnettoeinkommen\n- Beruf und Art der Beschäftigung\n- Haustiere\n- gewünschter Einzugstermin$/);
  assert.match(hinweis.inhalt.original, /Daten zu Ihrer Immobilie 158460832/, 'der Wortlaut kommt aus dem HTML, nicht aus der einen Klartextzeile');

  // Inserate: die Anzeige mit Titel und Adresse aus der Benachrichtigung, zwei Anfragen dazu
  assert.deepEqual(a.json.inserate.map(function (x) { return x.anzeige; }), ['158460832']);
  assert.equal(a.json.inserate[0].titel, 'Erstbezug 2025: 3-Zimmer-Wohnung mit Balkon, EBK und Tiefgarage');
  assert.equal(a.json.inserate[0].adresse, 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen');
  assert.equal(a.json.inserate[0].anzahl, 3);
  assert.equal(a.json.inserate[0].offen, 3);
  assert.equal(a.json.inserate[0].einheitId, '');
  assert.equal(a.json.inserate[0].url, 'https://www.immobilienscout24.de/expose/158460832');

  // Jede Mail wurde einmal vollständig geholt; bei Claude landeten nur die fünf, die der Vorfilter durchließ und die
  // mehr als eine Benachrichtigung sind
  assert.deepEqual(google.abrufe.slice().sort(), ['anfrage1', 'anfrage2', 'antwort1', 'antwort2', 'hinweis', 'rueckblick', 'statistik', 'suche']);
  assert.equal(anthropic.anfragen.length, 5);
  assert.deepEqual(anthropic.anfragen.map(function (r) { return r.body.messages[0].content.split('\n')[0]; }),
    ['Betreff: ' + MAILS.anfrage1.betreff, 'Betreff: ' + MAILS.anfrage2.betreff, 'Betreff: ' + MAILS.rueckblick.betreff,
      'Betreff: ' + MAILS.antwort1.betreff, 'Betreff: ' + MAILS.antwort2.betreff]);

  // So sieht jede Anfrage an Claude aus
  anthropic.anfragen.forEach(function (r) {
    assert.equal(r.headers['x-api-key'], 'sk-ant-test');
    assert.equal(r.headers['anthropic-version'], '2023-06-01');
    assert.match(String(r.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(r.body.model, 'claude-opus-5-5');
    assert.equal(r.body.fallbacks, 'default');
    assert.equal(r.body.max_tokens, 16000);
    assert.equal(r.body.output_config.effort, 'medium');
    assert.equal(r.body.output_config.format.type, 'json_schema');
    assert.equal(r.body.output_config.format.schema.type, 'object');
    assert.equal(r.body.output_config.format.schema.additionalProperties, false);
    assert.ok(r.body.output_config.format.schema.required.indexOf('istAnfrage') !== -1);
    assert.match(r.body.system, /Nur Nichtraucher\./, 'die eigenen Kriterien stehen in der Anweisung');
    assert.doesNotMatch(r.body.system, /Höchstens zwei Erwachsene/, 'und ersetzen die Standardkriterien');
    assert.match(r.body.system, /Gleichbehandlungsgesetz/);
    assert.equal(r.body.messages.length, 1);
    assert.equal(r.body.messages[0].role, 'user');
    assert.match(r.body.messages[0].content, /^Betreff: .*\nVon: .*immobilienscout24\.de>\nEingang: /);
    assert.match(r.body.system, /ohne Grußformel und ohne Unterschrift/, 'den Gruß bringt die Signatur mit');
    assert.match(r.body.system, /bittet die Antwort um genau diese Angaben, jede als eigener Punkt/, 'Fehlendes wird erfragt');
    assert.match(r.body.system, /Das alte Urteil ist kein Maßstab/, 'Nachträge können das Urteil ändern');
  });
  // Die HTML-Mail kam als Text an, ohne Tags und ohne Stilangaben
  const text = anthropic.anfragen[1].body.messages[0].content;
  assert.match(text, /Max Beispiel/);
  assert.match(text, /ein Hund \(Labrador\)/);
  assert.doesNotMatch(text, /<\/?(p|br|td|tr|table|div|b|style|html|body)\b/i);
  assert.doesNotMatch(text, /font-family/);

  // Noch einmal: schon geprüfte Mails werden weder geholt noch bewertet
  a = await louis.get('/api/anfragen?neu=1');
  assert.equal(google.abrufe.length, 8, 'schon geprüfte Mails werden nicht nochmal geholt');
  assert.equal(anthropic.anfragen.length, 5);
  assert.deepEqual(ids(a.json.anfragen), ['anfrage2', 'anfrage1', 'antwort2', 'antwort1', 'hinweis']);
});

test('Benachrichtigung und Antwortweg: die Regeln einzeln', function () {
  const { hinweisAus, antwortAdresse, mailText } = require('../lib/anfragen');
  // Nur Benachrichtigungen von anfrage@immobilienscout24.de ohne Angaben zur Person
  assert.equal(hinweisAus(ABSENDER, 'Neue Kontaktanfrage', 'Name: Anna\nE-Mail: a@b.de\nNachrichten-Manager', ''), null);
  assert.equal(hinweisAus('anfrage@immobilienscout24.de', 'Anfrage zu Ihrem Objekt 1', 'Sie haben eine neue Anfrage erhalten.\nE-Mail: a@b.de', ''), null, 'mit Adresse ist es eine volle Anfrage');
  const h = hinweisAus('anfrage@immobilienscout24.de', 'Anfrage zu Ihrem Objekt 158460832', 'Sie haben eine neue Anfrage erhalten. Nachrichten-Manager', '');
  assert.equal(h.nr, '158460832');
  assert.equal(h.titel, '');
  assert.equal(h.link, 'https://www.immobilienscout24.de/expose/158460832', 'ohne Link in der Mail wenigstens das Exposé');
  assert.equal(h.relais, '', 'ohne Link keine Weiterleitungsadresse');
  const h2 = hinweisAus('anfrage@immobilienscout24.de', 'Anfrage zu Ihrem Objekt 169648839',
    'Sie haben eine neue Anfrage erhalten.\nAdresse:\n71332 Waiblingen (Adresse wird nicht vollständig angezeigt)\n\n> Direkt zum Exposé',
    '<a href="https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/169648839/contact-request/4059AF1F395448EDAA64E4132E84A361?x=1">x</a>');
  assert.equal(h2.relais, 'sucher.4059af1f395448edaa64e4132e84a361@nachrichten.immobilienscout24.de');
  assert.equal(h2.adresse, '71332 Waiblingen', 'der Hinweis auf die unvollständige Adresse fällt weg');
  // Antwortadresse: die Weiterleitungsadresse zählt, auch als Absender; Portaladressen nicht
  assert.equal(antwortAdresse({ From: 'Renate <' + RELAIS + '>' }), RELAIS);
  assert.equal(antwortAdresse({ From: 'anfrage@immobilienscout24.de', 'Reply-To': 'noreply@immobilienscout24.de' }), '');
  assert.equal(antwortAdresse({ From: 'ImmoScout <noreply@immobilienscout24.de>', 'Reply-To': 'Anna <anna@example.org>' }), 'anna@example.org');
  assert.equal(antwortAdresse({ From: 'ImmoScout <noreply@immobilienscout24.de>' }), '');
  // Kurzer Klartext neben HTML: der Text kommt aus dem HTML
  const b64 = function (t) { return Buffer.from(t, 'utf8').toString('base64'); };
  assert.equal(mailText({ parts: [{ mimeType: 'text/plain', body: { data: b64('Anfrage zu Objekt 1') } }, { mimeType: 'text/html', body: { data: b64('<p>Guten Tag,</p><p>viel Text</p>') } }] }), 'Guten Tag,\nviel Text');
  assert.equal(mailText({ parts: [{ mimeType: 'text/plain', body: { data: b64('Nur Klartext.') } }] }), 'Nur Klartext.');
});

test('Benachrichtigung mit versteckter Nachricht: der Kommentar im Kopf der Mail', function () {
  const { hinweisAus, versteckteAnfrage, hinweisMailText } = require('../lib/anfragen');
  // So steht es in den echten Mails: Kopfzeile, ObjektID, Objektname, Text bis zum Ende, Zeilen mit \r\n, Umlaute umschrieben
  const html = '<html><head><!--[if mso]>\r\n<style>td {}</style>\r\n<![endif]-->\r\n  \r\n'
    + '  <!-- Kontaktanfrage zu Ihrem Objekt 169648839\r\nObjektID: 169648839\r\nObjektname: 169648839\r\n'
    + 'Text: Guten Tag Herr Ziegler, \r\n\r\nFinanzielle Situation & Unterlagen:\r\nTelefon: 0179/1234567\r\n'
    + 'wir freuen uns ueber einen Termin &amp; Gr&#252;&szlig;e, 4.000 € netto.\r\n\r\n\r\n\r\nVG\r\nFamilie Ibrom\r\n -->\r\n'
    + '</head><body><p>Nachricht Ihrer Interessent:innen</p></body></html>';
  const v = versteckteAnfrage(html);
  assert.deepEqual(v.felder, { ObjektID: '169648839', Objektname: '169648839' });
  assert.equal(v.text, 'Guten Tag Herr Ziegler,\n\nFinanzielle Situation & Unterlagen:\nTelefon: 0179/1234567\n'
    + 'wir freuen uns ueber einen Termin & Grüße, 4.000 € netto.\n\nVG\nFamilie Ibrom',
    'Zeilen mit Doppelpunkt nach „Text:“ gehören zum Text; Leerzeichen am Zeilenende und Leerzeilen zusammengefasst');
  assert.equal(versteckteAnfrage('<html><head><!--[if !mso]><!--><!--<![endif]--></head></html>'), null, 'andere Kommentare zählen nicht');
  assert.equal(versteckteAnfrage('<!-- Kontaktanfrage zu Ihrem Objekt 1\r\nObjektID: 1\r\nText: \r\n -->').text, '', 'leere Nachricht bleibt leer');
  assert.equal(versteckteAnfrage('<!-- Kontaktanfrage zu Ihrem Objekt 1\r\nObjektID: 1\r\n -->').text, '', 'ohne „Text:“ gibt es keine Nachricht');
  // hinweisAus reicht die Nachricht weiter, der Assistent liest Anzeige und Nachricht
  const h = hinweisAus('anfrage@immobilienscout24.de', 'Anfrage zu Ihrem Objekt 169648839',
    'Sie haben eine neue Anfrage erhalten. Nachrichten-Manager', html);
  assert.match(h.nachricht, /^Guten Tag Herr Ziegler,\n[\s\S]*Familie Ibrom$/);
  const t = hinweisMailText(Object.assign({}, h, { titel: '4-Zimmer-Wohnung', adresse: '71332 Waiblingen' }));
  assert.match(t, /^Kontaktanfrage über ImmoScout24 zur Anzeige 169648839: 4-Zimmer-Wohnung, 71332 Waiblingen\n\nNachricht der Person:\nGuten Tag Herr Ziegler,/);
  assert.doesNotMatch(t, /ObjektID|Objektname/, 'die Nummer steht schon in der ersten Zeile');
  // Ohne Kommentar bleibt es eine bloße Benachrichtigung
  assert.equal(hinweisAus('anfrage@immobilienscout24.de', 'Anfrage zu Ihrem Objekt 1', 'Sie haben eine neue Anfrage erhalten. Nachrichten-Manager', '<p>x</p>').nachricht, '');
  // Antworten über ImmoScout: die Nachricht sind die Zeilen mit „> “; der Umbruch mitten in „&ouml;“ wird geheilt
  const { zitierteNachricht } = require('../lib/anfragen');
  assert.equal(zitierteNachricht('# Sie haben eine neue Nachricht\n\n> Guten Tag, Herr Ziegler,\n> ich arbeite als Qualit&auml;tstechniker, 3.400 &euro; netto.\n'
    + '> Wir w&uuml;rden uns &uuml;ber die M&\n> ouml;glichkeit freuen.\n> \n> Nikolai Kowtun\n\n[Jetzt antworten](https://example.org)\n\nAnrede: Herr'),
  'Guten Tag, Herr Ziegler,\nich arbeite als Qualitätstechniker, 3.400 € netto.\nWir würden uns über die Möglichkeit freuen.\n\nNikolai Kowtun');
  assert.equal(zitierteNachricht('Ohne Zitat.'), '');
});

test('Stand ändern: merken, absagen, Unsinn abgewiesen', async function () {
  let a = await papa.put('/api/anfragen/anfrage1', { status: 'gemerkt' });
  assert.equal(a.status, 200);
  assert.equal(a.json.anfrage.status, 'gemerkt');
  assert.equal(a.json.anfrage.inhalt.name, 'Anna Muster', 'Inhalt und Bewertung bleiben');
  assert.equal(a.json.anfrage.bewertung.punkte, 88);

  a = await papa.put('/api/anfragen/anfrage2', { status: 'abgelehnt' });
  assert.equal(a.json.anfrage.status, 'abgelehnt');
  a = await papa.put('/api/anfragen/anfrage2', { status: 'neu' });
  assert.equal(a.json.anfrage.status, 'neu', 'und wieder zurück');

  a = await papa.put('/api/anfragen/anfrage1', { status: 'eingezogen' });
  assert.equal(a.status, 400);
  assert.match(a.json.fehler, /Unbekannter Stand/);
  assert.equal((await papa.put('/api/anfragen/gibtsnicht', { status: 'gemerkt' })).status, 404);

  a = await papa.put('/api/anfragen/anfrage1', { einheitId: 'u1' });
  assert.equal(a.json.anfrage.einheitId, 'u1');
  assert.equal(a.json.anfrage.status, 'gemerkt', 'der Stand bleibt beim Zuordnen');

  a = await louis.get('/api/anfragen');
  assert.equal(a.json.anfragen[1].status, 'gemerkt');
  assert.equal(a.json.anfragen[1].einheitId, 'u1');
});

test('Inserate: eine Anzeige der Wohnung zuordnen gilt für alle Anfragen dazu', async function () {
  let a = await papa.put('/api/anfragen/inserate/158460832', { einheitId: 'u2' });
  assert.equal(a.status, 200);
  assert.equal(a.json.inserate[0].einheitId, 'u2');
  const nach = {};
  a.json.anfragen.forEach(function (x) { nach[x.id] = x.einheitId; });
  assert.equal(nach.antwort1, 'u2');
  assert.equal(nach.hinweis, 'u2');
  assert.equal(nach.anfrage1, 'u1', 'Anfragen zu anderen Anzeigen bleiben, wie sie sind');
  assert.equal((await papa.put('/api/anfragen/inserate/abc', { einheitId: 'u2' })).status, 400);

  a = await papa.put('/api/anfragen/inserate/158460832', { einheitId: '' });
  assert.equal(a.json.inserate[0].einheitId, '');
  a.json.anfragen.forEach(function (x) { if (x.id === 'hinweis' || x.id === 'antwort1') assert.equal(x.einheitId, ''); });
});

test('Neu bewerten: eine Anfrage, dann alle offenen', async function () {
  const bewertet = anthropic.anfragen.length;
  const geholt = google.abrufe.length;

  let a = await louis.post('/api/anfragen/bewerten', { id: 'anfrage1' });
  assert.equal(a.status, 200);
  assert.deepEqual(ids(a.json.anfragen), ['anfrage1']);
  assert.equal(a.json.anfragen[0].bewertung.punkte, 88);
  assert.equal(a.json.anfragen[0].status, 'gemerkt', 'der Stand bleibt');
  assert.equal(a.json.anfragen[0].einheitId, 'u1', 'die Zuordnung auch');
  assert.equal(anthropic.anfragen.length, bewertet + 1);
  assert.deepEqual(google.abrufe.slice(geholt), ['anfrage1'], 'die Mail wird dafür frisch geholt');

  a = await louis.post('/api/anfragen/bewerten', { id: 'gibtsnicht' });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.anfragen, []);
  assert.equal(anthropic.anfragen.length, bewertet + 1);

  // Die erste Nachricht von Frau Schäfer noch einmal: die spätere Nachricht gehört nicht als „frühere“ dazu
  a = await louis.post('/api/anfragen/bewerten', { id: 'antwort1' });
  assert.equal(a.json.anfragen[0].bewertung.urteil, 'vielleicht');
  assert.equal(anthropic.anfragen.length, bewertet + 2);
  assert.doesNotMatch(anthropic.anfragen[anthropic.anfragen.length - 1].body.messages[0].content, /Frühere Mails/);

  // Alle offenen (neu und gemerkt), die neueste zuerst — die Sammelrunde kostet bis zu 30 Aufrufe und ist dem Verwalter vorbehalten
  assert.equal((await papa.post('/api/anfragen/bewerten', {})).status, 403);
  assert.equal(anthropic.anfragen.length, bewertet + 2, 'ohne Recht wird Claude nicht gefragt');
  a = await louis.post('/api/anfragen/bewerten', {});
  assert.equal(a.status, 200);
  assert.deepEqual(ids(a.json.anfragen), ['anfrage2', 'anfrage1', 'antwort2', 'antwort1', 'hinweis']);
  assert.equal(a.json.anfragen[0].inhalt.haustiere, 'Hund');
  assert.equal(a.json.anfragen[0].bewertung.urteil, 'passt nicht');
  assert.equal(a.json.anfragen[2].bewertung.urteil, 'passt', 'der Nachtrag passt auch nach dem Neubewerten');
  assert.equal(a.json.anfragen[4].inhalt.hinweis, 'nachrichten-manager', 'die Benachrichtigung bleibt eine — ohne Claude');
  assert.equal(anthropic.anfragen.length, bewertet + 6);
});

test('Löschen nur der Verwalter', async function () {
  assert.equal((await papa.del('/api/anfragen/anfrage2')).status, 403);
  let a = await louis.del('/api/anfragen/anfrage2');
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { ok: true });
  a = await louis.get('/api/anfragen');
  assert.deepEqual(ids(a.json.anfragen), ['anfrage1', 'antwort2', 'antwort1', 'hinweis']);

  // Die Mail bleibt als geprüft vermerkt — beim nächsten Abgleich kommt sie nicht zurück
  const geholt = google.abrufe.length;
  a = await louis.get('/api/anfragen?neu=1');
  assert.deepEqual(ids(a.json.anfragen), ['anfrage1', 'antwort2', 'antwort1', 'hinweis']);
  assert.equal(google.abrufe.length, geholt);
});

test('Benachrichtigung mit versteckter Nachricht: der Assistent bewertet sie, die Karte behält den Antwortweg', async function () {
  const vorher = anthropic.anfragen.length;
  const RELAIS_HINWEIS = 'sucher.4059af1f395448edaa64e4132e84a361@nachrichten.immobilienscout24.de';
  MAILS.hinweis.html = MAILS.hinweis.html.replace('<html>', '<html><head><!--[if mso]><style>td {}</style><![endif]-->\r\n'
    + '  <!-- Kontaktanfrage zu Ihrem Objekt 158460832\r\nObjektID: 158460832\r\nObjektname: 158460832\r\n'
    + 'Text: Guten Tag Herr Ziegler,\r\n\r\nals junge Familie mit zwei Kindern (3 und 5 Jahre) suchen wir eine Wohnung. '
    + 'Wir freuen uns ueber einen Besichtigungstermin.\r\n\r\nVG\r\nFamilie Ibrom\r\n -->\r\n</head>');
  const a = await louis.post('/api/anfragen/bewerten', { id: 'hinweis' });
  assert.equal(a.status, 200);
  assert.equal(anthropic.anfragen.length, vorher + 1, 'jetzt fragt die App den Assistenten');
  const frage = anthropic.anfragen[anthropic.anfragen.length - 1].body.messages[0].content;
  assert.match(frage, /Kontaktanfrage über ImmoScout24 zur Anzeige 158460832: Erstbezug 2025/);
  assert.match(frage, /Nachricht der Person:\nGuten Tag Herr Ziegler,\n\nals junge Familie/);
  const h = a.json.anfragen[0];
  assert.equal(h.id, 'hinweis');
  assert.equal(h.inhalt.name, 'Familie Ibrom');
  assert.equal(h.inhalt.hinweis, undefined, 'keine bloße Benachrichtigung mehr');
  assert.equal(h.inhalt.email, RELAIS_HINWEIS, 'Antwortweg über ImmoScout');
  assert.equal(h.person, RELAIS_HINWEIS, 'spätere Nachrichten der Person landen auf derselben Karte');
  assert.match(h.inhalt.link, /^https:\/\/www\.immobilienscout24\.de\/nachrichten-manager\/.*contact-request\/4059af1f395448edaa64e4132e84a361/);
  assert.equal(h.bewertung.urteil, 'unklar');
  assert.equal(h.bewertung.punkte, 40);
  assert.match(h.bewertung.antwort, /folgende Angaben:\n- monatliches Haushaltsnettoeinkommen\n- Beruf und Art der Beschäftigung$/);
  assert.match(h.inhalt.original, /Familie Ibrom/, 'der Wortlaut zeigt die Nachricht');
  assert.equal(h.inhalt.volltext, 'Guten Tag Herr Ziegler,\n\nals junge Familie mit zwei Kindern (3 und 5 Jahre) suchen wir eine Wohnung. '
    + 'Wir freuen uns ueber einen Besichtigungstermin.\n\nVG\nFamilie Ibrom', 'die Nachricht ganz, in den Worten der Person');
  assert.equal(h.fehler, null);
});

test('Ist der Assistent gestört, steht die Nachricht trotzdem gleich da — bewertet wird, sobald er wieder kann', async function () {
  const RELAIS2 = 'sucher.aaaa1111bbbb2222cccc3333dddd4444@nachrichten.immobilienscout24.de';
  MAILS.hinweis2 = {
    von: 'anfrage@immobilienscout24.de', betreff: 'Anfrage zu Ihrem Objekt 169648839', wann: JETZT - 600000,
    text: 'Anfrage zu Objekt 169648839',
    html: '<html><head>\r\n  <!-- Kontaktanfrage zu Ihrem Objekt 169648839\r\nObjektID: 169648839\r\nObjektname: 169648839\r\n'
      + 'Text: Guten Tag Herr Ziegler,\r\nwir sind Familie Ibrom und haben grosses Interesse.\r\n -->\r\n</head><body>'
      + '<p>Sie haben eine neue Anfrage erhalten. Sie können nun direkt über den <a href="https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/169648839/contact-request/aaaa1111bbbb2222cccc3333dddd4444">Nachrichten-Manager</a> antworten.</p>'
      + '<p>Daten zu Ihrer Immobilie 169648839</p><p>Nachricht Ihrer Interessent:innen</p></body></html>'
  };
  const vorher = anthropic.anfragen.length;
  anthropic.stoerung = 529;
  let a = await louis.get('/api/anfragen?neu=1');
  let k = a.json.anfragen.find(function (x) { return x.id === 'hinweis2'; });
  assert.ok(k, 'die Karte ist da, obwohl der Assistent nicht antwortet');
  assert.equal(k.inhalt.volltext, 'Guten Tag Herr Ziegler,\nwir sind Familie Ibrom und haben grosses Interesse.');
  assert.equal(k.inhalt.hinweis, 'nachrichten-manager', 'noch nicht bewertet');
  assert.equal(k.inhalt.email, RELAIS2);
  assert.deepEqual(k.bewertung.gruende, ['Die Nachricht ist da, die Bewertung folgt']);
  assert.match(a.json.fehler, /gestört/);
  assert.equal(anthropic.anfragen.length, vorher, 'der gestörte Dienst zählt keine Anfrage');

  // Der Dienst kann wieder: beim nächsten Abgleich wird dieselbe Mail bewertet, die Karte bekommt Namen und Urteil
  anthropic.stoerung = 0;
  a = await louis.get('/api/anfragen?neu=1');
  k = a.json.anfragen.find(function (x) { return x.id === 'hinweis2'; });
  assert.equal(anthropic.anfragen.length, vorher + 1);
  assert.equal(k.inhalt.name, 'Familie Ibrom');
  assert.equal(k.inhalt.hinweis, undefined);
  assert.equal(k.inhalt.volltext, 'Guten Tag Herr Ziegler,\nwir sind Familie Ibrom und haben grosses Interesse.');
  assert.equal(k.person, RELAIS2);
  assert.equal(a.json.fehler, null);

  // Antworten über ImmoScout tragen die Nachricht ebenso ganz
  const renate = a.json.anfragen.find(function (x) { return x.id === 'antwort1'; });
  assert.equal(renate.inhalt.volltext, 'Guten Morgen Herr Ziegler,\nist die Wohnung noch zu mieten? Wir sind zu zweit, beide berufstätig.\nViele Grüße\nRenate Schäfer');
});
