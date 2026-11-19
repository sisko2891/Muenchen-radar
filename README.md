# Katzingers Castle

Persönliche Übersicht für zu Hause (iPad): S4 ab Aubing, Störungen, Wetter, Heizung, Termine, Dienste, Kino und Events.

## Bausteine

| Bereich | Quelle | Aktualisierung | Schutz |
|---|---|---|---|
| S4 Aubing → Innenstadt, Störungen | MVG | live im Browser | öffentlich |
| Wetter Aubing (mit Tageslicht-Leiste; Antippen zeigt 7 Tage) | Open-Meteo | alle 15 min | öffentlich |
| Luftqualität Aubing | Open-Meteo (Europäischer Luftqualitätsindex, Modellwerte) | alle 30 min | öffentlich |
| Pollenflug Oberbayern | Deutscher Wetterdienst | mit jedem Datenabgleich (`scripts/fetch_pollen.py`) | öffentlich |
| Schulferien Bayern, Feiertage | OpenHolidays (Ferien), Feiertage selbst berechnet | mit jedem Datenabgleich (`scripts/fetch_ferien.py`) | öffentlich |
| Kinopreise Premium-Sitze | Mathäser: Programm- und Preisseite des Kinos, berechnet (`scripts/fetch_kino.py`); Cineplex Germering: feste Preisliste in `js/app.js` (`GER`, Stand Nov. 2026) | mit jedem Datenabgleich | öffentlich |
| Kino, Events, Neu angekündigt | kino.de, muenchen.de, Olympiapark, MünchenMusik, Mathäser, Ticketmaster | alle 3 h (`scripts/fetch_events.py`) | öffentlich |
| Dienste | Profahr (Wochenliste und Druckansicht) | tagsüber etwa alle 3 Stunden (`scripts/fetch_privat.py`) | verschlüsselt (Dienst-PIN) **und** nur über den geschützten Speicher `daten/` abrufbar |
| Termine | TimeTree | alle 3 h (`scripts/fetch_kalender.py`) | verschlüsselt (Kalender-Passwort) **und** nur über den geschützten Speicher `daten/` abrufbar |
| Heizung (anzeigen + steuern) | tado über Cloudflare-Dienst `worker/` | live | Passwort, serverseitig geprüft |
| Hinweise aus der Heizung | Fenster seit mindestens 10 min offen und draußen unter 10 °C: Hinweis oben und in der Nachtanzeige (tados Meldung endet von selbst; der Hinweis bleibt, solange der Raum weiter auskühlt, höchstens 3 h – solche Räume tragen ein Fragezeichen). Raum seit mindestens 30 min über 65 % Luftfeuchte: Kachel gelb mit „lüften“. Schwellen: `FENSTER_MIN`, `AUSSEN_KALT`, `FEUCHT_MIN` in `js/app.js`, 65/62 % in `worker/index.js` | mit jedem Heizungs-Abruf | wie Heizung |
| Fahrzeit zum Dienst | TomTom über Cloudflare-Dienst `weg/` | 60 min vor Ankunft | Passwort, serverseitig geprüft |
| Licht (anzeigen + steuern) | Philips Hue über Cloudflare-Dienst `licht/` | live | Passwort, serverseitig geprüft |
| Futter & Katzenklo | Cloudflare-Dienst `licht/` (nur Zeitpunkte) | live | Licht-Passwort |
| Gäste-WLAN als QR-Code | Cloudflare-Dienst `licht/` (Secrets `WLAN_NAME`, `WLAN_PASS`); QR-Code entsteht im Browser (`lib/qrcode.js`) | beim Antippen | Licht-Passwort |
| Bild des Hausherrn | geschützter Speicher `daten/` | – | nur mit Kalender-Passwort oder Dienst-PIN abrufbar |

Abläufe: `update.yml` (Daten + Seite), `heizung-deploy.yml`, `weg-deploy.yml`, `licht-deploy.yml`, `daten-deploy.yml`.

Aufbau: `index.html` (Gerüst und Gestaltung), `js/app.js` (Programm der Seite), `js/skin.js`, `lib/qrcode.js`, `fonts/` (Schriften, liegen im Projekt – kein Abruf bei Google), `scripts/` (Datenabgleich), `worker/`, `weg/`, `licht/`, `daten/` (Cloudflare-Dienste), `werkzeug/` (fest eingefrorenes Werkzeug zum Veröffentlichen der Dienste).

## Schutz der privaten Daten

- **Nichts Privates liegt im öffentlichen Projekt.** Dienste, Termine und das Bild liegen im Cloudflare-Dienst `daten/`. Er gibt sie nur gegen einen Zugangsschlüssel heraus, den die Seite aus Dienst-PIN bzw. Kalender-Passwort berechnet, und sperrt nach 5 Fehlversuchen (je Anschluss, 15 min; nach 30 Fehlversuchen insgesamt 1 h für alle Unbekannten). Eine PIN lässt sich damit nicht mehr offline durchprobieren.
- Dienste und Termine sind zusätzlich Ende-zu-Ende verschlüsselt (PBKDF2 + AES-GCM): Auch der Speicherdienst kann sie nicht lesen. Entschlüsselt wird erst im Browser.
- Schreiben darf nur der Datenabgleich. Sein Schlüssel wird in den Abläufen aus `CLOUDFLARE_API_TOKEN` abgeleitet; der Dienst kennt nur dessen Hash. Der Verlauf für die Turbo-Erkennung liegt in einer Ablage, die nur der Abgleich lesen kann.
- Das öffentliche Protokoll der Abläufe enthält weder Inhalte noch Zählwerte der privaten Daten.
- Die Seite erlaubt per Content-Security-Policy nur eigene Skripte und Verbindungen zu den genannten Quellen und eigenen Diensten; Bilder nur von der Seite selbst und von kino.de (Plakate). **Neue Quelle oder neue Dienst-Adresse:** in `index.html` bei `connect-src` ergänzen. Eingebettet in eine fremde Seite zeigt und lädt die Seite nichts.
- Die gespeicherten Passwörter liegen im Browser des iPads und gelten für alle Seiten unter `sisko2891.github.io`. Deshalb unter diesem GitHub-Konto **keine weitere Pages-Seite** veröffentlichen (oder dieser Seite eine eigene Domain geben).
- **Gerät abmelden:** Wappen antippen → „Dieses Gerät abmelden“ (zweimal tippen) entfernt PIN, Passwörter und die gemerkten privaten Daten von diesem Gerät – gedacht für fremde Geräte, auf denen die Seite einmal entsperrt wurde. Einstellungen wie Design oder Merkliste bleiben.
- **PIN oder Passwort ändern:** Secret in GitHub ändern → Ablauf „Daten aktualisieren & veröffentlichen“ starten → am iPad einmal neu eingeben. Passwörter der Dienste (Heizung, Licht, Fahrzeit, WLAN): nach dem Ändern den jeweiligen Ablauf „… veröffentlichen“ starten (Passwörter ohne Leerzeichen am Anfang/Ende hinterlegen – der Ablauf bricht sonst mit einem Hinweis ab).
- **`CLOUDFLARE_API_TOKEN` ersetzen:** danach einmal den Ablauf „Geschützten Datenspeicher veröffentlichen“ starten – erst dann kennt der Speicher den neuen Schreibschlüssel, bis dahin scheitert der Datenabgleich. Der interne Verlauf (gemerkte Bemerkungen, Turbo-Erkennung) beginnt danach neu.

## Dauerbetrieb an der Wand

- Daten werden im Hintergrund nachgeladen (Abfahrten 30 s, Licht 1 min – nur wenn sichtbar, Heizung 2 min – nachts und bei sichtbarem Licht-Feld alle 6 min, Störungen 2 min, Wetter 15 min, alles Übrige stündlich).
- Schlägt ein Abruf fehl (WLAN-Aussetzer), bleibt der letzte Stand stehen; Abfahrten höchstens 3 min, Wetter mit Hinweis „Stand …“ höchstens 3 h, danach steht ein Hinweis da. Dienste, Termine und Bild werden auf dem Gerät gemerkt und stehen auch ohne Verbindung zum Speicher da.
- **Gesperrte Tage:** In der Wochenliste von Profahr steht dort nur „gesperrt“. Was geplant ist, steht allein in der Druckansicht (ein PDF) in der Spalte „Bemerkung“; der Abgleich liest es mit und zeigt es hinter „gesperrt“. Ändert sich die Bemerkung, solange der Tag gesperrt ist, steht sie rot in der Übersicht – mit Zeitpunkt und vorherigem Text – und das Dienst-Feld bekommt einen roten Punkt, bis die Übersicht einmal geöffnet wurde. Ist die Druckansicht nicht lesbar, bleiben die Dienste trotzdem aktuell und die Bemerkungen auf dem letzten Stand. Die Druckansicht reicht immer 15 Tage ab heute; einen längeren Zeitraum gibt Profahr dafür nicht heraus (ausprobiert), spätere gesperrte Tage zeigen deshalb noch keine Bemerkung.
- **„Änd“-Tage** (geänderter Dienst ohne Uhrzeit): Die Bemerkung steht schon in der Wochenliste; sie erscheint hinter dem Kürzel, im Dienst-Feld gekürzt und in der Übersicht ganz (blaue Kante). Ändert sie sich, wird sie wie bei gesperrten Tagen rot markiert, mit Zeitpunkt und vorherigem Text.
- **Tagesbogen um die Uhr** (ab iPad-Breite): ein Halbkreis über der Uhrzeit zeigt 6 Stunden zurück und 18 voraus – außen den Dienst (gestrichelt: gesperrter Tag), innen die Termine nach TimeTree-Farbe (Blautöne = eigene Termine, Grüntöne = die der zweiten Person; andere Farben erscheinen nur im Kalender). Ganztägige Termine von heute stehen als Punkte über dem Datum; Ferien und Feiertage bleiben weg. Die Uhrzeit steht nur noch im Bogen, das Wappen ist dafür größer.
- **Feiertage und Ferien** stehen auch in der Dienste-Übersicht: der Feiertag (Bayern) bzw. schulfreie Tag als kleine Zeile über dem Dienst, Schulferien als kleines Wort unter dem Datum.
- **Läufe in GitHub Actions** älter als 3 Tage löscht der Abgleich selbst (samt Protokollen), damit sie sich nicht ansammeln.
- Sind die Dienste älter als 18 Stunden (Abruf klappt nicht), steht „⚠ Stand …“ im Dienst-Feld. Ein gescheiterter Abruf färbt außerdem den Lauf in GitHub Actions rot (GitHub benachrichtigt dann, sofern Benachrichtigungen für Actions eingeschaltet sind).
- Der Datenabgleich wird stündlich angestoßen – von GitHubs eigenem Zeitplan und, weil der oft stundenlang ausfällt, zusätzlich von einem Zeitgeber bei Cloudflare (Dienst `daten/`, Secret `ANSTOSS_TOKEN`). Gearbeitet wird nur, wenn die Daten älter als etwa 2,5 Stunden sind. Lehnt GitHub den Anstoß ab (Schlüssel abgelaufen), steht der Lauf bei Cloudflare als gescheitert da, die Meldung unter „Logs“ des Dienstes `katzingers-daten`.
- Eine neue Version der Seite wird stündlich erkannt und geladen, sobald 2 min niemand bedient hat. Zusätzlich lädt die Seite nachts um 3:30 neu – beides nur, wenn sie erreichbar ist.
- Nachtanzeige 23:00–5:30, Antippen zeigt 2 min die volle Seite.
- Einbrennschutz: Die Seite wandert alle 2 min um 1 px (Bereich 7 × 6 px), die Nachtanzeige etwas weiter.

## Secrets (Settings → Secrets and variables → Actions)

| Secret | Wofür |
|---|---|
| `TICKETMASTER_KEY` | Konzerte mit VVK-Start |
| `PROFAHR_USER`, `PROFAHR_PASS`, `DIENSTE_PIN` | Dienste |
| `TIMETREE_EMAIL`, `TIMETREE_PASS`, `KALENDER_PASS` | Termine |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Veröffentlichung der Cloudflare-Dienste (Heizung, Fahrzeit, Licht, Datenspeicher); aus dem Token wird außerdem der Schreibschlüssel des Datenspeichers abgeleitet |
| `HEIZUNG_PASS` | Heizungsdienst |
| `WEG_PASS`, `TOMTOM_KEY`, `WEG_START`, `WEG_ZIEL` | Fahrzeit-Dienst (Adressen nur hier) |
| `LICHT_PASS`, `HUE_CLIENT_ID`, `HUE_CLIENT_SECRET` | Licht-Dienst (Philips Hue) |
| `WLAN_NAME`, `WLAN_PASS` | optional: Gäste-WLAN für den QR-Code (nur im Licht-Dienst hinterlegt) |
| `ANSTOSS_TOKEN` | GitHub-Zugangsschlüssel (fine-grained, nur dieses Projekt, „Actions: Read and write“), mit dem der Zeitgeber bei Cloudflare den Datenabgleich startet. Läuft er ab: neuen anlegen, Secret ersetzen, Ablauf „Geschützten Datenspeicher veröffentlichen“ starten |
