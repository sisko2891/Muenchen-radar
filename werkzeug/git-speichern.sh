#!/usr/bin/env bash
# Vorgemerkte Änderungen (git add) als Bot festschreiben und hochladen – mit Wiederholung, falls gleichzeitig
# ein anderer Ablauf geschrieben hat. Aufruf:  werkzeug/git-speichern.sh "<Text>"
# Rückgabe 0 = gespeichert oder nichts zu tun, 1 = Hochladen gescheitert.
set -uo pipefail
git diff --cached --quiet && { echo "nichts zu speichern"; exit 0; }
git -c user.name="muenchen-radar-bot" -c user.email="actions@users.noreply.github.com" commit -q -m "$1" || exit 1
for i in 1 2 3 4; do
  # Schutz: Wurde der Verlauf auf GitHub neu angelegt (kein gemeinsamer Vorfahr mit diesem Lauf), nichts hochladen –
  # sonst brächte das Zusammenführen den alten Verlauf zurück. Der nächste Lauf arbeitet dann auf dem neuen Verlauf.
  if git fetch -q origin main && ! git merge-base HEAD FETCH_HEAD > /dev/null; then
    echo "Verlauf auf GitHub wurde neu angelegt – dieser Lauf speichert nicht"; exit 1
  fi
  if git -c user.name="muenchen-radar-bot" -c user.email="actions@users.noreply.github.com" pull -q --rebase -X theirs origin main && git push -q; then
    echo "gespeichert"; exit 0
  fi
  git rebase --abort 2>/dev/null || true
  sleep $((i * 5))
done
exit 1
