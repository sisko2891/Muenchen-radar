#!/usr/bin/env python3
"""Termine der nächsten 14 Tage holen, mit KALENDER_PASS verschlüsseln -> data/kalender.enc.json.

Gespeichert werden nur Titel, Zeit, Ganztägig-Flag und Farbe (keine Notizen, Orte, Teilnehmer).
Im Protokoll erscheinen nie Inhalte, nur Zählwerte und Feldnamen.
Aufruf:  fetch_kalender.py           -> Datei schreiben
         fetch_kalender.py --stats   -> nur Struktur und Zählwerte (Test)
"""
import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_privat import encrypt  # gleiche Verschlüsselung wie bei den Diensten

BASE = "https://timetreeapp.com"
OUT = Path(__file__).resolve().parent.parent / "data" / "kalender.enc.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
TZ = ZoneInfo("Europe/Berlin")
DAYS = 16  # etwas Vorlauf, falls ein Abruf ausfällt
PAD_TO = 64000

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = ""


def call(method, path, body=None, query=None):
    url = BASE + "/api" + path + ("?" + urllib.parse.urlencode(query) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json",
        "X-TimeTreeA": "web/2.1.0/de", "X-CSRF-Token": csrf,
    })
    with op.open(req, timeout=40) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def login():
    global csrf
    email, pw = os.environ.get("TIMETREE_EMAIL", ""), os.environ.get("TIMETREE_PASS", "")
    if not email or not pw:
        raise SystemExit("übersprungen: TimeTree-Zugangsdaten fehlen")
    req = urllib.request.Request(BASE + "/signin", headers={"User-Agent": UA})
    with op.open(req, timeout=40) as r:
        page = r.read().decode("utf-8", "replace")
    m = re.search(r'<meta name="csrf-token" content="([^"]+)"', page)
    csrf = m.group(1) if m else ""
    try:
        call("PUT", "/v1/auth/email/signin", {"uid": email, "password": pw, "uuid": uuid.uuid4().hex})
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Login fehlgeschlagen (HTTP {e.code})")


def calendars():
    for path in ("/v2/calendars", "/v1/calendars"):
        try:
            d = call("GET", path, query={"since": 0})
        except urllib.error.HTTPError:
            continue
        cals = d.get("calendars") if isinstance(d, dict) else d
        if cals:
            return cals, path, d
    return [], None, {}


def labels(cal_id):
    try:
        d = call("GET", f"/v1/calendar/{cal_id}/labels")
    except urllib.error.HTTPError:
        return {}
    items = (d.get("calendar_labels") or d.get("labels") or []) if isinstance(d, dict) else d
    return {str(l.get("id")): l.get("color") for l in items or [] if isinstance(l, dict)}


def events(cal_id):
    out, since = [], 0
    for _ in range(50):
        d = call("GET", f"/v1/calendar/{cal_id}/events/sync", query={"since": since})
        out += d.get("events") or []
        if not d.get("chunk"):
            break
        since = d.get("since", since)
    return out


def color_css(c):
    if isinstance(c, int):
        return "#%06x" % (c & 0xFFFFFF)
    if isinstance(c, str) and re.match(r"^#?[0-9a-fA-F]{6}$", c):
        return c if c.startswith("#") else "#" + c
    return None


def expand(ev, start, end):
    """Liefert (Beginn, Ende) aller Vorkommen im Zeitraum; Wiederholungen per RRULE."""
    from dateutil.rrule import rrulestr
    s = datetime.fromtimestamp(ev["start_at"] / 1000, timezone.utc)
    e = datetime.fromtimestamp(ev["end_at"] / 1000, timezone.utc)
    tz = TZ if not ev.get("all_day") else timezone.utc
    try:
        tz = ZoneInfo(ev.get("start_timezone") or "Europe/Berlin") if not ev.get("all_day") else timezone.utc
    except Exception:
        pass
    s_local, dur = s.astimezone(tz), e - s
    ex = timedelta(days=1) if ev.get("all_day") else timedelta(0)  # ganztägig: Ende ist inklusive
    rec = [r for r in (ev.get("recurrences") or []) if r]
    if not rec:
        return [(s, e)] if s < end and e + ex > start else []
    text = "DTSTART:" + s_local.strftime("%Y%m%dT%H%M%S") + "\n" + "\n".join(rec)
    try:
        rule = rrulestr(text, forceset=True, ignoretz=True)
    except Exception:
        return [(s, e)] if s < end and e + ex > start else []
    lo = (start - dur - ex).astimezone(tz).replace(tzinfo=None)
    hi = end.astimezone(tz).replace(tzinfo=None)
    res = []
    for occ in rule.between(lo, hi, inc=True):
        o = occ.replace(tzinfo=tz).astimezone(timezone.utc)
        res.append((o, o + dur))
    return res


def build(stats=False):
    login()
    cals, path, raw = calendars()
    now = datetime.now(timezone.utc)
    start = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    end = start + timedelta(days=DAYS)
    if stats:
        print("Kalenderliste über", path, "| Anzahl:", len(cals))
        if isinstance(raw, dict):
            print("Antwort-Schlüssel:", sorted(raw.keys()))
        if cals:
            print("Kalender-Felder:", sorted(cals[0].keys()))
    out, kal, cnt = [], [], Counter()
    for c in cals:
        cid = c.get("id")
        if cid is None or c.get("deactivated_at"):
            continue
        lab = labels(cid)
        evs = events(cid)
        kal.append({"id": str(cid), "name": c.get("name") or "", "farbe": color_css(c.get("color"))})
        if stats and evs:
            print("Event-Felder:", sorted(evs[0].keys()))
            print("Label-Farben (Typen):", Counter(type(v).__name__ for v in lab.values()))
        cnt["events"] += len(evs)
        overrides = {(x.get("recurring_uuid"), x.get("start_at")) for x in evs if x.get("parent_id")}
        for ev in evs:
            if ev.get("deactivated_at") or not ev.get("start_at") or not ev.get("end_at"):
                cnt["gelöscht/leer"] += 1
                continue
            if ev.get("category") not in (None, 1):
                cnt["kein Termin (Kategorie)"] += 1
                continue
            if ev.get("recurrences"):
                cnt["wiederkehrend"] += 1
            allday = bool(ev.get("all_day"))
            if allday:
                cnt["ganztägig"] += 1
                cnt["ganztägig Ende=Beginn"] += ev["end_at"] == ev["start_at"]
                cnt["ganztägig UTC-Mitternacht"] += ev["start_at"] % 86400000 == 0
            for s, e in expand(ev, start, end):
                ls, le = s.astimezone(TZ), e.astimezone(TZ)
                if allday:
                    # TimeTree: Datum steht als Mitternacht (UTC), das Ende ist der letzte Tag selbst (inklusive);
                    # +12 h fängt auch Mitternacht lokaler Zeit ab
                    d0, d1 = (s + timedelta(hours=12)).date(), (e + timedelta(hours=12)).date()
                out.append({
                    "d": (d0 if allday else ls.date()).isoformat(),
                    "bis_d": (max(d0, d1) if allday else le.date()).isoformat(),
                    "von": None if allday else ls.strftime("%H:%M"),
                    "bis": None if allday else le.strftime("%H:%M"),
                    "ganztag": allday,
                    "titel": (ev.get("title") or "").strip(),
                    "farbe": color_css(lab.get(str(ev.get("label_id")))) or color_css(c.get("color")),
                    "kal": str(cid),
                })
    out.sort(key=lambda t: (t["d"], not t["ganztag"], t["von"] or ""))
    print("Zählwerte:", dict(cnt), "| Termine im Zeitraum:", len(out),
              "| ganztägig:", sum(t["ganztag"] for t in out),
              "| mit Farbe:", sum(1 for t in out if t["farbe"]))
    return {"stand": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "kalender": kal, "termine": out}


def main():
    if "--stats" in sys.argv:
        build(stats=True)
        return
    pw = os.environ.get("KALENDER_PASS", "")
    if len(pw) < 8:
        raise SystemExit("übersprungen: KALENDER_PASS fehlt oder ist zu kurz")
    data = build()
    import fetch_privat
    fetch_privat.PAD_TO = PAD_TO
    OUT.write_text(json.dumps(encrypt(data, pw)))
    print("gespeichert:", len(data["termine"]), "Termine (verschlüsselt)")


if __name__ == "__main__":
    main()
