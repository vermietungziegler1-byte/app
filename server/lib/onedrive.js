'use strict';

// -------------------------------------------------------------
//  OneDrive: Dateien aus Louis' Cloud bei Objekten, Wohnungen und Mietern
//
//  Die App bekommt über Microsoft nur Lesezugriff (Files.Read) und kopiert keine Dateien — sie merkt sich Name,
//  Ort, Link und wozu die Datei gehört. Alle fünf Minuten fragt sie OneDrive nach Änderungen (Delta-Abfrage):
//  Neues kommt dazu, Gelöschtes verschwindet, Umbenanntes zieht nach.
//
//  Zuordnen in drei Stufen:
//    1. am Pfad und Namen (dokumente-regeln.js) — kostenlos
//    2. was dabei offen bleibt und ein PDF ist, liest der Assistent (Objekt, Wohnung, Art, Datum)
//    3. was unsicher ist, steht unter „Bitte prüfen“; Louis' Antwort merkt sich die App für den ganzen Ordner
// -------------------------------------------------------------

const express = require('express');
const { db, crypto, holen, htmlSicher, einstellung, einstellungSetzen, standInhalt, mitFehler } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const regeln = require('./dokumente-regeln');

const app = express.Router();
const LOGIN = process.env.MS_LOGIN_BASIS || 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = process.env.MS_GRAPH_BASIS || 'https://graph.microsoft.com/v1.0';
const SCOPE = 'offline_access Files.Read User.Read';
const TAKT_MS = 5 * 60 * 1000;
// Große PDFs (viele Seiten) liest der Assistent nicht — das kostet viel und sagt selten mehr als der Name
const ASSISTENT_JE_LAUF = 25, ASSISTENT_JE_TAG = 300, PDF_HOECHSTENS = 3 * 1024 * 1024;
// Sammelordner: Hier lernt die App nichts aus einer einzelnen Zuordnung, sonst landete jeder Scan beim selben Objekt
const SAMMELORDNER = /^(scans?|dokumente|documents|downloads?|desktop|bilder|pictures|fotos|rechnungen|belege|eingang|neu|sonstiges|ablage|temp|privat|onedrive|anhaenge|attachments)$/;

db.exec(`
  CREATE TABLE IF NOT EXISTS od_dateien (
    id        TEXT PRIMARY KEY,
    name      TEXT,
    pfad      TEXT,
    mime      TEXT,
    groesse   INTEGER,
    geaendert INTEGER,
    url       TEXT,
    objekt    TEXT,
    einheit   TEXT,
    art       TEXT,
    titel     TEXT,
    datum     TEXT,
    quelle    TEXT,
    status    TEXT DEFAULT 'neu',
    gesehen   INTEGER
  );
  CREATE INDEX IF NOT EXISTS od_dateien_objekt ON od_dateien (objekt);
  CREATE TABLE IF NOT EXISTS od_regeln (pfad TEXT PRIMARY KEY, objekt TEXT, einheit TEXT);
`);
// status: neu (noch nicht angesehen) · zugeordnet · pruefen (Vorschlag, unsicher) · offen (keine Ahnung, wartet auf den
// Assistenten) · unklar (auch der Assistent weiß es nicht) · fremd (hat nichts mit der Vermietung zu tun) · ignoriert (Louis: keins)

function fehler(text, status) { const e = new Error(text); e.status = status; return e; }
function verschluesselt() { return require('./postfach'); }   // dieselbe Verschlüsselung wie fürs Mailkonto

function einstellungen() {
  let refresh = null;
  try { refresh = einstellung('od_refresh') ? verschluesselt().entschluesseln(einstellung('od_refresh')) : null; } catch (e) { refresh = null; }
  return { clientId: einstellung('od_client_id'), clientSecret: einstellung('od_client_secret'), refresh: refresh, konto: einstellung('od_konto') };
}

// ---------------- Zugriff bei Microsoft ----------------
let zugriff = { token: null, bis: 0 };
async function token() {
  const e = einstellungen();
  if (!e.clientId || !e.refresh) throw fehler('OneDrive ist nicht verbunden', 409);
  if (zugriff.token && Date.now() < zugriff.bis) return zugriff.token;
  const antwort = await holen(LOGIN + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret || '', grant_type: 'refresh_token', refresh_token: e.refresh, scope: SCOPE })
  });
  const daten = await antwort.json().catch(function () { return {}; });
  if (!antwort.ok || !daten.access_token) {
    if (daten.error === 'invalid_grant') throw fehler('Die Verbindung zu OneDrive ist abgelaufen — bitte unter Menü → OneDrive neu anmelden', 409);
    throw fehler('Microsoft lehnt den Zugriff ab (' + antwort.status + (daten.error ? ', ' + daten.error : '') + ')', 502);
  }
  // Microsoft gibt bei jeder Erneuerung ein neues dauerhaftes Recht aus — das alte läuft dann irgendwann ab
  if (daten.refresh_token) einstellungSetzen('od_refresh', verschluesselt().verschluesseln(daten.refresh_token));
  zugriff = { token: daten.access_token, bis: Date.now() + Math.max(60, (Number(daten.expires_in) || 3600) - 120) * 1000 };
  return zugriff.token;
}
async function graph(pfadOderUrl) {
  const url = /^https?:/.test(pfadOderUrl) ? pfadOderUrl : GRAPH + pfadOderUrl;
  const antwort = await holen(url, { headers: { Authorization: 'Bearer ' + await token() } });
  if (antwort.status === 401) zugriff = { token: null, bis: 0 };
  if (!antwort.ok) {
    const grund = await antwort.text().catch(function () { return ''; });
    const e = fehler('OneDrive antwortet mit ' + antwort.status + (grund ? ': ' + grund.slice(0, 160) : ''), antwort.status === 410 ? 410 : 502);
    throw e;
  }
  return antwort.json();
}

// ---------------- Abgleich ----------------
const stand = { laeuft: false, zuletzt: 0, fehler: null, neu: 0 };

function pfadVon(item) {
  // parentReference.path: "/drive/root:/Dokumente/Scans" → "/Dokumente/Scans"
  const p = (item.parentReference && item.parentReference.path) || '';
  const i = p.indexOf('root:');
  return decodeURIComponent(i === -1 ? '' : p.slice(i + 5)) || '/';
}

const speichern = db.prepare(`INSERT INTO od_dateien (id, name, pfad, mime, groesse, geaendert, url, status, gesehen)
  VALUES (@id, @name, @pfad, @mime, @groesse, @geaendert, @url, 'neu', @gesehen)
  ON CONFLICT(id) DO UPDATE SET name = @name, pfad = @pfad, mime = @mime, groesse = @groesse, geaendert = @geaendert, url = @url,
    status = CASE WHEN od_dateien.status IN ('zugeordnet', 'ignoriert') AND od_dateien.quelle = 'louis' THEN od_dateien.status
                  WHEN od_dateien.name <> @name OR od_dateien.pfad <> @pfad THEN 'neu' ELSE od_dateien.status END`);

async function abgleichen() {
  if (stand.laeuft) return;
  const e = einstellungen();
  if (!e.clientId || !e.refresh) return;
  stand.laeuft = true; stand.fehler = null;
  try {
    let url = einstellung('od_delta') || '/me/drive/root/delta?$select=id,name,file,folder,parentReference,size,lastModifiedDateTime,webUrl,deleted';
    let seiten = 0, neu = 0;
    while (url && seiten < 400) {
      let antwort;
      try { antwort = await graph(url); }
      catch (x) {
        // 410: der gemerkte Stand ist zu alt — von vorn
        if (x.status === 410) { db.prepare("DELETE FROM einstellungen WHERE schluessel = 'od_delta'").run(); url = '/me/drive/root/delta'; continue; }
        throw x;
      }
      seiten++;
      db.transaction(function () {
        (antwort.value || []).forEach(function (it) {
          if (it.deleted) { db.prepare('DELETE FROM od_dateien WHERE id = ?').run(it.id); return; }
          if (!it.file) return;   // Ordner merken wir uns nicht
          const pfad = pfadVon(it);
          if (!regeln.kommtInFrage(pfad, it.name)) { db.prepare('DELETE FROM od_dateien WHERE id = ?').run(it.id); return; }
          const vorher = db.prepare('SELECT 1 FROM od_dateien WHERE id = ?').get(it.id);
          speichern.run({ id: it.id, name: it.name, pfad: pfad, mime: (it.file && it.file.mimeType) || '', groesse: it.size || 0,
            geaendert: Date.parse(it.lastModifiedDateTime || '') || 0, url: it.webUrl || '', gesehen: Date.now() });
          if (!vorher) neu++;
        });
      })();
      if (antwort['@odata.nextLink']) url = antwort['@odata.nextLink'];
      else { if (antwort['@odata.deltaLink']) einstellungSetzen('od_delta', antwort['@odata.deltaLink']); url = null; }
    }
    stand.neu = neu;
    regelnAnwenden();
    await assistentAnwenden();
  } catch (x) {
    stand.fehler = x.message;
  } finally {
    stand.laeuft = false; stand.zuletzt = Date.now();
  }
}

// Stufe 1: am Pfad und Namen — für alles, was neu ist oder dessen Zuordnung nicht von Louis stammt
function regelnAnwenden() {
  const wb = regeln.woerterbuch(standInhalt() || {});
  const gelernt = db.prepare('SELECT pfad, objekt, einheit FROM od_regeln').all();
  const setzen = db.prepare('UPDATE od_dateien SET objekt = ?, einheit = ?, art = ?, quelle = ?, status = ? WHERE id = ?');
  db.transaction(function () {
    // Neue immer; offene und unklare nur, wenn jetzt eine Regel greift (z. B. nach einem neuen Mieter oder gelernten Ordner)
    db.prepare("SELECT id, name, pfad, status FROM od_dateien WHERE status IN ('neu', 'offen', 'unklar')").all().forEach(function (d) {
      const r = regeln.zuordnen(d.pfad, d.name, wb, gelernt);
      if (r.objekt) setzen.run(r.objekt, r.einheit || '', r.art, 'regel', r.sicher ? 'zugeordnet' : 'pruefen', d.id);
      else if (d.status === 'neu') setzen.run('', '', r.art, 'regel', r.kandidaten && r.kandidaten.length ? 'pruefen' : 'offen', d.id);
    });
  })();
}

// Stufe 2: offene PDFs liest der Assistent — die neuesten zuerst, mit Tageslimit
const ARTEN = regeln.ARTEN.map(function (a) { return a[0]; }).concat(['Foto', 'Sonstiges']);
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    vermietung: { type: 'boolean' },
    objekt: { type: 'string' }, einheit: { type: 'string' },
    art: { type: 'string', enum: ARTEN },
    titel: { type: 'string' }, datum: { type: 'string' },
    sicherheit: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] }
  },
  required: ['vermietung', 'objekt', 'einheit', 'art', 'titel', 'datum', 'sicherheit']
};
function tagesZaehler(dazu) {
  const heute = new Date().toISOString().slice(0, 10);
  const [tag, n] = String(einstellung('od_assistent_tag') || '').split(':');
  let zahl = tag === heute ? Number(n) || 0 : 0;
  if (dazu) { zahl += dazu; einstellungSetzen('od_assistent_tag', heute + ':' + zahl); }
  return zahl;
}
async function assistentAnwenden() {
  if (!einstellung('anthropic_token')) return;
  let frei = Math.min(ASSISTENT_JE_LAUF, ASSISTENT_JE_TAG - tagesZaehler(0));
  if (frei <= 0) return;
  const offen = db.prepare("SELECT * FROM od_dateien WHERE status = 'offen' AND lower(name) LIKE '%.pdf' AND groesse <= ? ORDER BY geaendert DESC LIMIT ?")
    .all(PDF_HOECHSTENS, frei);
  if (!offen.length) return;
  const s = standInhalt() || {};
  const liste = (s.objects || []).map(function (o) {
    return '- ' + o.id + ': ' + o.name + '\n' + (o.units || []).map(function (x) {
      return '    - ' + x.id + ': ' + (x.name || '') + (x.tenant ? ' (Mieter: ' + x.tenant + ')' : '');
    }).join('\n');
  }).join('\n');
  const { claude } = require('./assistent');
  for (const d of offen) {
    let r = null;
    try {
      const antwort = await fetch(GRAPH + '/me/drive/items/' + encodeURIComponent(d.id) + '/content', {
        headers: { Authorization: 'Bearer ' + await token() }, signal: AbortSignal.timeout(30000)
      });
      if (!antwort.ok) throw new Error('Datei nicht lesbar (' + antwort.status + ')');
      const daten = Buffer.from(await antwort.arrayBuffer());
      const koerper = {
        max_tokens: 1500,
        system: 'Du hilfst Louis Ziegler, einem privaten Vermieter, Dateien aus seiner Cloud zu ordnen. Bestimme für das Dokument: '
          + 'gehört es zur Vermietung (vermietung), zu welchem Objekt (objekt = die ID aus der Liste, sonst leer) und welcher Wohnung '
          + '(einheit = die ID, sonst leer — leer lassen, wenn es das ganze Haus betrifft), welche Art es ist, einen kurzen Titel '
          + '(z. B. „Nebenkostenabrechnung 2025“ oder „Rechnung Gartenpflege“), das Datum des Dokuments (JJJJ-MM-TT oder leer) und wie '
          + 'sicher du dir bei Objekt und Wohnung bist. Adresse, Mietername oder Wohnungsbezeichnung im Text sind die besten Hinweise. '
          + 'Rate nicht: lieber leer und sicherheit „niedrig“.\n\nObjekte und Wohnungen:\n' + liste,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: daten.toString('base64') } },
          { type: 'text', text: 'Dateiname: ' + d.name + '\nOrdner: ' + d.pfad }
        ] }]
      };
      let antwortClaude = null;
      for (const v of [{ model: 'claude-haiku-5-5', output_config: { format: { type: 'json_schema', schema: SCHEMA } } },
                       { model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } }]) {
        try { antwortClaude = await claude(Object.assign({}, koerper, v), null, 60000); break; }
        catch (x) { if (x.status && x.status !== 400 && x.status !== 404) throw x; }
      }
      if (!antwortClaude) throw new Error('Kein Modell erreichbar');
      tagesZaehler(1);
      const block = (antwortClaude.content || []).find(function (x) { return x.type === 'text'; });
      r = JSON.parse(block.text);
    } catch (x) {
      if (x.status === 401 || x.status === 429 || /Guthaben/.test(x.message || '')) break;   // Schlüssel, Auslastung, Guthaben: später weiter
      db.prepare("UPDATE od_dateien SET status = 'unklar', quelle = 'assistent' WHERE id = ?").run(d.id);
      continue;
    }
    const objektOk = (s.objects || []).some(function (o) { return o.id === r.objekt; });
    const einheitOk = objektOk && (s.objects || []).some(function (o) { return o.id === r.objekt && (o.units || []).some(function (x) { return x.id === r.einheit; }); });
    const status = !r.vermietung ? 'fremd' : (!objektOk ? 'unklar' : (r.sicherheit === 'hoch' ? 'zugeordnet' : 'pruefen'));
    db.prepare('UPDATE od_dateien SET objekt = ?, einheit = ?, art = ?, titel = ?, datum = ?, quelle = ?, status = ? WHERE id = ?')
      .run(objektOk ? r.objekt : '', einheitOk ? r.einheit : '', r.art || 'Sonstiges', String(r.titel || '').slice(0, 120),
        /^\d{4}-\d{2}-\d{2}$/.test(r.datum || '') ? r.datum : '', 'assistent', status, d.id);
  }
}

setTimeout(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, 30000).unref();
setInterval(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, TAKT_MS).unref();

// ---------------- Schnittstellen ----------------
function zahlen() {
  const z = {};
  db.prepare('SELECT status, COUNT(*) AS n FROM od_dateien GROUP BY status').all().forEach(function (r) { z[r.status] = r.n; });
  return z;
}
app.get('/api/onedrive', nurAngemeldet, function (req, res) {
  const e = einstellungen();
  res.json({ eingerichtet: !!(e.clientId && e.clientSecret), verbunden: !!e.refresh, konto: e.konto || null,
    zahlen: zahlen(), laeuft: stand.laeuft, zuletzt: stand.zuletzt || null, fehler: stand.fehler, assistentHeute: tagesZaehler(0) });
});

app.put('/api/onedrive', nurAngemeldet, nurVerwalter, function (req, res) {
  const { clientId, clientSecret } = req.body || {};
  if (clientId) einstellungSetzen('od_client_id', String(clientId).trim());
  if (clientSecret) einstellungSetzen('od_client_secret', String(clientSecret).trim());
  res.json({ ok: true });
});

app.delete('/api/onedrive', nurAngemeldet, nurVerwalter, function (req, res) {
  ['od_refresh', 'od_konto', 'od_delta'].forEach(function (k) { db.prepare('DELETE FROM einstellungen WHERE schluessel = ?').run(k); });
  db.prepare('DELETE FROM od_dateien').run();
  zugriff = { token: null, bis: 0 };
  res.json({ ok: true });
});

function rueckweg(req) {
  const basis = process.env.ADRESSE ? process.env.ADRESSE.replace(/\/+$/, '') : 'https://' + req.get('host');
  return basis + '/api/onedrive/zurueck';
}
const vorgaenge = new Map();
app.get('/api/onedrive/start', nurAngemeldet, nurVerwalter, function (req, res) {
  const e = einstellungen();
  if (!e.clientId) return res.status(400).send('Erst die Anwendungs-ID von Microsoft hinterlegen');
  const grenze = Date.now() - 10 * 60 * 1000;
  vorgaenge.forEach(function (v, k) { if (v.zeit < grenze) vorgaenge.delete(k); });
  const state = crypto.randomBytes(24).toString('hex');
  vorgaenge.set(state, { nutzer: req.nutzer, zeit: Date.now() });
  res.redirect(LOGIN + '/authorize?' + new URLSearchParams({
    client_id: e.clientId, response_type: 'code', redirect_uri: rueckweg(req), response_mode: 'query',
    scope: SCOPE, state: state, prompt: 'select_account'
  }));
});
app.get('/api/onedrive/zurueck', nurAngemeldet, nurVerwalter, async function (req, res) {
  const seite = function (titel, text) {
    return '<meta charset="utf-8"><meta http-equiv="refresh" content="2;url=/"><body style="font-family:sans-serif;background:#000;color:#f5f5f7;padding:40px">'
      + '<h2>' + htmlSicher(titel) + '</h2><p>' + htmlSicher(text) + '</p></body>';
  };
  const state = String(req.query.state || '');
  const vorgang = vorgaenge.get(state);
  vorgaenge.delete(state);
  if (!vorgang || vorgang.nutzer !== req.nutzer || Date.now() - vorgang.zeit > 10 * 60 * 1000) {
    return res.status(400).send(seite('Nicht verbunden', 'Dieser Rücksprung gehört zu keiner laufenden Anmeldung. Bitte in der App neu verbinden.'));
  }
  if (req.query.error) return res.status(400).send(seite('Nicht verbunden', String(req.query.error_description || req.query.error)));
  const e = einstellungen();
  try {
    const antwort = await holen(LOGIN + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret || '', code: String(req.query.code || ''),
        redirect_uri: rueckweg(req), grant_type: 'authorization_code', scope: SCOPE })
    });
    const daten = await antwort.json();
    if (!daten.refresh_token) throw new Error(daten.error_description || 'Kein dauerhaftes Zugriffsrecht erhalten');
    einstellungSetzen('od_refresh', verschluesselt().verschluesseln(daten.refresh_token));
    zugriff = { token: daten.access_token, bis: Date.now() + 50 * 60 * 1000 };
    try {
      const ich = await graph('/me?$select=displayName,userPrincipalName,mail');
      einstellungSetzen('od_konto', String(ich.mail || ich.userPrincipalName || ich.displayName || ''));
    } catch (x) { /* nicht schlimm */ }
    setTimeout(function () { abgleichen().catch(function () { /* nächster Lauf */ }); }, 1000).unref();
    res.send(seite('OneDrive verbunden', 'Die App liest jetzt deine Dateien ein und ordnet sie zu. Du kannst dieses Fenster schließen.'));
  } catch (x) {
    res.status(502).send(seite('Nicht verbunden', x.message));
  }
});

app.post('/api/onedrive/abgleich', nurAngemeldet, nurVerwalter, function (req, res) {
  abgleichen().catch(function () { /* steht in stand.fehler */ });
  res.json({ ok: true });
});

// Alle zugeordneten und zu prüfenden Dateien — schlank, die App filtert selbst nach Objekt und Wohnung
app.get('/api/onedrive/dateien', nurAngemeldet, function (req, res) {
  const zeilen = db.prepare("SELECT id, name, pfad, mime, groesse, geaendert, url, objekt, einheit, art, titel, datum, quelle, status, gesehen "
    + "FROM od_dateien WHERE status IN ('zugeordnet', 'pruefen', 'unklar') ORDER BY geaendert DESC LIMIT 5000").all();
  res.json({ dateien: zeilen, zahlen: zahlen(), laeuft: stand.laeuft, zuletzt: stand.zuletzt || null, fehler: stand.fehler });
});

// Louis ordnet zu (oder sagt „gehört zu keinem“). Mit merken: gilt künftig für den ganzen Ordner
app.put('/api/onedrive/dateien/:id', nurAngemeldet, nurVerwalter, function (req, res) {
  const d = db.prepare('SELECT * FROM od_dateien WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ fehler: 'Datei nicht gefunden' });
  const b = req.body || {};
  if (b.ignorieren) {
    db.prepare("UPDATE od_dateien SET status = 'ignoriert', quelle = 'louis', objekt = '', einheit = '' WHERE id = ?").run(d.id);
  } else {
    const objekt = String(b.objekt || d.objekt || '');
    if (!objekt) return res.status(400).json({ fehler: 'Zu welchem Objekt?' });
    const einheit = b.einheit !== undefined ? String(b.einheit || '') : (d.einheit || '');
    db.prepare("UPDATE od_dateien SET objekt = ?, einheit = ?, art = ?, quelle = 'louis', status = 'zugeordnet' WHERE id = ?")
      .run(objekt, einheit, String(b.art || d.art || 'Sonstiges'), d.id);
    // Lernen: nicht in Sammelordnern wie „Scans“ oder „Dokumente“ — sonst landete dort alles beim selben Objekt
    const letzter = regeln.normal(d.pfad.split('/').filter(Boolean).pop() || '').trim();
    if (b.merken !== false && d.pfad && d.pfad !== '/' && letzter && !SAMMELORDNER.test(letzter)) {
      db.prepare('INSERT OR REPLACE INTO od_regeln (pfad, objekt, einheit) VALUES (?, ?, ?)').run(d.pfad, objekt, b.ordnerMitWohnung ? einheit : '');
      // Was im selben Ordner noch offen ist, gleich mitnehmen
      db.prepare("UPDATE od_dateien SET status = 'neu' WHERE pfad = ? AND status IN ('offen', 'unklar', 'pruefen') AND id <> ?").run(d.pfad, d.id);
      regelnAnwenden();
    }
  }
  res.json({ ok: true, datei: db.prepare('SELECT * FROM od_dateien WHERE id = ?').get(d.id), zahlen: zahlen() });
});

module.exports = { router: app, abgleichen, regelnAnwenden };
