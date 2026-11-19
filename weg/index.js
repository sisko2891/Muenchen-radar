// Katzingers Castle – Arbeitsweg (eigener Cloudflare-Dienst, unabhängig von der Heizung)
// Start- und Zieladresse kommen ausschließlich aus Secrets (WEG_START, WEG_ZIEL).
// Nach außen gehen nur Fahrzeit, Stau-Minuten und Abfahrtszeit – keine Adressen, Koordinaten oder Strecke.

const ORIGINS = ["https://sisko2891.github.io"];

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-Castle-Pass",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
const json = (req, status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    // Anfragen ganz ohne Passwort sofort abweisen – sie wecken den Speicher-Dienst gar nicht erst
    if (!req.headers.get("X-Castle-Pass")) return json(req, 401, { error: "Passwort fehlt" });
    return env.WEG.get(env.WEG.idFromName("weg")).fetch(req);
  },
};


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


export class WegState {
  constructor(ctx, env) { this.s = ctx.storage; this.env = env; this.bremse = new Bremse(ctx.storage); }

  async fetch(req) {
    const url = new URL(req.url);
    const p = await this.bremse.pruefen(req, this.env.WEG_PASS);
    if (p) return json(req, p.status, p.body);
    try {
      if (url.pathname === "/verkehr") return json(req, 200, await this.verkehr(url.searchParams.get("ankunft")));
      if (url.pathname === "/check") return json(req, 200, { ok: true });
      return json(req, 404, { error: "unbekannt" });
    } catch (e) {
      // Unerwartetes (TomTom nicht erreichbar oder Antwort unlesbar): keine rohe Laufzeit-Meldung nach außen
      if (!(Number.isInteger(e.code) && e.code >= 400 && e.code <= 599)) return json(req, 502, { error: "Verkehrsdienst gerade nicht erreichbar" });
      return json(req, e.code, { error: e.message || "Fehler" });
    }
  }

  async geo(slot, addr, key) {
    // Nur ein Fingerabdruck der Adresse wird zum Vergleich gespeichert, nicht die Adresse selbst
    const fp = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(addr)))).slice(0, 8).join(".");
    const c = await this.s.get("geo:" + slot);
    if (c && c.fp === fp) return c;
    const r = await fetch(`https://api.tomtom.com/search/2/geocode/${encodeURIComponent(addr)}.json?key=${key}&limit=1&countrySet=DE&language=de-DE`);
    if (!r.ok) throw Object.assign(new Error("Adresse nicht auflösbar"), { code: 502 });
    const p = (await r.json()).results?.[0]?.position;
    if (!p) throw Object.assign(new Error(`${slot === "start" ? "Start" : "Ziel"}adresse nicht gefunden`), { code: 502 });
    const v = { fp, lat: p.lat, lon: p.lon };
    await this.s.put("geo:" + slot, v);
    return v;
  }

  async verkehr(ankunft) {
    const key = this.env.TOMTOM_KEY, a = this.env.WEG_START, b = this.env.WEG_ZIEL;
    if (!key || !a || !b) throw Object.assign(new Error("Arbeitsweg nicht eingerichtet"), { code: 501 });
    const t = new Date(ankunft || NaN);
    if (isNaN(t)) throw Object.assign(new Error("Ankunftszeit fehlt"), { code: 400 });
    const ck = t.toISOString().slice(0, 16);
    const cache = (await this.s.get("vk")) || {};
    for (const k of Object.keys(cache)) if (cache[k].until < Date.now()) delete cache[k];
    if (cache[ck]) return cache[ck].v;
    const [p1, p2] = await Promise.all([this.geo("start", a, key), this.geo("ziel", b, key)]);
    const q = new URLSearchParams({ key, traffic: "true", travelMode: "car", routeType: "fastest", computeTravelTimeFor: "all" });
    // Ankunft liegt weiter in der Zukunft: TomTom rechnet die Abfahrt mit Verkehrsprognose aus; sonst Lage ab jetzt
    const jetzt = !(t.getTime() - Date.now() > 20 * 60e3);
    if (jetzt) q.set("departAt", "now"); else q.set("arriveAt", t.toISOString().replace(/\.\d+Z$/, "Z"));
    const r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${p1.lat},${p1.lon}:${p2.lat},${p2.lon}/json?${q}`);
    if (r.status === 429) throw Object.assign(new Error("Verkehrsabfragen für heute aufgebraucht"), { code: 429 });
    if (!r.ok) throw Object.assign(new Error(`Verkehrsabfrage fehlgeschlagen (${r.status})`), { code: 502 });
    const sm = (await r.json()).routes?.[0]?.summary || {};
    const sek = sm.travelTimeInSeconds || 0;
    const v = {
      minuten: Math.round(sek / 60),
      stau: Math.round((sm.trafficDelayInSeconds || 0) / 60),
      // kurz vor der Ankunft rechnet TomTom „ab jetzt“ – die nötige Abfahrtszeit ergibt sich dann aus Ankunft minus Fahrzeit
      los: jetzt ? (sek ? new Date(t.getTime() - sek * 1000).toISOString() : null) : (sm.departureTime || null),
      stand: new Date().toISOString(),
    };
    cache[ck] = { until: Date.now() + 5 * 60e3, v };
    await this.s.put("vk", cache);
    return v;
  }
}
