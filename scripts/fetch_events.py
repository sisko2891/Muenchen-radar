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
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "events.json"
SEEN = OUT.with_name("events-seen.json")   # Merkliste des Abgleichs (wann welche Kennung zuerst/zuletzt gesehen wurde); nicht Teil der Seite
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
        kopf = re.search(r'm-event-list-item__headline"[^>]*>.*?<span>(.*?)</span>', block, re.S)
        if not m and not kopf:
            continue
        title = clean(m.group(2) if m else kopf.group(1))
        end = re.search(r'itemprop="endDate" datetime="([^"]+)"', block)
        when = re.search(r'icon-calendar"></use>\s*</svg>(.*?)</p>', block, re.S)
        d = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", when.group(1) if when else "")
        start = f"{d.group(3)}-{d.group(2)}-{d.group(1)}" if d else None
        loc = re.search(r'itemprop="location">(.*?)</p>', block, re.S)
        cat = re.search(r'm-event-list-item__category">(.*?)</p>', block, re.S)
        if m:
            url, key = m.group(1), m.group(1)
        else:   # Eintrag ohne eigene Seite: Ticket-Link; Kennung aus Titel + letztem Tag + Ort (eine Zeile je Spielserie)
            tick = re.search(r'<a href="(https?://[^"]+)"[^>]*>\s*<span>Tickets</span>', block)
            url = html.unescape(tick.group(1)) if tick else MDE + "/veranstaltungen/event"
            key = slug(title) + ":" + (end.group(1)[:10] if end else start or "") + ":" + slug(clean(loc.group(1)) if loc else "")[:30]
        if not title:
            continue
        out.append({
            "id": "mde:" + key,
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
        if not m:
            # Listeneintrag ohne eigene Seite: rutscht nur mit der Zeit ins Datumsfenster der Liste – gilt nie als „neu angekündigt“
            out[-1]["fenster"] = True
    return out


def fetch_mde():
    events = []
    heute = NOW.astimezone(ZoneInfo("Europe/Berlin")).date()
    a, b = heute.isoformat(), (heute + timedelta(days=6)).isoformat()
    letzte = 0
    for page in range(25):          # Obergrenze; tatsächlich so viele Seiten, wie der Blätterer nennt
        h = get(f"{MDE}/veranstaltungen/event/termine-der-woche?search=1&type=intro"
                f"&field_subevent_start_date_value_1={a}&field_subevent_end_date_value={b}&page={page}")
        if 'class="m-event-list-item"' not in h:   # Seite ohne Einträge: Ende der Liste
            break
        part = parse_mde(h, "woche")
        events += [e for e in part if not e["start"] or e["start"] <= b]   # die Liste führt am Ende auch spätere Termine
        letzte = max([letzte] + [int(x) for x in re.findall(r"[?&;]page=(\d+)", h)])
        if page >= letzte:
            break
    # Fällt eine Rubrik aus (Zeitüberschreitung, geänderte Seite), gilt die ganze Quelle als gescheitert: Dann bleiben
    # alle bisherigen Einträge stehen und die Seite zeigt die Quelle als gestört – statt die Rubrik still zu verlieren.
    for path, tag in (("rock-pop", "konzert"), ("konzerte", "konzert"), ("musical", "show"), ("theater", "show")):
        part = parse_mde(get(f"{MDE}/veranstaltungen/event/{path}"), tag)
        if not part:
            raise RuntimeError(f"Rubrik {path}: 0 Einträge gelesen (Seite geändert?)")
        events += part
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
        bis = re.search(r'date-end" datetime="([^"]+)"', art)
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
            "end": bis.group(1)[:10] if bis else None,
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
    tage = {}
    heute = NOW.astimezone(ZoneInfo("Europe/Berlin")).date()
    for m in re.finditer(r'data-performance-ids=\[([^\]]*)\]>.*?prog-nav__day">([^<]*)<', page, re.S):
        lab = m.group(2).strip()
        if lab.startswith("Heute"):
            dt = heute
        elif lab.startswith("Morgen"):
            dt = heute + timedelta(days=1)
        else:
            mm = re.search(r"(\d{1,2})\.(\d{1,2})\.", lab)
            if not mm:
                continue
            try:
                dt = date(heute.year, int(mm.group(2)), int(mm.group(1)))
                if dt < heute - timedelta(days=60):
                    dt = dt.replace(year=heute.year + 1)
            except ValueError:
                continue
        ts = {times[x.strip()] for x in m.group(1).split(",") if x.strip() in times}
        tage.setdefault(dt, set()).update(ts)
    return [(dt, sorted(ts)) for dt, ts in sorted(tage.items())]   # ein Eintrag je Spieltag, auch bei mehreren Filmen


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
    # dieselbe (einzige) Quelle nennt zwei verschiedene Uhrzeiten: zwei Vorstellungen, kein Doppel
    if a.get("source") == b.get("source") and ", " not in (a.get("source") or "") and a.get("when") and b.get("when") and a["when"] != b["when"]:
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
        qs = lambda x: x["source"].split(", ")
        rang = lambda x: (x["title"].isupper(), min(QUELLEN_RANG.index(q) if q in QUELLEN_RANG else 9 for q in qs(x)), -len(x.get("when") or ""), len(x["title"]))
        best = dict(sorted(g, key=rang)[0])
        aelteste = min(g, key=lambda x: x.get("firstSeen") or "9")
        best["id"] = aelteste["id"]                      # stabile Kennung, damit „neu“ nicht erneut auftaucht
        best["firstSeen"] = aelteste.get("firstSeen")
        best["tag"] = ",".join(sorted({t for x in g for t in (x.get("tag") or "").split(",") if t}))
        best["source"] = ", ".join(sorted({q for x in g for q in qs(x)}, key=lambda q: QUELLEN_RANG.index(q) if q in QUELLEN_RANG else 9))
        best["presale"] = best.get("presale") or next((x.get("presale") for x in g if x.get("presale")), None)
        best["cancelled"] = all(x.get("cancelled") for x in g)
        if best.get("presale") is None:
            best.pop("presale", None)
        out.append(best)
    return out


def main():
    stamp = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        alt = json.loads(OUT.read_text())
        old = {e["id"]: e for e in alt["events"]}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        alt, old = {}, {}
    try:   # Kennung -> [zuerst, zuletzt gesehen]; eigene Datei, die die Seite nie lädt (früher Teil von events.json)
        roh = json.loads(SEEN.read_text()) if SEEN.exists() else alt.get("seen")
        seen = {k: list(v) for k, v in (roh or {}).items()}
    except (OSError, ValueError, TypeError, AttributeError):
        seen = {}
    # erster Lauf nach der Umstellung (Datei noch ohne „seen“): neu lesbare Einträge gelten nicht als neu angekündigt
    neu_ab = stamp if not old or seen else min(e.get("firstSeen") or stamp for e in old.values())
    for e in old.values():   # Übernahme aus Dateien ohne „seen“
        seen.setdefault(e["id"], [e.get("firstSeen") or stamp, stamp])
    basis = min((e.get("firstSeen") or stamp for e in old.values()), default=stamp)   # ältester Zeitstempel = gilt auf der Seite nie als neu
    hat = lambda e2, name: name in e2["source"].split(", ")
    events, status = [], {}
    for name, fn in (("muenchen.de", fetch_mde), ("Olympiapark", fetch_olympiapark),
                     ("MünchenMusik", fetch_muenchenmusik), ("Mathäser", fetch_mathaeser_events),
                     ("Ticketmaster", fetch_ticketmaster)):
        try:
            got = fn()
            if not got and any(hat(e2, name) for e2 in old.values()):
                raise RuntimeError("0 Events gelesen (Seite geändert?) – alte Einträge bleiben")
            status[name] = {"ok": True, "count": len(got)}
            events += got
        except Exception as e:
            print(name, "FEHLER", e, file=sys.stderr)
            status[name] = {"ok": False, "error": str(e)[:200]}
            # alte Daten dieser Quelle behalten
            events += [e2 for e2 in old.values() if hat(e2, name)]

    iso = lambda v: v if isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v) else None
    uniq = {}
    for e in events:
        e["start"], e["end"] = iso(e.get("start")), iso(e.get("end"))   # Datumswerte nur in der Form JJJJ-MM-TT übernehmen
        if e["id"] in uniq:  # gleiches Event in mehreren Listen: Tags zusammenführen
            tags = set(uniq[e["id"]]["tag"].split(",")) | set(e["tag"].split(","))
            uniq[e["id"]]["tag"] = ",".join(sorted(tags))
            continue
        fenster = e.pop("fenster", False)
        e["firstSeen"] = seen.get(e["id"], [basis if fenster else neu_ab])[0]
        seen[e["id"]] = [e["firstSeen"], stamp]
        uniq[e["id"]] = e
    merged = dedupe(list(uniq.values()))
    print("Doppelte über Quellen zusammengeführt:", len(uniq) - len(merged))
    uniq = {e["id"]: e for e in merged}
    # vergangene Events raus
    today = NOW.astimezone(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
    grenze = (NOW - timedelta(days=45)).strftime("%Y-%m-%dT%H:%M:%SZ")
    seen = {k: v for k, v in seen.items() if v[1] >= grenze}
    keep = [e for e in uniq.values() if not (e.get("end") or e.get("start")) or (e.get("end") or e.get("start")) >= today]
    keep.sort(key=lambda e: (e.get("start") or "9999", e["title"]))
    OUT.parent.mkdir(exist_ok=True)
    # ohne Einrückung und ohne die Merkliste „seen“: Die Seite lädt diese Datei stündlich, gebraucht wird nur das hier
    kompakt = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    SEEN.write_text(kompakt(seen))
    OUT.write_text(kompakt({"updated": stamp, "sources": status, "events": keep}))
    print(f"{len(keep)} Events gespeichert", status)


if __name__ == "__main__":
    main()
