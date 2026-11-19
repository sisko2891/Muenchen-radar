// Katzingers Castle – Licht (Philips Hue über die offizielle Remote API)
// Eigener Cloudflare-Dienst mit eigenem Passwort (LICHT_PASS), getrennt von Heizung und Arbeitsweg.
// Secrets: HUE_CLIENT_ID, HUE_CLIENT_SECRET, LICHT_PASS; optional WLAN_NAME, WLAN_PASS (Gäste-WLAN für den QR-Code). Zugang zu Hue wird hier verwahrt, nie auf der Seite.

const ORIGINS = ["https://sisko2891.github.io"];
const HUE = "https://api.meethue.com";
const ID = /^[0-9a-f-]{20,64}$/i;   // Hue-Kennungen (UUID) – nichts anderes darf in eine Hue-Adresse gelangen

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
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors(req) } });
const escH = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const page = (title, text) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(title)}</title>` +
  `<body style="font:17px system-ui;background:#0f1b2d;color:#f4f6fa;display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px">` +
  `<div><h1 style="font-size:1.3rem">${escH(title)}</h1><p>${escH(text)}</p></div></body>`,
  { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    // Anfragen ganz ohne Passwort sofort abweisen – sie wecken den Speicher-Dienst gar nicht erst (Ausnahme: Rücksprung von Hue)
    if (!req.headers.get("X-Castle-Pass") && new URL(req.url).pathname !== "/callback") return json(req, 401, { error: "Passwort fehlt" });
    return env.LICHT.get(env.LICHT.idFromName("licht")).fetch(req);
  },
};

const err = (msg, code) => Object.assign(new Error(msg), { code });

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


export class LichtState {
  constructor(ctx, env) { this.s = ctx.storage; this.env = env; this.bremse = new Bremse(ctx.storage); }

  async fetch(req) {
    const url = new URL(req.url);
    // Rücksprung von Hue nach der Anmeldung: ohne Passwort, aber nur mit gültigem Einmal-Code (state)
    if (url.pathname === "/callback") return this.callback(url);

    const p = await this.bremse.pruefen(req, this.env.LICHT_PASS);
    if (p) return json(req, p.status, p.body);
    try {
      const body = req.method === "POST" ? (await req.json().catch(() => null)) || {} : {};
      switch (url.pathname) {
        case "/check": return json(req, 200, { ok: true });
        case "/status": return json(req, 200, await this.status());
        case "/set": return json(req, 200, await this.set(body));
        case "/szene": return json(req, 200, await this.szene(body.id));
        case "/allesaus": return json(req, 200, await this.allesAus());
        case "/login/start": return json(req, 200, await this.loginStart(url));
        case "/kater": return json(req, 200, req.method === "POST" ? await this.katerSet(body) : await this.kater());
        case "/wlan": return json(req, 200, this.wlan());
        default: return json(req, 404, { error: "unbekannt" });
      }
    } catch (e) {
      // Unerwartetes (Hue nicht erreichbar oder Antwort unlesbar): keine rohe Laufzeit-Meldung nach außen
      if (!(Number.isInteger(e.code) && e.code >= 400 && e.code <= 599)) return json(req, 502, { error: "Hue gerade nicht erreichbar" });
      return json(req, e.code, { error: e.message || "Fehler" });
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
      await this.s.delete("meta");
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
  async clip(method, path, body, nochmal = true) {
    const key = await this.s.get("appkey");
    if (!key) throw err("Hue nicht verbunden", 409);
    const tok = await this.token();
    const r = await fetch(`${HUE}/route/clip/v2/resource${path}`, {
      method, headers: { Authorization: "Bearer " + tok, "hue-application-key": key, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) throw err("Hue: zu viele Anfragen, gleich wieder", 429);
    // Zugang nicht mehr gültig: einmal mit frischem Token versuchen, sonst „neu verbinden“ melden (statt dauerhaft Fehler 502)
    if (r.status === 401 && nochmal) { await this.s.delete("access"); return this.clip(method, path, body, false); }
    if (r.status === 401 || (r.status === 403 && method === "GET")) throw err("Hue-Zugang ungültig – bitte neu verbinden", 409);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw err(`Hue-Fehler ${r.status}${d.errors?.[0]?.description ? " – " + d.errors[0].description : ""}`, 502);
    return d.data || [];
  }

  // ---------- Hausherr: Futter & Katzenklo (nur Zeitpunkte) ----------
  async kater() {
    // wlan: nur die Angabe, ob Gäste-WLAN-Daten hinterlegt sind (die Daten selbst gibt nur /wlan heraus)
    return { futter: (await this.s.get("k:futter")) || null, klo: (await this.s.get("k:klo")) || null, wlan: !!(this.env.WLAN_NAME && this.env.WLAN_PASS) };
  }
  // Gäste-WLAN für den QR-Code auf der Seite: liegt nur hier als Secret, nie im öffentlichen Projekt
  wlan() {
    if (!this.env.WLAN_NAME || !this.env.WLAN_PASS) throw err("WLAN ist nicht eingerichtet", 404);
    return { ssid: this.env.WLAN_NAME, pass: this.env.WLAN_PASS, typ: "WPA" };
  }
  async katerSet({ art, zurueck } = {}) {
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
  // Räume, Zonen und Szenen ändern sich fast nie: 10 Minuten merken (1 statt 4 Hue-Abfragen je Abruf). Gemerkt wird im
  // dauerhaften Speicher – den Arbeitsspeicher räumt Cloudflare schon nach wenigen Sekunden Ruhe ab – und nur das Nötige.
  async meta() {
    const m = await this.s.get("meta");
    if (m && Date.now() - m.at < 10 * 60e3) return m.v;
    const [rooms, zones, scenes] = await Promise.all([this.clip("GET", "/room"), this.clip("GET", "/zone"), this.clip("GET", "/scene")]);
    const kurz = (x, typ) => ({ id: x.id, typ, name: x.metadata?.name || "Bereich", gl: (x.services || []).find(s => s.rtype === "grouped_light")?.rid || null });
    const v = {
      bereiche: [...rooms.map(r => kurz(r, "raum")), ...zones.map(r => kurz(r, "zone"))].filter(b => b.gl),
      szenen: scenes.map(s => ({ id: s.id, name: s.metadata?.name || "Szene", gruppe: s.group?.rid || null })),
    };
    await this.s.put("meta", { at: Date.now(), v });
    return v;
  }
  async status() {
    const [meta, groups] = await Promise.all([this.meta(), this.clip("GET", "/grouped_light")]);
    const gl = Object.fromEntries(groups.map(g => [g.id, g]));
    const bereiche = meta.bereiche.map(b => {
      const g = gl[b.gl];
      return {
        id: b.gl, gruppe: b.id, typ: b.typ, name: b.name,
        an: !!g?.on?.on, hell: g?.dimming ? Math.round(g.dimming.brightness) : null,
        szenen: meta.szenen.filter(s => s.gruppe === b.id).map(s => ({ id: s.id, name: s.name }))
          .sort((x, y) => x.name.localeCompare(y.name, "de")),
      };
    }).sort((a, b) => (a.typ === b.typ ? a.name.localeCompare(b.name, "de") : a.typ === "raum" ? -1 : 1));
    return { stand: new Date().toISOString(), bereiche };
  }
  async set({ id, an, hell }) {
    if (typeof id !== "string" || !ID.test(id)) throw err("Bereich fehlt", 400);
    const body = {};
    if (typeof an === "boolean") body.on = { on: an };
    if (hell != null) {
      const h = Number(hell);
      if (!Number.isFinite(h)) throw err("Helligkeit 1–100", 400);
      body.dimming = { brightness: Math.max(1, Math.min(100, h)) }; body.on = { on: true };
    }
    if (!Object.keys(body).length) throw err("nichts zu tun", 400);
    await this.clip("PUT", `/grouped_light/${id}`, body);
    return this.status();
  }
  async szene(id) {
    if (typeof id !== "string" || !ID.test(id)) throw err("Szene fehlt", 400);
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
