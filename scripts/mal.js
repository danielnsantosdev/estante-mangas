// MyAnimeList (via Jikan): anime e situação de cada obra do catálogo, conferidos aqui no GitHub
// uma vez para todo mundo. O app só lê o resultado na ficha da obra (campos anime e situacao).
//  - anime.st: "anu" (anunciado, ainda não estreou) | "dis" (já saiu episódio) | null (sem anime)
//  - "dis" e situação "Finished"/"Discontinued" não voltam atrás: não são conferidos de novo
// MODO=diag: confere só o One Piece e falha se não vier "anime disponível" (teste da rotina)
const admin = require("firebase-admin");
function lerChave(txt) {
  txt = String(txt || "").replace(/^\uFEFF/, "").trim();
  const tentativas = [
    (t) => t,
    (t) => t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"),
    (t) => t.replace(/\\\r?\n/g, "\\n"),                                   // "\" + quebra de linha  ->  \n
    (t) => t.replace(/\r?\n(?=[^"]*"(?:[^"]*"[^"]*")*[^"]*$)/g, "\\n"),     // quebra de linha dentro de aspas -> \n
    (t) => t.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"),                       // barra solta -> barra escapada
  ];
  let t = txt;
  for (const f of tentativas) {
    t = f(t);
    try { return JSON.parse(t); } catch (e) {}
  }
  // última tentativa: todas as correções juntas, a partir do original
  t = tentativas.reduce((acc, f) => f(acc), txt);
  return JSON.parse(t);
}
let sa = {};
try { sa = lerChave(process.env.FIREBASE_SA); }
catch (e) { console.error("A chave FIREBASE_SA não pôde ser lida (" + e.message + "). Gere uma nova chave no Firebase e cole o arquivo .json inteiro no segredo."); process.exit(1); }
if (!sa.project_id || !sa.private_key || !sa.client_email) { console.error("A chave FIREBASE_SA está incompleta. Cole o arquivo .json inteiro, do { ao }."); process.exit(1); }
sa.private_key = String(sa.private_key).replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const espera = (ms) => new Promise(r => setTimeout(r, ms));
let ultima = 0; const logDiag = [];
async function jikan(path) {
  for (let t = 0; t < 4; t++) {
    const falta = 1200 - (Date.now() - ultima); if (falta > 0) await espera(falta);
    ultima = Date.now();
    const r = await fetch("https://api.jikan.moe/v4" + path, { headers: { Accept: "application/json" } });
    if (r.ok) return r.json();
    if (r.status === 404) return null;
    const msg = `Jikan ${path}: ${r.status} ${(await r.text()).slice(0, 160)}`; logDiag.push(msg); console.log(msg + " — tentando de novo…"); await espera(3000 * (t + 1));
  }
  throw new Error("Jikan não respondeu: " + path);
}
async function conferir(mid) {
  const m = await jikan(`/manga/${mid}/full`);
  const d = (m && m.data) || {};
  const ids = (d.relations || []).filter(x => x.relation === "Adaptation").flatMap(x => x.entry || []).filter(e => e.type === "anime").map(e => e.mal_id);
  let st = null, aid = 0;
  for (const id of ids.slice(0, 8)) {
    const a = await jikan(`/anime/${id}`); const sa = a && a.data && a.data.status;
    if (sa === "Currently Airing" || sa === "Finished Airing") { st = "dis"; aid = id; break; }
    if (sa === "Not yet aired" && !st) { st = "anu"; aid = id; }
  }
  return { anime: { st, aid }, situacao: d.status || "" };
}
const VALE = { anu: 20 * 3600e3, nada: 3 * 864e5, sit: 7 * 864e5 };
const precisa = (c) => {
  const a = c.anime || null, agora = Date.now();
  const animeOk = a && (a.st === "dis" || agora - (c.animeEm || 0) < (a.st === "anu" ? VALE.anu : VALE.nada));
  const sitOk = c.situacao && (["Finished", "Discontinued"].includes(c.situacao) || agora - (c.situacaoEm || 0) < VALE.sit);
  return !(animeOk && sitOk);
};

(async () => {
  if (process.env.MODO === "diag") {   // grava o resultado do teste em sinopses/diag-mal.json
    const fs = require("fs"), path = require("path"), out = { quando: new Date().toISOString() };
    try {
      const m = await jikan("/manga/13/full"); const d = (m && m.data) || {};
      out.manga = { status: d.status, relacoes: (d.relations || []).map(x => ({ relation: x.relation, entry: (x.entry || []).slice(0, 4) })) };
      out.resultado = await conferir(13);
    } catch (e) { out.erro = String(e && e.message || e); }
    out.log = logDiag;
    fs.writeFileSync(path.join(__dirname, "..", "sinopses", "diag-mal.json"), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out.resultado || out.erro));
    process.exit(0);
  }
  const snap = await db.collection("catalogo").get();
  const fila = snap.docs.filter(d => { const c = d.data() || {}; const mid = c.malId || (/^mal(\d+)$/.exec(d.id) || [])[1]; return mid && precisa(c); }).slice(0, 25);
  let n = 0;
  for (const d of fila) {
    const c = d.data() || {}, mid = +(c.malId || /^mal(\d+)$/.exec(d.id)[1]);
    try {
      const r = await conferir(mid);
      await d.ref.set({ anime: r.anime, animeEm: Date.now(), situacao: r.situacao, situacaoEm: Date.now() }, { merge: true });
      console.log(`${d.id}: anime ${r.anime.st || "—"}, situação ${r.situacao || "—"}`); n++;
    } catch (e) { console.log(d.id + ": " + e.message); }
  }
  console.log(`Catálogo: ${snap.size} obras; ${n} conferidas no MyAnimeList.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
