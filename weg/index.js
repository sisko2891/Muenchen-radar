// Katzingers Castle – Arbeitsweg (eigener Cloudflare-Dienst, unabhängig von der Heizung)
// Start- und Zieladresse kommen ausschließlich aus Secrets (WEG_START, WEG_ZIEL).
// Nach außen gehen nur Fahrzeit, Stau-Minuten und Abfahrtszeit – keine Adressen, Koordinaten oder Strecke.

const ORIGINS = ["https://sisko2891.github.io"];
const MAX_FAILS_IP = 5, FAIL_WINDOW = 15 * 60e3, MAX_FAILS_ALL = 30;

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
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    return env.WEG.get(env.WEG.idFromName("weg")).fetch(req);
  },
};

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0 && a.length > 0;
}

export class WegState {
  constructor(ctx, env) { this.s = ctx.storage; this.env = env; }

  async fetch(req) {
    const url = new URL(req.url);
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const now = Date.now();
    const lockAll = (await this.s.get("lockAll")) || 0;
    const fails = (await this.s.get("fail:" + ip)) || { n: 0, t: now };
    if (now - fails.t > FAIL_WINDOW) { fails.n = 0; fails.t = now; }
    if (lockAll > now || fails.n >= MAX_FAILS_IP) return json(req, 429, { error: "gesperrt", bis: Math.max(lockAll, fails.t + FAIL_WINDOW) });
    if (!(await safeEqual(req.headers.get("X-Castle-Pass") || "", this.env.WEG_PASS || ""))) {
      fails.n++; await this.s.put("fail:" + ip, fails);
      const all = (await this.s.get("failAll")) || { n: 0, t: now };
      if (now - all.t > 3600e3) { all.n = 0; all.t = now; }
      all.n++; await this.s.put("failAll", all);
      if (all.n >= MAX_FAILS_ALL) await this.s.put("lockAll", now + 3600e3);
      return json(req, 401, { error: "Passwort falsch", rest: Math.max(0, MAX_FAILS_IP - fails.n) });
    }
    if (fails.n) await this.s.delete("fail:" + ip);
    try {
      if (url.pathname === "/verkehr") return json(req, 200, await this.verkehr(url.searchParams.get("ankunft")));
      if (url.pathname === "/check") return json(req, 200, { ok: true });
      return json(req, 404, { error: "unbekannt" });
    } catch (e) {
      return json(req, e.code || 500, { error: e.message || "Fehler" });
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
    const t = new Date(ankunft);
    if (isNaN(t)) throw Object.assign(new Error("Ankunftszeit fehlt"), { code: 400 });
    const ck = t.toISOString().slice(0, 16);
    const cache = (await this.s.get("vk")) || {};
    for (const k of Object.keys(cache)) if (cache[k].until < Date.now()) delete cache[k];
    if (cache[ck]) return cache[ck].v;
    const [p1, p2] = await Promise.all([this.geo("start", a, key), this.geo("ziel", b, key)]);
    const q = new URLSearchParams({ key, traffic: "true", travelMode: "car", routeType: "fastest", computeTravelTimeFor: "all" });
    // Ankunft liegt weiter in der Zukunft: TomTom rechnet die Abfahrt mit Verkehrsprognose aus; sonst Lage ab jetzt
    if (t.getTime() - Date.now() > 20 * 60e3) q.set("arriveAt", t.toISOString().replace(/\.\d+Z$/, "Z"));
    else q.set("departAt", "now");
    const r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${p1.lat},${p1.lon}:${p2.lat},${p2.lon}/json?${q}`);
    if (r.status === 429) throw Object.assign(new Error("Verkehrsabfragen für heute aufgebraucht"), { code: 429 });
    if (!r.ok) throw Object.assign(new Error(`Verkehrsabfrage fehlgeschlagen (${r.status})`), { code: 502 });
    const sm = (await r.json()).routes?.[0]?.summary || {};
    const v = {
      minuten: Math.round((sm.travelTimeInSeconds || 0) / 60),
      stau: Math.round((sm.trafficDelayInSeconds || 0) / 60),
      los: sm.departureTime || null,
      stand: new Date().toISOString(),
    };
    cache[ck] = { until: Date.now() + 5 * 60e3, v };
    await this.s.put("vk", cache);
    return v;
  }
}
