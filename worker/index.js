// Katzingers Castle – Heizungsdienst (Cloudflare Worker + Durable Object)
// Verwahrt den tado-Zugang, prüft das Heizungs-Passwort serverseitig und bremst Fehlversuche.
// Die Seite spricht nur mit diesem Dienst, nie direkt mit tado.

const ORIGINS = ["https://sisko2891.github.io"];
const CLIENT = "1bb50063-6b0c-4d11-bd99-387f4a91cc46";
const LOGIN = "https://login.tado.com/oauth2";
const API = "https://my.tado.com/api/v2";
const MAX_FAILS_IP = 5;          // Fehlversuche pro IP …
const FAIL_WINDOW = 15 * 60e3;   // … in 15 Minuten
const MAX_FAILS_ALL = 30;        // Fehlversuche gesamt pro Stunde, dann Sperre für alle

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

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const stub = env.TADO.get(env.TADO.idFromName("castle"));
    return stub.fetch(req);
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

export class TadoState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.s = ctx.storage; }

  async fetch(req) {
    const url = new URL(req.url);
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    // --- Sperren prüfen
    const now = Date.now();
    const lockAll = (await this.s.get("lockAll")) || 0;
    const fails = (await this.s.get("fail:" + ip)) || { n: 0, t: now };
    if (now - fails.t > FAIL_WINDOW) { fails.n = 0; fails.t = now; }
    if (lockAll > now || fails.n >= MAX_FAILS_IP) return json(req, 429, { error: "gesperrt", bis: Math.max(lockAll, fails.t + FAIL_WINDOW) });
    // --- Passwort
    const ok = await safeEqual(req.headers.get("X-Castle-Pass") || "", this.env.HEIZUNG_PASS || "");
    if (!ok) {
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
        case "/status": return json(req, 200, await this.status());
        case "/set": return json(req, 200, await this.setTemp(body.zone, body.temp));
        case "/off": return json(req, 200, await this.overlay(body.zone, { type: "HEATING", power: "OFF" }, "MANUAL"));
        case "/auto": return json(req, 200, await this.auto(body.zone));
        case "/presence": return json(req, 200, await this.presence(body.mode));
        case "/login/start": return json(req, 200, await this.loginStart());
        case "/login/poll": return json(req, 200, await this.loginPoll());
        default: return json(req, 404, { error: "unbekannt" });
      }
    } catch (e) {
      const code = e.code || 500;
      const extra = code === 409 ? { grund: (await this.s.get("lostReason")) || null } : {};
      return json(req, code, { error: e.message || "Fehler", ...extra });
    }
  }

  // ---------- tado-Anmeldung (Geräte-Code, einmalig)
  async loginStart() {
    const r = await fetch(`${LOGIN}/device_authorize?client_id=${CLIENT}&scope=offline_access`, { method: "POST" });
    if (!r.ok) throw Object.assign(new Error("tado-Anmeldung nicht erreichbar"), { code: 502 });
    const d = await r.json();
    await this.s.put("device", { code: d.device_code, until: Date.now() + (d.expires_in || 300) * 1000 });
    return { link: d.verification_uri_complete, gueltig: d.expires_in || 300 };
  }
  async loginPoll() {
    const dev = await this.s.get("device");
    if (!dev || dev.until < Date.now()) return { fertig: false, abgelaufen: true };
    const q = new URLSearchParams({ client_id: CLIENT, device_code: dev.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    const r = await fetch(`${LOGIN}/token?${q}`, { method: "POST" });
    if (!r.ok) return { fertig: false };
    const t = await r.json();
    await this.s.put("refresh", t.refresh_token);
    await this.s.put("access", { t: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 });
    await this.s.delete("device");
    await this.s.delete("home");
    await this.s.put("connectedAt", Date.now());
    await this.s.delete("lostReason");
    return { fertig: true };
  }

  // ---------- Zugriff auf tado
  async token() {
    const a = await this.s.get("access");
    if (a && a.until > Date.now()) return a.t;
    // Immer nur EINE Erneuerung gleichzeitig: tado ersetzt den Refresh-Token bei jeder Nutzung,
    // parallele Erneuerungen mit demselben alten Token würden sich gegenseitig ungültig machen.
    if (!this.refreshing) this.refreshing = this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refreshOnce() {
    const a = await this.s.get("access");
    if (a && a.until > Date.now()) return a.t;
    for (let attempt = 0; attempt < 2; attempt++) {
      const rt = await this.s.get("refresh");
      if (!rt) throw Object.assign(new Error("tado nicht verbunden"), { code: 409 });
      const q = new URLSearchParams({ client_id: CLIENT, grant_type: "refresh_token", refresh_token: rt });
      let r;
      try { r = await fetch(`${LOGIN}/token?${q}`, { method: "POST" }); }
      catch { throw Object.assign(new Error("tado nicht erreichbar"), { code: 502 }); }
      if (r.ok) {
        const t = await r.json();
        await this.s.put("refresh", t.refresh_token);
        await this.s.put("access", { t: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 });
        await this.s.put("lastRefresh", Date.now());
        return t.access_token;
      }
      const body = await r.json().catch(() => ({}));
      // Wurde der Token inzwischen von einer anderen Anfrage erneuert? Dann mit dem neuen erneut versuchen.
      const now = await this.s.get("refresh");
      if (now && now !== rt) continue;
      if (body.error === "invalid_grant") {
        await this.s.put("lostReason", { at: Date.now(), why: body.error_description || body.error });
        await this.s.delete("refresh");
        throw Object.assign(new Error("tado-Zugang abgelaufen, bitte neu verbinden"), { code: 409 });
      }
      // sonstige Fehler (Störung bei tado): Token behalten, später erneut versuchen
      throw Object.assign(new Error(`tado-Anmeldung gestört (${r.status})`), { code: 502 });
    }
    throw Object.assign(new Error("tado-Anmeldung gestört"), { code: 502 });
  }
  async api(method, path, body) {
    const tok = await this.token();
    const r = await fetch(API + path, {
      method, headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) throw Object.assign(new Error("tado-Abfragegrenze erreicht"), { code: 429 });
    if (!r.ok) {
      // Begründung von tado mitliefern (z. B. {"errors":[{"code":"...","title":"..."}]})
      const b = await r.json().catch(() => ({}));
      const why = (b.errors || []).map(e => [e.code, e.title].filter(Boolean).join(": ")).join("; ");
      throw Object.assign(new Error(`tado-Fehler ${r.status}${why ? " – " + why : ""}`), { code: 502, status: r.status });
    }
    const txt = await r.text();
    return txt ? JSON.parse(txt) : {};
  }
  async home() {
    let h = await this.s.get("home");
    if (!h) { const me = await this.api("GET", "/me"); h = me.homes[0].id; await this.s.put("home", h); }
    return h;
  }
  async zones(h) {
    const day = new Date().toISOString().slice(0, 10);
    let z = await this.s.get("zones");
    if (!z || z.day !== day) {
      const list = await this.api("GET", `/homes/${h}/zones`);
      z = { day, list: list.map(x => ({ id: x.id, name: x.name, typ: x.type })) };
      await this.s.put("zones", z);
    }
    return z.list;
  }

  async status() {
    const h = await this.home();
    const [zones, zs, st] = await Promise.all([this.zones(h), this.api("GET", `/homes/${h}/zoneStates`), this.api("GET", `/homes/${h}/state`)]);
    const states = zs.zoneStates || {};
    const raeume = zones.filter(z => z.typ === "HEATING").map(z => {
      const s = states[String(z.id)] || {};
      const set = s.setting || {};
      return {
        id: z.id, name: z.name,
        ist: s.sensorDataPoints?.insideTemperature?.celsius ?? null,
        feuchte: s.sensorDataPoints?.humidity?.percentage ?? null,
        an: set.power === "ON",
        soll: set.power === "ON" ? set.temperature?.celsius ?? null : null,
        leistung: s.activityDataPoints?.heatingPower?.percentage ?? null,
        fenster: !!(s.openWindow || s.openWindowDetected),
        manuell: !!s.overlay,
      };
    });
    return { stand: new Date().toISOString(), zuhause: st.presence ? st.presence === "HOME" : null, fixiert: !!st.presenceLocked, raeume,
      verbunden_seit: (await this.s.get("connectedAt")) || null };
  }
  async overlay(zone, setting, termination) {
    const h = await this.home();
    const z = Number(zone);
    if (!Number.isInteger(z)) throw Object.assign(new Error("Raum fehlt"), { code: 400 });
    // tado akzeptiert je nach Gerät/Konto unterschiedliche Schreibweisen für das Ende einer manuellen Einstellung.
    const variants = termination === "MANUAL"
      ? [{ typeSkillBasedApp: "MANUAL" }, { type: "MANUAL" }]
      : [{ typeSkillBasedApp: "NEXT_TIME_BLOCK" }, { type: "TADO_MODE" }, { typeSkillBasedApp: "MANUAL" }, { type: "MANUAL" }];
    // zuletzt erfolgreiche Variante zuerst probieren
    const ok = await this.s.get("overlayOk");
    if (termination !== "MANUAL" && ok) variants.sort((x, y) => (JSON.stringify(y) === JSON.stringify(ok)) - (JSON.stringify(x) === JSON.stringify(ok)));
    let last;
    for (const term of variants) {
      try {
        await this.api("PUT", `/homes/${h}/zones/${z}/overlay`, { setting, termination: term });
        await this.s.put("overlayOk", term);
        return this.status();
      } catch (e) {
        last = e;
        if (e.status !== 422 && e.status !== 400) throw e;   // nur bei „ungültig“ die nächste Variante probieren
      }
    }
    throw last;
  }
  async setTemp(zone, temp) {
    const t = Math.round(Number(temp) * 2) / 2;
    if (!(t >= 5 && t <= 25)) throw Object.assign(new Error("Temperatur 5–25 °C"), { code: 400 });
    return this.overlay(zone, { type: "HEATING", power: "ON", temperature: { celsius: t } }, "NEXT_TIME_BLOCK");
  }
  async auto(zone) {
    const h = await this.home();
    const z = Number(zone);
    if (!Number.isInteger(z)) throw Object.assign(new Error("Raum fehlt"), { code: 400 });
    await this.api("DELETE", `/homes/${h}/zones/${z}/overlay`);
    return this.status();
  }
  async presence(mode) {
    const h = await this.home();
    if (mode === "AUTO") await this.api("DELETE", `/homes/${h}/presenceLock`);
    else if (mode === "HOME" || mode === "AWAY") await this.api("PUT", `/homes/${h}/presenceLock`, { homePresence: mode });
    else throw Object.assign(new Error("Modus HOME, AWAY oder AUTO"), { code: 400 });
    return this.status();
  }
}
