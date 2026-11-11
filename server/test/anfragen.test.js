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
      + '<p>Sie haben eine neue Anfrage erhalten. Sie können nun direkt über den <a href="https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/158460832/contact-request/7f91d268?utm_medium=email&amp;utm_source=system">Nachrichten-Manager</a> antworten.</p>'
      + '<h2>Daten zu Ihrer Immobilie 158460832</h2><p>Erstbezug 2025: 3-Zimmer-Wohnung mit Balkon, EBK und Tiefgarage</p>'
      + '<table><tr><td>Scout-ID:</td><td>158460832</td></tr><tr><td>Zimmer:</td><td>3,00</td></tr><tr><td>Kaltmiete:</td><td>1.347,20 €</td></tr></table>'
      + '<p>Adresse:</p><p>Bertha-von-Suttner-Weg 4,<br>71334 Waiblingen</p><p><a href="https://www.immobilienscout24.de/expose/158460832">Direkt zum Exposé</a></p>'
      + '<p>Nachricht Ihrer Interessent:innen</p><p><a href="https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/158460832/contact-request/7f91d268">Nachrichtenverlauf anzeigen</a></p></body></html>'
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
  if (text.indexOf('Wochenstatistik') !== -1) {
    return { istAnfrage: false, name: '', email: '', telefon: '', objekt: '', einheitId: '', personen: '',
      erwachsene: null, kinder: null, haustiere: '', beruf: '', einkommen: '', einkommenNetto: null, einzug: '',
      nachricht: '', urteil: 'unklar', punkte: 0, gruende: [], fehlt: [], antwort: '' };
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
  const server = http.createServer(function (req, res) {
    let roh = '';
    req.on('data', function (d) { roh += d; });
    req.on('end', function () {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
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
      ok({ basis: 'http://127.0.0.1:' + server.address().port, anfragen: anfragen, stoppen: function () { server.close(); } });
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
  assert.deepEqual(ids(a.json.anfragen), ['anfrage2', 'anfrage1', 'antwort1', 'hinweis'], 'nur echte Anfragen, die neueste zuerst');

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

  // Die Antwort einer Interessentin: Antwortweg ist ihre Weiterleitungsadresse, und die hält ihre Mails zusammen
  const renate = a.json.anfragen[2];
  assert.equal(renate.id, 'antwort1');
  assert.equal(renate.inhalt.name, 'Renate Schäfer');
  assert.equal(renate.inhalt.email, RELAIS, 'ohne eigene Adresse gilt die Weiterleitungsadresse von ImmoScout');
  assert.equal(renate.person, RELAIS);
  assert.equal(renate.bewertung.urteil, 'vielleicht');

  // Die bloße Benachrichtigung: Karte ohne Bewertung durch Claude, mit dem Weg in den Nachrichten-Manager
  const hinweis = a.json.anfragen[3];
  assert.equal(hinweis.id, 'hinweis');
  assert.equal(hinweis.inhalt.hinweis, 'nachrichten-manager');
  assert.equal(hinweis.inhalt.name, '');
  assert.equal(hinweis.inhalt.link, 'https://www.immobilienscout24.de/nachrichten-manager/api/external/reference/158460832/contact-request/7f91d268?utm_medium=email&utm_source=system');
  assert.equal(hinweis.inhalt.objekt, 'Erstbezug 2025: 3-Zimmer-Wohnung mit Balkon, EBK und Tiefgarage · Bertha-von-Suttner-Weg 4, 71334 Waiblingen (Scout-ID 158460832)');
  assert.equal(hinweis.bewertung.urteil, 'unklar');
  assert.equal(hinweis.fehler, null);
  assert.equal(hinweis.person, null, 'anfrage@immobilienscout24.de ist kein Schlüssel — sonst wären alle Benachrichtigungen eine Karte');
  assert.match(hinweis.inhalt.original, /Daten zu Ihrer Immobilie 158460832/, 'der Wortlaut kommt aus dem HTML, nicht aus der einen Klartextzeile');

  // Inserate: die Anzeige mit Titel und Adresse aus der Benachrichtigung, zwei Anfragen dazu
  assert.deepEqual(a.json.inserate.map(function (x) { return x.anzeige; }), ['158460832']);
  assert.equal(a.json.inserate[0].titel, 'Erstbezug 2025: 3-Zimmer-Wohnung mit Balkon, EBK und Tiefgarage');
  assert.equal(a.json.inserate[0].adresse, 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen');
  assert.equal(a.json.inserate[0].anzahl, 2);
  assert.equal(a.json.inserate[0].offen, 2);
  assert.equal(a.json.inserate[0].einheitId, '');
  assert.equal(a.json.inserate[0].url, 'https://www.immobilienscout24.de/expose/158460832');

  // Jede Mail wurde einmal vollständig geholt; bei Claude landeten nur die vier, die der Vorfilter durchließ und die
  // mehr als eine Benachrichtigung sind
  assert.deepEqual(google.abrufe.slice().sort(), ['anfrage1', 'anfrage2', 'antwort1', 'hinweis', 'rueckblick', 'statistik', 'suche']);
  assert.equal(anthropic.anfragen.length, 4);
  assert.deepEqual(anthropic.anfragen.map(function (r) { return r.body.messages[0].content.split('\n')[0]; }),
    ['Betreff: ' + MAILS.anfrage1.betreff, 'Betreff: ' + MAILS.anfrage2.betreff, 'Betreff: ' + MAILS.rueckblick.betreff, 'Betreff: ' + MAILS.antwort1.betreff]);

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
  });
  // Die HTML-Mail kam als Text an, ohne Tags und ohne Stilangaben
  const text = anthropic.anfragen[1].body.messages[0].content;
  assert.match(text, /Max Beispiel/);
  assert.match(text, /ein Hund \(Labrador\)/);
  assert.doesNotMatch(text, /<\/?(p|br|td|tr|table|div|b|style|html|body)\b/i);
  assert.doesNotMatch(text, /font-family/);

  // Noch einmal: schon geprüfte Mails werden weder geholt noch bewertet
  a = await louis.get('/api/anfragen?neu=1');
  assert.equal(google.abrufe.length, 7, 'schon geprüfte Mails werden nicht nochmal geholt');
  assert.equal(anthropic.anfragen.length, 4);
  assert.deepEqual(ids(a.json.anfragen), ['anfrage2', 'anfrage1', 'antwort1', 'hinweis']);
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

  // Alle offenen (neu und gemerkt), die neueste zuerst — die Sammelrunde kostet bis zu 30 Aufrufe und ist dem Verwalter vorbehalten
  assert.equal((await papa.post('/api/anfragen/bewerten', {})).status, 403);
  assert.equal(anthropic.anfragen.length, bewertet + 1, 'ohne Recht wird Claude nicht gefragt');
  a = await louis.post('/api/anfragen/bewerten', {});
  assert.equal(a.status, 200);
  assert.deepEqual(ids(a.json.anfragen), ['anfrage2', 'anfrage1', 'antwort1', 'hinweis']);
  assert.equal(a.json.anfragen[0].inhalt.haustiere, 'Hund');
  assert.equal(a.json.anfragen[0].bewertung.urteil, 'passt nicht');
  assert.equal(a.json.anfragen[3].inhalt.hinweis, 'nachrichten-manager', 'die Benachrichtigung bleibt eine — ohne Claude');
  assert.equal(anthropic.anfragen.length, bewertet + 4);
});

test('Löschen nur der Verwalter', async function () {
  assert.equal((await papa.del('/api/anfragen/anfrage2')).status, 403);
  let a = await louis.del('/api/anfragen/anfrage2');
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { ok: true });
  a = await louis.get('/api/anfragen');
  assert.deepEqual(ids(a.json.anfragen), ['anfrage1', 'antwort1', 'hinweis']);

  // Die Mail bleibt als geprüft vermerkt — beim nächsten Abgleich kommt sie nicht zurück
  const geholt = google.abrufe.length;
  a = await louis.get('/api/anfragen?neu=1');
  assert.deepEqual(ids(a.json.anfragen), ['anfrage1', 'antwort1', 'hinweis']);
  assert.equal(google.abrufe.length, geholt);
});
