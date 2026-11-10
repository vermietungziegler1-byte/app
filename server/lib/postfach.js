'use strict';

// -------------------------------------------------------------
//  Postfach: Louis' eigenes Mailkonto (louis.ziegler@mzer.de) über IMAP und SMTP.
//  Ordner ansehen, Mails lesen, löschen, verschieben, schreiben und beantworten —
//  alles direkt auf dem Mailserver, Outlook sieht denselben Stand.
//
//  Das Passwort liegt verschlüsselt (AES-256-GCM) in der Datenbank. Der Schlüssel
//  steht in einer eigenen Datei im Datenordner — nicht in der Datenbank und damit
//  auch nicht in deren Sicherung bei Google Drive. Nur der Verwalter kommt ans Postfach.
// -------------------------------------------------------------

const express = require('express');
const { crypto, path, fs, DATENORDNER, db, einstellung, einstellungSetzen, mitFehler } = require('./kern');
const { nurVerwalter } = require('./anmeldung');

let ImapFlow = null, nodemailer = null, MailComposer = null, simpleParser = null;
try {
  ImapFlow = require('imapflow').ImapFlow;
  nodemailer = require('nodemailer');
  MailComposer = require('nodemailer/lib/mail-composer');
  simpleParser = require('mailparser').simpleParser;
} catch (e) {
  console.log('Hinweis: imapflow, nodemailer oder mailparser fehlen — das Postfach bleibt aus. Nachrüsten mit: npm install imapflow nodemailer mailparser');
}
const PAKETE_FEHLEN = 'Auf dem Server fehlen die Pakete für das Postfach — einmal „einspielen“ ausführen, dann sind sie da.';

const app = express.Router();
const STANDARD_SERVER = process.env.POSTFACH_SERVER || 'mail.gate-7.de';
const IMAP_PORT = Number(process.env.POSTFACH_IMAP_PORT) || 993;
const SMTP_PORT = Number(process.env.POSTFACH_SMTP_PORT) || 465;
const MIT_TLS = process.env.POSTFACH_TLS !== '0';      // nur die Tests schalten das ab

function fehler(text, status) { const e = new Error(text); e.status = status; return e; }

// ---------------- Passwort verschlüsselt ablegen ----------------
const SCHLUESSELDATEI = process.env.POSTFACH_SCHLUESSEL || path.join(DATENORDNER, 'postfach.schluessel');
function schluessel() {
  try { const k = fs.readFileSync(SCHLUESSELDATEI); if (k.length === 32) return k; } catch (e) { /* noch keiner da */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(SCHLUESSELDATEI, k, { mode: 0o600 });
  return k;
}
function verschluesseln(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel(), iv);
  const inhalt = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), inhalt]).toString('base64');
}
function entschluesseln(wert) {
  if (!wert || String(wert).indexOf('v1:') !== 0) return null;
  const roh = Buffer.from(String(wert).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', schluessel(), roh.subarray(0, 12));
  d.setAuthTag(roh.subarray(12, 28));
  return Buffer.concat([d.update(roh.subarray(28)), d.final()]).toString('utf8');
}

function zugang() {
  const benutzer = einstellung('postfach_benutzer');
  const geheim = einstellung('postfach_passwort');
  if (!benutzer || !geheim) return null;
  let passwort = null;
  try { passwort = entschluesseln(geheim); } catch (e) { passwort = null; }   // Schlüsseldatei weg: neu einrichten
  if (!passwort) return null;
  return {
    benutzer: benutzer,
    passwort: passwort,
    server: einstellung('postfach_server') || STANDARD_SERVER,
    name: einstellung('postfach_name') || 'Louis Ziegler'
  };
}

// Verständliche Meldungen statt Fachchinesisch des Mailservers
function anmeldeFehler(e) {
  const t = String((e && (e.responseText || e.message)) || '');
  if ((e && e.authenticationFailed) || /AUTHENTICATIONFAILED|invalid credentials|login failed|authentication failed|535/i.test(t)) {
    return 'Mailadresse oder Passwort stimmt nicht';
  }
  if (e && e.code === 'ENOTFOUND') return 'Den Mailserver gibt es unter diesem Namen nicht';
  if (e && /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/.test(String(e.code || '') + t)) return 'Der Mailserver antwortet nicht';
  if (/certificate|self.signed|CERT_/i.test(t + String((e && e.code) || ''))) return 'Das Zertifikat des Mailservers ist nicht gültig';
  return t || 'Verbindung zum Mailserver fehlgeschlagen';
}

function imapOptionen(z) {
  return {
    host: z.server, port: IMAP_PORT, secure: MIT_TLS, doSTARTTLS: MIT_TLS ? undefined : false,
    auth: { user: z.benutzer, pass: z.passwort }, logger: false, emitLogs: false,
    socketTimeout: 60000, greetingTimeout: 15000, connectionTimeout: 15000
  };
}

// ---------------- Eine Verbindung, die zwei Minuten offen bleibt ----------------
let verbindung = null, verbindungBis = 0, verbindet = null;
async function imap() {
  if (!ImapFlow) throw fehler(PAKETE_FEHLEN, 500);
  const z = zugang();
  if (!z) throw fehler('Das Postfach ist noch nicht eingerichtet', 409);
  if (verbindung && verbindung.usable) { verbindungBis = Date.now() + 120000; return verbindung; }
  if (verbindet) return verbindet;
  verbindet = (async function () {
    const c = new ImapFlow(imapOptionen(z));
    c.on('error', function () { if (verbindung === c) verbindung = null; });
    c.on('close', function () { if (verbindung === c) verbindung = null; });
    try { await c.connect(); }
    catch (e) { throw fehler(anmeldeFehler(e), 502); }
    verbindung = c; verbindungBis = Date.now() + 120000;
    return c;
  })();
  try { return await verbindet; } finally { verbindet = null; }
}
function trennen() {
  const c = verbindung; verbindung = null; ordnerCache = null;
  if (c) c.logout().catch(function () { /* egal */ });
}
setInterval(function () { if (verbindung && Date.now() > verbindungBis) trennen(); }, 30000).unref();

// Mit gesperrtem Ordner arbeiten (IMAP kennt immer nur einen geöffneten Ordner)
async function imOrdner(ordner, fn) {
  const c = await imap();
  let sperre;
  try { sperre = await c.getMailboxLock(String(ordner)); }
  catch (e) { throw fehler('Den Ordner „' + ordner + '“ gibt es nicht (mehr)', 404); }
  try { return await fn(c); } finally { sperre.release(); }
}

// ---------------- Ordner ----------------
const SPEZIAL = {
  '\\Inbox': ['eingang', 'Posteingang', 0], '\\Drafts': ['entwuerfe', 'Entwürfe', 2], '\\Sent': ['gesendet', 'Gesendet', 1],
  '\\Archive': ['archiv', 'Archiv', 3], '\\Junk': ['spam', 'Spam', 4], '\\Trash': ['papierkorb', 'Papierkorb', 5]
};
// Ohne Kennzeichnung durch den Server: an üblichen Namen erkennen (auch Outlook/Exchange auf Deutsch)
const NAMEN = [
  [/^(sent|sent items|sent messages|gesendet|gesendete elemente|gesendete objekte)$/i, '\\Sent'],
  [/^(trash|deleted|deleted items|deleted messages|papierkorb|gelöschte elemente|gelöschte objekte)$/i, '\\Trash'],
  [/^(drafts|entwürfe|entwurf)$/i, '\\Drafts'],
  [/^(junk|spam|junk-e-mail|junk e-mail|junk email)$/i, '\\Junk'],
  [/^(archive|archiv)$/i, '\\Archive']
];
function artVon(f) {
  if (f.specialUse) return f.specialUse;
  if (String(f.path).toUpperCase() === 'INBOX') return '\\Inbox';
  const treffer = NAMEN.find(function (n) { return n[0].test(f.name); });
  return treffer ? treffer[1] : '';
}

let ordnerCache = null;   // { wann, liste }
async function ordnerListe(mitZahlen) {
  if (!mitZahlen && ordnerCache && Date.now() - ordnerCache.wann < 60000) return ordnerCache.liste;
  const c = await imap();
  const roh = await c.list(mitZahlen ? { statusQuery: { unseen: true, messages: true } } : {});
  const liste = roh.filter(function (f) { return !(f.flags && f.flags.has('\\Noselect')) && !(f.flags && f.flags.has('\\NonExistent')); })
    .map(function (f) {
      const s = SPEZIAL[artVon(f)];
      const trenner = f.delimiter || '/';
      return {
        pfad: f.path, name: s ? s[1] : f.name, spezial: s ? s[0] : '', rang: s ? s[2] : 10,
        ebene: s ? 0 : Math.max(0, String(f.path).split(trenner).length - 1 - (/^INBOX$/i.test(String(f.path).split(trenner)[0]) ? 1 : 0)),
        ungelesen: f.status ? f.status.unseen || 0 : 0, gesamt: f.status ? f.status.messages || 0 : 0
      };
    });
  // Zwei „Gesendet“-Ordner? Nur den ersten als besonders führen
  const gesehen = {};
  liste.forEach(function (f) {
    if (!f.spezial) return;
    if (gesehen[f.spezial]) { f.spezial = ''; f.rang = 10; } else gesehen[f.spezial] = true;
  });
  liste.sort(function (a, b) { return a.rang - b.rang || String(a.pfad).localeCompare(String(b.pfad), 'de'); });
  ordnerCache = { wann: Date.now(), liste: liste };
  return liste;
}
async function spezialOrdner(art) {
  const f = (await ordnerListe(false)).find(function (o) { return o.spezial === art; });
  return f ? f.pfad : null;
}

// ---------------- Hilfen für Mails ----------------
function adressen(liste) {
  return (liste || []).map(function (a) { return { name: a.name || '', adresse: a.address || '' }; }).filter(function (a) { return a.adresse || a.name; });
}
function geparsteAdressen(feld) {
  if (!feld) return [];
  const werte = [].concat(feld).reduce(function (alle, f) { return alle.concat((f && f.value) || []); }, []);
  return adressen(werte);
}
function hatAnhang(s) {
  if (!s) return false;
  if (s.disposition === 'attachment') return true;
  return (s.childNodes || []).some(hatAnhang);
}
function htmlZuText(html) { return require('./anfragen').htmlZuText(html); }   // erst bei Bedarf: anfragen.js braucht google.js

async function mailHolen(c, uid) {
  const m = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
  if (!m || !m.source) throw fehler('Diese Mail gibt es nicht mehr', 404);
  return { m: m, p: await simpleParser(m.source) };
}

// ---------------- Schnittstellen ----------------
app.get('/api/postfach', nurVerwalter, function (req, res) {
  res.json({
    eingerichtet: !!zugang(),
    benutzer: einstellung('postfach_benutzer') || '',
    server: einstellung('postfach_server') || STANDARD_SERVER,
    name: einstellung('postfach_name') || 'Louis Ziegler',
    pakete: !!ImapFlow
  });
});

// Einrichten: erst beim Mailserver anmelden, nur wenn das klappt wird gespeichert
app.put('/api/postfach', nurVerwalter, mitFehler(async function (req, res) {
  const b = req.body || {};
  const benutzer = String(b.benutzer || '').trim();
  const server = String(b.server || STANDARD_SERVER).trim();
  if (!benutzer) throw fehler('Bitte die Mailadresse eintragen', 400);
  if (!/^[a-z0-9.-]+$/i.test(server)) throw fehler('Der Name des Mailservers sieht nicht richtig aus', 400);
  const bisher = zugang();
  const passwort = String(b.passwort || '') || (bisher && bisher.benutzer === benutzer ? bisher.passwort : '');
  if (!passwort) throw fehler('Bitte das Passwort eintragen', 400);
  if (!ImapFlow) throw fehler(PAKETE_FEHLEN, 500);

  const probe = new ImapFlow(imapOptionen({ server: server, benutzer: benutzer, passwort: passwort }));
  probe.on('error', function () { /* wird unten gemeldet */ });
  try { await probe.connect(); await probe.logout(); }
  catch (e) { throw fehler(anmeldeFehler(e), 400); }

  trennen();
  einstellungSetzen('postfach_benutzer', benutzer);
  einstellungSetzen('postfach_passwort', verschluesseln(passwort));
  einstellungSetzen('postfach_server', server);
  if (b.name) einstellungSetzen('postfach_name', String(b.name).trim().slice(0, 80));
  res.json({ ok: true, eingerichtet: true });
}));

app.delete('/api/postfach', nurVerwalter, function (req, res) {
  trennen();
  db.prepare("DELETE FROM einstellungen WHERE schluessel IN ('postfach_passwort', 'postfach_benutzer')").run();
  res.json({ ok: true });
});

app.get('/api/postfach/ordner', nurVerwalter, mitFehler(async function (req, res) {
  res.json(await ordnerListe(true));
}));

// Die neuesten Mails eines Ordners, 50 auf einmal; „vor“ blättert zu älteren
app.get('/api/postfach/mails', nurVerwalter, mitFehler(async function (req, res) {
  const ordner = String(req.query.ordner || 'INBOX');
  const anzahl = Math.max(10, Math.min(100, Number(req.query.anzahl) || 50));
  const vor = Number(req.query.vor) || 0;
  const antwort = await imOrdner(ordner, async function (c) {
    const gesamt = c.mailbox.exists || 0;
    const bis = vor ? Math.min(vor - 1, gesamt) : gesamt;
    if (bis < 1) return { mails: [], gesamt: gesamt, aeltere: 0 };
    const von = Math.max(1, bis - anzahl + 1);
    const mails = [];
    for await (const m of c.fetch(von + ':' + bis, { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true })) {
      const e = m.envelope || {};
      mails.push({
        uid: m.uid, seq: m.seq, betreff: e.subject || '(ohne Betreff)',
        von: adressen(e.from)[0] || null, an: adressen(e.to),
        datum: e.date || m.internalDate || null,
        gelesen: m.flags.has('\\Seen'), markiert: m.flags.has('\\Flagged'), beantwortet: m.flags.has('\\Answered'),
        anhang: hatAnhang(m.bodyStructure)
      });
    }
    mails.sort(function (a, b) { return b.seq - a.seq; });
    return { mails: mails, gesamt: gesamt, aeltere: von > 1 ? von : 0 };
  });
  res.json(antwort);
}));

// Eine Mail lesen — sie gilt danach als gelesen, wie in Outlook
app.get('/api/postfach/mail', nurVerwalter, mitFehler(async function (req, res) {
  const ordner = String(req.query.ordner || 'INBOX');
  const uid = Number(req.query.uid);
  if (!uid) throw fehler('Welche Mail?', 400);
  const antwort = await imOrdner(ordner, async function (c) {
    const g = await mailHolen(c, uid);
    if (!g.m.flags.has('\\Seen')) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    const p = g.p;
    return {
      ordner: ordner, uid: uid, betreff: p.subject || '(ohne Betreff)',
      von: geparsteAdressen(p.from)[0] || null, an: geparsteAdressen(p.to), cc: geparsteAdressen(p.cc),
      antwortAn: geparsteAdressen(p.replyTo), datum: p.date || null,
      text: String(p.text || htmlZuText(p.html || '') || '').slice(0, 100000),
      anhaenge: (p.attachments || []).map(function (a, i) {
        return { nr: i, name: a.filename || 'Anhang ' + (i + 1), typ: a.contentType || '', groesse: a.size || 0, eingebettet: !!a.related };
      }).filter(function (a) { return !a.eingebettet; }),
      markiert: g.m.flags.has('\\Flagged'), beantwortet: g.m.flags.has('\\Answered')
    };
  });
  res.json(antwort);
}));

// Anhang herunterladen — immer als Datei, nie im Browser ausgeführt
app.get('/api/postfach/anhang', nurVerwalter, mitFehler(async function (req, res) {
  const ordner = String(req.query.ordner || 'INBOX');
  const uid = Number(req.query.uid), nr = Number(req.query.nr);
  const a = await imOrdner(ordner, async function (c) {
    const g = await mailHolen(c, uid);
    const x = (g.p.attachments || [])[nr];
    if (!x) throw fehler('Diesen Anhang gibt es nicht', 404);
    return x;
  });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(a.filename || 'anhang'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(a.content);
}));

// Löschen, verschieben, gelesen/ungelesen, markieren
app.post('/api/postfach/aktion', nurVerwalter, mitFehler(async function (req, res) {
  const b = req.body || {};
  const ordner = String(b.ordner || '');
  const uids = [].concat(b.uids || []).map(Number).filter(function (n) { return n > 0; });
  if (!ordner || !uids.length) throw fehler('Angaben fehlen', 400);
  const menge = uids.join(',');
  let endgueltig = false;
  const papierkorb = b.aktion === 'loeschen' ? await spezialOrdner('papierkorb') : null;
  await imOrdner(ordner, async function (c) {
    if (b.aktion === 'gelesen') await c.messageFlagsAdd(menge, ['\\Seen'], { uid: true });
    else if (b.aktion === 'ungelesen') await c.messageFlagsRemove(menge, ['\\Seen'], { uid: true });
    else if (b.aktion === 'markieren') await c.messageFlagsAdd(menge, ['\\Flagged'], { uid: true });
    else if (b.aktion === 'entmarkieren') await c.messageFlagsRemove(menge, ['\\Flagged'], { uid: true });
    else if (b.aktion === 'verschieben') {
      if (!b.ziel || String(b.ziel) === ordner) throw fehler('Wohin verschieben?', 400);
      await c.messageMove(menge, String(b.ziel), { uid: true });
    } else if (b.aktion === 'loeschen') {
      // In den Papierkorb wie in Outlook; erst dort gelöscht ist endgültig weg
      if (papierkorb && papierkorb !== ordner) await c.messageMove(menge, papierkorb, { uid: true });
      else { await c.messageDelete(menge, { uid: true }); endgueltig = true; }
    } else throw fehler('Unbekannte Aktion', 400);
  });
  res.json({ ok: true, endgueltig: endgueltig });
}));

// Schreiben, antworten, weiterleiten — als louis.ziegler@mzer.de, Kopie landet in „Gesendet“
app.post('/api/postfach/senden', nurVerwalter, mitFehler(async function (req, res) {
  if (!nodemailer) throw fehler(PAKETE_FEHLEN, 500);
  const z = zugang();
  if (!z) throw fehler('Das Postfach ist noch nicht eingerichtet', 409);
  const b = req.body || {};
  const an = String(b.an || '').trim();
  if (!an) throw fehler('Bitte einen Empfänger eintragen', 400);
  const domain = (z.benutzer.split('@')[1] || 'localhost').toLowerCase();
  const nachricht = {
    from: { name: z.name, address: z.benutzer },
    to: an, cc: String(b.cc || '').trim() || undefined, bcc: String(b.bcc || '').trim() || undefined,
    subject: String(b.betreff || '').slice(0, 500), text: String(b.text || ''),
    messageId: '<' + crypto.randomUUID() + '@' + domain + '>', date: new Date()
  };

  // Antwort oder Weiterleitung: Bezug zur Originalmail herstellen
  let bezug = null;
  if (b.bezug && b.bezug.ordner && Number(b.bezug.uid)) {
    bezug = { ordner: String(b.bezug.ordner), uid: Number(b.bezug.uid) };
    const p = (await imOrdner(bezug.ordner, function (c) { return mailHolen(c, bezug.uid); })).p;
    if (b.art === 'weiter') {
      nachricht.attachments = (p.attachments || []).filter(function (a) { return !a.related; })
        .map(function (a) { return { filename: a.filename, content: a.content, contentType: a.contentType }; });
    } else {
      if (p.messageId) nachricht.inReplyTo = p.messageId;
      nachricht.references = [].concat(p.references || [], p.messageId ? [p.messageId] : []);
    }
  }

  const transport = nodemailer.createTransport({
    host: z.server, port: SMTP_PORT, secure: MIT_TLS && SMTP_PORT === 465, ignoreTLS: !MIT_TLS,
    auth: { user: z.benutzer, pass: z.passwort }, connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 60000
  });
  try { await transport.sendMail(nachricht); }
  catch (e) { throw fehler('Senden fehlgeschlagen: ' + anmeldeFehler(e), 502); }

  // Kopie in „Gesendet“ ablegen, damit sie auch in Outlook dort steht
  let abgelegt = false;
  try {
    const roh = await new Promise(function (ok, nein) {
      new MailComposer(nachricht).compile().build(function (f, m) { if (f) nein(f); else ok(m); });
    });
    const gesendet = await spezialOrdner('gesendet');
    if (gesendet) { await (await imap()).append(gesendet, roh, ['\\Seen']); abgelegt = true; }
  } catch (e) { console.log('Postfach: Kopie in „Gesendet“ fehlgeschlagen:', e.message); }

  if (bezug && b.art !== 'weiter') {
    try { await imOrdner(bezug.ordner, function (c) { return c.messageFlagsAdd(String(bezug.uid), ['\\Answered'], { uid: true }); }); }
    catch (e) { /* nicht schlimm */ }
  }
  res.json({ ok: true, abgelegt: abgelegt });
}));

module.exports = { router: app, verschluesseln, entschluesseln };
