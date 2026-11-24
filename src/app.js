// Estante de Mangás — app (Android/Windows) com Firebase: login por e-mail/senha + Firestore
import { initializeApp } from "firebase/app";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, onAuthStateChanged, signOut, reload,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword, deleteUser,
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, writeBatch,
  query, where, addDoc, updateDoc, deleteField,
  terminate, clearIndexedDbPersistence,
} from "firebase/firestore";
import { firebaseConfig, adminEmail, downloadUrl } from "./firebase-config.js";

const STATUS = {
  lendo:      { label: "Lendo" },
  fila:       { label: "Na fila" },
  pausado:    { label: "Pausado" },
  concluido:  { label: "Concluído" },
};
const $ = (s) => document.querySelector(s);
// Status antigo "acumulando" agora conta como "pausado".
const stOf = (it) => it && it.status === "acumulando" ? "pausado" : (it && STATUS[it.status] ? it.status : "lendo");
const show = (id) => ["setupScreen", "loginScreen", "verifyScreen", "deniedScreen", "appScreen"].forEach(x => $("#" + x).classList.toggle("hidden", x !== id));

let items = new Map();          // id -> mangá
const pending = new Map();      // id -> timer (alterações ainda não enviadas)
let col = null, unsub = null, loaded = false, currentUser = null;
let netState = { pendingWrites: false, fromCache: true };
let savedSort = "recent"; try { savedSort = localStorage.getItem("estante-sort") || "recent"; } catch (e) {}
const ui = { filter: "todos", q: "", sort: savedSort, visit: null };   // visit = estante de outra pessoa aberta
let myProfile = null;            // { apelido, publico }
let myAvals = {};                // notas que visitantes deram nos MEUS mangás: { idMangá: { idVisitante: {nota, apelido, em} } }
let extraUnsubs = [];
$("#sort").value = ui.sort;

// ---------- utilidades ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fmtCap = (n) => { n = Number(n) || 0; return Number.isInteger(n) ? String(n) : String(n).replace(".", ","); };
const parseCap = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0; };
const NOTAS = Array.from({ length: 19 }, (_, i) => 1 + i * 0.5);           // 1; 1,5; … 10
const fmtNota = (n) => Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
const parseNota = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) && n >= 1 && n <= 10 ? Math.round(n * 2) / 2 : null; };
const media = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;
function relTime(ms) {
  // "lido" some no celular (classe .lw) para caber no card compacto
  if (!ms) return "";
  const L = '<span class="lw">lido </span>';
  const d = (Date.now() - ms) / 86400000;
  if (d < 1) return L + "hoje";
  if (d < 2) return L + "ontem";
  if (d < 30) return `${L}há ${Math.floor(d)} dias`;
  const m = Math.floor(d / 30.4);
  if (m < 12) return m === 1 ? L + "há 1 mês" : `${L}há ${m} meses`;
  const y = Math.floor(d / 365);
  return y === 1 ? L + "há 1 ano" : `${L}há ${y} anos`;
}
function fixLink(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (e) { return ""; }
}
let toastT;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms);
}
function updateSync() {
  const el = $("#sync"), txt = el.querySelector(".txt");
  if (!navigator.onLine) { el.className = "sync local"; txt.textContent = "Offline · salvo no aparelho"; return; }
  if (pending.size || netState.pendingWrites) { el.className = "sync saving"; txt.textContent = "Salvando…"; return; }
  if (netState.fromCache) { el.className = "sync"; txt.textContent = "Conectando…"; return; }
  el.className = "sync ok"; txt.textContent = "Sincronizado";
}
window.addEventListener("online", updateSync);
window.addEventListener("offline", updateSync);

// ---------- Firebase ----------
const ADMIN = String(adminEmail || "").trim().toLowerCase();
const isAdmin = (u) => !!u && !!u.emailVerified && String(u.email || "").toLowerCase() === ADMIN && !!ADMIN;
const configured = firebaseConfig && firebaseConfig.apiKey && !/COLE|SEU_/i.test(firebaseConfig.apiKey);
let auth, db;
if (!configured) show("setupScreen");
else {
  const app = initializeApp(firebaseConfig);
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    experimentalAutoDetectLongPolling: true,
  });
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (unsub) { unsub(); unsub = null; }
    items = new Map(); loaded = false;
    if (!user) { show("loginScreen"); return; }
    if (!user.emailVerified) { $("#verifyEmail").textContent = user.email; show("verifyScreen"); return; }
    checkInvite(user);
  });
}

// ---------- login por e-mail e senha ----------
let authMode = "login";
function setAuthMode(m) {
  authMode = m;
  document.querySelectorAll("#authTabs .chip").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  const su = m === "signup";
  $("#pass2Wrap").classList.toggle("hidden", !su);
  $("#authBtn").textContent = su ? "Criar minha senha" : "Entrar";
  $("#forgotBtn").classList.toggle("hidden", su);
  $("#authHint").textContent = su
    ? "Primeira vez? Use o e-mail que foi liberado para você e crie uma senha (mínimo 6 caracteres)."
    : "Entre com seu e-mail e senha.";
  $("#loginForm [name=pass]").autocomplete = su ? "new-password" : "current-password";
  $("#loginErr").textContent = "";
}
$("#authTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setAuthMode(b.dataset.mode); });
function authMsg(e) {
  const c = (e && e.code) || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "E-mail ou senha incorretos. Se é sua primeira vez, use a aba \"Primeiro acesso\".";
  if (c.includes("email-already-in-use")) return "Esse e-mail já tem senha. Use \"Entrar\" (ou \"Esqueci a senha\").";
  if (c.includes("weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  if (c.includes("invalid-email")) return "Esse e-mail não parece válido.";
  if (c.includes("too-many-requests")) return "Muitas tentativas. Espere alguns minutos e tente de novo.";
  if (c.includes("network")) return "Sem internet. Conecte-se para entrar.";
  if (c.includes("operation-not-allowed")) return "O login por e-mail ainda não foi ativado no servidor (Firebase → Authentication).";
  return "Não foi possível continuar (" + c + ").";
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, email = f.email.value.trim().toLowerCase(), pass = f.pass.value;
  const err = $("#loginErr"); err.textContent = "";
  const btn = $("#authBtn"); btn.disabled = true;
  try {
    if (authMode === "signup") {
      if (pass !== f.pass2.value) { err.textContent = "As senhas não são iguais."; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      try { await sendEmailVerification(cred.user); } catch (x) {}
    } else await signInWithEmailAndPassword(auth, email, pass);
  } catch (x) { err.textContent = authMsg(x); }
  finally { btn.disabled = false; }
});
$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#loginForm").email.value.trim();
  if (!email) { $("#loginErr").textContent = "Digite seu e-mail acima e toque de novo em \"Esqueci a senha\"."; return; }
  try { await sendPasswordResetEmail(auth, email); toast("Se esse e-mail tiver conta, enviamos um link para criar nova senha.", 5000); }
  catch (x) { $("#loginErr").textContent = authMsg(x); }
});
$("#verifiedBtn").addEventListener("click", async () => {
  if (!currentUser) return;
  $("#verifyErr").textContent = "";
  try {
    await reload(currentUser);
    if (currentUser.emailVerified) { await currentUser.getIdToken(true); checkInvite(currentUser); }
    else $("#verifyErr").textContent = "Ainda não aparece como confirmado. Clique no link do e-mail e tente de novo.";
  } catch (x) { $("#verifyErr").textContent = authMsg(x); }
});
$("#resendBtn").addEventListener("click", async () => {
  try { await sendEmailVerification(currentUser); toast("E-mail reenviado!"); } catch (x) { $("#verifyErr").textContent = authMsg(x); }
});

// ---------- lista de convidados ----------
// Quem decide de verdade é o servidor (firestore.rules). Esta checagem só mostra
// uma tela amigável para quem ainda não foi liberado.
async function checkInvite(user) {
  const email = String(user.email || "").toLowerCase();
  let invited = null;
  if (isAdmin(user)) invited = true;
  else {
    try {
      const cd = email ? await getDoc(doc(db, "convidados", email)) : null;
      invited = !!(cd && cd.exists());
      if (invited && (cd.data() || {}).uid !== user.uid) updateDoc(doc(db, "convidados", email), { uid: user.uid }).catch(() => {});
    }
    catch (e) { invited = (e.code === "unavailable") ? null : false; } // sem internet: abre com o que está no aparelho
  }
  if (currentUser !== user) return;
  if (invited === false) { $("#deniedEmail").textContent = email || "(sem e-mail)"; show("deniedScreen"); return; }
  show("appScreen");
  startSync(user.uid);
  checkUpdate();
}

// ---------- aviso de versão nova ----------
let updateChecked = false;
async function checkUpdate() {
  if (updateChecked) return; updateChecked = true;
  const mine = Number(window.APP_VERSION || 0);
  const m = String(downloadUrl || "").match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!mine || !m) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) return;
    const j = await r.json();
    const latest = parseInt(String(j.tag_name || "").split(".").pop(), 10);
    if (latest > mine) {
      const b = $("#banner");
      b.innerHTML = `📦 Tem versão nova do app (v1.${latest}). <a href="${esc(downloadUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit;font-weight:800">Baixar agora ↗</a>`;
      b.classList.add("show");
    }
  } catch (e) {}
}
async function fullSignOut() {
  // Sai da conta e apaga a cópia local dos dados neste aparelho.
  try { await signOut(auth); } catch (e) {}
  try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) {}
  location.reload();
}
$("#retryBtn").addEventListener("click", () => currentUser && checkInvite(currentUser));
$("#deniedOut").addEventListener("click", fullSignOut);
$("#verifyOut").addEventListener("click", fullSignOut);

function startSync(uid) {
  col = collection(db, "users", uid, "mangas");
  extraUnsubs.forEach(f => { try { f(); } catch (e) {} }); extraUnsubs = [];
  extraUnsubs.push(onSnapshot(doc(db, "perfis", uid), (d) => {
    myProfile = d.exists() ? d.data() : null; updateMeBtn();
    // perfil antigo sem o campo "oculto", ou reativado pelo administrador: volta a aparecer
    if (myProfile && myProfile.apelido && (myProfile.oculto !== false || !myProfile.membroDesde) && !(d.metadata && d.metadata.fromCache))
      setDoc(doc(db, "perfis", uid), perfilData({})).catch(() => {});
  }, () => {}));
  extraUnsubs.push(onSnapshot(collection(db, "users", uid, "avaliacoes"), (snap) => {
    const m = {}; snap.forEach(d => { m[d.id] = (d.data() || {}).notas || {}; }); myAvals = m; updateBell();
  }, () => {}));
  try { if (!localStorage.getItem(AVAL_KEY)) localStorage.setItem(AVAL_KEY, String(Date.now())); } catch (e) {}
  limparLixeira(uid);
  render();
  const slowT = setTimeout(() => {
    if (!loaded) { loaded = true; render(); }
  }, 8000);
  unsub = onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
    const next = new Map();
    snap.forEach(d => next.set(d.id, { id: d.id, ...d.data() }));
    for (const id of pending.keys()) { if (items.has(id)) next.set(id, items.get(id)); else next.delete(id); }
    items = next;
    netState = { pendingWrites: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache };
    if (!snap.metadata.fromCache || snap.size) { loaded = true; clearTimeout(slowT); }
    if (!snap.metadata.fromCache) setTimeout(checkNewChapters, 1500);
    render(); updateSync();
  }, (err) => {
    clearTimeout(slowT); loaded = true;
    const b = $("#banner");
    b.textContent = err.code === "permission-denied"
      ? "Acesso recusado pelo servidor: sua conta não está (ou não está mais) na lista de convidados."
      : "A sincronização parou. Feche e abra o app de novo.";
    b.classList.add("show"); render();
  });
}

// ---------- gravação ----------
const FIELDS = ["title", "chapter", "status", "link", "cover", "createdAt", "updatedAt", "lastReadAt"];
function safeCover(c) {
  c = String(c || "");
  if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(c) && c.length <= 400000) return c;
  return /^https?:\/\//i.test(c) && c.length <= 2000 ? c : "";
}
// Limpa e valida um mangá antes de gravar (o servidor valida de novo).
function clean(it) {
  const now = Date.now();
  const o = {
    title: String(it.title || "").trim().slice(0, 120) || "Sem nome",
    titulo2: String(it.titulo2 || "").trim().slice(0, 200),
    catId: /^(al|mal)[0-9]{1,10}$/.test(String(it.catId || "")) ? String(it.catId) : "",
    chapter: Math.min(99999, parseCap(it.chapter)),
    status: stOf(it),
    link: fixLink(it.link).slice(0, 2000),
    cover: safeCover(it.cover),
    nota: parseNota(it.nota),
    comentario: String(it.comentario || "").trim().slice(0, 300),
  };
  for (const k of ["createdAt", "updatedAt", "lastReadAt"]) { const n = Number(it[k]); o[k] = isFinite(n) && n > 0 ? n : now; }
  return o;
}
const strip = (it) => clean(it);
function scheduleWrite(id, delay = 500) {
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => flush(id), delay));
  updateSync();
}
function flush(id) {
  pending.delete(id);
  const it = items.get(id);
  // O Firestore guarda no aparelho na hora e envia quando houver internet.
  const p = it ? setDoc(doc(col, id), strip(it)) : deleteDoc(doc(col, id));
  p.catch(e => {
    if (e.code === "invalid-argument" || e.code === "resource-exhausted") toast("Não foi possível salvar: a imagem é grande demais.", 4000);
    else if (e.code === "permission-denied") toast("O servidor recusou salvar. Confira se as regras novas foram publicadas no Firebase.", 5000);
    else toast("Falha ao salvar — tente de novo.", 3000);
  });
  updateSync();
}
function commit(id, patch) {
  const old = items.get(id); if (!old) return;
  items.set(id, { ...old, ...patch, updatedAt: Date.now() });
  render(); scheduleWrite(id);
}
function create(data) {
  const id = doc(col).id; const now = Date.now();
  items.set(id, { id, createdAt: now, updatedAt: now, lastReadAt: now, ...data });
  render(); scheduleWrite(id, 0);
}
function remove(id) {
  // Não apaga de vez: vai para a lixeira por 30 dias
  const it = items.get(id); if (!it) return;
  clearTimeout(pending.get(id)); pending.delete(id);
  items.delete(id); render();
  const b = writeBatch(db);
  b.set(doc(db, "users", currentUser.uid, "lixeira", id), { ...clean(it), excluidoEm: Date.now() });
  b.delete(doc(col, id));
  b.commit().catch(() => toast("Não foi possível mover para a lixeira agora."));
}

// ---------- capítulos novos (confere ao abrir o app) ----------
// Guarda, por aparelho, o último capítulo encontrado no site e o que já foi "visto" (ao tocar em Ler).
const CHK_KEY = "estante-chk-v1";
let chk = {};
try { chk = JSON.parse(localStorage.getItem(CHK_KEY) || "{}") || {}; } catch (e) { chk = {}; }
const saveChk = () => { try { localStorage.setItem(CHK_KEY, JSON.stringify(chk)); } catch (e) {} };
const canFetchSites = () => !!(window.estanteNative || isNativeApp);
async function fetchPage(url) {
  // PC: pede ao app (Electron). Celular: usa o acesso nativo do Android só para esta consulta,
  // sem mexer na conexão do banco de dados.
  const nativeHttp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  const job = window.estanteNative ? window.estanteNative.fetchText(url)
    : nativeHttp ? nativeHttp.request({ url, method: "GET", headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36" }, responseType: "text" })
        .then(r => { if (r.status >= 400) throw new Error("http"); return typeof r.data === "string" ? r.data : JSON.stringify(r.data || ""); })
    : fetch(url, { headers: { Accept: "text/html" } }).then(r => { if (!r.ok) throw new Error("http"); return r.text(); });
  return Promise.race([job, new Promise((_, rej) => setTimeout(() => rej(new Error("tempo")), 15000))]);
}
// Procura o maior número de capítulo na página (links "capitulo-427" e textos "Capítulo 427").
function latestFromHtml(html) {
  let max = null;
  const add = (n) => { n = parseFloat(String(n).replace(",", ".")); if (isFinite(n) && n > 0 && n < 100000 && (max === null || n > max)) max = n; };
  for (const m of html.matchAll(/href\s*=\s*["'][^"']*?(?:cap(?:itulo)?|chapter|chap)[-_/.]?(\d{1,5})(?:[-.](\d{1,2}))?(?=[/"'?#]|$)/gi)) add(m[2] ? m[1] + "." + m[2] : m[1]);
  for (const m of html.matchAll(/(?:cap[íi]tulo|cap\.|chapter|ch\.)\s*(\d{1,5}(?:[.,]\d{1,2})?)/gi)) add(m[1]);
  return max;
}
let checkStarted = false;
async function checkNewChapters() {
  if (checkStarted || !canFetchSites()) return; checkStarted = true;
  const now = Date.now();
  const list = [...items.values()].filter(it => fixLink(it.link) && stOf(it) !== "concluido" && stOf(it) !== "fila" && !(chk[it.id] && now - (chk[it.id].t || 0) < 3 * 3600e3));
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const it = list[i++];
      try {
        const n = latestFromHtml(await fetchPage(fixLink(it.link)));
        if (n == null) continue;
        const c = chk[it.id] || {};
        if (c.seen == null) c.seen = n;      // primeira vez: só marca a referência
        c.latest = n; c.t = Date.now(); chk[it.id] = c;
        saveChk(); render();
      } catch (e) { /* site não deixou ler: ignora em silêncio */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
function unreadBadge(it) {
  const c = chk[it.id]; const cur = Number(it.chapter) || 0;
  if (!c || c.latest == null || c.seen == null) return 0;
  return (c.latest > c.seen && c.latest > cur) ? Math.ceil(c.latest - cur) : 0;
}

// ---------- catálogo: AniList (principal) + MyAnimeList (reserva) + MangaDex (português) ----------
async function httpReq(url, { method = "GET", headers = {}, body } = {}) {
  if (window.estanteNative && window.estanteNative.http) return window.estanteNative.http({ url, method, headers, body });
  const nh = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (nh) {
    const r = await nh.request({ url, method, headers, data: body ? JSON.parse(body) : undefined, responseType: "text" });
    if (r.status >= 400) throw new Error("http " + r.status);
    return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  }
  const r = await fetch(url, { method, headers, body });
  if (!r.ok) throw new Error("http " + r.status);
  return r.text();
}
const httpJSON = async (url, opt) => JSON.parse(await httpReq(url, opt));
// Gêneros sempre em português (o que não estiver na lista não aparece)
const GENEROS = {
  "Action": "Ação", "Adventure": "Aventura", "Comedy": "Comédia", "Drama": "Drama", "Ecchi": "Ecchi", "Fantasy": "Fantasia",
  "Horror": "Terror", "Mahou Shoujo": "Garota mágica", "Mecha": "Mecha", "Music": "Música", "Mystery": "Mistério",
  "Psychological": "Psicológico", "Romance": "Romance", "Sci-Fi": "Ficção científica", "Slice of Life": "Cotidiano",
  "Sports": "Esportes", "Supernatural": "Sobrenatural", "Thriller": "Suspense", "Suspense": "Suspense", "Avant Garde": "Vanguarda",
  "Award Winning": "Premiado", "Boys Love": "Yaoi (BL)", "Girls Love": "Yuri (GL)", "Gourmet": "Culinária", "Shounen": "Shounen",
  "Seinen": "Seinen", "Shoujo": "Shoujo", "Josei": "Josei", "Isekai": "Isekai", "Historical": "Histórico", "Martial Arts": "Artes marciais",
  "Military": "Militar", "School": "Escolar", "Super Power": "Superpoderes", "Harem": "Harém", "Reverse Harem": "Harém reverso",
  "Reincarnation": "Reencarnação", "Time Travel": "Viagem no tempo", "Workplace": "Trabalho", "Survival": "Sobrevivência",
  "Love Polygon": "Triângulo amoroso", "Vampire": "Vampiros", "Mythology": "Mitologia", "Gore": "Violência explícita",
  "Detective": "Detetive", "Samurai": "Samurais", "Space": "Espaço", "Strategy Game": "Estratégia", "Video Game": "Videogame",
  "Villainess": "Vilã", "Iyashikei": "Iyashikei", "Adult Cast": "Elenco adulto", "Anthropomorphic": "Antropomórfico",
  "CGDCT": "Garotas fofas", "Childcare": "Criação de filhos", "Combat Sports": "Esportes de combate", "Delinquents": "Delinquentes",
  "Educational": "Educativo", "Gag Humor": "Humor", "High Stakes Game": "Jogos de alto risco", "Idols (Female)": "Ídolos",
  "Idols (Male)": "Ídolos", "Medical": "Medicina", "Organized Crime": "Crime organizado", "Otaku Culture": "Cultura otaku",
  "Performing Arts": "Artes cênicas", "Pets": "Animais de estimação", "Racing": "Corrida", "Romantic Subtext": "Romance sutil",
  "Showbiz": "Mundo artístico", "Team Sports": "Esportes em equipe", "Visual Arts": "Artes visuais", "Urban Fantasy": "Fantasia urbana",
  "Magical Sex Shift": "Troca de gênero", "Crossdressing": "Crossdressing", "Memoir": "Memórias", "Kids": "Infantil",
};
const generosPT = (lista) => [...new Set((lista || []).map(g => GENEROS[g]).filter(Boolean))].slice(0, 12);
const TIPO = { JP: "Mangá", KR: "Manhwa", CN: "Manhua", TW: "Manhua" };
const decodeHTML = (s) => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };
function limpaSinopse(s) {
  return decodeHTML(String(s || ""))
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/~!.*?!~/gs, "")
    .replace(/\((Source|Fonte)[^)]*\)/gi, "").replace(/\[Written by[^\]]*\]/gi, "").replace(/__|\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, 3500);
}
async function buscaAniList(q) {
  const query = `query($q:String){Page(perPage:10){media(search:$q,type:MANGA,isAdult:false,sort:SEARCH_MATCH){id idMal title{romaji english native} coverImage{large} genres description(asHtml:false) countryOfOrigin format}}}`;
  const j = await httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables: { q } }) });
  return ((j.data && j.data.Page && j.data.Page.media) || []).filter(m => m.format !== "NOVEL").map(m => ({
    key: m.idMal ? "mal" + m.idMal : "al" + m.id, alId: m.id, malId: m.idMal || null,
    original: (m.title.romaji || m.title.english || "").trim(), ingles: (m.title.english || "").trim(),
    capa: (m.coverImage && m.coverImage.large) || "", generos: generosPT(m.genres), desc: m.description || "",
    tipo: TIPO[m.countryOfOrigin] || "Mangá",
  }));
}
async function buscaMAL(q) {
  const j = await httpJSON(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(q)}&limit=10&sfw=true`);
  return (j.data || []).filter(m => !/novel/i.test(m.type || "")).map(m => ({
    key: "mal" + m.mal_id, alId: null, malId: m.mal_id,
    original: (m.title || "").trim(), ingles: (m.title_english || "").trim(),
    capa: (m.images && m.images.jpg && m.images.jpg.large_image_url) || "",
    generos: generosPT([...(m.genres || []), ...(m.themes || []), ...(m.demographics || [])].map(g => g.name)),
    desc: m.synopsis || "", tipo: /manhwa/i.test(m.type || "") ? "Manhwa" : /manhua/i.test(m.type || "") ? "Manhua" : "Mangá",
  }));
}
async function buscaCatalogo(q) {
  let r = [];
  try { r = await buscaAniList(q); } catch (e) {}
  if (!r.length) { try { r = await buscaMAL(q); } catch (e) {} }
  return r;
}
// Tradução automática (inglês → português), em pedaços de até ~450 caracteres
async function traduzPT(texto) {
  texto = String(texto || "").trim(); if (!texto) return "";
  const partes = []; let atual = "";
  for (const frase of texto.split(/(?<=[.!?])\s+|\n+/)) {
    if ((atual + " " + frase).length > 450) { if (atual) partes.push(atual); atual = frase.slice(0, 450); }
    else atual = atual ? atual + " " + frase : frase;
  }
  if (atual) partes.push(atual);
  const out = [];
  for (const p of partes) {
    const j = await httpJSON(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(p)}&langpair=en|pt-BR`);
    const t = j && j.responseData && j.responseData.translatedText;
    if (!t || Number(j.responseStatus) !== 200 || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) throw new Error("tradução indisponível");
    out.push(decodeHTML(t));
  }
  return out.join(" ").replace(/\s+\n/g, "\n").trim();
}
// Procura no MangaDex o mesmo mangá, para pegar nome e sinopse em português quando existirem
async function mangaDexPT(r) {
  try {
    const j = await httpJSON(`https://api.mangadex.org/manga?limit=10&title=${encodeURIComponent(r.original)}&contentRating[]=safe&contentRating[]=suggestive`);
    const m = (j.data || []).find(x => { const l = (x.attributes && x.attributes.links) || {}; return (r.alId && String(l.al) === String(r.alId)) || (r.malId && String(l.mal) === String(r.malId)); });
    if (!m) return {};
    const alt = (m.attributes.altTitles || []).find(t => t["pt-br"]);
    return { titulo: alt ? alt["pt-br"] : "", sinopse: (m.attributes.description || {})["pt-br"] || "" };
  } catch (e) { return {}; }
}
const catCache = {};
async function lerCatalogo(key) {
  if (!key) return null;
  if (catCache[key]) return catCache[key];
  try { const d = await getDoc(doc(db, "catalogo", key)); if (d.exists()) return (catCache[key] = d.data()); } catch (e) {}
  return null;
}
// Garante que o mangá escolhido está no catálogo compartilhado, já em português
async function prepararCatalogo(r) {
  const salvo = await lerCatalogo(r.key);
  if (salvo) return salvo;
  const pt = await mangaDexPT(r);
  const orig = limpaSinopse(r.desc);
  let sinopse = limpaSinopse(pt.sinopse || "");
  if (!sinopse && orig) { try { sinopse = await traduzPT(orig); } catch (e) { sinopse = ""; } }
  const titulo2 = (pt.titulo && norm(pt.titulo) !== norm(r.original) ? pt.titulo : (r.ingles && norm(r.ingles) !== norm(r.original) ? r.ingles : "")).slice(0, 200);
  const c = { titulo: r.original.slice(0, 200), titulo2, generos: r.generos, sinopse: sinopse.slice(0, 4000), sinopseOrig: sinopse ? "" : orig.slice(0, 4000),
    capa: String(r.capa || "").slice(0, 500), tipo: r.tipo, alId: r.alId || null, malId: r.malId || null, atualizadoEm: Date.now() };
  try { await setDoc(doc(db, "catalogo", r.key), c); } catch (e) {}
  return (catCache[r.key] = c);
}
// Tenta completar uma sinopse que ficou pendente (sem nunca mostrar inglês)
async function completarSinopse(key, c) {
  if (!c || c.sinopse || !c.sinopseOrig) return c;
  try {
    const s = (await traduzPT(c.sinopseOrig)).slice(0, 4000);
    if (s) { await updateDoc(doc(db, "catalogo", key), { sinopse: s, atualizadoEm: Date.now() }); c = { ...c, sinopse: s }; catCache[key] = c; }
  } catch (e) {}
  return c;
}
// Componente de busca no catálogo (usado no "Novo mangá" e no "Vincular ao catálogo")
function montarBuscaCatalogo(root, inicial, aoEscolher) {
  const box = root.querySelector("#catBox");
  box.innerHTML = `
    <div class="urlrow"><input id="catQ" placeholder="Buscar no catálogo (ex.: Kimetsu, Demon Slayer)" value="${esc(inicial || "")}"><button type="button" class="btn primary" id="catGo">🔎</button></div>
    <div id="catRes" class="catres"></div>`;
  const q = box.querySelector("#catQ"), res = box.querySelector("#catRes");
  const buscar = async () => {
    const termo = q.value.trim(); if (termo.length < 2) { toast("Digite pelo menos 2 letras."); return; }
    if (!navigator.onLine) { res.innerHTML = `<div class="hint">Sem internet: a busca no catálogo precisa de conexão.</div>`; return; }
    res.innerHTML = `<div class="hint">Buscando…</div>`;
    const lista = await buscaCatalogo(termo);
    res.innerHTML = lista.length ? lista.map((r, i) => `
      <button type="button" class="catitem" data-i="${i}">
        ${r.capa ? `<img src="${esc(r.capa)}" alt="" referrerpolicy="no-referrer">` : `<span class="nocapa">?</span>`}
        <span class="ct"><b>${esc(r.original)}</b>${r.ingles && norm(r.ingles) !== norm(r.original) ? `<small>${esc(r.ingles)}</small>` : ""}<em>${esc(r.tipo)}${r.generos.length ? " · " + esc(r.generos.slice(0, 3).join(", ")) : ""}</em></span>
      </button>`).join("") + `<div class="hint">Não achou? Preencha manualmente abaixo.</div>`
      : `<div class="hint">Nada encontrado no catálogo. Você pode preencher manualmente abaixo.</div>`;
    res.querySelectorAll("[data-i]").forEach(b => b.onclick = async () => {
      const r = lista[Number(b.dataset.i)];
      res.innerHTML = `<div class="hint">Preparando "${esc(r.original)}" em português…</div>`;
      const c = await prepararCatalogo(r);
      aoEscolher(r.key, c);
      res.innerHTML = "";
    });
  };
  box.querySelector("#catGo").onclick = buscar;
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscar(); } });
  if (inicial) buscar();
}

// ---------- renderização ----------
const source = () => ui.visit ? ui.visit.items : items;
function filtered() {
  const q = norm(ui.q);
  const arr = [...source().values()].filter(it => (ui.filter === "todos" || stOf(it) === ui.filter) && (!q || norm(it.title).includes(q)));
  if (ui.sort === "name") arr.sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
  else if (ui.sort === "stale") arr.sort((a, b) => (a.lastReadAt || 0) - (b.lastReadAt || 0));
  else if (ui.sort === "nota") arr.sort((a, b) => (parseNota(b.nota) || 0) - (parseNota(a.nota) || 0) || norm(a.title).localeCompare(norm(b.title)));
  else arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return arr;
}
function renderChips() {
  const src = source();
  const counts = { todos: src.size };
  for (const k in STATUS) counts[k] = 0;
  for (const it of src.values()) counts[stOf(it)]++;
  $("#chips").innerHTML = ["todos", ...Object.keys(STATUS)].map(k =>
    `<button class="chip ${ui.filter === k ? "on" : ""}" data-f="${k}">${k === "todos" ? "Todos" : STATUS[k].label}<span class="n">${counts[k]}</span></button>`).join("");
}
function phHTML(title, size) {
  const initials = esc((title || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase());
  return `<div class="ph"><span${size ? ` style="font-size:${size}px"` : ""}>${initials || "?"}</span></div>`;
}
function cardHTML(it) {
  const st = stOf(it), visit = !!ui.visit;
  const cv = safeCover(it.cover), lk = fixLink(it.link);
  const cover = cv ? `<img src="${esc(cv)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback>` : phHTML(it.title);
  const days = it.lastReadAt ? (Date.now() - it.lastReadAt) / 86400000 : 0;
  const old = !visit && days > 60 && st !== "concluido" && st !== "fila";
  const link = lk ? `<a class="mini read" data-act="read" href="${esc(lk)}" target="_blank" rel="noopener noreferrer" title="Abrir site">Ler<span class="arr"> ↗</span></a>` : "";
  const chap = visit
    ? `<div class="chap ro"><span class="num"><small>LEU ATÉ O CAP.</small><b>${fmtCap(it.chapter)}</b></span></div>`
    : `<div class="chap">
        <button data-act="minus" aria-label="Capítulo anterior">−</button>
        <button class="num" data-act="goto" aria-label="Definir capítulo"><small>CAPÍTULO</small><b>${fmtCap(it.chapter)}</b></button>
        <button class="plus" data-act="plus" aria-label="Próximo capítulo">+</button>
      </div>`;
  const foot = visit
    ? `<div class="foot"><span class="when">${parseNota(it.nota) ? "⭐ " + fmtNota(parseNota(it.nota)) : ""}</span>${link}</div>`
    : `<div class="foot"><span class="when ${old ? "old" : ""}">${relTime(it.lastReadAt)}</span>${link}<button class="mini" data-act="edit" title="Editar">✎</button></div>`;
  return `<article class="card" data-id="${esc(it.id)}">
    <div class="cover" data-act="${visit ? "info" : "edit"}">${cover}<span class="badge s-${st}"><i></i>${STATUS[st].label}</span><button class="infob" data-act="info" title="Detalhes" aria-label="Detalhes">i</button></div>
    <div class="body">
      <div class="title" title="${esc(it.title)}${it.titulo2 ? " — " + esc(it.titulo2) : ""}"><span class="t1">${esc(it.title)}</span>${it.titulo2 ? `<span class="t2">${esc(it.titulo2)}</span>` : ""}</div>
      ${chap}
      ${foot}
    </div>
  </article>`;
}
function render() {
  if (!currentUser) return;
  renderChips();
  $("#visitBar").classList.toggle("hidden", !ui.visit);
  if (ui.visit) { $("#visitName").textContent = "@" + ui.visit.apelido; $("#visitAv").innerHTML = avatarHTML(ui.visit.foto, ui.visit.apelido); }
  $("#addBtn").classList.toggle("hidden", !!ui.visit);
  const vt = $("#vitrine"), vkey = ui.visit && !ui.visit.loading ? ui.visit.uid : "";
  vt.classList.toggle("hidden", !vkey);
  if (vkey && vt.dataset.uid !== vkey) { vt.dataset.uid = vkey; vt.innerHTML = vitrineHTML(ui.visit.perfil || { apelido: ui.visit.apelido }, ui.visit.items, true); ligarVitrine(vt, ui.visit.items); }
  if (!vkey) { vt.dataset.uid = ""; vt.innerHTML = ""; }
  updateBell();
  const grid = $("#grid"), empty = $("#empty");
  if (!loaded || (ui.visit && ui.visit.loading)) { grid.innerHTML = ""; empty.innerHTML = `<div class="loading">Carregando estante…</div>`; return; }
  const arr = filtered();
  grid.innerHTML = arr.map(cardHTML).join("");
  grid.querySelectorAll("img[data-fallback]").forEach(img => img.addEventListener("error", () => {
    const card = img.closest(".card"); const it = card && source().get(card.dataset.id);
    img.outerHTML = phHTML(it ? it.title : "?");
  }, { once: true }));
  if (ui.visit && !source().size) empty.innerHTML = `<div class="empty"><p>A estante de @${esc(ui.visit.apelido)} está vazia.</p></div>`;
  else if (!source().size) empty.innerHTML = `<div class="empty"><div class="big">Estante vazia!</div><p>Adicione o primeiro mangá que você está lendo — nome, capítulo e, se quiser, uma capa.</p><button class="btn primary" id="emptyAdd">+ Adicionar mangá</button></div>`;
  else if (!arr.length) empty.innerHTML = `<div class="empty"><p>Nenhum mangá encontrado com esse filtro.</p></div>`;
  else empty.innerHTML = "";
}

// ---------- modais ----------
let modalCleanup = null;
function openModal(html, onMount) {
  $("#modal").innerHTML = html; $("#bd").classList.add("open");
  modalCleanup = onMount ? onMount($("#modal")) : null;
}
function closeModal() {
  $("#bd").classList.remove("open"); $("#modal").innerHTML = "";
  if (typeof modalCleanup === "function") modalCleanup(); modalCleanup = null;
}
$("#bd").addEventListener("click", (e) => { if (e.target.id === "bd") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#bd").classList.contains("open")) closeModal(); });

async function imageToCover(blob) {
  // Capa em alta qualidade: 600×800, redução em etapas (mais nítida), WebP ou JPEG.
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const W = 600, H = 800;
    const r = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    let src = img, sw = img.naturalWidth, sh = img.naturalHeight;
    // reduz pela metade até chegar perto do tamanho final (evita serrilhado)
    while (sw * r < sw / 2) {
      const c2 = document.createElement("canvas"); c2.width = Math.round(sw / 2); c2.height = Math.round(sh / 2);
      const x2 = c2.getContext("2d"); x2.imageSmoothingEnabled = true; x2.imageSmoothingQuality = "high";
      x2.drawImage(src, 0, 0, c2.width, c2.height); src = c2; sw = c2.width; sh = c2.height;
    }
    const k = Math.max(W / sw, H / sh);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
    for (const q of [0.9, 0.82, 0.72, 0.6]) {
      let out = c.toDataURL("image/webp", q);
      if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/jpeg", q);
      if (out.length <= 380000) return out;
    }
    return c.toDataURL("image/jpeg", 0.5);
  } finally { URL.revokeObjectURL(url); }
}

function openEditor(id) {
  const it = id ? items.get(id) : null;
  let cover = it ? it.cover || "" : "";
  let catId = it ? it.catId || "" : "", titulo2 = it ? it.titulo2 || "" : "";
  let confirmDel = false;
  const opts = Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(it ? stOf(it) : "lendo") === k ? "selected" : ""}>${v.label}</option>`).join("");
  openModal(`
    <form id="ed" autocomplete="off">
      <div class="mhead"><h2>${it ? "Editar mangá" : "Novo mangá"}</h2><button type="button" class="icon-btn" data-x>✕</button></div>
      <div class="mbody">
        <div class="sect catsect">
          <div class="secth">📚 Catálogo <span id="catStatus">${catId ? "vinculado ✓" : ""}</span></div>
          <div id="catPick"></div>
          <div id="catBox">${it ? `<button type="button" class="btn" id="catLink">🔗 ${catId ? "Trocar vínculo do catálogo" : "Vincular ao catálogo"}</button>` : ""}</div>
        </div>
        <label class="f">Nome<input name="title" required maxlength="120" placeholder="Ex.: One Piece" value="${esc(it ? it.title : "")}"></label>
        <div class="two">
          <label class="f">Último capítulo lido<input name="chapter" inputmode="decimal" placeholder="0" value="${it ? fmtCap(it.chapter) : ""}"></label>
          <label class="f">Status<select name="status">${opts}</select></label>
        </div>
        <label class="f">Link do site onde você lê <span style="font-weight:500;color:var(--muted)">(opcional)</span><input name="link" inputmode="url" placeholder="https://…" value="${esc(it ? it.link || "" : "")}"></label>
        <div class="two">
          <label class="f">Sua nota <span style="font-weight:500;color:var(--muted)">(opcional)</span><select name="nota"><option value="">Sem nota</option>${NOTAS.map(n => `<option value="${n}" ${it && parseNota(it.nota) === n ? "selected" : ""}>⭐ ${fmtNota(n)}</option>`).join("")}</select></label>
          <span></span>
        </div>
        <label class="f">Comentário <span style="font-weight:500;color:var(--muted)">(opcional · aparece no seu perfil público)</span><textarea name="comentario" maxlength="300" rows="3" placeholder="Ex.: começa lento, fica ótimo a partir do cap. 50">${esc(it ? it.comentario || "" : "")}</textarea></label>
        <div>
          <div style="font-size:13px;font-weight:700;margin-bottom:6px">Capa <span style="font-weight:500;color:var(--muted)">(opcional)</span></div>
          <div class="cover-edit">
            <div class="cprev" id="cprev"></div>
            <div class="cbtns">
              <button type="button" class="btn" id="pick">🖼️ Foto da galeria / arquivo</button>
              <div class="urlrow">
                <input id="imgUrl" inputmode="url" placeholder="ou cole o link da imagem">
                <button type="button" class="btn" id="useUrl">OK</button>
              </div>
              <div class="paste" id="paste" contenteditable="true" spellcheck="false" data-ph="1">Ou cole aqui uma imagem copiada (Ctrl+V)</div>
              <button type="button" class="btn ghost" id="rmCover">Remover capa</button>
            </div>
          </div>
        </div>
      </div>
      <div class="mfoot">
        ${it ? `<button type="button" class="btn danger" id="del">Excluir</button>` : ""}
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-x>Cancelar</button>
        <button type="submit" class="btn primary">Salvar</button>
      </div>
    </form>`, (root) => {
    const prev = root.querySelector("#cprev");
    const titleInput = root.querySelector("[name=title]");
    const pick = root.querySelector("#catPick");
    const mostrarEscolha = (c) => {
      pick.innerHTML = c ? `<div class="catchosen">${c.capa ? `<img src="${esc(c.capa)}" alt="" referrerpolicy="no-referrer">` : ""}<div><b>${esc(c.titulo)}</b>${c.titulo2 ? `<small>${esc(c.titulo2)}</small>` : ""}<em>${esc(c.tipo || "")}${(c.generos || []).length ? " · " + esc(c.generos.slice(0, 4).join(", ")) : ""}</em></div><button type="button" class="mini" id="catUnlink" title="Desvincular">✕</button></div>` : "";
      const un = pick.querySelector("#catUnlink"); if (un) un.onclick = () => { catId = ""; titulo2 = ""; mostrarEscolha(null); root.querySelector("#catStatus").textContent = ""; };
    };
    const aoEscolher = (key, c) => {
      catId = key; titulo2 = c.titulo2 || "";
      titleInput.value = c.titulo; mostrarEscolha(c);
      root.querySelector("#catStatus").textContent = "vinculado ✓";
      if (!cover && c.capa) { cover = c.capa; paintCover(); }
    };
    if (catId) lerCatalogo(catId).then(c => c && mostrarEscolha(c));
    if (!it) montarBuscaCatalogo(root, "", aoEscolher);
    const cl = root.querySelector("#catLink"); if (cl) cl.onclick = () => montarBuscaCatalogo(root, it.title, aoEscolher);
    const paintCover = () => {
      prev.innerHTML = cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer">` : phHTML(titleInput.value || "?", 34);
      const im = prev.querySelector("img");
      if (im) im.onerror = () => { toast("Essa imagem não abriu. Tente outro link ou use uma foto do aparelho.", 4000); cover = ""; paintCover(); };
      root.querySelector("#rmCover").style.display = cover ? "" : "none";
    };
    paintCover();
    titleInput.addEventListener("input", () => { if (!cover) paintCover(); });
    const useBlob = async (blob) => {
      try { cover = await imageToCover(blob); paintCover(); toast("Capa adicionada!"); }
      catch (e) { toast("Não consegui ler essa imagem."); }
    };
    const useUrl = () => {
      const u = fixLink(root.querySelector("#imgUrl").value);
      if (!u) { toast("Cole um link de imagem válido."); return; }
      if (u.length > 2000) { toast("Link longo demais."); return; }
      cover = u; paintCover(); root.querySelector("#imgUrl").value = "";
    };
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelector("#pick").onclick = () => { const f = $("#file"); f.value = ""; f.onchange = () => f.files[0] && useBlob(f.files[0]); f.click(); };
    root.querySelector("#useUrl").onclick = useUrl;
    root.querySelector("#imgUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); useUrl(); } });
    root.querySelector("#rmCover").onclick = () => { cover = ""; paintCover(); };
    const pz = root.querySelector("#paste");
    pz.addEventListener("focus", () => { if (pz.dataset.ph) { pz.textContent = ""; delete pz.dataset.ph; } });
    pz.addEventListener("input", () => { pz.textContent = ""; });
    const onPaste = (e) => {
      const dt = e.clipboardData; if (!dt) return;
      const img = [...dt.items].find(i => i.type && i.type.startsWith("image/"));
      if (img) { e.preventDefault(); useBlob(img.getAsFile()); return; }
      if (e.target === pz) {
        e.preventDefault();
        const txt = (dt.getData("text") || "").trim();
        if (/^https?:\/\//i.test(txt)) { cover = txt; paintCover(); }
      }
    };
    document.addEventListener("paste", onPaste);
    prev.addEventListener("dragover", (e) => { e.preventDefault(); prev.classList.add("drag"); });
    prev.addEventListener("dragleave", () => prev.classList.remove("drag"));
    prev.addEventListener("drop", (e) => { e.preventDefault(); prev.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) useBlob(f); });
    const del = root.querySelector("#del");
    if (del) del.onclick = () => {
      if (!confirmDel) { confirmDel = true; del.textContent = "Confirmar exclusão?"; del.style.background = "var(--red)"; del.style.color = "#fff"; return; }
      remove(id); closeModal(); toast("Movido para a lixeira (fica lá por 30 dias).", 3500);
    };
    root.querySelector("#ed").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const title = String(fd.get("title") || "").trim();
      if (!title) return;
      const chapter = parseCap(fd.get("chapter"));
      const rawLink = String(fd.get("link") || "").trim();
      const link = fixLink(rawLink);
      if (rawLink && !link) { toast("Esse link não parece válido."); return; }
      const data = { title, chapter, status: String(fd.get("status")), link, cover, catId, titulo2: catId ? titulo2 : "",
        nota: parseNota(fd.get("nota")), comentario: String(fd.get("comentario") || "").trim().slice(0, 300) };
      if (it) {
        const patch = { ...data };
        if (chapter !== (Number(it.chapter) || 0)) patch.lastReadAt = Date.now();
        commit(id, patch); toast("Salvo!");
      } else { create(data); toast("Adicionado à estante!"); }
      closeModal();
    });
    if (!it) setTimeout(() => { const q = root.querySelector("#catQ"); (q || titleInput).focus(); }, 50);
    return () => document.removeEventListener("paste", onPaste);
  });
}

function openGoto(id) {
  const it = items.get(id); if (!it) return;
  openModal(`
    <form id="gt" autocomplete="off">
      <div class="mhead"><h2>${esc(it.title)}</h2><button type="button" class="icon-btn" data-x>✕</button></div>
      <div class="mbody">
        <label class="f">Último capítulo lido<input name="ch" inputmode="decimal" value="${fmtCap(it.chapter)}" style="font-family:Bangers,Impact,sans-serif;font-size:30px;height:58px;letter-spacing:1px;text-align:center"></label>
        <div class="quick">${[1, 5, 10, 20].map(n => `<button type="button" class="btn" data-add="${n}">+${n}</button>`).join("")}</div>
      </div>
      <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="submit" class="btn primary">Salvar</button></div>
    </form>`, (root) => {
    const inp = root.querySelector("[name=ch]");
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { inp.value = fmtCap(Math.floor(parseCap(inp.value)) + Number(b.dataset.add)); });
    root.querySelector("#gt").addEventListener("submit", (e) => {
      e.preventDefault();
      const ch = parseCap(inp.value);
      if (ch !== (Number(it.chapter) || 0)) commit(id, { chapter: ch, lastReadAt: Date.now() });
      closeModal();
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  });
}

// ---------- menu ----------
const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (x) {}
    ta.remove(); return ok;
  }
}
function openMenu() {
  const u = currentUser || {};
  openModal(`
    <div class="mhead"><h2>Menu</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody">
      <div class="acct"><div><b>${esc(u.email || "Sua conta")}</b><small>${isAdmin(u) ? "👑 Administrador" : "Conta conectada"}</small></div></div>
      <div class="menu-list">
        ${isAdmin(u) ? `<button class="btn primary" id="mAdmin">👑 Administrador — quem pode usar</button><button class="btn" id="mReports">🛠️ Relatos de problemas</button>` : ""}
        <button class="btn" id="mLix">🗑️ Lixeira</button>
        <button class="btn" id="mSupport">🛠️ Reportar problema</button>
        <button class="btn" id="mSenha">🔑 Trocar senha</button>
        <button class="btn" id="mExport">💾 ${isNativeApp ? "Copiar backup" : "Baixar backup (arquivo .json)"}</button>
        <button class="btn" id="mImport">📂 Restaurar backup</button>
        <button class="btn danger" id="mOut">Sair da conta (apaga a cópia deste aparelho)</button>
        <button class="btn ghost" id="mDel" style="color:var(--red)">Excluir minha conta</button>
      </div>
      <p class="hint">Seus mangás ficam salvos na sua conta e sincronizam entre todos os aparelhos em que você entrar. Sem internet, o app continua funcionando e envia as mudanças depois.</p>
    </div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const ab = root.querySelector("#mAdmin"); if (ab) ab.onclick = openAdmin;
    const rb = root.querySelector("#mReports"); if (rb) rb.onclick = openReports;
    root.querySelector("#mSupport").onclick = openSupport;
    root.querySelector("#mLix").onclick = openLixeira;
    root.querySelector("#mSenha").onclick = openSenha;
    root.querySelector("#mDel").onclick = openExcluirConta;
    root.querySelector("#mExport").onclick = async () => {
      const data = JSON.stringify({ app: "estante-mangas", exportedAt: new Date().toISOString(), mangas: [...items.values()].map(clean) }, null, 2);
      if (isNativeApp) { toast(await copyText(data) ? "Backup copiado! Cole num bloco de notas ou mande para você mesmo." : "Não consegui copiar.", 5000); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      a.download = `estante-mangas-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast("Backup baixado!");
    };
    root.querySelector("#mImport").onclick = () => {
      const f = $("#importFile"); f.value = "";
      f.onchange = async () => {
        try {
          const json = JSON.parse(await f.files[0].text());
          const list = Array.isArray(json) ? json : json.mangas;
          if (!Array.isArray(list)) throw new Error("formato");
          let batch = writeBatch(db), n = 0;
          for (const m of list) {
            if (!m || !m.title) continue;
            const id = m.id && /^[\w-]{1,100}$/.test(m.id) ? m.id : doc(col).id;
            batch.set(doc(col, id), clean(m));
            if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
          }
          await batch.commit();
          toast(`${n} mangás restaurados!`); closeModal();
        } catch (e) { toast("Esse arquivo não é um backup válido."); }
      };
      f.click();
    };
    root.querySelector("#mOut").onclick = () => { closeModal(); fullSignOut(); };
  });
}

// ---------- administrador ----------
function inviteText(email) {
  return `Oi! Te liberei na Estante de Mangás 📚\n\n` +
    `1) Baixe o app: ${downloadUrl || "(link de download)"}\n` +
    `   • Android: EstanteMangas.apk  • PC: EstanteMangas-Setup.exe\n` +
    `2) Abra, toque em "Primeiro acesso" e use o e-mail ${email}\n` +
    `3) Confirme o e-mail pelo link que chegar e pronto!`;
}
function openAdmin() {
  let unsubInv = null;
  openModal(`
    <div class="mhead"><h2>👑 Administrador</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody">
      <p class="hint" style="font-size:13.5px">Só os e-mails desta lista conseguem usar o app (você sempre consegue). Ao remover alguém, o perfil some para todos, mas nada é apagado: se liberar de novo, a estante volta inteira.</p>
      <form id="invForm" class="mbody" style="padding:0;gap:10px" autocomplete="off">
        <label class="f">E-mail da pessoa<input name="email" type="email" required placeholder="amigo@gmail.com"></label>
        <label class="f">Nome <span style="font-weight:500;color:var(--muted)">(opcional)</span><input name="nome" maxlength="60" placeholder="Ex.: João"></label>
        <button class="btn primary" type="submit">+ Liberar acesso</button>
      </form>
      <div style="font-size:13px;font-weight:800;margin-top:6px">Pessoas liberadas</div>
      <div id="invList" class="menu-list"><div class="hint">Carregando…</div></div>
      <button class="btn" id="copyLink">🔗 Copiar link de download</button>
    </div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const list = root.querySelector("#invList");
    unsubInv = onSnapshot(collection(db, "convidados"), (snap) => {
      if (snap.empty) { list.innerHTML = `<div class="hint">Ninguém liberado ainda.</div>`; return; }
      list.innerHTML = snap.docs.map(d => { const v = d.data() || {}; return `
        <div class="acct" style="justify-content:space-between" data-email="${esc(d.id)}">
          <div><b>${esc(v.nome || d.id)}</b><small>${esc(d.id)}</small></div>
          <div style="display:flex;gap:6px;flex:none">
            <button class="mini" data-inv="copy" title="Copiar convite">📋</button>
            <button class="mini" data-inv="del" title="Remover acesso" style="color:var(--red)">✕</button>
          </div>
        </div>`; }).join("");
    }, () => { list.innerHTML = `<div class="err">Sem permissão. Confira se seu e-mail está certo nas regras do servidor.</div>`; });
    list.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-inv]"); if (!b) return;
      const email = b.closest("[data-email]").dataset.email;
      if (b.dataset.inv === "copy") { toast(await copyText(inviteText(email)) ? "Convite copiado! Cole no WhatsApp." : "Não consegui copiar."); return; }
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Remover?"; b.style.background = "var(--red)"; b.style.color = "#fff"; return; }
      try {
        const cd = await getDoc(doc(db, "convidados", email));
        const uid = cd.exists() ? (cd.data() || {}).uid : null;
        if (uid) await updateDoc(doc(db, "perfis", uid), { oculto: true }).catch(() => {});
        await deleteDoc(doc(db, "convidados", email));
        toast("Acesso removido. O perfil ficou oculto; se liberar de novo, tudo volta.", 4500);
      } catch (x) { toast("Não foi possível remover."); }
    });
    root.querySelector("#invForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = e.target.email.value.trim().toLowerCase();
      const nome = e.target.nome.value.trim().slice(0, 60);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("E-mail inválido."); return; }
      try {
        await setDoc(doc(db, "convidados", email), { nome, adicionadoEm: Date.now() });
        e.target.reset();
        toast(await copyText(inviteText(email)) ? "Liberado! Convite copiado — cole no WhatsApp." : "Liberado!", 4000);
      } catch (x) { toast("Não foi possível liberar (sem internet ou sem permissão)."); }
    });
    root.querySelector("#copyLink").onclick = async () => toast(await copyText(downloadUrl || "") ? "Link copiado!" : "Link ainda não configurado.");
    return () => { if (unsubInv) unsubInv(); };
  });
}
// ---------- sino de capítulos novos (no topo) ----------
function markSeen(id) { const c = chk[id]; if (c && c.latest != null) { c.seen = c.latest; saveChk(); setTimeout(render, 300); } }
const AVAL_KEY = "estante-aval-visto";
const avalVisto = () => { try { return Number(localStorage.getItem(AVAL_KEY)) || 0; } catch (e) { return 0; } };
function bellList() { return [...items.values()].map(it => ({ it, n: unreadBadge(it) })).filter(x => x.n > 0); }
function novasAvaliacoes() {
  const desde = avalVisto(), out = [];
  for (const [mid, notas] of Object.entries(myAvals)) {
    const it = items.get(mid); if (!it) continue;
    for (const v of Object.values(notas || {})) if ((v.em || 0) > desde && parseNota(v.nota)) out.push({ it, v });
  }
  return out.sort((a, b) => (b.v.em || 0) - (a.v.em || 0));
}
function updateBell() {
  if (!$("#bellBtn")) return;
  const n = bellList().length + novasAvaliacoes().length;
  $("#bellBtn").classList.toggle("hidden", !n);
  $("#bellCnt").textContent = n > 9 ? "9+" : String(n || "");
}
function openBell() {
  const caps = bellList(), avs = novasAvaliacoes();
  openModal(`
    <div class="mhead"><h2>🔔 Novidades</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody">
      ${avs.length ? `<div class="secth">Avaliações novas</div><div class="menu-list">${avs.map(({ it, v }) => `
        <button class="acct pbtn" data-info="${esc(it.id)}"><div><b>@${esc(v.apelido || "?")} deu ⭐ ${fmtNota(parseNota(v.nota))}</b><small>em ${esc(it.title)}</small></div></button>`).join("")}</div>` : ""}
      ${caps.length ? `<div class="secth">Capítulos novos</div><div class="menu-list">${caps.map(({ it, n }) => `
        <div class="acct" style="justify-content:space-between">
          <div><b>${esc(it.title)}</b><small>+${n} ${n === 1 ? "capítulo novo" : "capítulos novos"} · você parou no ${fmtCap(it.chapter)}</small></div>
          ${fixLink(it.link) ? `<a class="mini read" data-seen="${esc(it.id)}" href="${esc(fixLink(it.link))}" target="_blank" rel="noopener noreferrer">Ler ↗</a>` : ""}
        </div>`).join("")}</div>` : ""}
      ${!avs.length && !caps.length ? `<p class="hint">Nenhuma novidade por enquanto.</p>` : ""}
    </div>`, (root) => {
    try { localStorage.setItem(AVAL_KEY, String(Date.now())); } catch (e) {}
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelectorAll("[data-info]").forEach(b => b.onclick = () => openInfo(b.dataset.info));
    root.querySelectorAll("[data-seen]").forEach(a => a.addEventListener("click", () => { markSeen(a.dataset.seen); setTimeout(() => { if (!bellList().length) closeModal(); else openBell(); }, 350); }));
    return () => updateBell();
  });
}

// ---------- lixeira (30 dias) ----------
const LIX_DIAS = 30;
async function limparLixeira(uid) {
  try {
    const snap = await getDocs(collection(db, "users", uid, "lixeira"));
    const limite = Date.now() - LIX_DIAS * 86400000;
    for (const d of snap.docs) if (((d.data() || {}).excluidoEm || 0) < limite) {
      await deleteDoc(doc(db, "users", uid, "lixeira", d.id)).catch(() => {});
      await deleteDoc(doc(db, "users", uid, "avaliacoes", d.id)).catch(() => {});
    }
  } catch (e) {}
}
async function openLixeira() {
  const uid = currentUser.uid;
  openModal(`
    <div class="mhead"><h2>🗑️ Lixeira</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody"><p class="hint">Mangás excluídos ficam aqui por ${LIX_DIAS} dias e depois somem de vez.</p><div id="lxl" class="menu-list"><div class="hint">Carregando…</div></div></div>`, async (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const box = root.querySelector("#lxl");
    let lista = [];
    const draw = () => {
      box.innerHTML = lista.length ? lista.map(x => {
        const dias = Math.max(0, LIX_DIAS - Math.floor((Date.now() - (x.excluidoEm || 0)) / 86400000));
        return `<div class="acct" style="justify-content:space-between" data-id="${esc(x.id)}"><div><b>${esc(x.title)}</b><small>some em ${dias} ${dias === 1 ? "dia" : "dias"}</small></div>
          <div style="display:flex;gap:6px;flex:none"><button class="mini read" data-l="rest">Restaurar</button><button class="mini" data-l="del" style="color:var(--red)">✕</button></div></div>`;
      }).join("") : `<div class="hint">A lixeira está vazia.</div>`;
    };
    try { lista = (await getDocs(collection(db, "users", uid, "lixeira"))).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.excluidoEm || 0) - (a.excluidoEm || 0)); }
    catch (e) { box.innerHTML = `<div class="err">Não consegui abrir a lixeira agora.</div>`; return; }
    draw();
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-l]"); if (!b) return;
      const id = b.closest("[data-id]").dataset.id, x = lista.find(y => y.id === id); if (!x) return;
      try {
        if (b.dataset.l === "rest") {
          const m = { ...x }; delete m.id; delete m.excluidoEm;
          const bt = writeBatch(db); bt.set(doc(col, id), clean(m)); bt.delete(doc(db, "users", uid, "lixeira", id)); await bt.commit();
          toast("Restaurado na estante!");
        } else {
          if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Apagar de vez?"; return; }
          await deleteDoc(doc(db, "users", uid, "lixeira", id)); await deleteDoc(doc(db, "users", uid, "avaliacoes", id)).catch(() => {});
          toast("Apagado de vez.");
        }
        lista = lista.filter(y => y.id !== id); draw();
      } catch (x2) { toast("Não foi possível agora. Verifique a internet."); }
    });
  });
}

// ---------- trocar senha ----------
function openSenha() {
  openModal(`
    <form id="sF" autocomplete="off">
      <div class="mhead"><h2>🔑 Trocar senha</h2><button type="button" class="icon-btn" data-x>✕</button></div>
      <div class="mbody">
        <label class="f">Senha atual<input name="a" type="password" autocomplete="current-password" required></label>
        <label class="f">Nova senha<input name="n" type="password" autocomplete="new-password" minlength="6" required></label>
        <label class="f">Repita a nova senha<input name="n2" type="password" autocomplete="new-password" minlength="6" required></label>
        <p class="hint">Esqueceu a senha atual? Saia da conta e use "Esqueci a senha" na tela de entrada.</p>
      </div>
      <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="submit" class="btn primary">Salvar</button></div>
    </form>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelector("#sF").addEventListener("submit", async (e) => {
      e.preventDefault(); const f = e.target;
      if (f.n.value !== f.n2.value) { toast("As senhas novas não são iguais."); return; }
      try {
        await reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, f.a.value));
        await updatePassword(currentUser, f.n.value);
        closeModal(); toast("Senha trocada! Use a nova nos outros aparelhos.", 4000);
      } catch (x) { toast(/wrong-password|invalid-credential/.test(x.code || "") ? "Senha atual incorreta." : authMsg(x), 4000); }
    });
  });
}

// ---------- excluir a própria conta (afeta só quem exclui) ----------
async function apagarColecao(path) {
  const snap = await getDocs(collection(db, ...path));
  let b = writeBatch(db), n = 0;
  for (const d of snap.docs) { b.delete(doc(db, ...path, d.id)); if (++n % 400 === 0) { await b.commit(); b = writeBatch(db); } }
  await b.commit();
}
function openExcluirConta() {
  openModal(`
    <form id="xF" autocomplete="off">
      <div class="mhead"><h2>⚠️ Excluir minha conta</h2><button type="button" class="icon-btn" data-x>✕</button></div>
      <div class="mbody">
        <p><b>Isso apaga para sempre:</b> sua estante, sua lixeira, seu perfil, seu apelido e as notas que você deu nos mangás de outras pessoas. As estantes dos outros não são alteradas.</p>
        <p class="hint">Quer guardar seus mangás? Antes, use "Baixar backup" no menu.</p>
        <label class="f">Sua senha<input name="a" type="password" autocomplete="current-password" required></label>
        <label class="f">Digite EXCLUIR para confirmar<input name="c" required placeholder="EXCLUIR"></label>
      </div>
      <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="submit" class="btn danger" id="xGo">Excluir para sempre</button></div>
    </form>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelector("#xF").addEventListener("submit", async (e) => {
      e.preventDefault(); const f = e.target, me = currentUser.uid;
      if (f.c.value.trim().toUpperCase() !== "EXCLUIR") { toast('Digite "EXCLUIR" para confirmar.'); return; }
      const go = root.querySelector("#xGo"); go.disabled = true; go.textContent = "Excluindo…";
      try { await reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, f.a.value)); }
      catch (x) { go.disabled = false; go.textContent = "Excluir para sempre"; toast("Senha incorreta."); return; }
      try {
        // 1) remove SÓ a minha nota em cada mangá dos outros (o servidor não deixa mexer em mais nada)
        const minhas = await getDocs(collection(db, "users", me, "minhasNotas"));
        for (const d of minhas.docs) {
          const x = d.data() || {};
          await updateDoc(doc(db, "users", x.dono, "avaliacoes", x.manga), { [`notas.${me}`]: deleteField() }).catch(() => {});
        }
        // notas antigas (de antes desta versão): procura nos perfis públicos
        try {
          const ps = await getDocs(query(collection(db, "perfis"), where("publico", "==", true), where("oculto", "==", false)));
          for (const p of ps.docs) {
            if (p.id === me) continue;
            const av = await getDocs(collection(db, "users", p.id, "avaliacoes")).catch(() => null);
            if (!av) continue;
            for (const a of av.docs) if (((a.data() || {}).notas || {})[me])
              await updateDoc(doc(db, "users", p.id, "avaliacoes", a.id), { [`notas.${me}`]: deleteField() }).catch(() => {});
          }
        } catch (x) {}
        // 2) apaga os meus dados
        for (const c of ["minhasNotas", "mangas", "lixeira", "avaliacoes"]) await apagarColecao(["users", me, c]).catch(() => {});
        if (myProfile && myProfile.apelido) await deleteDoc(doc(db, "apelidos", apKey(myProfile.apelido))).catch(() => {});
        await deleteDoc(doc(db, "perfis", me)).catch(() => {});
        // 3) apaga o login
        await deleteUser(currentUser);
        try { await terminate(db); await clearIndexedDbPersistence(db); } catch (x) {}
        alertaFinal();
      } catch (x) { go.disabled = false; go.textContent = "Excluir para sempre"; toast("Não foi possível concluir. Verifique a internet e tente de novo.", 4500); }
    });
  });
}
function alertaFinal() {
  document.body.innerHTML = `<div class="login"><div class="login-box"><h1 class="logo"><span class="mark">ATÉ</span> logo</h1><p>Sua conta foi excluída. Obrigado por ter usado a Estante de Mangás.</p><button class="gbtn" onclick="location.reload()">Fechar</button></div></div>`;
}

// ---------- ⓘ detalhes do mangá (nota, comentário, link, notas dos visitantes) ----------
function avalsOf(mid) { return ui.visit ? (ui.visit.avals[mid] || {}) : (myAvals[mid] || {}); }
function openInfo(mid) {
  const visit = ui.visit, it = source().get(mid); if (!it) return;
  const nota = parseNota(it.nota), lk = fixLink(it.link);
  const me = currentUser.uid, avals = avalsOf(mid);
  const lista = Object.entries(avals).map(([uid, v]) => ({ uid, ...v })).filter(v => parseNota(v.nota)).sort((a, b) => (b.em || 0) - (a.em || 0));
  const m = media(lista.map(v => parseNota(v.nota)));
  const minha = visit ? avals[me] : null;
  const cheio = lista.length >= 10 && !minha;
  const jaTenho = visit && [...items.values()].some(x => (it.catId && x.catId === it.catId) || norm(x.title) === norm(it.title));
  openModal(`
    <div class="mhead"><h2>${esc(it.title)}${it.titulo2 ? `<small class="h2sub">${esc(it.titulo2)}</small>` : ""}</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody">
      ${it.catId ? `<div id="catInfo" class="catinfo"><div class="hint">Carregando informações do catálogo…</div></div>` : ""}
      <div class="infogrid">
        <div class="ibox"><small>${visit ? "NOTA DE @" + esc(visit.apelido).toUpperCase() : "SUA NOTA"}</small><b>${nota ? "⭐ " + fmtNota(nota) : "—"}</b></div>
        <div class="ibox"><small>LEU ATÉ O CAP.</small><b>${fmtCap(it.chapter)}</b></div>
        <div class="ibox"><small>STATUS</small><b class="st"><span class="badge s-${stOf(it)}" style="position:static"><i></i>${STATUS[stOf(it)].label}</span></b></div>
      </div>
      <div class="comment">${it.comentario ? "💬 " + esc(it.comentario) : `<span class="hint">Sem comentário.</span>`}</div>
      ${lk ? `<a class="btn" href="${esc(lk)}" target="_blank" rel="noopener noreferrer" ${visit ? "" : `data-seen="${esc(mid)}"`}>🔗 Abrir o site onde ${visit ? "ele lê" : "você lê"} ↗</a>` : ""}
      <div class="sect">
        <div class="secth">Notas dos visitantes <span>${lista.length}/10</span></div>
        ${lista.length ? `<div class="menu-list">${lista.map(v => `
          <div class="acct rrow" data-uid="${esc(v.uid)}"><div><b>@${esc(v.apelido || "?")}</b></div><div class="rv">⭐ ${fmtNota(parseNota(v.nota))}${!visit ? `<button class="mini" data-rm="${esc(v.uid)}" title="Remover esta nota">✕</button>` : ""}</div></div>`).join("")}</div>
          <div class="avg">Média dos visitantes: <b>⭐ ${fmtNota(m)}</b></div>`
          : `<p class="hint">${visit ? "Ninguém avaliou ainda. Seja o primeiro!" : "Quando alguém visitar seu perfil público, as notas aparecem aqui."}</p>`}
      </div>
      ${visit ? `
      <div class="sect">
        <div class="secth">Sua nota para este mangá</div>
        ${!myProfile || !myProfile.apelido ? `<p class="hint">Para avaliar, crie seu apelido em 👤 Social → Meu perfil.</p>`
          : cheio ? `<p class="hint">Este mangá já recebeu 10 notas, o limite.</p>`
          : `<div class="urlrow"><select id="myNota" class="f-sel"><option value="">Escolha…</option>${NOTAS.map(n => `<option value="${n}" ${minha && parseNota(minha.nota) === n ? "selected" : ""}>⭐ ${fmtNota(n)}</option>`).join("")}</select><button class="btn primary" id="saveNota">${minha ? "Atualizar" : "Avaliar"}</button></div>
             ${minha ? `<button class="btn ghost" id="rmNota">Remover minha nota</button>` : ""}`}
      </div>
      <button class="btn ${jaTenho ? "" : "primary"}" id="copyShelf" ${jaTenho ? "disabled" : ""}>${jaTenho ? "✓ Já está na sua estante" : "＋ Adicionar à minha estante (Na fila)"}</button>`
      : `<button class="btn" id="editIt">✎ Editar este mangá</button>`}
    </div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelectorAll("[data-seen]").forEach(a => a.addEventListener("click", () => markSeen(a.dataset.seen)));
    const ci = root.querySelector("#catInfo");
    if (ci) lerCatalogo(it.catId).then(c => completarSinopse(it.catId, c)).then(c => {
      if (!ci.isConnected) return;
      if (!c) { ci.innerHTML = navigator.onLine ? "" : `<div class="hint">Sem internet: gêneros e sinopse aparecem quando conectar.</div>`; return; }
      ci.innerHTML = `${(c.generos || []).length ? `<div class="gens">${c.generos.map(g => `<span>${esc(g)}</span>`).join("")}</div>` : ""}
        <div class="sinopse"><b>Sinopse</b>${c.sinopse ? `<p>${esc(c.sinopse)}</p>` : `<p class="hint">Sinopse em tradução… tente abrir de novo daqui a pouco.</p>`}</div>`;
    });
    const ed = root.querySelector("#editIt"); if (ed) ed.onclick = () => openEditor(mid);
    root.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Remover?"; return; }
      try { await updateDoc(doc(db, "users", me, "avaliacoes", mid), { [`notas.${b.dataset.rm}`]: deleteField() }); toast("Nota removida."); setTimeout(() => openInfo(mid), 300); }
      catch (e) { toast("Não foi possível remover."); }
    });
    const sv = root.querySelector("#saveNota");
    if (sv) sv.onclick = async () => {
      const n = parseNota(root.querySelector("#myNota").value); if (!n) { toast("Escolha uma nota."); return; }
      sv.disabled = true;
      try {
        await setDoc(doc(db, "users", visit.uid, "avaliacoes", mid), { notas: { [me]: { nota: n, apelido: myProfile.apelido, em: Date.now() } } }, { merge: true });
        setDoc(doc(db, "users", me, "minhasNotas", visit.uid + "_" + mid), { dono: visit.uid, manga: mid, em: Date.now() }).catch(() => {});
        await refreshVisitAval(mid); toast("Nota enviada!"); openInfo(mid);
      } catch (e) { sv.disabled = false; toast(e.code === "permission-denied" ? "Não foi possível avaliar (limite de 10 notas ou perfil ficou privado)." : "Falha ao enviar a nota."); }
    };
    const rn = root.querySelector("#rmNota");
    if (rn) rn.onclick = async () => {
      try { await updateDoc(doc(db, "users", visit.uid, "avaliacoes", mid), { [`notas.${me}`]: deleteField() }); deleteDoc(doc(db, "users", me, "minhasNotas", visit.uid + "_" + mid)).catch(() => {}); await refreshVisitAval(mid); toast("Sua nota foi removida."); openInfo(mid); }
      catch (e) { toast("Não foi possível remover."); }
    };
    const cp = root.querySelector("#copyShelf");
    if (cp && !jaTenho) cp.onclick = () => {
      create({ title: it.title, titulo2: it.titulo2 || "", catId: it.catId || "", cover: safeCover(it.cover), link: fixLink(it.link), status: "fila", chapter: 0, nota: null, comentario: "" });
      toast("Adicionado à sua estante em Na fila!"); openInfo(mid);
    };
  });
}

// ---------- 👤 pessoas: seu perfil + busca ----------
const safeFoto = (f) => /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(String(f || "")) && String(f).length <= 60000 ? f : "";
function avatarHTML(foto, apelido, cls = "") {
  const f = safeFoto(foto);
  return f ? `<img class="av ${cls}" src="${esc(f)}" alt="">` : `<span class="av ${cls} avph">${esc((apelido || "?").slice(0, 1).toUpperCase())}</span>`;
}
async function imageToAvatar(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const S = 192, c = document.createElement("canvas"); c.width = S; c.height = S;
    const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
    for (const q of [0.88, 0.75, 0.6]) { let o = c.toDataURL("image/webp", q); if (!o.startsWith("data:image/webp")) o = c.toDataURL("image/jpeg", q); if (o.length <= 60000) return o; }
    return c.toDataURL("image/jpeg", 0.5);
  } finally { URL.revokeObjectURL(url); }
}
const perfilData = (patch) => {
  const p = myProfile || {};
  return { apelido: p.apelido || "", publico: !!p.publico, foto: safeFoto(p.foto), oculto: false, atualizadoEm: Date.now(),
    bio: String(p.bio || "").slice(0, 120), cor: CORES[p.cor] ? p.cor : "", banner: safeBanner(p.banner),
    favoritos: Array.isArray(p.favoritos) ? p.favoritos.filter(x => typeof x === "string" && x.length <= 60).slice(0, 3) : [],
    membroDesde: Number(p.membroDesde) || membroDesdeAuth(), ...patch };
};
function updateMeBtn() {
  const b = $("#peopleBtn"); const f = myProfile && safeFoto(myProfile.foto);
  b.innerHTML = f ? `<img class="av" src="${esc(f)}" alt="">` : "👤";
  b.classList.toggle("hasav", !!f);
}
// Apelido: letras (com acento) e números, 3 a 20. Mostra como a pessoa digitou ("Daniel"),
// mas a checagem de repetido ignora maiúsculas ("Daniel" e "daniel" são o mesmo).
const APELIDO_RE = /^[A-Za-z0-9áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]{3,20}$/;
const apKey = (a) => String(a || "").toLowerCase();
// Filtro básico de palavrões/ofensas (compara sem acento e trocando números por letras: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t)
const AP_RUINS_CONTEM = ["caralho","buceta","boceta","viado","traveco","arrombad","vagabund","retardad","estupr","pedofil","nazis","hitler","nigger","nigga","faggot","xoxota","piroca","fuck","porra","merda","bosta","foder","fuder","cuzao","filhodaputa","putaria","prostitut","macacada","escravo","sapatao"];
const AP_RUINS_IGUAL = ["puta","puto","cu","pica","rola","xota","bicha","macaco","crioulo","mongol","fdp","shit","bitch","cunt","whore","slut","retard","penis","vagina","pinto","cacete","corno","otario","idiota","imbecil","burro"];
function apelidoOfensivo(a) {
  const n = norm(a).replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t").replace(/[^a-z]/g, "");
  return AP_RUINS_CONTEM.some(w => n.includes(w)) || AP_RUINS_IGUAL.some(w => n === w || n === w + "s");
}
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const nomeMes = (m) => { const [a, b] = String(m || "").split("-").map(Number); return a && b ? `${MESES[b - 1]} de ${a}` : ""; };
// 👤 "Social": Meu perfil · Comunidade · Ranking
function openPeople(tab = "perfil") {
  const p = myProfile || {};
  const offline = !navigator.onLine;
  const tabs = `<div class="ctabs">${[["perfil", "Meu perfil"], ["pessoas", "Comunidade"], ["ranking", "Ranking"]].map(([k, l]) => `<button type="button" class="chip ${tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>`;
  let corpo = "";
  if (tab === "perfil") corpo = `
      ${p.apelido ? `<div class="vitrine mine">${vitrineHTML(p, items, false)}</div>
      <button type="button" class="btn primary" id="vtEdit" style="width:100%">✏️ Editar vitrine</button>
      <p class="hint" style="margin-top:-4px">É assim que as pessoas veem o seu perfil.</p>` : ""}
      <div class="sect">
        <div class="me">
          ${avatarHTML(p.foto, p.apelido, "big")}
          <div class="mebtns">
            <button type="button" class="btn" id="fotoBtn" ${p.apelido ? "" : "disabled"}>📷 ${safeFoto(p.foto) ? "Trocar foto" : "Escolher foto"}</button>
            ${safeFoto(p.foto) ? `<button type="button" class="btn ghost" id="fotoRm">Remover foto</button>` : ""}
            ${p.apelido ? "" : `<small class="hint">Escolha um apelido primeiro.</small>`}
          </div>
        </div>
        <form id="apForm" class="urlrow" autocomplete="off"><input name="ap" maxlength="20" placeholder="seu apelido (ex.: Daniel)" value="${esc(p.apelido || "")}"><button class="btn primary" type="submit">Salvar</button></form>
        <p class="hint">Letras e números, de 3 a 20, sem símbolos. Cada apelido é único (Daniel e daniel contam como o mesmo).</p>
        <label class="switch"><input type="checkbox" id="pubT" ${p.publico ? "checked" : ""} ${p.apelido ? "" : "disabled"}><span class="sl"></span><span>Perfil público <small>${p.publico ? "— outras pessoas podem achar e ver sua estante, e você entra no ranking" : "— ninguém encontra você e você não entra no ranking"}</small></span></label>
      </div>`;
  else if (tab === "pessoas") corpo = offline ? `<p class="hint">📴 Sem internet: a busca de pessoas precisa de conexão.</p>` : `
      <div class="sect">
        <div class="search" style="height:42px">🔍<input id="pq" type="search" placeholder="Buscar apelido…" autocomplete="off"></div>
        <div id="plist" class="menu-list"><div class="hint">Carregando…</div></div>
      </div>`;
  else corpo = offline ? `<p class="hint">📴 Sem internet: o ranking precisa de conexão.</p>` : `<div id="rk"><div class="hint">Carregando ranking…</div></div>`;
  openModal(`
    <div class="mhead"><h2>👥 Social</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody">${tabs}${corpo}</div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => openPeople(b.dataset.tab));
    if (tab === "pessoas" && !offline) montarPessoas(root);
    if (tab === "ranking" && !offline) montarRanking(root);
    if (tab !== "perfil") return;
    const vtm = root.querySelector(".vitrine.mine");
    if (vtm) ligarVitrine(vtm, items, true);
    const ve = root.querySelector("#vtEdit"); if (ve) ve.onclick = openVitrineEdit;
    const fb = root.querySelector("#fotoBtn");
    if (fb) fb.onclick = () => { const f = $("#file"); f.value = ""; f.onchange = async () => {
      if (!f.files[0]) return;
      try { const foto = await imageToAvatar(f.files[0]); await setDoc(doc(db, "perfis", currentUser.uid), perfilData({ foto })); myProfile = { ...myProfile, foto }; updateMeBtn(); toast("Foto atualizada!"); openPeople("perfil"); }
      catch (x) { toast("Não foi possível salvar a foto."); }
    }; f.click(); };
    const fr = root.querySelector("#fotoRm");
    if (fr) fr.onclick = async () => { try { await setDoc(doc(db, "perfis", currentUser.uid), perfilData({ foto: "" })); myProfile = { ...myProfile, foto: "" }; updateMeBtn(); openPeople("perfil"); } catch (x) { toast("Não foi possível remover."); } };
    root.querySelector("#apForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const novo = e.target.ap.value.trim().replace(/^@/, "");
      if (!APELIDO_RE.test(novo)) { toast("Use só letras e números (3 a 20), sem espaços nem símbolos.", 4000); return; }
      if (apelidoOfensivo(novo)) { toast("Esse apelido não é permitido. Escolha outro, sem palavrões ou ofensas.", 4000); return; }
      const atual = myProfile && myProfile.apelido;
      if (novo === atual) { toast("Esse já é o seu apelido."); return; }
      const key = apKey(novo), keyAtual = atual ? apKey(atual) : null;
      let ex;
      try { ex = await getDoc(doc(db, "apelidos", key)); }
      catch (x) { toast("O servidor recusou. Confira se as regras novas foram publicadas no Firebase.", 5000); return; }
      if (ex.exists() && (ex.data() || {}).uid !== currentUser.uid) { toast(`O apelido "${novo}" já está em uso. Tente outro, como ${novo}2.`, 4500); return; }
      try {
        const b = writeBatch(db);
        if (!ex.exists()) b.set(doc(db, "apelidos", key), { uid: currentUser.uid });
        if (keyAtual && keyAtual !== key) b.delete(doc(db, "apelidos", keyAtual));
        b.set(doc(db, "perfis", currentUser.uid), perfilData({ apelido: novo }));
        await b.commit();
        myProfile = { ...(myProfile || {}), apelido: novo, publico: !!(myProfile && myProfile.publico) };
        toast("Apelido salvo: @" + novo); openPeople("perfil");
      } catch (x) { toast(x.code === "permission-denied" ? "O servidor recusou. Confira se as regras novas foram publicadas no Firebase." : "Não foi possível salvar agora. Verifique a internet.", 5000); }
    });
    const pt = root.querySelector("#pubT");
    pt.addEventListener("change", async () => {
      if (!myProfile || !myProfile.apelido) { pt.checked = false; return; }
      try {
        await setDoc(doc(db, "perfis", currentUser.uid), perfilData({ publico: pt.checked }));
        myProfile = { ...myProfile, publico: pt.checked };
        toast(pt.checked ? "Perfil público: agora te encontram na Comunidade." : "Perfil privado: ninguém encontra você."); openPeople("perfil");
      } catch (x) { pt.checked = !pt.checked; toast("Não foi possível alterar agora."); }
    });
  });
}
function montarPessoas(root) {
  let perfis = null;
  const plist = root.querySelector("#plist"), pq = root.querySelector("#pq");
  const draw = () => {
    if (!perfis) return;
    const q = norm(pq.value).replace(/^@/, "");
    const l = perfis.filter(x => x.uid !== currentUser.uid && (!q || norm(x.apelido).includes(q)));
    plist.innerHTML = l.length ? l.map(x => `<button class="acct pbtn" data-uid="${esc(x.uid)}" data-ap="${esc(x.apelido)}">${avatarHTML(x.foto, x.apelido)}<div><b>@${esc(x.apelido)}</b><small>Ver estante →</small></div></button>`).join("")
      : `<div class="hint">${perfis.length ? "Ninguém com esse apelido." : "Ainda não há perfis públicos."}</div>`;
  };
  getDocs(query(collection(db, "perfis"), where("publico", "==", true), where("oculto", "==", false)))
    .then(snap => { perfis = snap.docs.map(d => ({ uid: d.id, apelido: String((d.data() || {}).apelido || ""), foto: (d.data() || {}).foto || "" })).filter(x => x.apelido).sort((a, b) => a.apelido.localeCompare(b.apelido)); draw(); })
    .catch(() => { plist.innerHTML = `<div class="err">Não consegui buscar agora. Verifique a internet.</div>`; });
  pq.addEventListener("input", draw);
  plist.addEventListener("click", (e) => { const b = e.target.closest("[data-uid]"); if (b) { const x = perfis.find(y => y.uid === b.dataset.uid); openVisit(b.dataset.uid, b.dataset.ap, x && x.foto); } });
}
async function montarRanking(root) {
  const box = root.querySelector("#rk");
  let r;
  try { const d = await getDoc(doc(db, "ranking", "atual")); r = d.exists() ? d.data() : null; }
  catch (e) { box.innerHTML = `<div class="err">Não consegui carregar o ranking agora.</div>`; return; }
  if (!box.isConnected) return;
  const aviso = `<p class="rknote">Ranking feito apenas com perfis públicos.</p>`;
  if (!r) { box.innerHTML = `<p class="hint">O primeiro ranking sai no dia 1º do próximo mês.</p>${aviso}`; return; }
  const capa = (x) => x.capa ? `<img class="rkcapa" src="${esc(x.capa)}" alt="" referrerpolicy="no-referrer">` : `<span class="rkcapa nocapa">${esc((x.titulo || "?").slice(0, 1))}</span>`;
  const obra = (x, i, metrica) => `<div class="rkrow"><span class="rkpos">${i + 1}</span>${capa(x)}<span class="rkt"><b>${esc(x.titulo)}</b>${x.titulo2 ? `<small>${esc(x.titulo2)}</small>` : ""}</span><span class="rkm">${metrica}</span></div>`;
  const lista = (arr, f) => (arr && arr.length) ? arr.map(f).join("") : `<p class="hint">Ainda sem dados suficientes.</p>`;
  box.innerHTML = `
    <div class="rkhead">🏆 Ranking de ${esc(nomeMes(r.mes))}</div>
    <div class="sect"><div class="secth">📚 Mais lidos</div>${lista(r.maisLidos, (x, i) => obra(x, i, ""))}</div>
    <div class="sect"><div class="secth">⭐ Mais bem avaliados</div>${lista(r.melhores, (x, i) => obra(x, i, `⭐ ${fmtNota(x.media)}<small>${x.notas} notas</small>`))}</div>
    <div class="sect"><div class="secth">🏅 Top 10 leitores</div>${lista(r.leitores, (x, i) => `<button class="rkrow pbtn" data-uid="${esc(x.uid)}" data-ap="${esc(x.apelido)}"><span class="rkpos">${i + 1}</span><span class="rkav" data-av="${esc(x.uid)}">${avatarHTML("", x.apelido)}</span><span class="rkt"><b data-ap-of="${esc(x.uid)}">@${esc(x.apelido)}</b></span><span class="rkm">${x.lidos} ${x.lidos === 1 ? "lido" : "lidos"}</span></button>`)}</div>
    ${aviso}`;
  box.querySelectorAll("[data-uid]").forEach(b => b.onclick = () => openVisit(b.dataset.uid, b.dataset.ap, ""));
  for (const el of box.querySelectorAll("[data-av]")) {
    getDoc(doc(db, "perfis", el.dataset.av)).then(d => {
      if (!d.exists() || !el.isConnected) return;
      const pf = d.data() || {};
      el.innerHTML = avatarHTML(pf.foto, pf.apelido);
      if (pf.apelido) {   // mostra sempre o apelido atual do perfil, do jeito que a pessoa digitou
        const b = box.querySelector(`[data-ap-of="${el.dataset.av}"]`); if (b) b.textContent = "@" + pf.apelido;
        const row = el.closest("[data-ap]"); if (row) row.dataset.ap = pf.apelido;
      }
    }).catch(() => {});
  }
}


// ---------- vitrine do perfil ----------
const CORES = { roxo: "#7c3aed", azul: "#2563eb", ciano: "#0891b2", verde: "#16a34a", laranja: "#ea580c", vermelho: "#dc2626", rosa: "#db2777", grafite: "#475569" };
const CORES_NOME = { roxo: "Roxo", azul: "Azul", ciano: "Ciano", verde: "Verde", laranja: "Laranja", vermelho: "Vermelho", rosa: "Rosa", grafite: "Grafite" };
const membroDesdeAuth = () => (currentUser && Date.parse(currentUser.metadata && currentUser.metadata.creationTime)) || Date.now();
function safeBanner(b) {
  b = String(b || "");
  if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(b) && b.length <= 160000) return b;
  if (/^https:\/\/[^\s"'<>]+$/.test(b) && b.length <= 600) return b;
  return "";
}
const mesAno = (ms) => { if (!ms) return ""; const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; };
function haQuanto(ms) {
  if (!ms) return "";
  const d = (Date.now() - ms) / 86400000;
  if (d < 1) return "hoje"; if (d < 2) return "ontem"; if (d < 30) return `há ${Math.floor(d)} dias`;
  const m = Math.floor(d / 30.4); return m < 12 ? `há ${m} ${m === 1 ? "mês" : "meses"}` : `há ${Math.floor(m / 12)} ${m < 24 ? "ano" : "anos"}`;
}
function capaMini(it, cls) {
  const cv = safeCover(it.cover);
  return cv ? `<img class="${cls}" src="${esc(cv)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="${cls} vph">${esc((it.title || "?").slice(0, 1).toUpperCase())}</span>`;
}
function vitrineHTML(p, its, visita) {
  const cor = CORES[p.cor] || CORES.roxo, bn = safeBanner(p.banner);
  const todos = [...its.values()];
  const cnt = { lendo: 0, fila: 0, pausado: 0, concluido: 0 }; todos.forEach(it => { cnt[stOf(it)] = (cnt[stOf(it)] || 0) + 1; });
  const favs = (p.favoritos || []).map(id => its.get(id)).filter(Boolean).slice(0, 3);
  const lendo = todos.filter(it => stOf(it) === "lendo").sort((a, b) => (b.lastReadAt || b.updatedAt || 0) - (a.lastReadAt || a.updatedAt || 0))[0];
  const ativ = todos.filter(it => it.updatedAt || it.createdAt).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)).slice(0, 3);
  const verbo = (it) => ({ concluido: "concluiu", fila: "colocou na fila", pausado: "pausou", lendo: `leu até o cap. ${fmtCap(it.chapter)} de` })[stOf(it)] || "atualizou";
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  return `
  <div class="vt" style="--vt:${cor}">
    <div class="vtban">${bn ? `<img src="${esc(bn)}" alt="" referrerpolicy="no-referrer">` : ""}</div>
    <div class="vtin">
      <div class="vthead">${avatarHTML(p.foto, p.apelido, "vtav")}<div class="vtname"><b>@${esc(p.apelido || "")}</b>${p.membroDesde ? `<small>Membro desde ${mesAno(p.membroDesde)}</small>` : ""}</div></div>
      ${p.bio ? `<p class="vtbio">${esc(p.bio)}</p>` : ""}
      <div class="vtcnt"><span><i style="background:var(--c-lendo)"></i>${cnt.lendo} lendo</span><span><i style="background:var(--c-fila)"></i>${cnt.fila} na fila</span><span><i style="background:var(--c-pausa)"></i>${plural(cnt.pausado, "pausado", "pausados")}</span><span><i style="background:var(--c-fim)"></i>${plural(cnt.concluido, "concluído", "concluídos")}</span></div>
      ${favs.length ? `<div class="vtsec">Favoritos</div><div class="vtfavs">${favs.map(it => `<button type="button" class="vtfav" data-mid="${esc(it.id)}">${capaMini(it, "vtfc")}<span>${esc(it.title)}</span></button>`).join("")}</div>` : ""}
    </div>
  </div>
  <div class="vtmais">
    ${lendo ? `<div class="vtbox"><div class="vtsec">Lendo agora</div><button type="button" class="vtrow" data-mid="${esc(lendo.id)}">${capaMini(lendo, "vtrc")}<span><b>${esc(lendo.title)}</b><small>Capítulo ${fmtCap(lendo.chapter)}</small></span></button></div>` : ""}
    <div class="vtbox vtgen hidden"><div class="vtsec">Gêneros favoritos</div><div class="gens"></div></div>
    ${ativ.length ? `<div class="vtbox"><div class="vtsec">Atividade recente</div>${ativ.map(it => `<button type="button" class="vtrow" data-mid="${esc(it.id)}">${capaMini(it, "vtrc")}<span>${visita ? `@${esc(p.apelido || "")}` : "Você"} ${verbo(it)} <b>${esc(it.title)}</b><small>${haQuanto(it.updatedAt || it.createdAt)}</small></span></button>`).join("")}</div>` : ""}
  </div>`;
}
// liga os cliques (abre o ⓘ do mangá) e calcula os gêneros favoritos pelo catálogo
function ligarVitrine(box, its, fechar) {
  box.querySelectorAll("[data-mid]").forEach(b => b.onclick = () => { const id = b.dataset.mid; if (fechar) closeModal(); openInfo(id); });
  const gbox = box.querySelector(".vtgen"); if (!gbox) return;
  const ids = [...new Set([...its.values()].map(it => it.catId).filter(Boolean))].slice(0, 60);
  if (!ids.length) return;
  Promise.all(ids.map(k => lerCatalogo(k))).then(cats => {
    const c = {}; cats.forEach(x => ((x && x.generos) || []).forEach(g => { c[g] = (c[g] || 0) + 1; }));
    const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    if (!top.length || !gbox.isConnected) return;
    gbox.querySelector(".gens").innerHTML = top.map(g => `<span>${esc(g)}</span>`).join("");
    gbox.classList.remove("hidden");
  }).catch(() => {});
}
async function bannerDaGaleria(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const W = 1200, H = 400, c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const r = Math.max(W / img.naturalWidth, H / img.naturalHeight), w = W / r, h = H / r;
    ctx.drawImage(img, (img.naturalWidth - w) / 2, (img.naturalHeight - h) / 2, w, h, 0, 0, W, H);
    for (const [s, qs] of [[1, [0.82, 0.7, 0.6]], [0.75, [0.75, 0.6, 0.5]]]) {
      let cv = c; if (s < 1) { cv = document.createElement("canvas"); cv.width = W * s; cv.height = H * s; cv.getContext("2d").drawImage(c, 0, 0, cv.width, cv.height); }
      for (const q of qs) { let o = cv.toDataURL("image/webp", q); if (!o.startsWith("data:image/webp")) o = cv.toDataURL("image/jpeg", q); if (o.length <= 160000) return o; }
    }
    throw new Error("grande");
  } finally { URL.revokeObjectURL(url); }
}
async function buscaBanners(q) {
  const query = `query($q:String){Page(perPage:25){media(search:$q,isAdult:false,sort:SEARCH_MATCH){id bannerImage title{romaji english}}}}`;
  const j = await httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables: { q } }) });
  const vistos = new Set();
  return ((j.data && j.data.Page && j.data.Page.media) || []).filter(m => m.bannerImage && !vistos.has(m.bannerImage) && vistos.add(m.bannerImage))
    .map(m => ({ url: m.bannerImage, nome: (m.title.english || m.title.romaji || "").trim() }));
}
// ---------- busca de GIFs: GIPHY + KLIPY juntos (chaves vêm do GitHub, em version.js) ----------
const gifKeys = () => { const k = window.GIF_KEYS || {}; return { giphy: String(k.giphy || ""), klipy: String(k.klipy || "") }; };
const temBuscaGif = () => { const k = gifKeys(); return !!(k.giphy || k.klipy); };
function urlGif(o, tamanhos) {
  for (const t of tamanhos) { const f = o && o[t]; if (!f) continue; for (const fm of ["gif", "webp"]) { const u = f[fm] && (f[fm].url || f[fm]); if (typeof u === "string" && /^https:\/\//.test(u)) return u; } }
  return "";
}
async function buscaGiphy(q, key) {
  const j = await httpJSON(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13&lang=pt`);
  return (j.data || []).map(g => {
    const im = g.images || {};
    const full = (im.original && im.original.url) || (im.downsized && im.downsized.url) || "";
    const thumb = (im.fixed_width_downsampled && im.fixed_width_downsampled.url) || (im.fixed_width && im.fixed_width.url) || full;
    return { url: full.split("?")[0], thumb, fonte: "GIPHY", w: Number(im.original && im.original.width) || 0, h: Number(im.original && im.original.height) || 0 };
  }).filter(g => /^https:\/\//.test(g.url));
}
async function buscaKlipy(q, key) {
  const cid = encodeURIComponent((currentUser && currentUser.uid) || "anon");
  const j = await httpJSON(`https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/search?q=${encodeURIComponent(q)}&per_page=24&page=1&customer_id=${cid}&locale=pt_BR&content_filter=medium`);
  const lista = (j.data && (j.data.data || j.data)) || [];
  return (Array.isArray(lista) ? lista : []).filter(g => g && g.file && g.type !== "ad").map(g => ({
    url: urlGif(g.file, ["hd", "md", "sm"]), thumb: urlGif(g.file, ["sm", "xs", "md"]), fonte: "KLIPY",
  })).filter(g => g.url);
}
async function buscaGifs(q) {
  const k = gifKeys(), tarefas = [];
  if (k.giphy) tarefas.push(buscaGiphy(q, k.giphy));
  if (k.klipy) tarefas.push(buscaKlipy(q, k.klipy));
  const res = await Promise.allSettled(tarefas);
  const listas = res.filter(r => r.status === "fulfilled").map(r => r.value);
  if (!listas.length) throw new Error("falhou");
  const out = [], vistos = new Set();
  for (let i = 0; i < 30; i++) for (const l of listas) { const g = l[i]; if (g && !vistos.has(g.url)) { vistos.add(g.url); out.push(g); } }   // intercala as fontes
  return out;
}
const testaImagem = (u) => new Promise((res) => { const i = new Image(); i.referrerPolicy = "no-referrer"; const t = setTimeout(() => res(false), 12000); i.onload = () => { clearTimeout(t); res(i.naturalWidth > 0); }; i.onerror = () => { clearTimeout(t); res(false); }; i.src = u; });

function openVitrineEdit() {
  const p = myProfile || {};
  const d = { banner: safeBanner(p.banner), cor: CORES[p.cor] ? p.cor : "roxo", bio: String(p.bio || ""), favoritos: (p.favoritos || []).filter(id => items.has(id)).slice(0, 3) };
  const meus = [...items.values()].sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
  openModal(`
    <div class="mhead"><h2>✏️ Editar vitrine</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody">
      <div class="sect">
        <div class="secth">Capa do perfil</div>
        <div class="vtban edit" id="veBan" style="--vt:${CORES[d.cor]}"></div>
        <div class="vemodo">
          <button type="button" class="btn" data-modo="cat">📚 Catálogo</button>
          <button type="button" class="btn" data-modo="gal">🖼️ Galeria</button>
          <button type="button" class="btn" data-modo="gif">🎞️ GIF</button>
        </div>
        <div id="vePainel"></div>
        <button type="button" class="btn ghost hidden" id="veRm">Remover capa</button>
      </div>
      <div class="sect">
        <div class="secth">Cor do perfil</div>
        <div class="vecores">${Object.keys(CORES).map(k => `<button type="button" class="vecor" data-cor="${k}" title="${CORES_NOME[k]}" style="background:${CORES[k]}"></button>`).join("")}</div>
      </div>
      <div class="sect">
        <div class="secth">Mini-bio <small id="veBioN"></small></div>
        <textarea id="veBio" maxlength="120" rows="2" placeholder="Ex.: Leitor de manhwa de ação. Sempre na fila de algo novo."></textarea>
      </div>
      <div class="sect">
        <div class="secth">Favoritos <small id="veFavN"></small></div>
        <p class="hint">Escolha até 3 mangás da sua estante. Você pode trocar quando quiser.</p>
        <div class="search" style="height:40px">🔍<input id="veFq" type="search" placeholder="Filtrar sua estante…" autocomplete="off"></div>
        <div id="veFavs" class="vefavs"></div>
      </div>
    </div>
    <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="button" class="btn primary" id="veSave">Salvar</button></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const ban = root.querySelector("#veBan"), painel = root.querySelector("#vePainel"), rm = root.querySelector("#veRm");
    const showBan = () => {
      ban.style.setProperty("--vt", CORES[d.cor]);
      ban.innerHTML = d.banner ? `<img src="${esc(d.banner)}" alt="" referrerpolicy="no-referrer">` : `<span>Sem capa: fica na cor do perfil</span>`;
      rm.classList.toggle("hidden", !d.banner);
    };
    showBan();
    rm.onclick = () => { d.banner = ""; showBan(); };
    const modos = root.querySelectorAll("[data-modo]");
    const marca = (m) => modos.forEach(b => b.classList.toggle("on", b.dataset.modo === m));
    root.querySelector('[data-modo="cat"]').onclick = () => {
      marca("cat");
      const sug = (d.favoritos.map(id => items.get(id)).filter(Boolean)[0] || meus[0] || {}).title || "";
      painel.innerHTML = `<p class="hint">Banners prontos das obras (AniList). Busque pelo nome e toque em um.</p>
        <div class="urlrow"><input id="vbQ" placeholder="Nome da obra (ex.: Eleceed)" value="${esc(sug)}"><button type="button" class="btn" id="vbGo">Buscar</button></div>
        <div id="vbRes" class="vbres"></div>`;
      const q = painel.querySelector("#vbQ"), res = painel.querySelector("#vbRes");
      const buscar = async () => {
        const t = q.value.trim(); if (!t) return;
        if (!navigator.onLine) { res.innerHTML = `<p class="hint">📴 Sem internet.</p>`; return; }
        res.innerHTML = `<p class="hint">Buscando…</p>`;
        try {
          const l = await buscaBanners(t);
          res.innerHTML = l.length ? l.map(b => `<button type="button" class="vbopt" data-u="${esc(b.url)}" title="${esc(b.nome)}"><img src="${esc(b.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><small>${esc(b.nome)}</small></button>`).join("")
            : `<p class="hint">Nenhum banner encontrado para "${esc(t)}". Tente o nome em inglês ou japonês, ou use Galeria/GIF.</p>`;
          res.querySelectorAll("[data-u]").forEach(b => b.onclick = () => { d.banner = safeBanner(b.dataset.u); showBan(); res.querySelectorAll(".vbopt").forEach(x => x.classList.toggle("on", x === b)); });
        } catch (e) { res.innerHTML = `<p class="err">Não consegui buscar agora. Tente de novo.</p>`; }
      };
      painel.querySelector("#vbGo").onclick = buscar;
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscar(); } });
      if (sug) buscar();
    };
    root.querySelector('[data-modo="gal"]').onclick = () => {
      marca("gal"); painel.innerHTML = `<p class="hint">Escolha uma imagem do seu PC ou celular. Ela é cortada no formato de capa (largura 3× a altura).</p>`;
      const f = $("#file"); f.value = "";
      f.onchange = async () => {
        if (!f.files[0]) return;
        painel.innerHTML = `<p class="hint">Preparando a imagem…</p>`;
        try { d.banner = await bannerDaGaleria(f.files[0]); showBan(); painel.innerHTML = `<p class="hint">✅ Imagem pronta. Toque em Salvar.</p>`; }
        catch (e) { painel.innerHTML = `<p class="err">Não consegui usar essa imagem. Tente outra.</p>`; }
      };
      f.click();
    };
    root.querySelector('[data-modo="gif"]').onclick = () => {
      marca("gif");
      const busca = temBuscaGif();
      painel.innerHTML = `${busca ? `<div class="urlrow"><input id="vgQ" placeholder="Buscar GIF (ex.: solo leveling)" autocomplete="off"><button type="button" class="btn" id="vgBusca">Buscar</button></div>
        <div id="vgRes" class="vgres"></div>
        <p class="vgcred">GIFs: Powered by GIPHY · KLIPY</p>
        <details class="vglink"><summary>Ou colar o link de um GIF</summary>` : ""}
        <p class="hint">Cole o link de um GIF (ou imagem) de qualquer site. No Giphy: abra o GIF, clique com o botão direito (no celular, segure o dedo) e escolha <b>Copiar endereço da imagem</b>. O link precisa começar com https://</p>
        <div class="urlrow"><input id="vgU" placeholder="https://media.giphy.com/....gif" inputmode="url"><button type="button" class="btn" id="vgGo">Usar</button></div>
        ${busca ? `</details>` : ""}`;
      if (busca) {
        const q = painel.querySelector("#vgQ"), res = painel.querySelector("#vgRes");
        const buscar = async () => {
          const t = q.value.trim(); if (!t) { q.focus(); return; }
          if (!navigator.onLine) { res.innerHTML = `<p class="hint">📴 Sem internet.</p>`; return; }
          res.innerHTML = `<p class="hint">Buscando GIFs…</p>`;
          try {
            const l = await buscaGifs(t);
            res.innerHTML = l.length ? l.map(g => `<button type="button" class="vgopt" data-u="${esc(g.url)}" title="${esc(g.fonte)}"><img src="${esc(g.thumb || g.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join("")
              : `<p class="hint">Nenhum GIF encontrado para "${esc(t)}". Tente em inglês (ex.: "solo leveling anime").</p>`;
            res.querySelectorAll("[data-u]").forEach(b => b.onclick = () => {
              const u = safeBanner(b.dataset.u); if (!u || u.startsWith("data:")) return;
              d.banner = u; showBan(); res.querySelectorAll(".vgopt").forEach(x => x.classList.toggle("on", x === b));
            });
          } catch (e) { res.innerHTML = `<p class="err">Não consegui buscar agora (o limite de buscas por hora pode ter acabado). Tente daqui a pouco ou cole um link.</p>`; }
        };
        painel.querySelector("#vgBusca").onclick = buscar;
        q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscar(); } });
        const sug = (d.favoritos.map(id => items.get(id)).filter(Boolean)[0] || meus[0] || {}).title || "";
        if (sug) { q.value = sug; buscar(); }
      }
      const u = painel.querySelector("#vgU");
      const usar = async () => {
        const v = u.value.trim();
        if (!safeBanner(v) || v.startsWith("data:")) { toast("O link precisa começar com https://", 3500); return; }
        painel.querySelector("#vgGo").textContent = "Testando…";
        const ok = await testaImagem(v);
        painel.querySelector("#vgGo").textContent = "Usar";
        if (!ok) { toast("Esse link não abriu uma imagem. Use «Copiar endereço da imagem», não o link da página.", 5000); return; }
        d.banner = v; showBan();
      };
      painel.querySelector("#vgGo").onclick = usar;
      u.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); usar(); } });
    };
    // cor
    const cores = root.querySelectorAll("[data-cor]");
    const marcaCor = () => cores.forEach(b => b.classList.toggle("on", b.dataset.cor === d.cor));
    cores.forEach(b => b.onclick = () => { d.cor = b.dataset.cor; marcaCor(); showBan(); });
    marcaCor();
    // bio
    const bio = root.querySelector("#veBio"), bioN = root.querySelector("#veBioN");
    bio.value = d.bio; const contaBio = () => { bioN.textContent = `${bio.value.length}/120`; }; contaBio();
    bio.addEventListener("input", contaBio);
    // favoritos
    const fq = root.querySelector("#veFq"), fl = root.querySelector("#veFavs"), fn = root.querySelector("#veFavN");
    const drawFavs = () => {
      fn.textContent = `${d.favoritos.length}/3`;
      const q = norm(fq.value);
      const l = meus.filter(it => !q || norm(it.title).includes(q));
      const sel = d.favoritos.map(id => items.get(id)).filter(Boolean);
      const resto = l.filter(it => !d.favoritos.includes(it.id));
      fl.innerHTML = (q ? [] : sel).concat(q ? l : resto).map(it => {
        const on = d.favoritos.includes(it.id);
        return `<button type="button" class="vefav ${on ? "on" : ""}" data-fid="${esc(it.id)}">${capaMini(it, "vtrc")}<span class="vft">${esc(it.title)}</span><b>${on ? "★ " + (d.favoritos.indexOf(it.id) + 1) : "☆"}</b></button>`;
      }).join("") || `<p class="hint">Nada encontrado.</p>`;
      fl.querySelectorAll("[data-fid]").forEach(b => b.onclick = () => {
        const id = b.dataset.fid, i = d.favoritos.indexOf(id);
        if (i >= 0) d.favoritos.splice(i, 1);
        else if (d.favoritos.length >= 3) { toast("Máximo de 3 favoritos. Tire um para colocar outro."); return; }
        else d.favoritos.push(id);
        drawFavs();
      });
    };
    fq.addEventListener("input", drawFavs); drawFavs();
    root.querySelector("#veSave").onclick = async () => {
      const texto = bio.value.replace(/\s+/g, " ").trim().slice(0, 120);
      if (texto && AP_RUINS_CONTEM.some(w => norm(texto).replace(/[^a-z]/g, "").includes(w))) { toast("A mini-bio tem palavras não permitidas.", 4000); return; }
      const patch = { banner: d.banner, cor: d.cor, bio: texto, favoritos: d.favoritos.slice(0, 3) };
      try {
        await setDoc(doc(db, "perfis", currentUser.uid), perfilData(patch));
        myProfile = { ...myProfile, ...patch };
        toast("Vitrine salva!"); openPeople("perfil");
      } catch (x) {
        toast(x.code === "permission-denied" ? "O servidor recusou. As regras novas do Firebase ainda não foram publicadas." : (x.code === "invalid-argument" ? "A imagem da capa ficou grande demais. Tente outra." : "Não foi possível salvar agora. Verifique a internet."), 5000);
      }
    };
  });
}

// ---------- estante de outra pessoa (só leitura) ----------
async function refreshVisitAval(mid) {
  if (!ui.visit) return;
  const d = await getDoc(doc(db, "users", ui.visit.uid, "avaliacoes", mid));
  ui.visit.avals[mid] = d.exists() ? ((d.data() || {}).notas || {}) : {};
}
async function openVisit(uid, apelido, foto) {
  closeModal();
  ui.visit = { uid, apelido, foto: foto || "", items: new Map(), avals: {}, loading: true };
  ui.filter = "todos"; window.scrollTo(0, 0); render();
  try {
    const [ms, av, pf] = await Promise.all([getDocs(collection(db, "users", uid, "mangas")), getDocs(collection(db, "users", uid, "avaliacoes")), getDoc(doc(db, "perfis", uid))]);
    if (!ui.visit || ui.visit.uid !== uid) return;
    ui.visit.perfil = pf.exists() ? (pf.data() || {}) : { apelido };
    ms.forEach(d => ui.visit.items.set(d.id, { id: d.id, ...d.data() }));
    av.forEach(d => { ui.visit.avals[d.id] = (d.data() || {}).notas || {}; });
    ui.visit.loading = false; render();
  } catch (e) {
    toast("Essa estante não está disponível (o perfil pode ter ficado privado).", 4000); closeVisit();
  }
}
function closeVisit() { ui.visit = null; ui.filter = "todos"; window.scrollTo(0, 0); render(); }

// ---------- suporte ----------
function openSupport() {
  openModal(`
    <form id="supF">
      <div class="mhead"><h2>🛠️ Reportar problema</h2><button type="button" class="icon-btn" data-x>✕</button></div>
      <div class="mbody">
        <p class="hint">Conte o que aconteceu e o que você estava fazendo. A versão do app e o tipo de aparelho vão junto automaticamente.</p>
        <label class="f">O que aconteceu?<textarea name="t" maxlength="1000" rows="6" required placeholder="Ex.: ao trocar a capa no celular, o app fechou sozinho."></textarea></label>
      </div>
      <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="submit" class="btn primary">Enviar</button></div>
    </form>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelector("#supF").addEventListener("submit", async (e) => {
      e.preventDefault();
      const texto = e.target.t.value.trim().slice(0, 1000); if (!texto) return;
      const plataforma = isNativeApp ? "Android" : window.estanteNative ? "Windows" : "Navegador";
      try {
        await addDoc(collection(db, "suporte"), { texto, uid: currentUser.uid, email: String(currentUser.email || ""), apelido: (myProfile && myProfile.apelido) || "", versao: String(window.APP_VERSION || 0), plataforma, criadoEm: Date.now(), resolvido: false });
        closeModal(); toast("Enviado! Obrigado por avisar. 🙌", 3500);
      } catch (x) { toast("Não foi possível enviar agora. Tente de novo com internet."); }
    });
  });
}
function openReports() {
  let un = null;
  openModal(`
    <div class="mhead"><h2>🛠️ Relatos</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody"><div id="rlist" class="menu-list"><div class="hint">Carregando…</div></div></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const rl = root.querySelector("#rlist");
    un = onSnapshot(collection(db, "suporte"), (snap) => {
      const l = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.resolvido - b.resolvido) || (b.criadoEm || 0) - (a.criadoEm || 0));
      rl.innerHTML = l.length ? l.map(r => `
        <div class="report ${r.resolvido ? "done" : ""}" data-id="${esc(r.id)}">
          <div class="rmeta">${r.resolvido ? "✅" : "🟠"} <b>${esc(r.apelido ? "@" + r.apelido : r.email)}</b> · ${esc(r.plataforma)} · v1.${esc(r.versao)} · ${new Date(r.criadoEm || 0).toLocaleString("pt-BR")}</div>
          <div class="rtext">${esc(r.texto)}</div>
          <div class="ract">${r.resolvido ? "" : `<button class="mini" data-r="ok">✓ Resolvido</button>`}<button class="mini" data-r="del" style="color:var(--red)">Apagar</button></div>
        </div>`).join("") : `<div class="hint">Nenhum relato. 🎉</div>`;
    }, () => { rl.innerHTML = `<div class="err">Sem permissão para ver os relatos.</div>`; });
    rl.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-r]"); if (!b) return;
      const id = b.closest("[data-id]").dataset.id;
      try {
        if (b.dataset.r === "ok") await updateDoc(doc(db, "suporte", id), { resolvido: true });
        else { if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Apagar?"; return; } await deleteDoc(doc(db, "suporte", id)); }
      } catch (x) { toast("Não foi possível alterar."); }
    });
    return () => { if (un) un(); };
  });
}

// ---------- eventos ----------
$("#grid").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  const act = btn.dataset.act;
  if (ui.visit) {                       // estante de outra pessoa: só ver detalhes e abrir o site
    if (act === "info") { e.preventDefault(); openInfo(id); }
    return;
  }
  const it = items.get(id); if (!it) return;
  const c = Number(it.chapter) || 0;
  if (act === "read") { markSeen(id); return; }
  if (act === "info") { e.preventDefault(); openInfo(id); return; }
  if (act === "plus") commit(id, { chapter: Math.floor(c) + 1, lastReadAt: Date.now() });
  else if (act === "minus") { if (c > 0) commit(id, { chapter: Math.max(0, Math.ceil(c) - 1), lastReadAt: Date.now() }); }
  else if (act === "goto") openGoto(id);
  else if (act === "edit") openEditor(id);
});
$("#chips").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (!b) return; ui.filter = b.dataset.f; render(); });
$("#q").addEventListener("input", (e) => { ui.q = e.target.value; render(); });
$("#sort").addEventListener("change", (e) => { ui.sort = e.target.value; try { localStorage.setItem("estante-sort", ui.sort); } catch (x) {} render(); });
$("#addBtn").addEventListener("click", () => openEditor(null));
$("#empty").addEventListener("click", (e) => { if (e.target.id === "emptyAdd") openEditor(null); });
$("#menuBtn").addEventListener("click", openMenu);
$("#peopleBtn").addEventListener("click", () => openPeople("perfil"));
$("#bellBtn").addEventListener("click", openBell);
$("#visitBack").addEventListener("click", closeVisit);
window.addEventListener("beforeunload", (e) => { if (pending.size) { for (const id of [...pending.keys()]) { clearTimeout(pending.get(id)); flush(id); } } });
document.addEventListener("visibilitychange", () => { if (document.hidden) for (const id of [...pending.keys()]) { clearTimeout(pending.get(id)); flush(id); } else render(); });

