#!/usr/bin/env python3
"""Wöchentlicher Selbsttest: prüft von außen, ob Seite, Datenabgleich und alle Dienste laufen -> data/selbsttest.json.

Die Datei ist öffentlich (die Seite zeigt bei einem Fehler einen Hinweis an der Wand). Sie enthält deshalb nur neutrale
Texte („Heizung: Anmeldung bei tado erneuern“) – keine Zeiten von Diensten, keine Inhalte, keinen Pausen-Zustand.
Passwörter (Secrets) reisen nur als Kopfzeile zum jeweiligen Dienst und werden nie ausgegeben.

Umgebung: GITHUB_REPOSITORY, GH_TOKEN (Abläufe lesen), HEIZUNG_PASS, LICHT_PASS, WEG_PASS (fehlt eins: Prüfung übersprungen),
          SELBSTTEST_ANLASS ("zeitplan": nichts tun, wenn der letzte Test jünger als 20 Stunden ist – so bleibt nach einem
          Start von Hand der Montagstest nicht aus, der zweite Anstoß desselben Montags aber schon).
"""
import hashlib, json, os, re, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

WURZEL = Path(__file__).resolve().parent.parent
OUT = WURZEL / "data" / "selbsttest.json"
UA = "katzingers-castle-selbsttest/1.0"


def holen(url, kopf=None, zeit=25):
    """(Status, Kopfzeilen, Inhalt als Bytes) – Netzfehler als Status 0, nie eine Ausnahme"""
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(kopf or {})})
    try:
        with urllib.request.urlopen(req, timeout=zeit) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(2_000_000)
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, b""
    except Exception:
        return 0, {}, b""


def json_von(inhalt):
    try:
        return json.loads(inhalt)
    except Exception:
        return None


def alter_h(iso, jetzt):
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return (jetzt - t).total_seconds() / 3600
    except Exception:
        return None


class Test:
    def __init__(self):
        self.punkte = []

    def p(self, k, ok, text):
        self.punkte.append({"k": k, "ok": bool(ok), "text": text})


def seite_pruefen(t, seite, herkunft, jetzt):
    code, _, roh = holen(seite)
    html = roh.decode("utf-8", "replace")
    if code != 200 or "Katzingers Castle" not in html:
        t.p("seite", False, "Seite nicht erreichbar")
        return {}
    if "Content-Security-Policy" not in html:
        t.p("seite", False, "Seite ohne Schutzregel (CSP)")
        return {}
    falsch = []
    for pfad, marke in re.findall(r'(?:src|href)="(js/[\w.-]+\.js)\?v=([0-9a-f]{12})"', html):
        c, _, js = holen(seite + pfad + "?v=" + marke)
        if c != 200 or hashlib.sha256(js).hexdigest()[:12] != marke:
            falsch.append(pfad)
    t.p("seite", not falsch, "Seite erreichbar, Skripte passen" if not falsch else "Seite: Skript passt nicht zur Seite (" + ", ".join(falsch) + ")")
    c, _, ev = holen(seite + "data/events.json")
    a = alter_h((json_von(ev) or {}).get("updated"), jetzt) if c == 200 else None
    t.p("veroeffentlichung", a is not None and a < 8, "Seite wird regelmäßig veröffentlicht" if a is not None and a < 8 else "Seite wurde länger nicht neu veröffentlicht")
    dienste = {}
    for name in ("daten", "heizung", "licht", "weg"):
        c, _, d = holen(seite + f"data/{name}.json")
        u = (json_von(d) or {}).get("url") if c == 200 else None
        if isinstance(u, str) and re.fullmatch(r"https://[a-z0-9.-]+", u):
            dienste[name] = u
    return dienste


def ablauf_pruefen(t, repo, token, jetzt):
    if not token or not repo:
        t.p("abgleich", False, "Datenabgleich nicht prüfbar (kein Zugang zu den Abläufen)")
        return
    kopf = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json"}
    c, _, d = holen(f"https://api.github.com/repos/{repo}/actions/workflows/update.yml/runs?per_page=25", kopf)
    laeufe = (json_von(d) or {}).get("workflow_runs") if c == 200 else None
    if not isinstance(laeufe, list):
        t.p("abgleich", False, "Datenabgleich nicht prüfbar (Abläufe nicht lesbar)")
        return
    # Zeitgeber: tagsüber (Weltzeit 4–22 Uhr) stößt Cloudflare den Abgleich stündlich an – gezählt werden nur Anstöße von
    # außen (workflow_dispatch), nicht GitHubs eigener Zeitplan, der sonst einen ausgefallenen Zeitgeber verdeckte
    c2, _, d2 = holen(f"https://api.github.com/repos/{repo}/actions/workflows/update.yml/runs?event=workflow_dispatch&per_page=5", kopf)
    anst = (json_von(d2) or {}).get("workflow_runs") if c2 == 200 else None
    neuester = min((a for a in (alter_h(l.get("created_at"), jetzt) for l in anst or []) if a is not None), default=None)
    if 5 <= jetzt.hour <= 22:
        t.p("zeitgeber", neuester is not None and neuester < 2.5, "Zeitgeber stößt den Abgleich an" if neuester is not None and neuester < 2.5 else "Zeitgeber stößt den Abgleich nicht mehr an")
    # letzter Lauf, der wirklich gearbeitet hat (Auftrag „update“ nicht übersprungen)
    for l in laeufe:
        if l.get("status") != "completed":
            continue
        c, _, j = holen(f"https://api.github.com/repos/{repo}/actions/runs/{l.get('id')}/jobs", kopf)
        jobs = (json_von(j) or {}).get("jobs") if c == 200 else None
        upd = next((x for x in jobs or [] if x.get("name") == "update"), None)
        if not upd or upd.get("conclusion") == "skipped":
            continue
        a = alter_h(upd.get("completed_at") or l.get("updated_at"), jetzt)
        if upd.get("conclusion") != "success":
            t.p("abgleich", False, "Datenabgleich zuletzt gescheitert (Dienste, Termine oder Events)")
        elif a is None or a > 6:
            t.p("abgleich", False, "Datenabgleich lief länger nicht")
        else:
            t.p("abgleich", True, "Datenabgleich läuft")
        return
    t.p("abgleich", False, "Datenabgleich lief länger nicht")


def dienste_pruefen(t, dienste, herkunft, jetzt):
    o = {"Origin": herkunft}
    u = dienste.get("daten")
    if not u:
        t.p("speicher", False, "Datenspeicher: Adresse fehlt")
    else:
        c, h, d = holen(u + "/s4", o)
        stand = (json_von(d) or {}).get("stand") if c == 200 else None
        frisch = isinstance(stand, (int, float)) and jetzt.timestamp() * 1000 - stand < 20 * 60e3
        t.p("s4", frisch, "S4-Zähler läuft" if frisch else "S4-Zähler steht")
        c2, _, _ = holen(u + "/blob/privat", o)
        cors = h.get("access-control-allow-origin") == herkunft
        t.p("speicher", c2 == 401 and cors, "Datenspeicher erreichbar und geschützt" if c2 == 401 and cors else "Datenspeicher: Schutz oder Freigabe für die Seite stimmt nicht")
    for k, name, pfad, pw in (("heizung", "Heizung", "/status", "HEIZUNG_PASS"), ("licht", "Licht", "/status", "LICHT_PASS"), ("weg", "Arbeitsweg", "/check", "WEG_PASS")):
        u, geheim = dienste.get(k), os.environ.get(pw, "").strip()
        if not u:
            continue                                   # Dienst nicht eingerichtet (keine Adresse auf der Seite)
        c0, h0, _ = holen(u + pfad, o)                 # ohne Passwort: muss abgewiesen werden (zählt nicht als Fehlversuch)
        if c0 != 401 or h0.get("access-control-allow-origin") != herkunft:
            t.p(k, False, f"{name}: Dienst nicht erreichbar" if c0 in (0, 500, 502, 503, 504) else f"{name}: Schutz oder Freigabe für die Seite stimmt nicht")
            continue
        if not geheim:
            t.p(k, True, f"{name}: erreichbar (Anmeldung nicht geprüft)")
            continue
        c, _, _ = holen(u + pfad, {**o, "X-Castle-Pass": geheim}, zeit=40)
        text = {200: f"{name}: in Ordnung", 409: f"{name}: Anmeldung beim Anbieter erneuern (auf der Seite neu verbinden)",
                429: f"{name}: Zugang gerade gesperrt (zu viele Fehlversuche)", 401: f"{name}: Passwort passt nicht"}.get(c, f"{name}: Fehler beim Anbieter")
        t.p(k, c == 200, text)


def fahrplan_pruefen(t, seite, dienste, herkunft, jetzt):
    """Soll-Fahrplan der S4 (data/s4-soll.json, wöchentlich vom MVV): reicht er noch eine Woche, und kennt ihn der Zähler?"""
    c, _, d = holen(seite + "data/s4-soll.json")
    tage = (json_von(d) or {}).get("tage") if c == 200 else None
    in7 = (jetzt.astimezone(ZoneInfo("Europe/Berlin")).date() + timedelta(days=7)).isoformat()
    if not isinstance(tage, dict) or not tage.get(in7):
        t.p("fahrplan", False, "Soll-Fahrplan der S4 veraltet (Ablauf „Soll-Fahrplan der S4 holen“ prüfen)")
        return
    u = dienste.get("daten")
    c2, _, d2 = holen(u + "/s4", {"Origin": herkunft}) if u else (0, {}, b"")
    so = (json_von(d2) or {}).get("soll") if c2 == 200 else None
    if not isinstance(so, dict) or not so.get("version"):
        t.p("fahrplan", False, "S4-Zähler kennt den Soll-Fahrplan nicht")
        return
    # der Zähler holt ihn stündlich von der Seite: Stand von heute und zuletzt vor höchstens gut einem Tag geholt
    # (fährt laut Soll heute gar keine S4, etwa bei einer Vollsperrung, hat auch der Zähler keinen Tag „heute“)
    g, heute = so.get("geholt"), jetzt.astimezone(ZoneInfo("Europe/Berlin")).date().isoformat()
    ok = (so.get("heute") is True or not tage.get(heute)) and isinstance(g, (int, float)) and jetzt.timestamp() * 1000 - g < 26 * 3600e3
    t.p("fahrplan", ok, "Soll-Fahrplan der S4 aktuell" if ok else "S4-Zähler holt den Soll-Fahrplan nicht mehr")


def main():
    jetzt = datetime.now(timezone.utc)
    if os.environ.get("SELBSTTEST_ANLASS") == "zeitplan" and OUT.exists():
        a = alter_h((json_von(OUT.read_text()) or {}).get("t"), jetzt)
        if a is not None and a < 20:
            print("Selbsttest: letzter Test ist jünger als 20 Stunden – nichts zu tun")
            return 0
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    besitzer, _, name = repo.partition("/")
    seite = os.environ.get("SELBSTTEST_SEITE") or f"https://{besitzer.lower()}.github.io/{name}/"
    herkunft = re.match(r"https://[^/]+", seite).group(0)
    t = Test()
    dienste = seite_pruefen(t, seite, herkunft, jetzt)
    ablauf_pruefen(t, repo, os.environ.get("GH_TOKEN", ""), jetzt)
    dienste_pruefen(t, dienste, herkunft, jetzt)
    fahrplan_pruefen(t, seite, dienste, herkunft, jetzt)
    ok = all(p["ok"] for p in t.punkte)
    if os.environ.get("GITHUB_OUTPUT"):   # nur ein echter Test bewertet den Lauf (ein übersprungener meldet nichts doppelt)
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("geprueft=1\n")
    OUT.write_text(json.dumps({"t": jetzt.strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": ok, "punkte": t.punkte}, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Selbsttest: {sum(p['ok'] for p in t.punkte)} von {len(t.punkte)} in Ordnung")
    for p in t.punkte:
        if not p["ok"]:
            print("  ✗ " + p["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
