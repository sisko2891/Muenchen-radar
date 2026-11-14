#!/usr/bin/env python3
"""Sammelt Events rund um München und schreibt data/events.json.

Quellen: muenchen.de (Termine der Woche + Konzerte), Olympiapark, MünchenMusik
(Neu im Vorverkauf inkl. VVK-Start), Mathäser-Kinoevents.
Merkt sich, wann ein Event zum ersten Mal auftauchte (firstSeen), damit die
Seite neu angekündigte Events markieren kann.
"""
import html
import os
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "events.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
NOW = datetime.now(timezone.utc)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "replace")


def clean(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:80]


# ---------- muenchen.de ----------
MDE = "https://www.muenchen.de"


def parse_mde(page_html, tag):
    out = []
    for block in page_html.split('class="m-event-list-item"')[1:]:
        block = block.split('class="m-listing__list-item"')[0]
        m = re.search(r'itemprop="url" href="([^"]+)"><span>(.*?)</span>', block, re.S)
        if not m:
            continue
        url, title = m.group(1), clean(m.group(2))
        end = re.search(r'itemprop="endDate" datetime="([^"]+)"', block)
        when = re.search(r'icon-calendar"></use>\s*</svg>(.*?)</p>', block, re.S)
        d = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", when.group(1) if when else "")
        start = f"{d.group(3)}-{d.group(2)}-{d.group(1)}" if d else None
        loc = re.search(r'itemprop="location">(.*?)</p>', block, re.S)
        cat = re.search(r'm-event-list-item__category">(.*?)</p>', block, re.S)
        out.append({
            "id": "mde:" + url,
            "source": "muenchen.de",
            "tag": tag,
            "title": title,
            "start": start,
            "end": end.group(1)[:10] if end else start,
            "when": clean(when.group(1)) if when else "",
            "location": clean(loc.group(1)) if loc else "",
            "category": clean(cat.group(1)) if cat else "",
            "url": url if url.startswith("http") else MDE + url,
        })
    return out


def fetch_mde():
    events = []
    from datetime import timedelta
    a, b = NOW.strftime("%Y-%m-%d"), (NOW + timedelta(days=6)).strftime("%Y-%m-%d")
    for page in range(5):
        h = get(f"{MDE}/veranstaltungen/event/termine-der-woche?search=1&type=intro"
                f"&field_subevent_start_date_value_1={a}&field_subevent_end_date_value={b}&page={page}")
        part = parse_mde(h, "woche")
        if not part:
            break
        events += part
    for path, tag in (("rock-pop", "konzert"), ("konzerte", "konzert"), ("musical", "show"), ("theater", "show")):
        try:
            events += parse_mde(get(f"{MDE}/veranstaltungen/event/{path}"), tag)
        except Exception as e:  # einzelne Kategorie darf fehlen
            print("muenchen.de", path, e, file=sys.stderr)
    return events


# ---------- Olympiapark ----------
def fetch_olympiapark():
    h = get("https://www.olympiapark.de/de/veranstaltungen/")
    out = []
    for b in re.findall(r'<script[^>]*ld\+json[^>]*>(.*?)</script>', h, re.S):
        try:
            d = json.loads(b)
        except ValueError:
            continue
        items = d.get("itemListElement", []) if isinstance(d, dict) else d
        for ev in items:
            if not isinstance(ev, dict) or ev.get("@type") != "Event":
                continue
            name = clean(ev.get("name"))
            start = (ev.get("startDate") or "")
            out.append({
                "id": "op:" + slug(name) + ":" + start[:10],
                "source": "Olympiapark",
                "tag": "konzert",
                "title": name,
                "start": start[:10] or None,
                "end": (ev.get("endDate") or "")[:10] or None,
                "when": start[11:16] + " Uhr" if len(start) >= 16 else "",
                "location": clean((ev.get("location") or {}).get("name")),
                "category": "",
                "url": "https://www.olympiapark.de/de/veranstaltungen/?q=" + urllib.request.quote(name),
                "cancelled": "Cancelled" in (ev.get("eventStatus") or ""),
            })
    return out


# ---------- MünchenMusik (VVK) ----------
def fetch_muenchenmusik():
    base = "https://www.muenchenmusik.de"
    h = get(base + "/")
    out = []
    for art in re.findall(r'<article class="event-teaser.*?</article>', h, re.S):
        title = re.search(r'event-teaser--content-headline">(.*?)</h3>', art, re.S)
        date = re.search(r'date-start" datetime="([^"]+)"', art)
        loc = re.search(r'<address[^>]*>(.*?)</address>', art, re.S)
        link = re.search(r'href="(/mm/veranstaltungen/[^"]+)"', art)
        if not title or not link:
            continue
        out.append({
            "id": "mm:" + link.group(1),
            "source": "MünchenMusik",
            "tag": "vvk",
            "title": clean(title.group(1)),
            "start": date.group(1)[:10] if date else None,
            "end": None,
            "when": "",
            "location": clean(loc.group(1)) if loc else "",
            "category": "Klassik/Konzert",
            "url": base + link.group(1),
        })
    return out


# ---------- Mathäser Kino-Events ----------
def _mat_termine(page):
    """Spieltage + Uhrzeiten von einer Mathäser-Eventseite: [(date, ['HH:MM', ...]), ...]"""
    times = {}
    for m in re.finditer(r'data-performance-id="([^"]+)"', page):
        t = re.search(r'prog2__time[^"]*"[^>]*>\s*(\d{1,2}:\d{2})', page[m.end():m.end() + 900])
        if t:
            times[m.group(1)] = t.group(1)
    out = []
    for m in re.finditer(r'data-performance-ids=\[([^\]]*)\]>.*?prog-nav__day">[^<]*?(\d{1,2})\.(\d{1,2})\.', page, re.S):
        d, mth = int(m.group(2)), int(m.group(3))
        year = NOW.year + (1 if mth < NOW.month - 2 else 0)
        try:
            dt = datetime(year, mth, d).date()
        except ValueError:
            continue
        ts = sorted({times[x.strip()] for x in m.group(1).split(",") if x.strip() in times})
        out.append((dt, ts))
    return sorted(out)


def fetch_mathaeser_events():
    base = "https://www.mathaeser.de"
    h = get(base + "/mm/events")
    out, seen = [], set()
    for path, name in re.findall(r'href="(/mm/events/detail/[^"&\']+)"[^>]*>(.*?)</a>', h, re.S):
        name = clean(name)
        if path in seen or len(name) < 3:
            continue
        seen.add(path)
        start = end = None
        when = ""
        try:
            termine = _mat_termine(get(base + path))
        except Exception:
            termine = []
        if termine:
            start, end = termine[0][0].isoformat(), termine[-1][0].isoformat()
            first = termine[0]
            when = (first[1][0] + " Uhr") if first[1] else ""
            if len(termine) > 1:
                when = (when + " · " if when else "") + f"{len(termine)} Termine"
        out.append({
            "id": "mat:" + path, "source": "Mathäser", "tag": "kino",
            "title": name, "start": start, "end": end, "when": when,
            "location": "Mathäser Filmpalast", "category": "Kino-Event",
            "url": base + path,
        })
    return out


# ---------- Ticketmaster (Konzerte mit VVK-Start) ----------
def fetch_ticketmaster():
    key = os.environ.get("TICKETMASTER_KEY", "").strip()
    if not key:
        raise RuntimeError("kein TICKETMASTER_KEY hinterlegt")
    out, page = [], 0
    while page < 5:
        q = urllib.parse.urlencode({
            "apikey": key, "latlong": "48.137,11.575", "radius": "35", "unit": "km",
            "countryCode": "DE", "classificationName": "music", "locale": "*",
            "size": "200", "page": str(page), "sort": "date,asc",
        })
        d = json.loads(get("https://app.ticketmaster.com/discovery/v2/events.json?" + q))
        for ev in d.get("_embedded", {}).get("events", []):
            start = ev.get("dates", {}).get("start", {})
            venue = (ev.get("_embedded", {}).get("venues") or [{}])[0]
            sale = ev.get("sales", {}).get("public", {}).get("startDateTime")
            t = start.get("localTime", "")
            out.append({
                "id": "tm:" + ev["id"],
                "source": "Ticketmaster",
                "tag": "konzert",
                "title": clean(ev.get("name")),
                "start": start.get("localDate"),
                "end": start.get("localDate"),
                "when": t[:5] + " Uhr" if t else "",
                "location": clean(venue.get("name")),
                "category": "",
                "url": ev.get("url", ""),
                "presale": sale[:16] if sale and not sale.startswith("1900") else None,
                "cancelled": ev.get("dates", {}).get("status", {}).get("code") == "cancelled",
            })
        pages = d.get("page", {}).get("totalPages", 1)
        page += 1
        if page >= pages:
            break
    return out


# ---------- Doppelte über Quellen hinweg zusammenführen ----------
QUELLEN_RANG = ["Olympiapark", "MünchenMusik", "Mathäser", "muenchen.de", "Ticketmaster"]


def _norm(t):
    t = (t or "").lower().replace("&", " und ").replace("ß", "ss")
    t = re.sub(r"\(.*?\)|\[.*?\]", " ", t)
    t = re.sub(r"[^a-z0-9äöü ]+", " ", t)
    return " ".join(t.split())


def _kern(t):
    """Titel ohne Tour-/Paket-Zusätze: Teil vor „:“, „ - “, „|“, „–“."""
    return _norm(re.split(r"\s[-–|]\s|:|\|", t or "", maxsplit=1)[0])


def _ort(o):
    w = [x for x in _norm(o).split() if x not in ("münchen", "muenchen", "munich", "die", "das", "der")]
    return w[0] if w else ""


def _gleich(a, b):
    if (a.get("start") or "") != (b.get("start") or "") or not a.get("start"):
        return False
    oa, ob = _ort(a.get("location")), _ort(b.get("location"))
    if oa and ob and oa != ob and not (oa.startswith(ob) or ob.startswith(oa)):
        return False
    na, nb = _norm(a["title"]), _norm(b["title"])
    ka, kb = _kern(a["title"]), _kern(b["title"])
    if na == nb or (ka and ka == kb):
        return True
    ta, tb = set(ka.split()), set(kb.split())
    return bool(ta and tb) and (ta <= set(na.split()) and ta <= set(nb.split()) or tb <= set(na.split()) and tb <= set(nb.split())) and min(len(ta), len(tb)) >= 2


def dedupe(evs):
    gruppen = []
    for e in evs:
        for g in gruppen:
            if any(_gleich(e, x) for x in g):
                g.append(e)
                break
        else:
            gruppen.append([e])
    out = []
    for g in gruppen:
        if len(g) == 1:
            out.append(g[0])
            continue
        rang = lambda x: (x["title"].isupper(), QUELLEN_RANG.index(x["source"]) if x["source"] in QUELLEN_RANG else 9, -len(x.get("when") or ""), len(x["title"]))
        best = dict(sorted(g, key=rang)[0])
        aelteste = min(g, key=lambda x: x.get("firstSeen") or "9")
        best["id"] = aelteste["id"]                      # stabile Kennung, damit „neu“ nicht erneut auftaucht
        best["firstSeen"] = aelteste.get("firstSeen")
        best["tag"] = ",".join(sorted({t for x in g for t in (x.get("tag") or "").split(",") if t}))
        best["source"] = ", ".join(sorted({x["source"] for x in g}, key=lambda q: QUELLEN_RANG.index(q) if q in QUELLEN_RANG else 9))
        best["presale"] = best.get("presale") or next((x.get("presale") for x in g if x.get("presale")), None)
        best["cancelled"] = all(x.get("cancelled") for x in g)
        if best.get("presale") is None:
            best.pop("presale", None)
        out.append(best)
    return out


def main():
    try:
        old = {e["id"]: e for e in json.loads(OUT.read_text())["events"]}
    except (OSError, ValueError, KeyError):
        old = {}
    stamp = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    events, status = [], {}
    for name, fn in (("muenchen.de", fetch_mde), ("Olympiapark", fetch_olympiapark),
                     ("MünchenMusik", fetch_muenchenmusik), ("Mathäser", fetch_mathaeser_events),
                     ("Ticketmaster", fetch_ticketmaster)):
        try:
            got = fn()
            status[name] = {"ok": True, "count": len(got)}
            events += got
        except Exception as e:
            print(name, "FEHLER", e, file=sys.stderr)
            status[name] = {"ok": False, "error": str(e)[:200]}
            # alte Daten dieser Quelle behalten
            events += [e2 for e2 in old.values() if e2["source"] == name]

    uniq = {}
    for e in events:
        if e["id"] in uniq:  # gleiches Event in mehreren Listen: Tags zusammenführen
            tags = set(uniq[e["id"]]["tag"].split(",")) | {e["tag"]}
            uniq[e["id"]]["tag"] = ",".join(sorted(tags))
            continue
        e["firstSeen"] = old.get(e["id"], {}).get("firstSeen", stamp)
        uniq[e["id"]] = e
    merged = dedupe(list(uniq.values()))
    print("Doppelte über Quellen zusammengeführt:", len(uniq) - len(merged))
    uniq = {e["id"]: e for e in merged}
    # vergangene Events raus
    today = NOW.strftime("%Y-%m-%d")
    keep = [e for e in uniq.values() if not (e.get("end") or e.get("start")) or (e.get("end") or e.get("start")) >= today]
    keep.sort(key=lambda e: (e.get("start") or "9999", e["title"]))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"updated": stamp, "sources": status, "events": keep}, ensure_ascii=False, indent=1))
    print(f"{len(keep)} Events gespeichert", status)


if __name__ == "__main__":
    main()
