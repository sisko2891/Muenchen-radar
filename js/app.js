// Die Seite läuft nie eingebettet in einer fremden Seite (dort könnten untergeschobene Tipper Licht oder Heizung schalten)
if(window.top!==window.self){document.documentElement.hidden=true;throw new Error("Einbetten ist nicht erlaubt");}
const MVG = "https://www.mvg.de/api/bgw-pt/v3";
const AUBING = "de:09162:1710";
const KINO = "https://kntkapi.apps.stroeermb.de/api/cinema/";
const WEST = /Buchenau|Geltendorf|F[üu]rstenfeldbruck|Puchheim|Eichenau|Grafrath|T[üu]rkenfeld|Sch[öo]ngeising|Freiham|Neuaubing|Gilching|Germering/i;
const STAMM = /Stammstrecke|Pasing und Ostbahnhof|Ostbahnhof und Pasing|Hauptbahnhof|Karlsplatz|Marienplatz|Isartor|Rosenheimer Platz|Hackerbr[üu]cke|Donnersbergerbr[üu]cke|Hirschgarten|Laim/i;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// Adressen aus fremden Quellen: nur http(s) wird zum Link, alles andere (z. B. javascript:) nicht
const safeUrl = u => /^https?:\/\//i.test(String(u ?? "")) ? String(u) : "#";
const fmtT = ms => new Date(ms).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"});
const fmtD = ms => new Date(ms).toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit",timeZone:"Europe/Berlin"});
let abgemeldet=false;   // nach „Dieses Gerät abmelden“ schreibt bis zum Neuladen nichts mehr auf das Gerät (auch kein noch laufender Abruf)
const store = {
  get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d}},
  set(k,v){if(abgemeldet)return;try{localStorage.setItem(k,JSON.stringify(v))}catch{}}
};
// Abruf mit Zeitlimit, damit hängende Verbindungen (WLAN-Aussetzer) nicht ewig offen bleiben
const fetchT=(url,opt={},ms=20000)=>fetch(url,{...opt,...(typeof AbortSignal!=="undefined"&&AbortSignal.timeout?{signal:AbortSignal.timeout(ms)}:{})});
async function getJSON(url){const r=await fetchT(url,{cache:"no-store"});if(!r.ok)throw new Error(r.status);return r.json();}
// verständlicher Fehlertext statt Browser-Meldungen wie „Failed to fetch“
const errTxt=e=>e?.name==="TimeoutError"?"Zeitüberschreitung":/^(Failed to fetch|Load failed|NetworkError)/.test(e?.message||"")?"keine Verbindung":(e?.message||"Fehler");
function setPill(el,state,text){el.className="pill "+state;el.innerHTML='<i></i><span class="pt">'+esc(text)+"</span>";}

/* ---------- Design-Auswahl ---------- */
function setSkin(v){if(v==="holo")document.documentElement.dataset.skin="holo";else delete document.documentElement.dataset.skin;store.set("skin",v==="holo"?"holo":null);}
// Antippen des Wappens öffnet die Auswahl direkt darunter; Auswahl oder Antippen daneben schließt sie
function skinPop(auf){
  const pop=$("#skinpop");pop.hidden=!auf;abmeldenZurueck();if(!auf)return;
  const cur=document.documentElement.dataset.skin||"standard", r=$("#crest").getBoundingClientRect(), box=$("#skinpop-in");
  box.style.left=Math.max(12,Math.round(r.left))+"px";box.style.top=Math.round(r.bottom+10)+"px";
  box.querySelectorAll("button[data-skin]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.skin===cur));
}
$("#crest").onclick=()=>skinPop($("#skinpop").hidden);
$("#skinpop").addEventListener("click",e=>{const b=e.target.closest("button[data-skin]");if(b)setSkin(b.dataset.skin);if(b||!e.target.closest("#skinpop-in"))skinPop(false);});
// „Dieses Gerät abmelden“: entfernt PIN, Passwörter und die gemerkten privaten Daten von diesem Gerät (Einstellungen wie
// Design, Kino oder Merkliste bleiben). Zweimal tippen, damit ein versehentlicher Tipper am Wand-Display nichts löscht.
const GERAET_GEHEIM=["privatPin","kalenderPass","heizungPass","lichtPass","wegPass","zugang","ablage:privat","ablage:kalender","ablage:kater","falsch:privat","falsch:kalender","dienstGesehen"];
let abmeldenBis=0, abmeldenAb=0;
$("#sp-ab").onclick=()=>{
  const b=$("#sp-ab");
  if(Date.now()>abmeldenBis){abmeldenBis=Date.now()+6000;abmeldenAb=Date.now()+700;b.classList.add("sicher");b.querySelector("b").textContent="Wirklich? Nochmal tippen";
    setTimeout(()=>{if(Date.now()>=abmeldenBis)abmeldenZurueck();},6100);return;}
  if(Date.now()<abmeldenAb)return;   // Doppeltipp oder Prellen: Die Nachfrage muss erst zu lesen sein
  abgemeldet=true;
  GERAET_GEHEIM.forEach(k=>{try{localStorage.removeItem(k);}catch{}});
  location.reload();
};
function abmeldenZurueck(){abmeldenBis=0;const b=$("#sp-ab");b.classList.remove("sicher");b.querySelector("b").textContent="Dieses Gerät abmelden";}

/* ---------- Uhr ---------- */
function tick(){$("#cdate").textContent=new Date().toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit",timeZone:"Europe/Berlin"});$("#clock").textContent=new Date().toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"});}
var ringBereit=false;   // der Tagesbogen braucht Dienste und Termine; er wird erst gezeichnet, wenn das Skript ganz geladen ist
tick();setInterval(()=>{tick();if(ringBereit)ringZeigen();},10000);

/* ---------- Privat: Dienste (verschlüsselt, PIN) ---------- */
const PIN_KEY="privatPin";
let privDa=false, privData=null;
const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));

/* ---------- Geschützter Speicher (Dienste, Termine, Bild des Hausherrn) ----------
   Die verschlüsselten Daten liegen nicht im öffentlichen Projekt, sondern in einem eigenen Dienst (daten/).
   Er gibt sie nur gegen einen Zugangsschlüssel heraus, der hier aus PIN bzw. Passwort berechnet wird, und
   begrenzt Fehlversuche. Entschlüsselt wird weiterhin erst hier im Browser. */
let datenUrl=null, datenUrlAt=0, datenUrlP=null;
const hexOf=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
const LOKAL=/^(localhost|127\.0\.0\.1)$/.test(location.hostname);   // nur für Tests am eigenen Rechner
// Adresse des Dienstes (data/daten.json). Gleichzeitige Anfragen teilen sich einen Abruf; nach einem Fehlschlag
// wird frühestens nach 30 s erneut gesucht.
function datenAdresse(){
  if(datenUrl)return Promise.resolve(datenUrl);
  if(datenUrlP)return datenUrlP;
  if(Date.now()-datenUrlAt<30000)return Promise.resolve(null);
  datenUrlAt=Date.now();
  return datenUrlP=(async()=>{
    try{const u=String((await getJSON("data/daten.json")).url||"").replace(/\/+$/,"");
      datenUrl=/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(u)||(LOKAL&&/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(u))?u:null;}
    catch{datenUrl=null;}
    datenUrlP=null;return datenUrl;})();
}
// Zugangsschlüssel: PBKDF2 wie im Datenabgleich (scripts/daten.py). Die Berechnung dauert spürbar, deshalb wird das
// Ergebnis gemerkt – zusammen mit einem Fingerabdruck des Geheimnisses, damit ein geändertes neu berechnet wird.
async function zugangKey(geheim,name,id){
  const te=new TextEncoder(), fp=hexOf(await crypto.subtle.digest("SHA-256",te.encode(id+"\n"+geheim))).slice(0,16), c=store.get("zugang",{})||{};
  if(c[id]?.f===fp)return c[id].k;
  const base=await crypto.subtle.importKey("raw",te.encode(geheim),"PBKDF2",false,["deriveBits"]);
  const k=hexOf(await crypto.subtle.deriveBits({name:"PBKDF2",salt:te.encode("katzingers-castle/zugang/v1/"+name),iterations:600000,hash:"SHA-256"},base,256));
  const neu=store.get("zugang",{})||{};neu[id]={f:fp,k};store.set("zugang",neu);return k;   // frisch lesen: gleichzeitige Berechnungen überschreiben sich nicht
}
// liefert {inhalt,t}; Fehler tragen .status: 401 Schlüssel falsch, 404 nichts abgelegt, 429 gesperrt, 0 keine Verbindung
async function datenHolen(name,geheim,id=name){
  const url=await datenAdresse();
  if(!url){const e=new Error("Speicher nicht erreichbar");e.status=0;throw e;}
  let r;try{r=await fetchT(`${url}/blob/${name}`,{cache:"no-store",headers:{"X-Castle-Key":await zugangKey(geheim,name,id)}});}catch(e){e.status=0;throw e;}
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.error||("Fehler "+r.status));e.status=r.status;e.data=d;throw e;}
  return d;
}
// Passte ein gespeichertes Geheimnis nicht (z. B. nach PIN-Wechsel), wird es 6 Stunden nicht von selbst erneut probiert –
// sonst würde die Seite ihre eigenen Fehlversuche aufbrauchen. Eine neue Eingabe gilt sofort.
const falschGemerkt=n=>Date.now()-(store.get("falsch:"+n,0)||0)<6*3600e3;
const sperrText=e=>e.status===401?`falsch${e.data?.rest!=null?` (noch ${e.data.rest} Versuche)`:""}`
  :e.status===429?`Zu viele Fehlversuche – gesperrt bis ${e.data?.bis?fmtT(e.data.bis):"später"}`
  :e.status===404?"Noch keine Daten abgelegt":"Keine Verbindung zum Speicher";
// Wiederholung in kurzen Abständen, solange beim Start noch nichts geladen werden konnte (danach reicht der Stundentakt)
const baldNochmal=(()=>{const z={};return (name,fn)=>{z[name]=z[name]||{n:0,t:null};clearTimeout(z[name].t);if(z[name].n++<8)z[name].t=setTimeout(fn,60000);};})();
async function decryptPriv(enc,pin){
  const c=crypto.subtle;
  const base=await c.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveKey"]);
  const key=await c.deriveKey({name:"PBKDF2",salt:b64(enc.salt),iterations:enc.iter,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["decrypt"]);
  return JSON.parse(new TextDecoder().decode(await c.decrypt({name:"AES-GCM",iv:b64(enc.iv)},key,b64(enc.ct))));
}
// Kalendertag in München, um off Tage verschoben. Gerechnet wird mit Kalendertagen (nicht mit 24-Stunden-Blöcken),
// damit rund um die Zeitumstellung kein Tag übersprungen oder doppelt gezählt wird.
const berlinDay=(off=0)=>{const [y,m,d]=new Date().toLocaleDateString("sv-SE",{timeZone:"Europe/Berlin"}).split("-").map(Number);return new Date(Date.UTC(y,m-1,d+off)).toISOString().slice(0,10);};
const nowHM=()=>new Date().toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Europe/Berlin"});
// Dienste eines Tages, aufbereitet für das Dienst-Feld und die Übersicht.
// art: work = Dienst mit Uhrzeit, closed = gesperrt, sonder = „Änd“ (geänderter Dienst, Näheres steht in der Bemerkung),
// free = frei/Urlaub, none = kein Eintrag.
// Bei gesperrten Tagen steht in bem, was die Druckansicht als Bemerkung führt; hat sie sich geändert, nennt
// seit den Zeitpunkt (Sekunden) und alt den vorherigen Text. Bei „Änd“-Tagen tragen die Einträge selbst bemSeit/bemAlt.
const DN_ALT=18*3600e3, DN_GESEHEN="dienstGesehen";
const dnName=e=>/^o$/i.test((e.name||"").trim())?"frei":(e.name||"").trim();   // Kürzel "O" aus Profahr bedeutet dienstfrei
const dnKurz=(t,n)=>t.length>n?t.slice(0,n-1).trimEnd()+"…":t;
const dnAend=e=>!e.von&&!e.gesperrt&&/^änd/i.test((e.name||"").trim());
function dayInfo(d){
  const es=(privData?.eintraege||[]).filter(e=>e.d===d), zeit=es.filter(e=>e.von), zu=es.filter(e=>e.gesperrt);
  const g=zu.find(e=>e.bem||e.bemSeit)||zu[0]||null;
  const aend=es.filter(dnAend);
  return {es,zeit,zu,aend,art:zeit.length?"work":zu.length?"closed":aend.length?"sonder":es.length?"free":"none",bem:(g?.bem||"").trim(),alt:(g?.bemAlt||"").trim(),seit:+g?.bemSeit||0};
}
function dayText(d){
  const i=dayInfo(d);
  if(!i.es.length)return "kein Eintrag";
  const t=i.zeit.map(e=>`${e.von}–${e.bis}${e.ueber?"⁺¹":""}`);
  if(i.zu.length)t.push("gesperrt"+(i.bem?" · "+dnKurz(i.bem,28):""));
  for(const e of i.aend)t.push(dnName(e)+((e.bem||"").trim()?" · "+dnKurz(e.bem.trim(),28):""));
  return t.length?t.join(" · "):([...new Set(i.es.map(dnName).filter(Boolean))].join(" · ")||"frei");
}
// jüngste Änderung an der Bemerkung eines kommenden gesperrten oder „Änd“-Tages (0 = keine)
function dienstNeu(){const h=berlinDay();return Math.max(0,...(privData?.eintraege||[]).filter(e=>(e.gesperrt||dnAend(e))&&e.d>=h).map(e=>+e.bemSeit||0));}
function renderDuty(){
  const pill=$("#pill-duty"), kn=$("#duty-days");
  if(!privDa&&!privData){pill.hidden=kn.hidden=true;$("#pin-form").hidden=true;dienstZu();return;}
  if(!privData){pill.hidden=false;pill.className="pill duty lock";pill.innerHTML="<i></i>Privat · PIN";kn.hidden=true;dienstZu();return;}
  pill.hidden=true;   // freigeschaltet: das Dienst-Feld zeigt heute, angetippt die kommenden Tage
  const today=berlinDay(), yest=berlinDay(-1);
  // laufender Nachtdienst vom Vortag
  const night=(privData.eintraege||[]).find(e=>e.d===yest&&e.ueber&&nowHM()<e.bis);
  let heute="Heute: "+dayText(today);if(night)heute=`Jetzt bis ${night.bis} · `+heute;
  // Dienste werden tagsüber etwa alle 3 Stunden geholt: Ist der Stand älter als 18 Stunden, klappt der Abruf nicht – das steht dann dabei
  const stand=Date.parse(privData.stand||"");
  if(stand&&Date.now()-stand>DN_ALT)heute+=" · ⚠ Stand "+fmtD(stand);
  const i0=dayInfo(today);
  kn.dataset.today=heute;
  kn.classList.remove("work","free","closed","sonder");kn.classList.add(night?"work":i0.art==="none"?"free":i0.art);
  // roter Punkt, solange eine Änderung noch nicht angesehen wurde (Übersicht einmal öffnen)
  kn.classList.toggle("aend",dienstNeu()>(+store.get(DN_GESEHEN,0)||0));
  const t=kn.dataset.label||heute, pt=kn.querySelector(".pt");   // bei Fahrzeit steht stattdessen die Fahrzeit da
  if(pt.textContent!==t)pt.textContent=t;
  kn.hidden=false;
  if(!$("#dienste").hidden)dienstZeigen();
  if(ringBereit)ringZeigen();
}
/* Übersicht der kommenden Dienste: klappt unter dem Dienst-Feld auf, nach Kalenderwochen geordnet */
const dnMontag=d=>{const t=new Date(d+"T12:00:00Z");t.setUTCDate(t.getUTCDate()-(t.getUTCDay()+6)%7);return t.toISOString().slice(0,10);};
const dnPlus=(d,n)=>{const t=new Date(d+"T12:00:00Z");t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
function dnKW(d){const t=new Date(d+"T12:00:00Z");t.setUTCDate(t.getUTCDate()+3-(t.getUTCDay()+6)%7);const j=new Date(Date.UTC(t.getUTCFullYear(),0,4));return 1+Math.round(((t-j)/864e5-3+(j.getUTCDay()+6)%7)/7);}
const dnTM=d=>d.slice(8,10)+"."+d.slice(5,7)+".";
function dnTagHTML(d,today,night){
  const i=dayInfo(d), dt=new Date(d+"T12:00:00Z"), wd=dt.toLocaleDateString("de-DE",{weekday:"short",timeZone:"UTC"}).replace(".","");
  // Feiertag (Bayern), schulfreier Tag und Schulferien – wie im Kalender
  const ft=feiertag(d), sf=schulfrei(d), fe0=ferienAm(d), fe=fe0&&fe0!==sf?fe0:null;
  const z=[];
  if(ft)z.push(`<span class="dn-ft">Feiertag · ${esc(ft)}</span>`);else if(sf)z.push(`<span class="dn-sf">schulfrei · ${esc(sf)}</span>`);
  if(d===today&&night)z.push(`<span class="dn-b dn-jetzt">Nachtdienst von gestern läuft bis ${esc(night.bis)}</span>`);
  for(const e of i.zeit){
    z.push(`<span class="dn-z">${esc(e.von)}–${esc(e.bis)}${e.ueber?'<sup title="endet am Folgetag">+1</sup>':""}${e.name?`<span class="dn-n">${esc(e.name)}</span>`:""}</span>`);
    if(e.bem)z.push(`<span class="dn-b">${esc(e.bem)}</span>`);
  }
  if(i.zu.length){
    z.push(`<span class="dn-g"><em>gesperrt</em>${i.bem?`<b>${esc(i.bem)}</b>`:i.seit?`<b>Bemerkung entfernt</b>`:""}</span>`);
    if(i.seit)z.push(`<span class="dn-ae">geändert ${esc(fmtD(i.seit*1000))} ${esc(fmtT(i.seit*1000))}${i.alt?` · vorher ${esc(i.alt)}`:""}</span>`);
  }
  // „Änd“: geänderter Dienst ohne Uhrzeit – was gilt, steht in der Bemerkung
  for(const e of i.aend){
    z.push(`<span class="dn-g"><em>${esc(dnName(e))}</em>${(e.bem||"").trim()?`<b>${esc(e.bem.trim())}</b>`:+e.bemSeit?`<b>Bemerkung entfernt</b>`:""}</span>`);
    if(+e.bemSeit)z.push(`<span class="dn-ae">geändert ${esc(fmtD(e.bemSeit*1000))} ${esc(fmtT(e.bemSeit*1000))}${(e.bemAlt||"").trim()?` · vorher ${esc(e.bemAlt.trim())}`:""}</span>`);
  }
  if(!i.zeit.length&&!i.zu.length&&!i.aend.length){
    z.push(`<span class="dn-frei">${esc(i.es.length?([...new Set(i.es.map(dnName).filter(Boolean))].join(" · ")||"frei"):"kein Eintrag")}</span>`);
    for(const b of new Set(i.es.map(e=>(e.bem||"").trim()).filter(Boolean)))z.push(`<span class="dn-b">${esc(b)}</span>`);
  }
  return `<div class="dn-tag ${i.art}${d===today?" heute":""}${dt.getUTCDay()%6===0?" we":""}${(i.zu.length&&i.seit)||i.aend.some(e=>+e.bemSeit)?" aend":""}${ft?" ft":""}" data-d="${esc(d)}"><span class="dn-d"><b>${esc(d===today?"Heute":wd)}</b><small>${esc(d===today?wd+" ":"")}${dnTM(d)}</small>${fe?`<small class="dn-fe" title="${esc(fe)}">Ferien</small>`:""}</span><span class="dn-m">${z.join("")}</span></div>`;
}
function dienstZeigen(){
  if(!privData)return;
  const today=berlinDay(), yest=berlinDay(-1), ein=privData.eintraege||[];
  const night=ein.find(e=>e.d===yest&&e.ueber&&nowHM()<e.bis);
  const tage=[...new Set([today,...ein.map(e=>e.d).filter(d=>d>today)])].sort();
  const wochen=new Map();for(const d of tage){const m=dnMontag(d);if(!wochen.has(m))wochen.set(m,[]);wochen.get(m).push(d);}
  const m0=dnMontag(today);
  const html=[...wochen].map(([m,ds])=>{
    const titel=m===m0?"Diese Woche":m===dnPlus(m0,7)?"Nächste Woche":"KW "+dnKW(m);
    return `<section class="dn-w"><h3>${titel}<small>${m===m0||m===dnPlus(m0,7)?"KW "+dnKW(m)+" · ":""}${ds.length<2?dnTM(ds[0]):(ds[0].slice(0,7)===ds[ds.length-1].slice(0,7)?ds[0].slice(8,10)+".":dnTM(ds[0]))+"–"+dnTM(ds[ds.length-1])}</small></h3>${ds.map(d=>dnTagHTML(d,today,night)).join("")}</section>`;}).join("");
  const box=$("#dn-inhalt");if(box._html!==html){box.innerHTML=html;box._html=html;}
  $("#dn-in").style.setProperty("--dn-n",Math.min(3,wochen.size));
  const stand=Date.parse(privData.stand||""), alt=stand&&Date.now()-stand>DN_ALT, st=$("#dn-stand");
  // Bemerkungen gesperrter Tage kommen aus der Druckansicht; ist sie seit über 12 h nicht lesbar, steht ihr Stand dabei
  const bemSt=Date.parse(privData.bemStand||""), bemAlt=!!(stand&&bemSt&&stand-bemSt>12*3600e3&&ein.some(e=>e.gesperrt&&e.d>=today));
  st.textContent=stand?`Stand ${fmtD(stand)} ${fmtT(stand)}${alt?" – Abruf klappt gerade nicht":""}${bemAlt?` · Bemerkungen gesperrter Tage: Stand ${fmtD(bemSt)} ${fmtT(bemSt)}`:""}`:"";st.classList.toggle("alt",!!alt||bemAlt);
  // Fahrzeit zur Arbeit: einrichten bzw. Stand
  const fuss=$("#dn-fuss"), ohnePass=wegUrl&&!store.get(WEG_KEY,""), ws=typeof wegStatus!=="undefined"?wegStatus:"";
  fuss.hidden=!(ohnePass||ws);
  const fh=ohnePass?`<button type="button" class="dn-weg" id="dn-weg">🚗 Fahrzeit einrichten …</button>`:esc(ws);
  if(fuss._html!==fh){fuss.innerHTML=fh;fuss._html=fh;}
}
// Platz der Übersicht: unter dem Dienst-Feld, linksbündig mit ihm, aber nie über den Rand hinaus
function dienstOrt(){
  const k=$("#duty-days").getBoundingClientRect(), b=$("#dn-in"), oben=Math.round(Math.max(8,k.bottom+8));
  b.style.top=oben+"px";b.style.maxHeight=Math.max(200,innerHeight-oben-12)+"px";
  b.style.left=Math.round(Math.max(12,Math.min(k.left,innerWidth-b.offsetWidth-12)))+"px";
}
let dienstTimer=null;
function dienstAuf(){
  if(!privData)return;
  const kn=$("#duty-days");
  $("#dienste").hidden=false;dienstZeigen();dienstOrt();kn.setAttribute("aria-expanded","true");
  // Änderungen gelten damit als gesehen: der rote Punkt am Feld verschwindet, die Zeile in der Übersicht bleibt rot
  store.set(DN_GESEHEN,Math.max(dienstNeu(),+store.get(DN_GESEHEN,0)||0));kn.classList.remove("aend");
  clearTimeout(dienstTimer);dienstTimer=setTimeout(dienstZu,2*60000);   // schließt nach 2 min von selbst
}
function dienstZu(){
  const d=$("#dienste");if(!d||d.hidden)return;
  d.hidden=true;$("#duty-days").setAttribute("aria-expanded","false");clearTimeout(dienstTimer);
}
$("#duty-days").addEventListener("click",()=>{$("#dienste").hidden?dienstAuf():dienstZu();});
$("#dienste").addEventListener("click",e=>{
  if(e.target.closest("#dn-weg")){dienstZu();$("#weg-form").hidden=false;$("#weg-pass").focus();return;}
  if(e.target===e.currentTarget||e.target.closest("#dn-zu"))dienstZu();
});
addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#dienste").hidden){dienstZu();$("#duty-days").focus();}});
// Passt das Dienst-Feld nicht mehr in die Kopfzeile, heißt erst der WLAN-Knopf kurz „WLAN“; reicht das nicht
// (laufender Nachtdienst, Fahrzeit, lange Bemerkung), weicht das Feld in die Zeile darunter aus
function fitDutySel(){
  const kn=$("#duty-days"), brand=document.querySelector(".brand"), wl=$("#pill-wlan");
  if(!kn||!brand)return;
  const da=!kn.hidden, pt=kn.querySelector(".pt");
  wl.classList.remove("kurz");
  if(da&&kn.parentElement!==brand)brand.insertBefore(kn,$("#pet"));   // Normalplatz: in der Kopfzeile neben dem Titel
  const eng=()=>(da&&kn.parentElement===brand&&pt.scrollWidth>pt.clientWidth+1)||brand.scrollWidth>brand.clientWidth+1;
  if(eng())wl.classList.add("kurz");
  if(da&&eng()){$("#status").prepend(kn);wl.classList.remove("kurz");if(eng())wl.classList.add("kurz");}
  if(!$("#dienste").hidden)dienstOrt();
}
new MutationObserver(fitDutySel).observe($("#duty-days"),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["hidden"]});
addEventListener("load",fitDutySel);addEventListener("resize",fitDutySel);
if(window.ResizeObserver){const ro=new ResizeObserver(fitDutySel);ro.observe($("#pet"));ro.observe($("#pill-duty"));}
if(document.fonts?.ready)document.fonts.ready.then(fitDutySel);   // Futter/Klo-Anzeige ändert ihre Breite
$("#pill-duty").onclick=()=>{
  if(privData){renderDuty();return;}
  const f=$("#pin-form");f.hidden=!f.hidden;if(!f.hidden)$("#pin-input").focus();
};
// holt die Dienste mit dieser PIN und entschlüsselt sie; das Chiffrat wird für Netzaussetzer auf dem Gerät gemerkt
async function privHolen(pin){
  const d=await datenHolen("privat",pin);
  const klar=d.t&&d.t===privHolen.t&&privData?privData:await decryptPriv(d.inhalt,pin);   // unverändert: nicht erneut entschlüsseln
  privHolen.t=d.t;store.set("ablage:privat",d.inhalt);store.set("falsch:privat",0);
  return klar;
}
$("#pin-form").onsubmit=async e=>{
  e.preventDefault();const pin=$("#pin-input").value;if(!pin)return;$("#pin-err").textContent="Prüfe…";privHolen.t=0;
  try{privData=await privHolen(pin);store.set(PIN_KEY,pin);if(typeof renderCal==="function")renderCal();$("#pin-form").hidden=true;$("#pin-input").value="";$("#pin-err").textContent="";renderDuty();
    if(typeof katerTry==="function")katerTry();if(typeof loadWeg==="function")loadWeg();}
  catch(e){$("#pin-err").textContent=e.status===401?"PIN "+sperrText(e):e.status!=null?sperrText(e):"PIN falsch";}
};
async function loadPriv(){
  privDa=!!(await datenAdresse());
  const pin=store.get(PIN_KEY,null);
  let offen=!privDa;   // true: es fehlt noch etwas, das ein baldiger neuer Versuch bringen könnte
  if(privDa&&pin&&!falschGemerkt("privat")){
    try{privData=await privHolen(pin);}
    catch(e){
      if(e.status===401){privData=null;store.set("ablage:privat",null);store.set("falsch:privat",Date.now());}   // PIN passt nicht (mehr): neu eingeben
      else if(!privData){   // Netzaussetzer o. Ä.: den zuletzt geholten Stand vom Gerät zeigen
        const alt=store.get("ablage:privat",null);
        if(alt){try{privData=await decryptPriv(alt,pin);}catch{}}
        offen=e.status!==404;
      }
    }
  }
  // Adresse des Speichers gerade nicht abrufbar (Aussetzer beim Laden): den auf dem Gerät gemerkten Stand zeigen
  if(!privDa&&pin&&!privData&&!falschGemerkt("privat")){const alt=store.get("ablage:privat",null);if(alt){try{privData=await decryptPriv(alt,pin);}catch{}}}
  nightRefresh();
  renderDuty();if(typeof renderCal==="function"&&calData)renderCal();
  if(typeof loadWeg==="function")loadWeg();
  if(privData&&typeof katerTry==="function")katerTry();
  if(offen)baldNochmal("privat",loadPriv);
}
loadPriv();

/* ---------- Heizung (tado über eigenen Dienst, Passwort serverseitig geprüft) ---------- */
const HEAT_KEY="heizungPass";
let heatUrl=null, heatData=null, heatPending={}, heatLogin=null;
const f1=v=>v==null?"–":(Math.round(v*10)/10).toLocaleString("de-DE",{minimumFractionDigits:1,maximumFractionDigits:1});
async function heatCall(path,body){
  const r=await fetchT(heatUrl+path,{method:body?"POST":"GET",cache:"no-store",
    headers:{"X-Castle-Pass":store.get(HEAT_KEY,""),...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.error||("Fehler "+r.status));e.status=r.status;e.data=d;throw e;}
  return d;
}
function heatMsg(html){const m=$("#heat-msg");m.hidden=!html;m.innerHTML=html||"";}
// Antwort des Heizungsdienstes prüfen: Übernommen wird nur eine Liste von Räumen – alles andere gilt als Störung
// (der bisherige Stand bleibt stehen), statt die Anzeige mit einem Programmfehler anzuhalten.
function heatGut(d){
  if(!d||!Array.isArray(d.raeume))throw new Error("unerwartete Antwort");
  d.raeume=d.raeume.filter(r=>r&&typeof r==="object"&&r.id!=null);
  if(isNaN(Date.parse(d.stand)))d.stand=new Date().toISOString();
  return d;
}
function heatFail(e){
  if(e.status===401){store.set(HEAT_KEY,"");heatData=null;$("#heat-form").hidden=false;$("#heat-err").textContent=`Passwort falsch${e.data?.rest!=null?` (noch ${e.data.rest} Versuche)`:""}`;renderHeat();return;}
  if(e.status===429&&e.data?.bis){heatMsg(`Zu viele Fehlversuche, gesperrt bis ${new Date(e.data.bis).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})}.`);return;}
  if(e.status===409){heatData=null;renderHeat();
    if(heatLogin)return;   // Anmeldung läuft gerade: Hinweis mit dem Link stehen lassen
    const g=e.data?.grund;const why=g?` (Verbindung getrennt am ${new Date(g.at).toLocaleString("de-DE",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}, tado meldet: ${esc(g.why)})`:"";
    heatMsg(`tado ist nicht verbunden${why}. <button class="btn" type="button" id="heat-connect">tado verbinden</button>`);$("#heat-connect").onclick=heatConnect;return;}
  heatMsg(esc(errTxt(e))+" – neuer Versuch gleich.");
}
const heatLoginStop=()=>{clearInterval(heatLogin);heatLogin=null;};
async function heatConnect(){
  try{const d=await heatCall("/login/start",{});
    heatMsg(`1. <a href="${esc(safeUrl(d.link))}" target="_blank" rel="noopener noreferrer">Diesen Link öffnen</a> und bei tado bestätigen (5 Minuten gültig).<br>2. Danach hierher zurück, die Verbindung wird automatisch erkannt.`);
    heatLoginStop();const until=Date.now()+d.gueltig*1000;
    heatLogin=setInterval(async()=>{
      try{const p=await heatCall("/login/poll",{});
        if(p.fertig){heatLoginStop();heatMsg("");loadHeat();}
        else if(p.abgelaufen||Date.now()>until){heatLoginStop();heatMsg(`Zeit abgelaufen. <button class="btn" type="button" id="heat-connect">Erneut verbinden</button>`);$("#heat-connect").onclick=heatConnect;}
      }catch(e){if(e.status===401||e.status===429||Date.now()>until){heatLoginStop();heatFail(e);}}   // einzelner Aussetzer: weiter warten
    },5000);
  }catch(e){heatFail(e);}
}
/* Hinweise aus den Heizungsdaten. Der Heizungsdienst merkt sich je Raum, seit wann tado ein offenes Fenster meldet
   (bzw. der Raum danach weiter auskühlt) und seit wann die Luftfeuchte über 65 % liegt. */
const FENSTER_MIN=10, FEUCHT_MIN=30, AUSSEN_KALT=10;   // Minuten, Minuten, °C
const dauerTxt=ms=>{const m=Math.max(0,Math.round(ms/60000));return m<60?`${m} min`:`${Math.floor(m/60)} h ${String(m%60).padStart(2,"0")}`;};
// Fenster seit mindestens FENSTER_MIN offen und draußen kälter als AUSSEN_KALT (ohne Wetterdaten zählt nur das Fenster);
// nur mit frischen Heizungsdaten (höchstens 15 min alt)
function fensterWarnung(){
  if(!heatData?.raeume||!(Date.now()-Date.parse(heatData.stand)<15*60000))return null;
  const aussen=typeof wxState!=="undefined"&&wxState?wxState.temp:null;
  if(aussen!=null&&aussen>=AUSSEN_KALT)return null;
  const r=heatData.raeume.filter(x=>x.fensterOffen&&x.fensterSeit&&Date.now()-x.fensterSeit>=FENSTER_MIN*60000).sort((a,b)=>a.fensterSeit-b.fensterSeit);
  // Räume, für die tado nichts mehr meldet (die aber weiter auskühlen), bekommen ein Fragezeichen
  return r.length?{raeume:r,aussen,seit:r[0].fensterSeit,namen:r.map(x=>x.name+(x.fenster?"":"?")).join(", ")}:null;
}
// Hinweis oben in der Kopfzeile; Antippen zeigt das Heizungsfeld
function showFenster(){
  const p=$("#pill-fenster"), w=fensterWarnung();
  p.hidden=!w;
  // das Feste zuerst: Wird der Hinweis aus Platzgründen gekürzt, bleibt lesbar, worum es geht
  if(w)setPill(p,"bad",`Fenster offen: ${w.namen} · seit ${dauerTxt(Date.now()-w.seit)}${w.aussen!=null?` · draußen ${w.aussen}°`:""}`);
  if(typeof nightRefresh==="function")nightRefresh();
}
$("#pill-fenster").onclick=()=>{store.set("rechts","heat");applyRSwitch();loadHeat();};
setInterval(showFenster,60000);
function renderHeat(){
  showFenster();
  if(typeof applyRSwitch==="function")applyRSwitch();
  const box=$("#heat");
  if(!heatUrl){box.hidden=true;return;}
  box.hidden=false;
  const pass=store.get(HEAT_KEY,"");
  if(!pass){$("#heat-form").hidden=false;$("#heat-stamp").textContent="";$("#heat-rooms").innerHTML='<div class="empty">Die Heizung ist mit einem eigenen Passwort geschützt.</div>';return;}
  $("#heat-form").hidden=true;
  if(!heatData){$("#heat-rooms").innerHTML="";return;}
  // Anwesenheit wird in der tado-App umgestellt; hier nur der Hinweis, falls tado auf „abwesend“ steht
  $("#heat-stamp").textContent=(heatData.zuhause===false?"abwesend · ":"")+(heatData.gedrosselt?"tado-Limit · Stand ":"live · ")+fmtT(heatData.stand);
  $("#heat-rooms").innerHTML=heatData.raeume.map(r=>{
    const pend=heatPending[r.id];const soll=pend!=null?pend.t:r.soll;
    const heating=(r.leistung||0)>0;
    // länger als FEUCHT_MIN über 65 % Luftfeuchte: Kachel gelb, Hinweis „lüften“ (nicht, wenn das Fenster ohnehin offen ist)
    const feucht=!!r.feuchtSeit&&Date.now()-r.feuchtSeit>=FEUCHT_MIN*60000&&!r.fensterOffen;
    return `<div class="room ${heating?"heating":""} ${r.an||pend?"":"off"} ${pend?.busy?"busy":""} ${feucht?"feucht":""}" data-z="${esc(r.id)}" title="${esc(r.name)}${heating?` · heizt mit ${Math.round(r.leistung)} %`:""}${feucht?` · seit ${dauerTxt(Date.now()-r.feuchtSeit)} über 65 % Luftfeuchte`:""}">
      <span class="nm">${esc(r.name)}</span><span class="tp">${f1(r.ist)}°</span>
      <div class="ring"><svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="40" class="rg-bg"/><circle cx="48" cy="48" r="40" class="rg-arc" stroke-dasharray="${(Math.min(1,Math.max(0.03,((r.ist??10)-10)/18))*251.3).toFixed(1)} 251.3" transform="rotate(-90 48 48)"/></svg><div><b>${f1(r.ist)}°</b><small>${soll!=null?"→ "+f1(soll)+"°":"aus"}</small></div></div>
      <span class="sub">${r.feuchte!=null?Math.round(r.feuchte)+" % Feuchte":""}</span>
      ${r.fenster?'<span class="badge">Fenster offen</span>':r.fensterOffen?'<span class="badge frage">Fenster offen?</span>':feucht?'<span class="badge lueften">lüften</span>':""}
      <div class="rc"><div class="ctl tmp"><button class="rb" data-a="minus" aria-label="${esc(r.name)} kälter">−</button><span class="sv">${soll!=null?f1(soll)+"°":"aus"}</span><button class="rb" data-a="plus" aria-label="${esc(r.name)} wärmer">+</button></div>
      <div class="ctl">${r.an?'<button class="rb sm" data-a="off">Aus</button>':""}${r.manuell?'<button class="rb sm" data-a="auto">Zeitplan</button>':""}</div></div>
      ${heating?`<span class="bar" style="width:${Math.min(100,Math.max(8,r.leistung))}%"></span>`:""}</div>`;
  }).join("");
  $("#heat-rooms").querySelectorAll(".room").forEach(el=>{
    const id=+el.dataset.z, r=heatData.raeume.find(x=>x.id===id);
    el.querySelectorAll("button").forEach(b=>b.onclick=()=>{
      const a=b.dataset.a;
      clearTimeout(heatPending[id]?.timer);
      if(a==="off"||a==="auto"){const p=heatPending[id]={t:a==="off"?null:r.soll,busy:true};renderHeat();return heatAct("/"+a,{zone:id},id,p);}
      const cur=heatPending[id]?.t??r.soll??(r.ist!=null?Math.round(r.ist*2)/2:20);
      const t=Math.min(25,Math.max(5,cur+(a==="plus"?.5:-.5)));
      const p=heatPending[id]={t};
      p.timer=setTimeout(()=>{if(heatPending[id]!==p)return;p.busy=true;renderHeat();heatAct("/set",{zone:id,temp:t},id,p);},1200);
      renderHeat();
    });
  });
}
async function heatAct(path,body,zone,p){
  try{const d=heatGut(await heatCall(path,body));if(!p||heatPending[zone]===p){heatData=d;heatMsg("");}}catch(e){heatFail(e);}
  if(zone!=null&&(!p||heatPending[zone]===p))delete heatPending[zone];   // nur die eigene Eingabe abräumen, nicht eine neuere
  renderHeat();
}
async function loadHeat(){
  if(!heatUrl){try{heatUrl=(await getJSON("data/heizung.json")).url||null;}catch{heatUrl=null;}}
  if(!heatUrl||!store.get(HEAT_KEY,"")){renderHeat();return;}
  if($("#heat").hidden)renderHeat();   // Feld samt Umschalter sofort zeigen, nicht erst nach der ersten Antwort
  if(Object.keys(heatPending).length)return; // während einer Eingabe nicht überschreiben
  try{const d=heatGut(await heatCall("/status"));if(!Object.keys(heatPending).length){heatData=d;heatMsg("");}}catch(e){heatFail(e);}
  renderHeat();
}
$("#heat-form").onsubmit=async e=>{
  e.preventDefault();store.set(HEAT_KEY,$("#heat-pin").value);$("#heat-pin").value="";$("#heat-err").textContent="Prüfe…";
  await loadHeat();if(store.get(HEAT_KEY,""))$("#heat-err").textContent="";
};
loadHeat();
// regelmäßig aktualisieren; beim Umschalten zwischen Heizung und Licht wird sofort geladen.
// Heizung alle 2 Minuten (Temperaturen ändern sich langsam, tado begrenzt die Abfragen). Nachts und solange das Licht-Feld
// zu sehen ist nur alle 6 Minuten – ganz ohne Abruf gäbe es keine Hinweise auf offene Fenster.
const rechtsZeigt=()=>document.querySelector(".hero-right")?.dataset.show||"heat";
let heatTick=0;
setInterval(()=>{if(document.hidden)return;const night=typeof isNight==="function"&&isNight()&&Date.now()>wakeUntil;if(heatTick++%(night||(heatUrl&&rechtsZeigt()!=="heat")?3:1)===0)loadHeat();},120000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadHeat();});

/* ---------- Umschalter Heizung | Licht ---------- */
function applyRSwitch(){
  const hr=document.querySelector(".hero-right"), sw=$("#rswitch");if(!hr||!sw)return;
  const hasHeat=!!(typeof heatUrl!=="undefined"&&heatUrl), hasLicht=!!(typeof lichtUrl!=="undefined"&&lichtUrl);
  let show=store.get("rechts","heat");
  if(!hasLicht)show="heat";else if(!hasHeat)show="licht";
  hr.dataset.show=show;
  sw.hidden=!(hasHeat&&hasLicht);
  const kopf=$(show==="licht"?"#licht-head":"#heat-head");if(sw.parentElement!==kopf)kopf.prepend(sw);   // in die Titelzeile des sichtbaren Felds
  sw.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.r===show));
}
$("#rswitch").querySelectorAll("button").forEach(b=>b.onclick=()=>{store.set("rechts",b.dataset.r);applyRSwitch();
  if(b.dataset.r==="licht"&&typeof loadLicht==="function")loadLicht();else if(typeof loadHeat==="function")loadHeat();});

/* ---------- Licht (Philips Hue, eigener Dienst und eigenes Passwort) ---------- */
const LICHT_KEY="lichtPass";
const LICHT_AUSBLENDEN=["badezimmer","balkon","flur"];   // Bereiche, die im Licht-Feld nicht angezeigt werden
const LICHT_REIHENFOLGE=["küche","wohnzimmer","arbeitszimmer","schlafzimmer","wohnung"]; // weitere Bereiche danach
let lichtUrl=null, lichtData=null, lichtBusy={}, lichtPoll=null;
const BULB='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
async function lichtCall(path,body){
  const r=await fetchT(lichtUrl+path,{method:body?"POST":"GET",cache:"no-store",
    headers:{"X-Castle-Pass":store.get(LICHT_KEY,""),...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.error||("Fehler "+r.status));e.status=r.status;e.data=d;throw e;}
  return d;
}
function lichtMsg(h){const m=$("#licht-msg");m.hidden=!h;m.innerHTML=h||"";}
// wie bei der Heizung: nur eine Liste von Bereichen übernehmen, fehlende Angaben auffüllen
function lichtGut(d){
  if(!d||!Array.isArray(d.bereiche))throw new Error("unerwartete Antwort");
  d.bereiche=d.bereiche.filter(b=>b&&typeof b==="object"&&typeof b.id==="string")
    .map(b=>({...b,name:String(b.name??"Bereich"),szenen:Array.isArray(b.szenen)?b.szenen.filter(z=>z&&typeof z==="object"):[]}));
  if(isNaN(Date.parse(d.stand)))d.stand=new Date().toISOString();
  return d;
}
function lichtFail(e){
  if(e.status===401){store.set(LICHT_KEY,"");lichtData=null;$("#licht-err").textContent=`Passwort falsch${e.data?.rest!=null?` (noch ${e.data.rest} Versuche)`:""}`;renderLicht();return;}
  if(e.status===429&&e.data?.bis){lichtMsg(`Zu viele Fehlversuche, gesperrt bis ${new Date(e.data.bis).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})}.`);return;}
  if(e.status===409){lichtData=null;renderLicht();
    if(lichtPoll)return;   // Anmeldung läuft gerade: Hinweis mit dem Link stehen lassen
    lichtMsg(`Hue ist nicht verbunden. <button class="btn" type="button" id="licht-connect">Hue verbinden</button>`);$("#licht-connect").onclick=lichtConnect;return;}
  lichtMsg(esc(errTxt(e)));
}
const lichtPollStop=()=>{clearInterval(lichtPoll);lichtPoll=null;};
async function lichtConnect(){
  try{const d=await lichtCall("/login/start",{});
    lichtMsg(`1. <a href="${esc(safeUrl(d.link))}" target="_blank" rel="noopener noreferrer">Bei Philips Hue anmelden und zustimmen</a> (10 Minuten gültig).<br>2. Danach hierher zurück, die Verbindung wird automatisch erkannt.`);
    lichtPollStop();const until=Date.now()+10*60e3;
    lichtPoll=setInterval(async()=>{
      try{lichtData=lichtGut(await lichtCall("/status"));lichtPollStop();lichtMsg("");renderLicht();}
      catch(e){if(e.status===401||e.status===429||Date.now()>until){lichtPollStop();lichtFail(e);}}   // „noch nicht verbunden“ oder ein Aussetzer: weiter warten
    },5000);
  }catch(e){lichtFail(e);}
}
function renderLicht(){
  applyRSwitch();
  const box=$("#licht");
  if(!lichtUrl){box.hidden=true;return;}
  box.hidden=false;
  const pass=store.get(LICHT_KEY,"");
  $("#licht-form").hidden=!!pass;
  $("#licht-aus").hidden=!lichtData;
  if(!pass){$("#licht-list").innerHTML='<div class="empty">Das Licht ist mit einem eigenen Passwort geschützt.</div>';$("#licht-stamp").textContent="";return;}
  if(!lichtData){$("#licht-list").innerHTML="";return;}
  $("#licht-stamp").textContent="live · "+new Date(lichtData.stand).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"});
  if(lichtTouch){lichtDirty=true;return;}   // Finger liegt gerade auf einem Regler: erst danach neu zeichnen
  const rang=b=>{const i=LICHT_REIHENFOLGE.indexOf(b.name.trim().toLowerCase());return i<0?99:i;};
  const sichtbar=lichtData.bereiche.filter(b=>!LICHT_AUSBLENDEN.includes(b.name.trim().toLowerCase()))
    .map((b,i)=>({b,i})).sort((x,y)=>rang(x.b)-rang(y.b)||x.i-y.i).map(x=>x.b);
  $("#licht-list").innerHTML=sichtbar.map(b=>{
    const p=lichtBusy[b.id]||{}, an=p.an??b.an, hell=p.hell??b.hell;
    return `<div class="lamp ${an?"on":""}" data-id="${esc(b.id)}">
      <button class="lamp-btn" type="button" data-a="toggle" aria-pressed="${an?"true":"false"}" aria-label="${esc(b.name)} ${an?"ausschalten":"einschalten"}">${BULB}</button>
      <div class="lamp-top"><span class="nm">${esc(b.name)}${b.typ==="zone"?" <small>· Zone</small>":""}</span>
        ${b.szenen.length?`<select data-a="szene" aria-label="Szene ${esc(b.name)}"><option value="">Szene …</option>${b.szenen.map(z=>`<option value="${esc(z.id)}">${esc(z.name)}</option>`).join("")}</select>`:""}</div>
      <div class="lamp-ctl">${hell!=null?`<input type="range" min="1" max="100" value="${esc(hell)}" data-a="hell" aria-label="Helligkeit ${esc(b.name)}"><span class="pct">${an?esc(hell)+" %":"aus"}</span>`:`<span class="pct">${an?"an":"aus"}</span>`}</div></div>`;
  }).join("")||'<div class="empty">Keine Räume oder Zonen in Hue gefunden.</div>';
  $("#licht-list").querySelectorAll(".lamp").forEach(el=>{
    const id=el.dataset.id, b=lichtData.bereiche.find(x=>x.id===id);
    el.querySelector('[data-a="toggle"]').onclick=()=>lichtAct("/set",{id,an:!(lichtBusy[id]?.an??b.an)},id,{an:!(lichtBusy[id]?.an??b.an)});
    const r=el.querySelector('[data-a="hell"]');
    if(r){r.oninput=()=>{el.querySelector(".pct").textContent=r.value+" %";};r.onchange=()=>lichtAct("/set",{id,hell:+r.value},id,{an:true,hell:+r.value});}
    const sz=el.querySelector('[data-a="szene"]');
    if(sz)sz.onchange=()=>{if(sz.value)lichtAct("/szene",{id:sz.value},id,{an:true});};
  });
}
// Solange ein Finger in der Liste liegt (Regler ziehen), wird sie nicht neu aufgebaut – sonst bräche das Ziehen ab.
// Sicherheitsnetz: spätestens nach 15 s gilt die Berührung als beendet.
let lichtTouch=false, lichtDirty=false, lichtTouchT=null;
function lichtLos(){if(!lichtTouch)return;lichtTouch=false;clearTimeout(lichtTouchT);setTimeout(()=>{if(lichtDirty&&!lichtTouch){lichtDirty=false;renderLicht();}},0);}
$("#licht-list").addEventListener("pointerdown",()=>{lichtTouch=true;clearTimeout(lichtTouchT);lichtTouchT=setTimeout(lichtLos,15000);});
addEventListener("pointerup",lichtLos);addEventListener("pointercancel",lichtLos);
async function lichtAct(path,body,id,optimistic){
  if(id)lichtBusy[id]=optimistic||{};renderLicht();
  try{lichtData=lichtGut(await lichtCall(path,body));lichtMsg("");}catch(e){lichtFail(e);}
  if(id)delete lichtBusy[id];renderLicht();
}
async function loadLicht(){
  if(!lichtUrl){try{lichtUrl=(await getJSON("data/licht.json")).url||null;}catch{lichtUrl=null;}}
  if(!lichtUrl||!store.get(LICHT_KEY,"")){renderLicht();return;}
  if($("#licht").hidden)renderLicht();   // Feld samt Umschalter sofort zeigen, nicht erst nach der ersten Antwort
  if(Object.keys(lichtBusy).length||lichtTouch)return;
  if(document.activeElement&&document.activeElement.closest&&document.activeElement.closest("#licht-list"))return; // nicht während der Bedienung neu zeichnen
  try{const d=lichtGut(await lichtCall("/status"));if(!Object.keys(lichtBusy).length){lichtData=d;lichtMsg("");}}catch(e){lichtFail(e);}
  renderLicht();
}
$("#licht-form").onsubmit=async e=>{
  e.preventDefault();store.set(LICHT_KEY,$("#licht-pass").value);$("#licht-pass").value="";$("#licht-err").textContent="Prüfe…";
  await loadLicht();if(store.get(LICHT_KEY,""))$("#licht-err").textContent="";
};
$("#licht-aus").onclick=()=>lichtAct("/allesaus",{});
loadLicht();
setInterval(()=>{if(document.hidden||(lichtUrl&&rechtsZeigt()!=="licht"))return;const night=typeof isNight==="function"&&isNight()&&Date.now()>wakeUntil;if(!night||new Date().getMinutes()%5===0)loadLicht();},60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadLicht();});

/* ---------- Termine (TimeTree, eigenes Passwort) ---------- */
const CAL_KEY="kalenderPass";
let calDa=false, calData=null;
function calDayLabel(d,k){const dt=new Date(d+"T12:00:00");return {top:k===0?"Heute":k===1?"Morgen":dt.toLocaleDateString("de-DE",{weekday:"short"}),num:dt.toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit"})};}
function renderCal(){
  const box=$("#cal");
  if(ringBereit)ringZeigen();   // der Tagesbogen zeigt dieselben Termine
  if(!calDa&&!calData){box.hidden=true;return;}
  box.hidden=false;
  if(!calData){$("#cal-form").hidden=false;$("#cal-list").innerHTML='<div class="empty">Termine sind mit einem eigenen Passwort geschützt.</div>';$("#cal-stamp").textContent="";return;}
  $("#cal-form").hidden=true;
  const now=nowHM(), today=berlinDay();
  // nur Tage, die der letzte Abruf abdeckt (ab dem Abruftag CAL_ABRUF Tage)
  const bis=new Date(new Date(calData.stand).getTime()+(CAL_ABRUF-1)*864e5).toLocaleDateString("sv-SE",{timeZone:"Europe/Berlin"});
  const days=[...Array(CAL_TAGE)].map((_,k)=>berlinDay(k)).filter((d,k)=>k<8||d<=bis);
  $("#cal-list").innerHTML=`<div class="cal-days">${days.map((d,k)=>{
    const items=calData.termine.filter(t=>t.d<=d&&(t.bis_d||t.d)>=d&&!(!t.ganztag&&t.d<d&&t.bis_d===d&&t.bis==="00:00"));
    const gz=t=>t.ganztag||(t.d<d&&(t.bis_d||t.d)>d);   // ganztägig oder Zwischentag eines mehrtägigen Termins
    const duty=(privData?.eintraege||[]).filter(e=>e.d===d&&e.von);
    // ganztägig zuerst, danach Dienste und Termine nach Uhrzeit gemischt
    const tm=(lang,kurz)=>`<span class="tm"><span class="tl">${lang}</span><span class="ts">${kurz}</span></span>`;
    const all=[...duty.map(e=>({k:"1"+e.von,h:`<div class="cal-it duty"><i style="background:var(--amber)"></i>${tm(esc(e.von)+"–"+esc(e.bis),esc(e.von))}<span class="ti">Dienst${e.bem?` (${esc(e.bem)})`:""}</span></div>`})),
      ...items.map(t=>({k:gz(t)?"0":(t.d<d?"1 ":"1"+t.von),h:`<div class="cal-it ${gz(t)?"allday":""} ${d===today&&t.bis&&!t.ganztag&&t.bis<now&&t.bis_d===d?"past":""}"><i style="${/^#[0-9a-f]{6}$/i.test(t.farbe||"")?`background:${t.farbe}`:""}"></i>${gz(t)?tm("ganztägig",""):t.d<d?tm("bis "+esc(t.bis),"→"+esc(t.bis)):tm(esc(t.von)+(t.bis&&t.bis_d===t.d?"–"+esc(t.bis):""),esc(t.von))}<span class="ti">${esc(t.titel||"Termin")}</span></div>`}))];
    const rows=all.sort((a,b)=>a.k<b.k?-1:a.k>b.k?1:0).map(x=>x.h);
    const l=calDayLabel(d,k);
    const ft=feiertag(d), sf=schulfrei(d), fe0=ferienAm(d), fe=fe0&&fe0!==sf?fe0:null;
    const extra=(ft?`<div class="cal-it allday ft"><i></i>${tm("Feiertag","")}<span class="ti">${esc(ft)}</span></div>`:"")+(sf&&!ft?`<div class="cal-it allday sf"><i></i>${tm("schulfrei","")}<span class="ti">${esc(sf)}</span></div>`:"");
    return `<div class="cal-day ${k===0?"today":""} ${ft?"feiertag":""}"><div class="cal-dl">${esc(l.top)}<b>${esc(l.num)}</b>${fe?`<span class="hol" title="${esc(fe)}">Ferien</span>`:""}</div><div class="cal-items">${extra+rows.join("")||'<span class="muted">–</span>'}</div></div>`;
  }).join("")}</div>`;
  $("#cal-stamp").textContent="Stand "+new Date(calData.stand).toLocaleString("de-DE",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"});
  fitCal();
}
// So viele Tage zeigen, dass der Kalender mit dem Feld rechts (Heizung/Licht) abschließt; mindestens CAL_MIN
const CAL_TAGE=14, CAL_MIN=8, CAL_ABRUF=16;
function fitCal(){
  const days=[...document.querySelectorAll("#cal-list .cal-day")];if(!days.length)return;
  const right=document.querySelector(".hero-right"), cal=$("#cal");
  const card=[...right.querySelectorAll(":scope > .card")].find(x=>!x.hidden&&x.offsetParent);
  right.querySelectorAll(":scope > .card").forEach(x=>{if(x.style.minHeight)x.style.minHeight="";});
  days.forEach(x=>x.hidden=false);cal.style.minHeight="";
  const cols=getComputedStyle(days[0].parentElement).gridTemplateColumns.split(" ").length;
  const r=right.getBoundingClientRect(), c=cal.getBoundingClientRect();
  let n=days.length;
  if(r.left<c.right||!r.height){n=Math.min(n,CAL_MIN);}   // Feld steht nicht daneben (Handy)
  else{
    n=n-n%cols;   // nur volle Reihen
    for(let i=n;i<days.length;i++)days[i].hidden=true;
    while(n>CAL_MIN&&cal.getBoundingClientRect().bottom>r.bottom+2){
      n-=cols;for(let i=n;i<n+cols;i++)days[i].hidden=true;
    }
  }
  days.forEach((x,i)=>x.hidden=i>=n);
  // bündig mit dem Feld rechts abschließen
  if(r.left>=c.right&&r.height){const c2=cal.getBoundingClientRect();
    if(c2.bottom<r.bottom)cal.style.minHeight=Math.round(r.bottom-c2.top)+"px";
    else if(card&&c2.bottom>r.bottom+1){const k=card.getBoundingClientRect();card.style.minHeight=Math.round(c2.bottom-k.top)+"px";}}
}
addEventListener("resize",()=>{if(calData)fitCal();});
if(window.ResizeObserver)new ResizeObserver(()=>{if(calData)fitCal();}).observe(document.querySelector(".hero-right"));
// holt die Termine mit diesem Passwort und entschlüsselt sie; das Chiffrat wird für Netzaussetzer auf dem Gerät gemerkt
async function calHolen(pw){
  const d=await datenHolen("kalender",pw);
  const klar=d.t&&d.t===calHolen.t&&calData?calData:await decryptPriv(d.inhalt,pw);   // unverändert: nicht erneut entschlüsseln
  calHolen.t=d.t;store.set("ablage:kalender",d.inhalt);store.set("falsch:kalender",0);
  return klar;
}
$("#cal-form").onsubmit=async e=>{
  e.preventDefault();const pw=$("#cal-pass").value;if(!pw)return;$("#cal-err").textContent="Prüfe…";calHolen.t=0;
  try{calData=await calHolen(pw);store.set(CAL_KEY,pw);$("#cal-pass").value="";$("#cal-err").textContent="";renderCal();if(typeof katerTry==="function")katerTry();}
  catch(e){$("#cal-err").textContent=e.status===401?"Passwort "+sperrText(e):e.status!=null?sperrText(e):"Passwort falsch";}
};
async function loadCal(){
  calDa=!!(await datenAdresse());
  const pw=store.get(CAL_KEY,null);
  let offen=!calDa;   // true: es fehlt noch etwas, das ein baldiger neuer Versuch bringen könnte
  if(calDa&&pw&&!falschGemerkt("kalender")){
    try{calData=await calHolen(pw);}
    catch(e){
      if(e.status===401){calData=null;store.set("ablage:kalender",null);store.set("falsch:kalender",Date.now());}   // Passwort passt nicht (mehr): neu eingeben
      else if(!calData){   // Netzaussetzer o. Ä.: den zuletzt geholten Stand vom Gerät zeigen
        const alt=store.get("ablage:kalender",null);
        if(alt){try{calData=await decryptPriv(alt,pw);}catch{}}
        offen=e.status!==404;
      }
    }
  }
  if(!calDa&&pw&&!calData&&!falschGemerkt("kalender")){const alt=store.get("ablage:kalender",null);if(alt){try{calData=await decryptPriv(alt,pw);}catch{}}}   // wie bei den Diensten
  renderCal();
  if(calData&&typeof katerTry==="function")katerTry();
  if(offen)baldNochmal("kalender",loadCal);
}
loadCal();
// Gesetzliche Feiertage Bayern (München) – selbst berechnet; Schulferien aus data/ferien.json
const _ftCache={};
function feiertageJahr(y){
  if(_ftCache[y])return _ftCache[y];
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  const om=Math.floor((h+l-7*m+114)/31), od=((h+l-7*m+114)%31)+1, ostern=Date.UTC(y,om-1,od);
  const iso=t=>new Date(t).toISOString().slice(0,10), o=n=>iso(ostern+n*864e5), f2=(mm,dd)=>`${y}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
  const r={[f2(1,1)]:"Neujahr",[f2(1,6)]:"Heilige Drei Könige",[o(-2)]:"Karfreitag",[o(1)]:"Ostermontag",[f2(5,1)]:"Tag der Arbeit",[o(39)]:"Christi Himmelfahrt",
    [o(50)]:"Pfingstmontag",[o(60)]:"Fronleichnam",[f2(8,15)]:"Mariä Himmelfahrt",[f2(10,3)]:"Tag der Deutschen Einheit",[f2(11,1)]:"Allerheiligen",[f2(12,25)]:"1. Weihnachtstag",[f2(12,26)]:"2. Weihnachtstag"};
  return _ftCache[y]=r;
}
const feiertag=d=>feiertageJahr(+d.slice(0,4))[d]||null;
// Buß- und Bettag: Mittwoch vor dem 23. November, in Bayern schulfrei (kein Feiertag)
function schulfrei(d){const y=+d.slice(0,4);const t=new Date(Date.UTC(y,10,22));while(t.getUTCDay()!==3)t.setUTCDate(t.getUTCDate()-1);return d===t.toISOString().slice(0,10)?"Buß- und Bettag":null;}
let ferien=[];
const ferienAm=d=>(ferien.find(f=>f.von<=d&&d<=f.bis)||{}).name||null;
function loadFerien(){getJSON("data/ferien.json").then(x=>{ferien=x.ferien||[];if(calData)renderCal();if(!$("#dienste").hidden)dienstZeigen();}).catch(()=>{});}
loadFerien();
setInterval(loadCal,60*60000);
setInterval(()=>{if(calData)renderCal();},60000);

/* ---------- Tagesbogen um die Uhr (ab iPad-Breite) ----------
   Halbkreis über der Uhrzeit: ein laufendes Fenster von 6 Stunden zurück bis 18 Stunden voraus. „Jetzt“ steht immer
   an derselben Stelle, die Stunden wandern; so bleibt ein Nachtdienst ein Stück. Außen der Dienst (gestrichelt:
   gesperrter Tag), innen die Termine nach TimeTree-Farbe – blau = eigene, grün = die der zweiten Person. Ganztägige Termine von heute
   stehen als Punkte über dem Datum. Ferien und Feiertage erscheinen hier nicht. */
// Zeitpunkt (ms) einer Münchner Ortszeit; zweistufig, damit auch die Tage der Zeitumstellung stimmen
function berlinMs(d,hm){
  const [y,m,t]=d.split("-").map(Number), [h,mi]=(hm||"00:00").split(":").map(Number), u=Date.UTC(y,m-1,t,h,mi||0);
  const ab=x=>Date.parse(new Date(x).toLocaleString("sv-SE",{timeZone:"Europe/Berlin"}).replace(" ","T")+"Z")-x;
  return u-ab(u-ab(u));
}
// wem ein Termin gehört, sagt seine Farbe: Blautöne = ich, Grüntöne = zweite Person, alles andere bleibt aus dem Bogen
function terminWer(f){
  const m=/^#([0-9a-f]{6})$/i.exec(f||"");if(!m)return null;
  const n=parseInt(m[1],16), r=(n>>16)/255, g=(n>>8&255)/255, b=(n&255)/255, mx=Math.max(r,g,b), dl=mx-Math.min(r,g,b);
  if(dl<.15)return null;   // Grau, Schwarz, Weiß
  const h=((mx===r?((g-b)/dl)%6:mx===g?(b-r)/dl+2:(r-g)/dl+4)*60+360)%360;
  return h>=75&&h<165?"zwei":h>=165&&h<262?"ich":null;
}
const RING_FREI=/ferien|feiertag|schulfrei/i;
function ringZeigen(){
  const el=$("#tagring");if(!el)return;
  const H=3600e3, jetzt=Math.floor(Date.now()/60000)*60000, t0=jetzt-6*H, t1=t0+24*H, heute=berlinDay();
  const f=v=>v.toFixed(1), P=(x,r)=>{const w=Math.PI-(x/24)*Math.PI;return [50+r*Math.cos(w),52-r*Math.sin(w)];};
  const bogen=(a,b,r)=>{const [x1,y1]=P(a,r),[x2,y2]=P(b,r);return `M${f(x1)} ${f(y1)}A${r} ${r} 0 0 1 ${f(x2)} ${f(y2)}`;};
  // Abschnitt (ms) auf das Fenster zuschneiden; null, wenn er außerhalb liegt
  const teil=(a,b,r,kl)=>{a=Math.max(t0,a);b=Math.min(t1,b);return b>a?`<path class="${kl}" d="${bogen((a-t0)/H,(b-t0)/H,r)}"/>`:"";};
  const RD=44.5, RI=37.6, RJ=33.2;
  let s=`<path class="tr-sp" d="${bogen(0,24,RD)}"/><path class="tr-sp2" d="${bogen(0,24,RI)}"/><path class="tr-sp2" d="${bogen(0,24,RJ)}"/>`;
  const tage=[...new Set([berlinDay(-1),heute,berlinDay(1)])];
  if(privData){
    for(const d of tage){const i=dayInfo(d);if(i.zu.length&&!i.zeit.length)s+=teil(berlinMs(d),berlinMs(dnPlus(d,1)),RD,"tr-g");}
    for(const e of privData.eintraege||[])if(e.von&&e.bis&&tage.includes(e.d))s+=teil(berlinMs(e.d,e.von),berlinMs(e.ueber?dnPlus(e.d,1):e.d,e.bis),RD,"tr-d");
  }
  const punkte=[];
  for(const t of calData?.termine||[]){
    const wer=terminWer(t.farbe), bis=t.bis_d||t.d;if(!wer||bis<tage[0]||t.d>tage[2])continue;
    if(t.ganztag){
      const frei=RING_FREI.test(t.titel||"")||[feiertag(heute),schulfrei(heute),ferienAm(heute)].includes((t.titel||"").trim());
      if(t.d<=heute&&bis>=heute&&!frei&&!punkte.includes(wer))punkte.push(wer);
    }else if(t.von&&t.bis){const a=berlinMs(t.d,t.von);s+=teil(a,Math.max(berlinMs(bis,t.bis),a+.8*H),wer==="ich"?RI:RJ,wer==="ich"?"tr-i":"tr-j");}
  }
  // Stundenmarken 0, 6, 12, 18 (Mitternacht hervorgehoben)
  for(const d of tage)for(const st of [0,6,12,18]){
    const x=(berlinMs(d,String(st).padStart(2,"0")+":00")-t0)/H;if(x<.15||x>23.85)continue;
    const [a,b]=P(x,RD+3.6),[c,e]=P(x,RD+5.6),[g,h]=P(x,RD+9.5);
    s+=`<line class="tr-t${st?"":" tr-0"}" x1="${f(a)}" y1="${f(b)}" x2="${f(c)}" y2="${f(e)}"/><text class="tr-n${st?"":" tr-0"}" x="${f(g)}" y="${f(h+2)}" text-anchor="middle">${st}</text>`;
  }
  const [zx,zy]=P(6,33),[zx2,zy2]=P(6,RD+4);
  s+=`<line class="tr-z" x1="${f(zx)}" y1="${f(zy)}" x2="${f(zx2)}" y2="${f(zy2)}"/>`;
  punkte.sort().forEach((wer,k)=>{s+=`<circle class="${wer==="ich"?"tr-pi":"tr-pj"}" cx="${f(50+(k-(punkte.length-1)/2)*7.5)}" cy="27" r="2.7"/>`;});
  if(el._html!==s){el.innerHTML=s;el._html=s;}
}
ringBereit=true;ringZeigen();
setInterval(loadPriv,60*60000);
setInterval(()=>{if(privData)renderDuty();},60000);

/* ---------- Arbeitsweg (eigener Dienst; Adressen nur dort als Secrets) ---------- */
const WEG_KEY="wegPass", WEG_VORLAUF=35;      // Ankunft 35 min vor Dienstbeginn
let wegUrl=null, wegInfo=null, wegShift=null, wegArrive=null, wegStatus="", wegCheckAt=0, wegCheckOk=false, wegFehler=null;
function setWegStatus(t){if(t!==wegStatus){wegStatus=t;if(privData)renderDuty();}}
const wegTag=d=>d.toLocaleString("de-DE",{weekday:"short",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"});
const WEG_FENSTER=60;                          // Anzeige ab 60 min vor der Ankunft bis zur Ankunft
// Datum + Uhrzeit immer als deutsche Zeit (Europe/Berlin) deuten, unabhängig von der Gerätezeitzone
function berlinTime(d,hm){
  const [y,m,dd]=d.split("-").map(Number),[h,mi]=hm.split(":").map(Number),want=Date.UTC(y,m-1,dd,h,mi);
  const fmt=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Berlin",hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
  let t=want;
  for(let i=0;i<2;i++){const p=fmt.formatToParts(new Date(t)),g=k=>+p.find(x=>x.type===k).value;t-=Date.UTC(g("year"),g("month")-1,g("day"),g("hour"),g("minute"))-want;}
  return new Date(t);
}
function nextShift(){
  // nächster Dienst, dessen Ankunftszeit (Beginn − WEG_VORLAUF) noch bevorsteht
  const now=Date.now();
  return (privData?.eintraege||[]).filter(e=>e.von).map(e=>({e,start:berlinTime(e.d,e.von)}))
    .filter(x=>x.start.getTime()-WEG_VORLAUF*60e3>now).sort((a,b)=>a.start-b.start)[0]||null;
}
function wegText(){
  if(!wegInfo||!wegShift||!wegArrive)return null;
  const n=Date.now();
  if(n<wegArrive.getTime()-WEG_FENSTER*60e3||n>=wegArrive.getTime())return null;
  const los=wegInfo.los?new Date(wegInfo.los):null, now=Date.now();
  const lt=los?los.toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"}):"";
  const stau=wegInfo.stau>0?` (+${wegInfo.stau} Stau)`:"";
  if(los&&now>los.getTime())return {t:`🚗 Jetzt losfahren! ${wegInfo.minuten} min${stau}`,c:"weg-bad"};
  return {t:`🚗 ${wegInfo.minuten} min${stau} · los ${lt}`,c:wegInfo.stau>=10?"weg-warn":"weg-ok"};
}
function wegShow(){
  const kn=$("#duty-days");if(!kn)return;
  const w=wegText()||(wegFehler?{t:wegFehler,c:"weg-bad"}:null);
  kn.classList.remove("weg-ok","weg-warn","weg-bad");
  if(w){kn.dataset.label=w.t;kn.classList.add(w.c);}else delete kn.dataset.label;
  const t=kn.dataset.label||kn.dataset.today||"Dienste", pt=kn.querySelector(".pt");
  if(pt&&pt.textContent!==t)pt.textContent=t;
}
async function wegAbfrage(arrive,pass){
  const r=await fetchT(`${wegUrl}/verkehr?ankunft=${encodeURIComponent(arrive.toISOString())}`,{headers:{"X-Castle-Pass":pass},cache:"no-store"});
  const d=await r.json().catch(()=>({}));
  if(r.status===401){store.set(WEG_KEY,"");$("#weg-form").hidden=false;$("#weg-err").textContent="Passwort falsch";renderDuty();throw new Error("Passwort falsch");}
  if(!r.ok)throw new Error(d.error||("Fehler "+r.status));
  return d;
}
async function loadWeg(){
  if(!wegUrl){try{wegUrl=(await getJSON("data/weg.json")).url||null;}catch{wegUrl=null;}
    if(wegUrl&&privData)renderDuty();}
  const pass=store.get(WEG_KEY,"");
  if(!wegUrl||!pass||!privData){wegInfo=null;wegShow();return;}
  const ns=nextShift();
  if(!ns){wegInfo=null;setWegStatus("🚗 Fahrzeit: kein Dienst mit Uhrzeit in Sicht");wegShow();return;}
  const arrive=new Date(ns.start.getTime()-WEG_VORLAUF*60e3), ab=new Date(arrive.getTime()-WEG_FENSTER*60e3);
  const imFenster=Date.now()>=ab.getTime()&&Date.now()<arrive.getTime();
  if(!imFenster){
    wegInfo=null;wegShift=null;wegArrive=null;wegFehler=null;wegShow();
    // prüfen, ob der Dienst grundsätzlich funktioniert (Adressen, Schlüssel): bis es einmal geklappt hat, höchstens alle 10 min
    if(!wegCheckOk){
      if(Date.now()-wegCheckAt<10*60e3)return;
      wegCheckAt=Date.now();
      try{await wegAbfrage(arrive,pass);wegCheckOk=true;}catch(e){setWegStatus("🚗 Fahrzeit-Fehler: "+errTxt(e));return;}
    }
    setWegStatus(`🚗 Fahrzeit ab ${wegTag(ab)} (Dienst ${wegTag(ns.start)})`);
    return;
  }
  try{wegInfo=await wegAbfrage(arrive,pass);wegShift=ns;wegArrive=arrive;wegFehler=null;wegCheckOk=true;setWegStatus(`🚗 Fahrzeit aktiv bis ${wegTag(arrive)}`);}
  catch(e){wegInfo=null;wegFehler="🚗 Fahrzeit-Fehler – Details in der Liste";setWegStatus("🚗 Fahrzeit-Fehler: "+errTxt(e));}
  wegShow();
}
$("#weg-form").onsubmit=async e=>{
  e.preventDefault();store.set(WEG_KEY,$("#weg-pass").value);$("#weg-pass").value="";$("#weg-err").textContent="Prüfe…";
  try{const r=await fetchT(`${wegUrl}/check`,{headers:{"X-Castle-Pass":store.get(WEG_KEY,"")},cache:"no-store"});
    if(r.ok){$("#weg-form").hidden=true;$("#weg-err").textContent="";wegCheckAt=0;wegCheckOk=false;renderDuty();loadWeg();}
    else{store.set(WEG_KEY,"");$("#weg-err").textContent=r.status===429?"Gesperrt, später erneut":"Passwort falsch";}
  }catch{$("#weg-err").textContent="Dienst nicht erreichbar";}
};
setInterval(wegShow,20000);                       // Wechsel auf „Jetzt losfahren“ und Ende des Fensters
setInterval(()=>{if(!document.hidden)loadWeg();},60000); // außerhalb des Fensters ohne Abfrage
setTimeout(loadWeg,2500);

/* ---------- Wetter (Open-Meteo, Aubing) ---------- */
let wxState=null, wxOk=0;
// Pollenflug (DWD, Oberbayern): heute, die stärksten 3 Arten mit Balken (0–3), Tooltip mit morgen
let pollen=null;
const POL_TXT={0.5:"sehr gering",1:"gering",1.5:"gering bis mittel",2:"mittel",2.5:"mittel bis hoch",3:"hoch"};
function pollenHTML(){
  const t=pollen?.tage?.[berlinDay()];if(!t)return "";
  const m=pollen.tage[berlinDay(1)]||{};
  const hit=Object.entries(t).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,3);
  if(!hit.length)return `<span class="pol-l">Pollen</span> keine Belastung`;
  return `<span class="pol-l">Pollen</span> `+hit.map(([n,v])=>`<span class="pol" title="${esc(n)}: heute ${POL_TXT[v]}${m[n]!=null?`, morgen ${m[n]?POL_TXT[m[n]]:"keine"}`:""}">${esc(n)}<i class="pb ${v>=2.5?"hi":v>=1.5?"mid":"lo"}" style="--v:${v}"></i></span>`).join("");
}
function loadPollen(){getJSON("data/pollen.json").then(x=>{pollen=x;const el=document.querySelector("#wx .wx-pol");if(el)el.innerHTML=pollenHTML();}).catch(()=>{});}
loadPollen();
const WMO={0:"Klar",1:"Überwiegend klar",2:"Teils bewölkt",3:"Bedeckt",45:"Nebel",48:"Reifnebel",51:"Leichter Niesel",53:"Niesel",55:"Starker Niesel",56:"Gefrierender Niesel",57:"Gefrierender Niesel",61:"Leichter Regen",63:"Regen",65:"Starker Regen",66:"Eisregen",67:"Eisregen",71:"Leichter Schnee",73:"Schnee",75:"Starker Schnee",77:"Schneegriesel",80:"Regenschauer",81:"Regenschauer",82:"Heftige Schauer",85:"Schneeschauer",86:"Schneeschauer",95:"Gewitter",96:"Gewitter mit Hagel",99:"Gewitter mit Hagel"};
function wxIcon(code,day){
  if(code===0)return day?"sun":"moon";
  if(code===1||code===2)return day?"pday":"pnight";
  if(code===45||code===48)return "fog";
  if([51,53,55].includes(code))return "drizzle";
  if([56,57,66,67].includes(code))return "sleet";
  if([61,63,65,80,81,82].includes(code))return "rain";
  if([71,73,75,77,85,86].includes(code))return "snow";
  if(code>=95)return "thunder";
  return "cloud";
}
// Wind: Pfeil zeigt, wohin der Wind weht; Richtung als Herkunft (z. B. "aus SW")
const DIRS=["N","NO","O","SO","S","SW","W","NW"];
function windHTML(c){
  if(c.wind_speed_10m==null)return "";
  const dir=DIRS[Math.round(((c.wind_direction_10m%360)+360)%360/45)%8];
  const gust=Math.round(c.wind_gusts_10m||0), strong=gust>=50;
  return `<span class="wx-wind ${strong?"gust":""}" title="Wind aus ${dir}">
    <svg viewBox="0 0 24 24" style="transform:rotate(${(c.wind_direction_10m+180)%360}deg)" aria-hidden="true"><path d="M12 3v18M12 3l-5 5.5M12 3l5 5.5" stroke="#9fd2ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    <span>${Math.round(c.wind_speed_10m)} km/h <small>aus ${dir} · Böen ${gust}</small></span></span>`;
}
const ico=(code,day,label)=>`<svg role="img" aria-label="${esc(label||"")}"><use href="#i-${wxIcon(code,day)}"/></svg>`;
const WX_URL="https://api.open-meteo.com/v1/forecast?latitude=48.156&longitude=11.413&current=temperature_2m,apparent_temperature,weather_code,is_day,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day&timezone=Europe%2FBerlin&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max";
let wxDaily=null, wxWeekOpen=false, wxWeekTimer=null;
// mit Sonnenzeiten und Werten für 7 Tage; lehnt die Quelle die erweiterte Abfrage ab, läuft das Wetter mit der einfachen weiter
async function wxAbruf(){
  try{return await getJSON(WX_URL+",precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset&forecast_days=8");}
  catch(e){if(e.message!=="400")throw e;return getJSON(WX_URL+"&forecast_days=4");}
}
const SONNE='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="#ffc23d"/><g stroke="#ffc23d" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></g></svg>';
// Tageslicht-Leiste: Balken über 24 h, helle Phase gelb, weiße Marke = jetzt
function showSun(){
  const el=$("#sun");if(!el)return;
  const d=wxDaily, i=d?.time?d.time.indexOf(berlinDay()):-1;
  if(!d?.sunrise?.[i]||!d?.sunset?.[i]){el.hidden=true;return;}
  const min=t=>+t.slice(0,2)*60+ +t.slice(3,5), auf=d.sunrise[i].slice(11,16), unter=d.sunset[i].slice(11,16), a=min(auf), u=min(unter), n=min(nowHM());
  const dauer=m=>m<60?`${m} min`:`${Math.floor(m/60)} h ${String(m%60).padStart(2,"0")}`;
  const hell=n>=a&&n<u, txt=n<a?`hell in ${dauer(a-n)}`:hell?`noch ${dauer(u-n)} hell`:d.sunrise[i+1]?`hell ab ${d.sunrise[i+1].slice(11,16)}`:"dunkel";
  el.hidden=false;
  el.innerHTML=`${SONNE}<span>${esc(auf)}</span><span class="sbar"><i class="hell" style="left:${(a/14.4).toFixed(1)}%;width:${((u-a)/14.4).toFixed(1)}%"></i><i class="nun" style="left:${(n/14.4).toFixed(1)}%"></i></span><span>${esc(unter)}</span><span class="st ${hell?"":"dunkel"}">${esc(txt)}</span>`;
  el.title=`Sonnenaufgang ${auf}, Sonnenuntergang ${unter}, Tageslänge ${dauer(u-a)}`;
}
// Wochenwetter (7 Tage ab morgen) unter der Tafel; wird durch Antippen des Wetterfelds auf- und zugeklappt
function showWeek(){
  const el=$("#wx-week"), d=wxDaily, ok=!!d?.precipitation_sum;
  $("#wx").classList.toggle("tippbar",ok);
  const m=document.querySelector("#wx .wx-more");if(m)m.hidden=!ok;
  const auf=ok&&wxWeekOpen, war=!el.hidden;
  document.querySelector(".board").classList.toggle("woche",auf);
  el.hidden=!auf;
  if(auf){
    const i0=Math.max(0,d.time.indexOf(berlinDay())), z=x=>(Math.round(x*10)/10).toLocaleString("de-DE");
    const lc=typeof luftAktuell==="function"?luftAktuell():null, lr=x=>x==null?"–":Math.round(x);
    el.innerHTML=`<div class="ww-head"><h2>Wetter · nächste 7 Tage</h2><span>Regenmenge · Wind · antippen zum Schließen</span></div><div class="ww-grid">`+
      [...Array(7)].map((_,k)=>i0+1+k).filter(i=>d.time[i]).map(i=>{
        const dt=new Date(d.time[i]+"T12:00:00"), mm=d.precipitation_sum[i]||0, p=d.precipitation_probability_max?.[i]||0, w=Math.round(d.wind_speed_10m_max?.[i]||0), g=Math.round(d.wind_gusts_10m_max?.[i]||0);
        return `<div class="ww-d"><span class="top"><span class="wd">${dt.toLocaleDateString("de-DE",{weekday:"short"}).replace(".","")} <small>${dt.toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit"})}</small></span>${p>=20?`<i>${p} %</i>`:""}</span>
          <span class="mm">${ico(d.weather_code[i],1,WMO[d.weather_code[i]])}<b>${Math.round(d.temperature_2m_max[i])}°</b>${Math.round(d.temperature_2m_min[i])}°</span>
          <span class="rg ${mm>=0.1?"":"tr"}">${mm>=0.1?z(mm)+" mm":"trocken"}</span>
          <span class="wi ${g>=45?"sturm":""}">${g>=45?`Böen ${g} km/h`:`Wind ${w} km/h`}</span></div>`;}).join("")+`</div>`
      +(lc?`<div class="ww-luft">Luft jetzt: <b>LQI ${Math.round(lc.european_aqi)} · ${LUFT_ST[luftStufe(lc.european_aqi)][1]}</b> · Feinstaub ${lr(lc.pm2_5)} · Ozon ${lr(lc.ozone)} · Stickstoffdioxid ${lr(lc.nitrogen_dioxide)} µg/m³</div>`:"");
  }
  if(auf!==war&&typeof fitCal==="function"&&calData)fitCal();   // Kalender rückt nach unten bzw. wieder hoch
}
function wxWeekToggle(){
  if(!wxDaily?.precipitation_sum)return;
  wxWeekOpen=!wxWeekOpen;clearTimeout(wxWeekTimer);
  if(wxWeekOpen)wxWeekTimer=setTimeout(()=>{wxWeekOpen=false;showWeek();},3*60000);   // klappt nach 3 min von selbst wieder zu
  showWeek();
}
$("#wx").addEventListener("click",e=>{if(!e.target.closest("a,button,select,input"))wxWeekToggle();});
$("#wx-week").addEventListener("click",wxWeekToggle);
setInterval(showSun,60000);
// Die Stundenwerte der Wetterquelle für Niederschlag gelten für die Stunde VOR ihrer Zeitmarke: Der Wert bei 14:00
// beschreibt 13–14 Uhr. regenAb(h,i) ist deshalb die Regenwahrscheinlichkeit der Stunde, die bei h.time[i] beginnt.
const regenAb=(h,i)=>h.precipitation_probability?.[i+1]||0;
// Regen-Hinweis in der Statuszeile: Er kündigt nur den Beginn eines Niederschlags an („Regen ab 14:00“).
// Regnet es oder gilt die laufende Stunde als nass, verschwindet er – auch bei Dauerregen. Ein Beginn, der weniger
// als REGEN_PAUSE nach dem letzten Regen liegt, gehört noch zu diesem und wird nicht neu angekündigt (Schauertag).
const REGEN_AB=50, REGEN_PAUSE=3*3600e3, REGEN_WEIT=6;
let regenMerk=0;   // letzter nasser Abruf; zusätzlich im Gerätespeicher, damit er ein Neuladen übersteht
function regenHinweis(c,h,iNow,jetzt=Date.now()){
  // Der Wettercode der Quelle gilt jeweils für eine ganze Stunde und meldet oft „Regen“ ohne messbare Menge; er zählt
  // deshalb nur zusammen mit einer Menge für die laufende Stunde (fehlt die Angabe, zählt er allein). Der aktuelle
  // Code beschreibt in der ersten Viertelstunde noch die Stunde davor, darum zählt auch der Code am Stundenende.
  const nass=(c.precipitation||0)>0||regenAb(h,iNow)>=REGEN_AB||((c.weather_code>=51||h.weather_code?.[iNow+1]>=51)&&(h.precipitation?.[iNow+1]??1)>0);
  if(nass){regenMerk=jetzt;store.set("regenNass",jetzt);return null;}
  // ein Zeitpunkt in der Zukunft (Uhr verstellt) oder ein unlesbarer Wert zählt nicht
  const zuletzt=Math.max(0,...[regenMerk,store.get("regenNass",0)].filter(t=>typeof t==="number"&&t<=jetzt));
  for(let i=iNow+1;i<=iNow+REGEN_WEIT&&h.time[i];i++)if(regenAb(h,i)>=REGEN_AB){
    if(jetzt-jetzt%3600e3+(i-iNow)*3600e3-zuletzt<REGEN_PAUSE)return null;
    return {zeit:h.time[i].slice(11,16),p:regenAb(h,i),schnee:[i+1,i].some(k=>/^(7[1-7]|8[56])$/.test(String(h.weather_code?.[k])))};
  }
  return null;
}
async function loadWx(){
  try{
    const d=await wxAbruf();
    if(!d.current||!d.hourly)throw new Error(d.reason||"unvollständige Antwort");
    const h=d.hourly, c=d.current, nowH=c.time.slice(0,13);
    const iNow=Math.max(0,h.time.findIndex(t=>t.slice(0,13)===nowH));
    const next=h.time.map((t,i)=>i).filter(i=>h.time[i].slice(0,13)>nowH).slice(0,6);
    const pp=v=>v>=10?`${v} %`:"";
    const dy=d.daily;
    const dayCols=[1,2,3].filter(i=>dy.time?.[i]).map(i=>{
      const dt=new Date(dy.time[i]+"T12:00:00"), p=dy.precipitation_probability_max?.[i]||0;
      const wd=i===1?"Morgen":dt.toLocaleDateString("de-DE",{weekday:"short"}).replace(".","");
      return `<div class="wx-d"><span class="top"><span class="wd">${wd}</span>${p>=20?`<i>${p} %</i>`:""}</span><span class="mm">${ico(dy.weather_code[i],1,WMO[dy.weather_code[i]])}<b>${Math.round(dy.temperature_2m_max[i])}°</b>${Math.round(dy.temperature_2m_min[i])}°</span></div>`;});
    const cols=[`<div class="wx-c now"><b>${Math.round(c.temperature_2m)}°</b><span class="pp">${pp(regenAb(h,iNow))}</span>${ico(c.weather_code,c.is_day,WMO[c.weather_code])}<span class="t">Jetzt</span></div>`]
      .concat(next.map(i=>`<div class="wx-c"><b>${Math.round(h.temperature_2m[i])}°</b><span class="pp">${pp(regenAb(h,i))}</span>${ico(h.weather_code[i],h.is_day[i],WMO[h.weather_code[i]])}<span class="t">${esc(h.time[i].slice(11,16))}</span></div>`));
    $("#wx").innerHTML=`<div class="board-head"><h2>Wetter Aubing<span class="wx-more" hidden></span></h2>${windHTML(c)}</div>
      <div class="wx-cur">${ico(c.weather_code,c.is_day,WMO[c.weather_code])}<span class="wx-temp">${Math.round(c.temperature_2m)}°</span>
        <span class="wx-desc">${esc(WMO[c.weather_code]||"")}<small>gefühlt ${Math.round(c.apparent_temperature)}° · H ${Math.round(d.daily.temperature_2m_max[0])}° T ${Math.round(d.daily.temperature_2m_min[0])}°</small><small class="wx-pol">${pollenHTML()}</small></span>
        <span class="lqi" id="luft" hidden></span></div>
      <div class="wx-strip">${cols.join("")}<div class="sun" id="sun" hidden></div></div>
      <div class="wx-days">${dayCols.join("")}</div>`;
    wxDaily=dy;wxOk=Date.now();showSun();showWeek();
    showLuft();
    wxState={temp:Math.round(c.temperature_2m),code:c.weather_code,day:c.is_day,morgen:dy.time[1]?{max:Math.round(dy.temperature_2m_max[1]),min:Math.round(dy.temperature_2m_min[1]),pp:dy.precipitation_probability_max?.[1]||0}:null};
    showFenster();
    nightRefresh();
    const rg=regenHinweis(c,h,iNow), pr=$("#pill-rain");pr.hidden=!rg;
    if(rg)setPill(pr,"warn",`${rg.schnee?"Schnee":"Regen"} ab ${rg.zeit} · ${rg.p} %`);
  }catch(e){
    console.warn("Wetter:",e&&e.message);
    // alte Anzeige zunächst behalten; in 2 Minuten erneut versuchen. Wird sie zu alt, steht das dabei (ab 30 min)
    // bzw. sie verschwindet ganz (ab 3 h) – ein Wetterbericht von gestern hilft nicht.
    const alt=Date.now()-wxOk, kopf=$("#wx .board-head h2");
    if(!$("#wx .wx-strip")||alt>3*3600e3){
      $("#wx").innerHTML=`<div class="empty" style="color:#9fb0c8">Wetter ${wxOk?"seit "+fmtT(wxOk)+" Uhr nicht abrufbar":"gerade nicht abrufbar"}, neuer Versuch läuft.</div>`;
      document.querySelector(".board-wx")?.classList.remove("alarm");$("#pill-rain").hidden=true;wxDaily=null;wxState=null;showWeek();nightRefresh();
    }else if(kopf&&alt>30*60000){
      const s=kopf.querySelector(".wx-alt")||kopf.appendChild(Object.assign(document.createElement("small"),{className:"wx-alt"}));
      s.textContent=" · Stand "+fmtT(wxOk);$("#pill-rain").hidden=true;
    }
    clearTimeout(window._wxRetry);window._wxRetry=setTimeout(loadWx,120000);
  }
}
loadWx();setInterval(()=>{if(!document.hidden)loadWx();},15*60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-wxOk>5*60000)loadWx();});
// Luftqualität (Open-Meteo, Europäischer Luftqualitätsindex): 0–20 sehr gut … ab 60 schlecht → Wetterfeld rot
let luft=null, luftOk=0;
const LUFT_ST=[[20,"sehr gut"],[40,"gut"],[60,"mäßig"],[80,"schlecht"],[100,"sehr schlecht"],[1e9,"extrem schlecht"]];
const luftAktuell=()=>luft&&Date.now()-luftOk<3*3600e3&&luft.european_aqi!=null?luft:null;
const luftStufe=v=>LUFT_ST.findIndex(x=>v<x[0]);
function showLuft(){
  const el=$("#luft"), box=document.querySelector(".board-wx");if(!el)return;
  const c=luftAktuell();
  el.hidden=!c;if(!c){box.classList.remove("alarm");return;}
  const v=c.european_aqi, k=luftStufe(v), r=x=>x==null?"–":Math.round(x);
  el.className="lqi s"+(k+1);box.classList.toggle("alarm",k>=3);
  el.innerHTML=`<small>LQI</small><b>${Math.round(v)}</b><span>${LUFT_ST[k][1]}</span>`;
  el.title=`Luftqualitätsindex (0–20 sehr gut, ab 60 schlecht) · Feinstaub ${r(c.pm2_5)}, Ozon ${r(c.ozone)}, NO₂ ${r(c.nitrogen_dioxide)} µg/m³`;
  if(wxWeekOpen)showWeek();   // Einzelwerte stehen in der aufgeklappten Wochenansicht
}
async function loadLuft(){
  try{const d=await getJSON("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=48.156&longitude=11.413&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone&timezone=Europe%2FBerlin");
    if(d.current){luft=d.current;luftOk=Date.now();}}catch{}
  showLuft();
}
loadLuft();setInterval(()=>{if(!document.hidden)loadLuft();},30*60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-luftOk>30*60000)loadLuft();});   // nach längerer Pause nicht bis zum nächsten Takt warten

/* ---------- Abfahrten ---------- */
let deps=[], depsOk=0;
// Fährt der Zug bis mindestens Marienplatz? Ziele davor heißen: der Zug endet vor der Stammstrecke oder mittendrin
// (so sieht es bei Bauarbeiten und Sperrungen aus, z. B. „Pasing“ statt „Ebersberg“)
const KURZ=/Leienfels|Pasing|\bLaim\b|Hirschgarten|Donnersbergerbr|Hackerbr|Hauptbahnhof|\bHbf\b|Karlsplatz|Stachus|Heimeranplatz/i;
const endetVorher=d=>!!d.sev||(!/Berg am Laim/i.test(d.destination)&&KURZ.test(d.destination));
const depT=d=>d.realtimeDepartureTime||d.plannedDepartureTime;
const depsFrisch=()=>deps.length>0&&Date.now()-depsOk<180000;
const stadtZuege=()=>deps.filter(d=>!WEST.test(d.destination)&&depT(d)>Date.now()-30000);
// eindeutige Sperr-Formulierungen in Störungsmeldungen (allgemeine Hinweise wie „Umleitungen möglich“ zählen nicht)
const SPERR=/gesperrt|Sperrung|kein(?:e|en)? (?:S-Bahn-?|Zug)?[Vv]erkehr|[Vv]erkehr (?:ist |wurde )?eingestellt|unterbrochen|nicht befahrbar/i;
// … außer die Meldung sagt selbst, dass die Sperrung vorbei ist
const FREI=/aufgehoben|wieder (?:frei|befahrbar|freigegeben|aufgenommen)|nicht mehr gesperrt|Sperrung(?:en)? (?:ist |sind |wurde |wurden )?beendet/i;
// Hinweis für den Abfahrtskasten: rot, wenn die nächste S4 nicht bis Marienplatz fährt oder die Stammstrecke gesperrt ist;
// gelb, wenn erst spätere Züge vorher enden oder eine Störung auf der Stammstrecke gemeldet ist
function depAlarm(){
  const zuege=depsFrisch()?stadtZuege():[];
  const fahr=zuege.filter(d=>!d.cancelled), erster=fahr[0];
  const wo=d=>d.sev?"Ersatzverkehr statt S-Bahn":`Endstation: ${d.destination}`;
  const wann=d=>(dayKey(new Date(depT(d)).toISOString())===berlinDay()?"":fmtD(depT(d))+" ")+fmtT(depT(d));
  if(zuege.length&&zuege.slice(0,3).every(d=>d.cancelled))return {l:"rot",t:"S4 fällt aus",s:"Die nächsten Züge Richtung Innenstadt entfallen."};
  if(erster&&endetVorher(erster)){
    const durch=fahr.find(d=>!endetVorher(d)), alle=!fahr.slice(0,3).some(d=>!endetVorher(d));
    return {l:"rot",t:alle?"S4 fährt nicht bis Marienplatz":"Nächste S4 fährt nicht bis Marienplatz",s:wo(erster)+(durch?` · wieder durchgehend ab ${wann(durch)}`:"")};
  }
  const inc=(Date.now()-msgsOk<10*60000?msgs:[]).filter(m=>isS4(m)&&m.type==="INCIDENT"&&isNow(m)&&stammRelevant(m));
  const zu=inc.find(m=>SPERR.test(plain(m))&&!FREI.test(plain(m)));
  if(zu)return {l:"rot",t:"Stammstrecke gesperrt",s:zu.title};
  const spaeter=fahr.slice(0,3).find(d=>endetVorher(d));
  if(spaeter)return {l:"gelb",t:`Ab ${wann(spaeter)} nicht mehr bis Marienplatz`,s:wo(spaeter)};
  if(inc.length)return {l:"gelb",t:"Störung auf der Stammstrecke",s:inc[0].title};
  return null;
}
// Pünktlichkeit neben der Überschrift und Hinweis/rote Markierung des Kastens
function showDepStatus(){
  const p=$("#dep-punkt"), z=depsFrisch()?stadtZuege().slice(0,6):[];
  p.hidden=!z.length;
  if(z.length){
    const cx=z.filter(d=>d.cancelled).length, late=Math.max(0,...z.map(d=>d.cancelled?0:d.delayInMinutes||0));
    const echt=z.some(d=>d.realtime&&!d.cancelled);   // liefert die MVG gerade Echtzeitdaten? Sonst wäre „pünktlich“ nur geraten
    p.className="punkt "+(cx?"bad":late>=5?"warn":echt?"ok":"");
    p.lastElementChild.textContent=cx?`${cx} ${cx===1?"Ausfall":"Ausfälle"}${late>=3?` · bis +${late} min`:""}`:late>=3?`bis +${late} min`:echt?"pünktlich":"laut Fahrplan";
  }
  const a=depAlarm(), el=$("#dep-alarm");
  document.querySelector(".board-deps").classList.toggle("alarm",a?.l==="rot");
  el.hidden=!a;
  if(a){el.className="dep-alarm"+(a.l==="gelb"?" gelb":"");el.innerHTML=`<span>${esc(a.t)}${a.s?`<small>${esc(a.s)}</small>`:""}</span>`;}
}
async function loadDeps(){
  try{
    // nur vollständige Einträge (Linie und Abfahrtszeit) – ein lückenhafter Eintrag stünde sonst als „NaN min“ da
    deps=(await getJSON(`${MVG}/departures?globalId=${AUBING}&limit=40&transportTypes=SBAHN`)).filter(d=>d&&d.label==="S4"&&Number.isFinite(d.realtimeDepartureTime||d.plannedDepartureTime));
    depsOk=Date.now();
    nightRefresh();
    renderDeps();
    $("#dep-stamp").textContent="Stand "+fmtT(Date.now())+" · aktualisiert alle 30 s";
  }catch(e){
    // kurzer Aussetzer: die letzten Abfahrten (höchstens 3 min alt) weiter anzeigen, abgefahrene Züge ausblenden
    if(deps.length&&Date.now()-depsOk<180000){renderDeps(true);$("#dep-stamp").textContent="Stand "+fmtT(depsOk)+" · Verbindung gestört, neuer Versuch läuft";}
    else{$("#deps").innerHTML=`<div class="empty" style="color:#9fb0c8">Abfahrten gerade nicht abrufbar (${esc(errTxt(e))}). Neuer Versuch in 30 s.</div>`;showDepStatus();}
  }
}
function renderDeps(alt){
  const now=Date.now();
  const list=deps.filter(d=>{
    if(alt&&(d.realtimeDepartureTime||d.plannedDepartureTime)<now-30000)return false;
    return !WEST.test(d.destination);
  }).slice(0,3);
  $("#deps").innerHTML=list.length?list.map(d=>{
    const t=d.realtimeDepartureTime||d.plannedDepartureTime;
    const m=Math.max(0,Math.round((t-now)/60000));
    const delay=d.delayInMinutes>0?`<small class="late">+${Math.round(d.delayInMinutes)} · plan ${fmtT(d.plannedDepartureTime)}</small>`:`<small>${fmtT(t)}</small>`;
    const info=[...(d.infos||[]).map(i=>i.message),d.sev?"Ersatzverkehr":""].filter(Boolean).join(" · ");
    const kurz=endetVorher(d)&&!d.cancelled;   // endet vor Marienplatz: Zeile rot markieren
    const sub=[kurz&&!d.sev?"nicht bis Marienplatz":"",info,!info&&d.platform?"Gl. "+d.platform:""].filter(Boolean).join(" · ");
    return `<div class="dep ${kurz?"kurz":""}"><span><span class="line ${/^[A-Z_]+$/.test(d.transportType)?d.transportType:""} l-${esc(d.label)}">${esc(d.label)}</span></span>
      <span class="dest">${esc(d.destination)}<small>${esc(sub)}</small></span>
      <span class="min ${d.cancelled?"cxl":d.delayInMinutes>0?"late":""}">${d.cancelled?"fällt aus":m===0?"jetzt":m+" min"}${d.cancelled?"":delay}</span></div>`;
  }).join(""):`<div class="empty" style="color:#9fb0c8">Keine Abfahrten in dieser Auswahl.</div>`;
  showDepStatus();
}
loadDeps();
let depTick=0;
setInterval(()=>{depTick++;const night=typeof isNight==="function"&&isNight()&&Date.now()>wakeUntil;if(!document.hidden&&(!night||depTick%4===0))loadDeps();},30000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadDeps();});

/* ---------- Störungen ---------- */
let msgs=[], msgFilter={now:!!store.get("msgFilter",{}).now};
const isS4=m=>(m.lines||[]).some(l=>l.label==="S4");
// S4-Abschnitt Aubing–Marienplatz vs. Außenäste
const SEG=/Aubing|Leienfelsstra|Pasing|Laim|Hirschgarten|Donnersbergerbr|Hackerbr|Hauptbahnhof|Karlsplatz|Stachus|Marienplatz|Stammstrecke|Westkreuz/i;
const OUTER=/Puchheim|Eichenau|F[üu]rstenfeldbruck|Buchenau|Sch[öo]ngeising|Grafrath|T[üu]rkenfeld|Geltendorf|Isartor|Rosenheimer Platz|Ostbahnhof|Leuchtenbergring|Berg am Laim|Trudering|Gronsdorf|Haar|Vaterstetten|Baldham|Zorneding|Eglharting|Kirchseeon|Grafing|Ebersberg/i;
const plain=m=>m.title+" "+String(m.description||"").replace(/<[^>]+>/g," ");
// „Berg am Laim“ und „Neuaubing“ enthalten die Namen „Laim“ bzw. „Aubing“, liegen aber nicht auf dem Abschnitt
const ohneOst=s=>String(s).replace(/Berg am Laim|Neuaubing/gi," ");
// betrifft Aubing–Marienplatz: Station im Abschnitt genannt, oder Störung ohne Ortsangabe
const onSeg=m=>SEG.test(ohneOst(plain(m)))||(m.type==="INCIDENT"&&!OUTER.test(plain(m)));
const isU=m=>(m.lines||[]).some(l=>l.transportType==="UBAHN");
const isNow=m=>{const n=Date.now();const d=m.incidentDurations?.length?m.incidentDurations:[{from:m.validFrom,to:m.validTo}];return d.some(x=>x.from<=n&&n<=(x.to||Infinity));};
const lineSet=m=>[...new Set((m.lines||[]).map(l=>l.label))];
const types=m=>new Set((m.lines||[]).map(l=>l.transportType));
function stammRelevant(m){
  if(!types(m).has("SBAHN"))return false;
  const sLines=lineSet(m).filter(l=>/^S\d/.test(l));
  return STAMM.test(ohneOst(m.title))||(sLines.length>=4&&m.type==="INCIDENT");
}
// kurzer Zeitraum für die einzeilige Liste, z. B. „13.–16.11.“, „bis 30.06.28“
function kurzZeitraum(sp,now){
  if(!sp?.from)return "";
  const y=new Date().getFullYear(), p=ms=>{const d=new Date(ms);return {d:String(d.getDate()).padStart(2,"0"),m:String(d.getMonth()+1).padStart(2,"0"),y:d.getFullYear()};};
  const a=p(sp.from), b=sp.to?p(sp.to):null, yy=x=>x.y!==y?String(x.y).slice(2):"";
  const ds=x=>`${x.d}.${x.m}.${yy(x)}`;
  if(!b)return ds(a);
  if(now)return "bis "+ds(b);
  if(a.d===b.d&&a.m===b.m&&a.y===b.y)return ds(a);
  if(a.m===b.m&&a.y===b.y)return `${a.d}.–${ds(b)}`;
  return `${ds(a)}–${ds(b)}`;
}
function msgHTML(m,offen){
  const now=isNow(m);
  const span=(m.incidentDurations?.[0])||{from:m.validFrom,to:m.validTo};
  const when=span.to?`${fmtD(span.from)} ${fmtT(span.from)} – ${fmtD(span.to)} ${fmtT(span.to)}`:"";
  const links=(m.links||[]).map(l=>`<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.text)}</a>`).join(" · ");
  return `<details class="msg" data-k="${esc(m.title)}"${offen&&offen.has(m.title)?" open":""}><summary><span class="mtags">${now?'<span class="tag now">jetzt</span>':'<span class="tag plan">geplant</span>'}${isU(m)?[...new Set(m.lines.filter(l=>l.transportType==="UBAHN").map(l=>l.label))].map(l=>`<span class="tag">${esc(l)}</span>`).join(""):stammRelevant(m)?'<span class="tag">Stamm</span>':""}</span><span class="mwhen">${esc(kurzZeitraum(span,now))}</span><span class="mt">${esc(m.title)}</span></summary>
    <div class="body"><div class="muted">${esc(when)}</div>${sauber(m.description)}${links?`<p>${links}</p>`:""}</div></details>`;
}
let msgsOk=0;
async function loadMsgs(){
  try{const neu=await getJSON(`${MVG}/messages`);if(!Array.isArray(neu))throw new Error("unerwartete Antwort");
    // lückenhafte Einträge auslassen bzw. auffüllen, damit eine einzelne kaputte Meldung nicht alle anderen verschluckt
    msgs=neu.filter(m=>m&&typeof m==="object").map(m=>({...m,title:String(m.title??""),description:String(m.description??""),lines:Array.isArray(m.lines)?m.lines.filter(l=>l&&typeof l==="object"):[]}));
    msgsOk=Date.now();renderMsgs();}
  catch(e){
    // Aussetzer: vorhandene Meldungen stehen lassen; nach 10 min ohne Daten zählen sie nicht mehr für den Hinweis im Abfahrtskasten
    if(!msgs.length){$("#msgs").innerHTML=$("#umsgs").innerHTML=`<div class="empty">Störungsmeldungen nicht abrufbar (${esc(errTxt(e))}).</div>`;msgsHtml="";}
    showDepStatus();
  }
}
// Meldungstexte der MVG enthalten HTML. Übernommen werden nur ausdrücklich erlaubte Bausteine (Positivliste), neu aufgebaut
// ohne jedes Attribut außer geprüften http(s)-Links; alles andere wird zu reinem Text bzw. entfällt.
const SAN_OK=new Set(["A","B","STRONG","I","EM","U","P","BR","UL","OL","LI","DIV","SPAN","H3","H4","H5","H6","SMALL","SUB","SUP","TABLE","THEAD","TBODY","TR","TD","TH"]);
const SAN_WEG=new Set(["SCRIPT","STYLE","TEMPLATE","NOSCRIPT","IFRAME","OBJECT","EMBED","TITLE","TEXTAREA","SELECT","HEAD"]);
function sanKopie(src,dst){for(const n of src.childNodes){
  if(n.nodeType===3){dst.appendChild(document.createTextNode(n.data));continue;}
  if(n.nodeType!==1||n.namespaceURI!=="http://www.w3.org/1999/xhtml"||SAN_WEG.has(n.tagName))continue;
  if(!SAN_OK.has(n.tagName)){sanKopie(n,dst);continue;}
  const e=document.createElement(n.tagName);
  if(n.tagName==="A"){const h=n.getAttribute("href")||"";if(/^https?:\/\//i.test(h)){e.setAttribute("href",h);e.setAttribute("target","_blank");e.setAttribute("rel","noopener noreferrer");}}
  sanKopie(n,e);dst.appendChild(e);}}
function sanitize(html){const t=document.createElement("template");t.innerHTML=String(html??"");const out=document.createElement("div");sanKopie(t.content,out);return out.innerHTML;}
// bereinigt wird nur, was auch angezeigt wird (etwa zehn von über zweihundert Meldungen), und je Text nur einmal
const sauberMerk=new Map();
function sauber(html){const h=String(html??"");let c=sauberMerk.get(h);if(c==null){if(sauberMerk.size>300)sauberMerk.clear();c=sanitize(h);sauberMerk.set(h,c);}return c;}
function renderMsgs(){
  document.querySelectorAll("#msg-filter .chip").forEach(b=>b.setAttribute("aria-pressed",!!msgFilter[b.dataset.t]));
  showDepStatus();   // Störung auf der Stammstrecke erscheint als Hinweis im Abfahrtskasten
  // Liste
  const seen=new Set();
  const list=msgs.filter(m=>{
    if(!isS4(m)||!onSeg(m))return false;
    if(msgFilter.now&&!isNow(m))return false;
    const key=m.title;if(seen.has(key))return false;seen.add(key);   // Doppelte erst nach dem Filtern entfernen
    return true;
  });
  const st0=m=>(m.incidentDurations?.[0]?.from)||m.validFrom;
  list.sort((a,b)=>(isNow(b)-isNow(a))||(st0(a)-st0(b)));
  // U-Bahn: nur laufende Störungen (Liveticker), keine geplanten Baustellen
  const useen=new Set();
  const ul=msgs.filter(m=>isU(m)&&m.type==="INCIDENT"&&isNow(m)&&!useen.has(m.title)&&useen.add(m.title))
    .sort((a,b)=>b.publication-a.publication);
  // unverändert? Dann nichts anfassen (sonst klappt eine gerade gelesene Meldung alle 2 min zu); aufgeklappte bleiben offen
  const sg=m=>m.title+isNow(m)+(m.description||"")+((m.incidentDurations?.[0]?.to)||m.validTo||"");
  const sig=list.map(sg).join("|")+"#"+ul.map(sg).join("|")+"#"+!!msgFilter.now;
  if(sig===msgsHtml)return;
  msgsHtml=sig;
  const offen=new Set([...document.querySelectorAll("#msgs details[open],#umsgs details[open]")].map(d=>d.dataset.k));
  $("#msgs").className="";
  $("#msgs").innerHTML=list.length?`<p class="muted" style="margin:0 0 6px">${list.length} Meldungen zwischen Aubing und Marienplatz · antippen für Details</p>`+list.map(m=>msgHTML(m,offen)).join(""):'<div class="empty">Keine Meldungen zwischen Aubing und Marienplatz.</div>';
  $("#umsgs").className="";
  $("#umsgs").innerHTML=ul.length?ul.map(m=>msgHTML(m,offen)).join(""):'<div class="empty">Keine aktuellen U-Bahn-Störungen.</div>';
}
let msgsHtml="";
document.querySelectorAll("#msg-filter .chip").forEach(b=>b.onclick=()=>{msgFilter[b.dataset.t]=!msgFilter[b.dataset.t];store.set("msgFilter",msgFilter);renderMsgs();});
loadMsgs();let msgTick=0;
setInterval(()=>{msgTick++;const night=typeof isNight==="function"&&isNight()&&Date.now()>wakeUntil;if(!document.hidden&&(!night||msgTick%4===0))loadMsgs();},120000);

/* ---------- Merkliste ---------- */
let keywords=store.get("keywords",["Harry Potter"]);
const kwRe=()=>keywords.length?new RegExp(keywords.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|"),"i"):null;
function renderKw(){
  $("#kw-list").innerHTML=keywords.map((k,i)=>`<span class="chip kw" aria-pressed="true">${esc(k)}<button type="button" data-i="${i}" aria-label="${esc(k)} entfernen">×</button></span>`).join("")||'<span class="empty">Noch keine Stichwörter.</span>';
  $("#kw-list").querySelectorAll("button").forEach(b=>b.onclick=()=>{keywords.splice(+b.dataset.i,1);store.set("keywords",keywords);renderKw();renderEvents();renderFilms();});
  renderHits();
}
$("#kw-form").onsubmit=e=>{e.preventDefault();const v=$("#kw-input").value.trim();if(v&&!keywords.includes(v)){keywords.push(v);store.set("keywords",keywords);}$("#kw-input").value="";renderKw();renderEvents();renderFilms();};
function renderHits(){
  const re=kwRe();const hits=[];
  if(re){
    events.filter(e=>re.test(e.title)).forEach(e=>hits.push(`<div class="ev hit">${evDate(e)}<div><a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a><div class="muted">${esc(e.location)} · ${esc(e.source)}</div></div></div>`));
    Object.entries(cinemaCache).forEach(([id,c])=>c.movies.filter(m=>re.test(m.title)).forEach(m=>hits.push(`<div class="ev hit"><div class="date"><b>🎬</b></div><div><a href="#kino" data-c="${esc(id)}">${esc(m.title)}</a><div class="muted">${esc(c.name)}</div></div></div>`)));
  }
  $("#kw-hits").innerHTML=hits.length?hits.join(""):(re?'<div class="empty">Aktuell keine Treffer. Die Liste wird mehrmals täglich aktualisiert.</div>':"");
  $("#kw-hits").querySelectorAll("a[data-c]").forEach(a=>a.onclick=()=>kinoWahl(a.dataset.c));
  const p=$("#pill-watch");p.hidden=!hits.length;if(hits.length)setPill(p,"warn",`Merkliste: ${hits.length}`);
}

/* ---------- Events ---------- */
let events=[], evFilter=store.get("evFilter","woche");
const MON=["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
// Datum links: bei laufenden Events der Tag im gewählten Zeitraum (sonst heute), nicht der längst vergangene Starttag
function evShownDay(e){if(!e.start)return null;const rg=typeof evRange==="function"?evRange():null;const ab=rg?rg[0]:berlinDay();return e.start<ab&&(e.end||e.start)>=ab?ab:e.start;}
function evDate(e){const t=evShownDay(e);if(!t||!/^\d{4}-\d{2}-\d{2}$/.test(t))return '<div class="date"><span>offen</span></div>';const [y,m,d]=t.split("-");return `<div class="date"><b>${d}</b><span>${MON[+m-1]} ${y.slice(2)}</span></div>`;}
let baseSeen=0;
// Vorverkauf: Zeitpunkt (Europe/Berlin, ohne Zone aus Ticketmaster als UTC geliefert)
const presaleTs=e=>e.presale?Date.parse(e.presale+(e.presale.length===16?":00Z":"")):NaN;
function presaleTxt(e){const t=presaleTs(e);if(isNaN(t))return "";return t>Date.now()?"VVK ab "+new Date(t).toLocaleString("de-DE",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"}):"";}
const isNew=e=>e.tag!=="woche"&&Date.parse(e.firstSeen)>baseSeen+864e5&&Date.now()-Date.parse(e.firstSeen)<14*864e5;
async function loadEvents(){
  try{const d=await getJSON("data/events.json");if(!Array.isArray(d.events))throw new Error("unerwartete Antwort");
    events=d.events.filter(e=>e&&typeof e.title==="string"&&typeof e.tag==="string");baseSeen=Math.min(...events.map(e=>Date.parse(e.firstSeen)));
    const s=Object.entries(d.sources||{}).map(([k,v])=>`${k} ${v.ok?"✓":"✗"}`).join(" · ");
    $("#ev-stamp").textContent=`Stand ${new Date(d.updated).toLocaleString("de-DE",{timeZone:"Europe/Berlin"})} · ${s}`;
    renderEvents();renderHits();renderKev();
  }catch(e){if(!events.length){$("#ev-list").innerHTML=`<div class="empty">Events nicht geladen (${esc(errTxt(e))}).</div>`;}}
}
function renderEvents(){
  renderKev();
  document.querySelectorAll("#ev-filter .chip").forEach(b=>b.setAttribute("aria-pressed",b.dataset.f===evFilter));
  const re=kwRe();
  let list=evFilter==="vvkbald"
    ? events.filter(e=>presaleTs(e)>Date.now()).sort((a,b)=>presaleTs(a)-presaleTs(b))
    : events.filter(e=>evFilter==="neu"?isNew(e):e.tag.split(",").includes(evFilter));
  const rg=evRange();
  if(rg)list=list.filter(e=>e.start&&e.start<=rg[1]&&(e.end||e.start)>=rg[0]);
  $("#ev-count").textContent=rg?`${list.length} ${list.length===1?"Event":"Events"}`:"";
  $("#ev-list").innerHTML=list.length?list.map(e=>`<div class="ev ${re&&re.test(e.title)?"hit":""}">${evDate(e)}<div style="min-width:0">
    <a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a> ${isNew(e)?'<span class="tag new">neu</span>':""}${e.cancelled?' <span class="tag now">abgesagt</span>':""}${presaleTxt(e)?` <span class="tag plan">${esc(presaleTxt(e))}</span>`:""}
    <div class="muted">${esc([e.when,e.location].filter(Boolean).join(" · "))}${e.end&&e.end!==e.start?` · bis ${esc(e.end.split("-").reverse().join("."))}`:""} · ${esc(e.source)}</div></div></div>`).join("")
    :`<div class="empty">${evFilter==="neu"?"Keine neu angekündigten Events in den letzten 14 Tagen.":evFilter==="vvkbald"?"Kein bekannter VVK-Start in nächster Zeit (Quelle: Ticketmaster).":"Keine Einträge."}</div>`;
}
document.querySelectorAll("#ev-filter .chip").forEach(b=>b.onclick=()=>{evFilter=b.dataset.f;store.set("evFilter",evFilter);renderEvents();});
// Datumsfilter: Zeitraum als [von, bis] (JJJJ-MM-TT) oder null
function evRange(){
  const w=$("#ev-when").value, d0=berlinDay();
  if(w==="alle")return null;
  if(w==="heute")return [d0,d0];
  if(w==="morgen"){const d=berlinDay(1);return [d,d];}
  if(w==="7")return [d0,berlinDay(6)];
  if(w==="30")return [d0,berlinDay(29)];
  if(w==="we"){const wd=new Date(d0+"T12:00:00").getDay();const sa=wd===0?-1:wd===6?0:6-wd;return [wd===0?d0:berlinDay(sa),berlinDay(sa+1)];}
  if(w==="tag"){const v=$("#ev-day").value||d0;return [v,v];}
  return null;
}
(()=>{const w=$("#ev-when"),d=$("#ev-day");
  w.value=store.get("evWhen","alle");if(!w.value)w.value="alle";d.value=store.get("evDay","")||berlinDay();d.hidden=w.value!=="tag";
  w.onchange=()=>{store.set("evWhen",w.value);d.hidden=w.value!=="tag";if(w.value==="tag"&&!d.value)d.value=berlinDay();renderEvents();};
  // iPad: Auswahl im Kalender sofort übernehmen (input), alter gespeicherter Tag wird auf heute gesetzt
  if(d.value<berlinDay())d.value=berlinDay();
  d.oninput=d.onchange=()=>{store.set("evDay",d.value);renderEvents();};})();

function renderKev(){
  const re=kwRe(), hit=t=>re&&re.test(t)?"hit":"";
  // Konzerte: erst seit dem letzten Abgleich neu aufgetauchte (inkl. Neu im VVK)
  const conc=events.filter(e=>isNew(e)&&/konzert|vvk|show/.test(e.tag)).sort((a,b)=>Date.parse(b.firstSeen)-Date.parse(a.firstSeen)).slice(0,8);
  // Filme: Kinostart in den letzten 7 Tagen oder demnächst, aus beiden Kinos
  const now=Date.now(), films={};
  Object.entries(cinemaCache).forEach(([id,c])=>c.movies.forEach(m=>{
    const r=Date.parse(m.release_date);
    if(!(r>now-7*864e5&&r<now+21*864e5))return;
    const f=(films[m.id]??={m,where:new Set(),ids:new Set()});f.where.add(c.name.replace(/ Filmpalast| Germering/,""));f.ids.add(id);
  }));
  // gerade gestartete und unmittelbar bevorstehende Filme zuerst (statt: der fernste Starttermin zuerst)
  const nah=x=>Math.abs(Date.parse(x.m.release_date)-now);
  const fl=Object.values(films).sort((a,b)=>nah(a)-nah(b)).slice(0,6);
  const fdate=iso=>{const r=Date.parse(iso);return r>now?"Start "+new Date(r).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit"}):"seit "+new Date(r).toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit"});};
  const loaded=Object.keys(cinemaCache).length;
  $("#kev").innerHTML=`<h3>Konzerte</h3>`+(conc.length?conc.map(e=>`<a class="kev-item ${hit(e.title)}" href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer"><span class="tag new">neu</span> ${esc(e.title)}<div class="muted" style="font-weight:400">${esc([e.start?e.start.split("-").reverse().join("."):"",e.location,presaleTxt(e)].filter(Boolean).join(" · "))}</div></a>`).join("")
      :`<div class="empty">Seit dem letzten Abgleich nichts Neues. Neue Ankündigungen erscheinen hier 14 Tage lang.</div>`)
    +`<h3>Neu im Kino</h3>`+(fl.length?fl.map(({m,where,ids})=>`<a class="kev-item film-n ${hit(m.title)}" href="#kino" data-c="${esc(ids.has(cinema)?cinema:[...ids][0])}">${/^https:\/\//i.test(m.media?.poster_url||"")?`<img src="${esc(m.media.poster_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:"<span></span>"}<span style="min-width:0">${esc(m.title)}<div class="muted" style="font-weight:400">${esc(fdate(m.release_date))} · ${esc([...where].join(", "))}</div></span></a>`).join("")
      :`<div class="empty">${loaded?"Keine neuen Filmstarts.":"Lade Kinoprogramm…"}</div>`);
  $("#kev").querySelectorAll("a[data-c]").forEach(a=>a.onclick=()=>kinoWahl(a.dataset.c));
}
// Bilder, die sich nicht laden lassen (Plakate), unsichtbar machen statt ein Platzhalter-Symbol zu zeigen
document.addEventListener("error",e=>{const t=e.target;if(t&&t.tagName==="IMG"&&t.closest("#films,#kev"))t.style.visibility="hidden";},true);

/* ---------- Kino ---------- */
let cinema=store.get("cinema","3209"), day=null; const cinemaCache={};
if(!["3209","1081"].includes(cinema))cinema="3209";
// Antwort des Kinoprogramms nur übernehmen, wenn sie die erwartete Form hat
const kinoOk=d=>{if(!Array.isArray(d?.movies)||!Array.isArray(d?.showtimes))throw new Error("unerwartete Antwort");return d;};
// Treffer aus Merkliste/„Neu im Kino“ öffnet das Kino, in dem der Film läuft
function kinoWahl(id){if(!["3209","1081"].includes(id))return;cinema=id;store.set("cinema",cinema);if(location.hash==="#kino")loadCinema(cinema);}
function dayKey(iso){return new Date(iso).toLocaleDateString("sv-SE",{timeZone:"Europe/Berlin"});}
async function loadCinema(id){
  if(!cinemaCache[id]){
    $("#films").innerHTML='<div class="empty">Lade Programm…</div>';
    try{cinemaCache[id]=kinoOk(await getJSON(KINO+id+"/"));}
    catch(e){$("#films").innerHTML=`<div class="empty">Programm nicht abrufbar (${esc(errTxt(e))}).</div>`;return;}
  }
  renderFilms();renderHits();
}
/* Preise für Premium-Sitze
   Mathäser: berechnet in scripts/fetch_kino.py (Programm + Preisliste des Kinos), hier nur zugeordnet.
   Cineplex Germering: feste Online-Preisliste (Stand November 2026); die Website lässt sich nicht automatisch lesen. */
const GER={erw:10,recliner:5.5,sofa:3,ueber:m=>m>=181?3:m>=151?2:m>=121?1:0,rabattTag:2,rabatt:.5,min:5};   // rabattTag 2 = Dienstag (Best Price Day mit Cineplex PLUS)
const eur=v=>Number(v).toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2})+" €";
const berlinWochentag=iso=>new Date(dayKey(iso)+"T12:00:00").getDay();
let kinoPreise=null, kinoIdx=null;
function loadKinoPreise(){getJSON("data/kino.json").then(x=>{kinoPreise=x;kinoIdx=null;renderFilms();}).catch(()=>{});}
const K_STOP=new Set(["der","die","das","the","und","and","ov","omu","3d","in","a","of"]);
const kNorm=t=>(t||"").toLowerCase().replace(/ß/g,"ss").replace(/\(.*?\)/g," ").replace(/[^a-z0-9äöü ]+/g," ").split(" ").filter(w=>w&&!K_STOP.has(w));
function kAehn(a,b){const A=new Set(kNorm(a)),B=new Set(kNorm(b));if(!A.size||!B.size)return 0;let n=0;A.forEach(w=>{if(B.has(w))n++;});return n/Math.min(A.size,B.size);}
// Vorstellung der Mathäser-Seite zu Film und Uhrzeit finden (gleicher Tag, gleiche Uhrzeit, ähnlichster Titel).
// Laufen zwei Fassungen desselben Films zur selben Minute, entscheidet die Sprachfassung (Original oder deutsch).
function matVorstellung(titel,iso,ver){
  if(!Array.isArray(kinoPreise?.mathaeser))return null;
  if(!kinoIdx){kinoIdx={};kinoPreise.mathaeser.forEach(x=>(kinoIdx[x.d+"|"+x.z]??=[]).push(x));}
  const orig=v=>(v||[]).some(s=>/^(ov|omu)$/i.test(s)), of=orig(ver);
  let best=null,sc=0;
  (kinoIdx[dayKey(iso)+"|"+fmtT(Date.parse(iso))]||[]).forEach(x=>{let v=Math.max(kAehn(titel,x.t),kAehn(titel,x.o));if(v>=0.5&&orig(x.v)===of)v+=.01;if(v>sc){sc=v;best=x;}});
  return sc>=0.5?best:null;
}
// Preisangabe für eine Vorstellung: {p Preis, k klein gedruckter Zusatz, g günstiger, weg ausblenden (3D)}
function kinoPreis(m,s){
  if(/\b3D\b/i.test((s.version||[]).join(" ")+" "+(m.title||"")))return {weg:true};
  if(cinema==="1081"){
    const x=matVorstellung(m.title,s.showtime,s.version);
    if(!x)return {p:null,k:kinoPreise?"Preis offen":""};
    if(x.a==="3d")return {weg:true};
    const saal=/k6/i.test(x.s)?" · Kino 6":"";
    if(x.a==="sonder")return {p:x.p,ab:true,k:"Sonderpreis",saal:x.s};
    if(x.a==="dolby")return {p:x.p,k:x.g+" · Dolby, ohne Premium",g:x.b,saal:x.s};
    if(x.a==="normal")return {p:x.p,k:x.g+" · ohne Premium",g:x.b,saal:x.s};
    return {p:x.p,k:x.g+saal,g:x.b,saal:x.s};
  }
  const dauer=m.duration||0, basis=GER.erw+GER.ueber(dauer), di=berlinWochentag(s.showtime)===GER.rabattTag, f=v=>di?Math.max(GER.min,v*GER.rabatt):v;
  return {p:f(basis+GER.recliner),ab:!dauer,k:`Recliner\nSofa ${eur(f(basis+GER.sofa))}`+(dauer?"":"\nLaufzeit offen, ggf. + Überlänge"),g:di};
}
function renderFilms(){
  document.querySelectorAll("#cinema-pick .chip").forEach(b=>b.setAttribute("aria-pressed",b.dataset.c===cinema));
  const c=cinemaCache[cinema];if(!c)return;
  const days=[...new Set(c.showtimes.map(s=>dayKey(s.showtime)))].sort().slice(0,8);
  if(!days.includes(day))day=days[0];
  const today=dayKey(new Date().toISOString());
  $("#day-pick").innerHTML=days.map(d=>{const dt=new Date(d+"T12:00:00");const lbl=d===today?"Heute":dt.toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit"});
    const kt=cinema==="3209"&&dt.getDay()===GER.rabattTag;   // Kinotag in Germering
    return `<button class="chip ${kt?"kt":""}" data-d="${d}" aria-pressed="${d===day}" ${kt?'title="Best Price Day: −50 % mit Cineplex PLUS"':""}>${lbl}${kt?" · −50 %":""}</button>`;}).join("");
  $("#day-pick").querySelectorAll(".chip").forEach(b=>b.onclick=()=>{day=b.dataset.d;renderFilms();});
  const movies=Object.fromEntries(c.movies.map(m=>[m.id,m]));
  const by={};c.showtimes.filter(s=>dayKey(s.showtime)===day).forEach(s=>(by[s.movie.id]??=[]).push(s));
  const re=kwRe();const now=Date.now();
  const rows=Object.entries(by).map(([id,st])=>({m:movies[id]||{title:"Unbekannter Film"},st:st.sort((a,b)=>a.showtime.localeCompare(b.showtime))}))
    .sort((a,b)=>a.m.title.localeCompare(b.m.title,"de"));
  // je Film: Vorstellungen nach Preis gruppieren (günstigster zuerst), 3D-Vorstellungen fallen weg
  const karten=rows.map(({m,st})=>{
    const gr=new Map();
    st.forEach(s=>{const pi=kinoPreis(m,s);if(pi.weg)return;
      const key=[pi.p,pi.k,pi.g?1:0,pi.ab?1:0].join("|");
      if(!gr.has(key))gr.set(key,{pi,st:[]});gr.get(key).st.push({s,pi});});
    const gruppen=[...gr.values()].sort((a,b)=>(a.pi.p??1e9)-(b.pi.p??1e9));
    if(!gruppen.length)return "";
    return `<div class="film ${re&&re.test(m.title)?"hit":""}">
    ${/^https:\/\//i.test(m.media?.poster_url||"")?`<img src="${esc(m.media.poster_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:"<span></span>"}
    <div style="min-width:0"><strong>${esc(m.title)}</strong>
      <div class="muted">${esc([m.genres?.names?.join(", "),m.duration?m.duration+" min":"",m.fsk!=null?"FSK "+m.fsk:""].filter(Boolean).join(" · "))}</div></div>
    <div class="fp">${gruppen.map(({pi,st})=>`<div class="pg ${pi.g?"g":""}"><span class="pr">${pi.p!=null?(pi.ab?"ab ":"")+eur(pi.p):"–"}${pi.k?`<small>${esc(pi.k).replace(/\n/g,"<br>")}</small>`:""}</span>
      <span class="times">${st.map(({s,pi})=>`<a class="${Date.parse(s.showtime)<now?"past":""}" href="${esc(safeUrl(s.ticket_purchase_url))}" target="_blank" rel="noopener noreferrer" title="${esc([pi.saal,...(s.version||[])].filter(Boolean).join(", "))}">${fmtT(Date.parse(s.showtime))}${(s.version||[]).length?`<i>${esc(s.version.join("/"))}</i>`:""}</a>`).join("")}</span></div>`).join("")}</div></div>`;
  }).filter(Boolean);
  const hinweis=cinema==="1081"
    ?(kinoPreise?`Preise für den <b>Premium-Sessel</b>, berechnet aus Programm und Preisliste des Kinos (Stand ${new Date(kinoPreise.stand).toLocaleString("de-DE",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Berlin"})}). Grün = günstiger als der Abendpreis des Tages. 3D ist ausgeblendet. Der genaue Preis steht beim Ticketkauf.`:"Preise werden geladen …")
    :`Preise für den <b>Premium-Recliner</b> (Sofa klein daneben) laut Online-Preisliste: ${eur(GER.erw)} + Überlänge + Sitz. Nicht enthalten: Saalzuschlag Ultimate Studio (+2 €) bzw. ICE (+5 €). <b>Dienstag −50 %</b> mit Cineplex PLUS.`;
  $("#films").innerHTML=karten.length?`<p class="muted kino-hinweis">${hinweis}</p>`+karten.join(""):'<div class="empty">Keine Vorstellungen an diesem Tag.</div>';
}
document.querySelectorAll("#cinema-pick .chip").forEach(b=>b.onclick=()=>{cinema=b.dataset.c;store.set("cinema",cinema);loadCinema(cinema);});

/* ---------- Reiter ---------- */
function route(){
  const v=["live","kino","events"].includes(location.hash.slice(1))?location.hash.slice(1):"live";
  document.querySelectorAll("section[data-view]").forEach(s=>s.hidden=s.dataset.view!==v);
  document.querySelectorAll(".tabs a").forEach(a=>a.setAttribute("aria-current",a.getAttribute("href")==="#"+v?"page":"false"));
  if(v==="kino")loadCinema(cinema);
}
addEventListener("hashchange",route);route();
renderKw();loadEvents();
// beide Kinos im Hintergrund laden, damit die Merkliste Filme findet
function loadCinemas(){["3209","1081"].forEach(id=>getJSON(KINO+id+"/").then(d=>{cinemaCache[id]=kinoOk(d);renderHits();renderKev();if(id===cinema)renderFilms();}).catch(()=>{}));}
loadCinemas();loadKinoPreise();

/* ---------- Dauerbetrieb (iPad an der Wand) ---------- */
// Events, Kino, Pollen und Ferien stündlich neu laden; fehlgeschlagene Abrufe behalten die alten Daten
setInterval(()=>{loadEvents();loadCinemas();loadKinoPreise();loadPollen();loadFerien();},60*60000);
// Uhrzeit-Wechsel: nach Mitternacht Kino-Tag neu wählen
let lastDay=dayKey(new Date().toISOString());
setInterval(()=>{const d=dayKey(new Date().toISOString());if(d!==lastDay){lastDay=d;day=null;renderFilms();}},60000);
// Seite aktuell halten, ohne dass die Wand-Anzeige je leer bleibt:
// – neu geladen wird nur, wenn die Seite gerade erreichbar ist (sonst stünde bei einem WLAN-Aussetzer eine Fehlerseite da)
// – stündlich wird geprüft, ob eine neue Version online ist; dann lädt die Seite neu, sobald 2 min niemand bedient hat
// – unabhängig davon einmal nachts um 3:30
let pageSig=null, pageNeu=false, lastTouch=0;
// jede Berührung zählt als Bedienung; in der Nacht verlängert sie außerdem die helle Phase um 2 Minuten
addEventListener("pointerdown",()=>{lastTouch=Date.now();if(wakeUntil>lastTouch)wakeUntil=lastTouch+2*60000;},{passive:true,capture:true});
const sigOf=t=>{let h=0;for(let i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))|0;return t.length+":"+h;};
async function pageText(){const r=await fetchT(location.pathname,{cache:"no-store"});if(!r.ok)throw new Error(r.status);return r.text();}
const inBedienung=()=>Date.now()-lastTouch<120000||/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName||"")
  ||Object.keys(heatPending).length>0||Object.keys(lichtBusy).length>0||!$("#toast").hidden||!$("#wlan").hidden||!$("#dienste").hidden;
async function checkVersion(){
  try{const sig=sigOf(await pageText());
    if(pageSig===null)pageSig=sig;else if(sig!==pageSig)pageNeu=true;
    if(pageNeu&&!inBedienung())location.reload();
  }catch{}
}
setTimeout(checkVersion,20000);
setInterval(checkVersion,60*60000);
setInterval(()=>{if(pageNeu)checkVersion();},60000);   // steht eine neue Version an: jede Minute erneut, bis niemand mehr bedient
(function scheduleReload(){
  const now=new Date();
  const berlin=new Date(now.toLocaleString("en-US",{timeZone:"Europe/Berlin"}));
  const next=new Date(berlin);next.setHours(3,30,0,0);if(next<=berlin)next.setDate(next.getDate()+1);
  const versuch=async()=>{try{await pageText();location.reload();}catch{setTimeout(versuch,10*60000);}};   // offline: alle 10 min erneut
  setTimeout(versuch,next-berlin);
})();
// Nachts abdunkeln (23:00–5:30). Antippen zeigt die Seite 2 Minuten hell.
const NIGHT_FROM=23*60, NIGHT_TO=5*60+30;
let wakeUntil=0;
function berlinMinutes(){const p=new Date().toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Europe/Berlin"}).split(":");return +p[0]*60+ +p[1];}
const isNight=()=>{const m=berlinMinutes();return m>=NIGHT_FROM||m<NIGHT_TO;};
function updateNight(){const on=isNight()&&Date.now()>wakeUntil;
  if(on&&$("#night").hidden&&!$("#skinpop").hidden)skinPop(false);   // eine offen gelassene Design-Auswahl stünde sonst über der Nachtanzeige
  $("#night").hidden=!on;if(on)renderNight();}
// Aufwecken mit „click“ (beim Loslassen): So landet das Antippen sicher auf der Nachtanzeige und nicht auf einem
// Knopf darunter (Licht, Heizung, Futter). Danach sofort frische Abfahrten holen.
$("#night").addEventListener("click",()=>{wakeUntil=Date.now()+2*60000;updateNight();if(typeof loadDeps==="function")loadDeps();});
// Nachtanzeige: Uhr, Wetter, nächste S4, nächster Dienst – gedimmt
function nightRefresh(){const n=document.getElementById("night");if(n&&!n.hidden)renderNight();}
// Futter & Katzenklo: Zeitpunkte im Lichtdienst (gleicher Stand auf allen Geräten), orange nach 12 h bzw. 24 h
const PET_DUE={futter:24,klo:24}, PET_GRR=30, PET_FX={futter:["🐟","❤️","🐟","✨","❤️","🐾"],klo:["✨","🫧","✨","🐾","🫧","✨"]};
let petData=null, toastTimer=null;
function petAgo(t){if(!t)return "–";const m=Math.max(0,Math.round((Date.now()-t)/60000));
  if(m<1)return "jetzt";if(m<60)return m+" min";const h=Math.floor(m/60);if(h<3)return `${h} h ${String(m%60).padStart(2,"0")}`;if(h<48)return h+" h";return Math.floor(h/24)+" Tg";}
// ab 30 h ohne Eintrag: großer verärgerter Kater; Antippen schließt ihn für 3 h (pro Gerät), nie nachts
const GRR_KEY="grrPause";
function grrCheck(){
  const g=$("#grr");if(!petData||!lichtUrl||!store.get(LICHT_KEY,"")){g.hidden=true;return;}
  const over=["futter","klo"].filter(a=>petData[a]&&Date.now()-petData[a]>PET_GRR*3600e3);
  const night=typeof isNight==="function"&&isNight()&&Date.now()>wakeUntil;
  if(!over.length||night||Date.now()<store.get(GRR_KEY,0)){g.hidden=true;return;}
  const h=a=>Math.floor((Date.now()-petData[a])/3600e3);
  $("#grr-t").textContent=over[0]==="futter"?"Hunger!":"Klo!";
  $("#grr-s").innerHTML=over.map(a=>a==="futter"?`Seit ${h(a)} Stunden kein Futter.`:`Klo seit ${h(a)} Stunden nicht gereinigt.`).join("<br>");
  $("#grr-acts").innerHTML=over.map(a=>`<button type="button" data-art="${a}">${a==="futter"?"🍽️ Jetzt gefüttert":"🧹 Jetzt gereinigt"}</button>`).join("");
  $("#grr-acts").querySelectorAll("button").forEach(b=>b.onclick=e=>{e.stopPropagation();g.hidden=true;document.querySelector(`.petb[data-art="${b.dataset.art}"]`)?.click();});
  g.hidden=false;
}
$("#grr").addEventListener("click",()=>{store.set(GRR_KEY,Date.now()+3*3600e3);$("#grr").hidden=true;});
function renderPet(){
  const box=$("#pet");const ok=!!(lichtUrl&&store.get(LICHT_KEY,"")&&petData);box.hidden=!ok;
  $("#pill-wlan").hidden=!(ok&&petData.wlan);   // WLAN-Knopf nur, wenn im Lichtdienst ein Gäste-WLAN hinterlegt ist
  if(!ok)return;
  box.querySelectorAll(".petb").forEach(b=>{const a=b.dataset.art,t=petData[a];
    b.querySelector("small").textContent=petAgo(t);b.classList.toggle("due",!t||Date.now()-t>PET_DUE[a]*3600e3);
    b.title=(a==="futter"?"Zuletzt gefüttert":"Klo zuletzt gereinigt")+(t?": "+new Date(t).toLocaleString("de-DE",{weekday:"short",hour:"2-digit",minute:"2-digit"}):": noch nie");});
  grrCheck();
}
async function loadPet(){
  if(!lichtUrl){try{lichtUrl=(await getJSON("data/licht.json")).url||null;}catch{}}
  if(!lichtUrl||!store.get(LICHT_KEY,"")){renderPet();return;}
  try{petData=await lichtCall("/kater");}catch{}
  renderPet();
}
function petBurst(b,art){
  const r=b.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
  PET_FX[art].forEach((e,i)=>{const s=document.createElement("span");s.className="petfx";s.textContent=e;
    const ang=-Math.PI/2+(i-2.5)*0.42+(Math.random()-.5)*.3, dist=46+Math.random()*30;
    s.style.cssText=`left:${cx}px;top:${cy}px;--dx:${Math.cos(ang)*dist}px;--dy:${Math.sin(ang)*dist+18}px;--rot:${(Math.random()-.5)*60}deg;animation-delay:${i*35}ms`;
    document.body.appendChild(s);setTimeout(()=>s.remove(),1200);});
}
function toast(text,undo){
  $("#toast-t").textContent=text;$("#toast").hidden=false;clearTimeout(toastTimer);
  $("#toast-undo").hidden=!undo;$("#toast-undo").onclick=async()=>{$("#toast").hidden=true;try{await undo();}catch(e){toast("Rückgängig nicht gespeichert: "+errTxt(e));}};
  toastTimer=setTimeout(()=>{$("#toast").hidden=true;},10000);
}
const petBusy={};   // ein zweiter Tipp innerhalb von 3 s würde den Wert für „Rückgängig“ überschreiben
document.querySelectorAll(".petb").forEach(b=>b.onclick=async()=>{
  const art=b.dataset.art;if(petBusy[art])return;petBusy[art]=true;setTimeout(()=>{petBusy[art]=false;},3000);
  b.classList.remove("pop");void b.offsetWidth;b.classList.add("pop");petBurst(b,art);
  if(navigator.vibrate)navigator.vibrate(20);
  try{petData=await lichtCall("/kater",{art});renderPet();
    toast(`${art==="futter"?"Gefüttert":"Klo gereinigt"} um ${fmtT(Date.now())}`,async()=>{petData=await lichtCall("/kater",{art,zurueck:true});renderPet();});}
  catch(e){toast("Nicht gespeichert: "+errTxt(e));}
});
setTimeout(loadPet,1200);setInterval(()=>{if(!document.hidden)renderPet();},30000);setInterval(()=>{if(!document.hidden)loadPet();},5*60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadPet();});

/* Gäste-WLAN: Die Zugangsdaten liegen nur im Lichtdienst (hinter dem Licht-Passwort) und werden erst beim Antippen geholt.
   Der QR-Code entsteht hier im Browser (lib/qrcode.js, MIT-Lizenz) – nichts geht an einen fremden Dienst. */
let wlanTimer=null;
const wlanText=w=>{const e=t=>String(t).replace(/([\\;,:"])/g,"\\$1");return `WIFI:T:${w.typ||"WPA"};S:${e(w.ssid)};P:${e(w.pass)};;`;};
const ladeSkript=src=>new Promise((ok,nein)=>{if(window.qrcode)return ok();const t=document.createElement("script");t.src=src;t.onload=ok;t.onerror=()=>nein(new Error("QR-Programm nicht geladen"));document.head.appendChild(t);});
function qrSvg(text){
  qrcode.stringToBytes=qrcode.stringToBytesFuncs["UTF-8"];
  const q=qrcode(0,"M");q.addData(text);q.make();
  const n=q.getModuleCount(), r=4;let d="";
  for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(q.isDark(y,x))d+=`M${x+r} ${y+r}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n+2*r} ${n+2*r}" shape-rendering="crispEdges" role="img" aria-label="QR-Code für das WLAN"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
function wlanZu(){$("#wlan").hidden=true;$("#wlan-qr").innerHTML="";$("#wlan-pw").textContent="";$("#wlan-name").textContent="";clearTimeout(wlanTimer);}
async function wlanZeigen(){
  try{
    const [w]=await Promise.all([lichtCall("/wlan"),ladeSkript("lib/qrcode.js")]);
    $("#wlan-qr").innerHTML=qrSvg(wlanText(w));
    $("#wlan-name").textContent=w.ssid;$("#wlan-pw").textContent=w.pass;$("#wlan-pw").hidden=true;$("#wlan-zeig").hidden=false;
    $("#wlan").hidden=false;clearTimeout(wlanTimer);wlanTimer=setTimeout(wlanZu,3*60000);   // schließt nach 3 min von selbst
  }catch(e){toast("WLAN-Code nicht verfügbar: "+errTxt(e));}
}
$("#pill-wlan").onclick=wlanZeigen;
$("#wlan").addEventListener("click",wlanZu);
$("#wlan-zeig").onclick=e=>{e.stopPropagation();$("#wlan-pw").hidden=false;$("#wlan-zeig").hidden=true;};
$("#wlan-pw").addEventListener("click",e=>e.stopPropagation());

// Der Hausherr: Das Bild liegt im geschützten Speicher und wird nur mit Kalender-Passwort oder Dienst-PIN herausgegeben;
// ohne bleibt die Burg. Gezeigt wird es erst, wenn eines der beiden Geheimnisse auf diesem Gerät nachweislich stimmt
// (Termine oder Dienste sind entschlüsselt). Einmal geholt, bleibt es auf dem Gerät gemerkt (Abruf höchstens täglich).
let katerOk=false, katerBusy=false, katerAt=0;
const katerBild=src=>{if(/^data:image\/(jpeg|png|webp|avif|gif);base64,[A-Za-z0-9+/=]+$/.test(src||"")){document.querySelector(".crest img").src=src;katerOk=true;}};
async function katerTry(){
  if(katerBusy||!(calData||privData))return;
  if(!katerOk)katerBild(store.get("ablage:kater",null));
  if(Date.now()-katerAt<(katerOk?24*3600e3:10*60e3))return;
  katerBusy=true;katerAt=Date.now();
  try{
    for(const [pw,id,da] of [[store.get(CAL_KEY,null),"kater:k",calData],[store.get(PIN_KEY,null),"kater:p",privData]]){
      if(!pw||!da)continue;
      try{const d=await datenHolen("kater",pw,id);if(d.inhalt?.img){store.set("ablage:kater",d.inhalt.img);katerBild(d.inhalt.img);break;}}
      catch(e){if(e.status===0||e.status===429)break;}   // keine Verbindung oder gesperrt: später erneut, nichts weiter probieren
    }
  }finally{katerBusy=false;}
}
setTimeout(katerTry,3000);setInterval(katerTry,60000);
function renderNight(){
  $("#nt-clock").textContent=nowHM();
  $("#nt-date").textContent=new Date().toLocaleDateString("de-DE",{weekday:"long",day:"numeric",month:"long",timeZone:"Europe/Berlin"});
  const it=(l,b,sub)=>`<div class="nt-it"><small>${l}</small><b>${b}</b>${sub?`<span>${sub}</span>`:""}</div>`;
  const rows=[];
  if(typeof wxState!=="undefined"&&wxState){const w=wxState;
    rows.push(it("Wetter",`${ico(w.code,w.day,WMO[w.code])}${w.temp}°`,w.morgen?`Morgen ${w.morgen.max}° / ${w.morgen.min}°${w.morgen.pp>=30?` · Regen ${w.morgen.pp} %`:""}`:""));}
  const now=Date.now();
  const frisch=typeof deps!=="undefined"&&now-depsOk<6*60000;   // nachts wird alle 2 min abgerufen: älter als 6 min gilt als veraltet
  const d=(frisch?deps:[]).filter(x=>!WEST.test(x.destination)&&!x.cancelled&&(x.realtimeDepartureTime||x.plannedDepartureTime)>now)[0];
  if(d){const t=d.realtimeDepartureTime||d.plannedDepartureTime;rows.push(it("S4 → Innenstadt",fmtT(t),`in ${Math.max(0,Math.round((t-now)/60000))} min`+(d.delayInMinutes>0?` · +${Math.round(d.delayInMinutes)}`:"")+(endetVorher(d)?(d.sev?" · Ersatzverkehr":` · nur bis ${esc(d.destination)}`):"")));}
  else rows.push(it("S4 → Innenstadt","–",frisch?"keine Abfahrt in Sicht":"Abfahrten gerade nicht abrufbar"));
  const fw=typeof fensterWarnung==="function"?fensterWarnung():null;
  if(fw)rows.push(it("Fenster offen",esc(fw.namen),`seit ${dauerTxt(now-fw.seit)}${fw.aussen!=null?` · draußen ${fw.aussen}°`:""}`));
  if(privData){
    const n=(privData.eintraege||[]).filter(e=>e.von).map(e=>({e,start:berlinTime(e.d,e.von)})).filter(x=>x.start.getTime()>now).sort((a,b)=>a.start-b.start)[0];
    if(n){const k=Math.round((new Date(n.e.d+"T12:00:00")-new Date(berlinDay()+"T12:00:00"))/864e5);
      const tag=k===0?"Heute":k===1?"Morgen":new Date(n.e.d+"T12:00:00").toLocaleDateString("de-DE",{weekday:"long"});
      rows.push(it("Nächster Dienst",`${esc(n.e.von)}–${esc(n.e.bis||"")}`,tag));}
  }
  $("#nt-rows").innerHTML=rows.join("");
}
updateNight();setInterval(updateNight,10000);

// Einbrennschutz: alle 2 min wandert die ganze Seite um 1 px (Bereich 7 × 6 px, kehrt nach 2 h zurück);
// die Nachtanzeige wandert sechsmal so weit, weil dort stundenlang dasselbe Bild steht
function schiebe(){
  const s=Math.floor(Date.now()/120000), tri=(n,p)=>{const k=n%(2*p);return k<=p?k:2*p-k;}, r=document.documentElement.style;
  r.setProperty("--sx",(tri(s,6)-3)+"px");r.setProperty("--sy",tri(s,5)+"px");
}
schiebe();setInterval(schiebe,120000);

// Bildschirm wach halten (Safari ab iOS 16.4); wird beim Zurückkehren erneut angefordert
let wakeLock=null;
async function keepAwake(){
  if(!("wakeLock" in navigator)||document.hidden||wakeLock)return;
  try{wakeLock=await navigator.wakeLock.request("screen");wakeLock.addEventListener("release",()=>{wakeLock=null;});}catch{}
}
keepAwake();
document.addEventListener("visibilitychange",()=>{if(!document.hidden)keepAwake();});
// manche Safari-Versionen erlauben es erst nach einer Berührung
addEventListener("pointerdown",keepAwake,{passive:true});
