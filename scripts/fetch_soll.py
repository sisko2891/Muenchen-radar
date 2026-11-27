#!/usr/bin/env python3
"""Soll-Fahrplan der S4 ab Aubing Richtung Innenstadt aus den offenen Fahrplandaten des MVV (GTFS) -> data/s4-soll.json.

Der S4-Zähler (Dienst daten/) gleicht jede gezählte Fahrt damit ab: Eine Fahrt, die laut Soll-Fahrplan fahren sollte,
die MVG aber nie angezeigt hat, zählt als ausgefallen („fehlte“) – außer während einer angekündigten Baustelle.

Aufruf:  fetch_soll.py              -> Feed vom MVV laden
         fetch_soll.py datei.zip    -> lokale Datei verwenden (Test)
Daten: Münchner Verkehrs- und Tarifverbund GmbH (MVV), CC BY 4.0.
"""
import csv, io, json, re, sys, urllib.request, zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

URL = "https://www.mvv-muenchen.de/fileadmin/mediapool/developer/opendata/gesamt_gtfs.zip"
OUT = Path(__file__).resolve().parent.parent / "data" / "s4-soll.json"
BERLIN = ZoneInfo("Europe/Berlin")
HALT = "de:09162:1710"          # Aubing (Station; Bahnsteige sind de:09162:1710:…)
OSTWAERTS = re.compile(r"Leienfels|Pasing")   # nächste Halte Richtung Innenstadt
TAGE_ZURUECK, TAGE_VOR = 1, 21  # so viele Tage um heute herum werden abgelegt (der Ablauf läuft wöchentlich)
MAX_BYTES = 80_000_000


def laden():
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).read_bytes(), None
    req = urllib.request.Request(URL, headers={"User-Agent": "katzingers-castle/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        daten = r.read(MAX_BYTES + 1)
        if len(daten) > MAX_BYTES:
            raise SystemExit("Fahrplandatei unerwartet groß – nichts geändert")
        return daten, r.headers.get("Last-Modified")


def zeilen(z, name):
    return csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig", newline=""))


def sekunden(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def auswerten(roh, heute):
    z = zipfile.ZipFile(io.BytesIO(roh))
    info = next(zeilen(z, "feed_info.txt"), {}) if "feed_info.txt" in z.namelist() else {}
    s4 = {r["route_id"] for r in zeilen(z, "routes.txt") if r.get("route_short_name") == "S4"}
    if not s4:
        raise SystemExit("S4 nicht im Fahrplan gefunden – nichts geändert")
    fahrten = {t["trip_id"]: t for t in zeilen(z, "trips.txt") if t.get("route_id") in s4}
    namen = {s["stop_id"]: s.get("stop_name", "") for s in zeilen(z, "stops.txt")}
    halte = {}
    for r in zeilen(z, "stop_times.txt"):
        if r["trip_id"] in fahrten:
            halte.setdefault(r["trip_id"], []).append((int(r["stop_sequence"]), r["stop_id"], r.get("departure_time") or r.get("arrival_time")))
    # Abfahrt in Aubing Richtung Innenstadt (nächster Halt Leienfelsstraße/Pasing) und Ziel der Fahrt
    ab = {}
    for tid, f in halte.items():
        f.sort()
        for i, (_, sid, zeit) in enumerate(f):
            if (sid == HALT or sid.startswith(HALT + ":")) and i + 1 < len(f) and OSTWAERTS.search(namen.get(f[i + 1][1], "")) and zeit:
                ab[tid] = (sekunden(zeit), fahrten[tid].get("trip_headsign") or namen.get(f[-1][1], ""))
                break
    kal = {c["service_id"]: c for c in zeilen(z, "calendar.txt")} if "calendar.txt" in z.namelist() else {}
    ausnahmen = {}
    if "calendar_dates.txt" in z.namelist():
        for c in zeilen(z, "calendar_dates.txt"):
            ausnahmen[(c["service_id"], c["date"])] = c["exception_type"]
    wt = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

    def gilt(sid, tag):
        t = tag.strftime("%Y%m%d")
        aus = ausnahmen.get((sid, t))
        if aus == "2":
            return False
        if aus == "1":
            return True
        c = kal.get(sid)
        return bool(c) and c["start_date"] <= t <= c["end_date"] and c[wt[tag.weekday()]] == "1"

    ziele, tage = [], {}
    # Dienste, die nach Mitternacht fahren, gehören zum Betriebstag davor: deshalb einen Tag früher anfangen
    for k in range(-TAGE_ZURUECK - 1, TAGE_VOR + 1):
        betrieb = heute + timedelta(days=k)
        # GTFS: Zeiten zählen ab „Mittag minus 12 h“ – in echter Zeit gerechnet (an Tagen der Zeitumstellung ist das nicht 0 Uhr)
        basis = datetime(betrieb.year, betrieb.month, betrieb.day, 12, tzinfo=BERLIN).astimezone(timezone.utc) - timedelta(hours=12)
        for tid, (sek, ziel) in ab.items():
            if not gilt(fahrten[tid]["service_id"], betrieb):
                continue
            t = basis + timedelta(seconds=sek)
            tag = t.astimezone(BERLIN).date()
            if not (heute - timedelta(days=TAGE_ZURUECK) <= tag <= heute + timedelta(days=TAGE_VOR)):
                continue
            if ziel not in ziele:
                ziele.append(ziel)
            tage.setdefault(tag.isoformat(), set()).add((int(t.timestamp() // 60), ziele.index(ziel)))
    if not tage or sum(len(v) for v in tage.values()) < 20:
        raise SystemExit("zu wenige S4-Fahrten im Fahrplan gefunden – nichts geändert")
    return {
        "quelle": "Soll-Fahrplan des MVV (offene Fahrplandaten, CC BY 4.0)",
        "version": info.get("feed_version", ""),
        "gueltigBis": info.get("feed_end_date", ""),
        "ziele": ziele,
        # je Tag: [Abfahrt in Minuten seit 1970 (UTC), Ziel als Nummer in „ziele“]
        "tage": {d: [list(x) for x in sorted(v)] for d, v in sorted(tage.items())},
    }


def main():
    roh, geaendert = laden()
    heute = datetime.now(timezone.utc).astimezone(BERLIN).date()
    d = auswerten(roh, heute)
    if geaendert:
        try:
            d["stand"] = datetime.strptime(geaendert, "%a, %d %b %Y %H:%M:%S %Z").strftime("%Y-%m-%d")
        except ValueError:
            pass
    alt = None
    try:
        alt = json.loads(OUT.read_text())
    except (OSError, ValueError):
        pass
    if alt == d:
        print("Soll-Fahrplan unverändert")
        return
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n")
    n = sum(len(v) for v in d["tage"].values())
    print(f"Soll-Fahrplan gespeichert: {len(d['tage'])} Tage, {n} Fahrten, Version {d['version'] or '?'}")


if __name__ == "__main__":
    main()
