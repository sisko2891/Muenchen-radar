# Katzingers Castle

Persönliche Übersicht für zu Hause (iPad): S4 ab Aubing, Störungen, Wetter, Heizung, Termine, Dienste, Kino und Events.

## Bausteine

| Bereich | Quelle | Aktualisierung | Schutz |
|---|---|---|---|
| S4 Aubing → Innenstadt, Störungen | MVG | live im Browser | öffentlich |
| Wetter Aubing | Open-Meteo | alle 15 min | öffentlich |
| Pollenflug Oberbayern | Deutscher Wetterdienst | mit jedem Datenabgleich (`scripts/fetch_pollen.py`) | öffentlich |
| Schulferien Bayern, Feiertage | OpenHolidays (Ferien), Feiertage selbst berechnet | mit jedem Datenabgleich (`scripts/fetch_ferien.py`) | öffentlich |
| Kino, Events, Neu angekündigt | kino.de, muenchen.de, Olympiapark, MünchenMusik, Mathäser, Ticketmaster | alle 3 h (`scripts/fetch_events.py`) | öffentlich |
| Dienste | Profahr | 2× täglich (`scripts/fetch_privat.py`) | verschlüsselt, Dienst-PIN |
| Termine | TimeTree | alle 3 h (`scripts/fetch_kalender.py`) | verschlüsselt, Kalender-Passwort |
| Heizung (anzeigen + steuern) | tado über Cloudflare-Dienst `worker/` | live | Passwort, serverseitig geprüft |
| Fahrzeit zum Dienst | TomTom über Cloudflare-Dienst `weg/` | 60 min vor Ankunft | Passwort, serverseitig geprüft |
| Licht (anzeigen + steuern) | Philips Hue über Cloudflare-Dienst `licht/` | live | Passwort, serverseitig geprüft |
| Futter & Katzenklo | Cloudflare-Dienst `licht/` (nur Zeitpunkte) | live | Licht-Passwort |
| Bild des Hausherrn | `img/kater.*.enc.json` | – | verschlüsselt (Kalender-Passwort bzw. Dienst-PIN) |

Abläufe: `update.yml` (Daten + Seite), `heizung-deploy.yml`, `weg-deploy.yml`, `licht-deploy.yml`.

## Secrets (Settings → Secrets and variables → Actions)

| Secret | Wofür |
|---|---|
| `TICKETMASTER_KEY` | Konzerte mit VVK-Start |
| `PROFAHR_USER`, `PROFAHR_PASS`, `DIENSTE_PIN` | Dienste |
| `TIMETREE_EMAIL`, `TIMETREE_PASS`, `KALENDER_PASS` | Termine |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Veröffentlichung der Cloudflare-Dienste (Heizung, Fahrzeit, Licht) |
| `HEIZUNG_PASS` | Heizungsdienst |
| `WEG_PASS`, `TOMTOM_KEY`, `WEG_START`, `WEG_ZIEL` | Fahrzeit-Dienst (Adressen nur hier) |
| `LICHT_PASS`, `HUE_CLIENT_ID`, `HUE_CLIENT_SECRET` | Licht-Dienst (Philips Hue) |
