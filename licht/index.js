// Katzingers Castle – Licht (Philips Hue über die offizielle Remote API)
// Eigener Cloudflare-Dienst mit eigenem Passwort (LICHT_PASS), getrennt von Heizung und Arbeitsweg.
// Secrets: HUE_CLIENT_ID, HUE_CLIENT_SECRET, LICHT_PASS. Zugang zu Hue wird hier verwahrt, nie auf der Seite.

const ORIGINS = ["https://sisko2891.github.io"];
const HUE = "https://api.meethue.com";
const MAX_FAILS_IP = 5, FAIL_WINDOW = 15 * 60e3, MAX_FAILS_ALL = 30;

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Castle-Pass",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
const json = (req, status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) } });
const page = (title, text) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:17px system-ui;background:#0f1b2d;color:#f4f6fa;display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px">` +
  `<div><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p></div></body>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    return env.LICHT.get(env.LICHT.idFromName("licht")).fetch(req);
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
const err = (msg, code) => Object.assign(new Error(msg), { code });

export class LichtState {
  constructor(ctx, env) { this.s = ctx.storage; this.env = env; }

  async fetch(req) {
    const url = new URL(req.url);
    // Rücksprung von Hue nach der Anmeldung: ohne Passwort, aber nur mit gültigem Einmal-Code (state)
    if (url.pathname === "/callback") return this.callback(url);

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const now = Date.now();
    const lockAll = (await this.s.get("lockAll")) || 0;
    const fails = (await this.s.get("fail:" + ip)) || { n: 0, t: now };
    if (now - fails.t > FAIL_WINDOW) { fails.n = 0; fails.t = now; }
    if (lockAll > now || fails.n >= MAX_FAILS_IP) return json(req, 429, { error: "gesperrt", bis: Math.max(lockAll, fails.t + FAIL_WINDOW) });
    if (!(await safeEqual(req.headers.get("X-Castle-Pass") || "", this.env.LICHT_PASS || ""))) {
      fails.n++; await this.s.put("fail:" + ip, fails);
      const all = (await this.s.get("failAll")) || { n: 0, t: now };
      if (now - all.t > 3600e3) { all.n = 0; all.t = now; }
      all.n++; await this.s.put("failAll", all);
      if (all.n >= MAX_FAILS_ALL) await this.s.put("lockAll", now + 3600e3);
      return json(req, 401, { error: "Passwort falsch", rest: Math.max(0, MAX_FAILS_IP - fails.n) });
    }
    if (fails.n) await this.s.delete("fail:" + ip);
    try {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      switch (url.pathname) {
        case "/check": return json(req, 200, { ok: true });
        case "/status": return json(req, 200, await this.status());
        case "/set": return json(req, 200, await this.set(body));
        case "/szene": return json(req, 200, await this.szene(body.id));
        case "/allesaus": return json(req, 200, await this.allesAus());
        case "/login/start": return json(req, 200, await this.loginStart(url));
        case "/kater": return json(req, 200, req.method === "POST" ? await this.katerSet(body) : await this.kater());
        default: return json(req, 404, { error: "unbekannt" });
      }
    } catch (e) {
      return json(req, e.code || 500, { error: e.message || "Fehler" });
    }
  }

  // ---------- Anmeldung bei Hue (einmalig, OAuth) ----------
  async loginStart(url) {
    if (!this.env.HUE_CLIENT_ID || !this.env.HUE_CLIENT_SECRET) throw err("Hue-Zugangsdaten fehlen (Secrets)", 501);
    const state = crypto.randomUUID();
    await this.s.put("state", { v: state, until: Date.now() + 10 * 60e3 });
    const q = new URLSearchParams({ client_id: this.env.HUE_CLIENT_ID, response_type: "code", state });
    return { link: `${HUE}/v2/oauth2/authorize?${q}` };
  }
  async callback(url) {
    const st = await this.s.get("state");
    if (!st || st.until < Date.now() || url.searchParams.get("state") !== st.v)
      return page("Anmeldung abgelaufen", "Bitte auf der Seite erneut „Hue verbinden“ tippen.");
    await this.s.delete("state");
    const code = url.searchParams.get("code");
    if (!code) return page("Anmeldung abgebrochen", "Hue hat keine Freigabe erteilt.");
    try {
      await this.tokenRequest({ grant_type: "authorization_code", code });
      // Zugang auf der Bridge anlegen (virtueller Knopfdruck + App-Schlüssel)
      const tok = (await this.s.get("access")).t;
      await fetch(`${HUE}/route/api/0/config`, { method: "PUT", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify({ linkbutton: true }) });
      const r = await fetch(`${HUE}/route/api`, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify({ devicetype: "katzingers#castle" }) });
      const d = await r.json().catch(() => []);
      const user = d?.[0]?.success?.username;
      if (!user) throw new Error(d?.[0]?.error?.description || "Bridge hat keinen Zugang erteilt");
      await this.s.put("appkey", user);
      await this.s.put("connectedAt", Date.now());
      return page("Hue verbunden ✓", "Du kannst dieses Fenster schließen und zur Seite zurückkehren.");
    } catch (e) {
      return page("Verbindung fehlgeschlagen", String(e.message || e));
    }
  }
  async tokenRequest(params) {
    const basic = btoa(`${this.env.HUE_CLIENT_ID}:${this.env.HUE_CLIENT_SECRET}`);
    const r = await fetch(`${HUE}/v2/oauth2/token`, {
      method: "POST", headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) {
      const e = err(`Hue-Anmeldung abgelehnt (${t.error || r.status})`, r.status === 400 || r.status === 401 ? 409 : 502);
      e.hueError = t.error; throw e;
    }
    await this.s.put("access", { t: t.access_token, until: Date.now() + ((t.expires_in || 3600) - 300) * 1000 });
    if (t.refresh_token) await this.s.put("refresh", t.refresh_token);
    return t.access_token;
  }
  async token() {
    const a = await this.s.get("access");
    if (a && a.until > Date.now()) return a.t;
    // nur eine Erneuerung gleichzeitig (Refresh-Token kann bei Nutzung ersetzt werden)
    if (!this.refreshing) this.refreshing = (async () => {
      const a2 = await this.s.get("access");
      if (a2 && a2.until > Date.now()) return a2.t;
      const rt = await this.s.get("refresh");
      if (!rt) throw err("Hue nicht verbunden", 409);
      try { return await this.tokenRequest({ grant_type: "refresh_token", refresh_token: rt }); }
      catch (e) {
        const now = await this.s.get("refresh");
        if (now && now !== rt) return this.tokenRequest({ grant_type: "refresh_token", refresh_token: now });
        if (e.hueError === "invalid_grant") await this.s.delete("refresh");
        throw e;
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async clip(method, path, body) {
    const key = await this.s.get("appkey");
    if (!key) throw err("Hue nicht verbunden", 409);
    const tok = await this.token();
    const r = await fetch(`${HUE}/route/clip/v2/resource${path}`, {
      method, headers: { Authorization: "Bearer " + tok, "hue-application-key": key, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) throw err("Hue: zu viele Anfragen, gleich wieder", 429);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw err(`Hue-Fehler ${r.status}${d.errors?.[0]?.description ? " – " + d.errors[0].description : ""}`, 502);
    return d.data || [];
  }

  // ---------- Hausherr: Futter & Katzenklo (nur Zeitpunkte) ----------
  async kater() {
    return { futter: (await this.s.get("k:futter")) || null, klo: (await this.s.get("k:klo")) || null };
  }
  async katerSet({ art, zurueck }) {
    if (!["futter", "klo"].includes(art)) throw err("unbekannt", 400);
    if (zurueck) {
      const prev = await this.s.get("k:prev:" + art);
      if (prev === undefined) throw err("nichts zum Zurücknehmen", 409);
      if (prev) await this.s.put("k:" + art, prev); else await this.s.delete("k:" + art);
      await this.s.delete("k:prev:" + art);
    } else {
      await this.s.put("k:prev:" + art, (await this.s.get("k:" + art)) || 0);
      await this.s.put("k:" + art, Date.now());
    }
    return this.kater();
  }

  // ---------- Daten & Steuerung ----------
  async status() {
    const [rooms, zones, groups, scenes] = await Promise.all([
      this.clip("GET", "/room"), this.clip("GET", "/zone"), this.clip("GET", "/grouped_light"), this.clip("GET", "/scene"),
    ]);
    const gl = Object.fromEntries(groups.map(g => [g.id, g]));
    const glOf = x => (x.services || []).find(s => s.rtype === "grouped_light")?.rid;
    const bereiche = [...rooms.map(r => ({ r, typ: "raum" })), ...zones.map(r => ({ r, typ: "zone" }))].map(({ r, typ }) => {
      const g = gl[glOf(r)];
      return {
        id: glOf(r), gruppe: r.id, typ, name: r.metadata?.name || "Bereich",
        an: !!g?.on?.on, hell: g?.dimming ? Math.round(g.dimming.brightness) : null,
        szenen: scenes.filter(s => s.group?.rid === r.id).map(s => ({ id: s.id, name: s.metadata?.name || "Szene" }))
          .sort((a, b) => a.name.localeCompare(b.name, "de")),
      };
    }).filter(b => b.id).sort((a, b) => (a.typ === b.typ ? a.name.localeCompare(b.name, "de") : a.typ === "raum" ? -1 : 1));
    return { stand: new Date().toISOString(), bereiche };
  }
  async set({ id, an, hell }) {
    if (!id || typeof id !== "string") throw err("Bereich fehlt", 400);
    const body = {};
    if (typeof an === "boolean") body.on = { on: an };
    if (hell != null) { const h = Math.max(1, Math.min(100, Number(hell))); body.dimming = { brightness: h }; body.on = { on: true }; }
    if (!Object.keys(body).length) throw err("nichts zu tun", 400);
    await this.clip("PUT", `/grouped_light/${id}`, body);
    return this.status();
  }
  async szene(id) {
    if (!id || typeof id !== "string") throw err("Szene fehlt", 400);
    await this.clip("PUT", `/scene/${id}`, { recall: { action: "active" } });
    return this.status();
  }
  async allesAus() {
    const groups = await this.clip("GET", "/grouped_light");
    const home = groups.find(g => g.owner?.rtype === "bridge_home");
    if (home) await this.clip("PUT", `/grouped_light/${home.id}`, { on: { on: false } });
    else for (const g of groups) await this.clip("PUT", `/grouped_light/${g.id}`, { on: { on: false } });
    return this.status();
  }
}
