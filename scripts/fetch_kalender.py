#!/usr/bin/env python3
"""Termine der nächsten 14 Tage holen, mit KALENDER_PASS verschlüsseln und im geschützten Speicher ablegen (Dienst `daten/`).

Gespeichert werden nur Titel, Zeit, Ganztägig-Flag und Farbe (keine Notizen, Orte, Teilnehmer, Kalendernamen).
Im öffentlichen Projekt und im öffentlichen Protokoll erscheint davon nichts – weder Inhalte noch Zählwerte.
Aufruf:  fetch_kalender.py   -> abrufen und ablegen
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daten  # noqa: E402 – geschützter Speicher
from fetch_privat import (FEHLER_PAUSE_H, SOFORT, encrypt, jetzt,  # noqa: E402 – gleiche Verschlüsselung wie bei den Diensten
                          verlauf_lesen, verlauf_schreiben)

BASE = "https://timetreeapp.com"
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
    fehler = "leere Liste"
    for path in ("/v2/calendars", "/v1/calendars"):
        try:
            d = call("GET", path, query={"since": 0})
        except urllib.error.HTTPError as e:
            fehler = f"HTTP {e.code}"
            continue
        cals = d.get("calendars") if isinstance(d, dict) else d
        if cals:
            return cals, path, d
    # nichts erhalten (Störung bei TimeTree): abbrechen, damit der bisherige Stand nicht durch einen leeren ersetzt wird
    raise SystemExit(f"keine Kalender erhalten ({fehler})")


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
    # im Zeitraum: endet nach dessen Beginn – oder hat keine Dauer und liegt darin (z. B. eine Erinnerung um 0:00 Uhr heute)
    einzeln = [(s, e)] if s < end and (e + ex > start or (e == s and s >= start)) else []
    if not rec:
        return einzeln
    lokal = lambda m: datetime.strptime(m, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc).astimezone(tz).replace(tzinfo=None)
    regeln, aus_zeit, aus_tag = [], set(), set()
    try:   # ungültige Datumsangaben (z. B. „…T240000Z“ oder der 31.11.) dürfen nicht den ganzen Abgleich abbrechen
        for r in rec:
            kopf, _, wert = r.partition(":")
            if kopf.upper().startswith("EXDATE"):   # Ausnahmen selbst auswerten: UTC („…Z“), mit TZID, ohne Zone oder nur Datum
                for v in wert.split(","):
                    m = re.match(r"^(\d{8})(?:T(\d{6})(Z?))?$", v.strip())
                    if not m:
                        continue
                    if not m.group(2):
                        aus_tag.add(m.group(1))
                        continue
                    aus_zeit.add(datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S"))     # als Ortszeit gemeint
                    if m.group(3):
                        aus_zeit.add(lokal(m.group(1) + "T" + m.group(2)))                      # als UTC gemeint
            else:   # UNTIL in UTC auf die Ortszeit der Serie umrechnen (die Regel wird ohne Zone gerechnet)
                r = re.sub(r"UNTIL=(\d{8}T\d{6})Z", lambda m: "UNTIL=" + lokal(m.group(1)).strftime("%Y%m%dT%H%M%S"), r)
                regeln.append(re.sub(r"UNTIL=(\d{8})(?=;|$)", r"UNTIL=\1T235959", r))   # nur Datum: der Tag zählt mit
    except (ValueError, OverflowError):
        return einzeln
    text = "DTSTART:" + s_local.strftime("%Y%m%dT%H%M%S") + "\n" + "\n".join(regeln)
    lo = (start - dur - ex).astimezone(tz).replace(tzinfo=None)
    hi = end.astimezone(tz).replace(tzinfo=None)
    try:   # eine ungewöhnliche Wiederholungsregel darf nicht den ganzen Abgleich abbrechen
        vorkommen = rrulestr(text, forceset=True, ignoretz=True).between(lo, hi, inc=True)
    except Exception:
        return einzeln
    res = []
    for occ in vorkommen:
        if occ in aus_zeit or occ.strftime("%Y%m%d") in aus_tag:
            continue
        o = occ.replace(tzinfo=tz).astimezone(timezone.utc)
        if o < end and (o + dur + ex > start or (not dur and o >= start)):   # gleiche Grenzen wie bei Einzelterminen
            res.append((o, o + dur))
    return res


def build():
    login()
    cals, _, _ = calendars()
    now = datetime.now(timezone.utc)
    start = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    end = start + timedelta(days=DAYS)
    out, anzahl = [], 0
    for c in cals:
        cid = c.get("id")
        if cid is None or c.get("deactivated_at"):
            continue
        lab = labels(cid)
        evs = events(cid)
        anzahl += len(evs)
        for ev in evs:
            if ev.get("deactivated_at") or not ev.get("start_at") or not ev.get("end_at"):
                continue
            if ev.get("category") not in (None, 1):   # nur Termine (keine Notizen/Aufgaben)
                continue
            allday = bool(ev.get("all_day"))
            for s, e in expand(ev, start, end):
                ls, le = s.astimezone(TZ), e.astimezone(TZ)
                if allday:
                    # TimeTree: Datum steht als Mitternacht (UTC), das Ende ist der letzte Tag selbst (inklusive);
                    # +12 h fängt auch Mitternacht lokaler Zeit ab
                    d0, d1 = (s + timedelta(hours=12)).date(), (e + timedelta(hours=12)).date()
                mitternacht = not allday and le > ls and (le.hour, le.minute, le.second) == (0, 0, 0)
                if mitternacht:   # endet um 0:00 Uhr: gehört zum Vortag, sonst stünde der Termin am Folgetag noch einmal da
                    le -= timedelta(minutes=1)
                out.append({
                    "d": (d0 if allday else ls.date()).isoformat(),
                    "bis_d": (max(d0, d1) if allday else le.date()).isoformat(),
                    "von": None if allday else ls.strftime("%H:%M"),
                    "bis": None if allday else "24:00" if mitternacht else le.strftime("%H:%M"),
                    "ganztag": allday,
                    "titel": (ev.get("title") or "").strip(),
                    "farbe": color_css(lab.get(str(ev.get("label_id")))) or color_css(c.get("color")),
                })
    if not anzahl:   # die Synchronisation liefert sonst den gesamten Bestand, auch Vergangenes
        raise SystemExit("keine Termine erhalten")
    out.sort(key=lambda t: (t["d"], not t["ganztag"], t["von"] or ""))
    return {"stand": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "termine": out}


KAL_MIN_ABSTAND_H = 2   # kürzer als der normale Takt (etwa 3 h): verhindert nur doppelte Abrufe


def main():
    pw = os.environ.get("KALENDER_PASS", "")
    if not daten.eingerichtet():
        print("übersprungen: geschützter Speicher ist noch nicht veröffentlicht")
        return
    if not os.environ.get("TIMETREE_EMAIL") or not os.environ.get("TIMETREE_PASS") or len(pw) < 8:
        print("übersprungen: TimeTree-Zugangsdaten oder KALENDER_PASS fehlen (Passwort mindestens 8 Zeichen)")
        return
    if not daten.aktiv():
        raise SystemExit("Schlüssel für den geschützten Speicher fehlt (wird aus CLOUDFLARE_API_TOKEN abgeleitet)")
    verlauf = verlauf_lesen()
    if not SOFORT and jetzt() - (verlauf.get("kal_fehler_t") or 0) < FEHLER_PAUSE_H * 3600:
        print(f"Letzter Abruf ist gescheitert – nächster Versuch frühestens {FEHLER_PAUSE_H} h danach (oder manuell starten)")
        return
    # starten zwei Läufe fast gleichzeitig (Zeitplan bei GitHub und Zeitgeber bei Cloudflare), meldet sich nur der erste bei TimeTree an
    if not SOFORT and 0 <= jetzt() - (verlauf.get("kal_t") or 0) < KAL_MIN_ABSTAND_H * 3600 and daten.lesen("kalender", pw)[0] is not None:
        print(f"Termine sind jünger als {KAL_MIN_ABSTAND_H} h – übersprungen")
        daten.bild_pflegen("k", pw)
        return
    try:
        data = build()
    except (Exception, SystemExit) as e:  # noqa: BLE001 – Inhalte des Fehlers bleiben aus dem Protokoll
        grund = str(e) if isinstance(e, SystemExit) else type(e).__name__
        try:
            verlauf_schreiben({**verlauf_lesen(), "kal_fehler_t": jetzt()})
        except Exception:  # noqa: BLE001
            pass
        raise SystemExit(f"Abruf der Termine gescheitert ({grund}) – der bisherige Stand bleibt") from None
    daten.schreiben("kalender", encrypt(data, pw, PAD_TO), {"k": pw})
    v = verlauf_lesen()
    v.pop("kal_fehler_t", None)
    v["kal_t"] = jetzt()
    verlauf_schreiben(v)
    daten.bild_pflegen("k", pw)
    print("Termine gespeichert (verschlüsselt, im geschützten Speicher)")


if __name__ == "__main__":
    main()
