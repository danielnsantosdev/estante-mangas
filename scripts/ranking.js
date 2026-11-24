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

(async () => {
  const perfis = await db.collection("perfis").where("publico", "==", true).get();
  const obras = new Map();       // chave -> { titulos: Map(nome -> contagem), titulo2, capa, leitores: Set, notas: [] }
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
      const chave = /^(al|mal)\d+$/.test(x.catId || "") ? x.catId : "nome:" + norm(x.title);
      if (!obras.has(chave)) obras.set(chave, { titulos: new Map(), titulo2: "", capa: "", leitores: new Set(), notas: [] });
      const o = obras.get(chave);
      o.titulos.set(x.title, (o.titulos.get(x.title) || 0) + 1);
      if (!o.titulo2 && x.titulo2) o.titulo2 = x.titulo2;
      if (!o.capa && /^https?:\/\//.test(x.cover || "")) o.capa = x.cover;
      if (st === "lendo" || st === "concluido") o.leitores.add(p.id);           // "mais lidos" = Lendo + Concluído
      if (typeof x.nota === "number") o.notas.push(x.nota);
      if (st === "concluido") lidos++;
    }
    if (lidos > 0) leitores.push({ uid: p.id, apelido: pf.apelido, lidos });
  }

  // nomes e capas do catálogo (em português) têm prioridade
  const lista = [];
  for (const [chave, o] of obras) {
    let titulo = [...o.titulos.entries()].sort((a, b) => b[1] - a[1])[0][0], titulo2 = o.titulo2, capa = o.capa;
    if (!chave.startsWith("nome:")) {
      const c = await db.collection("catalogo").doc(chave).get();
      if (c.exists) { const d = c.data(); titulo = d.titulo || titulo; titulo2 = d.titulo2 || titulo2; capa = d.capa || capa; }
    }
    lista.push({ chave, titulo, titulo2: titulo2 || "", capa: capa || "", leitores: o.leitores.size, notas: o.notas.length, media: o.notas.length ? media(o.notas) : 0 });
  }

  const maisLidos = lista.filter(x => x.leitores > 0).sort((a, b) => b.leitores - a.leitores || a.titulo.localeCompare(b.titulo)).slice(0, 10)
    .map(({ chave, titulo, titulo2, capa, leitores }) => ({ chave, titulo, titulo2, capa, leitores }));
  const melhores = lista.filter(x => x.notas >= 2).sort((a, b) => b.media - a.media || b.notas - a.notas).slice(0, 10)
    .map(({ chave, titulo, titulo2, capa, media, notas }) => ({ chave, titulo, titulo2, capa, media, notas }));
  const topLeitores = leitores.sort((a, b) => b.lidos - a.lidos || a.apelido.localeCompare(b.apelido)).slice(0, 10);

  const agora = new Date(Date.now() - 3 * 3600e3); // horário de Brasília
  const mes = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, "0")}`;
  const dados = { mes, geradoEm: Date.now(), perfisContados: contados, maisLidos, melhores, leitores: topLeitores };
  await db.collection("ranking").doc("atual").set(dados);
  await db.collection("ranking").doc(mes).set(dados);
  console.log(`Ranking de ${mes} gerado com ${contados} perfis públicos.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
