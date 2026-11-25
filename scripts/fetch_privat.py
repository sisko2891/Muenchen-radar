#!/usr/bin/env python3
"""Holt die eigenen Einträge, verschlüsselt sie mit der PIN und legt sie im geschützten Speicher ab (Dienst `daten/`).

Im öffentlichen Projekt und im öffentlichen Protokoll erscheint davon nichts – weder Inhalte noch Zählwerte.
Verschlüsselung: PBKDF2-SHA256 (600 000 Runden) + AES-256-GCM, im Browser per WebCrypto lesbar.
Aufruf:  fetch_privat.py   -> abrufen und ablegen
"""
import base64
import contextlib
import http.cookiejar
import io
import json
import os
import re
import secrets
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daten  # noqa: E402 – geschützter Speicher

# Adresse des Dienstplan-Portals (mit Pfad, z. B. https://portal.example/app) kommt aus dem Secret DIENSTPLAN_URL –
# sie steht bewusst nicht im öffentlichen Projekt. Alle Wege unten sind relativ dazu.
BASE = os.environ.get("DIENSTPLAN_URL", "").strip().rstrip("/") + "/"
READ = "schedules/duty/week/weekItems-read"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
PAD_TO = 32768  # feste Größe, damit die Länge nichts verrät
ITER = 600_000

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
op.addheaders = [("User-Agent", UA), ("Accept-Language", "de-DE,de;q=0.9"),
                 ("X-Requested-With", "XMLHttpRequest")]


def req_roh(path, data=None):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    with op.open(urllib.parse.urljoin(BASE, path), body, timeout=40) as r:
        return r.read()


def req(path, data=None):
    return req_roh(path, data).decode("utf-8", "replace")


def login():
    user, pw = os.environ.get("DIENSTPLAN_USER", ""), os.environ.get("DIENSTPLAN_PASS", "")
    req("signin")
    page = req("signIn", {"AccountName": user, "Password": pw})
    if 'id="loginForm"' in page:
        raise SystemExit("Login fehlgeschlagen")
    req("schedules/duty/week")


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
        # „gesperrt“ steht im Dienstnamen bzw. im Status. Die Bemerkung zählt bewusst nicht mit: Dort kann das Wort
        # zufällig vorkommen („Haltestelle … gesperrt“) – der Tag würde sonst fälschlich als gesperrt gelten.
        text = " ".join(str(it.get(k) or "") for k in ("ActivityDescription", "DriverInformationStatusDisplayName"))
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
        # Zeilen ohne Uhrzeit („Änd“ u. Ä.) mit verschiedener Bemerkung bleiben beide; Dienste mit Uhrzeit wie bisher
        k = (e["d"], e["name"], e["von"], e["bis"], "" if e["von"] else e["bem"])
        if k not in seen:
            seen.add(k)
            res.append(e)
    return res


# ---- Stundenkonto: Zeitkonten 1–3 (Z1–Z3) und die drei Positionen der Nachtstunden des laufenden Zeitraums ----
# Die Seite lädt ihre Daten nach: erst die Abrechnungszeiträume (neuester zuerst), dann die Positionen des gewählten
# Zeitraums. Gelesen werden nur die benötigten Zeilen; ins öffentliche Protokoll gelangt davon nichts.
KONTO = "timeInformation/account/workingTimeAccount"
KONTO_PARAM = "workingTimeAccountKeyInfo"           # so fragt die Seite die Positionen eines Zeitraums ab
KONTO_Z = {1: 500, 2: 600, 3: 630}                  # Position der Zeitkonten 1–3, falls die Bezeichnung einmal abweicht
KONTO_NACHT = (90201, 90202, 90203)                 # Positionen unter „NACHTSTUNDEN“ (Monat, Jahr mit/ohne Restwert)
KONTO_FEHL_MAX = 3                                  # so oft in Folge darf das Konto unlesbar sein, bevor es gemeldet wird


def _minuten(v):
    """„12:34“, „-1:15“ → Minuten (mit Vorzeichen); None, wenn es keine Zeitangabe ist."""
    m = re.fullmatch(r"\s*([-+−]?)\s*(\d{1,5}):([0-5]\d)\s*", str(v if v is not None else ""))
    if not m:
        return None
    n = int(m.group(2)) * 60 + int(m.group(3))
    return -n if m.group(1) in ("-", "−") else n


def _konto_tag(t):
    """Beginn eines Zeitraums („/Date(ms)/“, ISO oder TT.MM.JJJJ) → Kalendertag in München; "" wenn unlesbar."""
    try:
        m = re.search(r"/Date\((-?\d{1,15})", str(t))
        if m:
            return datetime.fromtimestamp(int(m.group(1)) / 1000, ZoneInfo("Europe/Berlin")).date().isoformat()
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", str(t))
        if m:
            return date(*map(int, m.groups())).isoformat()
        m = re.search(r"\b(\d{2})\.(\d{2})\.(\d{4})\b", str(t))
        if m:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    except (OverflowError, ValueError, OSError):   # z. B. Platzhalter für „offen“ (Jahr 9999 und mehr)
        pass
    return ""


def _nacht_name(t):
    """„Stand-aktueller Monat“ → „aktueller Monat“ (Rückfall, wenn eine Zeile nicht zuzuordnen ist)."""
    t = re.sub(r"\s+", " ", str(t)).strip()
    kurz = re.sub(r"^Nacht\w*\.?\s*", "", re.sub(r"^Stand\b[\s-]*", "", t, flags=re.I), flags=re.I).strip(" -:")
    return (kurz or t)[:40]


# Die drei Nachtstunden-Zeilen des Portals, in der gewünschten Reihenfolge und mit klaren Namen:
#   „Stand-aktueller Monat“                 → Aktueller Monat
#   „Stand aktuelles Jahr (o. Restwert)“    → Dieses Jahr
#   „Stand aktuelles Jahr (mit Restwert)“   → Mit Restwert Vorjahr (dieses Jahr samt Rest aus dem Vorjahr)
NACHT_ARTEN = (("monat", "Aktueller Monat"), ("jahr", "Dieses Jahr"), ("rest", "Mit Restwert Vorjahr"))


def _nacht_art(name):
    """Nur die bekannten Portal-Bezeichnungen (genau, bis auf Groß-/Kleinschreibung und Leerzeichen) – Ähnliches wie
    „Vormonat“ oder „Vorjahr (mit Restwert)“ wird bewusst nicht zugeordnet."""
    t = re.sub(r"\s+", " ", str(name)).strip().lower()
    if re.fullmatch(r"stand ?-? ?aktuelle[rn]? monat:?", t):
        return "monat"
    m = re.fullmatch(r"stand ?-? ?aktuelles jahr ?\( ?(mit |o\. ?|ohne )restwert ?\):?", t)
    if m:
        return "rest" if m.group(1).startswith("mit") else "jahr"
    return None


def _nacht_ordnen(roh):
    """[(Portalname, Minuten)] → [{t, m}] in fester Reihenfolge. Genommen werden nur genau erkannte Zeilen; Unbekanntes
    im Abschnitt (z. B. eine neue Zeile „Vormonat“) bleibt weg. Wird gar nichts erkannt oder eine Art doppelt, bleibt es
    bei Portal-Reihenfolge und gekürzten Portalnamen – lieber unschön als falsch beschriftet."""
    bekannt = [(_nacht_art(n), m) for n, m in roh if _nacht_art(n)]
    if bekannt and len({a for a, _ in bekannt}) == len(bekannt):
        nach = dict(bekannt)
        return [{"t": t, "m": nach[a]} for a, t in NACHT_ARTEN if a in nach]
    return [{"t": _nacht_name(n), "m": m} for n, m in roh][:3]


def konto_zeilen(zeilen):
    """Aus den Positionen des Zeitraums: {"z": [{k, m}], "n": [{t, m}]} – nur Z1–Z3 und die drei Nachtpositionen."""
    zeilen = sorted((r for r in zeilen if isinstance(r, dict)), key=lambda r: r.get("Position") if isinstance(r.get("Position"), int) else 10 ** 9)
    name = lambda r: re.sub(r"\s+", " ", str(r.get("Name") or "")).strip()
    z = []
    for i, pos in KONTO_Z.items():
        r = next((r for r in zeilen if re.fullmatch(rf"Zeitkonto {i}", name(r), re.I)), None) or next((r for r in zeilen if r.get("Position") == pos), None)
        m = _minuten(r.get("Value")) if r else None
        if m is not None and abs(m) < 10 ** 6:
            z.append({"k": f"Z{i}", "m": m})
    n = []
    kopf = next((i for i, r in enumerate(zeilen) if re.fullmatch(r"-*\s*NACHTSTUNDEN\s*-*", name(r), re.I)), None)
    if kopf is not None:
        erste, block = None, 0
        for r in zeilen[kopf + 1:]:
            pos = r.get("Position") if isinstance(r.get("Position"), int) else None
            erste = erste if erste is not None else pos
            # Ende des Abschnitts: Trenner oder nächste Überschrift („-- … --“), oder ein anderer Positionsblock
            if re.match(r"^\s*-{2,}", name(r)) or block >= 20 or (erste is not None and pos is not None and pos // 100 != erste // 100):
                break
            block += 1                     # alle Zeilen des Abschnitts zählen, auch ohne lesbaren Wert
            m = _minuten(r.get("Value"))
            if m is not None and abs(m) < 10 ** 6:
                n.append((name(r), m))
    if not n:   # Überschrift nicht gefunden: feste Positionen
        for pos in KONTO_NACHT:
            r = next((r for r in zeilen if r.get("Position") == pos), None)
            m = _minuten(r.get("Value")) if r else None
            if m is not None and abs(m) < 10 ** 6:
                n.append((name(r), m))
    return {"z": z, "n": _nacht_ordnen(n)}


def konto_lesen():
    """Stundenkonto des laufenden Zeitraums (Anmeldung muss bestehen). Wirft bei jeder Unstimmigkeit – dann bleibt
    der letzte Stand."""
    seite = req(KONTO)
    if 'id="loginForm"' in seite:
        raise RuntimeError("nicht angemeldet")
    adressen = {u.split("?")[0].rsplit("/", 1)[-1]: u for u in
                (x.replace("\\u0026", "&").replace("\\/", "/") for x in re.findall(r'"url"\s*:\s*"([^"]{1,300})"', seite))}
    liste_url, pos_url = adressen.get("getWorkingTimeAccounts"), adressen.get("getWorkingTimeAccountItems")
    if not liste_url or not pos_url:
        raise RuntimeError("Datenquellen nicht gefunden")
    liste = json.loads(req(liste_url))
    if not isinstance(liste, list) or not liste:
        raise RuntimeError("keine Zeiträume")
    heute_s = heute().isoformat()
    laufend = [x for x in liste if isinstance(x, dict) and x.get("KeyInfo") and _konto_tag(x.get("Begin")) and _konto_tag(x.get("Begin")) <= heute_s]
    if not laufend:   # lieber den letzten Stand behalten als einen falschen (künftigen) Zeitraum zeigen
        raise RuntimeError("laufender Zeitraum nicht erkennbar")
    akt = max(laufend, key=lambda x: _konto_tag(x.get("Begin")))
    d = json.loads(req(pos_url, {"sort": "", "page": "1", "pageSize": "500", "group": "", "filter": "", KONTO_PARAM: str(akt["KeyInfo"])}))
    zeilen = d.get("Data") if isinstance(d, dict) else None
    if not isinstance(zeilen, list) or not zeilen:
        raise RuntimeError("keine Positionen")
    k = konto_zeilen(zeilen)
    if not k["z"] and not k["n"]:
        raise RuntimeError("Z1–Z3 und Nachtstunden nicht gefunden")
    zr = re.sub(r"\s+", " ", str(akt.get("RepresentationText") or "")).strip()[:40]
    return {"stand": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **({"zeitraum": zr} if zr else {}), **k}


# ---- Druckansicht der Wochenübersicht: Nur dort steht bei gesperrten Tagen in der Spalte „Bemerkung“, was geplant ist ----
DRUCK = "report/report/preview?rt=IndividualWeekDutyRosterReport&mm=true"
# Beginn einer Tageszeile: Wochentag und Datum. Je nach PDF-Leser stehen die Zellen einer Zeile nebeneinander oder
# jede in einer eigenen Textzeile – deshalb dürfen zwischen ihnen auch Zeilenwechsel liegen.
_DRUCK_TAG = re.compile(r"^[ \t]*(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?\s+(\d{2})\.(\d{2})\.(\d{4}|\d{2})\b", re.M)
# Hier endet eine Bemerkung spätestens: Tabellenkopf, Kopf mit Namen, Seitenzahl, Druckdatum am Fuß
_DRUCK_ENDE = re.compile(r"^[ \t]*(?:(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),\s*\d|Tag\s+Datum\b|Name,|Seite\s+\d)", re.M | re.I)


def druck_zeilen():
    """Textzeilen der Druckansicht. Die Seite zeigt ein PDF in einem Betrachter; dessen Adresse steht in der Seite.
    Der Zeitraum ist fest (15 Tage ab heute): Die Druckansicht kennt keine Wochenauswahl, und Datumsangaben in der
    Adresse wirken sich nicht aus (im November 2026 ausprobiert)."""
    seite = req(DRUCK)
    m = re.search(r"(?:/[A-Za-z0-9_-]+)*/report/report/Pdf/IndividualWeekDutyRosterReport/[A-Za-z0-9_./?=&%:;()\\-]+", seite)
    if not m:
        raise RuntimeError("Adresse des Berichts fehlt")
    adresse = m.group(0).replace("\\u0026", "&").replace("&amp;", "&").replace("\\/", "/")
    import io
    import logging
    import warnings
    from pypdf import PdfReader
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)   # Hinweise zu PDF-Mängeln gäbe es nur bei echten Abrufen
    pdf = req_roh(adresse)
    if not pdf.startswith(b"%PDF"):
        raise RuntimeError("Bericht ist kein PDF")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return [z for seite in PdfReader(io.BytesIO(pdf)).pages for z in (seite.extract_text() or "").splitlines()]


def druck_lesen(zeilen):
    """Aus den Textzeilen der Druckansicht: ({Tag: Bemerkung} für gesperrte Tage, alle Tage, die sie abdeckt).
    Eine Tageszeile beginnt mit Wochentag und Datum („Sa 21.11.26 gesperrt …“); alles bis zur nächsten Tageszeile
    oder zum Seitenfuß gehört zu ihr. Bei gesperrten Tagen steht nach „gesperrt“ nur noch die Bemerkung."""
    text = "\n".join(zeilen)
    anf = list(_DRUCK_TAG.finditer(text))
    tage, bem = set(), {}
    for m, nxt in zip(anf, anf[1:] + [None]):
        jahr = int(m.group(3))
        try:
            d = date(jahr + (2000 if jahr < 100 else 0), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            continue
        tage.add(d)
        rest = text[m.end():nxt.start() if nxt else len(text)]
        e = _DRUCK_ENDE.search(rest)
        if e:
            rest = rest[:e.start()]
        g = re.match(r"\s*gesperrt\b(.*)$", rest, re.I | re.S)
        if g:
            bem[d] = " ".join(g.group(1).split())[:120]
    return bem, tage


def _ist_aend(e):
    """Tag mit dem Kürzel „Änd“ (geänderter Dienst ohne Uhrzeit); was gilt, steht in der Bemerkung der Wochenliste."""
    return not e["von"] and not e["gesperrt"] and bool(re.match(r"änd", (e["name"] or "").strip(), re.I))


def _merken(merk, k, neu, now):
    """Hält unter k den Text neu fest. Stand vorher etwas anderes da, gilt das als Änderung (mit Zeitpunkt und
    vorherigem Text); die erste Eintragung nach „leer“ ist keine."""
    st = merk.get(k)
    if st is None:
        merk[k] = {"t": neu}
    elif st.get("t", "") != neu:
        if st.get("t") or st.get("seit"):
            merk[k] = {"t": neu, "alt": st.get("t") or st.get("alt", ""), "seit": now}
        else:
            merk[k] = {"t": neu}


def bemerkungen(items, merk_alt, druck, now):
    """Bemerkungen gesperrter Tage (aus der Druckansicht) und von „Änd“-Tagen (aus der Wochenliste): trägt sie ein
    und hält fest, wenn sie sich ändern.
    items: Rohzeilen mit dem Datum, unter dem das Portal sie führt. druck: Ergebnis von druck_lesen oder None, wenn
    die Druckansicht nicht lesbar war – dann bleibt bei gesperrten Tagen der zuletzt bekannte Stand stehen.
    Rückgabe: neuer Merker {Tag: {...}} für gesperrte Tage und {Tag + "|a": {...}} für „Änd“-Tage, jeweils
    {"t": Bemerkung, "alt": vorherige, "seit": Zeitpunkt der Änderung}."""
    merk = {d: dict(v) for d, v in (merk_alt or {}).items() if isinstance(v, dict)}
    gesperrt = {e["d"] for e in items if e["gesperrt"]}
    if druck:
        bem, tage = druck
        for d in gesperrt & tage:
            _merken(merk, d, bem.get(d, ""), now)
    aend = {}
    for e in items:
        if _ist_aend(e):
            aend.setdefault(e["d"], []).append(" ".join((e.get("bem") or "").split()))
    for d, texte in aend.items():
        _merken(merk, d + "|a", " / ".join(dict.fromkeys(t for t in texte if t)), now)
    # Tage, die nicht mehr gesperrt bzw. nicht mehr „Änd“ sind, vergessen
    merk = {k: v for k, v in merk.items() if k in gesperrt or (k.endswith("|a") and k[:-2] in aend)}
    for e in items:
        if e["gesperrt"]:
            st = merk.get(e["d"])
            if st and st.get("t"):
                e["bem"] = st["t"]
        else:
            st = merk.get(e["d"] + "|a") if _ist_aend(e) else None
        if st and st.get("seit"):
            e["bemAlt"], e["bemSeit"] = st.get("alt", ""), st["seit"]
    return merk


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
    """Turbo-Woche: 4 Dienste in 3 Tagen (04:30, 22:30, 19:30, 14:30). Das Portal führt jeden Dienst in einer
    eigenen Tageszeile, tatsächlich beginnen Dienst 2–4 aber einen Kalendertag früher.
    Erkennung über die Nachbarn: Ein Dienst gehört zur Folge, wenn der Vortag den vorherigen oder der
    Folgetag den nächsten Dienst der Abfolge hat. So klappt es auch, wenn die Folge vor heute begonnen hat
    (das Portal liefert erst ab heute). Alle anderen Wochen bleiben täglich."""
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
    """Rohzeilen (wie das Portal sie liefert) aus fertigen Einträgen zurückgewinnen: Turbo-Vorziehen rückgängig."""
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


def verlauf_lesen():
    """Merker des Abgleichs (Rohzeilen der letzten Tage, Zeitpunkte) aus der internen Ablage – nur der Abgleich
    kann sie lesen, weder die Seite noch das iPad. Leer, wenn es (noch) keine gibt."""
    g = daten.intern()
    if not g:
        return {}
    enc, _ = daten.lesen("verlauf", g)
    if not enc:
        return {}
    try:
        return decrypt(enc, g)
    except Exception as e:  # noqa: BLE001
        print("Verlauf nicht lesbar:", type(e).__name__)
        return {}


def verlauf_schreiben(v):
    g = daten.intern()
    if g:
        daten.schreiben("verlauf", encrypt(v, g, 16384), {"a": g})


def historie(pin, verlauf, vorhanden=None):
    """Vergangene Rohzeilen – das Portal selbst liefert erst ab heute. Quelle ist der interne Verlauf; fehlt er
    (z. B. nach einem neuen Cloudflare-Token), dient die bisherige Ablage als Startwert."""
    quellen = [verlauf.get("roh") or []]
    if not quellen[0]:
        if vorhanden:
            try:
                alt = decrypt(vorhanden, pin)
                quellen.append(roh_aus(alt.get("eintraege") or []))
            except Exception as e:  # noqa: BLE001
                print("bisherige Ablage nicht lesbar:", type(e).__name__)
    roh, seen = [], set()
    for q in quellen:
        for e in q:
            k = (e.get("d"), e.get("von"), e.get("name"), "" if e.get("von") else e.get("bem"))   # wie in normalize()
            if e.get("d") and k not in seen:
                seen.add(k)
                roh.append(e)
    grenze = (heute() - timedelta(days=HISTORIE_TAGE)).isoformat()
    return [e for e in roh if e["d"] >= grenze]


def collect(alt_roh=(), nach=None):
    """Aktuelle Woche plus folgende Wochen (sofern der Server einen Datumsparameter akzeptiert), davor die Historie.
    nach(items) läuft, sobald alle Zeilen da sind und bevor Tage vorgezogen werden (Bemerkungen der Druckansicht).
    Rückgabe: (Einträge ab gestern, Rohzeilen, lückenhaft, gestört). gestört = eine Folgewoche ließ sich nicht
    abrufen; lückenhaft = deshalb steht für spätere Tage der zuletzt bekannte Stand da."""
    items = normalize(read_items())
    if not items:
        return items, [], False, False
    have = {e["d"] for e in items}
    last = max(date.fromisoformat(e["d"]) for e in items)
    gestoert = False
    for weeks in range(1, 6):
        target = last + timedelta(days=1 + 7 * (weeks - 1))
        got, fehler = [], False
        for key in ("date", "startDate", "Date"):
            try:
                cand = normalize(read_items({key: target.strftime("%d.%m.%Y")}))
            except Exception:
                cand, fehler = [], True
            if any(e["d"] not in have for e in cand):
                got = cand
                break
        new = [e for e in got if e["d"] not in have]
        if not new:
            gestoert = fehler
            break
        items += new
        have |= {e["d"] for e in new}
    # Ein gescheiterter Abruf einer Folgewoche (Zeitüberschreitung, Störung) darf den Plan nicht stillschweigend kürzen:
    # Reichte der letzte Abruf weiter, bleiben dessen spätere Tage stehen – samt ihrer Änderungsmarken.
    lueckenhaft = False
    if gestoert:
        # ohne die Marken des letzten Laufs; bei gesperrten Tagen auch ohne dessen Bemerkung (kommt neu aus dem Merker)
        spaeter = [{**{k: v for k, v in e.items() if k not in ("bemAlt", "bemSeit")}, **({"bem": ""} if e.get("gesperrt") else {})}
                   for e in alt_roh if e["d"] > max(have)]
        if spaeter:
            items += spaeter
            lueckenhaft = True
    if nach:
        nach(items)
    erster = min(e["d"] for e in items)
    alt = [e for e in alt_roh if e["d"] < erster]
    roh = [dict(e) for e in alt + items]
    items, _ = fix_turbo([dict(e) for e in alt + items])
    # angezeigt wird ab gestern (laufender Nachtdienst), gemerkt werden die Rohzeilen für den nächsten Abruf
    gestern = (heute() - timedelta(days=1)).isoformat()
    return [e for e in items if e["d"] >= gestern], roh, lueckenhaft, gestoert


def encrypt(obj, pin, pad=PAD_TO):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    # auf feste Größe auffüllen; wird es einmal mehr, dann in 16-KB-Stufen (die Länge verrät so nie den genauen Umfang)
    n = len(raw.encode())
    raw = raw + " " * (max(pad, -(-n // 16384) * 16384) - n)
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(pin.encode())
    ct = AESGCM(key).encrypt(iv, raw.encode(), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b(salt), "iv": b(iv), "ct": b(ct)}


MIN_ABSTAND_H = 2.5  # das Portal bei jedem planmäßigen Datenabgleich abfragen (tagsüber etwa alle 3 Stunden)
FEHLER_PAUSE_H = 6   # nach einem gescheiterten Abruf (z. B. Anmeldung abgelehnt) so lange nicht erneut versuchen
DRUCK_FEHL_MAX = 3   # so oft in Folge darf die Druckansicht unlesbar sein, bevor der Lauf als gescheitert gemeldet wird
LUECKE_MAX = 2       # dito für nicht abrufbare Folgewochen (ein einzelner Aussetzer bleibt still)
SOFORT = os.environ.get("PRIVAT_SOFORT") == "1"   # manueller Start: ohne Wartezeiten


def heute():
    """Kalendertag in München (der Abgleich läuft auf Rechnern mit Weltzeit)."""
    return datetime.now(ZoneInfo("Europe/Berlin")).date()


def jetzt():
    return int(datetime.now(timezone.utc).timestamp())


def ruhig_warten():
    """Ohne Abruf ähnlich lange warten, wie ein Abruf dauert (nur in GitHub Actions)."""
    if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUHIG_WARTEN", "1") == "1":
        import random
        import time
        time.sleep(random.uniform(12, 24))


def ruhig_melden():
    """Eine einzige, neutrale Zeile fürs öffentliche Protokoll – egal ob abgerufen, noch frisch oder pausiert. Sonst ließe
    sich dort ablesen, wann jemand krank oder im Urlaub ist."""
    ruhig_warten()
    print("Dienste: erledigt")


class _Mitschrift:
    """Gibt alles wie gewohnt aus und merkt sich die Zeilen – ein pausierter Lauf gibt später genau dieselben aus."""
    def __init__(self, ziel):
        self.ziel, self.teile = ziel, []

    def write(self, t):
        self.teile.append(t)
        return self.ziel.write(t)

    def flush(self):
        self.ziel.flush()

    def zeilen(self):
        return [z for z in "".join(self.teile).splitlines() if z.strip()][:20]


def pause_lauf(verlauf, pin):
    """Pausiert: keine Anmeldung beim Portal. Nach außen (Protokoll, Ausgang, Takt) sieht der Lauf aus wie ohne Pause –
    wie der letzte echte Lauf, auch wenn der rot war (z. B. Stundenkonto dauerhaft unlesbar). Sonst verriete das
    öffentliche Protokoll durch ausbleibende Fehlermeldungen, wann jemand krank oder im Urlaub ist."""
    if not SOFORT:
        if jetzt() - max(verlauf.get("fehler_t") or 0, verlauf.get("pause_fehler_t") or 0) < FEHLER_PAUSE_H * 3600:
            print(f"Letzter Abruf ist gescheitert – nächster Versuch frühestens {FEHLER_PAUSE_H} h danach (oder manuell starten)")
            return
        daten.bild_pflegen("p", pin)
        if jetzt() - max(verlauf.get("t") or 0, verlauf.get("pause_t") or 0) < MIN_ABSTAND_H * 3600:
            ruhig_melden()
            return
    else:
        daten.bild_pflegen("p", pin)
    a = verlauf.get("ausgang") if isinstance(verlauf.get("ausgang"), dict) else {}
    # Takt wie bei echten Abrufen – mit eigenen Zeitpunkten: der echte Stand („t“, „fehler_t“) bleibt unberührt, damit
    # nach dem Fortsetzen im Normalfall (letzter Lauf grün) sofort wieder abgerufen wird
    neu = {**verlauf, "pause_t": jetzt()}
    if a.get("fehler"):
        neu["pause_fehler_t"] = jetzt()
    elif not a.get("exit"):   # grün nachgebildet: Zähler wie nach einem sauberen Lauf, sonst würde der erste echte Lauf
        neu.update(druck_fehl=0, luecke_n=0, konto_fehl=0)   # nach der Pause zu früh rot und verriete sie
    verlauf_schreiben(neu)
    ruhig_warten()
    if a.get("exit"):   # nur dauerhafte Zustände wiederholen (rot); einmalige Meldungen nicht
        zeilen = [z for z in (a["zeilen"] if isinstance(a.get("zeilen"), list) else []) if isinstance(z, str)]
        if not a.get("fehler"):   # Hinweis-Lauf: die Druckansicht-Zeile gehört nur zum Druckansicht-Hinweis
            zeilen = [z for z in zeilen if z.startswith("Druckansicht nicht lesbar") and "Druckansicht" in a["exit"]] + ["Dienste: erledigt"]
        for z in zeilen:
            if not z.startswith(("Zugang zum Bild", "bisherige Ablage")):
                print(z)
        raise SystemExit(a["exit"])
    print("Dienste: erledigt")


def main():
    pin = os.environ.get("DIENSTE_PIN", "")
    if not daten.eingerichtet():
        print("übersprungen: geschützter Speicher ist noch nicht veröffentlicht")
        return
    if not BASE.startswith("https://") or not os.environ.get("DIENSTPLAN_USER") or not os.environ.get("DIENSTPLAN_PASS") or len(pin) < 6:
        print("übersprungen: DIENSTPLAN_URL, Zugangsdaten oder DIENSTE_PIN fehlen (PIN mindestens 6 Zeichen)")
        return
    if not daten.aktiv() or not daten.intern():
        raise SystemExit("Schlüssel für den geschützten Speicher fehlen (werden aus CLOUDFLARE_API_TOKEN abgeleitet)")
    try:
        abgleich(pin)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 – ohne Traceback: Funktionsnamen und Zeilen verrieten sonst, ob pausiert ist
        raise SystemExit(f"Abruf der Dienste gescheitert ({type(e).__name__}) – der bisherige Stand bleibt") from None


def abgleich(pin):
    verlauf = verlauf_lesen()
    # Pause von der Seite (krank, Urlaub): dann meldet sich der Abgleich gar nicht beim Portal an – auch nicht von Hand
    if daten.pause("privat"):
        try:   # PIN während der Pause geändert: Ablage mit der neuen PIN neu ablegen (letzter Stand aus dem internen
            # Verlauf), sonst ließen sich weder die Dienste lesen noch die Pause beenden
            if daten.lesen("privat", pin)[0] is None and not daten.stand("privat").get("leer"):
                if isinstance(verlauf.get("letzte"), dict):   # ohne gemerkten Stand nichts umstellen: dann bleibt
                    daten.schreiben("privat", encrypt(verlauf["letzte"], pin), {"p": pin})   # wenigstens die alte PIN
        except Exception:  # noqa: BLE001 – still: das Protokoll bleibt mit und ohne Pause gleich
            pass
        pause_lauf(verlauf, pin)
        return
    vorhanden, _ = daten.lesen("privat", pin)   # None: noch nichts abgelegt oder PIN geändert -> sofort abrufen
    if not SOFORT:
        # Takt: Hat eine Pause zuletzt rote Läufe nachgebildet, gilt deren Takt weiter – ein vorzeitiger Lauf würde sonst
        # im Protokoll verraten, dass die roten Läufe davor nur nachgebildet waren. Im grünen Normalfall wird nach dem
        # Fortsetzen sofort abgerufen.
        rot = isinstance(verlauf.get("ausgang"), dict) and bool(verlauf["ausgang"].get("exit"))
        if jetzt() - max(verlauf.get("fehler_t") or 0, verlauf.get("pause_fehler_t") or 0) < FEHLER_PAUSE_H * 3600:
            print(f"Letzter Abruf ist gescheitert – nächster Versuch frühestens {FEHLER_PAUSE_H} h danach (oder manuell starten)")
            return
        if vorhanden and jetzt() - max(verlauf.get("t") or 0, (verlauf.get("pause_t") or 0) if rot else 0) < MIN_ABSTAND_H * 3600:
            daten.bild_pflegen("p", pin)
            ruhig_melden()
            return
    mit = _Mitschrift(sys.stdout)
    with contextlib.redirect_stdout(mit), contextlib.redirect_stderr(io.StringIO()):   # Bibliotheken schreiben sonst
        echter_lauf(pin, verlauf, vorhanden, mit)                                    # Warnungen nur bei echten Abrufen


def echter_lauf(pin, verlauf, vorhanden, mit):
    merk = verlauf.get("bem") or {}
    druck_fehl, druck_t = int(verlauf.get("druck_fehl") or 0), verlauf.get("druck_t")
    konto, konto_fehl = verlauf.get("konto"), int(verlauf.get("konto_fehl") or 0)   # letzter guter Stand des Stundenkontos

    def mit_bemerkungen(items):
        nonlocal merk, druck_fehl, druck_t
        druck = None
        try:
            druck = druck_lesen(druck_zeilen())
            if not druck[1]:
                raise RuntimeError("keine Tageszeilen erkannt")
            druck_fehl, druck_t = 0, jetzt()
        except Exception as e:  # noqa: BLE001 – ohne Druckansicht bleiben die Dienste trotzdem aktuell
            druck = None
            druck_fehl += 1
            print("Druckansicht nicht lesbar:", type(e).__name__, "– Bemerkungen bleiben auf dem letzten Stand")
        merk = bemerkungen(items, merk, druck, jetzt())

    try:
        login()
        entries, roh, lueckenhaft, gestoert = collect(historie(pin, verlauf, vorhanden), mit_bemerkungen)
        if not entries:
            raise RuntimeError("keine Einträge erhalten")
        try:
            konto, konto_fehl = konto_lesen(), 0
        except Exception:  # noqa: BLE001 – ohne Stundenkonto bleiben die Dienste aktuell; das Konto zeigt den letzten Stand
            konto_fehl += 1
    except (Exception, SystemExit) as e:  # noqa: BLE001 – Inhalte des Fehlers bleiben aus dem Protokoll
        grund = str(e) if isinstance(e, SystemExit) else type(e).__name__
        text = f"Abruf der Dienste gescheitert ({grund}) – der bisherige Stand bleibt"
        try:
            verlauf_schreiben({**verlauf, "fehler_t": jetzt(), "ausgang": {"zeilen": mit.zeilen(), "exit": text, "fehler": True}})
        except Exception:  # noqa: BLE001
            pass
        raise SystemExit(text) from None
    zeit = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {"stand": zeit(jetzt()), "eintraege": entries}
    if druck_t:   # wann die Bemerkungen gesperrter Tage zuletzt gelesen wurden – die Seite weist darauf hin, wenn das länger her ist
        payload["bemStand"] = zeit(druck_t)
    if isinstance(konto, dict):   # mit eigenem Stand: ist das Konto einmal nicht lesbar, zeigt die Seite das Alter an
        payload["konto"] = konto
    # Wie viele Tage der Plan vorausreicht. Hält die Störung so lange an, dass keine alten Tage mehr zum Übernehmen
    # da sind, bliebe sie sonst unbemerkt: Reicht der Plan klar kürzer als nach dem letzten störungsfreien Abruf,
    # zählt das ebenfalls als Lücke.
    weit, weit_alt = (date.fromisoformat(max(e["d"] for e in roh)) - heute()).days, verlauf.get("weit")
    if gestoert and isinstance(weit_alt, int) and weit <= weit_alt - 7:
        lueckenhaft = True
    luecke_n = int(verlauf.get("luecke_n") or 0) + 1 if lueckenhaft else 0
    # Dauerhafte Teil-Ausfälle sichtbar machen: Die Dienste sind gespeichert, der Lauf gilt trotzdem als gescheitert
    # (rot in GitHub Actions). Ein einzelner Aussetzer bleibt still.
    hinweise = []
    if luecke_n >= LUECKE_MAX:
        hinweise.append("Folgewochen mehrfach nicht abrufbar – spätere Tage zeigen den letzten bekannten Stand")
    if konto_fehl >= KONTO_FEHL_MAX:
        hinweise.append("Stundenkonto mehrfach in Folge nicht lesbar – es zeigt den letzten Stand")
    if druck_fehl >= DRUCK_FEHL_MAX:
        hinweise.append("Druckansicht mehrfach in Folge nicht lesbar – Bemerkungen gesperrter Tage können veraltet sein")
    ausgang = "Dienste gespeichert, aber: " + "; ".join(hinweise) if hinweise else ""
    daten.schreiben("privat", encrypt(payload, pin), {"p": pin})
    daten.bild_pflegen("p", pin)
    verlauf_schreiben({**{k: v for k, v in verlauf.items() if k.startswith("kal_")}, "t": jetzt(), "roh": roh, "bem": merk,
                       "druck_fehl": druck_fehl, "druck_t": druck_t, "luecke_n": luecke_n, "konto": konto, "konto_fehl": konto_fehl,
                       "weit": weit_alt if gestoert else weit, "letzte": payload,
                       "ausgang": {"zeilen": mit.zeilen() + ["Dienste: erledigt"], "exit": ausgang}})
    print("Dienste: erledigt")
    if ausgang:
        raise SystemExit(ausgang)


if __name__ == "__main__":
    main()
