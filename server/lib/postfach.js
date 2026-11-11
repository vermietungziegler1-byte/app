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
const { crypto, path, fs, DATENORDNER, db, einstellung, einstellungSetzen, mitFehler, standInhalt } = require('./kern');
const { nurAngemeldet, nurVerwalter } = require('./anmeldung');
const { signaturAus, umlautVarianten, einfacheKriterien } = require('./postfach-text');

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
const { verschluesseln, entschluesseln } = require('./geheim');

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

// ---------------- Suchverzeichnis aktuell halten ----------------
// Eigene Verbindung zum Mailserver, damit das Einlesen nie ein Klick in der App aufhält. Beim ersten Mal werden alle
// Mails (außer Spam) eingelesen, neueste zuerst — je Mail nur die ersten 64 KB, also Text ohne Anhänge. Danach alle
// drei Minuten: neue Mails dazu, gelöschte raus, gelesen/markiert nachziehen.
const indexMod = require('./postfach-index');
const { ohneZitat } = require('./postfach-text');
let ix = null;
function index() { if (!ix) ix = indexMod.oeffnen(path.join(DATENORDNER, 'mailindex.db')); return ix; }
function indexAnzahl() { try { return indexMod.anzahl(index()); } catch (e) { return 0; } }
const indexStand = { laeuft: false, gesamt: 0, eingelesen: 0, zuletzt: 0, fehler: null };
function indexInfo() {
  return { eingelesen: indexStand.laeuft ? indexStand.eingelesen : indexAnzahl(), gesamt: indexStand.gesamt || indexAnzahl(),
    laeuft: indexStand.laeuft, fertig: !indexStand.laeuft && indexStand.zuletzt > 0 && !indexStand.fehler, fehler: indexStand.fehler };
}
function anhangNamen(s, liste) {
  liste = liste || [];
  if (!s) return liste;
  const name = (s.dispositionParameters && s.dispositionParameters.filename) || (s.parameters && s.parameters.name);
  if (name && (s.disposition === 'attachment' || s.disposition === 'inline' || !/^text\//.test(s.type || ''))) liste.push(name);
  (s.childNodes || []).forEach(function (k) { anhangNamen(k, liste); });
  return liste;
}
const RANG_INDEX = { '\\Inbox': 0, '\\Sent': 1, '\\Archive': 2 };

async function indexAbgleich() {
  if (indexStand.laeuft || !ImapFlow || !simpleParser) return;
  const z = zugang();
  if (!z) return;
  indexStand.laeuft = true; indexStand.fehler = null;
  const c = new ImapFlow(imapOptionen(z));
  c.on('error', function () { /* steht unten in fehler */ });
  try {
    await c.connect();
    const ordner = (await c.list())
      .filter(function (f) { return !(f.flags && (f.flags.has('\\Noselect') || f.flags.has('\\NonExistent'))) && artVon(f) !== '\\Junk'; })
      .sort(function (a, b) { return (RANG_INDEX[artVon(a)] != null ? RANG_INDEX[artVon(a)] : 9) - (RANG_INDEX[artVon(b)] != null ? RANG_INDEX[artVon(b)] : 9); });
    indexMod.ordnerAufraeumen(index(), ordner.map(function (f) { return f.path; }));

    // 1. Je Ordner abgleichen: was ist neu, was ist weg, was hat sich an gelesen/markiert geändert
    const plan = [];
    let gesamt = 0, fehlend = 0;
    for (const f of ordner) {
      const sperre = await c.getMailboxLock(f.path, { readOnly: true });
      try {
        const uv = String(c.mailbox.uidValidity);
        if (indexMod.uidValidity(index(), f.path) !== uv) { indexMod.ordnerLeeren(index(), f.path); indexMod.uidValiditySetzen(index(), f.path, uv); }
        const server = new Map();
        if (c.mailbox.exists) {
          for await (const m of c.fetch('1:*', { uid: true, flags: true })) server.set(m.uid, m.flags);
        }
        const bekannt = indexMod.bekannte(index(), f.path);
        const weg = [], merker = [], neu = [];
        bekannt.forEach(function (b, uid) { if (!server.has(uid)) weg.push(uid); });
        server.forEach(function (fl, uid) {
          const b = bekannt.get(uid);
          const g = fl.has('\\Seen') ? 1 : 0, mk = fl.has('\\Flagged') ? 1 : 0, be = fl.has('\\Answered') ? 1 : 0;
          if (!b) neu.push(uid);
          else if (b.gelesen !== g || b.markiert !== mk || b.beantwortet !== be) merker.push({ uid: uid, gelesen: g, markiert: mk, beantwortet: be });
        });
        if (weg.length) indexMod.entfernen(index(), f.path, weg);
        if (merker.length) indexMod.merkerSetzen(index(), f.path, merker);
        gesamt += server.size; fehlend += neu.length;
        if (neu.length) plan.push({ pfad: f.path, neu: neu.sort(function (a, b) { return b - a; }) });
      } finally { sperre.release(); }
    }
    indexStand.gesamt = gesamt;
    indexStand.eingelesen = gesamt - fehlend;

    // 2. Neue Mails einlesen, neueste zuerst, je 20 auf einmal
    for (const p of plan) {
      const sperre = await c.getMailboxLock(p.pfad, { readOnly: true });
      try {
        for (let i = 0; i < p.neu.length; i += 20) {
          if (!zugang()) return;   // inzwischen getrennt
          const stueck = p.neu.slice(i, i + 20);
          const geholt = [];
          for await (const m of c.fetch(stueck.join(','), { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, source: { start: 0, maxLength: 65536 } }, { uid: true })) {
            geholt.push(m);
          }
          for (const m of geholt) {
            let text = '';
            try { const geparst = await simpleParser(m.source || ''); text = String(geparst.text || htmlZuText(geparst.html || '')); }
            catch (e) { text = ''; }
            const e = m.envelope || {};
            const von = adressen(e.from)[0] || { name: '', adresse: '' };
            const namen = anhangNamen(m.bodyStructure);
            indexMod.eintragen(index(), {
              ordner: p.pfad, uid: m.uid, datum: new Date(e.date || m.internalDate || 0).getTime() || 0,
              vonName: von.name, vonAdresse: von.adresse,
              an: adressen(e.to).concat(adressen(e.cc)).map(function (a) { return a.name ? a.name + ' <' + a.adresse + '>' : a.adresse; }).join('; '),
              betreff: e.subject || '', anhang: hatAnhang(m.bodyStructure), anhaenge: namen.join(' '),
              gelesen: m.flags && m.flags.has('\\Seen'), markiert: m.flags && m.flags.has('\\Flagged'), beantwortet: m.flags && m.flags.has('\\Answered'),
              text: ohneZitat(text).slice(0, 12000)
            });
            indexStand.eingelesen++;
          }
          await new Promise(function (r) { setTimeout(r, 25); });   // dem Mailserver Luft lassen
        }
      } finally { sperre.release(); }
    }
  } catch (e) {
    indexStand.fehler = anmeldeFehler(e);
  } finally {
    indexStand.laeuft = false; indexStand.zuletzt = Date.now();
    c.logout().catch(function () { /* egal */ });
  }
}
setTimeout(function () { indexAbgleich().catch(function () { /* nächster Lauf */ }); }, 20000).unref();
setInterval(function () { indexAbgleich().catch(function () { /* nächster Lauf */ }); }, 3 * 60 * 1000).unref();

// ---------------- Schnittstellen ----------------
app.get('/api/postfach/index', nurAngemeldet, nurVerwalter, function (req, res) { res.json(indexInfo()); });

app.get('/api/postfach', nurAngemeldet, nurVerwalter, function (req, res) {
  res.json({
    eingerichtet: !!zugang(),
    benutzer: einstellung('postfach_benutzer') || '',
    server: einstellung('postfach_server') || STANDARD_SERVER,
    name: einstellung('postfach_name') || 'Louis Ziegler',
    pakete: !!ImapFlow
  });
});

// Einrichten: erst beim Mailserver anmelden, nur wenn das klappt wird gespeichert
app.put('/api/postfach', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
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
  setTimeout(function () { indexAbgleich().catch(function () { /* nächster Lauf */ }); }, 2000).unref();   // Suchverzeichnis gleich aufbauen
  res.json({ ok: true, eingerichtet: true });
}));

app.delete('/api/postfach', nurAngemeldet, nurVerwalter, function (req, res) {
  trennen();
  db.prepare("DELETE FROM einstellungen WHERE schluessel IN ('postfach_passwort', 'postfach_benutzer')").run();
  try { indexMod.alleLeeren(index()); } catch (e) { /* kein Verzeichnis da */ }   // mit dem Konto geht auch das Suchverzeichnis
  res.json({ ok: true });
});

app.get('/api/postfach/ordner', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
  res.json(await ordnerListe(true));
}));

// Die neuesten Mails eines Ordners, 50 auf einmal; „vor“ blättert zu älteren
app.get('/api/postfach/mails', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
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
app.get('/api/postfach/mail', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
  const ordner = String(req.query.ordner || 'INBOX');
  const uid = Number(req.query.uid);
  if (!uid) throw fehler('Welche Mail?', 400);
  const antwort = await imOrdner(ordner, async function (c) {
    const g = await mailHolen(c, uid);
    if (!g.m.flags.has('\\Seen')) {
      await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      try { indexMod.merkerAendern(index(), ordner, [uid], 'gelesen', true); } catch (e) { /* egal */ }
    }
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
app.get('/api/postfach/anhang', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
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
app.post('/api/postfach/aktion', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
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
  // Suchverzeichnis gleich nachziehen; verschobene Mails tauchen beim nächsten Abgleich im Zielordner auf
  try {
    if (b.aktion === 'loeschen' || b.aktion === 'verschieben') indexMod.entfernen(index(), ordner, uids);
    else if (b.aktion === 'gelesen' || b.aktion === 'ungelesen') indexMod.merkerAendern(index(), ordner, uids, 'gelesen', b.aktion === 'gelesen');
    else if (b.aktion === 'markieren' || b.aktion === 'entmarkieren') indexMod.merkerAendern(index(), ordner, uids, 'markiert', b.aktion === 'markieren');
  } catch (e) { /* das Verzeichnis holt es beim nächsten Abgleich nach */ }
  res.json({ ok: true, endgueltig: endgueltig });
}));

// ---------------- Postausgang ----------------
// Erst der eingestellte Weg (465, TLS von Anfang an), bei Verbindungsfehlern 587 mit STARTTLS — manche Anbieter
// und manche Netze lassen nur einen der beiden durch. Ein abgelehntes Passwort wird nicht noch einmal probiert
// Der Weg, der zuletzt funktioniert hat, kommt zuerst — sonst wartete jeder Versand erst 20 s auf den blockierten Port
// (auf dem Server ist 465 zum Mailserver dicht, 587 geht). Gemerkt in den Einstellungen, überlebt also den Neustart
function smtpWege(z) {
  const wege = [{ port: SMTP_PORT, secure: MIT_TLS && SMTP_PORT === 465 }];
  if (MIT_TLS && SMTP_PORT === 465) wege.push({ port: 587, secure: false });
  const bewaehrt = Number(einstellung('postfach_smtp_port')) || 0;
  wege.sort(function (a, b) { return (b.port === bewaehrt) - (a.port === bewaehrt); });
  return wege.map(function (w) {
    return {
      host: z.server, port: w.port, secure: w.secure, requireTLS: MIT_TLS && !w.secure, ignoreTLS: !MIT_TLS,
      auth: { user: z.benutzer, pass: z.passwort }, connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 60000
    };
  });
}
function verbindungsfehler(e) {
  return /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ESOCKET|ETIMEOUT|Greeting never received|Connection timeout/i
    .test(String((e && e.code) || '') + ' ' + String((e && e.message) || ''));
}
function smtpPortMerken(port) {
  if (String(einstellung('postfach_smtp_port') || '') !== String(port)) einstellungSetzen('postfach_smtp_port', String(port));
}
async function smtpSenden(z, nachricht) {
  let letzter = null;
  for (const o of smtpWege(z)) {
    try {
      const ergebnis = await nodemailer.createTransport(o).sendMail(nachricht);
      smtpPortMerken(o.port);
      return ergebnis;
    }
    catch (e) {
      e.port = o.port;
      letzter = e;
      if (!verbindungsfehler(e)) break;
    }
  }
  throw letzter;
}

// Verbindung prüfen: Posteingang (IMAP) und jeder Weg zum Postausgang (SMTP) einzeln, mit dem Fehler im Wortlaut —
// wenn das Senden nur „antwortet nicht“ sagt, steht hier, welcher Weg klemmt
app.get('/api/postfach/pruefen', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
  if (!ImapFlow || !nodemailer) throw fehler(PAKETE_FEHLEN, 500);
  const z = zugang();
  if (!z) throw fehler('Das Postfach ist noch nicht eingerichtet', 409);
  const ergebnis = { server: z.server, benutzer: z.benutzer, eingang: null, ausgang: [] };
  const t0 = Date.now();
  const c = new ImapFlow(imapOptionen(z));
  c.on('error', function () { /* steht im Ergebnis */ });
  try { await c.connect(); await c.logout().catch(function () { /* egal */ }); ergebnis.eingang = { port: IMAP_PORT, ok: true, ms: Date.now() - t0 }; }
  catch (e) { ergebnis.eingang = { port: IMAP_PORT, ok: false, fehler: anmeldeFehler(e), code: String(e.code || ''), ms: Date.now() - t0 }; }
  for (const o of smtpWege(z)) {
    const t1 = Date.now();
    try {
      await nodemailer.createTransport(o).verify();
      ergebnis.ausgang.push({ port: o.port, ok: true, ms: Date.now() - t1 });
      // Der erste Weg, der geht, ist ab jetzt der erste Versuch beim Senden
      if (!ergebnis.ausgang.some(function (x) { return x.ok && x.port !== o.port; })) smtpPortMerken(o.port);
    }
    catch (e) { ergebnis.ausgang.push({ port: o.port, ok: false, fehler: anmeldeFehler(e), code: String(e.code || ''), ms: Date.now() - t1 }); }
  }
  res.json(ergebnis);
}));

// Schreiben, antworten, weiterleiten — als louis.ziegler@mzer.de, Kopie landet in „Gesendet“
app.post('/api/postfach/senden', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
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
    const holen = function () { return imOrdner(bezug.ordner, function (c) { return mailHolen(c, bezug.uid); }); };
    let p;
    try { p = (await holen()).p; }
    catch (e) {
      if (e.status === 404) throw e;
      // Die seit Minuten gehaltene Verbindung war wohl tot — einmal frisch verbinden, dann erst aufgeben,
      // und dann so, dass klar ist: der Posteingang klemmt, nicht der Versand
      trennen();
      try { p = (await holen()).p; }
      catch (e2) { throw fehler('Die Originalmail ließ sich nicht aus dem Posteingang holen (' + z.server + '): ' + (e2.status ? e2.message : anmeldeFehler(e2)), 502); }
    }
    if (b.art === 'weiter') {
      nachricht.attachments = (p.attachments || []).filter(function (a) { return !a.related; })
        .map(function (a) { return { filename: a.filename, content: a.content, contentType: a.contentType }; });
    } else {
      if (p.messageId) nachricht.inReplyTo = p.messageId;
      nachricht.references = [].concat(p.references || [], p.messageId ? [p.messageId] : []);
    }
  }

  try { await smtpSenden(z, nachricht); }
  catch (e) {
    // Mit Server, Port und Fehlercode — „antwortet nicht“ allein hilft bei der Suche nicht weiter
    throw fehler('Senden fehlgeschlagen: ' + anmeldeFehler(e) + ' (Postausgang ' + z.server + ', Port ' + (e.port || SMTP_PORT)
      + (e.code ? ', ' + e.code : '') + ')', 502);
  }

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
    try {
      await imOrdner(bezug.ordner, function (c) { return c.messageFlagsAdd(String(bezug.uid), ['\\Answered'], { uid: true }); });
      indexMod.merkerAendern(index(), bezug.ordner, [bezug.uid], 'beantwortet', true);
    } catch (e) { /* nicht schlimm */ }
  }
  res.json({ ok: true, abgelegt: abgelegt });
}));

// ---------------- Signatur ----------------
// Steht unter jeder neuen Mail, Antwort und Weiterleitung. Ist noch keine hinterlegt, wird sie einmal aus den zuletzt
// gesendeten Mails gelesen: der Block ab dem letzten Gruß vor dem Zitat, so wie Outlook ihn anhängt.
async function signaturVorschlag() {
  const gesendet = await spezialOrdner('gesendet');
  if (!gesendet) return '';
  const texte = await imOrdner(gesendet, async function (c) {
    const gesamt = c.mailbox.exists || 0;
    if (!gesamt) return [];
    const uids = [];
    for await (const m of c.fetch(Math.max(1, gesamt - 7) + ':' + gesamt, { uid: true })) uids.push(m.uid);
    const liste = [];
    for (const uid of uids.reverse()) {
      try { const g = await mailHolen(c, uid); liste.push(String(g.p.text || htmlZuText(g.p.html || ''))); } catch (e) { /* nächste */ }
    }
    return liste;
  });
  // Der Block, der in den meisten der letzten Mails steht
  const zaehler = {};
  texte.map(signaturAus).filter(Boolean).forEach(function (s) { zaehler[s] = (zaehler[s] || 0) + 1; });
  return Object.keys(zaehler).sort(function (a, b) { return zaehler[b] - zaehler[a]; })[0] || '';
}

// Mehrere Signaturen mit Namen („Vermietung“, „Kurz“ …); eine ist der Standard und steht unter jeder Mail aus der App,
// im Schreibfenster lässt sich umschalten. Gespeichert als Liste in den Einstellungen; die alte Einzelsignatur
// (postfach_signatur) wird beim ersten Lesen übernommen und für ältere Oberflächen weiter mitgeschrieben
function signaturenLesen() {
  let liste = null;
  try { liste = JSON.parse(einstellung('postfach_signaturen') || 'null'); } catch (e) { liste = null; }
  if (!Array.isArray(liste)) {
    const alt = einstellung('postfach_signatur');
    liste = alt ? [{ id: 's1', name: 'Standard', text: alt }] : [];
  }
  liste = liste.filter(function (s) { return s && typeof s === 'object' && s.id; }).map(function (s) {
    return { id: String(s.id).slice(0, 40), name: String(s.name || '').slice(0, 80), text: String(s.text || '').slice(0, 3000) };
  });
  let standard = einstellung('postfach_signatur_standard') || '';
  if (!liste.some(function (s) { return s.id === standard; })) standard = liste.length ? liste[0].id : '';
  return { signaturen: liste, standard: standard };
}
function signaturenSchreiben(liste, standard) {
  einstellungSetzen('postfach_signaturen', JSON.stringify(liste));
  einstellungSetzen('postfach_signatur_standard', standard || '');
  const s = liste.find(function (x) { return x.id === standard; });
  einstellungSetzen('postfach_signatur', s ? s.text : '');
}
function standardSignatur() {
  const s = signaturenLesen();
  const t = s.signaturen.find(function (x) { return x.id === s.standard; });
  return t ? t.text : '';
}

app.get('/api/postfach/signaturen', nurAngemeldet, nurVerwalter, function (req, res) { res.json(signaturenLesen()); });

app.put('/api/postfach/signaturen', nurAngemeldet, nurVerwalter, function (req, res) {
  const b = req.body || {};
  if (!Array.isArray(b.signaturen)) return res.status(400).json({ fehler: 'Signaturen müssen eine Liste sein' });
  if (b.signaturen.length > 20) return res.status(400).json({ fehler: 'Höchstens 20 Signaturen' });
  const gesehen = {};
  const liste = [];
  for (const s of b.signaturen) {
    if (!s || typeof s !== 'object') return res.status(400).json({ fehler: 'Eine Signatur ist kein Eintrag' });
    const name = String(s.name || '').trim().slice(0, 80);
    const text = String(s.text || '').replace(/\r/g, '').trim().slice(0, 3000);
    if (!name) return res.status(400).json({ fehler: 'Jede Signatur braucht einen Namen' });
    let id = String(s.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || ('s' + crypto.randomUUID().slice(0, 8));
    while (gesehen[id]) id += 'x';
    gesehen[id] = true;
    liste.push({ id: id, name: name, text: text });
  }
  let standard = String(b.standard || '');
  if (!liste.some(function (s) { return s.id === standard; })) standard = liste.length ? liste[0].id : '';
  signaturenSchreiben(liste, standard);
  res.json(signaturenLesen());
});

// Die Standard-Signatur allein (ältere Oberflächen); ohne eine hinterlegte wird einmal aus den gesendeten Mails gelesen
app.get('/api/postfach/signatur', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
  const neu = req.query.neu === '1';
  const s = signaturenLesen();
  if (s.signaturen.length && !neu) return res.json({ signatur: standardSignatur() });
  let vorschlag = '';
  try { vorschlag = await signaturVorschlag(); } catch (e) { vorschlag = ''; }
  // Beim ersten Mal gleich als Standard übernehmen — auf der Seite „Signaturen“ lässt sie sich ändern
  if (!s.signaturen.length && !neu && vorschlag) signaturenSchreiben([{ id: 's1', name: 'Standard', text: vorschlag }], 's1');
  res.json({ signatur: vorschlag, vorschlag: true });
}));

app.put('/api/postfach/signatur', nurAngemeldet, nurVerwalter, function (req, res) {
  const t = String((req.body || {}).signatur || '').replace(/\r/g, '').slice(0, 3000);
  const s = signaturenLesen();
  const liste = s.signaturen.slice();
  const i = liste.findIndex(function (x) { return x.id === s.standard; });
  if (i === -1) liste.push({ id: 's1', name: 'Standard', text: t }); else liste[i] = { id: liste[i].id, name: liste[i].name, text: t };
  signaturenSchreiben(liste, i === -1 ? 's1' : s.standard);
  res.json({ signatur: t });
});

// ---------------- Suche, die mitdenkt ----------------
// Claude übersetzt die Suchanfrage in Kriterien — Synonyme und Schreibweisen, Absender (auch über die Namen der
// Mieter), Zeitraum, Anhänge, Ordner. Der Mailserver sucht dann in allen Ordnern außer Papierkorb und Spam.
// Ohne Assistent (oder wenn er gerade nicht kann) wird nach den einzelnen Wörtern gesucht, mit ä/ae-Schreibweisen.
const SUCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    begriffe: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    absender: { type: 'array', items: { type: 'string' } },
    empfaenger: { type: 'array', items: { type: 'string' } },
    seit: { type: 'string' },
    bis: { type: 'string' },
    nurAnhang: { type: 'boolean' },
    ordner: { type: 'string', enum: ['alle', 'eingang', 'gesendet', 'papierkorb'] },
    erklaerung: { type: 'string' }
  },
  required: ['begriffe', 'absender', 'empfaenger', 'seit', 'bis', 'nurAnhang', 'ordner', 'erklaerung']
};

// Mieter, Interessenten und Objekte aus dem Datenstand — damit „Mail von der Mieterin im EG“ einen Namen bekommt
function bekannte() {
  const s = standInhalt() || {};
  const personen = [];
  (s.objects || []).forEach(function (o) {
    (o.units || []).forEach(function (x) {
      if (x.tenant) personen.push({ name: String(x.tenant), wo: (x.name || '') + ', ' + String(o.name || '').split(',')[0], kontakt: String(x.contact || '') });
    });
  });
  (s.interessenten || []).forEach(function (i) { if (i.name) personen.push({ name: String(i.name), wo: 'Interessent', kontakt: String(i.kontakt || '') }); });
  return { objekte: (s.objects || []).map(function (o) { return String(o.name || ''); }).filter(Boolean), personen: personen };
}

async function kriterienVonClaude(q, b) {
  const { claude } = require('./assistent');
  const heute = new Date();
  const system = 'Du hilfst Louis Ziegler, einem privaten Vermieter, in seinem E-Mail-Postfach zu suchen. Übersetze seine Suchanfrage '
    + 'in Suchkriterien für einen Mailserver, der nur nach Teilwörtern sucht (Groß- und Kleinschreibung egal).\n'
    + '- begriffe: Gruppen von Wörtern. Jede Gruppe muss in der Mail vorkommen (Betreff, Absender oder Text). In einer Gruppe stehen '
    + 'gleichwertige Schreibweisen und naheliegende Synonyme, z. B. ["Rechnung", "Abrechnung", "Invoice"] oder ["Heizung", "Therme", "Heizkörper"]. '
    + 'Nimm Wortstämme ("Rechnung" findet auch "Rechnungen"). Höchstens 3 Gruppen mit je höchstens 5 Wörtern. Füllwörter, Zeitangaben '
    + 'und Absendernamen gehören nicht hierher. Steht nur ein Name in der Anfrage, bleibt begriffe leer.\n'
    + '- absender / empfaenger: Namen, Firmen oder Adressen; leer, wenn nicht gemeint. Passt die Anfrage auf eine der bekannten Personen '
    + 'unten (z. B. "Mieterin im EG der Bertha"), nimm deren Namen.\n'
    + '- seit / bis: Datum JJJJ-MM-TT, wenn ein Zeitraum gemeint ist ("letzte Woche", "im Oktober", "seit dem Sommer"), sonst leer. '
    + 'Heute ist ' + heute.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' })
    + ' (' + heute.toISOString().slice(0, 10) + ').\n'
    + '- nurAnhang: true, wenn nach Anhängen, PDFs, Dateien oder Fotos gefragt ist.\n'
    + '- ordner: "gesendet" für Mails, die Louis selbst geschrieben hat ("meine Mail an …", "was ich … geschickt habe"), '
    + '"eingang" für "neue Mails", "papierkorb" für gelöschte Mails, sonst "alle".\n'
    + '- erklaerung: ein kurzer deutscher Satz, wonach jetzt gesucht wird.\n\n'
    + 'Objekte: ' + (b.objekte.join(' | ') || '—') + '\n'
    + 'Bekannte Personen: ' + (b.personen.slice(0, 120).map(function (p) { return p.name + ' (' + p.wo + ')'; }).join('; ') || '—');
  // Fürs Suchen zählt Tempo: erst das schnelle Modell, bei Problemen das große mit wenig Nachdenken
  const versuche = [
    { model: 'claude-haiku-5-5', output_config: { format: { type: 'json_schema', schema: SUCH_SCHEMA } } },
    { model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema', schema: SUCH_SCHEMA } } }
  ];
  let letzter = null;
  for (const v of versuche) {
    try {
      const antwort = await claude(Object.assign({ max_tokens: 2000, system: system, messages: [{ role: 'user', content: String(q).slice(0, 300) }] }, v), null, 20000);
      const block = (antwort.content || []).find(function (x) { return x.type === 'text'; });
      return JSON.parse(block.text);
    } catch (e) {
      letzter = e;
      if (e.status && e.status !== 400 && e.status !== 404) throw e;   // Schlüssel, Guthaben, Auslastung: das zweite Modell hilft nicht
    }
  }
  throw letzter;
}

function oder(liste) { return liste.length === 1 ? liste[0] : { or: liste }; }

// Ordnernamen für die Treffer aus dem Verzeichnis
async function mitOrdnernamen(r) {
  const liste = await ordnerListe(false).catch(function () { return []; });
  const name = function (pfad) { const o = liste.find(function (x) { return x.pfad === pfad; }); return o ? o.name : pfad; };
  r.top.forEach(function (m) { m.ordnerName = name(m.ordner); });
  r.mails.forEach(function (m) { m.ordnerName = name(m.ordner); });
  return r;
}
async function ordnerFuer(art) {
  const liste = await ordnerListe(false);
  const pfade = function (sp) { return liste.filter(function (o) { return o.spezial === sp; }).map(function (o) { return o.pfad; }); };
  if (art === 'eingang' || art === 'gesendet' || art === 'papierkorb') return { nurOrdner: pfade(art) };
  return { ohneOrdner: pfade('papierkorb').concat(pfade('spam')) };
}

app.get('/api/postfach/suche', nurAngemeldet, nurVerwalter, mitFehler(async function (req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw fehler('Bitte mindestens zwei Zeichen eingeben', 400);
  const imVerzeichnis = indexAnzahl() > 0;

  // Beim Tippen: sofort aus dem Verzeichnis, ohne Assistent
  if (req.query.schnell === '1') {
    if (!imVerzeichnis) return res.json({ q: q, schnell: true, top: [], mails: [], gesamt: 0, index: indexInfo() });
    const r = indexMod.suchen(index(), Object.assign({ gruppen: einfacheKriterien(q).begriffe }, await ordnerFuer('alle')));
    await mitOrdnernamen(r);
    return res.json({ q: q, schnell: true, top: r.top, mails: r.mails, gesamt: r.gesamt, mehr: r.mehr, index: indexInfo() });
  }

  const b = bekannte();
  let k = null, schlau = false;
  if (req.query.schlau !== '0' && einstellung('anthropic_token')) {
    try { k = await kriterienVonClaude(q, b); schlau = true; } catch (e) { k = null; }
  }
  if (!k) k = einfacheKriterien(q);

  // Gruppen säubern, ä/ae ergänzen; Absender um die Adressen bekannter Personen erweitern
  const gruppen = (k.begriffe || []).map(function (g) {
    const v = [];
    (g || []).slice(0, 6).forEach(function (w) { umlautVarianten(w).forEach(function (x) { if (x.length >= 2 && v.indexOf(x) === -1) v.push(x); }); });
    return v;
  }).filter(function (g) { return g.length; }).slice(0, 4);
  const absender = [];
  (k.absender || []).forEach(function (a) {
    umlautVarianten(a).forEach(function (x) { if (absender.indexOf(x) === -1) absender.push(x); });
    b.personen.forEach(function (p) {
      if (p.name.toLowerCase().indexOf(String(a).toLowerCase()) === -1) return;
      const adr = (p.kontakt.match(/[^\s<>,;"]+@[^\s<>,;"]+/) || [])[0];
      if (adr && absender.indexOf(adr) === -1) absender.push(adr);
    });
  });
  const empfaenger = (k.empfaenger || []).filter(Boolean).slice(0, 6);
  const erklaerung = k.erklaerung || ('Mails ' + [
    gruppen.length ? 'mit ' + gruppen.map(function (g) { return '„' + g[0] + '“'; }).join(' und ') : '',
    absender.length ? 'von ' + absender[0] : ''
  ].filter(Boolean).join(', '));
  const nurZeit = /^\d{4}-\d{2}-\d{2}$/.test(k.seit || '') || /^\d{4}-\d{2}-\d{2}$/.test(k.bis || '');
  if (!gruppen.length && !absender.length && !empfaenger.length && !(imVerzeichnis && (nurZeit || k.nurAnhang))) {
    return res.json({ q: q, erklaerung: k.erklaerung || '', schlau: schlau, top: [], mails: [], gesamt: 0, index: indexInfo() });
  }

  // Steht das Suchverzeichnis, wird dort gesucht — in Millisekunden, über alle Jahre und auch im Mailtext
  if (imVerzeichnis) {
    const seit = /^\d{4}-\d{2}-\d{2}$/.test(k.seit || '') ? new Date(k.seit + 'T00:00:00').getTime() : 0;
    let bis = 0;
    if (/^\d{4}-\d{2}-\d{2}$/.test(k.bis || '')) { const d = new Date(k.bis + 'T00:00:00'); d.setDate(d.getDate() + 1); bis = d.getTime(); }
    const r = indexMod.suchen(index(), Object.assign({
      gruppen: gruppen, absender: absender, empfaenger: empfaenger, seit: seit, bis: bis, nurAnhang: !!k.nurAnhang
    }, await ordnerFuer(k.ordner)));
    await mitOrdnernamen(r);
    return res.json({ q: q, schlau: schlau, top: r.top, mails: r.mails, gesamt: r.gesamt, mehr: r.mehr, index: indexInfo(), erklaerung: erklaerung });
  }

  // Ordner: alle außer Papierkorb, Spam und Entwürfe — oder nur Eingang bzw. Gesendet. Die großen zuerst,
  // damit bei Zeitnot wenigstens Posteingang, Gesendet und Archiv durchsucht sind
  const RANG = { eingang: 0, gesendet: 1, archiv: 2 };
  const ordner = (await ordnerListe(false)).filter(function (o) {
    if (k.ordner === 'eingang') return o.spezial === 'eingang';
    if (k.ordner === 'gesendet') return o.spezial === 'gesendet';
    if (k.ordner === 'papierkorb') return o.spezial === 'papierkorb';
    return ['papierkorb', 'spam', 'entwuerfe'].indexOf(o.spezial) === -1;
  }).sort(function (a, b2) { return (RANG[a.spezial] != null ? RANG[a.spezial] : 9) - (RANG[b2.spezial] != null ? RANG[b2.spezial] : 9); });
  const zeit = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(k.seit || '')) zeit.since = new Date(k.seit + 'T00:00:00');
  if (/^\d{4}-\d{2}-\d{2}$/.test(k.bis || '')) { const d = new Date(k.bis + 'T00:00:00'); d.setDate(d.getDate() + 1); zeit.before = d; }
  // Der Mailserver hat keinen Suchindex: Mailtexte durchsucht er Mail für Mail. Betreff und Absender also über alle
  // Jahre, den Text nur im letzten Jahr — außer es ist ein Zeitraum genannt, dann in diesem
  const textSeit = zeit.since || new Date(Date.now() - 365 * 86400000);
  const textGrenze = !zeit.since;
  // Schritte vom schärfsten zum weichsten; jeder weitere sucht nur noch in dem, was der vorige fand
  const schritte = [];
  if (absender.length) schritte.push({ kopf: oder(absender.map(function (a) { return { from: a }; })) });
  if (empfaenger.length) schritte.push({ kopf: oder([].concat.apply([], empfaenger.map(function (a) { return [{ to: a }, { cc: a }]; }))) });
  gruppen.forEach(function (g) {
    schritte.push({
      kopf: oder([].concat.apply([], g.map(function (w) { return [{ subject: w }, { from: w }]; }))),
      text: oder(g.map(function (w) { return { body: w }; }))
    });
  });
  // UID-Menge kompakt für den Mailserver: 3,4,5,9 → 3:5,9
  const menge = function (uids) {
    const s = uids.slice().sort(function (a, b2) { return a - b2; }), teile = [];
    for (let i = 0; i < s.length; i++) {
      let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      teile.push(j > i ? s[i] + ':' + s[j] : String(s[i])); i = j;
    }
    return teile.join(',');
  };

  const treffer = [];
  const start = Date.now();
  let gesamt = 0, abgebrochen = false;
  for (const o of ordner) {
    if (Date.now() - start > 15000) { abgebrochen = true; break; }   // lieber rasch etwas zeigen als ewig suchen
    await imOrdner(o.pfad, async function (c) {
      if (!c.mailbox.exists) return;
      let uids = null;
      for (const s of schritte) {
        const nur = uids === null ? {} : { uid: menge(uids) };
        const imKopf = await c.search(Object.assign({}, zeit, nur, s.kopf), { uid: true }) || [];
        let imText = [];
        if (s.text) {
          // Bei schon eingegrenzten Mails den Text ohne Zeitgrenze prüfen — das sind nur wenige
          const wann = uids === null ? Object.assign({}, zeit, { since: textSeit }) : zeit;
          imText = await c.search(Object.assign({}, wann, nur, s.text), { uid: true }) || [];
        }
        const gefunden = imKopf.concat(imText.filter(function (u) { return imKopf.indexOf(u) === -1; }));
        uids = uids === null ? gefunden : uids.filter(function (u) { return gefunden.indexOf(u) !== -1; });
        if (!uids.length) return;
      }
      gesamt += uids.length;
      const neueste = uids.sort(function (a, b2) { return b2 - a; }).slice(0, 40);
      for await (const m of c.fetch(neueste.join(','), { uid: true, flags: true, envelope: true, bodyStructure: true }, { uid: true })) {
        if (k.nurAnhang && !hatAnhang(m.bodyStructure)) continue;
        const e = m.envelope || {};
        treffer.push({
          uid: m.uid, ordner: o.pfad, ordnerName: o.name, betreff: e.subject || '(ohne Betreff)',
          von: adressen(e.from)[0] || null, an: adressen(e.to), datum: e.date || null,
          gelesen: m.flags.has('\\Seen'), markiert: m.flags.has('\\Flagged'), beantwortet: m.flags.has('\\Answered'),
          anhang: hatAnhang(m.bodyStructure)
        });
      }
    }).catch(function () { /* ein Ordner, der sich nicht öffnen lässt, hält die Suche nicht auf */ });
  }
  treffer.sort(function (a, b2) { return new Date(b2.datum || 0) - new Date(a.datum || 0); });
  res.json({
    q: q, schlau: schlau, gesamt: gesamt, top: [], mails: treffer.slice(0, 80), index: indexInfo(),
    // Die Jahresgrenze für Mailtexte gilt nur, wenn zuerst nach Begriffen gesucht wurde — nach einem Absender
    // werden dessen Mails ohne Grenze geprüft
    textGrenze: textGrenze && gruppen.length > 0 && !absender.length && !empfaenger.length, abgebrochen: abgebrochen,
    erklaerung: erklaerung
  });
}));

// ---------------- Für „Anhänge ablegen“ (anhaenge.js) ----------------
// Nichts davon markiert eine Mail als gelesen: Kopf und Aufbau kommen aus dem Verzeichnis bzw. per BODYSTRUCTURE,
// der Inhalt per BODY.PEEK (mailHolen).
function postfachBereit() { return !!zugang() && indexAnzahl() > 0; }
async function anhangKandidaten(seit) {
  if (!postfachBereit()) return [];
  const liste = await ordnerListe(false);
  const ohne = liste.filter(function (f) { return ['papierkorb', 'spam', 'gesendet', 'entwuerfe'].indexOf(f.spezial) !== -1; })
    .map(function (f) { return f.pfad; });
  const ix2 = index();
  return indexMod.mitAnhang(ix2, { seit: seit, ohneOrdner: ohne }).map(function (z) {
    return Object.assign(z, { uidvalidity: indexMod.uidValidity(ix2, z.ordner) || '' });
  });
}
function anhangTeile(s, liste) {
  if (!s) return liste;
  const name = (s.dispositionParameters && s.dispositionParameters.filename) || (s.parameters && s.parameters.name) || '';
  if (!s.childNodes && name && !/^(text\/(plain|html)|multipart\/)/i.test(s.type || '')) {
    liste.push({ teil: String(s.part || '1'), name: String(name), typ: String(s.type || ''), groesse: Number(s.size) || 0,
      inline: s.disposition === 'inline' && /^image\//i.test(s.type || '') });
  }
  (s.childNodes || []).forEach(function (k) { anhangTeile(k, liste); });
  return liste;
}
// Anhänge mehrerer Mails eines Ordners: uid → [{ teil, name, typ, groesse, inline }]
async function anhangListen(ordner, uids) {
  return imOrdner(ordner, async function (c) {
    const erg = new Map();
    if (!uids.length) return erg;
    for await (const m of c.fetch(uids.join(','), { uid: true, bodyStructure: true }, { uid: true })) {
      erg.set(m.uid, anhangTeile(m.bodyStructure, []));
    }
    return erg;
  });
}
// Ein Anhang mit Inhalt: genau der Teil aus BODYSTRUCTURE (BODY.PEEK — die Mail bleibt ungelesen). Passt der Name nicht
// oder wurde der Ordner neu nummeriert (UIDVALIDITY), lieber gar keiner als ein falscher.
async function anhangInhalt(ordner, uid, teil, name, uidvalidity) {
  return imOrdner(ordner, async function (c) {
    if (uidvalidity && c.mailbox && c.mailbox.uidValidity !== undefined && String(c.mailbox.uidValidity) !== String(uidvalidity)) {
      throw fehler('Der Ordner wurde auf dem Mailserver neu nummeriert — der Anhang wird beim nächsten Suchen neu erfasst', 409);
    }
    const gleich = function (x) { return String(x || '').normalize('NFC') === String(name || '').normalize('NFC'); };
    try {
      const d = await c.download(String(uid), String(teil), { uid: true });
      if (d && d.content) {
        const stuecke = [];
        for await (const s of d.content) stuecke.push(s);
        const meta = d.meta || {};
        if (meta.filename && name && !gleich(meta.filename)) throw fehler('Der Anhang passt nicht mehr zu dieser Mail', 409);
        return { name: meta.filename || name, typ: meta.contentType || '', inhalt: Buffer.concat(stuecke) };
      }
    } catch (e) {
      if (e.status === 409) throw e;   // sonst über die ganze Mail versuchen
    }
    const g = await mailHolen(c, uid);
    const gleichnamig = (g.p.attachments || []).filter(function (a) { return !a.related && gleich(a.filename); });
    if (gleichnamig.length !== 1) throw fehler('Den Anhang gibt es in der Mail nicht mehr', 404);
    return { name: gleichnamig[0].filename || name, typ: gleichnamig[0].contentType || '', inhalt: gleichnamig[0].content };
  });
}

module.exports = { router: app, verschluesseln, entschluesseln, signaturAus, postfachBereit, anhangKandidaten, anhangListen, anhangInhalt };
