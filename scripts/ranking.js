// Ranking mensal da Estante de Mangás.
// Roda no GitHub todo dia 1º (ou manualmente na aba Actions) e grava o resultado no Firebase.
// Só entram perfis PÚBLICOS e não ocultos. O app apenas lê o resultado pronto.
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
async function buscaCatalogo(titulo) { return (await buscaAniList(titulo)) || (await buscaMAL(titulo)); }
async function buscaAniList(titulo) {
  const query = `query($q:String){Page(perPage:5){media(search:$q,type:MANGA,isAdult:false,sort:SEARCH_MATCH){id idMal title{romaji english native} synonyms coverImage{large}}}}`;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables: { q: titulo } }) });
      if (r.status === 429) { await sleep((Number(r.headers.get("retry-after")) || 30) * 1000 + 500); continue; }
      if (!r.ok) { console.log(`AniList respondeu ${r.status} para "${titulo}"`); return null; }
      const j = await r.json();
      const lista = (j.data && j.data.Page && j.data.Page.media) || [];
      const m = lista.find(x => [x.title.romaji, x.title.english, x.title.native, ...(x.synonyms || [])].some(n => parecido(n, titulo)));
      if (!m) { console.log(`AniList: nada parecido com "${titulo}" (veio: ${lista.map(x => x.title.english || x.title.romaji).join(" / ")})`); return null; }
      return { chave: m.idMal ? "mal" + m.idMal : "al" + m.id, titulo: (m.title.romaji || m.title.english || "").trim(), titulo2: (m.title.english || "").trim(), capa: (m.coverImage && m.coverImage.large) || "" };
    } catch (e) { await sleep(1500); }
  }
  return null;
}

(async () => {
  const perfis = await db.collection("perfis").where("publico", "==", true).get();
  const entradas = [];   // um item por mangá de cada leitor
  const leitores = [];
  let contados = 0;

  for (const p of perfis.docs) {
    const pf = p.data() || {};
    if (pf.oculto === true || !pf.apelido) continue;
    contados++;
    const ms = await db.collection("users").doc(p.id).collection("mangas").get();
    let lidos = 0;
    for (const m of ms.docs) {
      const x = m.data() || {};
      const st = x.status === "acumulando" ? "pausado" : x.status;
      const cv = String(x.cover || "");
      entradas.push({ uid: p.id, title: String(x.title || "").trim(), catId: /^(al|mal)\d+$/.test(x.catId || "") ? x.catId : "", st,
        nota: typeof x.nota === "number" ? x.nota : null,
        capa: /^https?:\/\//.test(cv) || (/^data:image\//.test(cv) && cv.length < 120000) ? cv : "" });
      if (st === "concluido") lidos++;
    }
    if (lidos > 0) leitores.push({ uid: p.id, apelido: pf.apelido, lidos });
  }

  // 1) mangás sem vínculo: procura no catálogo pelo nome (uma vez por nome)
  const porNome = new Map();
  for (const e of entradas) if (!e.catId && e.title && !porNome.has(norm(e.title))) porNome.set(norm(e.title), e.title);
  const achados = new Map();
  for (const [k, titulo] of porNome) { achados.set(k, await buscaCatalogo(titulo)); await sleep(2200); }
  for (const e of entradas) if (!e.catId) { const a = achados.get(norm(e.title)); if (a) { e.catId = a.chave; e.aniList = a; } }

  // 2) agrupa por obra
  const obras = new Map();
  for (const e of entradas) {
    const chave = e.catId || "nome:" + norm(e.title);
    if (!obras.has(chave)) obras.set(chave, { titulos: new Map(), capa: "", aniList: null, leitores: new Set(), notas: [] });
    const o = obras.get(chave);
    o.titulos.set(e.title, (o.titulos.get(e.title) || 0) + 1);
    if (!o.capa && e.capa) o.capa = e.capa;
    if (!o.aniList && e.aniList) o.aniList = e.aniList;
    if (e.st === "lendo" || e.st === "concluido") o.leitores.add(e.uid);           // "mais lidos" = Lendo + Concluído
    if (e.nota !== null) o.notas.push(e.nota);
  }

  // 3) nome e capa: catálogo do app primeiro, depois AniList, por último o que o leitor colocou
  const lista = [];
  for (const [chave, o] of obras) {
    const digitado = [...o.titulos.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let titulo = digitado, titulo2 = "", capa = "";
    if (!chave.startsWith("nome:")) {
      const c = await db.collection("catalogo").doc(chave).get();
      if (c.exists) { const d = c.data(); titulo = d.titulo2 || d.titulo || titulo; capa = d.capa || ""; }
      else if (o.aniList) { titulo = o.aniList.titulo2 || o.aniList.titulo || titulo; capa = o.aniList.capa; }
      else {
        const a = await buscaCatalogo(digitado); await sleep(2200);
        if (a && a.chave === chave) { titulo = a.titulo2 || a.titulo || titulo; capa = a.capa; }
      }
    }
    if (!capa) capa = o.capa;
    if (norm(digitado) !== norm(titulo)) titulo2 = digitado;
    lista.push({ chave, titulo, titulo2, capa: capa || "", leitores: o.leitores.size, notas: o.notas.length, media: o.notas.length ? media(o.notas) : 0 });
  }

  const maisLidos = lista.filter(x => x.leitores > 0).sort((a, b) => b.leitores - a.leitores || a.titulo.localeCompare(b.titulo)).slice(0, 10)
    .map(({ chave, titulo, titulo2, capa, leitores }) => ({ chave, titulo, titulo2, capa, leitores }));
  const melhores = lista.filter(x => x.notas >= 2).sort((a, b) => b.media - a.media || b.notas - a.notas).slice(0, 10)
    .map(({ chave, titulo, titulo2, capa, media, notas }) => ({ chave, titulo, titulo2, capa, media, notas }));
  const topLeitores = leitores.sort((a, b) => b.lidos - a.lidos || a.apelido.localeCompare(b.apelido)).slice(0, 10);

  const agora = new Date(Date.now() - 3 * 3600e3); // horário de Brasília
  const mes = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, "0")}`;
  const semCapa = lista.filter(x => !x.capa).map(x => `${x.titulo} [${x.chave}]`);
  const dados = { mes, geradoEm: Date.now(), perfisContados: contados, maisLidos, melhores, leitores: topLeitores };
  await db.collection("ranking").doc("atual").set(dados);
  await db.collection("ranking").doc(mes).set(dados);
  console.log(`Ranking de ${mes} gerado com ${contados} perfis públicos e ${lista.length} obras.`);
  if (semCapa.length) console.log("Obras sem capa (não achadas no AniList nem no MyAnimeList): " + semCapa.join(" | "));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
