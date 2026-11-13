#!/usr/bin/env python3
"""Schulferien Bayern (öffentliche Daten) -> data/ferien.json. Erst OpenHolidays, sonst ferien-api.de."""
import json, urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "ferien.json"
UA = {"User-Agent": "katzingers-castle/1.0", "Accept": "application/json"}
von, bis = date.today() - timedelta(days=40), date.today() + timedelta(days=400)


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.loads(r.read().decode())


def openholidays():
    d = get("https://openholidaysapi.org/SchoolHolidays?countryIsoCode=DE&subdivisionCode=DE-BY&languageIsoCode=DE"
            f"&validFrom={von}&validTo={bis}")
    out = []
    for x in d:
        names = x.get("name") or []
        name = next((n["text"] for n in names if n.get("language") == "DE"), names[0]["text"] if names else "Ferien")
        out.append({"von": x["startDate"][:10], "bis": x["endDate"][:10], "name": name})
    return out


def ferienapi():
    out = []
    for y in {von.year, bis.year}:
        for x in get(f"https://ferien-api.de/api/v1/holidays/BY/{y}"):
            out.append({"von": x["start"][:10], "bis": (datetime.fromisoformat(x["end"][:19]).date()).isoformat(),
                        "name": (x.get("name") or "Ferien").replace("ferien", "ferien").title()})
    return out


def main():
    for quelle in (openholidays, ferienapi):
        try:
            f = [x for x in quelle() if x["bis"] >= von.isoformat() and x["von"] <= bis.isoformat()]
        except Exception as e:
            print(quelle.__name__, "fehlgeschlagen:", type(e).__name__)
            continue
        if f:
            f.sort(key=lambda x: x["von"])
            OUT.write_text(json.dumps({"stand": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                       "quelle": quelle.__name__, "ferien": f}, ensure_ascii=False, indent=1))
            print("Ferien gespeichert:", len(f), "über", quelle.__name__)
            return
    print("keine Ferien erhalten, alte Datei bleibt")


if __name__ == "__main__":
    main()
