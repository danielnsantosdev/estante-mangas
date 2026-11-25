// Ranking da Estante de Mangás.
// Roda no GitHub todo dia (e manualmente na aba Actions) e grava o resultado no Firebase:
//  - todo dia: guarda o histórico de leituras e calcula Em alta, Esta semana, Este mês, Por gênero e "Quem lê";
//  - dia 1º (ou rodando manualmente): recalcula "Todos os tempos" (somando o histórico inteiro).
// Só entram perfis PÚBLICOS e não ocultos. Leituras antigas continuam contando para as obras
// mesmo se a pessoa apagar o mangá ou fechar o perfil (sem mostrar quem foi).
// O app apenas lê o resultado pronto.
const admin = require("firebase-admin");

// Lê a chave (segredo FIREBASE_SA) e conserta defeitos comuns de copiar e colar:
// barras "\" seguidas de quebra de linha, quebras de linha soltas dentro do texto, aspas "inteligentes" etc.
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

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const media = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10;

// Busca a obra no mesmo catálogo do app (AniList) quando o mangá não foi vinculado,
// para o ranking ter sempre o nome popular e a capa oficial.
// mesmo critério do app: mangá japonês → inglês (ou japonês); manhwa/manhua → português (ou inglês)
function nomePopular(c) {
  const jp = !c.tipo || c.tipo === "Mangá";
  if (!c.nomes) return String(c.titulo2 || c.titulo || "").trim().slice(0, 120);   // catálogo antigo, sem a lista de nomes
  const ord = jp ? [c.nomeEN, c.titulo, c.nomePT] : [c.nomePT, c.nomeEN, c.titulo];
  return String(ord.find(x => x && String(x).trim()) || "").trim();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function distancia(a, b) {   // quantas letras trocar para um virar o outro (aceita erro de digitação)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const parecido = (a, b) => {
  a = norm(a).replace(/[^a-z0-9]/g, ""); b = norm(b).replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b || (a.length >= 5 && b.includes(a)) || (b.length >= 5 && a.includes(b))) return true;
  return Math.min(a.length, b.length) >= 8 && distancia(a, b) <= 2;
};
async function buscaMAL(titulo) {   // segunda opção: MyAnimeList (Jikan), o mesmo que o app usa
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(titulo)}&limit=8&sfw=true`);
      if (r.status === 429) { await sleep(4000); continue; }
      if (!r.ok) { console.log(`MyAnimeList respondeu ${r.status} para "${titulo}"`); return null; }
      const j = await r.json();
      const m = (j.data || []).filter(x => !/novel/i.test(x.type || "")).find(x => [x.title, x.title_english, x.title_japanese, ...(x.title_synonyms || []), ...((x.titles || []).map(y => y.title))].some(n => parecido(n, titulo)));
      if (!m) return null;
      const img = (m.images && ((m.images.jpg && m.images.jpg.large_image_url) || (m.images.webp && m.images.webp.large_image_url))) || "";
      return { chave: "mal" + m.mal_id, titulo: (m.title || "").trim(), titulo2: (m.title_english || "").trim(), capa: img };
    } catch (e) { console.log(`MyAnimeList falhou para "${titulo}": ${e.message}`); await sleep(1500); }
  }
  return null;
}
// Baixa a capa e guarda dentro do ranking (o MangaDex não deixa outros apps exibirem as capas direto do site dele)
async function capaEmbutida(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "EstanteMangas-Ranking/1.0" } });
    if (!r.ok) { console.log(`Capa não baixou (${r.status}): ${url}`); return ""; }
    const tipo = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    const buf = Buffer.from(await r.arrayBuffer());
    if (!/^image\//.test(tipo) || buf.length > 90000) return "";
    return `data:${tipo};base64,${buf.toString("base64")}`;
  } catch (e) { return ""; }
}
async function buscaMangaDex(titulo) {   // terceira opção: MangaDex (tem nomes em português)
  try {
    const r = await fetch(`https://api.mangadex.org/manga?title=${encodeURIComponent(titulo)}&limit=8&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive`, { headers: { "User-Agent": "EstanteMangas-Ranking/1.0" } });
    if (!r.ok) { console.log(`MangaDex respondeu ${r.status} para "${titulo}"`); return null; }
    const j = await r.json();
    let nome = "";
    const m = (j.data || []).find(x => { const a = x.attributes || {}; const n = [...Object.values(a.title || {}), ...(a.altTitles || []).flatMap(t => Object.values(t))].find(n => parecido(n, titulo)); if (n) nome = n; return !!n; });
    if (!m) { console.log(`MangaDex: nada parecido com "${titulo}"`); return null; }
    const a = m.attributes || {}, links = a.links || {};
    // nome mostrado: o nome da obra que bateu com o que o leitor digitou (o mais conhecido), sem os erros de digitação
    const cov = (m.relationships || []).find(x => x.type === "cover_art");
    const capa = cov && cov.attributes && cov.attributes.fileName ? await capaEmbutida(`https://uploads.mangadex.org/covers/${m.id}/${cov.attributes.fileName}.256.jpg`) : "";
    const chave = links.mal ? "mal" + links.mal : (links.al ? "al" + links.al : "md:" + m.id);
    return { chave, titulo: nome, titulo2: "", capa };
  } catch (e) { console.log(`MangaDex falhou para "${titulo}": ${e.message}`); return null; }
}
async function buscaCatalogo(titulo) { return (await buscaAniList(titulo)) || (await buscaMAL(titulo)) || (await buscaMangaDex(titulo)); }
async function buscaAniList(titulo) {
  const query = `query($q:String){Page(perPage:5){media(search:$q,type:MANGA,isAdult:false,sort:SEARCH_MATCH){id idMal title{romaji english native} synonyms coverImage{large}}}}`;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables: { q: titulo } }) });
      if (r.status === 429) { await sleep((Number(r.headers.get("retry-after")) || 30) * 1000 + 500); continue; }
      if (!r.ok) { console.log(`AniList respondeu ${r.status} para "${titulo}"`); return null; }
      const j = await r.json();
      if (j.errors) console.log(`AniList deu erro para "${titulo}": ${JSON.stringify(j.errors).slice(0, 200)}`);
      const lista = (j.data && j.data.Page && j.data.Page.media) || [];
      const m = lista.find(x => [x.title.romaji, x.title.english, x.title.native, ...(x.synonyms || [])].some(n => parecido(n, titulo)));
      if (!m) { console.log(`AniList: nada parecido com "${titulo}" (veio: ${lista.map(x => x.title.english || x.title.romaji).join(" / ")})`); return null; }
      return { chave: m.idMal ? "mal" + m.idMal : "al" + m.id, titulo: (m.title.romaji || m.title.english || "").trim(), titulo2: (m.title.english || "").trim(), capa: (m.coverImage && m.coverImage.large) || "" };
    } catch (e) { await sleep(1500); }
  }
  return null;
}

const DIA = 86400e3;
const agoraBR = () => new Date(Date.now() - 3 * 3600e3);   // horário de Brasília (como UTC)
const idHist = (uid, chave) => `${uid}__${chave}`.replace(/\//g, "_").slice(0, 300);
const ehCat = (k) => /^(al|mal)\d+$/.test(k || "");

(async () => {
  const br = agoraBR();
  const tudo = process.env.MODO === "tudo" || br.getUTCDate() === 1;
  const inicioDiaBR = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate()) + 3 * 3600e3;
  const segunda = inicioDiaBR - ((br.getUTCDay() + 6) % 7) * DIA;
  const inicioMes = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), 1) + 3 * 3600e3;
  const seteDias = Date.now() - 7 * DIA;
  const mesRef = `${br.getUTCFullYear()}-${String(br.getUTCMonth() + 1).padStart(2, "0")}`;

  // 1) perfis públicos e as estantes deles
  const perfisSnap = await db.collection("perfis").get();
  const publicos = new Map();
  for (const p of perfisSnap.docs) { const pf = p.data() || {}; if (pf.publico === true && pf.oculto !== true && pf.apelido) publicos.set(p.id, pf); }
  const entradas = [];
  for (const [uid] of publicos) {
    const ms = await db.collection("users").doc(uid).collection("mangas").get();
    for (const m of ms.docs) {
      const x = m.data() || {};
      const st = x.status === "acumulando" ? "pausado" : x.status;
      const cv = String(x.cover || "");
      entradas.push({ uid, title: String(x.title || "").trim(), catId: ehCat(x.catId) ? x.catId : "", st,
        nota: typeof x.nota === "number" ? x.nota : null, cap: Number(x.chapter) || 0,
        criado: Number(x.createdAt) || Date.now(), lido: Number(x.lastReadAt) || 0,
        capa: /^https?:\/\//.test(cv) || (/^data:image\//.test(cv) && cv.length < 120000) ? cv : "" });
    }
  }
  console.log(`${publicos.size} perfis públicos, ${entradas.length} mangás nas estantes.`);

  // 2) mangás sem vínculo: procura no catálogo pelo nome (guardado de um dia para o outro, só procura nome novo)
  const cacheRef = db.collection("rkcache").doc("nomes");
  const cache = ((await cacheRef.get()).data() || {}).mapa || {};
  let novosNomes = 0;
  for (const e of entradas) {
    if (e.catId || !e.title) continue;
    const k = norm(e.title).slice(0, 150).replace(/[.\/\[\]*`~]/g, "_");
    let c = cache[k];
    if (!c || (!c.chave && Date.now() - (c.em || 0) > 7 * DIA)) {   // não achado: tenta de novo depois de 7 dias
      const a = await buscaCatalogo(e.title); await sleep(2200); novosNomes++;
      c = a ? { chave: a.chave, titulo: a.titulo2 || a.titulo || "", capa: a.capa || "", em: Date.now() } : { chave: "", em: Date.now() };
      cache[k] = c;
    }
    if (c.chave) { e.catId = c.chave; e.achado = c; }
  }
  if (novosNomes) await cacheRef.set({ mapa: cache });

  // 3) histórico de leituras: um registro por pessoa + obra, que nunca é apagado
  const histSnap = await db.collection("historico").get();
  const hist = new Map(histSnap.docs.map(d => [d.id, d.data()]));
  const mudou = new Map();
  for (const e of entradas) {
    const chave = e.catId || "nome:" + norm(e.title).slice(0, 150);
    e.chave = chave;
    const id = idHist(e.uid, chave);
    const h = hist.get(id) || { uid: e.uid, chave, desde: e.criado, ultimaLeitura: 0, lido: false, concluido: false, nota: null };
    const novo = { ...h, titulo: e.title.slice(0, 120),
      desde: Math.min(h.desde || e.criado, e.criado),
      ultimaLeitura: Math.max(h.ultimaLeitura || 0, (e.st === "lendo" || e.st === "concluido") ? e.lido : 0),
      lido: h.lido || e.st === "lendo" || e.st === "concluido",
      concluido: h.concluido || e.st === "concluido",
      nota: e.nota !== null ? e.nota : (h.nota ?? null) };
    if (JSON.stringify(novo) !== JSON.stringify(h)) { mudou.set(id, novo); }
    hist.set(id, novo);
  }
  let lote = db.batch(), n = 0;
  for (const [id, h] of mudou) { lote.set(db.collection("historico").doc(id), h); if (++n % 400 === 0) { await lote.commit(); lote = db.batch(); } }
  if (n % 400) await lote.commit();
  console.log(`Histórico: ${hist.size} registros (${mudou.size} atualizados hoje).`);

  // 4) nome e capa de cada obra: catálogo do app primeiro, depois o que foi achado, por último o que o leitor colocou
  const info = new Map();
  async function obra(chave) {
    if (info.has(chave)) return info.get(chave);
    const daqui = entradas.filter(e => e.chave === chave);
    const nomes = new Map(); for (const e of daqui) nomes.set(e.title, (nomes.get(e.title) || 0) + 1);
    const hs = [...hist.values()].filter(h => h.chave === chave);
    const digitado = ([...nomes.entries()].sort((a, b) => b[1] - a[1])[0] || [])[0] || (hs[0] && hs[0].titulo) || chave.replace(/^nome:/, "");
    let titulo = digitado, capa = "";
    if (ehCat(chave)) {
      const c = await db.collection("catalogo").doc(chave).get();
      if (c.exists) { const d = c.data(); titulo = nomePopular(d) || titulo; capa = d.capa || ""; }
    }
    const achado = (daqui.find(e => e.achado) || {}).achado;
    if (!capa && achado) { titulo = achado.titulo || titulo; capa = achado.capa || ""; }
    if (!capa) capa = (daqui.find(e => e.capa) || {}).capa || "";
    // capas embutidas (MangaDex) ficam num documento à parte, para o ranking não passar do limite de tamanho
    if (capa.startsWith("data:")) { const cid = chave.replace(/[\/]/g, "_").slice(0, 300); await db.collection("rkcapas").doc(cid).set({ capa }); capa = "rkcapa:" + cid; }
    const r = { chave, catId: ehCat(chave) ? chave : "", titulo: String(titulo).slice(0, 120), capa };
    info.set(chave, r); return r;
  }
  const top = async (mapa, qtd, extra) => {
    const lista = [...mapa.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, qtd);
    const out = []; for (const [chave, v] of lista) out.push({ ...(await obra(chave)), ...(extra ? extra(chave, v) : {}) }); return out;
  };
  const conta = (filtro) => { const m = new Map(); for (const h of hist.values()) if (filtro(h)) m.set(h.chave, (m.get(h.chave) || 0) + 1); return m; };

  // 5) períodos (todo dia)
  const semana = conta(h => h.lido && h.ultimaLeitura >= segunda);
  const mes = conta(h => h.lido && h.ultimaLeitura >= inicioMes);
  const alta = new Map();
  for (const h of hist.values()) {
    if (!h.lido) continue;
    const pts = (h.desde >= seteDias ? 2 : 0) + (h.ultimaLeitura >= seteDias ? 1 : 0);
    if (pts) alta.set(h.chave, (alta.get(h.chave) || 0) + pts);
  }
  const periodos = { geradoEm: Date.now(), mesRef, alta: await top(alta, 10), semana: await top(semana, 10), mes: await top(mes, 10) };
  await db.collection("ranking").doc("periodos").set(periodos);

  // 5b) por gênero (todo dia): os mais lidos de cada gênero, somando o histórico inteiro
  const GENEROS_RK = { "Ação": "Action", "Romance": "Romance", "Fantasia": "Fantasy", "Comédia": "Comedy", "Drama": "Drama", "Esportes": "Sports", "Mistério": "Mystery", "Terror": "Horror" };
  const genRef = db.collection("rkcache").doc("generos");
  const genCache = ((await genRef.get()).data() || {}).mapa || {};
  let genNovos = 0;
  async function generosDe(chave) {
    if (!ehCat(chave)) return [];
    if (genCache[chave]) return genCache[chave];
    let lista = [];
    const c = await db.collection("catalogo").doc(chave).get();
    if (c.exists && Array.isArray(c.data().generos)) lista = c.data().generos.filter(g => GENEROS_RK[g]);
    else {
      const m = /^(al|mal)(\d+)$/.exec(chave);
      try {
        const r = await fetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query: `query{Media(${m[1] === "al" ? "id" : "idMal"}:${m[2]},type:MANGA){genres}}` }) });
        const j = await r.json(); const en = (j.data && j.data.Media && j.data.Media.genres) || [];
        lista = Object.entries(GENEROS_RK).filter(([, e]) => en.includes(e)).map(([pt]) => pt);
      } catch (e) {}
      await sleep(800);
    }
    genCache[chave] = lista; genNovos++; return lista;
  }
  const lidosTudo = conta(h => h.lido);
  const porGenero = {}; for (const g in GENEROS_RK) porGenero[g] = new Map();
  for (const [chave, v] of lidosTudo) for (const g of await generosDe(chave)) porGenero[g].set(chave, v);
  if (genNovos) await genRef.set({ mapa: genCache });
  const generos = { geradoEm: Date.now(), lista: {} };
  for (const g in porGenero) generos.lista[g] = await top(porGenero[g], 10);
  await db.collection("ranking").doc("generos").set(generos);

  // 6) todos os tempos (dia 1º, ou quando ainda não existe)
  const temTodos = (await db.collection("ranking").doc("todos").get()).exists;
  let todos = null;
  if (tudo || !temTodos) {
    const lidos = conta(h => h.lido);
    const notas = new Map();
    for (const h of hist.values()) if (typeof h.nota === "number") { if (!notas.has(h.chave)) notas.set(h.chave, []); notas.get(h.chave).push(h.nota); }
    const medias = new Map([...notas].filter(([, a]) => a.length >= 2).map(([k, a]) => [k, media(a)]));
    const melhoresLista = [...medias.entries()].sort((a, b) => b[1] - a[1] || notas.get(b[0]).length - notas.get(a[0]).length).slice(0, 10);
    const melhores = []; for (const [chave, m] of melhoresLista) melhores.push({ ...(await obra(chave)), media: m, notas: notas.get(chave).length });
    const porLeitor = new Map(); for (const h of hist.values()) if (h.concluido && publicos.has(h.uid)) porLeitor.set(h.uid, (porLeitor.get(h.uid) || 0) + 1);
    const leitores = [...porLeitor.entries()].map(([uid, c]) => ({ uid, apelido: publicos.get(uid).apelido, concluidos: c }))
      .sort((a, b) => b.concluidos - a.concluidos || a.apelido.localeCompare(b.apelido)).slice(0, 15);
    todos = { geradoEm: Date.now(), mesRef, maisLidos: await top(lidos, 10, (k, v) => ({ leitores: v })), melhores, leitores };
    await db.collection("ranking").doc("todos").set(todos);
    // versões antigas do app leem "atual"
    await db.collection("ranking").doc("atual").set({ mes: mesRef, geradoEm: Date.now(), perfisContados: publicos.size,
      maisLidos: todos.maisLidos.map(x => ({ ...x, capa: x.capa.startsWith("rkcapa:") ? "" : x.capa })),
      melhores: todos.melhores.map(x => ({ ...x, capa: x.capa.startsWith("rkcapa:") ? "" : x.capa })),
      leitores: todos.leitores.slice(0, 10).map(l => ({ uid: l.uid, apelido: l.apelido, lidos: l.concluidos })) });
    console.log(`Todos os tempos recalculado: ${todos.maisLidos.length} mais lidos, ${melhores.length} mais bem avaliados, ${leitores.length} leitores.`);
  } else todos = (await db.collection("ranking").doc("todos").get()).data();

  // 7) "Quem lê": quem tem hoje cada obra das tabelas (só perfis públicos)
  const chaves = new Set([...(todos.maisLidos || []), ...(todos.melhores || [])].map(x => x.chave));
  const quem = {};
  for (const e of entradas) {
    if (!chaves.has(e.chave)) continue;
    const ch = e.chave.replace(/[.\/\[\]*`~]/g, "_");
    (quem[ch] = quem[ch] || []).push({ uid: e.uid, apelido: publicos.get(e.uid).apelido, st: e.st, cap: e.cap, nota: e.nota });
  }
  for (const k in quem) quem[k] = quem[k].sort((a, b) => (b.st === "lendo") - (a.st === "lendo") || a.apelido.localeCompare(b.apelido)).slice(0, 40);
  await db.collection("ranking").doc("quem").set({ geradoEm: Date.now(), mapa: quem });

  const semCapa = [...info.values()].filter(x => !x.capa).map(x => `${x.titulo} [${x.chave}]`);
  if (semCapa.length) console.log("Obras sem capa: " + semCapa.join(" | "));
  console.log(`Pronto. Em alta: ${periodos.alta.length} · Esta semana: ${periodos.semana.length} · Este mês: ${periodos.mes.length}.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
