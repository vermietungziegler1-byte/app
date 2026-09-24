# Vermietung

Hausverwaltungs-App: Objekte, Mieter, Mieten, Interessenten, Post (Gmail),
Aufgaben (Todoist), Kalender, Rechnungen, Mitteilungen und Sprachassistent.

## Aufbau

```
public/            Oberfläche (wird vom Server ausgeliefert)
  index.html       Gerüst, verweist auf die Dateien unten
  app.js           Programmlogik der Oberfläche
  app.css          Aussehen
  schriften.css    eingebettete Schriften (kein Google Fonts, DSGVO)
server/
  server.js        startet die Anwendung und bindet die Bausteine ein
  lib/             Bausteine: kern, anmeldung, daten, todoist, google, push,
                   stimme, assistent, kalender, rechnungen, sicherung
  test/            automatische Tests
werkzeuge/
  einspielen.sh    Update auf dem Server einspielen (mit Sicherung und Rücknahme)
  bauen.js         trägt Prüfsummen in index.html ein
```

## Entwickeln

```bash
cd server
npm install
npm test                      # alle Tests (der Browser-Test braucht Playwright)
node ../werkzeuge/bauen.js    # nach Änderungen an app.js, app.css oder schriften.css
```

Bei jedem Push laufen die Tests automatisch auf GitHub (Actions).

## Auf dem Server

Der Server holt Updates direkt aus diesem Repository (Zweig in
`/etc/vermietung-einspielen.conf`).

| Befehl | Was passiert |
|---|---|
| `einspielen` | neuesten Stand holen, vorher sichern, danach prüfen, bei Problemen automatisch zurück |
| `zurueck` | Programm auf den Stand vor dem letzten Update |
| `zurueck --mit-daten` | zusätzlich die Datenbank von damals |
| `einspielen einrichten` | einmalig: Zugang zu GitHub (Deploy-Key) einrichten |

Vom PC aus in einem Schritt: `ssh -t root@46.225.76.239 einspielen`

Sicherungen: vor jedem Update in `/root/sicherungen`, jede Nacht im
Datenordner unter `sicherung/` (14 Tage) und in Google Drive im Ordner
„Vermietung – Sicherungen" (30 Tage, ohne Zugangsschlüssel).
