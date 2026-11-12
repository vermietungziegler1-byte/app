'use strict';

// Ziegler Verwaltung als Windows-Programm.
//
// Das Programm zeigt dieselbe App wie der Browser — sie kommt vom Server, jedes „einspielen“ ist also sofort mit
// drin, ohne neue Installation. Dazu kann es, was eine Webseite nicht darf:
//   - Anhänge aus Mails als echte Datei in andere Programme ziehen (Claude, Word, Explorer), wie aus Outlook
//   - Word-, Excel- und andere Anhänge per Klick gleich im passenden Programm öffnen
// Die Anmeldung bleibt die der App; das Programm merkt sich nur das Anmelde-Keks wie ein Browser.

const { app, BrowserWindow, Menu, ipcMain, nativeImage, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ADRESSE = 'https://zieglerverwaltung.immobilien';
const SYMBOL = path.join(__dirname, 'icon.png');
const HINTERGRUND = '#14181e';
let zwischenordner = '';   // hier landen gezogene und geöffnete Anhänge (wird beim Start geleert)
let fenster = null;

// Ein Browser-üblicher Kennzeichner: Google lässt die Anmeldung (Drive verbinden) sonst womöglich nicht zu
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|Ziegler|ziegler-desktop)\/[^ ]+/g, '');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (!fenster) return;
    if (fenster.isMinimized()) fenster.restore();
    fenster.focus();
  });
  app.whenReady().then(starten);
  app.on('window-all-closed', function () { app.quit(); });
}

function vonDerApp(adresse) {
  try { return new URL(adresse).origin === ADRESSE; } catch (e) { return false; }
}
// Im Fenster bleiben dürfen nur die App selbst und die Google-Anmeldung; alles andere öffnet der Standardbrowser
function imFensterErlaubt(adresse) {
  try {
    const u = new URL(adresse);
    if (u.origin === ADRESSE) return true;
    return u.protocol === 'https:' && (u.hostname === 'google.com' || u.hostname.endsWith('.google.com'));
  } catch (e) { return false; }
}
function aussenOeffnen(adresse) {
  try {
    const p = new URL(adresse).protocol;
    if (p === 'https:' || p === 'http:' || p === 'mailto:' || p === 'tel:') shell.openExternal(adresse);
  } catch (e) { /* unbrauchbare Adresse */ }
}
function istAnhang(adresse) {
  return vonDerApp(adresse) && /^\/api\/(postfach\/anhang|anhaenge\/)/.test(new URL(adresse).pathname);
}

// Ein eigener Unterordner je Datei, damit der Originalname bleiben kann (zwei „Rechnung.pdf“ stören sich nicht)
function zielPfad(name) {
  let n = String(name || 'anhang').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 150) || 'anhang';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  const ordner = path.join(zwischenordner, Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(ordner, { recursive: true });
  return path.join(ordner, n);
}

function starten() {
  zwischenordner = path.join(app.getPath('temp'), 'Ziegler-Anhaenge');
  try { fs.rmSync(zwischenordner, { recursive: true, force: true }); } catch (e) { /* eine Datei ist noch offen — egal */ }
  fs.mkdirSync(zwischenordner, { recursive: true });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Bearbeiten', submenu: [
      { role: 'undo', label: 'Rückgängig' }, { role: 'redo', label: 'Wiederholen' }, { type: 'separator' },
      { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' }, { role: 'paste', label: 'Einfügen' },
      { role: 'selectAll', label: 'Alles auswählen' }] },
    { label: 'Ansicht', submenu: [
      { role: 'reload', label: 'Neu laden' }, { role: 'forceReload', label: 'Neu laden (ohne Zwischenspeicher)' }, { type: 'separator' },
      { role: 'zoomIn', label: 'Größer' }, { role: 'zoomOut', label: 'Kleiner' }, { role: 'resetZoom', label: 'Normale Größe' }, { type: 'separator' },
      { role: 'togglefullscreen', label: 'Vollbild' }, { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' }] }
  ]));

  // Mikrofon (Sprachnotizen), Zwischenablage, Mitteilungen und Vollbild — nur für die App selbst
  const ERLAUBT = ['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen'];
  session.defaultSession.setPermissionRequestHandler(function (wc, recht, antwort, details) {
    antwort(ERLAUBT.indexOf(recht) !== -1 && vonDerApp(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler(function (wc, recht, herkunft) {
    return ERLAUBT.indexOf(recht) !== -1 && vonDerApp(herkunft || '');
  });

  // Anhänge, die die App herunterlädt (Word, Excel, ZIP …): nicht erst speichern, gleich im passenden Programm öffnen.
  // Alles andere (z. B. „Daten sichern“) fragt wie gewohnt, wohin.
  session.defaultSession.on('will-download', function (ereignis, eintrag) {
    if (!istAnhang(eintrag.getURL())) return;
    const ziel = zielPfad(eintrag.getFilename());
    eintrag.setSavePath(ziel);
    eintrag.once('done', function (e, zustand) { if (zustand === 'completed') shell.openPath(ziel); });
  });

  // Für jedes Fenster (auch die, in denen PDFs aufgehen): fremde Seiten in den Standardbrowser
  app.on('web-contents-created', function (e, inhalt) {
    inhalt.on('will-navigate', function (ereignis, adresse) {
      if (!imFensterErlaubt(adresse)) { ereignis.preventDefault(); aussenOeffnen(adresse); }
    });
    inhalt.setWindowOpenHandler(function (d) {
      // Leere Fenster (das Drucken eines Briefs schreibt hinein) und Seiten der App bleiben im Programm
      const leer = !d.url || d.url === 'about:blank';
      if (!leer && !vonDerApp(d.url)) { aussenOeffnen(d.url); return { action: 'deny' }; }
      // PDFs und Fotos aus Mails in einem eigenen Fenster
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 1000, height: 900, icon: SYMBOL, backgroundColor: HINTERGRUND, autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, sandbox: true, plugins: true }
      } };
    });
  });

  fensterOeffnen();
}

// Fenstergröße und -lage vom letzten Mal
function lageDatei() { return path.join(app.getPath('userData'), 'fenster.json'); }
function lageLesen() {
  try { const l = JSON.parse(fs.readFileSync(lageDatei(), 'utf8')); if (l.width > 400 && l.height > 300) return l; } catch (e) { /* erstes Mal */ }
  return { width: 1440, height: 900 };
}

function fensterOeffnen() {
  const lage = lageLesen();
  fenster = new BrowserWindow({
    x: lage.x, y: lage.y, width: lage.width, height: lage.height, minWidth: 420, minHeight: 500,
    title: 'Ziegler', icon: SYMBOL, backgroundColor: HINTERGRUND, autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true, spellcheck: true }
  });
  if (lage.maximiert) fenster.maximize();
  fenster.once('ready-to-show', function () { fenster.show(); });
  fenster.on('close', function () {
    try { fs.writeFileSync(lageDatei(), JSON.stringify(Object.assign({}, fenster.getNormalBounds(), { maximiert: fenster.isMaximized() }))); } catch (e) { /* egal */ }
  });
  fenster.on('closed', function () { fenster = null; });
  // Maustaste „Zurück“ wie im Browser
  fenster.on('app-command', function (e, befehl) {
    const verlauf = fenster.webContents.navigationHistory || fenster.webContents;
    if (befehl === 'browser-backward' && verlauf.canGoBack()) verlauf.goBack();
    if (befehl === 'browser-forward' && verlauf.canGoForward()) verlauf.goForward();
  });
  // Ohne Internet: ein Hinweis mit „Nochmal versuchen“ statt eines leeren Fensters
  fenster.webContents.on('did-fail-load', function (e, code, text, adresse, hauptrahmen) {
    if (!hauptrahmen || code === -3) return;   // -3 = abgebrochen (z. B. durch eine neue Anfrage)
    fenster.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="de"><body style="margin:0;height:100vh;display:flex;'
      + 'align-items:center;justify-content:center;background:' + HINTERGRUND + ';color:#f5f5f7;font:15px system-ui,sans-serif"><div style="text-align:center">'
      + '<p style="font-size:18px;font-weight:600">Der Server ist gerade nicht erreichbar</p><p style="color:#98989f">Ist das Internet da?</p>'
      + '<p><a href="' + ADRESSE + '/" style="color:#0a84ff">Nochmal versuchen</a></p></div></body></html>'));
  });
  fenster.loadURL(ADRESSE + '/');
}

// ---- Anhänge als echte Datei aus der App ziehen ----
// Die App holt die Datei selbst (mit ihrer Anmeldung) und reicht den Inhalt herüber; hier wird sie in den
// Zwischenordner gelegt. Beim Ziehen übergibt Windows dann diese Datei — wie beim Ziehen aus dem Explorer.
let ziehbild = null;
function ziehBild() {
  if (!ziehbild) ziehbild = nativeImage.createFromPath(SYMBOL).resize({ width: 40, height: 40 });
  return ziehbild;
}

ipcMain.handle('ablegen', function (ereignis, d) {
  if (!ereignis.senderFrame || !vonDerApp(ereignis.senderFrame.url)) throw new Error('Nur aus der App');
  if (!d || !(d.daten instanceof Uint8Array) || d.daten.length > 300 * 1024 * 1024) throw new Error('Ungültige Datei');
  const ziel = zielPfad(d.name);
  fs.writeFileSync(ziel, Buffer.from(d.daten.buffer, d.daten.byteOffset, d.daten.byteLength));
  return ziel;
});

ipcMain.on('ziehen', function (ereignis, pfad) {
  if (!ereignis.senderFrame || !vonDerApp(ereignis.senderFrame.url)) return;
  const p = path.resolve(String(pfad || ''));
  if (!p.startsWith(zwischenordner + path.sep) || !fs.existsSync(p)) return;
  ereignis.sender.startDrag({ file: p, icon: ziehBild() });
});
