// MyAnimeList (lendo as páginas do próprio site): anime e situação de cada obra do catálogo, conferidos aqui no GitHub
// uma vez para todo mundo. O app só lê o resultado na ficha da obra (campos anime e situacao).
//  - anime.st: "anu" (anunciado, ainda não estreou) | "dis" (já saiu episódio) | null (sem anime)
//  - "dis" e situação "Finished"/"Discontinued" não voltam atrás: não são conferidos de novo
// MODO=diag: confere One Piece e Omniscient Reader e grava o resultado em sinopses/diag-mal.json
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
// lê a página do próprio MyAnimeList, com calma (uma página a cada 2,5 s)
async function pagina(path) {
  for (let t = 0; t < 3; t++) {
    const falta = 2500 - (Date.now() - ultima); if (falta > 0) await espera(falta);
    ultima = Date.now();
    try {
      const r = await fetch("https://myanimelist.net" + path, { headers: { "User-Agent": "Mozilla/5.0 (compatible; EstanteDeMangas/1.0; +https://github.com/danielnsantosdev/estante-mangas)", "Accept-Language": "en" }, signal: AbortSignal.timeout(25000) });
      if (r.ok) return r.text();
      if (r.status === 404) return "";
      logDiag.push(`${path}: ${r.status}`);
    } catch (e) { logDiag.push(`${path}: ${e.message}`); }
    await espera(5000 * (t + 1));
  }
  throw new Error("MyAnimeList não respondeu: " + path);
}
const statusDe = (h) => { const m = /Status:<\/span>\s*([^<]+)</.exec(h || ""); return m ? m[1].replace(/\s+/g, " ").trim() : ""; };
function adaptacoes(h) {   // animes que adaptam o mangá ("Adaptation"), nos cartões e na tabela de relacionados
  const ids = [];
  for (const m of (h || "").matchAll(/<div class="relation">\s*Adaptation[\s\S]{0,200}?<div class="title">\s*<a href="https:\/\/myanimelist\.net\/anime\/(\d+)/g)) ids.push(+m[1]);
  for (const m of (h || "").matchAll(/>\s*Adaptation:\s*<\/td>([\s\S]*?)<\/ul>/g)) for (const a of m[1].matchAll(/myanimelist\.net\/anime\/(\d+)/g)) ids.push(+a[1]);
  return [...new Set(ids)];
}
async function conferir(mid) {
  const h = await pagina(`/manga/${mid}`);
  const ids = adaptacoes(h);
  let st = null, aid = 0;
  for (const id of ids.slice(0, 8)) {
    const sa = statusDe(await pagina(`/anime/${id}`));
    if (sa === "Currently Airing" || sa === "Finished Airing") { st = "dis"; aid = id; break; }
    if (sa === "Not yet aired" && !st) { st = "anu"; aid = id; }
  }
  return { anime: { st, aid }, situacao: statusDe(h) };
}
// obra que entrou só pelo MangaDex (ou sem o número do MAL): procura no MyAnimeList pelo nome e só aceita
// quando um dos nomes da obra bate com o título, o nome em inglês ou os sinônimos da página do MAL
const normNome = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\u1100-\u11ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/g, " ").trim();
const nomesDe = (c) => [...new Set([c.titulo, c.titulo2, c.nomeEN, c.nomePT, ...(Array.isArray(c.nomes) ? c.nomes : [])].map(normNome).filter(n => n.length >= 3))];
const nomesPagina = (h) => {
  const out = [];
  const t = /<span itemprop="name"[^>]*>([\s\S]*?)<\/span>/.exec(h || ""); if (t) out.push(t[1].replace(/<br[^>]*>[\s\S]*$/, "").replace(/<[^>]+>/g, ""));
  const h1 = /<h1 class="title-name[^"]*"><strong>([^<]+)<\/strong>/.exec(h || ""); if (h1) out.push(h1[1]);
  const te = /<p class="title-english[^"]*">([^<]+)<\/p>/.exec(h || ""); if (te) out.push(te[1]);
  for (const m of (h || "").matchAll(/<span class="dark_text">(?:English|Synonyms|Japanese|Korean|Chinese|German|French|Spanish):<\/span>\s*([^<]+)</g)) out.push(...m[1].split(/,\s*/));
  return out.map(x => normNome(x.replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"'))).filter(Boolean);
};
async function acharMalId(c) {
  const nomes = nomesDe(c); if (!nomes.length) return 0;
  const consultas = [...new Set([c.nomeEN, c.titulo, c.titulo2].filter(Boolean).map(x => String(x).slice(0, 60)))].slice(0, 2);
  const vistos = new Set();
  for (const q of consultas) {
    const itens = await prefixo("manga", q);
    const direto = itens.find(x => nomes.includes(normNome(x.name))); if (direto) return +direto.id;
    for (const x of itens.slice(0, 5)) {
      if (vistos.has(x.id)) continue; vistos.add(x.id);
      if (nomesPagina(await pagina(`/manga/${x.id}`)).some(n => nomes.includes(n))) return +x.id;
    }
  }
  return 0;
}
async function prefixo(tipo, q) {
  try { return (JSON.parse(await pagina(`/search/prefix.json?type=${tipo}&v=1&keyword=` + encodeURIComponent(String(q).slice(0, 60)))).categories || []).flatMap(k => k.items || []); }
  catch (e) { logDiag.push(`busca ${tipo} ${q}: ${e.message}`); return []; }
}
// obra que não existe como mangá no MyAnimeList (ex.: webcomic americano): procura o anime direto pelo nome.
// só vale se o nome bater com o título/inglês/sinônimos do anime e se o anime não for história original.
async function animePorNome(c) {
  const nomes = nomesDe(c).filter(n => n.length >= 6); if (!nomes.length) return { st: null, aid: 0 };
  const consultas = [...new Set([c.nomeEN, c.titulo, c.titulo2].filter(Boolean))].slice(0, 2);
  const vistos = new Set(); let achado = null;
  for (const q of consultas) {
    for (const x of (await prefixo("anime", q)).slice(0, 6)) {
      if (vistos.has(x.id)) continue; vistos.add(x.id);
      const h = await pagina(`/anime/${x.id}`);
      const fonte = (/Source:<\/span>\s*([^<]+)</.exec(h) || [])[1] || "";
      if (/original/i.test(fonte) || !nomesPagina(h).some(n => nomes.includes(n))) continue;
      const sa = statusDe(h);
      if (sa === "Currently Airing" || sa === "Finished Airing") return { st: "dis", aid: +x.id, porNome: true };
      if (sa === "Not yet aired" && !achado) achado = { st: "anu", aid: +x.id, porNome: true };
    }
    if (achado) break;
  }
  return achado || { st: null, aid: 0 };
}
// situação das obras que só existem no MangaDex (chave md + código da obra)
async function situacaoMangaDex(id) {
  const m = /^md([0-9a-f]{32})$/.exec(id); if (!m) return "";
  const u = m[1].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  try {
    const r = await fetch("https://api.mangadex.org/manga/" + u, { headers: { "User-Agent": "EstanteDeMangas/1.0" }, signal: AbortSignal.timeout(20000) });
    const st = ((await r.json()).data || {}).attributes?.status;
    return { ongoing: "Publishing", completed: "Finished", hiatus: "On Hiatus", cancelled: "Discontinued" }[st] || "";
  } catch (e) { logDiag.push("MangaDex " + id + ": " + e.message); return ""; }
}
const VALE = { anu: 20 * 3600e3, nada: 3 * 864e5, sit: 7 * 864e5 };
const precisaAnime = (c) => { const a = c.anime || null; return !(a && (a.st === "dis" || Date.now() - (c.animeEm || 0) < (a.st === "anu" ? VALE.anu : VALE.nada))); };
const precisa = (c) => {
  const a = c.anime || null, agora = Date.now();
  const animeOk = a && (a.st === "dis" || agora - (c.animeEm || 0) < (a.st === "anu" ? VALE.anu : VALE.nada));
  const sitOk = c.situacao && (["Finished", "Discontinued"].includes(c.situacao) || agora - (c.situacaoEm || 0) < VALE.sit);
  return !(animeOk && sitOk);
};

(async () => {
  if (process.env.MODO === "diag") {   // grava o resultado do teste em sinopses/diag-mal.json
    const fs = require("fs"), path = require("path"), out = { quando: new Date().toISOString() };
    out.busca = {};
    for (const c of [{ titulo: "The Beginning After the End", nomes: ["O Começo Depois do Fim"] }, { titulo: "One Punch-Man", nomeEN: "One-Punch Man" }]) {
      try { const id = await acharMalId(c); out.busca[c.titulo] = id ? { malId: id, ...(await conferir(id)) } : { malId: 0, anime: await animePorNome(c) }; } catch (e) { out.busca[c.titulo] = "falhou: " + e.message; }
    }
    out.situacaoMangaDex = await situacaoMangaDex("md6e3553b9ddb54d37b7a399998044774e");
    out.prefixoAnime = (await prefixo("anime", "The Beginning After the End")).slice(0, 6).map(x => x.id + " " + x.name);
    out.log = logDiag;
    fs.writeFileSync(path.join(__dirname, "..", "sinopses", "diag-mal.json"), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
    process.exit(0);
  }
  const snap = await db.collection("catalogo").get();
  // primeiro: obras sem o número do MAL (até 10 por rodada; quem não achou tenta de novo depois de 3 dias)
  let docs = snap.docs;
  const semId = docs.filter(d => { const c = d.data() || {}; return !c.malId && !/^mal\d+$/.test(d.id) && Date.now() - (c.malBuscaEm || 0) > 3 * 864e5; }).slice(0, 10);
  for (const d of semId) {
    try {
      const id = await acharMalId(d.data() || {});
      await d.ref.set(id ? { malId: id, malBuscaEm: Date.now() } : { malBuscaEm: Date.now() }, { merge: true });
      console.log(`${d.id}: MyAnimeList ${id || "não encontrado"}`);
    } catch (e) { console.log(d.id + " (busca no MAL): " + e.message); }
  }
  if (semId.length) docs = (await db.collection("catalogo").get()).docs;
  const fila = docs.filter(d => { const c = d.data() || {}; const mid = c.malId || (/^mal(\d+)$/.exec(d.id) || [])[1]; return mid && precisa(c); }).slice(0, 25);
  let n = 0;
  const soNome = docs.filter(d => { const c = d.data() || {}; return !c.malId && !/^mal\d+$/.test(d.id) && c.malBuscaEm && precisaAnime(c); }).slice(0, 10);
  for (const d of soNome) {
    try {
      const a = await animePorNome(d.data() || {});
      const novo = { anime: a, animeEm: Date.now() };
      const sit = await situacaoMangaDex(d.id); if (sit) Object.assign(novo, { situacao: sit, situacaoEm: Date.now() });
      await d.ref.set(novo, { merge: true });
      console.log(`${d.id}: anime pelo nome ${a.st || "—"}`); n++;
    } catch (e) { console.log(d.id + " (anime pelo nome): " + e.message); }
  }
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
