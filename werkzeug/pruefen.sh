#!/usr/bin/env bash
# Prüft Secrets, ohne ihren Inhalt zu zeigen.  Aufruf:  werkzeug/pruefen.sh <PASSWORT_NAME> <Mindestlänge> [WEITERES_SECRET …]
# Fehlt etwas, endet der Ablauf ohne Fehler mit go=0 (Dienst noch nicht eingerichtet).
set -uo pipefail
PASS="$1"; MIN="$2"; shift 2
fehlt=""
for n in "$PASS" "$@"; do [ -n "${!n:-}" ] || fehlt="$fehlt $n"; done
if [ -n "$fehlt" ]; then echo "Noch nicht eingerichtet, fehlt:$fehlt – Veröffentlichung übersprungen."; echo "go=0" >> "$GITHUB_OUTPUT"; exit 0; fi
v="${!PASS}"
[ "${#v}" -ge "$MIN" ] || { echo "::error::$PASS ist kürzer als $MIN Zeichen"; exit 1; }
# Passwörter der Seite (…_PASS) reisen als Kopfzeile einer Anfrage. Leerzeichen am Anfang/Ende oder ein Zeilenumbruch
# (beim Einfügen leicht mitkopiert) schneidet der Browser dort heraus bzw. kann sie gar nicht senden – das Passwort
# würde auf der Seite nie stimmen. Deshalb Abbruch mit klarer Meldung.
case "$PASS" in *_PASS)
  case "$v" in [[:space:]]*|*[[:space:]]|*[$'\n\r\t']*) echo "::error::$PASS beginnt oder endet mit einem Leerzeichen oder enthält einen Zeilenumbruch/Tabulator – bitte ohne diese Zeichen neu hinterlegen"; exit 1;; esac;;
esac
# Das Passwort reist als Kopfzeile einer Anfrage: Zeichen wie € oder Emoji kann der Browser dort nicht senden,
# Umlaute nur eingeschränkt – deshalb ein Hinweis (kein Abbruch, falls ein bestehendes Passwort bisher funktioniert)
if LC_ALL=C grep -q '[^ -~]' <<< "$v"; then echo "::warning::$PASS enthält Zeichen außerhalb von A–Z, a–z, 0–9 und üblichen Sonderzeichen – falls die Seite das Passwort nicht annimmt, bitte ohne Umlaute/€ neu vergeben"; fi
echo "go=1" >> "$GITHUB_OUTPUT"
