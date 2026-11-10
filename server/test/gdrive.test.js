'use strict';

// Google Drive: Recht zum Lesen über die bestehende Google-Verbindung, Ordner auswählen, einlesen, zuordnen,
// Änderungen nachziehen, korrigieren und lernen. Google (Anmeldung, Gmail-Profil, Drive) ist eine kleine Attrappe.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { serverStarten, sitzung } = require('./hilfe');

const ORDNER_TYP = 'application/vnd.google-apps.folder';
const LESEN = 'https://www.googleapis.com/auth/drive.readonly';

function fakeGoogle() {
  const g = {
    mitLesen: false,          // ob die nächste Anmeldung das Leserecht für Drive enthält
    ordner: [], dateien: [],  // was in „Meine Ablage“ liegt
    aenderungen: [],          // Änderungsprotokoll für die Changes-API
    abrufe: [], dateiListen: 0
  };
  g.ordnerNeu = function (id, name, eltern) { const o = { id: id, name: name, parents: [eltern], mimeType: ORDNER_TYP }; g.ordner.push(o); return o; };
  g.dateiNeu = function (id, name, eltern, mime) {
    const d = { id: id, name: name, parents: [eltern], mimeType: mime || 'application/pdf', size: '2048', modifiedTime: '2026-11-01T10:00:00Z',
      webViewLink: 'https://drive.example/' + id };
    g.dateien.push(d); return d;
  };
  // Nach dem ersten Einlesen: Änderungen so melden, wie Google sie meldet
  g.dateiDazu = function (id, name, eltern, mime) { const d = g.dateiNeu(id, name, eltern, mime); g.aenderungen.push({ fileId: id, removed: false, file: d }); };
  g.dateiWeg = function (id) { g.dateien = g.dateien.filter(function (d) { return d.id !== id; }); g.aenderungen.push({ fileId: id, removed: true }); };
  g.ordnerUmbenennen = function (id, name) {
    const o = g.ordner.find(function (x) { return x.id === id; }); o.name = name;
    g.aenderungen.push({ fileId: id, removed: false, file: o });
  };

  const server = http.createServer(function (req, res) {
    let koerper = '';
    req.on('data', function (d) { koerper += d; });
    req.on('end', function () {
      const url = new URL(req.url, 'http://x');
      g.abrufe.push(req.method + ' ' + url.pathname);
      res.setHeader('Content-Type', 'application/json');
      const json = function (x, status) { res.statusCode = status || 200; res.end(JSON.stringify(x)); };
      if (req.method === 'POST' && url.pathname === '/token') {
        const scope = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file' + (g.mitLesen ? ' ' + LESEN : '');
        return json({ access_token: 'zugang', refresh_token: 'dauerhaft', expires_in: 3600, scope: scope });
      }
      if (url.pathname === '/gmail/v1/users/me/profile') return json({ emailAddress: 'louis@example.org' });
      if (url.pathname.indexOf('/drive/') === 0) {
        if (req.headers.authorization !== 'Bearer zugang') return json({ error: 'unauthorized' }, 401);
        const p = url.pathname.slice('/drive'.length);
        if (p === '/changes/startPageToken') return json({ startPageToken: String(g.aenderungen.length) });
        if (p === '/files/root') return json({ id: 'wurzel' });
        if (p === '/files') {
          const nurOrdner = /mimeType = 'application\/vnd\.google-apps\.folder'/.test(url.searchParams.get('q') || '');
          if (!nurOrdner) g.dateiListen++;
          // Wie Google: mit „'me' in owners“ fehlt, was andere in Louis' Ordner gelegt haben
          const nurMeine = /'me' in owners/.test(url.searchParams.get('q') || '');
          const alle = (nurOrdner ? g.ordner : g.dateien).filter(function (x) { return !(nurMeine && x.fremd); });
          // In Dreierseiten — so wird das Blättern mitgeprüft
          const ab = Number(url.searchParams.get('pageToken') || 0);
          const seite = alle.slice(ab, ab + 3);
          return json(Object.assign({ files: seite }, ab + 3 < alle.length ? { nextPageToken: String(ab + 3) } : {}));
        }
        if (p === '/changes') {
          const ab = Number(url.searchParams.get('pageToken'));
          if (!(ab >= 0) || ab > g.aenderungen.length) return json({ error: 'invalid page token' }, 400);
          return json({ changes: g.aenderungen.slice(ab), newStartPageToken: String(g.aenderungen.length) });
        }
      }
      json({}, 404);
    });
  });
  return new Promise(function (ok) {
    server.listen(0, '127.0.0.1', function () {
      g.basis = 'http://127.0.0.1:' + server.address().port;
      g.stoppen = function () { server.close(); };
      ok(g);
    });
  });
}

const warten = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function fertig(s) {
  for (let i = 0; i < 60; i++) {
    const st = (await s.get('/api/dokumente')).json;
    if (!st.laeuft && st.zuletzt) return st;
    await warten(100);
  }
  throw new Error('Abgleich wurde nicht fertig');
}

test('Google Drive: Recht holen, Ordner wählen, einlesen, zuordnen, Änderungen, lernen', async function () {
  const g = await fakeGoogle();
  // Ordner so, wie Louis sie angelegt hat
  g.ordnerNeu('firma', 'Firma', 'wurzel');
  g.ordnerNeu('privat', 'Privat', 'wurzel');
  g.ordnerNeu('bertha', 'Bertha von Suttna ', 'firma');
  g.ordnerNeu('einheiten', '01 Mieteinheiten', 'bertha');
  g.ordnerNeu('eglinks', 'EG Links', 'einheiten');
  g.ordnerNeu('og1links', '1.OG Links', 'einheiten');
  g.ordnerNeu('rechnungen', '03 Rechnungen', 'bertha');
  g.ordnerNeu('sonstiges', '07 Sonstiges', 'bertha');
  g.ordnerNeu('maybach', 'Maybachstr.', 'firma');
  g.ordnerNeu('louis', 'Louis Ziegler', 'firma');
  g.ordnerNeu('hausmeister', 'Hausmeister', 'firma');
  g.ordnerNeu('belege7', 'Belege 7', 'firma');
  g.dateiNeu('mv', 'Mietvertrag.pdf', 'eglinks');
  g.dateiNeu('scan', 'Scan 2026-10-01.pdf', 'rechnungen');
  g.dateiNeu('protokoll', 'Übergabeprotokoll', 'og1links', 'application/vnd.google-apps.document');
  g.dateiNeu('alt', 'alt.pdf', 'sonstiges');
  g.dateiNeu('grundriss', 'Grundriss EG.pdf', 'maybach');
  g.dateiNeu('passwoerter', 'Passwörter Steuerberater.docx', 'louis');
  g.dateiNeu('okt', 'Stundenzettel Oktober.pdf', 'hausmeister');
  g.dateiNeu('nov', 'Stundenzettel November.pdf', 'hausmeister');
  g.dateiNeu('gaertner', 'Gärtner.pdf', 'belege7');
  g.dateiNeu('urlaub', 'Urlaub.pdf', 'privat');
  g.dateiNeu('ds', '.DS_Store', 'firma', 'application/octet-stream');
  g.dateiNeu('fremd', 'Rechnung Hecke.pdf', 'belege7').fremd = true;   // vom Gärtner in den geteilten Ordner gelegt
  g.dateiNeu('lose', 'Nebenkosten 2025.pdf', 'wurzel');                // lose in „Meine Ablage“

  const server = await serverStarten({ GOOGLE_TOKEN_URL: g.basis + '/token', GMAIL_BASIS: g.basis, GDRIVE_BASIS: g.basis + '/drive', ADRESSE: 'https://app.example' });
  try {
    const louis = sitzung(server), papa = sitzung(server);
    await louis.post('/api/setup', { name: 'louis', passwort: 'geheim123' });
    await louis.post('/api/users', { name: 'papa', passwort: 'geheim123' });
    await papa.post('/api/login', { name: 'papa', passwort: 'geheim123' });
    await louis.put('/api/data', { data: { objects: [
      { id: 'o1', name: 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen', units: [
        { id: 'u1', name: 'EG Links', tenant: 'Marlene Kirschner', status: 'vermietet' },
        { id: 'u2', name: '1.OG Links', tenant: '', status: 'frei' }
      ] },
      { id: 'o2', name: 'Dahlienweg 7, Waiblingen', units: [], ordnerId: 'belege7' },
      { id: 'o3', name: 'Maybachstraße', units: [] }
    ], interessenten: [] } });

    // Ohne Google gibt es nichts zu lesen
    let s = (await louis.get('/api/dokumente')).json;
    assert.equal(s.google, false);
    assert.equal(s.verbunden, false);

    // Google verbunden wie bisher (fürs Postfach) — ohne Leserecht für Drive
    await louis.put('/api/google', { clientId: 'app-id', clientSecret: 'geheim' });
    const start = await louis.get('/api/google/start');
    assert.equal(start.status, 302);
    const ziel = new URL(start.kopf.get('location'));
    assert.match(ziel.searchParams.get('scope'), /drive\.readonly/, 'die Anmeldung fragt jetzt auch nach dem Leserecht');
    let zurueck = await louis.get('/api/google/zurueck?code=c&state=' + ziel.searchParams.get('state'));
    assert.equal(zurueck.status, 200, zurueck.text);
    assert.doesNotMatch(zurueck.text, /<script/i, 'kein eingebettetes Skript (die Seite verbietet es ohnehin)');
    s = (await louis.get('/api/dokumente')).json;
    assert.equal(s.google, true);
    assert.equal(s.recht, false, 'Häkchen bei Drive nicht gesetzt');
    assert.equal((await louis.get('/api/dokumente/ordner')).status, 409);

    // Neu verbunden, diesmal mit Leserecht
    g.mitLesen = true;
    const start2 = new URL((await louis.get('/api/google/start')).kopf.get('location'));
    zurueck = await louis.get('/api/google/zurueck?code=c&state=' + start2.searchParams.get('state'));
    assert.equal(zurueck.status, 200);
    s = (await louis.get('/api/dokumente')).json;
    assert.equal(s.recht, true);
    assert.equal(s.gewaehlt, false);

    // Ordner zum Auswählen: zwei Ebenen, nur für den Verwalter. Dateien liest die App noch keine.
    assert.equal((await papa.get('/api/dokumente/ordner')).status, 403);
    const wahl = (await louis.get('/api/dokumente/ordner')).json;
    assert.equal(wahl.wurzel, 'wurzel');
    assert.deepEqual(wahl.ordner.filter(function (o) { return o.ebene === 1; }).map(function (o) { return o.name; }), ['Firma', 'Privat']);
    assert.deepEqual(wahl.ordner.filter(function (o) { return o.ebene === 2; }).map(function (o) { return o.name; }),
      ['Belege 7', 'Bertha von Suttna', 'Hausmeister', 'Louis Ziegler', 'Maybachstr.']);
    assert.ok(wahl.ordner.every(function (o) { return o.an === false; }), 'vorher ist nichts gewählt');
    assert.equal((await louis.get('/api/dokumente/dateien')).json.dateien.length, 0);
    assert.equal(g.dateiListen, 0, 'vor der Auswahl liest die App keine Dateiliste');

    // Louis wählt „Firma“, aber nicht „Louis Ziegler“
    assert.equal((await papa.put('/api/dokumente/ordner', { ein: ['firma'] })).status, 403);
    const gespeichert = await louis.put('/api/dokumente/ordner', { ein: ['firma', 'gibtsnicht'], aus: ['louis'] });
    assert.equal(gespeichert.status, 200, gespeichert.text);
    s = await fertig(louis);
    assert.equal(s.verbunden, true);
    assert.equal(s.fehler, null);

    let r = (await louis.get('/api/dokumente/dateien')).json;
    let nach = {};
    r.dateien.forEach(function (d) { nach[d.id] = d; });
    assert.equal(nach.mv.objekt, 'o1'); assert.equal(nach.mv.einheit, 'u1'); assert.equal(nach.mv.art, 'Mietvertrag'); assert.equal(nach.mv.status, 'zugeordnet');
    assert.equal(nach.mv.pfad, '/Firma/Bertha von Suttna/01 Mieteinheiten/EG Links', 'Pfad aus den Ordnern, Leerzeichen am Ende weg');
    assert.equal(nach.mv.gesehen, 0, 'beim ersten Einlesen ist nichts „neu“');
    assert.equal(nach.scan.objekt, 'o1'); assert.equal(nach.scan.art, 'Rechnung', 'Art vom Ordner „03 Rechnungen“');
    assert.equal(nach.protokoll.einheit, 'u2'); assert.equal(nach.protokoll.art, 'Übergabeprotokoll', 'Google-Dokument ohne Endung');
    assert.equal(nach.grundriss.objekt, 'o3', '„Maybachstr.“ passt zu „Maybachstraße“');
    assert.equal(nach.gaertner.objekt, 'o2', 'Beleg-Ordner, der beim Objekt hinterlegt ist');
    assert.equal(nach.okt.status, 'offen', 'nichts erkennbar: wartet (ohne Assistenten) auf Louis');
    assert.equal(nach.passwoerter, undefined, 'abgewählter Ordner bleibt außen vor');
    assert.equal(nach.urlaub, undefined, 'nicht gewählter Ordner bleibt außen vor');
    assert.equal(nach.ds, undefined, 'Systemdateien nicht');
    assert.equal(nach.fremd && nach.fremd.objekt, 'o2', 'was andere in Louis\' Ordner legen, gehört dazu');
    assert.equal(nach.lose, undefined, 'lose Dateien nur, wenn „Meine Ablage“ angehakt ist');

    // Änderungen: eine neue Datei, eine gelöschte, ein umbenannter Ordner
    g.dateiDazu('kaution', 'Kaution Kirschner.pdf', 'eglinks');
    g.dateiWeg('alt');
    await louis.post('/api/dokumente/abgleich');
    await warten(50);
    await fertig(louis);
    r = (await louis.get('/api/dokumente/dateien')).json;
    nach = {}; r.dateien.forEach(function (d) { nach[d.id] = d; });
    assert.equal(nach.kaution.einheit, 'u1'); assert.equal(nach.kaution.art, 'Kaution');
    assert.ok(nach.kaution.gesehen > 0, 'später dazugekommen: NEU');
    assert.equal(nach.alt, undefined, 'gelöscht');

    g.ordnerUmbenennen('maybach', 'Maybachstraße 12');
    await louis.post('/api/dokumente/abgleich');
    await warten(50);
    await fertig(louis);
    r = (await louis.get('/api/dokumente/dateien')).json;
    nach = {}; r.dateien.forEach(function (d) { nach[d.id] = d; });
    assert.equal(nach.grundriss.pfad, '/Firma/Maybachstraße 12', 'umbenannter Ordner: alles neu eingelesen');
    assert.equal(nach.grundriss.objekt, 'o3');
    assert.equal(nach.grundriss.status, 'zugeordnet', 'nur der Ordnername hat sich geändert: Zuordnung bleibt');
    assert.equal(nach.fremd && nach.fremd.objekt, 'o2', 'auch nach dem Neu-Einlesen noch da');

    // Louis ordnet einen Stundenzettel zu → der Ordner ist gelernt, der zweite folgt
    assert.equal((await papa.put('/api/dokumente/dateien/okt', { objekt: 'o2' })).status, 403);
    assert.equal((await louis.put('/api/dokumente/dateien/okt', { objekt: 'gibtsnicht' })).status, 400);
    const korrektur = await louis.put('/api/dokumente/dateien/okt', { objekt: 'o2', einheit: '', art: 'Rechnung' });
    assert.equal(korrektur.status, 200, korrektur.text);
    r = (await louis.get('/api/dokumente/dateien')).json;
    const nov = r.dateien.find(function (x) { return x.id === 'nov'; });
    assert.equal(nov.objekt, 'o2', 'gelernter Ordner gilt für die nächste Datei');
    assert.equal(nov.status, 'zugeordnet');

    // Gelernter Ordner umbenannt: die Regel hängt an der Ordner-ID und gilt weiter
    g.ordnerUmbenennen('hausmeister', 'Hausmeister Herr Kurz');
    g.dateiDazu('dez', 'Stundenzettel Dezember.pdf', 'hausmeister');
    await louis.post('/api/dokumente/abgleich');
    await warten(50);
    await fertig(louis);
    r = (await louis.get('/api/dokumente/dateien')).json;
    nach = {}; r.dateien.forEach(function (d) { nach[d.id] = d; });
    assert.equal(nach.dez.objekt, 'o2', 'neue Datei im umbenannten, gelernten Ordner');
    assert.equal(nach.nov.objekt, 'o2');
    assert.equal(nach.nov.status, 'zugeordnet');

    // Auswahl ändern: Bertha ab, „Meine Ablage“ an. Was nicht mehr gewählt ist, ist sofort weg.
    const kleiner = await louis.put('/api/dokumente/ordner', { ein: ['firma', 'wurzel'], aus: ['louis', 'bertha'] });
    assert.equal(kleiner.status, 200);
    r = (await louis.get('/api/dokumente/dateien')).json;
    assert.ok(!r.dateien.some(function (d) { return d.objekt === 'o1'; }), 'Bertha abgewählt');
    await warten(150);
    await fertig(louis);
    r = (await louis.get('/api/dokumente/dateien')).json;
    nach = {}; r.dateien.forEach(function (d) { nach[d.id] = d; });
    assert.ok(nach.lose, 'lose Datei in „Meine Ablage“ jetzt dabei');
    assert.equal(nach.urlaub, undefined, '„Meine Ablage“ angehakt zieht keine obersten Ordner mit');
    const wahl2 = (await louis.get('/api/dokumente/ordner')).json;
    assert.deepEqual(wahl2.ein.sort(), ['firma', 'wurzel']);
    assert.deepEqual(wahl2.aus.sort(), ['bertha', 'louis']);
    assert.equal(wahl2.ordner.find(function (o) { return o.id === 'maybach'; }).an, true, 'erbt von „Firma“');
    assert.equal(wahl2.ordner.find(function (o) { return o.id === 'privat'; }).an, false);

    // Zurücksetzen: Auswahl und Zuordnungen weg, die Google-Verbindung bleibt
    assert.equal((await papa.del('/api/dokumente')).status, 403);
    assert.equal((await louis.del('/api/dokumente')).status, 200);
    s = (await louis.get('/api/dokumente')).json;
    assert.equal(s.gewaehlt, false);
    assert.equal(s.recht, true);
    assert.equal((await louis.get('/api/dokumente/dateien')).json.dateien.length, 0);
  } finally {
    await server.stoppen();
    g.stoppen();
  }
});
