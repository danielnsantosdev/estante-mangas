// Tradução com o DeepL: sinopses do catálogo que vieram do tradutor gratuito (têm o original em inglês
// e ainda não foram revisadas) são retraduzidas para português do Brasil. Roda de hora em hora no GitHub.
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

async function deepl(textos) {
  const key = String(process.env.DEEPL_KEY || "").trim();
  if (!key) throw new Error("Segredo DEEPL_KEY não encontrado.");
  const url = key.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
  const r = await fetch(url, { method: "POST", headers: { Authorization: "DeepL-Auth-Key " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ text: textos, target_lang: "PT-BR", source_lang: "EN", formality: "prefer_less" }) });
  if (!r.ok) throw new Error("DeepL respondeu " + r.status + " " + (await r.text()).slice(0, 200));
  return ((await r.json()).translations || []).map(t => t.text || "");
}

(async () => {
  if (process.env.MODO === "teste") {
    const [t] = await deepl(["Ten years ago, gates connecting our world to a world of monsters began to open."]);
    console.log("DeepL funcionando: " + t);
    process.exit(0);
  }
  const snap = await db.collection("catalogo").get();
  const fila = snap.docs.filter(d => { const c = d.data() || {}; return c.sinopseOrig && !c.sinopseRevisada && !c.sinopseDeepl; }).slice(0, 40);
  let n = 0;
  for (const d of fila) {
    try {
      const [t] = await deepl([String(d.data().sinopseOrig).slice(0, 4000)]);
      if (t && t.trim().length > 20) { await d.ref.set({ sinopse: t.trim().slice(0, 4000), sinopseDeepl: true, atualizadoEm: Date.now() }, { merge: true }); n++; }
    } catch (e) { console.log(d.id + ": " + e.message); if (/456|403/.test(e.message)) break; }
  }
  console.log(`Catálogo: ${snap.size} obras; ${n} sinopses traduzidas com o DeepL.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
