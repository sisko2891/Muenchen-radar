#!/usr/bin/env python3
"""Holt die eigenen Einträge, verschlüsselt sie mit der PIN und schreibt data/privat.enc.json.

Im Protokoll erscheinen nie Inhalte, nur Zählwerte.
Verschlüsselung: PBKDF2-SHA256 (600 000 Runden) + AES-256-GCM, im Browser per WebCrypto lesbar.
Aufruf:  fetch_privat.py           -> Datei schreiben
         fetch_privat.py --stats   -> nur Zählwerte ausgeben (Test)
"""
import base64
import http.cookiejar
import json
import os
import re
import secrets
import sys
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "https://profahr.mvg.de"
READ = "/bik/schedules/duty/week/weekItems-read"
OUT = Path(__file__).resolve().parent.parent / "data" / "privat.enc.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
PAD_TO = 48000  # feste Größe, damit die Dateigröße nichts verrät (mit Historie)
ITER = 600_000

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
op.addheaders = [("User-Agent", UA), ("Accept-Language", "de-DE,de;q=0.9"),
                 ("X-Requested-With", "XMLHttpRequest")]


def req(path, data=None):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    with op.open(urllib.parse.urljoin(BASE, path), body, timeout=40) as r:
        return r.read().decode("utf-8", "replace")


def login():
    user, pw = os.environ.get("PROFAHR_USER", ""), os.environ.get("PROFAHR_PASS", "")
    if not user or not pw:
        raise SystemExit("übersprungen: Zugangsdaten fehlen")
    req("/bik/signin")
    page = req("/bik/signIn", {"AccountName": user, "Password": pw})
    if 'id="loginForm"' in page:
        raise SystemExit("Login fehlgeschlagen")
    req("/bik/schedules/duty/week")


def read_items(extra=None):
    params = {"sort": "", "page": "1", "pageSize": "500", "group": "", "filter": ""}
    params.update(extra or {})
    d = json.loads(req(READ, params))
    return d.get("Data") or []


def item_date(it):
    m = re.search(r"/Date\((-?\d+)", it.get("Date") or "")
    if m:
        # .NET liefert Mitternacht lokaler Zeit; +12 h verhindert Verrutschen über UTC
        return (datetime.fromtimestamp(int(m.group(1)) / 1000, timezone.utc) + timedelta(hours=12)).date()
    m = re.match(r"(\d{2})\.(\d{2})\.(\d{4})", it.get("DateString") or "")
    return date(int(m.group(3)), int(m.group(2)), int(m.group(1))) if m else None


def hhmm(s):
    m = re.search(r"(\d{1,2}):(\d{2})", s or "")
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


def normalize(items):
    out = []
    for it in items:
        d = item_date(it)
        if not d:
            continue
        desc = (it.get("ActivityDescription") or "").strip()
        start, end = hhmm(it.get("StartTime")), hhmm(it.get("EndTime"))
        text = " ".join(str(it.get(k) or "") for k in ("ActivityDescription", "Remark", "DriverInformationStatusDisplayName"))
        out.append({
            "d": d.isoformat(),
            "name": desc,
            "von": start,
            "bis": end,
            "ueber": bool(start and end and end <= start),  # endet am Folgetag
            "gesperrt": bool(re.search(r"gesperrt", text, re.I)),
            "bem": (it.get("Remark") or "").strip(),
        })
    # doppelte Zeilen entfernen, sortieren
    seen, res = set(), []
    for e in sorted(out, key=lambda e: (e["d"], e["von"] or "")):
        k = (e["d"], e["name"], e["von"], e["bis"])
        if k not in seen:
            seen.add(k)
            res.append(e)
    return res


TURBO = ["04:30", "22:30", "19:30", "14:30"]  # feste Abfolge der 4-Tage-Woche (Beginnzeiten)


def _turbo_idx(e):
    """Position einer Dienstzeile in der Turbo-Abfolge (0–3) oder None; 30 min Toleranz."""
    if not e["von"]:
        return None
    m = int(e["von"][:2]) * 60 + int(e["von"][3:])
    for k, t in enumerate(TURBO):
        if abs(m - (int(t[:2]) * 60 + int(t[3:]))) <= 30:
            return k
    return None


def fix_turbo(entries):
    """Turbo-Woche: 4 Dienste in 3 Tagen (04:30, 22:30, 19:30, 14:30). Profahr führt jeden Dienst in einer
    eigenen Tageszeile, tatsächlich beginnen Dienst 2–4 aber einen Kalendertag früher.
    Erkennung über die Nachbarn: Ein Dienst gehört zur Folge, wenn der Vortag den vorherigen oder der
    Folgetag den nächsten Dienst der Abfolge hat. So klappt es auch, wenn die Folge vor heute begonnen hat
    (Profahr liefert erst ab heute). Alle anderen Wochen bleiben täglich."""
    by_day = {}
    for e in entries:
        by_day.setdefault(e["d"], []).append(e)
    days = sorted(by_day)
    first = days[0] if days else None
    shift = lambda d, n: (date.fromisoformat(d) + timedelta(days=n)).isoformat()

    def k_of(d):
        ks = [_turbo_idx(e) for e in by_day.get(d, []) if e["von"]]
        return ks[0] if len(ks) == 1 else None

    def gesperrt(d):
        es = by_day.get(d, [])
        return bool(es) and all(e["gesperrt"] for e in es)

    rolle = {}  # Tag -> Position in der Folge (1–3 werden vorgezogen)
    for d in days:
        k = k_of(d)
        if k is None:
            continue
        prev, nxt = k_of(shift(d, -1)), k_of(shift(d, 1))
        dazu = (k > 0 and prev == k - 1) or (k < 3 and nxt == k + 1)
        # Folge hat vor heute begonnen: erster Datentag ist Dienst 2 oder 3, der Folgetag passt oder ist gesperrt
        if not dazu and d == first and k in (1, 2) and (nxt == k + 1 or gesperrt(shift(d, 1))):
            dazu = True
        if dazu:
            rolle[d] = k
    # gesperrter Tag direkt nach Dienst 3 ist Dienst 4
    for d, k in list(rolle.items()):
        if k == 2 and shift(d, 1) not in rolle and gesperrt(shift(d, 1)):
            rolle[shift(d, 1)] = 3
    count = sum(1 for k in rolle.values() if k == 0) or (1 if rolle else 0)
    geleert = []
    for d, k in sorted(rolle.items()):
        if k == 0:
            for e in by_day[d]:
                if e["von"]:
                    e["turbo"] = 1
            continue
        for e in by_day[d]:
            if e["von"] or e["gesperrt"]:
                e["d"] = shift(d, -1)
                e["turbo"] = k + 1
        geleert.append(d)
    # Tage, die durch das Vorziehen leer wurden, sind frei (in der Regel der letzte Tag der Folge)
    for d in geleert:
        if not any(e["d"] == d for e in entries):
            entries.append({"d": d, "name": "frei", "von": None, "bis": None,
                            "ueber": False, "gesperrt": False, "bem": "", "turbo": 5})
    return sorted(entries, key=lambda e: (e["d"], e["von"] or "99")), count


HISTORIE_TAGE = 14  # so lange werden vergangene Rohzeilen behalten (Turbo-Erkennung über den Wochenwechsel)


def decrypt(enc, pin):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    b = base64.b64decode
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b(enc["salt"]), iterations=enc["iter"]).derive(pin.encode())
    return json.loads(AESGCM(key).decrypt(b(enc["iv"]), b(enc["ct"]), None))


def roh_aus(eintraege):
    """Rohzeilen (wie Profahr sie liefert) aus fertigen Einträgen zurückgewinnen: Turbo-Vorziehen rückgängig."""
    out = []
    for e in eintraege:
        e = dict(e)
        t = e.pop("turbo", None)
        if t == 5:          # künstlicher "frei"-Tag nach dem Vorziehen
            continue
        if t in (2, 3, 4):  # wurde einen Tag vorgezogen
            e["d"] = (date.fromisoformat(e["d"]) + timedelta(days=1)).isoformat()
        out.append(e)
    return out


VORHER = OUT.with_name("privat.prev.enc.json")  # optionaler älterer Stand (einmaliger Startwert)


def historie(pin):
    """Vergangene Rohzeilen aus der vorigen (verschlüsselten) Datei – Profahr selbst liefert erst ab heute."""
    roh, seen = [], set()
    for f in (OUT, VORHER):
        if not f.exists():
            continue
        try:
            alt = decrypt(json.loads(f.read_text()), pin)
        except Exception as e:
            print("Historie nicht lesbar:", f.name, type(e).__name__)
            continue
        for e in alt.get("roh") or roh_aus(alt.get("eintraege") or []):
            k = (e.get("d"), e.get("von"), e.get("name"))
            if e.get("d") and k not in seen:
                seen.add(k)
                roh.append(e)
    grenze = (date.today() - timedelta(days=HISTORIE_TAGE)).isoformat()
    return [e for e in roh if e["d"] >= grenze]


def collect(pin=None):
    """Aktuelle Woche plus folgende Wochen (sofern der Server einen Datumsparameter akzeptiert), davor die Historie."""
    items = normalize(read_items())
    if not items:
        return items, []
    have = {e["d"] for e in items}
    last = max(date.fromisoformat(e["d"]) for e in items)
    for weeks in range(1, 6):
        target = last + timedelta(days=1 + 7 * (weeks - 1))
        got = []
        for key in ("date", "startDate", "Date"):
            try:
                cand = normalize(read_items({key: target.strftime("%d.%m.%Y")}))
            except Exception:
                cand = []
            if any(e["d"] not in have for e in cand):
                got = cand
                break
        new = [e for e in got if e["d"] not in have]
        if not new:
            break
        items += new
        have |= {e["d"] for e in new}
    erster = min(e["d"] for e in items)
    alt = [e for e in (historie(pin) if pin else []) if e["d"] < erster]
    print("Historie:", len({e["d"] for e in alt}), "Tage vor", erster)
    roh = [dict(e) for e in alt + items]
    items, n = fix_turbo([dict(e) for e in alt + items])
    print("Turbo-Folgen erkannt:", n)
    # angezeigt wird ab gestern (laufender Nachtdienst), gespeichert werden die Rohzeilen für den nächsten Abruf
    gestern = (date.today() - timedelta(days=1)).isoformat()
    return [e for e in items if e["d"] >= gestern], roh


def stats(items_raw, entries):
    today = date.today()
    ds = sorted({date.fromisoformat(e["d"]) for e in entries})
    print("Rohzeilen:", len(items_raw), "| Einträge:", len(entries), "| Tage:", len(ds))
    if ds:
        print("Zeitraum relativ zu heute: Tag", (ds[0] - today).days, "bis", (ds[-1] - today).days)
    print("Mit Uhrzeit:", sum(1 for e in entries if e["von"]), "| über Mitternacht:", sum(e["ueber"] for e in entries),
          "| gesperrt:", sum(e["gesperrt"] for e in entries))
    print("Tage mit 2+ Einträgen:", sum(1 for c in Counter(e["d"] for e in entries).values() if c > 1))
    print("DispatchedDayStatus:", dict(Counter(i.get("DispatchedDayStatus") for i in items_raw)))
    print("KindOfRow:", dict(Counter(i.get("KindOfRow") for i in items_raw)))
    print("Länge Dienstname:", dict(Counter(len((i.get("ActivityDescription") or "").strip()) for i in items_raw)))
    print("Felder mit 'gesperrt':", sorted({k for i in items_raw for k, v in i.items() if isinstance(v, str) and "gesperrt" in v.lower()}))


def encrypt(obj, pin):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    raw = raw + " " * max(0, PAD_TO - len(raw.encode()))
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(pin.encode())
    ct = AESGCM(key).encrypt(iv, raw.encode(), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b(salt), "iv": b(iv), "ct": b(ct)}


MIN_ABSTAND_H = 11  # Profahr höchstens ca. 2× täglich abfragen


def zu_frisch():
    """True, wenn die vorhandene Datei jünger als MIN_ABSTAND_H ist (Zeitstempel steht offen in der Datei)."""
    if os.environ.get("PRIVAT_SOFORT") == "1":
        return False
    try:
        t = json.loads(OUT.read_text()).get("t")
    except (OSError, ValueError):
        return False
    return bool(t) and datetime.now(timezone.utc).timestamp() - t < MIN_ABSTAND_H * 3600


def main():
    pin = os.environ.get("DIENSTE_PIN", "")
    if "--stats" not in sys.argv and zu_frisch():
        print(f"Dienste sind jünger als {MIN_ABSTAND_H} h – übersprungen")
        return
    login()
    if "--stats" in sys.argv:
        raw = read_items()
        stats(raw, normalize(raw))
        print("\nMit Folgewochen:")
        allx, _ = collect(pin if len(pin) >= 6 else None)
        stats(raw, allx)
        return
    if len(pin) < 6:
        raise SystemExit("übersprungen: DIENSTE_PIN fehlt oder ist zu kurz")
    entries, roh = collect(pin)
    if not entries:
        raise SystemExit("keine Einträge erhalten, alte Datei bleibt")
    payload = {"stand": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "eintraege": entries, "roh": roh}
    enc = encrypt(payload, pin)
    enc["t"] = int(datetime.now(timezone.utc).timestamp())  # nur der Zeitpunkt, für den Abstand zwischen Abrufen
    OUT.write_text(json.dumps(enc))
    print("gespeichert:", len(entries), "Einträge (verschlüsselt)")


if __name__ == "__main__":
    main()
