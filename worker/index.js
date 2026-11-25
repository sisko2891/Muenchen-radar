// Katzingers Castle – Heizungsdienst (Cloudflare Worker + Durable Object)
// Verwahrt den tado-Zugang, prüft das Heizungs-Passwort serverseitig und bremst Fehlversuche.
// Die Seite spricht nur mit diesem Dienst, nie direkt mit tado.

const ORIGINS = ["https://sisko2891.github.io"];
const CLIENT = "1bb50063-6b0c-4d11-bd99-387f4a91cc46";
const LOGIN = "https://login.tado.com/oauth2";
const API = "https://my.tado.com/api/v2";

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Castle-Pass, X-Castle-Geraet",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
const json = (req, status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    // Anfragen ganz ohne Passwort (Suchroboter, Neugierige) sofort abweisen – sie wecken den Speicher-Dienst gar nicht erst
    if (!req.headers.get("X-Castle-Pass")) return json(req, 401, { error: "Passwort fehlt" });
    const stub = env.TADO.get(env.TADO.idFromName("castle"));
    return stub.fetch(req);
  },
};


// ---------- Fehlversuche begrenzen (in allen Diensten gleich) ----------
const MAX_FAILS_IP = 5, FAIL_WINDOW = 15 * 60e3;               // 5 Fehlversuche je Anschluss in 15 min
const MAX_FAILS_ALL = 30, ALL_WINDOW = 3600e3, LOCK = 3600e3;  // 30 Fehlversuche insgesamt je Stunde -> 1 h Sperre für Unbekannte
const MAX_FAILS_TAG = 100, TAG_WINDOW = 24 * 3600e3;            // und höchstens 100 am Tag -> Sperre für Unbekannte bis zum Ende dieser 24 h
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

// Kurzmarke eines gültigen Zugangs: Freistellungen hängen daran und verfallen deshalb mit einem Passwortwechsel
async function zugangMarke(soll) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(soll))));
  return [...h.slice(0, 4)].map(x => x.toString(16).padStart(2, "0")).join("");
}

class Bremse {
  constructor(storage) { this.s = storage; this.kette = Promise.resolve(); }
  // Prüfungen laufen streng nacheinander: gleichzeitige Anfragen können die Zählung nicht unterlaufen
  nacheinander(fn) { const p = this.kette.then(fn, fn); this.kette = p.catch(() => {}); return p; }
  async laden() {
    const now = Date.now();
    let r = await this.s.get("rl");
    if (!r) r = { ip: {}, ok: {}, alle: { n: 0, t: now }, sperre: 0 };
    if (!r.tag || now - r.tag.t >= TAG_WINDOW) r.tag = { n: 0, t: now };
    r.ger = r.ger || {};
    // Freistellungen gelten je Ablage („name|adresse“ bzw. „name|gerät“); Einträge der früheren Fassung ohne Ablage fallen weg
    for (const o of [r.ok, r.ger]) for (const k of Object.keys(o)) if (!k.includes("|")) delete o[k];
    for (const k of Object.keys(r.ger)) if (now - r.ger[k] > OK_TTL) delete r.ger[k];
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
  gesperrt(r, ip, ger = "", name = "") {
    if ((r.ip[ip]?.n || 0) >= MAX_FAILS_IP) return r.ip[ip].t + FAIL_WINDOW;
    // allgemeine Sperre nach vielen Fehlversuchen von überall – wer zuletzt richtig lag, bleibt frei: das eigene Zuhause
    // (Adresse) und jedes Gerät, das sich schon angemeldet hat (zufällige Gerätekennung, gilt auch nach einem Adresswechsel).
    // Nur für DIESE Ablage: Wer das Kalender-Passwort kennt, darf deshalb nicht unbegrenzt die Dienst-PIN raten.
    if (r.sperre > Date.now() && !r.ok[name + "|" + ip] && !(ger && r.ger?.[name + "|" + ger])) return r.sperre;
    return 0;
  }
  async fehlversuch(r, ip) {
    const now = Date.now();
    r.ip[ip] = { n: (r.ip[ip]?.n || 0) + 1, t: r.ip[ip]?.t || now };
    r.alle.n++; r.tag.n++;
    if (r.alle.n >= MAX_FAILS_ALL) r.sperre = Math.max(r.sperre, now + LOCK);
    if (r.tag.n >= MAX_FAILS_TAG) r.sperre = Math.max(r.sperre, r.tag.t + TAG_WINDOW);   // auch über viele Adressen verteilt nicht mehr als 100 Versuche am Tag
    this.kuerzen(r.ip, v => v.t);
    await this.s.put("rl", r);
    return Math.max(0, MAX_FAILS_IP - r.ip[ip].n);
  }
  async treffer(r, ip, ger = "", name = "") {
    // Fehlversuche dieses Anschlusses verfallen nur mit der Zeit: Ein Treffer (etwa das iPad, das alle 2 min abfragt)
    // darf die Fehlversuche anderer Geräte hinter derselben Adresse nicht löschen
    const kIp = name + "|" + ip, kGer = name + "|" + ger;
    const now = Date.now(), alt = t => !t || now - t > 6 * 3600e3, neuIp = alt(r.ok[kIp]), neuGer = !!ger && alt(r.ger?.[kGer]);
    if (!neuIp && !neuGer) return;                   // nichts zu speichern (spart Schreibvorgänge)
    if (neuIp) { r.ok[kIp] = now; this.kuerzen(r.ok, v => v); }
    if (neuGer) { r.ger = r.ger || {}; r.ger[kGer] = now; this.kuerzen(r.ger, v => v); }
    await this.s.put("rl", r);
  }
  // Passwort einer Anfrage prüfen: null = in Ordnung, sonst { status, body } für die Antwort
  async pruefen(req, soll) {
    const given = req.headers.get("X-Castle-Pass") || "";
    if (!given) return { status: 401, body: { error: "Passwort fehlt" } };      // kein Rateversuch, wird nicht gezählt
    const ip = anschluss(req.headers.get("CF-Connecting-IP") || "?");
    const name = soll ? "pw:" + await zugangMarke(soll) : "-";   // Freistellung gilt nur für das aktuelle Passwort
    return this.nacheinander(async () => {
      const r = await this.laden(), ger = geraet(req), bis = this.gesperrt(r, ip, ger, name);
      if (bis) return { status: 429, body: { error: "gesperrt", bis } };
      if (soll && await gleich(given, soll)) { await this.treffer(r, ip, ger, name); return null; }
      return { status: 401, body: { error: "Passwort falsch", rest: await this.fehlversuch(r, ip) } };
    });
  }
}
// Gerätekennung der Seite: 128 Bit Zufall, nur eine Wiedererkennung (kein Zugang – das Passwort wird trotzdem geprüft)
function geraet(req) { const g = req.headers.get("X-Castle-Geraet") || ""; return /^[0-9a-f]{32}$/.test(g) ? g : ""; }
// ---------- Ende: Fehlversuche begrenzen ----------


export class TadoState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.s = ctx.storage; this.bremse = new Bremse(ctx.storage); }

  async fetch(req) {
    const url = new URL(req.url);
    const p = await this.bremse.pruefen(req, this.env.HEIZUNG_PASS);
    if (p) return json(req, p.status, p.body);
    if (!this.altGeprueft) { this.altGeprueft = true; if (await this.s.get("overlayOk")) await this.s.delete("overlayOk"); }   // Schlüssel früherer Fassung
    try {
      const body = req.method === "POST" ? (await req.json().catch(() => null)) || {} : {};
      switch (url.pathname) {
        case "/status": return json(req, 200, await this.status());
        case "/set": return json(req, 200, await this.setTemp(body.zone, body.temp));
        case "/off": return json(req, 200, await this.overlay(body.zone, { type: "HEATING", power: "OFF" }, "MANUAL"));
        case "/auto": return json(req, 200, await this.auto(body.zone));
        case "/login/start": return json(req, 200, await this.loginStart());
        case "/login/poll": return json(req, 200, await this.loginPoll());
        default: return json(req, 404, { error: "unbekannt" });
      }
    } catch (e) {
      // Unerwartetes (tado nicht erreichbar oder Antwort unlesbar): keine rohe Laufzeit-Meldung nach außen
      if (!(Number.isInteger(e.code) && e.code >= 400 && e.code <= 599)) return json(req, 502, { error: "tado gerade nicht erreichbar" });
      const extra = e.code === 409 ? { grund: (await this.s.get("lostReason")) || null } : {};
      return json(req, e.code, { error: e.message || "Fehler", ...extra });
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
    await this.s.delete("lostReason");
    this.cache = null; await this.s.delete(["z", "letzter", "zones", "overlayOk", "overlayOk:MANUAL", "overlayOk:BLOCK"]);   // neues Konto/Zuhause: nichts Altes behalten
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

  // tado begrenzt die Zahl der Abfragen pro Tag. Cloudflare räumt den Arbeitsspeicher dieses Dienstes schon nach wenigen
  // Sekunden Ruhe ab – alles, was länger als einen Abruf halten soll (Anwesenheit, letzter Stand, Merker je Raum),
  // liegt deshalb im dauerhaften Speicher, gebündelt in einem Datensatz ("z"). Nach eigenen Eingriffen wird frisch gelesen.
  // Mehrere Abrufe zur selben Zeit (zwei Geräte, Sichtwechsel + Takt) teilen sich EINE Runde bei tado.
  async status(frisch = false) {
    // nach einem eigenen Eingriff: frisch lesen, und spätere Abrufe nicht auf eine ältere, noch laufende Runde warten lassen
    if (frisch) { this.laeuft = null; return this.statusHolen(true); }
    if (!this.laeuft) { const p = this.statusHolen(false).finally(() => { if (this.laeuft === p) this.laeuft = null; }); this.laeuft = p; }
    return this.laeuft;
  }
  async statusHolen(frisch) {
    const now = Date.now();
    if (!frisch && this.cache && now - this.cache.at < 50e3) return this.cache.v;      // mehrere Abrufe kurz nacheinander
    const z = (await this.s.get("z")) || {};
    // Abfragegrenze erreicht: bis zu 30 Minuten den letzten Stand zeigen statt tado weiter zu bedrängen
    const letzter = async () => { const l = await this.s.get("letzter"); return l ? { ...l.v, gedrosselt: true } : null; };
    if (!frisch && z.limitBis > now) { const l = await letzter(); if (l) return l; throw Object.assign(new Error("tado-Abfragegrenze erreicht"), { code: 429 }); }
    const h = await this.home();
    const pres = !frisch && z.pres && now - z.pres.at < 10 * 60e3 ? z.pres.v : null;   // Anwesenheit wechselt selten: 10 min merken
    let zones, zs, st;
    try {
      [zones, zs, st] = await Promise.all([this.zones(h), this.api("GET", `/homes/${h}/zoneStates`), pres || this.api("GET", `/homes/${h}/state`)]);
    } catch (e) {
      if (e.code === 429) { await this.s.put("z", { ...z, limitBis: now + 30 * 60e3 }); const l = await letzter(); if (l) return l; }
      throw e;
    }
    let schreiben = false;
    if (!pres) { z.pres = { at: now, v: { presence: st.presence ?? null, presenceLocked: !!st.presenceLocked } }; schreiben = true; }
    if (z.limitBis) { delete z.limitBis; schreiben = true; }
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
    if (this.merken(z, raeume, states, now)) schreiben = true;
    if (now - (z.mt || 0) > 10 * 60e3) schreiben = true;      // Zeitpunkt des letzten Abrufs höchstens alle 10 min sichern
    const v = { stand: new Date().toISOString(), zuhause: st.presence ? st.presence === "HOME" : null, raeume };
    if (!this.cache || this.cache.at <= now) this.cache = { at: now, v };   // eine früher begonnene, langsamere Runde überschreibt keinen neueren Stand
    if (schreiben) {   // gebündelt: Merker, Anwesenheit und der letzte Stand (Rückfall für die Abfragegrenze)
      z.mt = now;
      const neu = await this.s.get("z");     // hat eine andere Anfrage inzwischen eine neuere Anwesenheit gesichert? Dann diese behalten
      if (neu?.pres && (!z.pres || neu.pres.at > z.pres.at)) z.pres = neu.pres;
      await this.s.put("z", z);
      await this.s.put("letzter", { v });
    }
    return v;
  }
  // Merker je Raum: Seit wann steht ein Fenster offen, seit wann ist die Luft zu feucht? Die Seite zeigt daraus Hinweise.
  // - Fenster: tado erkennt das Öffnen am Temperatursturz und beendet seine Meldung nach einer festen Zeit von selbst –
  //   auch wenn das Fenster offen bleibt. Die Öffnung gilt deshalb weiter, solange der Raum nicht wieder wärmer wird
  //   (höchstens 3 Stunden). Meldet tado während dieser Zeit oder binnen 30 Minuten nach seiner letzten Meldung erneut,
  //   zählt das zur selben Öffnung (der Beginn bleibt stehen).
  // - Feuchte: Beginn ab 65 %, Ende erst unter 62 % (sonst flackert die Anzeige an der Grenze).
  // Ergänzt die Räume um fensterOffen, fensterSeit, feuchtSeit; liefert true, wenn sich die Merker geändert haben.
  merken(z, raeume, states, now) {
    const FEUCHT_AB = 65, FEUCHT_ENDE = 62, ERNEUT = 30 * 60e3, NACHLAUF = 3 * 3600e3, LUECKE = 30 * 60e3;
    const merk = z.merk || {}, vorher = JSON.stringify(merk);
    const luecke = now - (z.mt || 0) > LUECKE;      // lange kein Abruf: was dazwischen war, ist nicht belegt
    const ids = new Set(raeume.map(r => String(r.id)));
    for (const k of Object.keys(merk)) if (!ids.has(k)) delete merk[k];
    for (const r of raeume) {
      const m = merk[r.id] || {};
      if (m.fz && (luecke || now - m.fl > ERNEUT)) { delete m.f; delete m.fl; delete m.fm; delete m.fz; }   // beendete Öffnung: nach 30 min vergessen
      if (r.fenster) {
        if (!m.f || (luecke && now - (m.fl || 0) > ERNEUT)) {     // neue Öffnung: Beginn laut tado, sonst der Zeitpunkt dieses Abrufs
          const t0 = Date.parse(states[String(r.id)]?.openWindow?.detectedTime || "");
          m.f = t0 > 0 && t0 <= now ? t0 : now; m.fm = r.ist; m.fl = now;
        }
        delete m.fz;                                   // erneute Meldung binnen 30 min: dieselbe Öffnung
        if (now - m.fl > 5 * 60e3) m.fl = now;         // „zuletzt gemeldet“ in 5-Minuten-Schritten (spart Schreibvorgänge)
        if (r.ist != null && (m.fm == null || r.ist < m.fm)) m.fm = r.ist;
      } else if (m.f && !m.fz) {
        const kuehltAus = !luecke && r.ist != null && m.fm != null && r.ist <= m.fm + 0.2 && now - m.fl < NACHLAUF;
        if (kuehltAus) { if (r.ist < m.fm) m.fm = r.ist; }
        else if (luecke || now - m.fl > ERNEUT) { delete m.f; delete m.fl; delete m.fm; }
        else m.fz = 1;                                 // beendet – Beginn noch bis 30 min nach der letzten Meldung merken
      }
      if (r.feuchte == null || r.feuchte < FEUCHT_ENDE) delete m.h;
      else if (luecke) { if (r.feuchte >= FEUCHT_AB) m.h = now; else delete m.h; }
      else if (r.feuchte >= FEUCHT_AB && !m.h) m.h = now;
      r.fensterOffen = !!m.f && !m.fz; r.fensterSeit = r.fensterOffen ? m.f : null; r.feuchtSeit = m.h || null;
      if (Object.keys(m).length) merk[r.id] = m; else delete merk[r.id];
    }
    z.merk = merk;
    return JSON.stringify(merk) !== vorher;
  }
  zone(zone) {   // Raumnummer aus der Anfrage: nur ganze Zahlen ab 0
    const z = typeof zone === "number" || (typeof zone === "string" && /^\d{1,9}$/.test(zone)) ? Number(zone) : NaN;
    if (!Number.isSafeInteger(z) || z < 0) throw Object.assign(new Error("Raum fehlt"), { code: 400 });
    return z;
  }
  async overlay(zone, setting, termination) {
    const z = this.zone(zone);
    const h = await this.home();
    // tado akzeptiert je nach Gerät/Konto unterschiedliche Schreibweisen für das Ende einer manuellen Einstellung.
    const variants = termination === "MANUAL"
      ? [{ typeSkillBasedApp: "MANUAL" }, { type: "MANUAL" }]
      : [{ typeSkillBasedApp: "NEXT_TIME_BLOCK" }, { type: "TADO_MODE" }, { typeSkillBasedApp: "MANUAL" }, { type: "MANUAL" }];
    // zuletzt erfolgreiche Variante zuerst probieren – getrennt je gewünschtem Ende: sonst würde nach einmal „Aus“
    // (immer dauerhaft) jede spätere Temperatur dauerhaft statt „bis zum nächsten Zeitblock“ gesetzt
    const merkName = termination === "MANUAL" ? "overlayOk:MANUAL" : "overlayOk:BLOCK";
    const ok = await this.s.get(merkName);
    if (ok) variants.sort((x, y) => (JSON.stringify(y) === JSON.stringify(ok)) - (JSON.stringify(x) === JSON.stringify(ok)));
    let last;
    for (const term of variants) {
      try {
        await this.api("PUT", `/homes/${h}/zones/${z}/overlay`, { setting, termination: term });
        // nur eine Variante merken, die zum gewünschten Ende passt (die dauerhafte Notlösung nie für „bis Zeitblock“)
        if (termination === "MANUAL" || !/MANUAL/.test(JSON.stringify(term))) await this.s.put(merkName, term);
        return this.status(true);
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
    const z = this.zone(zone);
    const h = await this.home();
    await this.api("DELETE", `/homes/${h}/zones/${z}/overlay`);
    return this.status(true);
  }
}
