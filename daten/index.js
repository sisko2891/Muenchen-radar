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
// befristete, angekündigte S4-Baustellen (Meldungen „Fahrplanänderung“ der MVG, höchstens 30 Tage lang) entschuldigen fehlende
// Fahrten; Dauerbaustellen stehen ohnehin im Soll-Fahrplan. Gestrichene Fahrten zählen nur mit Bau-Grund als Baustelle.
const S4_MELD_URL = "https://www.mvg.de/api/bgw-pt/v3/messages?messageTypes=SCHEDULE_CHANGE", S4_BAU_MAX = 30 * 864e5;
const S4_BAU_TEXT = /Bauarbeit|Baumaßnahme|Baustelle|Gleisbau/i;
const s4Tag = ms => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
let s4Merk = null;                                  // Antwort für die Seite kurz merken (eine Minute je Rechner-Instanz)

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const pfad = new URL(req.url).pathname;
    if (pfad === "/s4" && req.method === "GET") {   // Statistik für die Seite: ohne Schlüssel, es sind öffentliche Fahrplandaten
      if (!s4Merk || Date.now() - s4Merk.t > 60e3) {
        // Stört der Speicher-Dienst kurz, bleibt die letzte Antwort stehen (die Seite zeigt ohnehin, wie alt der Stand ist)
        try {
          const r = await env.DATEN.get(env.DATEN.idFromName("daten")).fetch(new Request("https://intern/s4/lesen"));
          if (!r.ok) throw new Error(String(r.status));
          s4Merk = { t: Date.now(), v: await r.json() };
        } catch { if (!s4Merk) return json(req, 502, { error: "Zähler gerade nicht erreichbar" }); }
      }
      return json(req, 200, s4Merk.v);
    }
    if (pfad.startsWith("/s4")) return json(req, 404, { error: "unbekannt" });   // die inneren Wege (/s4/…) sind von außen nicht erreichbar
    // Pause setzen: angekündigt zu großer Körper wird schon hier abgewiesen (der Speicher-Dienst liest ohnehin höchstens 500 Byte)
    if (pfad.startsWith("/pause/") && req.method === "PUT") {
      const roh = req.headers.get("Content-Length");
      if (roh !== null && roh !== "" && !(Number(roh) >= 0 && Number(roh) <= 500)) return json(req, 413, { error: "zu groß" });
    }
    // Anfragen ganz ohne (oder mit unsinnigem) Schlüssel und unbekannte Wege sofort abweisen – sie wecken den Speicher-Dienst
    // gar nicht erst (dort wird dasselbe noch einmal geprüft)
    const ck = req.headers.get("X-Castle-Key"), uk = req.headers.get("X-Upload-Key");
    if (!ck && !uk) return json(req, 401, { error: "Zugang fehlt" });
    if (!uk && !istHex64(ck.toLowerCase())) return json(req, 401, { error: "Zugang fehlt" });
    if (!/^\/(blob|zugang|stand|pause)\/[a-z]{1,12}$/.test(pfad)) return json(req, 404, { error: "unbekannt" });
    return env.DATEN.get(env.DATEN.idFromName("daten")).fetch(req);
  },
  // Zeitgeber (Zeitplan in wrangler.toml): startet den Datenabgleich bei GitHub. Der Ablauf entscheidet selbst, ob Arbeit
  // ansteht (Daten älter als ca. 2,5 h); „anlass: zeitplan“ unterscheidet den Anstoß von einem Start von Hand.
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") {             // S4-Zähler
      // mit Zeitgrenze: ein hängender Abruf darf nicht in den nächsten Lauf hineinreichen
      const r = await fetch(S4_URL, { headers: { "User-Agent": "Mozilla/5.0 (katzingers-castle S4-Zaehler)", Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`S4-Abruf gescheitert (${r.status})`);
      const liste = await r.json();
      if (!Array.isArray(liste)) throw new Error("S4-Abruf: unerwartete Antwort");
      const stub = env.DATEN.get(env.DATEN.idFromName("daten"));
      const z = await stub.fetch(new Request("https://intern/s4/zaehlen", { method: "POST", body: JSON.stringify(liste) }));
      if (!z.ok) throw new Error(`S4-Zähler gescheitert (${z.status})`);
      // stündlich: Soll-Fahrplan und Baustellen holen (im Speicher-Dienst – dort ist Rechenzeit für die große Meldungsliste)
      if ((await z.json().catch(() => ({}))).hilfe) await stub.fetch(new Request("https://intern/s4/hilfe", { method: "POST" }));
      return;
    }
    if (!env.ANSTOSS_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.ANSTOSS_REPO || "")) { console.log("Anstoß nicht eingerichtet"); return; }
    const anstossen = ablauf => fetch(`https://api.github.com/repos/${env.ANSTOSS_REPO}/actions/workflows/${ablauf}/dispatches`, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.ANSTOSS_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "katzingers-castle-zeitgeber", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { anlass: "zeitplan" } }),
      signal: AbortSignal.timeout(20000),
    });
    // montags (Weltzeit 9:23) zusätzlich den wöchentlichen Selbsttest – GitHubs eigener Zeitplan dafür ist nur die Reserve.
    // Ein Fehler hier hält den Datenabgleich nicht auf (die Seite meldet einen überfälligen Selbsttest ohnehin).
    const jetzt = new Date(Number.isFinite(event.scheduledTime) ? event.scheduledTime : Date.now());
    if (jetzt.getUTCDay() === 1 && jetzt.getUTCHours() === 9) {
      try { const t = await anstossen("selbsttest.yml"); console.log(t.ok ? "Selbsttest angestoßen" : `Selbsttest-Anstoß gescheitert (${t.status})`); }
      catch { console.log("Selbsttest-Anstoß gescheitert"); }
    }
    const r = await anstossen("update.yml");
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
  // spur: Kurzmarke des falschen Zugangs. Dasselbe falsche Passwort noch einmal (mehrere Geräte mit dem alten Passwort nach
  // einem Wechsel, gleichzeitige Anfragen eines Geräts) ist kein neuer Rateversuch: zählt je Anschluss nur einmal
  async fehlversuch(r, ip, spur = "") {
    const now = Date.now(), alt = r.ip[ip];
    if (spur && alt?.h?.includes(spur)) return Math.max(0, MAX_FAILS_IP - alt.n);   // kein Schreibvorgang
    const h = [...(alt?.h || []), spur].filter(Boolean).slice(-MAX_FAILS_IP);
    r.ip[ip] = { n: (alt?.n || 0) + 1, t: alt?.t || now, ...(h.length ? { h } : {}) };
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
      return { status: 401, body: { error: "Passwort falsch", rest: await this.fehlversuch(r, ip, await zugangMarke(String(soll) + "\n" + given)) } };
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
    if (url.pathname === "/s4/hilfe" && req.method === "POST") return json(req, 200, await this.s4Hilfe(await req.json().catch(() => null), Date.now()));   // ohne Körper: selbst holen
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
    // Lücken des Zählers: über 12 min kein Lauf, oder nur Läufe ohne eine einzige S4 Richtung Innenstadt (Datenausfall der
    // MVG, nachts). Was in solche Zeiten fällt, ist unbekannt und zählt nicht als „fehlte“. Eine noch offene Lücke gilt mit.
    s.luecken = (Array.isArray(s.luecken) ? s.luecken : []).filter(l => Array.isArray(l) && l[1] > now - 14 * 864e5);
    const s4Da = liste.some(d => d && d.label === "S4" && !S4_WEST.test(d.destination || "") && Number.isFinite(d.plannedDepartureTime));
    const letzt = Number.isFinite(s.okS4) ? s.okS4 : s.ok, lang = !Number.isFinite(letzt) || now - letzt > 12 * 60e3;
    const von = Number.isFinite(letzt) ? letzt : now - 6 * 3600e3;   // noch nie gelaufen: was davor lag, ist unbekannt
    if (s4Da) { if (lang) s.luecken = [...s.luecken, [von, now]].slice(-60); s.okS4 = now; }
    const luecken = !s4Da && lang ? [...s.luecken, [von, now]] : s.luecken;
    const hilfe = (await this.s.get("s4hilfe")) || {};
    const bauAktiv = p => (Array.isArray(hilfe.bau) ? hilfe.bau : []).some(b => b && b[0] <= p && p <= b[1]);
    const sollTag = tag => (hilfe.soll && Array.isArray(hilfe.soll.tage?.[tag]) ? hilfe.soll.tage[tag] : null);
    const imSoll = p => { const l = sollTag(s4Tag(p)); return l ? l.some(x => Math.abs(x[0] * 60e3 - p) <= 3 * 60e3) : null; };   // null: Soll unbekannt
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
    // Verschwunden: Die MVG zeigt eine Fahrt nicht mehr, obwohl sie noch bevorsteht und spätere Fahrten angezeigt werden
    // (die Liste reicht also über sie hinaus). Erst nach zwei solchen Läufen gilt sie als verschwunden (Aussetzer abfangen).
    const spaeteste = Math.max(-Infinity, ...[...gelistet].map(Number));
    for (const [p, f] of Object.entries(s.offen)) {
      if (gelistet.has(p) || f.aus) continue;
      if (+p > now + 2 * 60e3 && f.t > now + 2 * 60e3 && spaeteste > +p) f.fehlt = (f.fehlt || 0) + 1;
    }
    // Abfahrten laut Fahrplan aller bekannten, nicht gestrichenen Fahrten (noch offen oder in den letzten 6 h gezählt) – für
    // „zu spät“. Gestrichene zählen nicht als „die nächste“: Fährt die verspätete im Takt der gestrichenen (Zugtausch), ist
    // das ein Ausfall (die gestrichene), nicht zwei.
    s.fertigAus = s.fertigAus || {};
    const plan = [...new Set([...Object.keys(s.offen).filter(p => !s.offen[p].aus && !(s.offen[p].fehlt >= 2)), ...Object.keys(s.fertig).filter(p => !s.fertigAus[p])])]
      .map(Number).filter(Number.isFinite).sort((x, y) => x - y);
    const naechste = p => plan.find(x => x > p) ?? null;
    const fahrten = {};   // je Tag die eben gezählten Fahrten
    const tagVon = p => { const tag = s4Tag(p), z = s.tage[tag] || (s.tage[tag] = { n: 0, kurz: 0, g: {} });
      // v: Aufteilung der Fahrten mit eigener Fahrtenzahl (Tage ohne v stammen aus einer älteren Fassung). Ausgefallen (aus):
      // davon zu spät (ausSp), verschwunden (ausVw), fehlte im Fahrplan der MVG (ausFe), der Rest gestrichen. bau: wegen
      // angekündigter Bauarbeiten entfallen (zählt nirgends mit), zus: von der MVG gezeigt, aber nicht im Soll-Fahrplan
      const v = z.v || (z.v = { n: 0, aus: 0, ausSp: 0, ausVw: 0, ausFe: 0, bau: 0, zus: 0, og: 0, ogMin: 0, mg: 0, mgMin: 0, oe: 0 });
      return { tag, z, v }; };
    const merken = (tag, r) => (fahrten[tag] || (fahrten[tag] = [])).push(r);
    const gruendeZaehlen = (z, gr) => { for (const g of gr) { if (g in z.g || Object.keys(z.g).length < 40) z.g[g] = (z.g[g] || 0) + 1; } };
    // abgefahren (zwei Minuten Nachlauf): zählen und vergessen
    for (const [p, f] of Object.entries(s.offen)) {
      const vw = (f.fehlt || 0) >= 2 && !f.aus;   // verschwunden: gilt ab ihrer Abfahrtszeit laut Plan
      if (!vw && f.t > now - 120e3) continue;
      if (vw && +p > now - 120e3) continue;
      // ohne Echtzeit, aber noch angezeigt: warten (höchstens 90 min nach Fahrplan) – vielleicht kommt die Echtzeit noch
      if (f.rt === false && gelistet.has(p) && now - +p < 90 * 60e3) continue;
      delete s.offen[p]; s.fertig[p] = now; if (f.aus || vw) s.fertigAus[p] = now;
      const n = naechste(+p), spaet = !f.aus && !vw && f.rt !== false && n !== null && f.t >= n;
      const gr = Array.isArray(f.g) ? f.g : [];
      // angekündigte Bauarbeiten: gestrichen mit Bau-Grund, oder verschwunden während einer befristeten S4-Baustelle
      const bau = (f.aus && gr.some(x => S4_BAU_TEXT.test(x))) || (vw && bauAktiv(+p));
      const art = bau ? "b" : f.aus ? "g" : vw ? "v" : spaet ? "s" : "";
      const { tag, z, v } = tagVon(+p);
      merken(tag, { p: +p, t: f.t, v: f.v, rt: f.rt === false ? 0 : 1, a: f.aus ? 1 : 0, k: f.kurz ? 1 : 0, ...(art ? { art } : {}),
        n, s: Number.isFinite(f.s) ? f.s : null, r1: Number.isFinite(f.r1) ? f.r1 : null, z: typeof f.ziel === "string" ? f.ziel : "", g: gr });
      if (bau) { v.bau = (v.bau || 0) + 1; continue; }   // zählt nicht als Fahrt (offizielle Baustelle)
      z.n++; v.n++;
      if (imSoll(+p) === false) v.zus = (v.zus || 0) + 1;
      if (art) {   // ausgefallen; die Gründe zählen bei den Ursachen mit
        v.aus++;
        if (art === "s") v.ausSp = (v.ausSp || 0) + 1;
        if (art === "v") v.ausVw = (v.ausVw || 0) + 1;
        gruendeZaehlen(z, gr);
        continue;
      }
      if (f.kurz) z.kurz++;
      // ohne Echtzeit (z. B. Ausfall der Echtzeitdaten): Verspätung unbekannt – zählt weder als pünktlich noch als verspätet
      if (f.rt === false) { v.oe++; continue; }
      if (f.v >= 1 && gr.length) {
        gruendeZaehlen(z, gr);
        if (f.v >= S4_AB) { v.mg++; v.mgMin += f.v; }
      } else if (f.v >= S4_AB) { v.og++; v.ogMin += f.v; }
    }
    // Abgleich mit dem Soll-Fahrplan: Fahrten, die laut Plan fahren sollten, die die MVG aber nie angezeigt hat („fehlte“).
    // Geprüft wird 100 min nach der geplanten Abfahrt (bis dahin ist jede angezeigte Fahrt gezählt); in Zählerlücken und
    // während befristeter, angekündigter S4-Baustellen zählt sie als Baustelle. Nachbarprobe je Block: Nie angezeigte
    // Soll-Fahrten zwischen zwei angezeigten zählen nur, wenn es höchstens drei am Stück sind – passt der Soll-Fahrplan
    // nicht zum gefahrenen (Fahrplanwechsel, kurzfristig geänderter Takt, lange nichts angezeigt), entsteht kein falscher Ausfall.
    const sollGrenze = now - 100 * 60e3;
    if (hilfe.soll && hilfe.soll.tage) {
      const ab = Number.isFinite(s.sollBis) ? s.sollBis : sollGrenze;
      const bekannt = [...Object.keys(s.offen), ...Object.keys(s.fertig)].map(Number), gesehen = q => bekannt.some(b => Math.abs(b - q) <= 3 * 60e3);
      const sollZeiten = [...new Set([-1, 0, 1].flatMap(k => sollTag(s4Tag(sollGrenze + k * 864e5)) || []).map(x => x[0] * 60e3).filter(Number.isFinite))].sort((a, b) => a - b);
      // Größe des Blocks nie angezeigter Soll-Fahrten um p (bis zur nächsten angezeigten davor und danach; ohne beide: unendlich)
      const block = p => { const i = sollZeiten.indexOf(p); let n = 1, a = i - 1, e = i + 1;
        while (a >= 0 && !gesehen(sollZeiten[a])) { a--; if (++n > 3) return n; }
        while (e < sollZeiten.length && !gesehen(sollZeiten[e])) { e++; if (++n > 3) return n; }
        return i < 0 || a < 0 || e >= sollZeiten.length ? Infinity : n; };
      for (const tag of [...new Set([s4Tag(ab), s4Tag(sollGrenze)])]) {
        for (const x of sollTag(tag) || []) {
          const p = x[0] * 60e3;
          if (!(p > ab && p <= sollGrenze) || gesehen(p)) continue;
          if (luecken.some(l => l[0] < p + 5 * 60e3 && l[1] > p - 45 * 60e3)) continue;   // Zähler sah nichts: unbekannt
          const b = bauAktiv(p);
          if (!b && block(p) > 3) continue;   // Nachbarprobe
          const ziel = String(hilfe.soll.ziele?.[x[1]] ?? "").slice(0, 40), t = tagVon(p);
          merken(t.tag, { p, t: p, v: 0, rt: 0, a: 0, k: 0, art: b ? "b" : "f", n: null, s: null, r1: null, z: ziel, g: [] });
          if (b) { t.v.bau = (t.v.bau || 0) + 1; continue; }
          t.z.n++; t.v.n++; t.v.aus++; t.v.ausFe = (t.v.ausFe || 0) + 1;
        }
      }
    }
    s.sollBis = Math.max(Number.isFinite(s.sollBis) ? s.sollBis : 0, sollGrenze);
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
    // Zähler, einzelne Fahrten und Löschen in einem Schritt (ohne await dazwischen fasst der Speicher-Dienst sie zusammen)
    const w1 = this.s.put(schreiben), w2 = weg.length ? this.s.delete(weg) : null;
    await w1; await w2;
    // hilfe: Soll-Fahrplan und Baustellen sind älter als eine Stunde – der Zeitgeber soll sie neu holen
    return { ok: true, hilfe: !(Number.isFinite(hilfe.t) && now - hilfe.t < 55 * 60e3) };
  }
  // Soll-Fahrplan (von der eigenen Seite, data/s4-soll.json; abgelegt nur heute −1 bis +2 Tage) und befristete S4-Baustellen
  // (Meldungen „Fahrplanänderung“ der MVG) holen. Scheitert ein Teil, bleibt dessen letzter Stand; der Zählerlauf ist davon
  // unberührt. body nur für Tests (dann wird nichts geholt).
  async s4Hilfe(body, now) {
    if (!body || typeof body !== "object") {
      body = {};
      const holen = async u => { const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (katzingers-castle S4-Zaehler)", Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(String(r.status)); return r.json(); };
      const seite = this.env?.SEITE_URL || "";
      if (/^https:\/\/[\w.-]+\/[\w./-]*$/.test(seite)) {
        try { body.soll = await holen(seite + "data/s4-soll.json"); } catch (e) { console.log("Soll-Fahrplan nicht geholt (" + e.message + ")"); }
      }
      try {
        const l = await holen(S4_MELD_URL), bau = [];
        if (!Array.isArray(l)) throw new Error("unerwartete Antwort");
        for (const m of l) {
          if (!m || m.type !== "SCHEDULE_CHANGE" || !(Array.isArray(m.lines) && m.lines.some(x => x?.label === "S4"))) continue;
          const fenster = Array.isArray(m.incidentDurations) && m.incidentDurations.length ? m.incidentDurations : [{ from: m.validFrom, to: m.validTo }];
          for (const f of fenster) if (Number.isFinite(f?.from) && Number.isFinite(f?.to) && f.to > f.from && f.to - f.from <= S4_BAU_MAX) bau.push([f.from, f.to, String(m.title || "")]);
        }
        body.bau = bau;
      } catch (e) { console.log("Baustellen nicht geholt (" + e.message + ")"); }
    }
    const alt = (await this.s.get("s4hilfe")) || {}, neu = { t: now, soll: alt.soll || null, bau: Array.isArray(alt.bau) ? alt.bau : [] };
    const so = body.soll;
    if (so && typeof so === "object" && so.tage && typeof so.tage === "object") {
      const heute = s4Tag(now), tage = {};
      for (const k of [-1, 0, 1, 2]) {
        const tag = new Date(Date.parse(heute + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10), l = so.tage[tag];
        if (Array.isArray(l)) tage[tag] = l.filter(x => Array.isArray(x) && Number.isFinite(x[0]) && Number.isInteger(x[1])).slice(0, 200).map(x => [x[0], x[1]]);
      }
      neu.soll = { version: String(so.version || "").slice(0, 20), quelle: String(so.quelle || "").slice(0, 120), bis: Object.keys(so.tage).sort().pop() || "",
        ziele: (Array.isArray(so.ziele) ? so.ziele : []).slice(0, 50).map(x => String(x).slice(0, 40)), tage, geholt: now };
    }
    // Baustellen: die gerade gemeldeten, dazu die schon beendeten der letzten 14 Tage (die MVG nimmt eine Meldung nach ihrem
    // Ende aus der Liste – Soll-Fahrten an ihrem Ende werden aber erst 100 min später geprüft)
    if (Array.isArray(body.bau)) {
      const gut = b => Array.isArray(b) && Number.isFinite(b[0]) && Number.isFinite(b[1]) && b[1] > now - 14 * 864e5;
      const l = [...body.bau.filter(gut), ...neu.bau.filter(b => gut(b) && b[1] <= now)].map(b => [b[0], b[1], String(b[2] || "").slice(0, 120)]);
      neu.bau = l.filter((b, i) => l.findIndex(c => c[0] === b[0] && c[1] === b[1]) === i).slice(0, 50);
    }
    await this.s.put("s4hilfe", neu);
    return { ok: true };
  }
  // Summen für 7 Tage, 30 Tage und alles; je Zeitraum die zehn häufigsten Ursachen (Gründe von Verspätungen und Ausfällen).
  // v: Aufteilung der Fahrten – nur die Fahrten, die schon mit „mit Grund“ gezählt wurden; vAb: erster Tag damit im Zeitraum
  // h: Hochrechnung der Fahrten ohne Echtzeit – sie sind gefahren, nur ihre Verspätung ist unbekannt: Jede bekommt die
  // Verteilung der gefahrenen Fahrten mit Echtzeit ihrer Woche (Mo–So, die laufende mit dem Stand bisher) auf pünktlich,
  // verspätet und „zu spät“. h.n: so viele Fahrten sind geschätzt; Wochen ganz ohne Echtzeit bleiben offen.
  // ausfaelle: die ausgefallenen Fahrten im Zeitraum einzeln (höchstens die 40 neuesten, aus den letzten 30 Tagen)
  async s4Lesen(now) {
    const s = (await this.s.get("s4")) || { seit: null, tage: {} };
    const hilfe = (await this.s.get("s4hilfe")) || {};
    const VK = ["n", "aus", "ausSp", "ausVw", "ausFe", "bau", "zus", "og", "ogMin", "mg", "mgMin", "oe"], HK = ["ausSp", "og", "ogMin", "mg", "mgMin"];
    const zahl = x => { x = +x; return Number.isFinite(x) && x > 0 ? x : 0; };
    const vVon = t => (t.v && typeof t.v === "object" ? t.v : null);
    const woche = tag => { const d = new Date(tag + "T12:00:00Z"); return Number.isFinite(d.getTime()) ? new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10) : "?"; };
    const wochen = {};
    for (const [tag, t] of Object.entries(s.tage)) {
      const tv = vVon(t); if (!tv) continue;
      const w = wochen[woche(tag)] || (wochen[woche(tag)] = Object.fromEntries(VK.map(k => [k, 0])));
      for (const k of VK) w[k] += zahl(tv[k]);
    }
    // gefahrene Fahrten mit Echtzeit einer Woche: ohne „ohne Echtzeit“ und ohne die nicht gefahrenen Ausfälle
    const gefahren = w => w.n - w.oe - Math.max(0, w.aus - w.ausSp);
    // einzelne Ausfälle der letzten 30 Tage
    const fTage = (Array.isArray(s.fTage) ? s.fTage : []).filter(t => t >= new Date(Date.parse(s4Tag(now) + "T12:00:00Z") - 29 * 864e5).toISOString().slice(0, 10));
    const fWerte = fTage.length ? await this.s.get(fTage.map(t => "s4f:" + t)) : new Map();
    const ausfaelle = [];
    // Fahrten einer früheren Fassung tragen keine Art: gestrichen (a) bzw. „zu spät“ (Echtzeit, abgefahren ab der nächsten)
    const artVon = r => (typeof r.art === "string" ? r.art : r.a === 1 ? "g" : r.rt === 1 && Number.isFinite(r.n) && Number.isFinite(r.t) && r.t >= r.n ? "s" : "");
    for (const [k, l] of fWerte) for (const r of Array.isArray(l) ? l : []) { const art = r ? artVon(r) : "";
      if (["g", "s", "v", "f"].includes(art) && Number.isFinite(r.p))
        ausfaelle.push({ tag: k.slice(4), p: r.p, t: Number.isFinite(r.t) ? r.t : r.p, v: zahl(r.v), art, z: typeof r.z === "string" ? r.z : "", n: Number.isFinite(r.n) ? r.n : null, g: Array.isArray(r.g) && typeof r.g[0] === "string" ? r.g[0] : "" }); }
    ausfaelle.sort((a, b) => b.p - a.p);
    const summe = ab => {
      const z = { n: 0, kurz: 0 }, v = Object.fromEntries(VK.map(k => [k, 0])), h = { n: 0, aus: 0, ...Object.fromEntries(HK.map(k => [k, 0])) }, g = {};
      let vAb = null;
      for (const [tag, t] of Object.entries(s.tage)) {
        if (ab && tag < ab) continue;
        for (const k of Object.keys(z)) z[k] += t[k] || 0;
        const tv = vVon(t);
        if (tv) {
          for (const k of VK) v[k] += zahl(tv[k]);
          if (!vAb || tag < vAb) vAb = tag;
          const oe = zahl(tv.oe), w = wochen[woche(tag)], basis = gefahren(w);
          if (oe && basis > 0) { h.n += oe; for (const k of HK) h[k] += oe * w[k] / basis; }
        }
        for (const [text, n] of Object.entries(t.g || {})) g[text] = (g[text] || 0) + n;
      }
      h.aus = h.ausSp;   // geschätzte Ausfälle sind nur „zu spät“ (gestrichen, verschwunden und fehlend ist immer bekannt)
      for (const k of Object.keys(h)) if (k !== "n") h[k] = Math.round(h[k] * 1000) / 1000;
      return { ...z, v, vAb, h, top: Object.entries(g).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de")).slice(0, 10),
        ausfaelle: ausfaelle.filter(a => !ab || a.tag >= ab).slice(0, 40) };
    };
    // erster Tag des Zeitraums nach dem Kalender (nicht „jetzt minus 24 h“ – sonst um die Zeitumstellung ein Tag zu viel/wenig)
    const vorTagen = k => new Date(Date.parse(s4Tag(now) + "T12:00:00Z") - k * 864e5).toISOString().slice(0, 10);
    // „gezählt seit“: nach zwei Jahren wandert der Anfang mit (alte Tage sind gelöscht)
    const erster = Object.keys(s.tage).sort()[0], seit = s.seit && erster && erster > s.seit ? erster : s.seit;
    // Verlauf je Woche (die letzten 12 mit Aufteilung, älteste zuerst), hochgerechnet wie die Summen: Fahrten ohne Echtzeit
    // bekommen die Verteilung der gefahrenen Fahrten der Woche (verspätet, „zu spät“); mit = Fahrten, auf die sich sp und aus
    // beziehen (ohne Fahrten mit Echtzeit in der Woche bleiben die ohne Echtzeit draußen)
    const r3 = x => Math.round(x * 1000) / 1000;
    const verlauf = Object.entries(wochen).filter(([ab]) => /^\d{4}-\d{2}-\d{2}$/.test(ab)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-12)
      .map(([ab, w]) => { const b = gefahren(w), sp = w.og + w.mg;
        return w.oe > 0 && b > 0 ? { ab, n: w.n, mit: w.n, sp: r3(sp * (1 + w.oe / b)), aus: r3(w.aus + w.ausSp * w.oe / b) }
          : { ab, n: w.n, mit: Math.max(0, w.n - w.oe), sp, aus: w.aus }; });
    const so = hilfe.soll;
    return { seit, stand: s.ok || null, z: { "7": summe(vorTagen(6)), "30": summe(vorTagen(29)), alle: summe(null) }, wochen: verlauf,
      // heute: der Zähler hat den Soll-Fahrplan für heute (sonst gleicht er gerade nicht ab); geholt: letzter erfolgreicher Abruf
      soll: so ? { version: so.version, quelle: so.quelle, bis: so.bis, geholt: Number.isFinite(so.geholt) ? so.geholt : null, heute: Array.isArray(so.tage?.[s4Tag(now)]) } : null };
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
      return json(req, 401, { error: "Zugang falsch", rest: await this.bremse.fehlversuch(r, ip, await zugangMarke(name + "\n" + key)) });
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
      if (!(await this.passt(b, key))) return json(req, 401, { error: "Zugang falsch", rest: await this.bremse.fehlversuch(r, ip, await zugangMarke("privat\n" + key)) });
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
