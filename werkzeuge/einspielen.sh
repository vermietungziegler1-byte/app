#!/bin/bash
# ------------------------------------------------------------
#  einspielen — bringt die Vermietungs-App auf den neuesten Stand.
#
#    einspielen              neuesten Stand aus GitHub holen und einspielen
#    einspielen einrichten   einmalig: Zugang zu GitHub einrichten
#    zurueck                 Programm auf den Stand vor dem letzten Update
#    zurueck --mit-daten     … und auch die Datenbank von damals zurückholen
#
#  Vor jedem Update wird der bisherige Stand samt Datenbank nach
#  /root/sicherungen gelegt (die letzten 10 bleiben). Nach dem Neustart
#  prüft das Skript, ob die App antwortet — wenn nicht, nimmt es das
#  Update von selbst zurück.
#
#  Solange GitHub nicht eingerichtet ist, nimmt es wie früher die
#  Dateien aus /root/update.
#
#  Bringt ein Update eine neuere Fassung dieses Skripts mit, ersetzt es
#  sich selbst und läuft mit der neuen Fassung weiter.
# ------------------------------------------------------------
set -u

KONF=${EINSPIELEN_KONF:-/etc/vermietung-einspielen.conf}
REPO=git@github-vermietung:vermietungziegler1-byte/app.git
ZWEIG=main
# shellcheck disable=SC1090
[ -f "$KONF" ] && . "$KONF"
REPO=${EINSPIELEN_REPO:-$REPO}
ZWEIG=${EINSPIELEN_ZWEIG:-$ZWEIG}

Q=${EINSPIELEN_QUELLE:-/root/update}               # alter Weg: hochgeladene Dateien
GIT=${EINSPIELEN_GIT:-/opt/vermietung-quelle}       # neuer Weg: Abbild des GitHub-Repos
Z=${EINSPIELEN_ZIEL:-/opt/vermietung}
DIENST=${EINSPIELEN_DIENST:-vermietung}
ABLAGE=${EINSPIELEN_ABLAGE:-/root/sicherungen}
SELBST=${EINSPIELEN_SELBST:-/usr/local/bin/einspielen}
SSH_ORDNER=${EINSPIELEN_SSH:-/root/.ssh}
SCHLUESSEL=$SSH_ORDNER/vermietung_github
BEHALTEN=10

if [ -t 1 ]; then GRUEN=$'\e[32m'; ROT=$'\e[31m'; GELB=$'\e[33m'; FETT=$'\e[1m'; AUS=$'\e[0m'
else GRUEN=''; ROT=''; GELB=''; FETT=''; AUS=''; fi
ok()     { echo "${GRUEN}✔${AUS} $*"; }
warn()   { echo "${GELB}!${AUS} $*"; }
fehler() { echo "${ROT}✘ $*${AUS}"; }

MODUS=einspielen
[ "$(basename "$0")" = "zurueck" ] && MODUS=zurueck
case "${1:-}" in zurueck|einrichten) MODUS=$1; shift ;; einspielen) shift ;; esac

# ---------- Selbst aktualisieren ----------
# Neue Fassung erst daneben schreiben und dann umbenennen: So bleibt die
# gerade laufende Datei unangetastet, und bash liest nicht mitten im Lauf Neues.
selbst_erneuern() {   # $1 = neue Fassung
  [ -f "$1" ] || return 0
  cmp -s "$1" "$SELBST" && return 0
  cp "$1" "$SELBST.neu" && chmod +x "$SELBST.neu" && mv -f "$SELBST.neu" "$SELBST" \
    && ln -sf "$SELBST" "$(dirname "$SELBST")/zurueck" \
    || { fehler "einspielen konnte sich nicht selbst aktualisieren"; exit 1; }
  ok "einspielen selbst wurde aktualisiert"
  exec "$SELBST" "$MODUS" "$@"
}
# Aus /root/update nur, solange GitHub nicht eingerichtet ist — sonst kommt die
# neueste Fassung aus GitHub, und eine alte Kopie im Update-Ordner darf sie nicht überschreiben.
[ "$MODUS" != "zurueck" ] && [ ! -d "$GIT/.git" ] && selbst_erneuern "$Q/einspielen.sh" "$@"
[ -e "$(dirname "$SELBST")/zurueck" ] || ln -sf "$SELBST" "$(dirname "$SELBST")/zurueck" 2>/dev/null

# ---------- Wo liegt was? ----------
dienst_wert() {   # Wert einer Umgebungsvariable aus dem Dienst, z. B. DATEN oder PORT
  systemctl show "$DIENST" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1
}
datenordner() {
  local d f
  d=$(dienst_wert DATEN)
  [ -n "$d" ] || d="$Z/server/daten"
  if [ ! -f "$d/vermietung.db" ]; then
    f=$(find "$Z" /root /var/lib /srv -xdev -name vermietung.db \
          -not -path '*/sicherung/*' -not -path "$ABLAGE/*" 2>/dev/null | head -1)
    [ -n "$f" ] && d=$(dirname "$f")
  fi
  echo "$d"
}
PORT=$(dienst_wert PORT); PORT=${PORT:-3000}
DATEN=$(datenordner)

# ---------- Läuft die App? ----------
# Antwortet der Server, und lassen sich Seite, CSS und JS laden?
app_antwortet() {
  local i code seite v
  for i in $(seq 1 15); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/status" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 1
  done
  [ "$code" = "200" ] || return 1
  seite=$(curl -s "http://127.0.0.1:$PORT/") || return 1
  echo "$seite" | grep -qi '</html>' || return 1
  for v in $(echo "$seite" | grep -o '[a-z]*\.\(css\|js\)?v=[0-9a-f]*'); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$v")
    [ "$code" = "200" ] || { fehler "$v fehlt ($code)"; return 1; }
  done
  return 0
}
protokoll() {
  echo "--- Letzte Meldungen des Dienstes ---"
  journalctl -u "$DIENST" -n 15 --no-pager 2>/dev/null
}

# ---------- Sichern und Zurückholen ----------
datenbank_sichern() {   # $1 = Zielordner; nur bei gestopptem Dienst aufrufen
  local f
  for f in vermietung.db vermietung.db-wal vermietung.db-shm; do
    [ -f "$DATEN/$f" ] && cp -p "$DATEN/$f" "$1/"
  done
}
programm_sichern() {    # $1 = Zielordner: public/ und server/ ohne node_modules und Daten
  tar -C "$Z" --exclude=server/node_modules --exclude=server/daten -cf "$1/programm.tar" public server 2>/dev/null
  [ -f "$Z/.eingespielt" ] && cp "$Z/.eingespielt" "$1/"
}
programm_zurueck() {    # $1 = Sicherungsordner
  if [ -f "$1/programm.tar" ]; then
    rm -rf "$Z/server/lib"
    tar -C "$Z" -xf "$1/programm.tar"
  else
    # Sicherungen der ersten Fassung von einspielen: einzelne Dateien
    local f
    for f in index.html sw.js manifest.webmanifest; do [ -f "$1/public/$f" ] && cp -p "$1/public/$f" "$Z/public/"; done
    [ -d "$1/public/icons" ] && cp -rp "$1/public/icons" "$Z/public/"
    [ -f "$1/server/server.js" ] && cp -p "$1/server/server.js" "$Z/server/"
  fi
  if [ -f "$1/.eingespielt" ]; then cp "$1/.eingespielt" "$Z/"; else rm -f "$Z/.eingespielt"; fi
  chmod -R a+rX "$Z/public"
}
letzte_sicherung() {
  ls -1d "$ABLAGE"/20*/ 2>/dev/null | sort | tail -1 | sed 's#/$##'
}
aufraeumen() {
  ls -1d "$ABLAGE"/20*/ 2>/dev/null | sort | head -n -"$BEHALTEN" | while read -r alt; do rm -rf "$alt"; done
}
neue_sicherung() {      # hält den Dienst an, sichert Programm und Datenbank, gibt den Ordner aus
  local s
  s="$ABLAGE/$(date +%Y-%m-%d_%H-%M-%S)"
  mkdir -p "$s"
  systemctl stop "$DIENST"
  programm_sichern "$s"
  datenbank_sichern "$s"
  echo "$s"
}

# Nach dem Einspielen: starten, prüfen, sonst zurück
starten_und_pruefen() { # $1 = Sicherungsordner, $2 = Beschreibung
  systemctl start "$DIENST"
  if app_antwortet; then
    aufraeumen
    echo ""
    ok "Eingespielt: $2"
    ok "Die App läuft (Port $PORT)"
    ok "Vorheriger Stand gesichert in $1"
    echo ""
    echo "Im Browser einmal neu laden. Falls etwas nicht stimmt: ${FETT}zurueck${AUS}"
    return 0
  fi
  fehler "Die App antwortet nach dem Update nicht richtig — das Update wird zurückgenommen."
  protokoll
  systemctl stop "$DIENST"
  programm_zurueck "$1"
  systemctl start "$DIENST"
  if app_antwortet; then ok "Alter Stand ist wieder aktiv, die App läuft."
  else fehler "Auch der alte Stand startet nicht. Bitte die Meldungen oben an Claude schicken."; fi
  exit 1
}

# Code vorab prüfen, damit nichts Kaputtes live geht. $1 = Ordner mit public/ und server/
vorab_pruefen() {
  local f
  if command -v node >/dev/null; then
    for f in "$1"/server/*.js "$1"/server/lib/*.js; do
      [ -f "$f" ] || continue
      if ! node --check "$f" 2>/tmp/einspielen-pruefung.txt; then
        fehler "$(basename "$f") enthält einen Fehler — es wurde nichts verändert:"
        head -5 /tmp/einspielen-pruefung.txt; return 1
      fi
    done
  fi
  if [ -f "$1/public/index.html" ] && ! grep -qi '</html>' "$1/public/index.html"; then
    fehler "index.html ist unvollständig — es wurde nichts verändert."; return 1
  fi
  return 0
}

# Fehlen Pakete, die package.json verlangt? Dann nur diese nachinstallieren.
pakete_pruefen() {      # $1 = package.json aus dem Update
  [ -f "$1" ] && command -v node >/dev/null || return 0
  local fehlend
  fehlend=$(cd "$Z/server" && node -e '
    const d = require(process.argv[1]).dependencies || {};
    const f = Object.keys(d).filter(function (n) { try { require.resolve(n); return false; } catch (e) { return true; } });
    console.log(f.map(function (n) { return n + "@" + d[n]; }).join(" "));
  ' "$1")
  [ -z "$fehlend" ] && return 0
  echo "Installiere fehlende Pakete: $fehlend"
  (cd "$Z/server" && npm install --omit=dev --no-save --no-package-lock $fehlend) \
    || { fehler "Pakete ließen sich nicht installieren"; return 1; }
}

# ============================================================
#  zurueck
# ============================================================
if [ "$MODUS" = "zurueck" ]; then
  MIT_DATEN=0; [ "${1:-}" = "--mit-daten" ] && MIT_DATEN=1
  S=$(letzte_sicherung)
  if [ -z "$S" ]; then fehler "Keine Sicherung in $ABLAGE gefunden"; exit 1; fi
  echo "${FETT}Zurück auf den Stand vor dem Update vom $(basename "$S")${AUS}"
  if [ $MIT_DATEN = 1 ]; then
    warn "Auch die Datenbank wird zurückgeholt — alles, was seitdem eingetragen wurde, ist dann weg."
  else
    echo "  Nur das Programm. Deine Daten bleiben, wie sie sind."
  fi
  if [ -t 0 ]; then
    read -r -p "Wirklich? (j/n) " antwort
    [ "$antwort" = "j" ] || [ "$antwort" = "J" ] || { echo "Abgebrochen."; exit 0; }
  fi
  systemctl stop "$DIENST"
  programm_zurueck "$S"
  if [ $MIT_DATEN = 1 ]; then
    if [ -f "$S/vermietung.db" ]; then
      JETZT="$ABLAGE/datenbank-vor-zurueck-$(date +%Y-%m-%d_%H-%M-%S)"
      mkdir -p "$JETZT" && datenbank_sichern "$JETZT"
      rm -f "$DATEN/vermietung.db-wal" "$DATEN/vermietung.db-shm"
      cp -p "$S"/vermietung.db* "$DATEN/"
      ok "Datenbank zurückgeholt (die bisherige liegt in $JETZT)"
    else
      warn "In dieser Sicherung ist keine Datenbank — nur das Programm wurde zurückgeholt"
    fi
  fi
  systemctl start "$DIENST"
  if app_antwortet; then
    ok "Die App läuft wieder mit dem alten Stand."
    echo "  Ein erneutes 'einspielen' holt den neuen Stand wieder."
  else
    fehler "Die App antwortet nicht."; protokoll; exit 1
  fi
  exit 0
fi

# ============================================================
#  einrichten — einmalig: Schlüssel für GitHub und Abbild des Repos
# ============================================================
if [ "$MODUS" = "einrichten" ]; then
  command -v git >/dev/null || { echo "Installiere git …"; apt-get install -y -q git >/dev/null; }
  mkdir -p "$SSH_ORDNER" && chmod 700 "$SSH_ORDNER"
  if [ ! -f "$SCHLUESSEL" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "vermietung-server" -f "$SCHLUESSEL" \
      || { fehler "Schlüssel ließ sich nicht erzeugen"; exit 1; }
    ok "Schlüssel für GitHub erzeugt"
  fi
  if ! grep -q "Host github-vermietung" "$SSH_ORDNER/config" 2>/dev/null; then
    printf '\nHost github-vermietung\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' \
      "$SCHLUESSEL" >> "$SSH_ORDNER/config"
    chmod 600 "$SSH_ORDNER/config"
  fi
  grep -q "^github.com" "$SSH_ORDNER/known_hosts" 2>/dev/null || ssh-keyscan -q github.com >> "$SSH_ORDNER/known_hosts" 2>/dev/null

  if ! git ls-remote "$REPO" >/dev/null 2>&1; then
    echo ""
    warn "GitHub kennt diesen Server noch nicht. Einmalig so freischalten:"
    echo ""
    echo "  1. github.com → Repository ${FETT}app${AUS} → Settings → Deploy keys → ${FETT}Add deploy key${AUS}"
    echo "  2. Title: Vermietung-Server"
    echo "  3. Key: diese ganze Zeile hineinkopieren:"
    echo ""
    echo "${FETT}$(cat "$SCHLUESSEL.pub")${AUS}"
    echo ""
    echo "  4. ${FETT}Allow write access${AUS} NICHT anhaken → Add key"
    echo "  5. Danach hier noch einmal: ${FETT}einspielen einrichten${AUS}"
    exit 1
  fi
  if ! git ls-remote --exit-code --heads "$REPO" "$ZWEIG" >/dev/null 2>&1; then
    fehler "Im Repository gibt es den Zweig '$ZWEIG' nicht."; exit 1
  fi
  if [ ! -d "$GIT/.git" ]; then
    git clone -q --branch "$ZWEIG" "$REPO" "$GIT" || { fehler "Herunterladen von GitHub fehlgeschlagen"; exit 1; }
  fi
  printf 'REPO=%s\nZWEIG=%s\n' "$REPO" "$ZWEIG" > "$KONF"
  ok "GitHub ist eingerichtet (Zweig $ZWEIG)."
  echo "  Ab jetzt holt ${FETT}einspielen${AUS} Updates direkt von dort."
  exit 0
fi

# ============================================================
#  einspielen aus GitHub
# ============================================================
if [ -d "$GIT/.git" ]; then
  git -C "$GIT" fetch -q origin "$ZWEIG" 2>/tmp/einspielen-git.txt \
    || { fehler "GitHub ist nicht erreichbar:"; head -3 /tmp/einspielen-git.txt; exit 1; }
  NEU=$(git -C "$GIT" rev-parse "origin/$ZWEIG")
  git -C "$GIT" reset -q --hard "$NEU"
  selbst_erneuern "$GIT/werkzeuge/einspielen.sh" "$@"

  ALT=$(cat "$Z/.eingespielt" 2>/dev/null || true)
  if [ "$ALT" = "$NEU" ]; then
    ok "Schon auf dem neuesten Stand ($(git -C "$GIT" log -1 --format='%h vom %cd' --date=format:'%d.%m.%Y %H:%M' "$NEU"))."
    exit 0
  fi
  echo "${FETT}Neu seit dem letzten Einspielen:${AUS}"
  if [ -n "$ALT" ] && git -C "$GIT" cat-file -e "$ALT" 2>/dev/null; then
    git -C "$GIT" log --format='  · %s' "$ALT..$NEU" | head -15
  else
    git -C "$GIT" log --format='  · %s' -5 "$NEU"
  fi
  echo ""

  vorab_pruefen "$GIT" || exit 1
  S=$(neue_sicherung)
  [ -f "$S/vermietung.db" ] || warn "Datenbank nicht gefunden (gesucht in $DATEN) — nur das Programm ist gesichert"

  # Einspielen: public/ und server/ (ohne Tests, Pakete und Daten). server/lib wird
  # komplett ersetzt, damit keine gelöschten Bausteine liegen bleiben.
  rm -rf "$Z/server/lib"
  tar -C "$GIT" --exclude=server/test --exclude=server/node_modules --exclude=server/daten \
      --exclude=server/package.json --exclude=server/package-lock.json -cf - public server \
    | tar -C "$Z" -xf -
  chmod -R a+rX "$Z/public"
  pakete_pruefen "$GIT/server/package.json" || { programm_zurueck "$S"; systemctl start "$DIENST"; exit 1; }
  echo "$NEU" > "$Z/.eingespielt"

  starten_und_pruefen "$S" "Stand $(git -C "$GIT" log -1 --format='%h' "$NEU")"
  exit 0
fi

# ============================================================
#  einspielen aus /root/update (bis GitHub eingerichtet ist)
# ============================================================
if [ ! -d "$Q" ]; then
  fehler "Weder GitHub eingerichtet noch ein Ordner $Q da."
  echo "  GitHub einrichten mit: ${FETT}einspielen einrichten${AUS}"
  exit 1
fi
warn "GitHub ist noch nicht eingerichtet — nehme die Dateien aus $Q (einrichten mit: einspielen einrichten)"

OEFFENTLICH="index.html app.js app.css schriften.css sw.js manifest.webmanifest"
NEUE=()
for f in $OEFFENTLICH server.js; do [ -f "$Q/$f" ] && NEUE+=("$f"); done
for f in "$Q"/*; do
  [ -e "$f" ] || continue
  n=$(basename "$f")
  case " $OEFFENTLICH server.js einspielen.sh icons " in *" $n "*) ;; *) warn "$n gehört nicht zur App und wird ignoriert" ;; esac
done
GEAENDERT=()
for f in "${NEUE[@]}"; do
  if [ "$f" = "server.js" ]; then cmp -s "$Q/$f" "$Z/server/$f" || GEAENDERT+=("$f")
  else cmp -s "$Q/$f" "$Z/public/$f" || GEAENDERT+=("$f"); fi
done
[ -d "$Q/icons" ] && ! diff -rq "$Q/icons" "$Z/public/icons" >/dev/null 2>&1 && GEAENDERT+=("icons")
if [ ${#GEAENDERT[@]} -eq 0 ]; then
  ok "Alles schon eingespielt — die Dateien in $Q sind dieselben wie auf der App."
  exit 0
fi
echo "${FETT}Neu: ${GEAENDERT[*]}${AUS}"

if [ -f "$Q/server.js" ] && command -v node >/dev/null && ! node --check "$Q/server.js" 2>/tmp/einspielen-pruefung.txt; then
  fehler "server.js enthält einen Fehler — es wurde nichts verändert:"; head -5 /tmp/einspielen-pruefung.txt; exit 1
fi
if [ -f "$Q/index.html" ] && ! grep -qi '</html>' "$Q/index.html"; then
  fehler "index.html ist unvollständig — es wurde nichts verändert."; exit 1
fi

S=$(neue_sicherung)
[ -f "$S/vermietung.db" ] || warn "Datenbank nicht gefunden (gesucht in $DATEN) — nur das Programm ist gesichert"
for f in "${GEAENDERT[@]}"; do
  case "$f" in
    server.js) cp "$Q/$f" "$Z/server/" ;;
    icons)     cp -r "$Q/icons" "$Z/public/" ;;
    *)         cp "$Q/$f" "$Z/public/" ;;
  esac
done
chmod -R a+rX "$Z/public"
starten_und_pruefen "$S" "${GEAENDERT[*]}"
