// Sinopses do catálogo: exporta para revisão e grava as revisadas.
//  - exportar: lê sinopses/pedido.json ({ "buscar": [...] } ou { "todas": true }) e salva sinopses/atual.json
//  - gravar:   lê sinopses/revisadas.json ({ chave: "texto" }) e grava no catálogo, marcando como revisada
// Roda no GitHub (aba Actions → "Sinopses"), com a chave guardada no segredo FIREBASE_SA.
const fs = require("fs");
const path = require("path");
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

const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const PASTA = path.join(__dirname, "..", "sinopses");

async function exportar() {
  const pedido = JSON.parse(fs.readFileSync(path.join(PASTA, "pedido.json"), "utf8"));
  const termos = (pedido.buscar || []).map(norm);
  const snap = await db.collection("catalogo").get();
  const saida = {};
  snap.forEach(d => {
    const c = d.data() || {};
    const nomes = norm([c.titulo, c.titulo2, ...(c.nomes || [])].join(" | "));
    if (!pedido.todas && !termos.some(t => nomes.includes(t))) return;
    saida[d.id] = { titulo: c.titulo || "", titulo2: c.titulo2 || "", tipo: c.tipo || "", sinopse: c.sinopse || "", sinopseOrig: c.sinopseOrig || "", revisada: !!c.sinopseRevisada };
  });
  fs.writeFileSync(path.join(PASTA, "atual.json"), JSON.stringify(saida, null, 2) + "\n");
  console.log(`Catálogo: ${snap.size} obras; ${Object.keys(saida).length} exportadas.`);
}

async function gravar() {
  const arq = path.join(PASTA, "revisadas.json");
  if (!fs.existsSync(arq)) { console.log("Nenhuma sinopse revisada para gravar."); return; }
  const novas = JSON.parse(fs.readFileSync(arq, "utf8"));
  let n = 0, lote = db.batch();
  for (const [k, txt] of Object.entries(novas)) {
    if (typeof txt !== "string" || txt.trim().length < 20) continue;
    lote.set(db.collection("catalogo").doc(k), { sinopse: txt.trim().slice(0, 4000), sinopseRevisada: true, atualizadoEm: Date.now() }, { merge: true });
    if (++n % 400 === 0) { await lote.commit(); lote = db.batch(); }
  }
  if (n % 400) await lote.commit();
  console.log(`${n} sinopses revisadas gravadas no catálogo.`);
}

(async () => {
  if (process.env.MODO === "gravar") await gravar(); else await exportar();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
