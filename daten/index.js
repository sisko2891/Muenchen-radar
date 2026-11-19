// Katzingers Castle – geschützter Speicher für die privaten Daten (Dienste, Termine, Bild des Hausherrn)
// Die verschlüsselten Dateien liegen NICHT im öffentlichen Projekt, sondern hier. Herausgegeben werden sie nur gegen
// einen Zugangsschlüssel, den der Browser aus Dienst-PIN bzw. Kalender-Passwort berechnet (PBKDF2). Fehlversuche werden
// begrenzt – eine PIN lässt sich damit nicht mehr in Ruhe offline durchprobieren.
// Dienste und Termine bleiben zusätzlich Ende-zu-Ende verschlüsselt: Dieser Dienst kann sie nicht lesen.
// Secret: UPLOAD_HASH (SHA-256 des Schlüssels, mit dem nur der Datenabgleich in GitHub Actions schreiben darf).
//
// Außerdem Zeitgeber für den Datenabgleich: GitHub startet seine geplanten Läufe unzuverlässig (teils stundenlang gar
// nicht). Deshalb stößt dieser Dienst den Ablauf „Daten aktualisieren & veröffentlichen“ stündlich von außen an.
// Secret dafür: ANSTOSS_TOKEN (GitHub-Zugangsschlüssel, der nur Abläufe dieses einen Projekts starten darf).

const ORIGINS = ["https://sisko2891.github.io"];
const NAMEN = ["privat", "kalender", "kater", "verlauf"];   // erlaubte Ablagen
const MAX_BYTES = 400_000;                                  // Obergrenze je Ablage
const SLOT = /^[a-z]{1,8}$/;                                // Namen der Zugänge je Ablage (z. B. "k" = Kalender-Passwort)

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",                 // die Seite liest nur; geschrieben wird vom Datenabgleich (kein Browser)
    "Access-Control-Allow-Headers": "X-Castle-Key",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
const json = (req, status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    // Anfragen ganz ohne Schlüssel sofort abweisen – sie wecken den Speicher-Dienst gar nicht erst
    if (!req.headers.get("X-Castle-Key") && !req.headers.get("X-Upload-Key")) return json(req, 401, { error: "Zugang fehlt" });
    return env.DATEN.get(env.DATEN.idFromName("daten")).fetch(req);
  },
  // Zeitgeber (Zeitplan in wrangler.toml): startet den Datenabgleich bei GitHub. Der Ablauf entscheidet selbst, ob Arbeit
  // ansteht (Daten älter als ca. 2,5 h); „anlass: zeitplan“ unterscheidet den Anstoß von einem Start von Hand.
  async scheduled(event, env, ctx) {
    if (!env.ANSTOSS_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.ANSTOSS_REPO || "")) { console.log("Anstoß nicht eingerichtet"); return; }
    const r = await fetch(`https://api.github.com/repos/${env.ANSTOSS_REPO}/actions/workflows/update.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.ANSTOSS_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "katzingers-castle-zeitgeber", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { anlass: "zeitplan" } }),
    });
    // Lehnt GitHub ab (Schlüssel abgelaufen, Störung), endet der Lauf als Fehler – so steht er bei Cloudflare als gescheitert im Verlauf
    if (!r.ok) throw new Error(`Anstoß gescheitert (${r.status})`);
    console.log("Datenabgleich angestoßen");
  },
};

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async data => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const istHex64 = s => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
function hexBytes(s) { const u = new Uint8Array(32); for (let i = 0; i < 32; i++) u[i] = parseInt(s.substr(i * 2, 2), 16); return u; }

// ---------- Fehlversuche begrenzen (in allen Diensten gleich) ----------
const MAX_FAILS_IP = 5, FAIL_WINDOW = 15 * 60e3;               // 5 Fehlversuche je Anschluss in 15 min
const MAX_FAILS_ALL = 30, ALL_WINDOW = 3600e3, LOCK = 3600e3;  // 30 Fehlversuche insgesamt je Stunde -> 1 h Sperre für Unbekannte
const OK_TTL = 30 * 864e5, MAX_EINTRAEGE = 400;

// IPv6: ein ganzer Anschluss (/64) zählt als eine Adresse – sonst hätte jeder beliebig viele Versuche
function anschluss(ip) {
  if (!ip.includes(":")) return ip;
  const [a, b = ""] = ip.split("::");
  const h = a ? a.split(":") : [], t = b ? b.split(":") : [];
  const voll = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return voll.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(":") + "::/64";
}

// Vergleich ohne Zeitunterschiede: beide Seiten werden zuerst gehasht
async function gleich(a, b) {
  const e = new TextEncoder();
  const [x, y] = (await Promise.all([crypto.subtle.digest("SHA-256", e.encode(a)), crypto.subtle.digest("SHA-256", e.encode(b))])).map(v => new Uint8Array(v));
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

class Bremse {
  constructor(storage) { this.s = storage; this.kette = Promise.resolve(); }
  // Prüfungen laufen streng nacheinander: gleichzeitige Anfragen können die Zählung nicht unterlaufen
  nacheinander(fn) { const p = this.kette.then(fn, fn); this.kette = p.catch(() => {}); return p; }
  async laden() {
    const now = Date.now();
    let r = await this.s.get("rl");
    if (!r) r = { ip: {}, ok: {}, alle: { n: 0, t: now }, sperre: 0 };
    for (const k of Object.keys(r.ip)) if (now - r.ip[k].t > FAIL_WINDOW) delete r.ip[k];
    for (const k of Object.keys(r.ok)) if (now - r.ok[k] > OK_TTL) delete r.ok[k];
    if (now - r.alle.t > ALL_WINDOW) r.alle = { n: 0, t: now };
    return r;
  }
  kuerzen(o, wert) {   // nie unbegrenzt wachsen: älteste Einträge zuerst entfernen
    const k = Object.keys(o);
    if (k.length > MAX_EINTRAEGE) k.sort((a, b) => wert(o[a]) - wert(o[b])).slice(0, k.length - MAX_EINTRAEGE).forEach(x => delete o[x]);
  }
  // Zeitpunkt, bis zu dem dieser Anschluss nichts versuchen darf (0 = frei)
  gesperrt(r, ip) {
    if ((r.ip[ip]?.n || 0) >= MAX_FAILS_IP) return r.ip[ip].t + FAIL_WINDOW;
    // allgemeine Sperre nach vielen Fehlversuchen von überall – wer zuletzt richtig lag (das eigene Zuhause), bleibt frei
    if (r.sperre > Date.now() && !r.ok[ip]) return r.sperre;
    return 0;
  }
  async fehlversuch(r, ip) {
    const now = Date.now();
    r.ip[ip] = { n: (r.ip[ip]?.n || 0) + 1, t: r.ip[ip]?.t || now };
    r.alle.n++;
    if (r.alle.n >= MAX_FAILS_ALL) r.sperre = now + LOCK;
    this.kuerzen(r.ip, v => v.t);
    await this.s.put("rl", r);
    return Math.max(0, MAX_FAILS_IP - r.ip[ip].n);
  }
  async treffer(r, ip) {
    const now = Date.now(), neu = !r.ok[ip] || now - r.ok[ip] > 6 * 3600e3, hatte = !!r.ip[ip];
    if (!neu && !hatte) return;                      // nichts zu speichern (spart Schreibvorgänge)
    delete r.ip[ip]; r.ok[ip] = now; this.kuerzen(r.ok, v => v);
    await this.s.put("rl", r);
  }
  // Passwort einer Anfrage prüfen: null = in Ordnung, sonst { status, body } für die Antwort
  async pruefen(req, soll) {
    const given = req.headers.get("X-Castle-Pass") || "";
    if (!given) return { status: 401, body: { error: "Passwort fehlt" } };      // kein Rateversuch, wird nicht gezählt
    const ip = anschluss(req.headers.get("CF-Connecting-IP") || "?");
    return this.nacheinander(async () => {
      const r = await this.laden(), bis = this.gesperrt(r, ip);
      if (bis) return { status: 429, body: { error: "gesperrt", bis } };
      if (soll && await gleich(given, soll)) { await this.treffer(r, ip); return null; }
      return { status: 401, body: { error: "Passwort falsch", rest: await this.fehlversuch(r, ip) } };
    });
  }
}
// ---------- Ende: Fehlversuche begrenzen ----------


export class DatenState {
  constructor(ctx, env) { this.s = ctx.storage; this.env = env; this.bremse = new Bremse(ctx.storage); }

  async fetch(req) {
    const url = new URL(req.url), teile = url.pathname.split("/").filter(Boolean);   // /blob/<name> | /zugang/<name> | /stand/<name>
    const [art, name] = teile;
    if (teile.length !== 2 || !["blob", "zugang", "stand"].includes(art) || !NAMEN.includes(name)) return json(req, 404, { error: "unbekannt" });
    const ip = anschluss(req.headers.get("CF-Connecting-IP") || "?");
    try {
      if (req.method === "GET" && art === "blob") return await this.lesen(req, name, ip);
      if ((req.method === "PUT" && art !== "stand") || (req.method === "GET" && art === "stand")) return await this.abgleich(req, art, name, ip);
      return json(req, 405, { error: "nicht erlaubt" });
    } catch (e) {
      return json(req, 500, { error: "Fehler" });
    }
  }

  async passt(b, key) {
    const h = hex(await sha256(hexBytes(key)));
    let ok = false;
    for (const z of Object.values(b.zugang || {})) if (await gleich(h, z)) ok = true;   // immer alle vergleichen
    return ok;
  }

  // ---------- Lesen: nur mit passendem Zugangsschlüssel ----------
  async lesen(req, name, ip) {
    const key = (req.headers.get("X-Castle-Key") || "").toLowerCase();
    if (!istHex64(key)) return json(req, 401, { error: "Zugang fehlt" });        // kein Rateversuch, wird nicht gezählt
    // Der Datenabgleich (mit Schreibschlüssel) prüft nur, ob sein Schlüssel noch passt – das zählt nie als Fehlversuch
    if (await this.darfSchreiben(req)) {
      const b = await this.s.get("b:" + name);
      if (!b) return json(req, 404, { error: "leer" });
      return (await this.passt(b, key)) ? json(req, 200, { inhalt: b.inhalt, t: b.t }) : json(req, 403, { error: "Zugang passt nicht" });
    }
    return this.bremse.nacheinander(async () => {
      const r = await this.bremse.laden(), bis = this.bremse.gesperrt(r, ip);
      if (bis) return json(req, 429, { error: "gesperrt", bis });
      const b = await this.s.get("b:" + name);
      if (!b) return json(req, 404, { error: "leer" });
      if (await this.passt(b, key)) { await this.bremse.treffer(r, ip); return json(req, 200, { inhalt: b.inhalt, t: b.t }); }
      return json(req, 401, { error: "Zugang falsch", rest: await this.bremse.fehlversuch(r, ip) });
    });
  }

  // ---------- Schreiben und Stand: nur der Datenabgleich ----------
  async darfSchreiben(req) {
    const k = req.headers.get("X-Upload-Key") || "", soll = this.env.UPLOAD_HASH || "";
    return istHex64(soll) && k.length >= 32 && await gleich(hex(await sha256(enc.encode(k))), soll);
  }
  zugaenge(z) {   // { slot: hash | null } prüfen
    if (!z || typeof z !== "object" || Array.isArray(z)) return null;
    const e = Object.entries(z).map(([k, v]) => [k, v == null ? null : String(v).toLowerCase()]);
    if (!e.length || e.length > 6 || !e.every(([k, v]) => SLOT.test(k) && (v === null || istHex64(v)))) return null;
    return e;
  }
  async abgleich(req, art, name, ip) {
    if (!(req.headers.get("X-Upload-Key") || "")) return json(req, 401, { error: "nicht erlaubt" });
    // Der richtige Schreibschlüssel (256 Bit, nicht zu erraten) wird nie gebremst – sonst könnte jeder mit ein paar
    // falschen Anfragen den Datenabgleich aussperren. Gezählt und gesperrt werden nur falsche Schlüssel.
    if (!(await this.darfSchreiben(req))) return this.bremse.nacheinander(async () => {
      const r = await this.bremse.laden(), bis = this.bremse.gesperrt(r, ip);
      if (bis) return json(req, 429, { error: "gesperrt", bis });
      await this.bremse.fehlversuch(r, ip);
      return json(req, 401, { error: "nicht erlaubt" });
    });
    const alt = await this.s.get("b:" + name);
    if (art === "stand") return json(req, 200, alt ? { leer: false, t: alt.t, zugang: Object.keys(alt.zugang || {}) } : { leer: true });
    const text = await req.text();
    if (text.length > MAX_BYTES) return json(req, 413, { error: "zu groß" });
    let body; try { body = JSON.parse(text); } catch { return json(req, 400, { error: "kein JSON" }); }
    const neu = this.zugaenge(body?.zugang);
    if (!neu) return json(req, 400, { error: "Zugang fehlt" });
    if (art === "zugang") {            // nur Zugänge setzen oder entfernen (z. B. nach PIN-Wechsel), Inhalt bleibt
      if (!alt) return json(req, 404, { error: "leer" });
      for (const [k, v] of neu) { if (v === null) delete alt.zugang[k]; else alt.zugang[k] = v; }
      if (!Object.keys(alt.zugang).length) return json(req, 400, { error: "Zugang fehlt" });
      await this.s.put("b:" + name, alt);
      return json(req, 200, { ok: true, t: alt.t, zugang: Object.keys(alt.zugang) });
    }
    if (body.inhalt == null || typeof body.inhalt !== "object") return json(req, 400, { error: "Inhalt fehlt" });
    const zugang = Object.fromEntries(neu.filter(([, v]) => v !== null));
    if (!Object.keys(zugang).length) return json(req, 400, { error: "Zugang fehlt" });
    const t = Date.now();
    await this.s.put("b:" + name, { inhalt: body.inhalt, zugang, t });
    return json(req, 200, { ok: true, t });
  }
}
