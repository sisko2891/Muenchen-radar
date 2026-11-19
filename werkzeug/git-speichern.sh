#!/usr/bin/env bash
# Vorgemerkte Änderungen (git add) als Bot festschreiben und hochladen – mit Wiederholung, falls gleichzeitig
# ein anderer Ablauf geschrieben hat. Aufruf:  werkzeug/git-speichern.sh "<Text>"
# Rückgabe 0 = gespeichert oder nichts zu tun, 1 = Hochladen gescheitert.
set -uo pipefail
git diff --cached --quiet && { echo "nichts zu speichern"; exit 0; }
git -c user.name="muenchen-radar-bot" -c user.email="actions@users.noreply.github.com" commit -q -m "$1" || exit 1
for i in 1 2 3 4; do
  if git -c user.name="muenchen-radar-bot" -c user.email="actions@users.noreply.github.com" pull -q --rebase -X theirs origin main && git push -q; then
    echo "gespeichert"; exit 0
  fi
  git rebase --abort 2>/dev/null || true
  sleep $((i * 5))
done
exit 1
