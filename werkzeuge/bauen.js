#!/usr/bin/env node
'use strict';

// -------------------------------------------------------------
//  bauen — trägt in public/index.html zu jeder Datei eine kurze
//  Prüfsumme ein (app.js?v=1a2b3c4d5e). Ändert sich eine Datei,
//  ändert sich die Adresse, und kein Browser nimmt mehr die alte
//  Fassung aus seinem Zwischenspeicher.
//
//    node werkzeuge/bauen.js           Prüfsummen eintragen
//    node werkzeuge/bauen.js --pruefen nur prüfen (für Tests), Exit 1 wenn veraltet
// -------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OEFFENTLICH = path.join(__dirname, '..', 'public');
const DATEIEN = ['schriften.css', 'app.css', 'apple.css', 'app.js'];

function pruefsumme(datei) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(OEFFENTLICH, datei))).digest('hex').slice(0, 10);
}

function gebaut() {
  let html = fs.readFileSync(path.join(OEFFENTLICH, 'index.html'), 'utf8');
  DATEIEN.forEach(function (datei) {
    const muster = new RegExp('(["\\/]' + datei.replace('.', '\\.') + ')\\?v=[0-9a-z]+', 'g');
    if (!muster.test(html)) throw new Error('index.html verweist nicht auf ' + datei + '?v=…');
    html = html.replace(muster, '$1?v=' + pruefsumme(datei));
  });
  return html;
}

if (require.main === module) {
  const ziel = path.join(OEFFENTLICH, 'index.html');
  const neu = gebaut();
  const alt = fs.readFileSync(ziel, 'utf8');
  if (process.argv.includes('--pruefen')) {
    if (neu !== alt) {
      console.error('index.html ist veraltet — bitte "node werkzeuge/bauen.js" ausführen.');
      process.exit(1);
    }
    console.log('index.html ist aktuell.');
  } else {
    fs.writeFileSync(ziel, neu);
    console.log(neu === alt ? 'index.html war schon aktuell.' : 'Prüfsummen in index.html eingetragen.');
  }
}

module.exports = { gebaut };
