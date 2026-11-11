'use strict';

// Attrappe des Postfachs für anhaenge.test.js — dieselben vier Aufrufe wie lib/postfach.js, die Mails und Anhänge
// kommen aus der JSON-Datei in ANHANG_TESTDATEN (der Test schreibt sie).

const fs = require('fs');
function mails() { return JSON.parse(fs.readFileSync(process.env.ANHANG_TESTDATEN, 'utf8')).mails; }

module.exports = {
  postfachBereit: function () { return true; },
  anhangKandidaten: async function () {
    return mails().map(function (m) {
      return { id: m.uid, ordner: m.ordner, uid: m.uid, uidvalidity: '7', datum: m.datum, von_name: m.von_name, von_adresse: m.von_adresse,
        betreff: m.betreff, anhaenge: m.anhaenge.map(function (a) { return a.name; }).join(' '), text: m.text || '' };
    });
  },
  anhangListen: async function (ordner, uids) {
    const erg = new Map();
    mails().filter(function (m) { return m.ordner === ordner && uids.indexOf(m.uid) !== -1; }).forEach(function (m) {
      erg.set(m.uid, m.anhaenge.map(function (a, i) { return { teil: String(i + 2), name: a.name, typ: a.typ, groesse: a.groesse, inline: !!a.inline }; }));
    });
    return erg;
  },
  // Wie das echte Postfach: genau der Teil (teil = Position + 2), der Name muss passen
  anhangInhalt: async function (ordner, uid, teil, name) {
    const m = mails().find(function (x) { return x.ordner === ordner && x.uid === uid; });
    const a = m && m.anhaenge[Number(teil) - 2];
    if (a && a.name !== name) throw new Error('Der Anhang passt nicht mehr zu dieser Mail');
    if (!a) throw new Error('Den Anhang gibt es in der Mail nicht mehr');
    return { name: a.name, typ: a.typ, inhalt: Buffer.from(a.inhalt || 'PDF-Inhalt') };
  }
};
