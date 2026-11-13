#!/usr/bin/env python3
"""Pollenflug-Gefahrenindex des DWD (offene Daten) für Oberbayern/München -> data/pollen.json.

Aufruf:  fetch_pollen.py            -> vom DWD laden
         fetch_pollen.py datei.json -> lokale Datei verwenden (Test)
"""
import json, re, sys, urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

URL = "https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json"
OUT = Path(__file__).resolve().parent.parent / "data" / "pollen.json"
STUFE = {"0": 0, "0-1": 0.5, "1": 1, "1-2": 1.5, "2": 2, "2-3": 2.5, "3": 3}
NAME = {"Graeser": "Gräser", "Beifuss": "Beifuß"}


def laden():
    if len(sys.argv) > 1:
        return json.loads(Path(sys.argv[1]).read_text())
    req = urllib.request.Request(URL, headers={"User-Agent": "katzingers-castle/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    d = laden()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", d.get("last_update", ""))
    if not m:
        raise SystemExit("Ausgabedatum fehlt – alte Datei bleibt")
    tag0 = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    inhalt = d.get("content") or []
    # München liegt in der Teilregion „Allgäu/Oberbayern/Bay. Wald“ (121)
    reg = (next((c for c in inhalt if c.get("partregion_id") == 121), None)
           or next((c for c in inhalt if "Oberbayern" in (c.get("partregion_name") or "")), None)
           or next((c for c in inhalt if c.get("region_id") == 120), None))
    if not reg:
        raise SystemExit("Region Oberbayern nicht gefunden – alte Datei bleibt")
    tage = {}
    for off, key in ((0, "today"), (1, "tomorrow"), (2, "dayafter_to")):
        werte = {}
        for art, v in (reg.get("Pollen") or {}).items():
            s = STUFE.get(str(v.get(key, "-1")).strip())
            if s is not None:
                werte[NAME.get(art, art)] = s
        if werte:
            tage[(tag0 + timedelta(days=off)).isoformat()] = werte
    OUT.write_text(json.dumps({"stand": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "ausgabe": d.get("last_update"), "region": reg.get("partregion_name") or reg.get("region_name"),
                               "tage": tage}, ensure_ascii=False, indent=1))
    print("Pollen gespeichert:", len(tage), "Tage,", reg.get("partregion_name"),
          "| belastet heute:", sum(1 for v in tage.get(tag0.isoformat(), {}).values() if v > 0))


if __name__ == "__main__":
    main()
