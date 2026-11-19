#!/usr/bin/env bash
# Veröffentlicht einen Cloudflare-Dienst und hinterlegt seine Secrets.
# Aufruf (aus dem Projektordner):  werkzeug/veroeffentlichen.sh <Ordner> <Dienstname> [SECRET_NAME …]
# Erwartet CLOUDFLARE_API_TOKEN, CF_ACC_RAW und die genannten Secrets als Umgebungsvariablen.
# wrangler stammt aus werkzeug/node_modules (fest eingefrorene Versionen, siehe package-lock.json).
set -euo pipefail
ORDNER="$1"; NAME="$2"; shift 2
export CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "${CF_ACC_RAW:-}" | tr -d '[:space:]')"
export WRANGLER_SEND_METRICS=false
W="$PWD/werkzeug/node_modules/.bin/wrangler"
[ -x "$W" ] || { echo "::error::wrangler fehlt (npm ci im Ordner werkzeug)"; exit 1; }
cd "$ORDNER"
LOG="$(mktemp)"
"$W" deploy 2>&1 | tee "$LOG"
URL=$(grep -oE "https://${NAME}\.[a-z0-9-]+\.workers\.dev" "$LOG" | head -1 || true)
rm -f "$LOG"
[ -n "$URL" ] || { echo "::error::Keine Adresse gefunden (workers.dev-Subdomain vorhanden?)"; exit 1; }
# Die Seite erlaubt Verbindungen nur zu den eigenen Diensten (Content-Security-Policy in index.html)
case "$URL" in *.katzingers-castle.workers.dev) ;; *) echo "::warning::Adresse $URL passt nicht zur Freigabe in index.html (connect-src) – dort ergänzen";; esac
echo "url=$URL" >> "$GITHUB_OUTPUT"
for n in "$@"; do
  printf '%s' "${!n}" | "$W" secret put "$n" > /dev/null
  echo "$n gesetzt"
done
