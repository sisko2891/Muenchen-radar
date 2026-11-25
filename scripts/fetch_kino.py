#!/usr/bin/env python3
"""Mathäser: Vorstellungen mit Saal und berechnetem Preis für den Premium-Sessel -> data/kino.json.

Quelle sind die öffentliche Programmseite (Uhrzeit, Saal, Technik, günstigster Ticketpreis „ab …“)
und die Preisliste des Kinos. Der Ticketshop selbst wird nicht abgefragt; die Preise sind berechnet:
  ab 18 Uhr:  „ab“-Preis der Vorstellung (= Erwachsenenpreis inkl. Saal- und Filmzuschlag) + Premium-Zuschlag
  vor 18 Uhr: Listenpreis (Matinee/Happy Hour) + Saalzuschlag + Filmzuschlag + Premium-Zuschlag
Der Filmzuschlag ergibt sich je Film aus dem Abstand der „ab“-Preise zur Preisliste.
3D-Vorstellungen werden nur gekennzeichnet (die Seite blendet sie aus). Im Dolby Cinema gibt es keine Premium-Sessel (Normalpreis).

Aufruf:  fetch_kino.py                      -> von mathaeser.de laden
         fetch_kino.py prog.html preise.html [JJJJ-MM-TT]  -> lokale Dateien (Test)
"""
import html
import json
import re
import sys
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://www.mathaeser.de/mm"
OUT = Path(__file__).resolve().parent.parent / "data" / "kino.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"

# Stand der Preisliste (Spalten: Mo–Do, Fr/vor Feiertag, Sa, So/Feiertag); wird von der Preisseite überschrieben, wenn lesbar
PREISE = {
    "matinee": [7.49, 7.49, 7.49, 9.49],      # vor 12:00
    "happy": [9.49, 9.49, 12.49, 12.49],      # vor 18:00
    "abend": [10.99, 13.49, 13.49, 13.49],    # ab 18:00
    "late": [6.99, 13.49, 13.49, 6.99],       # ab 21:30
    "kind": [7.49, 7.49, 8.49, 8.49],         # Kinder vor 18:00 (das ist der „ab“-Preis am Tag)
    "premium": 4.50, "k6": 1.50, "dolby": 4.00,
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "replace")


def euro(s):
    m = re.search(r"(\d{1,3}),(\d{2})", s)
    return float(m.group(1) + "." + m.group(2)) if m else None


def preisliste(seite):
    """Preistabelle lesen (mit Spaltenverbund). Bei unerwartetem Aufbau bleiben die festen Werte."""
    p = dict(PREISE)
    tab = re.search(r"<table.*?</table>", seite, flags=re.S)
    if not tab:
        return p, "fest"
    gelesen = 0
    for tr in re.findall(r"<tr.*?</tr>", tab.group(0), flags=re.S):
        cells = re.findall(r"<t[hd]([^>]*)>(.*?)</t[hd]>", tr, flags=re.S)
        if len(cells) < 2:
            continue
        txt = lambda c: " ".join(html.unescape(re.sub(r"<[^>]+>", " ", c)).split())
        label = txt(cells[0][1]).lower()
        werte = []
        for attr, inner in cells[1:]:
            v = euro(txt(inner))
            n = int((re.search(r'colspan="?(\d+)', attr) or [0, 1])[1])
            werte += [v] * n
        key = ("matinee" if "matinee" in label else "happy" if "happy hour" in label else "late" if "late night" in label
               else "abend" if label.startswith("erwachsene") else "kind" if label.startswith("kinder") and "ab 18" not in label else None)
        if key and len(werte) == 4 and all(v and 3 < v < 30 for v in werte):
            p[key] = werte
            gelesen += 1
        for k, wort in (("premium", "premium-sessel"), ("k6", "(m)k6"), ("dolby", "dolby cinema")):
            if wort in label and len(werte) >= 1 and werte[0] and 0 < werte[0] < 15:
                p[k] = werte[0]
                gelesen += 1
    return p, ("gelesen" if gelesen >= 8 else "fest")


def feiertage(y):
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    ostern = date(y, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)
    fest = [(1, 1), (1, 6), (5, 1), (8, 15), (10, 3), (11, 1), (12, 25), (12, 26)]
    return {date(y, mo, t) for mo, t in fest} | {ostern + timedelta(days=n) for n in (-2, 1, 39, 50, 60)}


def spalte(d, start):
    """0 Mo–Do, 1 Fr/vor Feiertag, 2 Sa, 3 So/Feiertag; Filmstart/Preview: Samstagspreis bis Freitag der 1. Woche."""
    ft = feiertage(d.year) | feiertage(d.year + 1)
    col = 3 if d in ft or d.weekday() == 6 else 2 if d.weekday() == 5 else 1 if d.weekday() == 4 or d + timedelta(days=1) in ft else 0
    if start and col < 2:
        ende = start + timedelta(days=(4 - start.weekday()) % 7)   # Freitag der ersten Spielwoche
        if start - timedelta(days=7) <= d <= ende:
            col = 2
    return col


def parse(seite, heute):
    out = []
    for t in re.split(r'(?=<h2 class="hl--1 hidden-min-sm">)', seite)[1:]:
        m = re.search(r'class="hl-link">([^<]+)</a>', t)
        if not m:
            continue
        titel = html.unescape(m.group(1)).strip()
        orig = re.search(r'class="hl--sub">([^<]*)', t)
        orig = html.unescape(orig.group(1)).strip() if orig else ""
        start = re.search(r"Start:</span>\s*(\d{2})\.(\d{2})\.(\d{4})", t)
        start = date(int(start.group(3)), int(start.group(2)), int(start.group(1))) if start else None
        if start and start.year < 2010:
            start = None
        tag = {}
        for ids, lab in re.findall(r'data-performance-ids=\[([^\]]*)\]>.*?prog-nav__day">([^<]*)<', t, flags=re.S):
            lab = lab.strip()
            if lab.startswith("Heute"):
                d = heute
            elif lab.startswith("Morgen"):
                d = heute + timedelta(days=1)
            else:
                mm = re.search(r"(\d{1,2})\.(\d{1,2})\.", lab)
                if not mm:
                    continue
                try:   # ein Tag, den es so nicht gibt (Tippfehler der Seite, 29.02. im falschen Jahr), kostet nur diese Zeile
                    d = date(heute.year, int(mm.group(2)), int(mm.group(1)))
                    if d < heute - timedelta(days=60):
                        d = d.replace(year=heute.year + 1)
                except ValueError:
                    try:
                        d = date(heute.year + 1, int(mm.group(2)), int(mm.group(1)))
                    except ValueError:
                        continue
            for i in ids.split(","):
                if i.strip():
                    tag[i.strip()] = d
        for b in re.split(r'(?=<div class="prog2__cont )', t)[1:]:
            pid = re.search(r'data-performance-id="([^"]+)"', b)
            zeit = re.search(r"prog2__time[^>]*>\s*(\d{1,2}:\d{2})", b)
            if not pid or not zeit or pid.group(1) not in tag:
                continue
            saal = re.search(r"prog2__hall-num[^>]*>\s*<div>([^<]+)", b)
            ver = re.search(r"data-version='([^']*)'", b)
            ab = re.search(r"ab <b>([\d,]+)</b>", b)
            out.append({"id": pid.group(1), "titel": titel, "orig": orig, "d": tag[pid.group(1)], "zeit": zeit.group(1).zfill(5),
                        "saal": html.unescape(saal.group(1)).strip() if saal else "",
                        "tech": sorted(set(re.findall(r'"(\w+)"', ver.group(1)))) if ver else [],
                        "premium": 'data-seating="[1]"' in b, "ab": euro(ab.group(1)) if ab else None, "start": start})
    return out


def rechne(vs, p):
    """Preis je Vorstellung; Rückgabe: Liste für die Seite."""
    saalz = lambda x: p["k6"] if "k6" in x["saal"].lower() else p["dolby"] if "dolby" in x["saal"].lower() else 0.0

    def ab_soll(x, c):   # so setzt sich der „ab“-Preis laut Liste zusammen (ohne Filmzuschlag)
        t = x["zeit"]
        if t < "18:00":
            return min(p["kind"][c], p["matinee"][c]) if t < "12:00" else p["kind"][c]
        return p["late"][c] if t >= "21:30" else p["abend"][c]

    # Filmzuschlag je Film: häufigster Abstand zwischen „ab“-Preis und Liste (0 bis 2,50 €)
    rest = {}
    for x in vs:
        if x["ab"] is not None:
            r = round(x["ab"] - ab_soll(x, spalte(x["d"], x["start"])) - saalz(x), 2)
            if -0.01 <= r <= 2.51:
                rest.setdefault(x["titel"], Counter())[max(0.0, r)] += 1
    zuschlag = {t: c.most_common(1)[0][0] for t, c in rest.items()}

    out, zaehl = [], Counter()
    for x in vs:
        if "3d" in x["tech"]:   # 3D interessiert nicht: nur als Kennung liefern, damit die Seite die Vorstellung ausblendet
            zaehl["3D"] += 1
            out.append({"d": x["d"].isoformat(), "z": x["zeit"], "t": x["titel"], "o": x["orig"], "s": x["saal"], "v": [], "p": None, "a": "3d", "g": "", "b": False})
            continue
        c, t, z = spalte(x["d"], x["start"]), x["zeit"], zuschlag.get(x["titel"], 0.0)
        plus = p["premium"] if x["premium"] else 0.0
        art = "premium" if x["premium"] else "dolby" if "dolby" in x["saal"].lower() else "normal"
        abend_normal = p["abend"][c] + saalz(x) + z + plus       # Vergleichswert: Abendpreis dieses Tages
        r = None if x["ab"] is None else round(x["ab"] - ab_soll(x, c) - saalz(x), 2)
        if t < "18:00":
            if r is not None and not (-0.01 <= r <= 2.51):
                # Sonderpreis (z. B. Kinderfilm-Aktion, Veranstaltung): nur der „ab“-Preis ist bekannt
                preis, grund, art = x["ab"], "Sonderpreis ab", "sonder"
                zaehl["Sonderpreis"] += 1
            else:
                preis = (p["matinee"][c] if t < "12:00" else p["happy"][c]) + saalz(x) + z + plus
                grund = "Matinee" if t < "12:00" else "vor 18 Uhr"
        else:
            if x["ab"] is not None:
                preis = x["ab"] + plus
            else:
                preis = (p["late"][c] if t >= "21:30" else p["abend"][c]) + saalz(x) + z + plus
                zaehl["ohne ab-Preis"] += 1
            grund = "Late Night" if t >= "21:30" and preis < abend_normal - 0.01 else "ab 18 Uhr"
            if r is not None and r > 2.51:
                grund = "Sonderpreis"
        zaehl[art] += 1
        out.append({"d": x["d"].isoformat(), "z": t, "t": x["titel"], "o": x["orig"], "s": x["saal"],
                    "v": [v for v in x["tech"] if v in ("ov", "omu", "dbox", "atmos")],
                    "p": round(preis, 2), "a": art, "g": grund, "b": bool(preis < abend_normal - 0.01 and art != "sonder")})
    return out, zaehl, zuschlag


def main():
    if len(sys.argv) >= 3:
        seiten = [Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")]
        preis_html = Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace")
        heute = date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else date.today()
    else:
        heute = datetime.now(ZoneInfo("Europe/Berlin")).date()
        seiten = [get(BASE + "/programm")]
        for extra in ("/programm/woche-2",):
            try:
                seiten.append(get(BASE + extra))
            except Exception as e:
                print("weitere Woche nicht abrufbar:", type(e).__name__)
        try:
            preis_html = get(BASE + "/preise")
        except Exception as e:
            print("Preisliste nicht abrufbar:", type(e).__name__)
            preis_html = ""
    p, quelle = preisliste(preis_html)
    vs, seen = [], set()
    for s in seiten:
        for x in parse(s, heute):
            if x["id"] not in seen:
                seen.add(x["id"])
                vs.append(x)
    if len(vs) < 20:
        raise SystemExit(f"nur {len(vs)} Vorstellungen gelesen – alte Datei bleibt")
    out, zaehl, zuschlag = rechne(vs, p)
    out.sort(key=lambda x: (x["d"], x["z"], x["t"]))
    OUT.write_text(json.dumps({"stand": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "preisliste": quelle,
                               "zuschlag_premium": p["premium"], "mathaeser": out}, ensure_ascii=False, separators=(",", ":")))
    print(f"Mathäser: {len(out)} Vorstellungen, {len({x['t'] for x in out})} Filme, Tage {out[0]['d']} bis {out[-1]['d']} | Preisliste {quelle} |",
          dict(zaehl), "| Filme mit Zuschlag:", sum(1 for v in zuschlag.values() if v > 0))


if __name__ == "__main__":
    main()
