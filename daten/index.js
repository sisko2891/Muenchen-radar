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

// Körper einer Anfrage lesen, aber nie mehr als max Byte (sonst null): schützt den Speicher vor riesigen Körpern
async function kurzLesen(req, max) {
  if (!req.body) return "";
  const leser = req.body.getReader(), teile = [];
  let n = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await leser.cancel(); } catch {} return null; }
    teile.push(value);
  }
  const alles = new Uint8Array(n);
  let o = 0;
  for (const t of teile) { alles.set(t, o); o += t.byteLength; }
  return new TextDecoder().decode(alles);
}

function cors(req) {
  const o = req.headers.get("Origin") || "", pause = new URL(req.url).pathname.startsWith("/pause/");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    // die Seite liest nur; geschrieben wird vom Datenabgleich (kein Browser) – einzige Ausnahme: Pause des Dienstabrufs
    "Access-Control-Allow-Methods": pause ? "GET, PUT, OPTIONS" : "GET, OPTIONS",
    "Access-Control-Allow-Headers": pause ? "X-Castle-Key, X-Castle-Geraet, Content-Type" : "X-Castle-Key, X-Castle-Geraet",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
const json = (req, status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors(req) } });

// ---------- S4-Zähler: öffentliche Fahrplandaten, nichts Privates ----------
// Alle 5 Minuten werden die Abfahrten der S4 ab Aubing Richtung Innenstadt gelesen (siehe scheduled). Je Fahrt zählt der
// letzte Stand vor der Abfahrt: fuhr sie mindestens bis Marienplatz, fiel sie aus, wie viel Verspätung, mit welchem Grund.
const S4_URL = "https://www.mvg.de/api/bgw-pt/v3/departures?globalId=de:09162:1710&limit=40&transportTypes=SBAHN";
// dieselben Regeln wie auf der Seite (js/app.js: WEST, KURZ, endetVorher)
const S4_WEST = /Buchenau|Geltendorf|F[üu]rstenfeldbruck|Puchheim|Eichenau|Grafrath|T[üu]rkenfeld|Sch[öo]ngeising|Freiham|Neuaubing|Gilching|Germering/i;
const S4_KURZ = /Leienfels|Pasing|\bLaim\b|Hirschgarten|Donnersbergerbr|Hackerbr|Hauptbahnhof|\bHbf\b|Karlsplatz|Stachus|Heimeranplatz/i;
const S4_TAGE = 730, S4_AB = 5;                     // so viele Tage bleiben gezählt; „verspätet“ (mit/ohne Grund) ab so vielen Minuten
const S4_FAHRTEN_TAGE = 90;                         // so lange bleibt jede gezählte Fahrt einzeln gemerkt
// Neustart der Zählung (einmalig beim nächsten Lauf, wenn der gespeicherte Zähler eine andere Marke trägt): Tage und
// einzelne Fahrten werden gelöscht; offene und eben gezählte Fahrten bleiben (nichts doppelt, nichts verloren)
const S4_NEUSTART = "2026-11-26";
const s4Tag = ms => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
let s4Merk = null;                                  // Antwort für die Seite kurz merken (eine Minute je Rechner-Instanz)

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const pfad = new URL(req.url).pathname;
    if (pfad === "/s4" && req.method === "GET") {   // Statistik für die Seite: ohne Schlüssel, es sind öffentliche Fahrplandaten
      if (!s4Merk || Date.now() - s4Merk.t > 60e3) {
        const r = await env.DATEN.get(env.DATEN.idFromName("daten")).fetch(new Request("https://intern/s4/lesen"));
        if (!r.ok) return json(req, 502, { error: "Zähler gerade nicht erreichbar" });
        s4Merk = { t: Date.now(), v: await r.json() };
      }
      return json(req, 200, s4Merk.v);
    }
    if (pfad.startsWith("/s4")) return json(req, 404, { error: "unbekannt" });   // die inneren Wege (/s4/…) sind von außen nicht erreichbar
    // Pause setzen: angekündigt zu großer Körper wird schon hier abgewiesen (der Speicher-Dienst liest ohnehin höchstens 500 Byte)
    if (pfad.startsWith("/pause/") && req.method === "PUT") {
      const roh = req.headers.get("Content-Length");
      if (roh !== null && roh !== "" && !(Number(roh) >= 0 && Number(roh) <= 500)) return json(req, 413, { error: "zu groß" });
    }
    // Anfragen ganz ohne Schlüssel sofort abweisen – sie wecken den Speicher-Dienst gar nicht erst
    if (!req.headers.get("X-Castle-Key") && !req.headers.get("X-Upload-Key")) return json(req, 401, { error: "Zugang fehlt" });
    return env.DATEN.get(env.DATEN.idFromName("daten")).fetch(req);
  },
  // Zeitgeber (Zeitplan in wrangler.toml): startet den Datenabgleich bei GitHub. Der Ablauf entscheidet selbst, ob Arbeit
  // ansteht (Daten älter als ca. 2,5 h); „anlass: zeitplan“ unterscheidet den Anstoß von einem Start von Hand.
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") {             // S4-Zähler
      const r = await fetch(S4_URL, { headers: { "User-Agent": "Mozilla/5.0 (katzingers-castle S4-Zaehler)", Accept: "application/json" } });
      if (!r.ok) throw new Error(`S4-Abruf gescheitert (${r.status})`);
      const liste = await r.json();
      if (!Array.isArray(liste)) throw new Error("S4-Abruf: unerwartete Antwort");
      const z = await env.DATEN.get(env.DATEN.idFromName("daten")).fetch(new Request("https://intern/s4/zaehlen", { method: "POST", body: JSON.stringify(liste) }));
      if (!z.ok) throw new Error(`S4-Zähler gescheitert (${z.status})`);
      return;
    }
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


export class DatenState {
  constructor(ctx, env) { this.s = ctx.storage; this.env = env; this.bremse = new Bremse(ctx.storage); }

  async fetch(req) {
    const url = new URL(req.url), teile = url.pathname.split("/").filter(Boolean);   // /blob/<name> | /zugang/<name> | /stand/<name>
    // S4-Zähler: nur von innen erreichbar (der äußere Dienst reicht /s4/… von außen nie durch)
    if (url.pathname === "/s4/zaehlen" && req.method === "POST") return json(req, 200, await this.s4Zaehlen(await req.json().catch(() => null), Date.now()));
    if (url.pathname === "/s4/lesen") return json(req, 200, await this.s4Lesen(Date.now()));
    const [art, name] = teile;
    const ip = anschluss(req.headers.get("CF-Connecting-IP") || "?");
    if (teile.length === 2 && art === "pause" && name === "privat") {
      try { return await this.pause(req, ip); } catch { return json(req, 500, { error: "Fehler" }); }
    }
    if (teile.length !== 2 || !["blob", "zugang", "stand"].includes(art) || !NAMEN.includes(name)) return json(req, 404, { error: "unbekannt" });
    try {
      if (req.method === "GET" && art === "blob") return await this.lesen(req, name, ip);
      if ((req.method === "PUT" && art !== "stand") || (req.method === "GET" && art === "stand")) return await this.abgleich(req, art, name, ip);
      return json(req, 405, { error: "nicht erlaubt" });
    } catch (e) {
      return json(req, 500, { error: "Fehler" });
    }
  }

  // ---------- S4-Zähler ----------
  // liste: Antwort der MVG. Offene Fahrten werden mit dem neuesten Stand gemerkt und gezählt, sobald sie abgefahren sind.
  // Ohne Echtzeit wird gewartet, solange die MVG die Fahrt noch anzeigt (kommt die Echtzeit spät, zählt die Fahrt doch noch
  // mit ihrer Verspätung). Ein Stand ohne Echtzeit ersetzt nie einen früheren mit Echtzeit (Aussetzer der Echtzeitdaten).
  // Ausgefallen ist eine Fahrt, wenn die MVG sie streicht oder wenn sie erst abfährt, wenn laut Fahrplan schon die nächste
  // S4 Richtung Innenstadt fahren sollte („zu spät“). Jede gezählte Fahrt wird zusätzlich einzeln gemerkt (S4_FAHRTEN_TAGE),
  // damit sich die Regeln später auch für vergangene Fahrten nachrechnen lassen.
  async s4Zaehlen(liste, now) {
    if (!Array.isArray(liste)) return { ok: false };
    let s = (await this.s.get("s4")) || { seit: s4Tag(now), offen: {}, tage: {}, fertig: {}, neu: S4_NEUSTART };
    s.fertig = s.fertig || {};
    const weg = [];   // Speicherwerte, die am Ende gelöscht werden
    if (s.neu !== S4_NEUSTART) {
      for (const tag of Array.isArray(s.fTage) ? s.fTage : []) weg.push("s4f:" + tag);
      s = { seit: s4Tag(now), offen: s.offen || {}, tage: {}, fertig: s.fertig, fertigAus: s.fertigAus || {}, fTage: [], neu: S4_NEUSTART };
    }
    const gelistet = new Set();
    for (const d of liste) {
      if (!d || d.label !== "S4" || S4_WEST.test(d.destination || "") || !Number.isFinite(d.plannedDepartureTime)) continue;
      if (Math.abs(d.plannedDepartureTime - now) > 3 * 864e5) continue;   // unsinnige Zeit: nicht zählen
      if (s.fertig[d.plannedDepartureTime]) continue;   // schon gezählt (steht nach der Abfahrt noch kurz in der Liste)
      const p = d.plannedDepartureTime, alt = s.offen[p], rt = d.realtime !== false;
      gelistet.add(String(p));
      const v = Number.isFinite(d.delayInMinutes) ? Math.max(0, Math.round(d.delayInMinutes)) : 0;
      const gruende = [...new Set((Array.isArray(d.infos) ? d.infos : []).map(i => String(i?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean))].slice(0, 4);
      const f = {
        t: Number.isFinite(d.realtimeDepartureTime) ? d.realtimeDepartureTime : p + v * 60e3, v, aus: !!d.cancelled, rt,
        kurz: !!d.sev || (!/Berg am Laim/i.test(d.destination || "") && S4_KURZ.test(d.destination || "")), g: gruende,
        s: now, r1: alt?.r1 ?? (rt ? now : null), ziel: String(d.destination || "").slice(0, 40),
      };
      // Echtzeit gerade weg: den letzten Echtzeitstand behalten (auch gestrichen, Ziel, Ersatzverkehr und Gründe)
      if (!rt && alt?.rt) { f.t = alt.t; f.v = alt.v; f.rt = true; f.aus = f.aus || !!alt.aus; f.kurz = f.kurz || !!alt.kurz; if (!f.g.length && Array.isArray(alt.g)) f.g = alt.g; if (typeof alt.ziel === "string") f.ziel = alt.ziel; }
      s.offen[p] = f;
    }
    // Abfahrten laut Fahrplan aller bekannten, nicht gestrichenen Fahrten (noch offen oder in den letzten 6 h gezählt) – für
    // „zu spät“. Gestrichene zählen nicht als „die nächste“: Fährt die verspätete im Takt der gestrichenen (Zugtausch), ist
    // das ein Ausfall (die gestrichene), nicht zwei.
    s.fertigAus = s.fertigAus || {};
    const plan = [...new Set([...Object.keys(s.offen).filter(p => !s.offen[p].aus), ...Object.keys(s.fertig).filter(p => !s.fertigAus[p])])]
      .map(Number).filter(Number.isFinite).sort((x, y) => x - y);
    const naechste = p => plan.find(x => x > p) ?? null;
    const fahrten = {};   // je Tag die eben gezählten Fahrten
    // abgefahren (zwei Minuten Nachlauf): zählen und vergessen
    for (const [p, f] of Object.entries(s.offen)) {
      if (f.t > now - 120e3) continue;
      // ohne Echtzeit, aber noch angezeigt: warten (höchstens 90 min nach Fahrplan) – vielleicht kommt die Echtzeit noch
      if (f.rt === false && gelistet.has(p) && now - +p < 90 * 60e3) continue;
      delete s.offen[p]; s.fertig[p] = now; if (f.aus) s.fertigAus[p] = now;
      const n = naechste(+p), spaet = !f.aus && f.rt !== false && n !== null && f.t >= n;
      // v: Aufteilung der Fahrten (pünktlich / ab 5 min mit Grund / ohne Grund / ausgefallen / ohne Echtzeit) mit eigener
      // Fahrtenzahl (Tage ohne v stammen aus einer älteren Fassung). ausSp: davon ausgefallen, weil „zu spät“
      const tag = s4Tag(+p), z = s.tage[tag] || (s.tage[tag] = { n: 0, kurz: 0, g: {} });
      const v = z.v || (z.v = { n: 0, aus: 0, ausSp: 0, og: 0, ogMin: 0, mg: 0, mgMin: 0, oe: 0 });
      (fahrten[tag] || (fahrten[tag] = [])).push({ p: +p, t: f.t, v: f.v, rt: f.rt === false ? 0 : 1, a: f.aus ? 1 : 0, k: f.kurz ? 1 : 0,
        n, s: Number.isFinite(f.s) ? f.s : null, r1: Number.isFinite(f.r1) ? f.r1 : null, z: typeof f.ziel === "string" ? f.ziel : "", g: Array.isArray(f.g) ? f.g : [] });
      z.n++; v.n++;
      const gruendeZaehlen = () => { for (const g of f.g) { if (g in z.g || Object.keys(z.g).length < 40) z.g[g] = (z.g[g] || 0) + 1; } };
      if (f.aus) { v.aus++; continue; }
      if (spaet) { v.aus++; v.ausSp = (v.ausSp || 0) + 1; if (f.g.length) gruendeZaehlen(); continue; }
      if (f.kurz) z.kurz++;
      // ohne Echtzeit (z. B. Ausfall der Echtzeitdaten): Verspätung unbekannt – zählt weder als pünktlich noch als verspätet
      if (f.rt === false) { v.oe++; continue; }
      if (f.v >= 1 && f.g.length) {
        gruendeZaehlen();
        if (f.v >= S4_AB) { v.mg++; v.mgMin += f.v; }
      } else if (f.v >= S4_AB) { v.og++; v.ogMin += f.v; }
    }
    for (const [p, t] of Object.entries(s.fertig)) if (t < now - 6 * 3600e3) delete s.fertig[p];
    for (const p of Object.keys(s.fertigAus)) if (!s.fertig[p]) delete s.fertigAus[p];
    const tage = Object.keys(s.tage).sort();
    for (const t of tage.slice(0, Math.max(0, tage.length - S4_TAGE))) delete s.tage[t];
    // Größe begrenzen (ein Speicherwert, höchstens 2 MB): Tage älter als 60 Tage behalten nur ihre fünf häufigsten Gründe
    const grenze = s4Tag(now - 60 * 864e5);
    for (const [tag, z] of Object.entries(s.tage)) {
      delete z.aus; delete z.og; delete z.ogMin;   // Felder früherer Fassung (die Seite liest nur v)
      const g = Object.entries(z.g || {});
      if (tag < grenze && g.length > 5) z.g = Object.fromEntries(g.sort((a, b) => b[1] - a[1]).slice(0, 5));
    }
    // einzelne Fahrten: je Tag ein Speicherwert, höchstens 300 Fahrten, nach S4_FAHRTEN_TAGE gelöscht
    const schreiben = {}, fGrenze = s4Tag(now - S4_FAHRTEN_TAGE * 864e5);
    s.fTage = Array.isArray(s.fTage) ? s.fTage : [];
    for (const [tag, l] of Object.entries(fahrten)) {
      const k = "s4f:" + tag, alt = weg.includes(k) ? [] : await this.s.get(k);   // nach dem Neustart: alte Fahrten nicht übernehmen
      schreiben[k] = [...(Array.isArray(alt) ? alt : []), ...l].slice(-300);
      if (!s.fTage.includes(tag)) s.fTage.push(tag);
    }
    for (const tag of s.fTage) if (tag < fGrenze) { weg.push("s4f:" + tag); delete schreiben["s4f:" + tag]; }
    for (let i = weg.length - 1; i >= 0; i--) if (weg[i] in schreiben) weg.splice(i, 1);   // neu geschrieben: nicht löschen
    s.fTage = s.fTage.filter(t => t >= fGrenze).sort();
    s.ok = now;
    schreiben.s4 = s;
    await this.s.put(schreiben);                      // Zähler und einzelne Fahrten in einem Schritt: nie halb gespeichert
    if (weg.length) await this.s.delete(weg);
    return { ok: true };
  }
  // Summen für 7 Tage, 30 Tage und alles; je Zeitraum die zehn häufigsten Gründe.
  // v: Aufteilung der Fahrten – nur die Fahrten, die schon mit „mit Grund“ gezählt wurden; vAb: erster Tag damit im Zeitraum
  // h: Hochrechnung der Fahrten ohne Echtzeit – jede bekommt die Verteilung der Fahrten mit Echtzeit ihrer Woche (Mo–So,
  // die laufende Woche mit dem Stand bisher). h.n: so viele Fahrten sind geschätzt; Wochen ganz ohne Echtzeit bleiben offen.
  async s4Lesen(now) {
    const s = (await this.s.get("s4")) || { seit: null, tage: {} };
    const VK = ["n", "aus", "ausSp", "og", "ogMin", "mg", "mgMin", "oe"], HK = ["aus", "ausSp", "og", "ogMin", "mg", "mgMin"];
    const zahl = x => { x = +x; return Number.isFinite(x) && x > 0 ? x : 0; };
    const vVon = t => (t.v && typeof t.v === "object" ? t.v : null);
    const woche = tag => { const d = new Date(tag + "T12:00:00Z"); return Number.isFinite(d.getTime()) ? new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10) : "?"; };
    const wochen = {};
    for (const [tag, t] of Object.entries(s.tage)) {
      const tv = vVon(t); if (!tv) continue;
      const w = wochen[woche(tag)] || (wochen[woche(tag)] = Object.fromEntries(VK.map(k => [k, 0])));
      for (const k of VK) w[k] += zahl(tv[k]);
    }
    const summe = ab => {
      const z = { n: 0, kurz: 0 }, v = Object.fromEntries(VK.map(k => [k, 0])), h = { n: 0, ...Object.fromEntries(HK.map(k => [k, 0])) }, g = {};
      let vAb = null;
      for (const [tag, t] of Object.entries(s.tage)) {
        if (ab && tag < ab) continue;
        for (const k of Object.keys(z)) z[k] += t[k] || 0;
        const tv = vVon(t);
        if (tv) {
          for (const k of VK) v[k] += zahl(tv[k]);
          if (!vAb || tag < vAb) vAb = tag;
          const oe = zahl(tv.oe), w = wochen[woche(tag)], mit = w.n - w.oe;
          if (oe && mit > 0) { h.n += oe; for (const k of HK) h[k] += oe * w[k] / mit; }
        }
        for (const [text, n] of Object.entries(t.g || {})) g[text] = (g[text] || 0) + n;
      }
      for (const k of HK) h[k] = Math.round(h[k] * 1000) / 1000;
      return { ...z, v, vAb, h, top: Object.entries(g).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de")).slice(0, 10) };
    };
    // erster Tag des Zeitraums nach dem Kalender (nicht „jetzt minus 24 h“ – sonst um die Zeitumstellung ein Tag zu viel/wenig)
    const vorTagen = k => new Date(Date.parse(s4Tag(now) + "T12:00:00Z") - k * 864e5).toISOString().slice(0, 10);
    // „gezählt seit“: nach zwei Jahren wandert der Anfang mit (alte Tage sind gelöscht)
    const erster = Object.keys(s.tage).sort()[0], seit = s.seit && erster && erster > s.seit ? erster : s.seit;
    return { seit, stand: s.ok || null, z: { "7": summe(vorTagen(6)), "30": summe(vorTagen(29)), alle: summe(null) } };
  }

  // Name für Freistellungen: Ablage + Kurzmarke ihres einzigen Zugangs. Ablagen mit mehreren Zugängen (Bild: PIN und
  // Kalender-Passwort) bekommen keine – sonst ließe sich über das Kalender-Passwort die PIN weiter raten. Wechselt der
  // Zugang (neue PIN), passt die Marke nicht mehr und alte Freistellungen gelten nicht mehr.
  freiName(name, b) {
    const z = Object.values(b?.zugang || {});
    return z.length === 1 && typeof z[0] === "string" ? name + ":" + z[0].slice(0, 8) : "-";
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
      const b = await this.s.get("b:" + name), frei = this.freiName(name, b);
      const r = await this.bremse.laden(), ger = geraet(req), bis = this.bremse.gesperrt(r, ip, ger, frei);
      if (bis) return json(req, 429, { error: "gesperrt", bis });
      if (!b) return json(req, 404, { error: "leer" });
      if (await this.passt(b, key)) { if (frei !== "-") await this.bremse.treffer(r, ip, ger, frei); return json(req, 200, { inhalt: b.inhalt, t: b.t }); }
      return json(req, 401, { error: "Zugang falsch", rest: await this.bremse.fehlversuch(r, ip) });
    });
  }

  // ---------- Pause des Dienstabrufs (krank, Urlaub) ----------
  // Lesen und Setzen von der Seite mit dem Zugangsschlüssel der Dienste (aus der Dienst-PIN), Lesen auch vom Datenabgleich.
  // Gespeichert wird nur { seit, bis } (bis = null: bis zum Fortsetzen) – kein Grund, keine Dienstdaten.
  async pauseStand(now = Date.now()) {
    const p = await this.s.get("pause:privat");
    if (p && p.bis && p.bis <= now) { await this.s.delete("pause:privat"); return null; }   // abgelaufen: Abruf läuft wieder
    return p || null;
  }
  async pause(req, ip) {
    if (req.method === "GET" && await this.darfSchreiben(req)) return json(req, 200, { pause: await this.pauseStand() });
    if (req.method !== "GET" && req.method !== "PUT") return json(req, 405, { error: "nicht erlaubt" });
    const key = (req.headers.get("X-Castle-Key") || "").toLowerCase();
    if (!istHex64(key)) return json(req, 401, { error: "Zugang fehlt" });        // kein Rateversuch, wird nicht gezählt
    // höchstens 500 Byte lesen – unabhängig davon, ob die Längenangabe beim Weiterreichen erhalten bleibt
    const text = req.method === "PUT" ? await kurzLesen(req, 500) : "";
    if (text === null) return json(req, 413, { error: "zu groß" });
    return this.bremse.nacheinander(async () => {
      const b = await this.s.get("b:privat"), frei = this.freiName("privat", b);
      const r = await this.bremse.laden(), ger = geraet(req), bis = this.bremse.gesperrt(r, ip, ger, frei);
      if (bis) return json(req, 429, { error: "gesperrt", bis });
      if (!b) return json(req, 404, { error: "leer" });
      if (!(await this.passt(b, key))) return json(req, 401, { error: "Zugang falsch", rest: await this.bremse.fehlversuch(r, ip) });
      if (frei !== "-") await this.bremse.treffer(r, ip, ger, frei);
      if (req.method === "GET") return json(req, 200, { pause: await this.pauseStand() });
      if (text.length > 500) return json(req, 413, { error: "zu groß" });
      let body; try { body = JSON.parse(text); } catch { return json(req, 400, { error: "kein JSON" }); }
      // genau zwei Formen: {aus:true} beendet, {bis:null|Zeitpunkt} setzt – alles andere wird abgelehnt (keine Pause aus Versehen)
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(req, 400, { error: "unbekannt" });
      const now = Date.now();
      if (body.aus === true && Object.keys(body).length === 1) { await this.s.delete("pause:privat"); return json(req, 200, { pause: null }); }
      if (!Object.hasOwn(body, "bis") || Object.keys(body).length !== 1) return json(req, 400, { error: "unbekannt" });
      const ende = body.bis;
      // 401 statt 400 Tage: Puffer für die Zeitumstellung (die Seite bietet höchstens Tag 400 um 0 Uhr an)
      if (ende !== null && !(Number.isFinite(ende) && ende > now && ende <= now + 401 * 864e5)) return json(req, 400, { error: "Ende ungültig" });
      const p = { seit: now, bis: ende };
      await this.s.put("pause:privat", p);
      return json(req, 200, { pause: p });
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
