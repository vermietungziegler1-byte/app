'use strict';

// -------------------------------------------------------------
//  Vermietung — kleiner Server: Anmeldung, Daten, Verlauf.
//  Bewusst schlank gehalten: Express + SQLite, sonst nichts.
//
//  Die eigentliche Arbeit steckt in den Bausteinen unter lib/:
//    kern        Datenbank, Einstellungen, gemeinsame Hilfen
//    anmeldung   Passwörter, Sitzungen, Zugänge, Rechte
//    daten       Datenstand der App und Verlauf
//    todoist     Aufgaben
//    google      Google-Anmeldung, Post aus Gmail, Ablage in Drive
//    push        Mitteilungen aufs Handy, Morgenmeldung, Erinnerungen
//    stimme      Vorlesen (OpenAI)
//    assistent   Sprachassistent (Zuhören per OpenAI, Verstehen per Claude)
//    kalender    Google Kalender über die private iCal-Adresse
//    rechnungen  Allgemeinstrom- und Nebenkostenrechnungen
//    sicherung   tägliche Sicherung auf dem Server und in Google Drive
//    planer      Tagesplan: Aufgaben als Zeitblöcke, Rest auf die nächsten Tage
// -------------------------------------------------------------

const express = require('express');
const path = require('path');
const { PORT, HINTER_PROXY } = require('./lib/kern');

// ---------------- Anwendung ----------------
const app = express();
app.disable('x-powered-by');
if (HINTER_PROXY) app.set('trust proxy', 1);

// Grundlegende Schutz-Kopfzeilen für alle Antworten
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json({ limit: '4mb' }));

app.use(require('./lib/anmeldung').router);
app.use(require('./lib/daten').router);
app.use(require('./lib/todoist').router);
app.use(require('./lib/google').router);
app.use(require('./lib/push').router);
app.use(require('./lib/stimme').router);
app.use(require('./lib/assistent').router);
app.use(require('./lib/kalender').router);
app.use(require('./lib/rechnungen').router);
app.use(require('./lib/sicherung').router);
app.use(require('./lib/planer').router);

// ---------------- Oberfläche ----------------
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.listen(PORT, '127.0.0.1', function () {
  console.log('Vermietung läuft auf 127.0.0.1:' + PORT);
});
