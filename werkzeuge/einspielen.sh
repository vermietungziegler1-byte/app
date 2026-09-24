#!/bin/bash
# ------------------------------------------------------------
#  einspielen — spielt ein Update aus /root/update in die
#  Vermietungs-App ein.
#
#    einspielen              Update einspielen
#    zurueck                 Dateien auf den Stand vor dem letzten Update
#    zurueck --mit-daten     … und auch die Datenbank von damals zurückholen
#
#  Vor jedem Update wird der bisherige Stand samt Datenbank nach
#  /root/sicherungen gelegt (die letzten 10 bleiben). Nach dem Neustart
#  prüft das Skript, ob die App antwortet — wenn nicht, nimmt es das
#  Update von selbst zurück.
#
#  Liegt eine neuere einspielen.sh im Update-Ordner, ersetzt sich das
#  Skript selbst und läuft mit der neuen Fassung weiter.
# ------------------------------------------------------------
set -u

Q=${EINSPIELEN_QUELLE:-/root/update}
Z=${EINSPIELEN_ZIEL:-/opt/vermietung}
DIENST=${EINSPIELEN_DIENST:-vermietung}
ABLAGE=${EINSPIELEN_ABLAGE:-/root/sicherungen}
SELBST=${EINSPIELEN_SELBST:-/usr/local/bin/einspielen}
BEHALTEN=10

APP_DATEIEN="index.html sw.js manifest.webmanifest"   # kommen nach public/
ALLE_BEKANNTEN="$APP_DATEIEN server.js icons einspielen.sh"

if [ -t 1 ]; then GRUEN=$'\e[32m'; ROT=$'\e[31m'; GELB=$'\e[33m'; FETT=$'\e[1m'; AUS=$'\e[0m'
else GRUEN=''; ROT=''; GELB=''; FETT=''; AUS=''; fi
ok()     { echo "${GRUEN}✔${AUS} $*"; }
warn()   { echo "${GELB}!${AUS} $*"; }
fehler() { echo "${ROT}✘ $*${AUS}"; }

# ---------- Selbst aktualisieren ----------
# Neue Fassung erst daneben schreiben und dann umbenennen: So bleibt die
# gerade laufende Datei unangetastet, und bash liest nicht mitten im Lauf Neues.
if [ -f "$Q/einspielen.sh" ] && ! cmp -s "$Q/einspielen.sh" "$SELBST"; then
  cp "$Q/einspielen.sh" "$SELBST.neu" && chmod +x "$SELBST.neu" && mv -f "$SELBST.neu" "$SELBST" \
    && ln -sf "$SELBST" "$(dirname "$SELBST")/zurueck" \
    && { ok "einspielen selbst wurde aktualisiert"
         if [ "$(basename "$0")" = "zurueck" ]; then exec "$SELBST" zurueck "$@"; else exec "$SELBST" "$@"; fi; }
  fehler "einspielen konnte sich nicht selbst aktualisieren"; exit 1
fi
[ -e "$(dirname "$SELBST")/zurueck" ] || ln -sf "$SELBST" "$(dirname "$SELBST")/zurueck" 2>/dev/null

# ---------- Wo liegt was? ----------
dienst_wert() {   # Wert einer Umgebungsvariable aus dem Dienst, z. B. DATEN oder PORT
  systemctl show "$DIENST" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1
}
datenordner() {
  local d
  d=$(dienst_wert DATEN)
  [ -n "$d" ] || d="$Z/server/daten"
  if [ ! -f "$d/vermietung.db" ]; then
    local f
    f=$(find "$Z" /root /var/lib /srv -xdev -name vermietung.db \
          -not -path '*/sicherung/*' -not -path "$ABLAGE/*" 2>/dev/null | head -1)
    [ -n "$f" ] && d=$(dirname "$f")
  fi
  echo "$d"
}
PORT=$(dienst_wert PORT); PORT=${PORT:-3000}
DATEN=$(datenordner)

# ---------- Läuft die App? ----------
app_antwortet() {
  local i code
  for i in $(seq 1 15); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/status" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}

# ---------- Sichern und Zurückholen ----------
datenbank_sichern() {   # $1 = Zielordner; nur bei gestopptem Dienst aufrufen
  local f
  for f in vermietung.db vermietung.db-wal vermietung.db-shm; do
    [ -f "$DATEN/$f" ] && cp -p "$DATEN/$f" "$1/"
  done
}
dateien_sichern() {     # $1 = Zielordner
  local f
  mkdir -p "$1/public" "$1/server"
  for f in $APP_DATEIEN; do [ -f "$Z/public/$f" ] && cp -p "$Z/public/$f" "$1/public/"; done
  [ -d "$Z/public/icons" ] && cp -rp "$Z/public/icons" "$1/public/"
  [ -f "$Z/server/server.js" ] && cp -p "$Z/server/server.js" "$1/server/"
}
dateien_zurueck() {     # $1 = Sicherungsordner
  local f
  for f in $APP_DATEIEN; do [ -f "$1/public/$f" ] && cp -p "$1/public/$f" "$Z/public/"; done
  [ -d "$1/public/icons" ] && cp -rp "$1/public/icons" "$Z/public/"
  [ -f "$1/server/server.js" ] && cp -p "$1/server/server.js" "$Z/server/"
  chmod -R a+rX "$Z/public"
}
letzte_sicherung() {
  ls -1d "$ABLAGE"/20*/ 2>/dev/null | sort | tail -1 | sed 's#/$##'
}
aufraeumen() {
  ls -1d "$ABLAGE"/20*/ 2>/dev/null | sort | head -n -"$BEHALTEN" | while read -r alt; do rm -rf "$alt"; done
}
protokoll() {
  echo "--- Letzte Meldungen des Dienstes ---"
  journalctl -u "$DIENST" -n 15 --no-pager 2>/dev/null
}

# ============================================================
#  zurueck
# ============================================================
if [ "$(basename "$0")" = "zurueck" ] || [ "${1:-}" = "zurueck" ]; then
  [ "${1:-}" = "zurueck" ] && shift
  MIT_DATEN=0; [ "${1:-}" = "--mit-daten" ] && MIT_DATEN=1
  S=$(letzte_sicherung)
  if [ -z "$S" ]; then fehler "Keine Sicherung in $ABLAGE gefunden"; exit 1; fi
  echo "${FETT}Zurück auf den Stand vor dem Update vom $(basename "$S")${AUS}"
  if [ $MIT_DATEN = 1 ]; then
    warn "Auch die Datenbank wird zurückgeholt — alles, was seitdem eingetragen wurde, ist dann weg."
  else
    echo "  Nur die Programmdateien. Deine Daten bleiben, wie sie sind."
  fi
  if [ -t 0 ]; then
    read -r -p "Wirklich? (j/n) " antwort
    [ "$antwort" = "j" ] || [ "$antwort" = "J" ] || { echo "Abgebrochen."; exit 0; }
  fi
  systemctl stop "$DIENST"
  dateien_zurueck "$S"
  if [ $MIT_DATEN = 1 ]; then
    if [ -f "$S/vermietung.db" ]; then
      JETZT="$ABLAGE/datenbank-vor-zurueck-$(date +%Y-%m-%d_%H-%M-%S)"
      mkdir -p "$JETZT" && datenbank_sichern "$JETZT"
      rm -f "$DATEN/vermietung.db-wal" "$DATEN/vermietung.db-shm"
      cp -p "$S"/vermietung.db* "$DATEN/"
      ok "Datenbank zurückgeholt (die bisherige liegt in $JETZT)"
    else
      warn "In dieser Sicherung ist keine Datenbank — nur die Dateien wurden zurückgeholt"
    fi
  fi
  systemctl start "$DIENST"
  if app_antwortet; then
    ok "Die App läuft wieder mit dem alten Stand."
    echo "  Hinweis: In $Q liegt noch das neue Update — ein erneutes 'einspielen' spielt es wieder ein."
  else
    fehler "Die App antwortet nicht."; protokoll; exit 1
  fi
  exit 0
fi

# ============================================================
#  einspielen
# ============================================================
if [ ! -d "$Q" ]; then
  fehler "Kein Ordner $Q gefunden — zuerst vom PC hochladen, in der PowerShell:"
  echo "  scp \$env:USERPROFILE\\OneDrive\\Desktop\\update\\* root@46.225.76.239:/root/update/"
  exit 1
fi

# Was liegt im Update-Ordner?
NEU=()
for f in $APP_DATEIEN server.js; do [ -f "$Q/$f" ] && NEU+=("$f"); done
[ -d "$Q/icons" ] && NEU+=("icons")
for f in "$Q"/*; do
  [ -e "$f" ] || continue
  n=$(basename "$f")
  case " $ALLE_BEKANNTEN " in *" $n "*) ;; *) warn "$n gehört nicht zur App und wird ignoriert" ;; esac
done
if [ ${#NEU[@]} -eq 0 ]; then fehler "In $Q liegt nichts zum Einspielen."; exit 1; fi

# Schon eingespielt? Dann nichts anfassen.
GEAENDERT=()
for f in "${NEU[@]}"; do
  case "$f" in
    server.js) cmp -s "$Q/$f" "$Z/server/$f" || GEAENDERT+=("$f") ;;
    icons)     diff -rq "$Q/icons" "$Z/public/icons" >/dev/null 2>&1 || GEAENDERT+=("$f") ;;
    *)         cmp -s "$Q/$f" "$Z/public/$f" || GEAENDERT+=("$f") ;;
  esac
done
if [ ${#GEAENDERT[@]} -eq 0 ]; then
  ok "Alles schon eingespielt — die Dateien in $Q sind dieselben wie auf der App."
  exit 0
fi
echo "${FETT}Neu: ${GEAENDERT[*]}${AUS}"

# Vorab prüfen, damit kein kaputtes Update live geht
if [ -f "$Q/server.js" ] && command -v node >/dev/null; then
  if ! node --check "$Q/server.js" 2>/tmp/einspielen-pruefung.txt; then
    fehler "server.js enthält einen Fehler — es wurde nichts verändert:"
    head -5 /tmp/einspielen-pruefung.txt; exit 1
  fi
fi
if [ -f "$Q/index.html" ] && ! grep -qi '</html>' "$Q/index.html"; then
  fehler "index.html ist unvollständig (evtl. abgebrochener Upload) — es wurde nichts verändert."; exit 1
fi

# Sichern: erst Dienst anhalten, damit die Datenbank in sich stimmig kopiert wird
S="$ABLAGE/$(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "$S"
systemctl stop "$DIENST"
dateien_sichern "$S"
datenbank_sichern "$S"
if [ ! -f "$S/vermietung.db" ]; then warn "Datenbank nicht gefunden (gesucht in $DATEN) — nur die Dateien sind gesichert"; fi

# Einspielen
for f in "${GEAENDERT[@]}"; do
  case "$f" in
    server.js) cp "$Q/$f" "$Z/server/" ;;
    icons)     cp -r "$Q/icons" "$Z/public/" ;;
    *)         cp "$Q/$f" "$Z/public/" ;;
  esac
done
chmod -R a+rX "$Z/public"
systemctl start "$DIENST"

# Prüfen, ob die App antwortet — sonst sofort zurück
if app_antwortet; then
  aufraeumen
  echo ""
  ok "Eingespielt: ${GEAENDERT[*]}"
  ok "Die App läuft (Port $PORT)"
  ok "Vorheriger Stand gesichert in $S"
  echo ""
  echo "Im Browser einmal Strg+F5 drücken. Falls etwas nicht stimmt: ${FETT}zurueck${AUS}"
else
  fehler "Die App antwortet nach dem Update nicht — das Update wird zurückgenommen."
  protokoll
  systemctl stop "$DIENST"
  dateien_zurueck "$S"
  systemctl start "$DIENST"
  if app_antwortet; then ok "Alter Stand ist wieder aktiv, die App läuft."
  else fehler "Auch der alte Stand startet nicht. Bitte die Meldungen oben an Claude schicken."; fi
  exit 1
fi
