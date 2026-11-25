#!/usr/bin/env python3
"""Zugriff auf den geschützten Speicher (Cloudflare-Dienst `daten/`) für den Datenabgleich.

Die verschlüsselten privaten Daten liegen nicht im öffentlichen Projekt, sondern in diesem Dienst.
Geschrieben wird mit DATEN_UPLOAD_KEY, gelesen mit einem Zugangsschlüssel, der aus PIN bzw. Passwort
berechnet wird (derselbe wie im Browser). Beide Werte kommen nie ins Protokoll.
"""
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ITER = 600_000
UA = "katzingers-castle-abgleich/1.0"


def url():
    """Adresse des Dienstes (schreibt der Ablauf daten-deploy.yml nach data/daten.json) oder None."""
    try:
        u = (json.loads((ROOT / "data" / "daten.json").read_text()).get("url") or "").rstrip("/")
    except (OSError, ValueError):
        return None
    # der Schreibschlüssel geht nur an den eigenen Dienst: genau ein Rechnername unter dem eigenen workers.dev-Konto,
    # nichts dahinter (für lokale Tests: DATEN_TEST=1)
    ok = re.fullmatch(r"https://[a-z0-9-]+\.katzingers-castle\.workers\.dev", u) or os.environ.get("DATEN_TEST") == "1"
    return u if u and ok else None


def _key():
    return os.environ.get("DATEN_UPLOAD_KEY", "")


def eingerichtet():
    return url() is not None


def aktiv():
    return bool(url() and len(_key()) >= 32)


def intern():
    """Geheimnis für Ablagen, die nur der Abgleich selbst liest (Verlauf); kennt weder die Seite noch das iPad."""
    g = os.environ.get("DATEN_INTERN", "")
    return g if len(g) >= 32 else ""


def zugangsschluessel(geheimnis, name):
    """32 Byte, wie im Browser: PBKDF2-SHA256 über das Geheimnis, Salt = fester Text je Ablage."""
    return hashlib.pbkdf2_hmac("sha256", geheimnis.encode(), ("katzingers-castle/zugang/v1/" + name).encode(), ITER, 32)


def zugang(geheimnis, name):
    """Was der Dienst speichert: nur der Hash des Zugangsschlüssels."""
    return hashlib.sha256(zugangsschluessel(geheimnis, name)).hexdigest()


def _call(methode, pfad, kopf=None, body=None):
    data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    letzter = None
    for versuch in range(3):
        req = urllib.request.Request(url() + pfad, method=methode, data=data,
                                     headers={"User-Agent": UA, "Content-Type": "application/json", "X-Upload-Key": _key(), **(kopf or {})})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            if e.code >= 500 and versuch < 2:      # Störung beim Dienst: kurz warten, erneut versuchen
                letzter = e
                time.sleep(3 * (versuch + 1))
                continue
            try:
                return e.code, json.loads(e.read().decode() or "{}")
            except ValueError:
                return e.code, {}
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            letzter = e
            if versuch < 2:
                time.sleep(3 * (versuch + 1))
    raise RuntimeError(f"Speicher nicht erreichbar ({type(letzter).__name__})")


def stand(name):
    """{'leer': True} oder {'leer': False, 't': Zeitpunkt in ms, 'zugang': [Namen der Zugänge]}."""
    status, d = _call("GET", "/stand/" + name)
    if status != 200:
        raise RuntimeError(f"Speicher antwortet mit {status}")
    return d


def pause(name="privat"):
    """Pause des automatischen Abrufs (von der Seite gesetzt): {"seit", "bis"} oder None. bis = None heißt: bis zum Fortsetzen."""
    status, d = _call("GET", "/pause/" + name)
    if status != 200:
        raise RuntimeError(f"Speicher antwortet mit {status}")
    return d.get("pause")


def lesen(name, geheimnis):
    """(inhalt, zeitpunkt_ms) der Ablage oder (None, None), wenn sie leer ist oder der Schlüssel nicht (mehr) passt."""
    status, d = _call("GET", "/blob/" + name, {"X-Castle-Key": zugangsschluessel(geheimnis, name).hex()})
    if status == 200:
        return d.get("inhalt"), d.get("t")
    if status in (403, 404):
        return None, None
    raise RuntimeError(f"Speicher antwortet mit {status}")


def schreiben(name, inhalt, zugaenge):
    """Ablage ersetzen; zugaenge = {Name: PIN/Passwort} für alle, die lesen dürfen. Prüft durch Zurücklesen."""
    status, d = _call("PUT", "/blob/" + name, body={"inhalt": inhalt, "zugang": {k: zugang(g, name) for k, g in zugaenge.items()}})
    if status != 200:
        raise RuntimeError(f"Speichern abgelehnt ({status})")
    zurueck, _ = lesen(name, next(iter(zugaenge.values())))
    if zurueck != inhalt:
        raise RuntimeError("Kontrolle nach dem Speichern fehlgeschlagen")
    return d.get("t")


def zugang_setzen(name, slot, geheimnis):
    """Einen Zugang neu setzen (z. B. nach PIN-Wechsel), der Inhalt bleibt; False, wenn die Ablage leer ist."""
    status, _ = _call("PUT", "/zugang/" + name, body={"zugang": {slot: zugang(geheimnis, name)}})
    if status == 404:
        return False
    if status != 200:
        raise RuntimeError(f"Zugang setzen abgelehnt ({status})")
    return True


def bild_pflegen(slot, geheimnis):
    """Bild des Hausherrn: den eigenen Zugang aktuell halten – nach einem PIN-/Passwortwechsel passt der alte nicht
    mehr, das Bild selbst bleibt. Fehler hier halten den übrigen Abgleich nicht auf."""
    try:
        inhalt, _ = lesen("kater", geheimnis)
        if inhalt is None and not stand("kater").get("leer"):
            zugang_setzen("kater", slot, geheimnis)
    except Exception as e:  # noqa: BLE001 – bewusst breit: das Bild ist Beiwerk
        print("Zugang zum Bild konnte nicht erneuert werden:", type(e).__name__)
