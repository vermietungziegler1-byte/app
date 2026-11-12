'use strict';

// Brücke zwischen der App (Webseite) und dem Windows-Programm. Die App erkennt das Programm an
// window.zieglerDesktop und zieht Anhänge dann als echte Datei statt über den Browser.

const { contextBridge, ipcRenderer } = require('electron');

const bereit = new Map();   // Adresse → Promise mit dem Pfad der Datei im Zwischenordner

// Holt den Anhang mit der Anmeldung der App und lässt ihn vom Programm in den Zwischenordner legen
function bereitlegen(adresse, name) {
  adresse = String(adresse || '');
  if (!bereit.has(adresse)) {
    const p = fetch(adresse, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('Status ' + r.status); return r.arrayBuffer(); })
      .then(function (daten) { return ipcRenderer.invoke('ablegen', { name: String(name || 'anhang'), daten: new Uint8Array(daten) }); });
    p.catch(function () { bereit.delete(adresse); });
    bereit.set(adresse, p);
    while (bereit.size > 40) bereit.delete(bereit.keys().next().value);
  }
  return bereit.get(adresse);
}

contextBridge.exposeInMainWorld('zieglerDesktop', {
  version: 1,
  // beim Drücken der Maustaste schon holen, damit die Datei beim Ziehen meist fertig ist
  vorbereiten: function (adresse, name) { bereitlegen(adresse, name).catch(function () { /* beim Ziehen nochmal */ }); },
  ziehen: function (adresse, name) {
    bereitlegen(adresse, name).then(function (pfad) { ipcRenderer.send('ziehen', pfad); }).catch(function () { /* nichts zu ziehen */ });
  }
});
