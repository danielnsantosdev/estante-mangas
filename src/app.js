// Estante de Mangás — app (Android/Windows) com Firebase: login por e-mail/senha + Firestore
import "./abertura.js";   // a abertura aparece antes de tudo, ao abrir o app
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
  query, where, addDoc, updateDoc, deleteField, orderBy, limit, serverTimestamp,
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
let col = null, colPriv = null, unsub = null, unsubPriv = null, loaded = false, currentUser = null;
let snapPub = new Map(), snapPriv = new Map();
const movendo = new Map();   // mangás trocando entre visível e privado: ficam na tela até o servidor confirmar
let netState = { pendingWrites: false, fromCache: true };
let savedSort = "recent"; try { savedSort = localStorage.getItem("estante-sort") || "recent"; } catch (e) {}
const ui = { filter: "todos", q: "", sort: savedSort, visit: null };   // visit = estante de outra pessoa aberta
let myProfile = null;            // { apelido, publico }
let myAvisos = [], forumDnd = false;   // menções/respostas no fórum (sino) e "Não perturbe"
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
  colPriv = collection(db, "users", uid, "privados");
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
  extraUnsubs.push(onSnapshot(collection(db, "users", uid, "avisos"), (snap) => {
    myAvisos = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.em || 0) - (a.em || 0)); updateBell();
  }, () => {}));
  extraUnsubs.push(onSnapshot(doc(db, "users", uid, "config", "forum"), (d) => { forumDnd = !!(d.exists() && (d.data() || {}).dnd); updateBell(); }, () => {}));
  try { if (!localStorage.getItem(AVAL_KEY)) localStorage.setItem(AVAL_KEY, String(Date.now())); } catch (e) {}
  limparLixeira(uid);
  carregarAnimes();
  render();
  talvezTutorial(uid);
  const slowT = setTimeout(() => {
    if (!loaded) { loaded = true; render(); }
  }, 8000);
  // junta a estante pública (mangas) com a privada (privados) num mapa só
  const juntar = () => {
    const next = new Map();
    snapPub.forEach((v, k) => next.set(k, v));
    snapPriv.forEach((v, k) => next.set(k, v));
    for (const [id, it] of movendo) {
      const chegou = it.privado ? (snapPriv.has(id) && !snapPub.has(id)) : (snapPub.has(id) && !snapPriv.has(id));
      if (chegou) movendo.delete(id); else next.set(id, it);
    }
    for (const id of pending.keys()) { if (items.has(id)) next.set(id, items.get(id)); else next.delete(id); }
    items = next;
  };
  if (unsubPriv) { try { unsubPriv(); } catch (e) {} }
  unsubPriv = onSnapshot(colPriv, (snap) => {
    snapPriv = new Map(); snap.forEach(d => snapPriv.set(d.id, { id: d.id, ...d.data(), privado: true }));
    juntar(); render();
  }, () => {});
  unsub = onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
    snapPub = new Map(); snap.forEach(d => snapPub.set(d.id, { id: d.id, ...d.data() }));
    juntar();
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
    alias: String(it.alias || "").trim().slice(0, 1000),
    catId: /^(al|mal)[0-9]{1,10}$/.test(String(it.catId || "")) ? String(it.catId) : "",
    chapter: Math.min(99999, parseCap(it.chapter)),
    status: stOf(it),
    link: fixLink(it.link).slice(0, 2000),
    cover: safeCover(it.cover),
    nota: parseNota(it.nota),
    comentario: String(it.comentario || "").trim().slice(0, 300),
  };
  if (it.capa18) o.capa18 = true;   // capa com conteúdo adulto: o mangá não pode ficar público
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
  const p = it ? setDoc(doc(it.privado ? colPriv : col, id), strip(it)) : deleteDoc(doc(col, id));
  p.catch(e => {
    if (e.code === "invalid-argument" || e.code === "resource-exhausted") toast("Não foi possível salvar: a imagem é grande demais.", 4000);
    else if (e.code === "permission-denied") toast("O servidor recusou salvar. Confira se as regras novas foram publicadas no Firebase.", 5000);
    else toast("Falha ao salvar — tente de novo.", 3000);
  });
  updateSync();
}
// troca entre visível e privado: muda o mangá de coleção (de uma vez só)
function trocarPrivado(id, privado) {
  const it = items.get(id); if (!it || !!it.privado === !!privado) return;
  if (!privado && bloqueioPublico(it)) { toast(MSG_BLOQ[bloqueioPublico(it)], 5000); return; }
  clearTimeout(pending.get(id)); pending.delete(id);
  const novo = { ...it, privado: !!privado, updatedAt: Date.now() };
  if (!privado) delete novo.privado;
  items.set(id, novo); movendo.set(id, novo); render();
  const b = writeBatch(db);
  b.set(doc(privado ? colPriv : col, id), strip(novo));
  b.delete(doc(privado ? col : colPriv, id));
  b.commit().then(() => toast(privado ? "Privado: só você vê este mangá." : "Visível: aparece na sua estante pública.", 2600))
    .catch(() => { movendo.delete(id); toast("Não foi possível mudar agora. Verifique a internet.", 3500); });
}
function commit(id, patch) {
  const old = items.get(id); if (!old) return;
  items.set(id, { ...old, ...patch, updatedAt: Date.now() });
  render(); scheduleWrite(id);
}
function create(data) {
  const id = doc(col).id; const now = Date.now();
  if (!data.privado) delete data.privado;
  items.set(id, { id, createdAt: now, updatedAt: now, lastReadAt: now, ...data });
  render(); scheduleWrite(id, 0);
}
function remove(id) {
  // Não apaga de vez: vai para a lixeira por 30 dias
  const it = items.get(id); if (!it) return;
  clearTimeout(pending.get(id)); pending.delete(id);
  items.delete(id); render();
  const b = writeBatch(db);
  b.set(doc(db, "users", currentUser.uid, "lixeira", id), { ...clean(it), ...(it.privado ? { privado: true } : {}), excluidoEm: Date.now() });
  b.delete(doc(it.privado ? colPriv : col, id));
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
        .then(r => { if (r.status >= 400) throw new Error("http " + r.status); return typeof r.data === "string" ? r.data : JSON.stringify(r.data || ""); })
    : fetch(url, { headers: { Accept: "text/html" } }).then(r => { if (!r.ok) throw new Error("http " + r.status); return r.text(); });
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
        if (chk[it.id] && chk[it.id].falhas) { delete chk[it.id].falhas; saveChk(); render(); }   // voltou a funcionar
        if (n == null) continue;
        const c = chk[it.id] || {};
        if (c.seen == null) c.seen = n;      // primeira vez: só marca a referência
        c.latest = n; c.t = Date.now(); chk[it.id] = c;
        saveChk(); render();
      } catch (e) {
        // Só conta como "link com problema" quando a página não existe (404/410) ou o endereço não responde.
        // Site que bloqueia leitura automática (403, 429, 5xx) não gera aviso: ele abre normal no navegador.
        const m = String((e && e.message) || ""); const cod = Number((m.match(/http (\d{3})/) || [])[1] || 0);
        if (cod && cod !== 404 && cod !== 410) continue;
        const c = chk[it.id] || {}; const dia = new Date().toISOString().slice(0, 10);
        c.falhas = [...new Set([...(c.falhas || []), dia])].slice(-3); c.t = Date.now(); chk[it.id] = c;
        saveChk(); render();
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
// link com problema: falhou em 2 dias diferentes seguidos, sem funcionar no meio
const linkComProblema = (it) => { const c = chk[it.id]; return !!(c && c.falhas && c.falhas.length >= 2 && fixLink(it.link)); };
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
// ---------- anime: o AniList liga cada mangá às adaptações em anime ----------
const ANIME_CAMPOS = `relations{edges{relationType node{id idMal type format status title{romaji english} startDate{year month} episodes studios(isMain:true){nodes{name}}}}}`;
function animeDe(m) {
  const ns = ((m && m.relations && m.relations.edges) || []).filter(e => e.relationType === "ADAPTATION" && e.node && e.node.type === "ANIME" && e.node.format !== "MUSIC").map(e => e.node);
  if (!ns.length) return null;
  const prox = ns.find(n => n.status === "NOT_YET_RELEASED"), exib = ns.find(n => n.status === "RELEASING");
  const ref = prox || exib || ns.slice().sort((a, b) => ((b.startDate || {}).year || 0) - ((a.startDate || {}).year || 0))[0];
  const sd = ref.startDate || {};
  return { st: prox ? "anunciado" : exib ? "exibicao" : "finalizado", id: ref.id, mal: ref.idMal || null,
    titulo: (ref.title && (ref.title.english || ref.title.romaji)) || "", ano: sd.year || null, mes: sd.month || null,
    estudio: ((ref.studios && ref.studios.nodes) || []).map(x => x.name).slice(0, 2).join(", "), eps: ref.episodes || null,
    temporadas: ns.filter(n => ["TV", "TV_SHORT", "ONA"].includes(n.format)).length };
}
const tagAnime = (a) => !a ? "" : a.st === "anunciado" ? `<span class="atag novo">Anime anunciado</span>` : `<span class="atag">Tem anime</span>`;
async function buscaAniList(q) {
  const query = `query($q:String){Page(perPage:10){media(search:$q,type:MANGA,isAdult:false,sort:SEARCH_MATCH){id idMal title{romaji english native} synonyms coverImage{large} genres description(asHtml:false) countryOfOrigin format startDate{year} ${ANIME_CAMPOS}}}}`;
  const j = await httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables: { q } }) });
  return ((j.data && j.data.Page && j.data.Page.media) || []).filter(m => m.format !== "NOVEL").map(m => ({
    key: m.idMal ? "mal" + m.idMal : "al" + m.id, alId: m.id, malId: m.idMal || null,
    original: (m.title.romaji || m.title.english || "").trim(), ingles: (m.title.english || "").trim(),
    capa: (m.coverImage && m.coverImage.large) || "", generos: generosPT(m.genres), desc: m.description || "",
    tipo: TIPO[m.countryOfOrigin] || "Mangá", sinonimos: (m.synonyms || []).filter(x => typeof x === "string"),
    nativo: (m.title.native || "").trim(), ano: (m.startDate && m.startDate.year) || null, anime: animeDe(m),
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
    sinonimos: [...(m.title_synonyms || []), ...((m.titles || []).map(t => t.title))].filter(x => typeof x === "string"),
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
    const j = await httpJSON(`https://api.mangadex.org/manga?limit=10&title=${encodeURIComponent(r.original)}&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`);
    const m = (j.data || []).find(x => { const l = (x.attributes && x.attributes.links) || {}; return (r.alId && String(l.al) === String(r.alId)) || (r.malId && String(l.mal) === String(r.malId)); });
    if (!m) return {};
    const alts = m.attributes.altTitles || [];
    const alt = alts.find(t => t["pt-br"]);
    const nomes = [...Object.values(m.attributes.title || {}), ...alts.filter(t => t["pt-br"] || t.en || t["ja-ro"] || t["ko-ro"] || t["zh-ro"]).flatMap(t => Object.values(t))];
    return { titulo: alt ? alt["pt-br"] : "", sinopse: (m.attributes.description || {})["pt-br"] || "", nomes, rating: m.attributes.contentRating || "" };
  } catch (e) { return {}; }
}
const catCache = {};
async function lerCatalogo(key) {
  if (!key) return null;
  if (catCache[key]) return catCache[key];
  try { const d = await getDoc(doc(db, "catalogo", key)); if (d.exists()) return (catCache[key] = d.data()); } catch (e) {}
  return null;
}
// Nome mais conhecido: mangá japonês → nome em inglês (ou o japonês); manhwa/manhua → português (ou inglês)
function nomePopular(c) {
  const jp = !c.tipo || c.tipo === "Mangá";
  if (!c.nomes) return String(c.titulo2 || c.titulo || "").trim().slice(0, 120);   // catálogo antigo, sem a lista de nomes
  const ord = jp ? [c.nomeEN, c.titulo, c.nomePT] : [c.nomePT, c.nomeEN, c.titulo];
  return String(ord.find(x => x && String(x).trim()) || c.titulo || "").trim().slice(0, 120);
}
// segundo nome (o menor, embaixo): o nome conhecido do catálogo que for diferente do que está em cima
function nomeSecundario(c, principal) {
  return String([nomePopular(c), c.nomeEN, c.nomePT, c.titulo].find(x => x && norm(x) !== norm(principal)) || "").trim().slice(0, 200);
}
// Classificação etária (estilo brasileiro), pelos dados do catálogo
const IDADES = ["Livre", "10+", "12+", "14+", "16+", "18+"];
function idadeDe(c) {
  if (c && IDADES.includes(c.idade)) return c.idade;
  const g = (c && c.generos) || [], r = (c && c.rating) || "";
  if (r === "erotica" || r === "pornographic") return "18+";
  if (r === "suggestive" || g.includes("Ecchi") || g.includes("Violência explícita")) return "16+";
  if (g.some(x => ["Terror", "Psicológico", "Suspense", "Seinen", "Josei", "Crime organizado"].includes(x))) return "14+";
  if (g.some(x => ["Ação", "Romance", "Drama", "Sobrenatural", "Shounen", "Mistério", "Artes marciais", "Militar", "Sobrevivência"].includes(x))) return "12+";
  if (g.includes("Infantil")) return "Livre";
  return g.length ? "10+" : "";
}
const IDADE_COR = { "Livre": "#1f9d55", "10+": "#0891b2", "12+": "#e0a100", "14+": "#ea580c", "16+": "#dc2626", "18+": "#111111" };
const seloIdade = (id) => id ? `<span class="idade" style="--ic:${IDADE_COR[id] || "#666"}" title="Classificação indicativa">${id === "Livre" ? "L" : esc(id)}</span>` : "";
const listaNomes = (arr) => { const v = new Set(), out = []; for (const x of arr) { const t = String(x || "").trim(); if (t && t.length <= 200 && !v.has(norm(t))) { v.add(norm(t)); out.push(t); } } return out.slice(0, 30); };
const aliasDe = (c) => (c.nomes || []).join(" | ").slice(0, 1000);
// Garante que o mangá escolhido está no catálogo compartilhado, já em português
async function prepararCatalogo(r) {
  const salvo = await lerCatalogo(r.key);
  if (salvo && salvo.nomes) return salvo;
  const pt = await mangaDexPT(r);
  const nomes = listaNomes([r.original, r.ingles, pt.titulo, ...(pt.nomes || []), ...(r.sinonimos || [])]);
  if (salvo) {   // catálogo antigo, sem os nomes: completa
    const extra = { nomeEN: (r.ingles || "").slice(0, 200), nomePT: (pt.titulo || "").slice(0, 200), nomes, idade: idadeDe({ generos: salvo.generos, rating: pt.rating }), atualizadoEm: Date.now() };
    try { await updateDoc(doc(db, "catalogo", r.key), extra); } catch (e) {}
    return (catCache[r.key] = { ...salvo, ...extra });
  }
  const orig = limpaSinopse(r.desc);
  let sinopse = limpaSinopse(pt.sinopse || "");
  if (!sinopse && orig) { try { sinopse = await traduzPT(orig); } catch (e) { sinopse = ""; } }
  const titulo2 = (pt.titulo && norm(pt.titulo) !== norm(r.original) ? pt.titulo : (r.ingles && norm(r.ingles) !== norm(r.original) ? r.ingles : "")).slice(0, 200);
  const c = { titulo: r.original.slice(0, 200), titulo2, generos: r.generos, sinopse: sinopse.slice(0, 4000), sinopseOrig: sinopse ? "" : orig.slice(0, 4000),
    capa: String(r.capa || "").slice(0, 500), tipo: r.tipo, alId: r.alId || null, malId: r.malId || null, atualizadoEm: Date.now(),
    nomeEN: (r.ingles || "").slice(0, 200), nomePT: (pt.titulo || "").slice(0, 200), nomes, idade: idadeDe({ generos: r.generos, rating: pt.rating }) };
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
        <span class="ct"><b>${esc(r.original)}</b>${r.ingles && norm(r.ingles) !== norm(r.original) ? `<small>${esc(r.ingles)}</small>` : ""}<em>${esc(r.tipo)}${r.generos.length ? " · " + esc(r.generos.slice(0, 3).join(", ")) : ""}</em>${r.anime ? `<span class="atags">${tagAnime(r.anime)}</span>` : ""}</span>
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
const cardsHTML = new WeakMap();   // guarda o HTML de cada card para só redesenhar o que mudou
const source = () => ui.visit ? ui.visit.items : items;
function filtered() {
  const q = norm(ui.q);
  const arr = [...source().values()].filter(it => (ui.filter === "todos" || stOf(it) === ui.filter) && (!q || norm(`${it.title} | ${it.titulo2 || ""} | ${it.alias || ""}`).includes(q)));
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
// ícone de visibilidade: mangá aberto (visível) ou com a placa de proibido (privado)
const ICO_MANGA = `<path d="M12 6q-4-2-8-1v13q4-1 8 1q4-2 8-1V5q-4-1-8 1z"/><path d="M12 6v13"/>`;
const icoVis = (priv) => `<svg viewBox="0 0 24 24" width="15" height="15" class="icovis" aria-hidden="true">${ICO_MANGA}${priv ? `<path class="proib" d="M3.5 3.5L20.5 20.5"/>` : ""}</svg>`;
const botaoPrivado = (it) => `<button class="mini ic vis ${it.privado ? "priv" : ""}" data-act="vis" title="${it.privado ? "Privado: só você vê. Toque para deixar visível." : "Visível para quem visita. Toque para deixar privado."}" aria-label="${it.privado ? "Privado" : "Visível"}">${icoVis(it.privado)}</button>`;
function cardHTML(it) {
  const st = stOf(it), visit = !!ui.visit;
  const cv = safeCover(it.cover), lk = fixLink(it.link);
  const cover = cv ? `<img src="${esc(cv)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback>` : phHTML(it.title);
  const avisoLink = !visit && linkComProblema(it) ? `<button type="button" class="cwarn" data-act="warnlink" title="O link deste mangá não está funcionando">⚠️</button>` : "";
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
    : `<div class="foot"><span class="when ${old ? "old" : ""}">${relTime(it.lastReadAt)}</span><span class="grow"></span>${botaoPrivado(it)}${link}<button class="mini" data-act="edit" title="Editar">✎</button></div>`;
  return `<article class="card" data-id="${esc(it.id)}">
    <div class="cover" data-act="${visit ? "info" : "edit"}">${cover}${avisoLink}<span class="badge s-${st}"><i></i>${STATUS[st].label}</span><button class="infob" data-act="info" title="Detalhes" aria-label="Detalhes">i</button>${visit ? "" : seloAnime(it)}</div>
    <div class="body">
      <div class="title" title="${esc(it.title)}${it.titulo2 ? " — " + esc(it.titulo2) : ""}"><span class="t1">${esc(it.title)}</span>${it.titulo2 ? `<span class="t2">${esc(it.titulo2)}</span>` : ""}</div>
      ${chap}
      ${foot}
    </div>
  </article>`;
}
// ---------- anime das obras da estante (confere 1x por dia; novas obras na hora) ----------
let animeInfo = {}, animeEm = 0, animeT = null;
const ANIME_KEY = () => "estante-anime-v1-" + (currentUser ? currentUser.uid : "");
const AVISO_ANIME_KEY = () => "estante-anime-avisos-v1-" + (currentUser ? currentUser.uid : "");
function lerJSON(k, d) { try { return JSON.parse(localStorage.getItem(k) || "null") || d; } catch (e) { return d; } }
function salvarJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function carregarAnimes() { const c = lerJSON(ANIME_KEY(), {}); animeInfo = c.info || {}; animeEm = c.em || 0; }
function seloAnime(it) {
  const a = it.catId && animeInfo[it.catId]; if (!a) return "";
  const visto = (lerJSON(AVISO_ANIME_KEY(), {}).vistos || {})[it.catId + ":" + a.id];
  return a.st === "anunciado" && !visto ? `<span class="aselo novo">Anime anunciado</span>` : `<span class="aselo">Anime</span>`;
}
function marcarAnimeVisto(it) {
  const a = it && it.catId && animeInfo[it.catId]; if (!a || a.st !== "anunciado") return;
  const av = lerJSON(AVISO_ANIME_KEY(), {}); av.vistos = av.vistos || {};
  if (av.vistos[it.catId + ":" + a.id]) return;
  av.vistos[it.catId + ":" + a.id] = Date.now(); salvarJSON(AVISO_ANIME_KEY(), av); render();
}
function agendaAnimes() { clearTimeout(animeT); animeT = setTimeout(atualizarAnimes, 4000); }
async function atualizarAnimes() {
  if (!currentUser || !navigator.onLine) return;
  const cats = [...new Set([...items.values()].map(it => it.catId).filter(k => /^(al|mal)\d+$/.test(k || "")))];
  const velho = Date.now() - animeEm > 20 * 3600e3;
  const faltam = velho ? cats : cats.filter(k => !(k in animeInfo));
  if (!faltam.length) return;
  const novo = velho ? {} : { ...animeInfo };
  for (let i = 0; i < faltam.length; i += 50) {
    const lote = faltam.slice(i, i + 50), mal = lote.filter(k => k.startsWith("mal")).map(k => +k.slice(3)), al = lote.filter(k => k.startsWith("al")).map(k => +k.slice(2));
    try {
      const j = await httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: `query($m:[Int],$a:[Int]){m:Page(perPage:50){media(idMal_in:$m,type:MANGA){id idMal ${ANIME_CAMPOS}}} a:Page(perPage:50){media(id_in:$a,type:MANGA){id idMal ${ANIME_CAMPOS}}}}`, variables: { m: mal.length ? mal : [0], a: al.length ? al : [0] } }) });
      lote.forEach(k => { novo[k] = null; });
      const d = j && j.data;
      ((d && d.m && d.m.media) || []).forEach(m => { novo["mal" + m.idMal] = animeDe(m); });
      ((d && d.a && d.a.media) || []).forEach(m => { novo["al" + m.id] = animeDe(m); });
    } catch (e) { return; }
  }
  animeInfo = novo; animeEm = velho ? Date.now() : animeEm || Date.now();
  salvarJSON(ANIME_KEY(), { info: animeInfo, em: animeEm });
  // aviso no sino: uma vez por anime anunciado de cada obra da estante
  const av = lerJSON(AVISO_ANIME_KEY(), {}); av.avisados = av.avisados || {}; av.lista = av.lista || [];
  let mudou = false;
  for (const it of items.values()) {
    const a = it.catId && animeInfo[it.catId]; if (!a || a.st !== "anunciado") continue;
    const k = it.catId + ":" + a.id; if (av.avisados[k]) continue;
    av.avisados[k] = Date.now(); av.lista.unshift({ key: "anime:" + k, mid: it.id, titulo: it.title, em: Date.now() }); mudou = true;
  }
  av.lista = av.lista.slice(0, 50);
  salvarJSON(AVISO_ANIME_KEY(), av);
  render(); if (mudou) updateBell();
}
function render() {
  if (!currentUser) return;
  if (!ui.visit) agendaAnimes();
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
  const antigos = new Map([...grid.children].map(el => [el.dataset.id, el]));
  const novos = [], els = [];
  for (const it of arr) {
    const html = cardHTML(it); let el = antigos.get(it.id);
    if (!el || cardsHTML.get(el) !== html) {
      const t = document.createElement("template"); t.innerHTML = html.trim();
      const novo = t.content.firstElementChild;
      if (!el) novo.classList.add("entra");          // animação só para card que acabou de aparecer
      // aproveita a imagem da capa já carregada (não pisca)
      if (el) { const vi = el.querySelector(".cover img"), ni = novo.querySelector(".cover img"); if (vi && ni && vi.getAttribute("src") === ni.getAttribute("src")) ni.replaceWith(vi); }
      // a capa que já tinha falhado continua no modo reserva, sem recarregar
      if (el && el.querySelector('[data-act="warnimg"]')) { const ci = novo.querySelector("img[data-fallback]"); if (ci) { ci.outerHTML = phHTML(it.title); novo.querySelector(".cover").insertAdjacentHTML("beforeend", `<button type="button" class="cwarn img" data-act="warnimg" title="A imagem desta capa não abriu">⚠️</button>`); } }
      cardsHTML.set(novo, html); el = novo; novos.push(novo);
    }
    els.push(el);
  }
  // só mexe na ordem/quantidade quando mudou
  const mesmaOrdem = els.length === grid.children.length && els.every((e, i) => grid.children[i] === e);
  if (!mesmaOrdem) grid.replaceChildren(...els);
  novos.forEach(n => n.addEventListener("animationend", () => n.classList.remove("entra"), { once: true }));
  novos.flatMap(n => [...n.querySelectorAll("img[data-fallback]")]).forEach(img => img.addEventListener("error", () => {
    const card = img.closest(".card"); const it = card && source().get(card.dataset.id);
    const cov = img.parentElement;
    img.outerHTML = phHTML(it ? it.title : "?");
    // a capa não abriu: avisa só o dono do mangá
    if (!ui.visit && cov && !cov.querySelector('[data-act="warnimg"]')) cov.insertAdjacentHTML("beforeend", `<button type="button" class="cwarn img" data-act="warnimg" title="A imagem desta capa não abriu">⚠️</button>`);
  }, { once: true }));
  if (ui.visit) grid.querySelectorAll(".card").forEach(card => {
    const it = source().get(card.dataset.id); if (!it || !it.catId) return;
    lerCatalogo(it.catId).then(c => { if (c && idadeDe(c) === "18+" && card.isConnected) card.querySelector(".cover").classList.add("borrado"); });
  });
  if (ui.visit && !source().size) empty.innerHTML = `<div class="empty"><p>A estante de @${esc(ui.visit.apelido)} está vazia.</p></div>`;
  else if (!source().size) empty.innerHTML = `<div class="empty"><div class="big">Estante vazia!</div><p>Adicione o primeiro mangá que você está lendo — nome, capítulo e, se quiser, uma capa.</p><button class="btn primary" id="emptyAdd">+ Adicionar mangá</button></div>`;
  else if (!arr.length) empty.innerHTML = `<div class="empty"><p>Nenhum mangá encontrado com esse filtro.</p></div>`;
  else empty.innerHTML = "";
}

// ---------- modais ----------
let modalCleanup = null;
function openModal(html, onMount, opts = {}) {
  $("#modal").classList.toggle("wide", !!opts.wide);
  $("#modal").innerHTML = html; $("#bd").classList.add("open");
  modalCleanup = onMount ? onMount($("#modal")) : null;
}
function closeModal() {
  $("#bd").classList.remove("open"); $("#modal").innerHTML = ""; $("#modal").classList.remove("wide");
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
  let catId = it ? it.catId || "" : "", titulo2 = it ? it.titulo2 || "" : "", alias = it ? it.alias || "" : "", catNome = "", catSel = null;
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
        <label class="f">Nome<input name="title" required maxlength="120" placeholder="Ex.: One Piece" value="${esc(it ? it.title : "")}"><small class="nomecat" id="nomeCat"></small></label>
        <div class="two">
          <label class="f">Último capítulo lido<input name="chapter" inputmode="decimal" placeholder="0" value="${it ? fmtCap(it.chapter) : ""}"></label>
          <label class="f">Status<select name="status">${opts}</select></label>
        </div>
        <label class="f">Link do site onde você lê <span style="font-weight:500;color:var(--muted)">(opcional)</span><input name="link" inputmode="url" placeholder="https://…" value="${esc(it ? it.link || "" : "")}"></label>
        <div class="two">
          <label class="f">Sua nota <span style="font-weight:500;color:var(--muted)">(opcional)</span><select name="nota"><option value="">Sem nota</option>${NOTAS.map(n => `<option value="${n}" ${it && parseNota(it.nota) === n ? "selected" : ""}>⭐ ${fmtNota(n)}</option>`).join("")}</select></label>
          <span></span>
        </div>
        <label class="chk"><input type="checkbox" id="edPriv" ${it && it.privado ? "checked" : ""}> <span>${icoVis(true)} Privado: só eu vejo este mangá</span></label>
        <div class="hint" id="edPrivDica" style="margin-top:-8px">${it && bloqueioPublico(it) ? esc(MSG_BLOQ[bloqueioPublico(it)]) : ""}</div>
        <label class="f">Comentário <span style="font-weight:500;color:var(--muted)">(opcional · aparece no seu perfil público)</span><textarea name="comentario" maxlength="300" rows="3" placeholder="Ex.: começa lento, fica ótimo a partir do cap. 50">${esc(it ? it.comentario || "" : "")}</textarea></label>
        <div>
          <div style="font-size:13px;font-weight:700;margin-bottom:6px">Capa <span style="font-weight:500;color:var(--muted)">(opcional)</span></div>
          <div class="cover-edit">
            <div class="cprev" id="cprev"></div>
            <div class="cbtns">
              <button type="button" class="btn" id="pick">🖼️ Foto da galeria / arquivo</button>
              <button type="button" class="btn" id="imgBusca">🔎 Buscar imagem (catálogo e internet)</button>
              <div class="urlrow">
                <input id="imgUrl" inputmode="url" placeholder="ou cole o link da imagem">
                <button type="button" class="btn" id="useUrl">OK</button>
              </div>
              <div class="paste" id="paste" contenteditable="true" spellcheck="false" data-ph="1">Ou cole aqui uma imagem copiada (Ctrl+V)</div>
              <button type="button" class="btn ghost" id="rmCover">Remover capa</button>
            </div>
          </div>
          <div id="imgPainel"></div>
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
      const un = pick.querySelector("#catUnlink"); if (un) un.onclick = () => { catId = ""; titulo2 = ""; alias = ""; catNome = ""; mostrarEscolha(null); root.querySelector("#catStatus").textContent = ""; dicaNome(); };
      if (c) { catSel = c; catNome = nomePopular(c); dicaNome(); }
    };
    const dica = root.querySelector("#nomeCat");
    const dicaNome = () => {
      if (!catId || !catNome) { dica.innerHTML = ""; return; }
      dica.innerHTML = norm(titleInput.value) === norm(catNome) ? `Nome do catálogo. Você pode trocar à vontade: o vínculo continua.`
        : `Nome no catálogo: <b>${esc(catNome)}</b> · <button type="button" class="linkbtn" id="usarCat">Usar nome do catálogo</button>`;
      const u = dica.querySelector("#usarCat"); if (u) u.onclick = () => { titleInput.value = catNome; dicaNome(); };
    };
    titleInput.addEventListener("input", dicaNome);
    const aoEscolher = (key, c) => {
      catId = key; catNome = nomePopular(c); titulo2 = nomeSecundario(c, catNome); alias = aliasDe(c);
      titleInput.value = catNome; mostrarEscolha(c);
      if (idadeDe(c) === "18+") { root.querySelector("#edPriv").checked = true; root.querySelector("#edPrivDica").textContent = "Obra 18+: sugerimos deixar privada. Desmarque se quiser mostrar na sua estante pública."; }
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
      if (cover && (!it || cover !== it.cover)) carregarVerificador().catch(() => {});   // já vai preparando a verificação
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
    root.querySelector("#imgBusca").onclick = () => {
      const pn = root.querySelector("#imgPainel");
      pn.innerHTML = `<div class="sect" style="margin-top:10px"><p class="hint">Capas e imagens de AniList, MyAnimeList, Kitsu e Wallhaven. Toque em uma para usar.</p>
        <div class="urlrow"><input id="ibQ" placeholder="Nome da obra" value="${esc(titleInput.value)}"><button type="button" class="btn" id="ibGo">Buscar</button></div>
        <div id="ibRes" class="ibres"></div></div>`;
      const q = pn.querySelector("#ibQ"), res = pn.querySelector("#ibRes");
      const go = async () => {
        const t = q.value.trim(); if (!t) { q.focus(); return; }
        if (!navigator.onLine) { res.innerHTML = `<p class="hint">📴 Sem internet.</p>`; return; }
        res.innerHTML = `<p class="hint">Buscando…</p>`;
        try {
          const l = await buscaImagens(t, "capa");
          res.innerHTML = l.length ? l.map(x => `<button type="button" class="ibopt" data-u="${esc(x.url)}" title="${esc(x.fonte)} · ${esc(x.nome)}"><img src="${esc(x.thumb || x.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><small>${esc(x.fonte)}</small></button>`).join("")
            : `<p class="hint">Nada encontrado. Tente o nome em inglês ou japonês.</p>`;
          res.querySelectorAll("[data-u]").forEach(b => b.onclick = () => { cover = safeCover(b.dataset.u); paintCover(); res.querySelectorAll("[data-u]").forEach(x => x.classList.toggle("on", x === b)); });
        } catch (e) { res.innerHTML = `<p class="err">Não consegui buscar agora. Tente de novo.</p>`; }
      };
      pn.querySelector("#ibGo").onclick = go;
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      go();
    };
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
    let verificando = false;
    root.querySelector("#ed").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (verificando) return;
      const fd = new FormData(e.target);
      const title = String(fd.get("title") || "").trim();
      if (!title) return;
      const chapter = parseCap(fd.get("chapter"));
      const rawLink = String(fd.get("link") || "").trim();
      const link = fixLink(rawLink);
      if (rawLink && !link) { toast("Esse link não parece válido."); return; }
      if (catId && catSel) titulo2 = nomeSecundario(catSel, title);   // nome próprio: embaixo fica o nome conhecido do catálogo
      const data = { title, chapter, status: String(fd.get("status")), link, cover, catId, titulo2: catId ? titulo2 : "", alias: catId ? alias : "",
        nota: parseNota(fd.get("nota")), comentario: String(fd.get("comentario") || "").trim().slice(0, 300) };
      // capa nova? confere se tem conteúdo adulto (no próprio aparelho)
      let capa18 = !!(it && it.capa18 && cover === it.cover);
      if (cover && (!it || cover !== it.cover)) {
        const sb = root.querySelector('#ed [type="submit"]'), txt = sb.textContent;
        verificando = true; sb.disabled = true; sb.textContent = "Verificando a capa…";
        capa18 = (await verificarImagem(cover)) === "adulto";
        verificando = false; sb.disabled = false; sb.textContent = txt;
        if (!root.isConnected) return;
      }
      data.capa18 = capa18;
      const bloq = bloqueioPublico(data);
      let querPriv = root.querySelector("#edPriv").checked;
      if (bloq && !querPriv) querPriv = true;
      const aviso = bloq ? MSG_BLOQ[bloq] : "";
      if (it) {
        if (!!it.privado !== querPriv) {
          // muda de coleção já com os dados novos (a capa e o nome entram juntos)
          items.set(id, { ...it, ...data }); if (!capa18) delete items.get(id).capa18;
          trocarPrivado(id, querPriv);
        }
        const patch = { ...data };
        if (chapter !== (Number(it.chapter) || 0)) patch.lastReadAt = Date.now();
        commit(id, patch); if (!capa18) { const n = items.get(id); if (n) delete n.capa18; }
        toast(aviso || "Salvo!", aviso ? 6000 : 2000);
      } else {
        const novo = { ...data, privado: querPriv }; if (!capa18) delete novo.capa18;
        create(novo); toast(aviso || (querPriv ? "Adicionado como privado (só você vê)." : "Adicionado à estante!"), aviso ? 6000 : 2000);
      }
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
        <button class="btn" id="mGuia">📖 Guia do app</button>
        ${isAdmin(u) ? `<button class="btn primary" id="mAdmin">👑 Administrador — quem pode usar</button><button class="btn" id="mReports">🛠️ Relatos de problemas</button><button class="btn" id="mDen">🚩 Denúncias</button>` : ""}
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
    const db2 = root.querySelector("#mDen"); if (db2) db2.onclick = openDenuncias;
    root.querySelector("#mGuia").onclick = openGuia;
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
// Notificações ficam numa lista local: tocar marca como lida (sem sumir); "Limpar" esvazia (com Desfazer por 5 s)
const NOTIF_KEY = () => "estante-notif-v1-" + (currentUser ? currentUser.uid : "");
function juntarNotifs() {
  const L = lerJSON(NOTIF_KEY(), {}); L.itens = L.itens || []; L.limpas = L.limpas || [];
  const limpas = new Set(L.limpas);
  const tem = new Map(L.itens.map(x => [x.key, x])), agora = Date.now();
  const por = (x) => { if (tem.has(x.key)) { Object.assign(tem.get(x.key), { titulo: x.titulo, texto: x.texto, capa: x.capa, link: x.link }); return; } if (limpas.has(x.key)) return; const n = { ...x, em: x.em || agora, lida: false }; L.itens.push(n); tem.set(x.key, n); };
  for (const { it, n } of bellList()) {
    const c = chk[it.id];
    por({ key: "cap:" + it.id + ":" + c.latest, tipo: "cap", mid: it.id, titulo: it.title, capa: safeCover(it.cover) || "", link: fixLink(it.link) || "", texto: `+${n} ${n === 1 ? "capítulo novo" : "capítulos novos"} · você parou no ${fmtCap(it.chapter)}` });
  }
  for (const { it, v } of novasAvaliacoes()) por({ key: "aval:" + it.id + ":" + (v.uid || v.apelido) + ":" + (v.em || 0), tipo: "aval", mid: it.id, titulo: it.title, capa: safeCover(it.cover) || "", em: v.em, texto: `@${v.apelido || "?"} deu nota ${fmtNota(parseNota(v.nota))}` });
  if (!forumDnd) for (const f of myAvisos.slice(0, 30)) por({ key: "forum:" + f.id, tipo: "forum", aviso: f.id, sala: f.sala, em: f.em, titulo: `@${f.apelido || "?"} ${f.tipo === "resposta" ? "respondeu você" : "mencionou você"}`, texto: `em ${nomeSala(f.sala)}${f.trecho ? " · " + f.trecho : ""}` });
  for (const x of (lerJSON(AVISO_ANIME_KEY(), {}).lista || [])) { const it = items.get(x.mid); por({ key: x.key, tipo: "anime", mid: x.mid, titulo: x.titulo, capa: it ? safeCover(it.cover) || "" : "", em: x.em, texto: "vai ganhar anime" }); }
  // capítulo já lido: a notificação continua, mas como lida
  for (const x of L.itens) if (x.tipo === "cap" && !x.lida) { const it = items.get(x.mid); if (!it || !unreadBadge(it)) x.lida = true; }
  L.itens = L.itens.filter(x => agora - (x.em || 0) < 30 * 864e5).sort((p, q) => (q.em || 0) - (p.em || 0)).slice(0, 60);
  salvarJSON(NOTIF_KEY(), L);
  return L;
}
function updateBell() {
  if (!$("#bellBtn") || !currentUser) return;
  const n = juntarNotifs().itens.filter(x => !x.lida).length;
  $("#bellBtn").classList.remove("hidden");
  $("#bellCnt").textContent = n > 9 ? "9+" : String(n || "");
  $("#bellCnt").classList.toggle("hidden", !n);
}
let bellDesfazer = null;
function openBell() {
  let L = juntarNotifs(), guarda = null, tmr = null;
  const marcar = (key) => { const x = L.itens.find(y => y.key === key); if (x && !x.lida) { x.lida = true; salvarJSON(NOTIF_KEY(), L); updateBell(); } };
  const efetivar = (lista) => {   // depois dos 5 s: limpa também na origem
    lista.forEach(x => { if (x.tipo === "cap") markSeen(x.mid); });
    try { localStorage.setItem(AVAL_KEY, String(Date.now())); } catch (e) {}
    const fs = lista.filter(x => x.tipo === "forum" && x.aviso);
    if (fs.length) { const bt = writeBatch(db); fs.forEach(x => bt.delete(doc(db, "users", currentUser.uid, "avisos", x.aviso))); bt.commit().catch(() => {}); }
    const av = lerJSON(AVISO_ANIME_KEY(), {}); av.lista = []; salvarJSON(AVISO_ANIME_KEY(), av);
    updateBell();
  };
  openModal(`
    <div class="mhead"><h2>Notificações</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody"><div class="ntabs"><span class="lbl">Novidades</span><span class="qt" id="nQt"></span><button type="button" class="nlimpar" id="nLimpar">Limpar</button></div><div class="nlist" id="nList"></div></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const box = root.querySelector("#nList"), bLimpar = root.querySelector("#nLimpar"), qt = root.querySelector("#nQt");
    const capa = (x) => x.capa ? `<img src="${esc(x.capa)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ncapa-v">${x.tipo === "forum" ? "@" : esc((x.titulo || "?").trim().charAt(0).toUpperCase())}</span>`;
    const draw = () => {
      qt.textContent = String(L.itens.length); qt.classList.toggle("hidden", !L.itens.length); bLimpar.disabled = !L.itens.length;
      box.innerHTML = (L.itens.length ? L.itens.map(x => `
        <div class="ni${x.lida ? " lida" : ""}" data-k="${esc(x.key)}" role="button" tabindex="0">
          <span class="ncapa">${capa(x)}</span>
          <span class="nt"><b>${esc(x.titulo || "")}</b><small>${esc(x.texto || "")}</small></span>
          ${x.tipo === "cap" && x.link ? `<a class="mini read" data-ler href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">Ler</a>` : ""}
          <span class="ndot"></span>
        </div>`).join("") : `<div class="nvazio">Nenhuma notificação nova.</div>`)
        + (guarda ? `<div class="ntoast">Notificações limpas.<button type="button" id="nDesf">Desfazer</button></div>` : "");
    };
    draw();
    box.addEventListener("click", (e) => {
      if (e.target.id === "nDesf") { const ks = new Set(guarda.map(x => x.key)); L.limpas = L.limpas.filter(k => !ks.has(k)); L.itens = guarda; guarda = null; clearTimeout(tmr); bellDesfazer = null; salvarJSON(NOTIF_KEY(), L); updateBell(); draw(); return; }
      const el = e.target.closest(".ni"); if (!el) return;
      const x = L.itens.find(y => y.key === el.dataset.k); if (!x) return;
      marcar(x.key);
      if (e.target.closest("[data-ler]")) { markSeen(x.mid); draw(); return; }
      if (x.tipo === "forum") { forumEstado.sala = x.sala; openPeople("forum"); return; }
      if (x.mid && items.get(x.mid)) { openInfo(x.mid); return; }
      draw();
    });
    bLimpar.onclick = () => {
      if (!L.itens.length) return;
      box.querySelectorAll(".ni").forEach(n => n.classList.add("sai"));
      setTimeout(() => {
        guarda = L.itens; L.itens = []; L.limpas = [...guarda.map(x => x.key), ...L.limpas].slice(0, 300); salvarJSON(NOTIF_KEY(), L); updateBell(); draw();
        clearTimeout(tmr); const lista = guarda;
        bellDesfazer = () => efetivar(lista);
        tmr = setTimeout(() => { guarda = null; bellDesfazer = null; efetivar(lista); if (box.isConnected) draw(); }, 5000);
      }, 220);
    };
    return () => { if (bellDesfazer) { clearTimeout(tmr); const f = bellDesfazer; bellDesfazer = null; f(); } updateBell(); };
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
          const bt = writeBatch(db); bt.set(doc(m.privado ? colPriv : col, id), clean(m)); bt.delete(doc(db, "users", uid, "lixeira", id)); await bt.commit();
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
        for (const c of ["minhasNotas", "mangas", "privados", "lixeira", "avaliacoes"]) await apagarColecao(["users", me, c]).catch(() => {});
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
  if (!visit) marcarAnimeVisto(it);
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
      <button class="btn ${jaTenho ? "" : "primary"}" id="copyShelf" ${jaTenho ? "disabled" : ""}>${jaTenho ? "✓ Já está na sua estante" : "＋ Adicionar à minha estante (Na fila)"}</button>
      <button class="btn ghost denbtn" id="denIt">🚩 Denunciar</button>`
      : `<div class="visrow"><button type="button" class="mini ic vis ${it.privado ? "priv" : ""}" id="visInfo">${icoVis(it.privado)}</button><span><b>${it.privado ? "Privado" : "Visível"}</b><small>${it.privado ? "Só você vê. Fica fora da estante pública, da vitrine e do ranking." : "Aparece para quem visita sua estante (se o seu perfil for público)."}</small></span></div>
      <button class="btn" id="editIt">✎ Editar este mangá</button>`}
    </div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelectorAll("[data-seen]").forEach(a => a.addEventListener("click", () => markSeen(a.dataset.seen)));
    const vi = root.querySelector("#visInfo"); if (vi) vi.onclick = () => { trocarPrivado(mid, !it.privado); closeModal(); };
    const ci = root.querySelector("#catInfo");
    if (ci) lerCatalogo(it.catId).then(c => completarSinopse(it.catId, c)).then(c => {
      if (!ci.isConnected) return;
      if (!c) { ci.innerHTML = navigator.onLine ? "" : `<div class="hint">Sem internet: gêneros e sinopse aparecem quando conectar.</div>`; return; }
      const idd = idadeDe(c);
      ci.innerHTML = `${idd ? `<div class="idaderow">${seloIdade(idd)}<span>Classificação indicativa: <b>${idd === "Livre" ? "Livre para todos" : "não recomendado para menores de " + idd.replace("+", " anos")}</b></span></div>` : ""}
        ${(c.generos || []).length ? `<div class="gens">${c.generos.map(g => `<span>${esc(g)}</span>`).join("")}</div>` : ""}
        <div class="sinopse"><b>Sinopse</b>${c.sinopse ? `<p>${esc(c.sinopse)}</p>` : `<p class="hint">Sinopse em tradução… tente abrir de novo daqui a pouco.</p>`}</div>`;
    });
    const ed = root.querySelector("#editIt"); if (ed) ed.onclick = () => openEditor(mid);
    const dn = root.querySelector("#denIt"); if (dn) dn.onclick = () => openDenuncia(visit, mid, it);
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
      create({ title: it.title, titulo2: it.titulo2 || "", alias: it.alias || "", catId: it.catId || "", cover: safeCover(it.cover), link: fixLink(it.link), status: "fila", chapter: 0, nota: null, comentario: "" });
      toast("Adicionado à sua estante em Na fila!"); openInfo(mid);
    };
  });
}

// ---------- 👤 pessoas: seu perfil + busca ----------
const safeFoto = (f) => { f = String(f || ""); return (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(f) && f.length <= 60000) || (/^https:\/\/[^\s"'<>]+$/.test(f) && f.length <= 600) ? f : ""; };
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
    bio: String(p.bio || "").slice(0, 120), cor: CORES[p.cor] ? p.cor : "", banner: safeBanner(p.banner), bannerPos: posBanner(p.bannerPos),
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
// ---------- verificação automática de imagens e nomes (roda no próprio aparelho, nada é enviado) ----------
let nsfwP = null;
function carregarVerificador() {
  if (!nsfwP) nsfwP = new Promise((res, rej) => {
    if (window.EstanteNSFW) return res(window.EstanteNSFW);
    const s = document.createElement("script"); s.src = "nsfw.js";
    s.onload = () => window.EstanteNSFW ? res(window.EstanteNSFW) : rej(new Error("sem verificador"));
    s.onerror = () => rej(new Error("sem verificador"));
    document.head.appendChild(s);
  }).catch(e => { nsfwP = null; throw e; });
  return nsfwP;
}
// abre a imagem (ou 2 quadros do vídeo) de um jeito que o verificador consegue ler
function quadrosDe(src) {
  return new Promise((res, rej) => {
    const remoto = /^https?:/i.test(src);
    const tempo = setTimeout(() => rej(new Error("demorou")), 15000);
    if (ehVideo(src)) {
      const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; if (remoto) v.crossOrigin = "anonymous";
      const quadros = []; let alvo = [];
      const tira = () => { const c = document.createElement("canvas"); c.width = 224; c.height = 224; c.getContext("2d").drawImage(v, 0, 0, 224, 224); quadros.push(c); };
      v.onloadedmetadata = () => { const d = isFinite(v.duration) && v.duration > 0 ? v.duration : 1; alvo = [d * 0.2, d * 0.6]; v.currentTime = alvo.shift(); };
      v.onseeked = () => { try { tira(); } catch (e) { clearTimeout(tempo); rej(e); return; } if (alvo.length) v.currentTime = alvo.shift(); else { clearTimeout(tempo); res(quadros); } };
      v.onerror = () => { clearTimeout(tempo); rej(new Error("video")); };
      v.src = src; return;
    }
    const i = new Image(); if (remoto) i.crossOrigin = "anonymous";
    i.onload = () => { clearTimeout(tempo); res([i]); }; i.onerror = () => { clearTimeout(tempo); rej(new Error("img")); };
    i.src = src;
  });
}
// "adulto" | "ok" | "?" (não deu para verificar: sem internet, site que não deixa ler a imagem…)
async function verificarImagem(src) {
  if (!src) return "ok";
  try {
    const V = await carregarVerificador();
    for (const q of await quadrosDe(src)) {
      const p = await V.classificar(q);
      const explicito = (p.Porn || 0) + (p.Hentai || 0);
      if (explicito >= 0.7 || (p.Porn || 0) >= 0.5) return "adulto";
    }
    return "ok";
  } catch (e) { return "?"; }
}
// nomes de mangá que pedem cuidado: não bloqueia, só deixa privado
const NOME18_CONTEM = ["hentai", "porn", "xxx", "nsfw", "putaria", "pedofil", "estupr", "incest", "lolicon", "shotacon", "milf", "fetich"];
const NOME18_IGUAL = ["sex", "sexo", "sexy", "nude", "nudes", "nua", "nuas", "erotico", "erotica", "erotic", "ero", "r18"];
function nomeSuspeito(t) {
  const n = norm(t || "");
  const junto = n.replace(/[^a-z0-9]/g, ""), palavras = n.split(/[^a-z0-9]+/).filter(Boolean);
  return NOME18_CONTEM.some(w => junto.includes(w)) || palavras.some(w => NOME18_IGUAL.includes(w)) || AP_RUINS_CONTEM.some(w => junto.includes(w));
}
// motivo para este mangá não poder ficar público (ou "")
const bloqueioPublico = (it) => it.capa18 ? "capa" : nomeSuspeito(it.title) ? "nome" : "";
const MSG_BLOQ = {
  capa: "Essa capa parece ter conteúdo adulto, então o mangá fica privado. Para deixar público, troque a imagem.",
  nome: "O nome deste mangá parece ter conteúdo adulto, então ele fica privado. Para deixar público, mude o nome.",
};
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const nomeMes = (m) => { const [a, b] = String(m || "").split("-").map(Number); return a && b ? `${MESES[b - 1]} de ${a}` : ""; };
// 👤 "Social": Meu perfil · Comunidade · Ranking
function openPeople(tab = "perfil") {
  const p = myProfile || {};
  const offline = !navigator.onLine;
  const tabs = `<div class="ctabs">${[["perfil", "Meu perfil"], ["pessoas", "Comunidade"], ["ranking", "Ranking"], ["forum", "Fórum"]].map(([k, l]) => `<button type="button" class="chip ${tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>`;
  let corpo = "";
  if (tab === "perfil") corpo = `
      ${p.apelido ? `<div class="vitrine mine">${vitrineHTML(p, soVisiveis(), false)}</div>
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
  else if (tab === "forum") corpo = offline ? `<p class="hint">📴 Sem internet: o fórum precisa de conexão.</p>` : `<div id="forum" class="forum"><div class="hint" style="padding:16px">Carregando o fórum…</div></div>`;
  else corpo = offline ? `<p class="hint">📴 Sem internet: o ranking precisa de conexão.</p>` : `<div id="rk"><div class="hint">Carregando ranking…</div></div>`;
  openModal(`
    <div class="mhead"><h2>👥 Social</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody ${tab === "forum" ? "mbforum" : ""}">${tabs}${corpo}</div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => openPeople(b.dataset.tab));
    if (tab === "pessoas" && !offline) montarPessoas(root);
    if (tab === "ranking" && !offline) montarRanking(root);
    if (tab === "forum") return offline ? undefined : montarForum(root);
    if (tab !== "perfil") return;
    const vtm = root.querySelector(".vitrine.mine");
    if (vtm) ligarVitrine(vtm, soVisiveis(), true);
    const ve = root.querySelector("#vtEdit"); if (ve) ve.onclick = openVitrineEdit;
    const fb = root.querySelector("#fotoBtn");
    if (fb) fb.onclick = openFotoEdit;
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
  }, { wide: true });
}
function montarPessoas(root) {
  let perfis = null;
  const plist = root.querySelector("#plist"), pq = root.querySelector("#pq");
  const draw = () => {
    if (!perfis) return;
    const q = norm(pq.value).replace(/^@/, "");
    const l = perfis.filter(x => x.uid !== currentUser.uid && (!q || norm(x.apelido).includes(q)));
    plist.innerHTML = l.length ? l.map(x => `<button class="acct pbtn pcard" data-uid="${esc(x.uid)}" data-ap="${esc(x.apelido)}" style="--vt:${CORES[x.cor] || CORES.roxo}"><span class="pcban">${safeBanner(x.banner) ? midiaBanner(safeBanner(x.banner), x.bannerPos) : ""}</span>${avatarHTML(x.foto, x.apelido)}<div><b>@${esc(x.apelido)}</b><small>Ver estante →</small></div></button>`).join("")
      : `<div class="hint">${perfis.length ? "Ninguém com esse apelido." : "Ainda não há perfis públicos."}</div>`;
  };
  getDocs(query(collection(db, "perfis"), where("publico", "==", true), where("oculto", "==", false)))
    .then(snap => {
      perfis = snap.docs.map(d => { const v = d.data() || {}; return { uid: d.id, apelido: String(v.apelido || ""), foto: v.foto || "", banner: v.banner || "", bannerPos: v.bannerPos, cor: v.cor || "" }; }).filter(x => x.apelido);
      for (let i = perfis.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [perfis[i], perfis[j]] = [perfis[j], perfis[i]]; }   // ordem diferente a cada vez
      draw();
    })
    .catch(() => { plist.innerHTML = `<div class="err">Não consegui buscar agora. Verifique a internet.</div>`; });
  pq.addEventListener("input", draw);
  plist.addEventListener("click", (e) => { const b = e.target.closest("[data-uid]"); if (b) { const x = perfis.find(y => y.uid === b.dataset.uid); openVisit(b.dataset.uid, b.dataset.ap, x && x.foto); } });
}
// ---------- Ranking: Todos os tempos · Em alta · Esta semana · Este mês · Por gênero · Para você ----------
const RK_FILTROS = [["todos", "Todos os tempos"], ["alta", "Em alta"], ["mes", "Este mês"], ["genero", "Por gênero"], ["pv", "✨ Para você"]];
const rkEstado = { f: "todos", barra: 0, g: "Ação", gbarra: 0 };
const RK_GENEROS = ["Ação", "Romance", "Fantasia", "Comédia", "Drama", "Esportes", "Mistério", "Terror"];   // continua onde você parou ao voltar para o Ranking
const rkPC = () => matchMedia("(min-width:1100px)").matches;
const chaveQuem = (k) => String(k || "").replace(/[.\/\[\]*`~]/g, "_");
const naEstante = (x) => [...items.values()].some(it => (x.catId && it.catId === x.catId) || norm(it.title) === norm(x.titulo));
const rkCapaCache = {};
function rkCapa(x, cls = "") {
  const c = String(x.capa || "");
  if (c.startsWith("rkcapa:")) return `<span class="rkc ${cls}" data-obra="1"><img alt="" data-rkc="${esc(c.slice(7))}" ${rkCapaCache[c.slice(7)] ? `src="${esc(rkCapaCache[c.slice(7)])}"` : ""}></span>`;
  return `<span class="rkc ${cls}" data-obra="1">${c ? `<img src="${esc(c)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<i>${esc((x.titulo || "?").slice(0, 1))}</i>`}</span>`;
}
function rkCarregaCapas(box) {
  box.querySelectorAll("img[data-rkc]:not([src])").forEach(im => {
    const id = im.dataset.rkc;
    getDoc(doc(db, "rkcapas", id)).then(d => { const c = d.exists() ? (d.data() || {}).capa : ""; if (c) { rkCapaCache[id] = c; im.src = c; } }).catch(() => {});
  });
}
// janelinha por cima do Social (Quem lê, ⓘ da obra), sem fechar o Ranking
function abrirFolha(html, onMount) {
  fecharFolha();
  const f = document.createElement("div"); f.className = "rkfolha"; f.innerHTML = `<div class="modal folha">${html}</div>`;
  document.body.appendChild(f);
  f.addEventListener("click", (e) => { if (e.target === f || e.target.closest("[data-fx]")) fecharFolha(); });
  if (onMount) onMount(f.querySelector(".folha"));
}
function fecharFolha() { document.querySelectorAll(".rkfolha").forEach(x => x.remove()); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.querySelector(".rkfolha")) { e.stopImmediatePropagation(); fecharFolha(); } }, true);

async function montarRanking(root) {
  const box = root.querySelector("#rk");
  box.innerHTML = `<div class="rkbar">${RK_FILTROS.map(([k, l]) => `<button type="button" class="chip ${k === "pv" ? "pv" : ""} ${rkEstado.f === k ? "on" : ""}" data-f="${k}">${esc(l)}</button>`).join("")}</div><div class="rkconteudo"><div class="hint">Carregando ranking…</div></div>`;
  const barra = box.querySelector(".rkbar"), area = box.querySelector(".rkconteudo");
  barra.scrollLeft = rkEstado.barra;
  barra.addEventListener("scroll", () => { rkEstado.barra = barra.scrollLeft; }, { passive: true });
  let dados = null;
  const carregar = async () => {
    if (dados) return dados;
    const ler = (id) => getDoc(doc(db, "ranking", id)).then(d => d.exists() ? d.data() : null).catch(() => null);
    const [todos, periodos, quem, atual, generos] = await Promise.all([ler("todos"), ler("periodos"), ler("quem"), ler("atual"), ler("generos")]);
    // antes do primeiro cálculo novo, usa o ranking antigo
    const t = todos || (atual ? { maisLidos: atual.maisLidos || [], melhores: atual.melhores || [], leitores: (atual.leitores || []).map(l => ({ ...l, concluidos: l.lidos })) } : null);
    return (dados = { todos: t, periodos, quem: (quem && quem.mapa) || {}, generos: (generos && generos.lista) || {} });
  };
  const mostra = async () => {
    barra.querySelectorAll("[data-f]").forEach(b => b.classList.toggle("on", b.dataset.f === rkEstado.f));
    const f = rkEstado.f;
    if (f === "pv") { montarParaVoce(area, await carregar().catch(() => ({}))); return; }
    let d; try { d = await carregar(); } catch (e) { area.innerHTML = `<div class="err">Não consegui carregar o ranking agora.</div>`; return; }
    if (rkEstado.f !== f || !area.isConnected) return;
    if (f === "todos") desenharTodos(area, d); else if (f === "genero") desenharGenero(area, d); else desenharPeriodo(area, d, f);
    rkCarregaCapas(area);
  };
  barra.addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]"); if (!b || b.dataset.f === rkEstado.f) return;
    rkEstado.f = b.dataset.f;
    // a barrinha fica onde está; só se ajeita se a opção tocada estiver cortada na borda
    const bl = barra.getBoundingClientRect(), r = b.getBoundingClientRect();
    if (r.left < bl.left) barra.scrollLeft -= (bl.left - r.left) + 8; else if (r.right > bl.right) barra.scrollLeft += (r.right - bl.right) + 8;
    mostra();
  });
  area.addEventListener("click", (e) => {
    const q = e.target.closest("[data-quem]"); if (q) { abrirQuemLe(q.dataset.quem, q.dataset.tit, dados); return; }
    const ad = e.target.closest("[data-add]"); if (ad) { adicionarObra(JSON.parse(ad.dataset.add), ad); return; }
    const pu = e.target.closest("[data-uid]"); if (pu) { openVisit(pu.dataset.uid, pu.dataset.ap, ""); return; }
    const ob = e.target.closest("[data-obra]"); const card = ob && ob.closest("[data-x]");
    if (card) openObra(JSON.parse(card.dataset.x));
  });
  mostra();
}
const rkPos = (i) => `<span class="rkpos ${i < 3 ? "p" + (i + 1) : ""}">${i + 1}</span>`;
const rkJSON = (x) => esc(JSON.stringify({ chave: x.chave || "", catId: x.catId || "", titulo: x.titulo || "", capa: x.capa || "" }));
function rkBotoes(x) {
  const tem = naEstante(x);
  return `<div class="rkacts">${tem ? `<span class="mini rktem">✓ Na sua estante</span>` : `<button type="button" class="mini rkadd" data-add="${rkJSON(x)}">+ Estante</button>`}<button type="button" class="mini" data-quem="${esc(chaveQuem(x.chave))}" data-tit="${esc(x.titulo)}">Quem lê</button></div>`;
}
function desenharTodos(area, d) {
  const t = d.todos;
  if (!t) { area.innerHTML = `<p class="rkcap">O ranking ainda está sendo calculado. Volte daqui a pouco.</p>`; return; }
  const nLeit = rkPC() ? 15 : 10;
  const vazio = `<p class="rkvazio">Ainda sem dados suficientes.</p>`;
  const linhaObra = (x, i, met) => `<div class="rkl m" data-x="${rkJSON(x)}">${rkPos(i)}${rkCapa(x)}<div class="rkt"><b>${esc(x.titulo)}</b>${x.titulo2 ? `<small>${esc(x.titulo2)}</small>` : ""}<span class="rkmet">${met}</span>${rkBotoes(x)}</div></div>`;
  const me = currentUser && currentUser.uid;
  area.innerHTML = `<p class="rkcap">Soma de todas as leituras desde o início · atualiza todo dia 1º</p>
    <div class="rkcols">
      <div class="rktab"><div class="rkth">Os mais lidos da história</div>${(t.maisLidos || []).length ? t.maisLidos.map((x, i) => linhaObra(x, i, `<b>${x.leitores}</b> ${x.leitores === 1 ? "leitor" : "leitores"}`)).join("") : vazio}</div>
      <div class="rktab"><div class="rkth">Os mais bem avaliados</div>${(t.melhores || []).length ? t.melhores.map((x, i) => linhaObra(x, i, `<b>⭐ ${fmtNota(x.media)}</b> · ${x.notas} notas`)).join("") : vazio}</div>
      <div class="rktab"><div class="rkth">Maiores leitores</div>${(t.leitores || []).length ? t.leitores.slice(0, nLeit).map((l, i) => `<button type="button" class="rkl l" data-uid="${esc(l.uid)}" data-ap="${esc(l.apelido)}">${rkPos(i)}<span class="rkav" data-av="${esc(l.uid)}">${avatarHTML("", l.apelido)}</span><span class="rkt"><b><span data-ap-of="${esc(l.uid)}">@${esc(l.apelido)}</span>${l.uid === me ? `<span class="rkvoce">você</span>` : ""}</b><span class="rkmet"><b>${l.concluidos}</b> ${l.concluidos === 1 ? "concluído" : "concluídos"}</span></span></button>`).join("") : vazio}</div>
    </div>
    <p class="rknote">Ranking feito apenas com perfis públicos.</p>`;
  // foto e apelido atuais de cada leitor
  for (const el of area.querySelectorAll("[data-av]")) {
    getDoc(doc(db, "perfis", el.dataset.av)).then(dd => {
      if (!dd.exists() || !el.isConnected) return;
      const pf = dd.data() || {};
      el.innerHTML = avatarHTML(pf.foto, pf.apelido);
      if (pf.apelido) { const b = area.querySelector(`[data-ap-of="${el.dataset.av}"]`); if (b) b.textContent = "@" + pf.apelido; const row = el.closest("[data-ap]"); if (row) row.dataset.ap = pf.apelido; }
    }).catch(() => {});
  }
}
const MESES_CAP = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
function desenharPeriodo(area, d, f) {
  const p = d.periodos || {};
  const agora = new Date();
  const cap = { alta: "Os mais lidos dos últimos 7 dias · atualiza todo dia", semana: "De segunda até hoje · atualiza todo dia",
    mes: `${MESES_CAP[agora.getMonth()]} de ${agora.getFullYear()} até hoje · atualiza todo dia` }[f];
  const lista = p[f] || [];
  area.innerHTML = `<p class="rkcap">${cap}</p>${lista.length ? rkGrade(lista) : `<p class="rkvazio">Ainda não tem leituras neste período.</p>`}`;
  rkPosNoCanto(area);   // a posição fica no canto da capa
}
// Por gênero: abas de texto com sublinhado + grade dos 10 mais lidos do gênero
const rkGrade = (lista) => `<div class="rkgrade">${lista.map((x, i) => `<div class="rkcard" data-x="${rkJSON(x)}">${rkCapa(x, "g")}<span class="rkn ${i < 3 ? "p" + (i + 1) : ""}">${i + 1}</span><b>${esc(x.titulo)}</b></div>`).join("")}</div>`;
const rkPosNoCanto = (el) => el.querySelectorAll(".rkcard").forEach(c => { const n = c.querySelector(".rkn"), cp = c.querySelector(".rkc"); if (n && cp) cp.appendChild(n); });
function desenharGenero(area, d) {
  area.innerHTML = `<div class="rkgbar">${RK_GENEROS.map(g => `<button type="button" class="${g === rkEstado.g ? "on" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("")}</div><div class="rkgconteudo"></div>`;
  const gb = area.querySelector(".rkgbar"), cont = area.querySelector(".rkgconteudo");
  gb.scrollLeft = rkEstado.gbarra;
  gb.addEventListener("scroll", () => { rkEstado.gbarra = gb.scrollLeft; }, { passive: true });
  const pinta = () => {
    gb.querySelectorAll("[data-g]").forEach(b => b.classList.toggle("on", b.dataset.g === rkEstado.g));
    const lista = (d.generos || {})[rkEstado.g] || [];
    cont.innerHTML = `<p class="rkcap">Os mais lidos de ${esc(rkEstado.g)} entre todos os leitores · atualiza todo dia</p>${lista.length ? rkGrade(lista) : `<p class="rkvazio">Ainda não tem leituras deste gênero.</p>`}`;
    rkPosNoCanto(cont); rkCarregaCapas(cont);
  };
  gb.addEventListener("click", (e) => {
    const b = e.target.closest("[data-g]"); if (!b || b.dataset.g === rkEstado.g) return;
    rkEstado.g = b.dataset.g;
    const bl = gb.getBoundingClientRect(), r = b.getBoundingClientRect();
    if (r.left < bl.left) gb.scrollLeft -= (bl.left - r.left) + 8; else if (r.right > bl.right) gb.scrollLeft += (r.right - bl.right) + 8;
    pinta();
  });
  pinta();
}
function abrirQuemLe(ch, titulo, dados) {
  const l = ((dados && dados.quem) || {})[ch] || [];
  const cor = { lendo: "var(--c-lendo)", fila: "var(--c-fila)", pausado: "var(--c-pausa)", concluido: "var(--c-fim)" };
  abrirFolha(`<div class="mhead"><h2 class="fh">Quem lê ${esc(titulo || "")}</h2><button type="button" class="icon-btn" data-fx>✕</button></div>
    <div class="mbody">${l.length ? `<div class="menu-list">${l.map(q => `<button type="button" class="rkq" data-uid="${esc(q.uid)}" data-ap="${esc(q.apelido)}"><span class="rkav" data-av="${esc(q.uid)}">${avatarHTML("", q.apelido)}</span><span class="rkt"><b>@${esc(q.apelido)}</b><small>${q.st === "concluido" && q.nota ? "nota " + fmtNota(q.nota) : q.cap ? "cap. " + fmtCap(q.cap) : "&nbsp;"}</small></span><span class="rkst" style="background:${cor[q.st] || "var(--muted)"}">${esc((STATUS[q.st] || {}).label || "")}</span></button>`).join("")}</div>`
      : `<p class="hint">Ninguém com perfil público tem essa obra na estante agora.</p>`}
    <p class="rknote">Toque em alguém para abrir a estante da pessoa. Só aparecem perfis públicos.</p></div>`, (f) => {
    f.querySelectorAll("[data-uid]").forEach(b => b.onclick = () => { fecharFolha(); openVisit(b.dataset.uid, b.dataset.ap, ""); });
    f.querySelectorAll("[data-av]").forEach(el => getDoc(doc(db, "perfis", el.dataset.av)).then(dd => { if (dd.exists() && el.isConnected) el.innerHTML = avatarHTML((dd.data() || {}).foto, (dd.data() || {}).apelido); }).catch(() => {}));
  });
}
// ⓘ de uma obra do ranking (ou do Para você)
async function openObra(x) {
  abrirFolha(`<div class="mhead"><h2 class="fh">${esc(x.titulo)}</h2><button type="button" class="icon-btn" data-fx>✕</button></div>
    <div class="mbody"><div class="obra">${rkCapa(x, "o")}<div class="obrainfo"><div class="hint">Carregando informações do catálogo…</div></div></div>
    <div class="obraacts"></div></div>`, async (f) => {
    rkCarregaCapas(f);
    const acts = f.querySelector(".obraacts");
    const pintaBotao = () => { acts.innerHTML = naEstante(x) ? `<span class="btn" style="opacity:.7">✓ Na sua estante</span>` : `<button type="button" class="btn primary" id="obAdd">+ Adicionar à estante (Na fila)</button>`;
      const b = acts.querySelector("#obAdd"); if (b) b.onclick = async () => { await adicionarObra(x, b); pintaBotao(); }; };
    pintaBotao();
    const inf = f.querySelector(".obrainfo");
    let c = x.catId ? await lerCatalogo(x.catId) : null;
    if (!c && x.catId) c = await catalogoPorChave(x.catId).catch(() => null);
    if (c) c = await completarSinopse(x.catId, c);
    if (!inf.isConnected) return;
    if (!c) { inf.innerHTML = `<p class="hint">Sem informações do catálogo para esta obra.</p>`; return; }
    const idd = idadeDe(c);
    inf.innerHTML = `${idd ? `<div class="idaderow">${seloIdade(idd)}<span>${idd === "Livre" ? "Livre para todos" : "Não recomendado para menores de " + idd.replace("+", " anos")}</span></div>` : ""}
      ${(c.generos || []).length ? `<div class="gens">${c.generos.map(g => `<span>${esc(g)}</span>`).join("")}</div>` : ""}
      <div class="sinopse">${c.sinopse ? `<p>${esc(c.sinopse)}</p>` : `<p class="hint">Sinopse em tradução… tente abrir de novo daqui a pouco.</p>`}</div>`;
  });
}
// catálogo a partir da chave (al123 / mal123), quando a obra ainda não está no catálogo do app
async function catalogoPorChave(k) {
  const m = /^(al|mal)(\d+)$/.exec(k || ""); if (!m) return null;
  const arg = m[1] === "al" ? `id:${m[2]}` : `idMal:${m[2]}`;
  const j = await httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: `query{Media(${arg},type:MANGA){id idMal title{romaji english} synonyms coverImage{large} genres description(asHtml:false) countryOfOrigin format isAdult}}` }) });
  const md = j && j.data && j.data.Media; if (!md) return null;
  const r = rDeAniList(md); r.key = k;
  return prepararCatalogo(r);
}
const rDeAniList = (m) => ({ key: m.idMal ? "mal" + m.idMal : "al" + m.id, alId: m.id, malId: m.idMal || null,
  original: ((m.title && (m.title.romaji || m.title.english)) || "").trim(), ingles: ((m.title && m.title.english) || "").trim(),
  capa: (m.coverImage && m.coverImage.large) || "", generos: generosPT(m.genres), desc: m.description || "",
  tipo: TIPO[m.countryOfOrigin] || "Mangá", sinonimos: (m.synonyms || []).filter(x => typeof x === "string") });
// "+ Estante" / "Adicionar na fila": entra como Na fila, já ligada ao catálogo
async function adicionarObra(x, btn) {
  if (naEstante(x)) { toast("Essa obra já está na sua estante."); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Adicionando…"; }
  let c = null;
  try { if (x.catId) c = (await lerCatalogo(x.catId)) || (await catalogoPorChave(x.catId)); } catch (e) {}
  const title = (c && nomePopular(c)) || x.titulo;
  const capa = (c && c.capa) || (String(x.capa || "").startsWith("rkcapa:") ? (rkCapaCache[x.capa.slice(7)] || "") : x.capa) || "";
  const data = { title: String(title).slice(0, 120), titulo2: c ? nomeSecundario(c, title) : "", alias: c ? aliasDe(c) : "", catId: c ? x.catId : "",
    cover: safeCover(capa), link: "", status: "fila", chapter: 0, nota: null, comentario: "" };
  const privado = !!((c && idadeDe(c) === "18+") || nomeSuspeito(data.title));
  create(privado ? { ...data, privado: true } : data);
  toast(privado ? "Adicionado em Na fila, como privado (obra 18+)." : "Adicionado à sua estante em Na fila!");
  // troca o "+ Estante" dessa obra em todo lugar que estiver aparecendo
  document.querySelectorAll("[data-add]").forEach(b => { let y = {}; try { y = JSON.parse(b.dataset.add); } catch (e) {}
    if (b === btn || (y.chave && y.chave === x.chave)) { const s = document.createElement("span"); s.className = "mini rktem"; s.textContent = "✓ Na sua estante"; b.replaceWith(s); } });
}

// ---------- Lupa: busca geral no catálogo (nomes em inglês, japonês, português, coreano e chinês) ----------
async function buscaGeral(q) {
  const [al, md] = await Promise.all([buscaAniList(q).catch(() => []),
    httpJSON(`https://api.mangadex.org/manga?limit=10&title=${encodeURIComponent(q)}&contentRating[]=safe&contentRating[]=suggestive`).catch(() => null)]);
  let r = al.slice();
  // o MangaDex conhece nomes em português e variações que o AniList não tem: traz essas obras pelo id do AniList
  const extra = (((md && md.data) || []).map(m => { const l = (m.attributes && m.attributes.links) || {}; const alts = (m.attributes && m.attributes.altTitles) || [];
    const pt = alts.find(t => t["pt-br"]); return { al: +l.al || 0, pt: pt ? pt["pt-br"] : "", nomes: [...Object.values(m.attributes.title || {}), ...alts.flatMap(t => Object.values(t))] }; }))
    .filter(x => x.al);
  const faltam = extra.filter(x => !r.some(y => y.alId === x.al)).map(x => x.al).slice(0, 10);
  if (faltam.length) {
    try {
      const j = await httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: `query($a:[Int]){Page(perPage:10){media(id_in:$a,type:MANGA,isAdult:false){id idMal title{romaji english native} synonyms coverImage{large} genres description(asHtml:false) countryOfOrigin format startDate{year} ${ANIME_CAMPOS}}}}`, variables: { a: faltam } }) });
      const ms = ((j && j.data && j.data.Page && j.data.Page.media) || []);
      for (const m of ms) r.push({ ...rDeAniList(m), nativo: (m.title.native || "").trim(), ano: (m.startDate && m.startDate.year) || null, anime: animeDe(m) });
    } catch (e) {}
  }
  r.forEach(x => { const e = extra.find(y => y.al === x.alId); if (e) { x.nomePT = e.pt; x.outros = e.nomes; } });
  if (!r.length) { try { r = await buscaMAL(q); } catch (e) {} }
  return r.filter(x => !nomeSuspeito(x.original) && !nomeSuspeito(x.ingles || ""));
}
function nomeQueBateu(r, q) {   // quando a busca achou por outro nome (ex.: o nome em português), mostra qual
  const nq = norm(q), vistos = [r.ingles, r.original].map(norm);
  const todos = [r.nomePT, r.nativo, ...(r.sinonimos || []), ...(r.outros || [])].filter(Boolean);
  return todos.find(n => norm(n).includes(nq) && !vistos.includes(norm(n))) || "";
}
function openLupa() {
  openModal(`
    <div class="mhead"><h2>Buscar</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody lupa">
      <div class="lupaq"><input id="lpQ" type="search" placeholder="Nome do mangá, manhwa ou manhua…" autocomplete="off" enterkeyhint="search"></div>
      <div class="lpres" id="lpRes"><p class="hint">Procura no catálogo inteiro, por qualquer nome: inglês, japonês, português, coreano ou chinês.</p></div>
    </div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const inp = root.querySelector("#lpQ"), box = root.querySelector("#lpRes");
    let t = null, seq = 0, lista = [];
    setTimeout(() => inp.focus(), 60);
    const draw = (q) => {
      box.innerHTML = lista.length ? lista.map((r, i) => {
        const nome = r.ingles || r.original, outro = [r.original, r.ingles, r.nativo].find(n => n && norm(n) !== norm(nome)) || "";
        const bateu = nomeQueBateu(r, q), x = { chave: r.key, catId: r.key, titulo: nome, capa: r.capa };
        return `<div class="lpitem" data-i="${i}" role="button" tabindex="0">
          ${r.capa ? `<img src="${esc(r.capa)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="nocapa">?</span>`}
          <span class="ct"><b>${esc(nome)}</b>${outro ? `<small>${esc(outro)}</small>` : ""}${bateu ? `<small class="bateu">Também conhecido como ${esc(bateu)}</small>` : ""}
            <em>${esc(r.tipo || "Mangá")}${r.ano ? " · " + r.ano : ""}${(r.generos || []).length ? " · " + esc(r.generos.slice(0, 3).join(", ")) : ""}</em>${r.anime ? `<span class="atags">${tagAnime(r.anime)}</span>` : ""}</span>
          ${naEstante(x) ? `<span class="mini rktem">✓ Na estante</span>` : `<button type="button" class="mini read" data-lpadd="${i}">+ Estante</button>`}
        </div>`;
      }).join("") : `<p class="hint">Nada encontrado com esse nome. Tente outro nome ou parte dele.</p>`;
    };
    const buscar = async () => {
      const q = inp.value.trim(); clearTimeout(t);
      if (q.length < 2) { box.innerHTML = `<p class="hint">Procura no catálogo inteiro, por qualquer nome: inglês, japonês, português, coreano ou chinês.</p>`; return; }
      const meu = ++seq; box.innerHTML = `<p class="hint">Buscando…</p>`;
      const r = await buscaGeral(q).catch(() => []);
      if (meu !== seq || !box.isConnected) return;
      lista = r; draw(q);
    };
    inp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(buscar, 450); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscar(); } });
    box.addEventListener("click", async (e) => {
      const add = e.target.closest("[data-lpadd]");
      const el = e.target.closest(".lpitem"); if (!el) return;
      const r = lista[+el.dataset.i]; if (!r) return;
      const nome = r.ingles || r.original;
      const x = { chave: r.key, catId: r.key, titulo: nome, capa: r.capa };
      if (add) {
        add.disabled = true; add.textContent = "Adicionando…";
        try { await prepararCatalogo(r); } catch (er) {}
        await adicionarObra(x, null);
        const s2 = document.createElement("span"); s2.className = "mini rktem"; s2.textContent = "✓ Na estante"; add.replaceWith(s2);
        return;
      }
      try { await prepararCatalogo(r); } catch (er) {}
      openObra(x);
    });
  });
}

// ---------- Para você: 10 sugestões; "Não me interessa" troca por outra ----------
const PV_KEY = () => "estante-pv-v2-" + (currentUser ? currentUser.uid : "");
const PV_PROIBIDOS = ["Ecchi", "Hentai"];
const PV_VARIAR = ["Sports", "Mystery", "Romance", "Comedy", "Slice of Life", "Horror", "Sci-Fi", "Psychological", "Drama", "Supernatural", "Adventure", "Fantasy", "Action"];
const PV_CAMPOS = "id idMal type format isAdult genres countryOfOrigin title{romaji english} synonyms coverImage{large} description(asHtml:false)";
const aniQ = (query) => httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query }) });
function pvLer() { try { return JSON.parse(localStorage.getItem(PV_KEY()) || "{}"); } catch (e) { return {}; } }
function pvSalvar(o) { try { localStorage.setItem(PV_KEY(), JSON.stringify(o)); } catch (e) {} }
const pvOk = (m) => m && m.type === "MANGA" && m.format !== "NOVEL" && !m.isAdult && !(m.genres || []).some(g => PV_PROIBIDOS.includes(g)) && (m.coverImage && m.coverImage.large);
// nome mais conhecido: o inglês (Solo Leveling, e não Na Honjaman Level Up); se não tiver, o original
const pvItem = (m) => { const r = rDeAniList(m); return { chave: r.key, catId: r.key, titulo: r.ingles || r.original, capa: r.capa, alId: r.alId, malId: r.malId,
  nomes: [r.ingles, r.original, ...(r.sinonimos || [])].filter(Boolean).slice(0, 12), r }; };
// tudo o que identifica as obras da sua estante: ids do catálogo (AniList e MyAnimeList) e todos os nomes
async function pvMinhaEstante() {
  const ids = new Set(), nomes = new Set();
  const poeNome = (t) => { const n = norm(t).replace(/[^a-z0-9]/g, ""); if (n.length >= 3) nomes.add(n); };
  const meus = [...items.values()];
  for (const it of meus) { if (it.catId) ids.add(it.catId); poeNome(it.title); poeNome(it.titulo2); String(it.alias || "").split("|").forEach(poeNome); }
  const cats = await Promise.all(meus.filter(it => it.catId).slice(0, 80).map(it => lerCatalogo(it.catId).catch(() => null)));
  cats.forEach(c => { if (!c) return; if (c.alId) ids.add("al" + c.alId); if (c.malId) ids.add("mal" + c.malId); [c.titulo, c.titulo2, c.nomeEN, c.nomePT, ...(c.nomes || [])].forEach(poeNome); });
  return { ids, nomes };
}
const pvJaTenho = (x, est) => est.ids.has(x.chave) || (x.alId && est.ids.has("al" + x.alId)) || (x.malId && est.ids.has("mal" + x.malId))
  || [x.titulo, ...(x.nomes || [])].some(t => est.nomes.has(norm(t).replace(/[^a-z0-9]/g, "")));
async function pvMontarFila(dados) {
  const meus = [...items.values()];
  const est = await pvMinhaEstante();
  const jaTenho = (x) => pvJaTenho(x, est);
  // gêneros que você mais lê (pelo catálogo)
  const ligados = meus.filter(it => it.catId).slice(0, 60);
  const cats = await Promise.all(ligados.map(it => lerCatalogo(it.catId).catch(() => null)));
  const porGen = {}; const inv = Object.fromEntries(Object.entries(GENEROS).map(([en, pt]) => [pt, en]));
  cats.forEach(c => (c && c.generos || []).forEach(g => { const en = inv[g]; if (en) porGen[en] = (porGen[en] || 0) + 1; }));
  const principal = [], vistos = new Set();
  const poe = (lista, m) => { if (!pvOk(m)) return; const x = pvItem(m); if (vistos.has(x.chave) || jaTenho(x)) return; vistos.add(x.chave); lista.push(x); };
  // 1) parecidos com o que você avaliou bem
  const sementes = meus.filter(it => it.catId && parseNota(it.nota) >= 8).sort((a, b) => parseNota(b.nota) - parseNota(a.nota)).slice(0, 4);
  if (!sementes.length) sementes.push(...meus.filter(it => it.catId && (stOf(it) === "lendo" || stOf(it) === "concluido")).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)).slice(0, 3));
  const recs = [];
  for (const it of sementes) {
    const c = cats[ligados.indexOf(it)] || await lerCatalogo(it.catId).catch(() => null);
    const mm = /^(al|mal)(\d+)$/.exec(it.catId); if (!mm) continue;
    const arg = c && c.alId ? `id:${c.alId}` : mm[1] === "al" ? `id:${mm[2]}` : `idMal:${mm[2]}`;
    try { const j = await aniQ(`query{Media(${arg},type:MANGA){recommendations(perPage:12,sort:RATING_DESC){nodes{mediaRecommendation{${PV_CAMPOS}}}}}}`);
      recs.push(((j.data && j.data.Media && j.data.Media.recommendations && j.data.Media.recommendations.nodes) || []).map(n => n.mediaRecommendation)); } catch (e) {}
  }
  for (let i = 0; i < 12; i++) recs.forEach(l => l[i] && poe(principal, l[i]));   // intercala as sementes
  // 2) bem avaliados e em alta na comunidade
  const comunidade = [...((dados && dados.todos && dados.todos.melhores) || []), ...((dados && dados.periodos && dados.periodos.alta) || [])].filter(x => x.catId && !jaTenho(x) && !vistos.has(x.chave));
  for (const x of comunidade.slice(0, 8)) { vistos.add(x.chave); principal.push({ chave: x.chave, catId: x.catId, titulo: x.titulo, capa: x.capa }); }
  // 3) populares dos gêneros que você mais lê
  const favs = Object.entries(porGen).sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 2);
  for (const g of (favs.length ? favs : ["Action", "Fantasy"])) {
    try { const j = await aniQ(`query{Page(perPage:20){media(type:MANGA,genre:"${g}",isAdult:false,sort:POPULARITY_DESC){${PV_CAMPOS}}}}`); ((j.data && j.data.Page && j.data.Page.media) || []).forEach(m => poe(principal, m)); } catch (e) {}
  }
  // 4) para variar: os 2 gêneros que você quase não lê
  const raros = PV_VARIAR.filter(g => !favs.includes(g)).sort((a, b) => (porGen[a] || 0) - (porGen[b] || 0)).slice(0, 2);
  const variar = [];
  for (const g of raros) {
    try { const j = await aniQ(`query{Page(perPage:15){media(type:MANGA,genre:"${g}",isAdult:false,sort:SCORE_DESC,popularity_greater:20000){${PV_CAMPOS}}}}`); ((j.data && j.data.Page && j.data.Page.media) || []).forEach(m => poe(variar, m)); } catch (e) {}
  }
  return { principal: principal.slice(0, 40), variar: variar.slice(0, 16) };
}
async function montarParaVoce(area, dados) {
  area.innerHTML = `<p class="rkcap">Sugestões pelo que você lê e avalia · atualiza todo dia</p><div class="rkgrade pvg"><div class="hint">Montando suas sugestões…</div></div>`;
  const hoje = new Date().toISOString().slice(0, 10);
  let pv = pvLer();
  if (pv.dia !== hoje || !pv.fila) {
    if (!navigator.onLine) { area.querySelector(".pvg").innerHTML = `<p class="rkvazio">Sem internet: as sugestões precisam de conexão.</p>`; return; }
    let fila;
    try { fila = await pvMontarFila(dados); } catch (e) { fila = null; }
    if (!fila || (!fila.principal.length && !fila.variar.length)) { if (area.isConnected) area.querySelector(".pvg").innerHTML = `<p class="rkvazio">Não consegui montar as sugestões agora. Tente de novo daqui a pouco.</p>`; return; }
    const nao = pv.nao || [];
    // as que você dispensou ficam para o fim da fila (voltam só se acabar o resto)
    const ordena = (l) => [...l.filter(x => !nao.includes(x.chave)), ...l.filter(x => nao.includes(x.chave)).sort((a, b) => nao.indexOf(a.chave) - nao.indexOf(b.chave))];
    const P = ordena(fila.principal), V = ordena(fila.variar);
    const mostra = [...P.slice(0, 8).map(x => ({ ...x, tipo: "p" })), ...V.slice(0, 2).map(x => ({ ...x, tipo: "v" }))];
    if (mostra.length < 10) mostra.push(...P.slice(8, 8 + (10 - mostra.length)).map(x => ({ ...x, tipo: "p" })));
    // as 2 "para variar" ficam no meio e no fim, não juntas
    const vs = mostra.filter(x => x.tipo === "v"), ps = mostra.filter(x => x.tipo === "p");
    const ordem = []; ps.forEach((x, i) => { ordem.push(x); if (i === 3 && vs[0]) ordem.push(vs.shift()); }); ordem.push(...vs);
    const usados = new Set(ordem.map(x => x.chave));
    pv = { dia: hoje, mostra: ordem.slice(0, 10), fila: { p: P.filter(x => !usados.has(x.chave)), v: V.filter(x => !usados.has(x.chave)) }, nao };
    pvSalvar(pv);
  }
  if (!area.isConnected) return;
  // o que entrou na estante (por aqui ou de outro jeito) sai das sugestões e dá lugar a outra
  try {
    const est = await pvMinhaEstante(); let mudou = false;
    pv.mostra = pv.mostra.map(x => { if (!pvJaTenho(x, est)) return x; mudou = true; return pvProxima(pv, x.tipo, est) || null; }).filter(Boolean);
    if (mudou) pvSalvar(pv);
  } catch (e) {}
  if (!area.isConnected) return;
  desenharPV(area, pv);
}
// próxima sugestão da fila do mesmo tipo, pulando o que já está na estante
function pvProxima(pv, tipo, est) {
  const fila = pv.fila[tipo === "v" ? "v" : "p"] || [];
  while (fila.length) { const p = fila.shift(); if (!est || !pvJaTenho(p, est)) return { ...p, tipo }; }
  return null;
}
function desenharPV(area, pv, novo) {
  const g = area.querySelector(".pvg"); if (!g) return;
  g.innerHTML = pv.mostra.map(x => `<div class="rkcard pv ${novo === x.chave ? "entra" : ""}" data-x="${rkJSON(x)}">${rkCapa(x, "g")}<b>${esc(x.titulo)}</b>
    <div class="pvacts">${naEstante(x) ? `<span class="mini rktem">✓ Na fila</span>` : `<button type="button" class="mini rkadd" data-pvadd="${esc(x.chave)}">+ Adicionar na fila</button>`}<button type="button" class="mini pvnao" data-nao="${esc(x.chave)}">Não me interessa</button></div></div>`).join("");
  g.onclick = (e) => {
    const a = e.target.closest("[data-pvadd]");
    if (a) {
      e.stopPropagation(); const i = pv.mostra.findIndex(y => y.chave === a.dataset.pvadd); if (i < 0) return;
      const x = pv.mostra[i];
      adicionarObraPV(x, a).then(() => {
        // adicionada: sai das sugestões e entra outra no lugar (não volta mais)
        const prox = pvProxima(pv, x.tipo);
        if (prox) pv.mostra[i] = prox; else pv.mostra.splice(i, 1);
        pvSalvar(pv);
        const card = a.closest(".rkcard"); if (card) card.classList.add("sai");
        setTimeout(() => desenharPV(area, pv, prox && prox.chave), 220);
      });
      return;
    }
    const n = e.target.closest("[data-nao]"); if (!n) return;
    e.stopPropagation();
    const k = n.dataset.nao, i = pv.mostra.findIndex(y => y.chave === k); if (i < 0) return;
    const sai = pv.mostra[i], fila = pv.fila[sai.tipo === "v" ? "v" : "p"];
    pv.nao = [...(pv.nao || []).filter(y => y !== k), k].slice(-300);
    fila.push(sai);   // volta para o fim da fila: só reaparece depois de todas as outras
    let prox = fila.shift();
    while (prox && prox.chave !== k && naEstante(prox)) prox = fila.shift();
    pv.mostra[i] = prox && prox.chave !== k ? { ...prox, tipo: sai.tipo } : sai;
    pvSalvar(pv);
    const card = n.closest(".rkcard"); card.classList.add("sai");
    setTimeout(() => desenharPV(area, pv, pv.mostra[i].chave), 220);
  };
}
async function adicionarObraPV(x, btn) {
  if (naEstante(x)) return;
  btn.disabled = true; btn.textContent = "Adicionando…";
  try { if (x.r) await prepararCatalogo(x.r); } catch (e) {}
  await adicionarObra({ chave: x.chave, catId: x.catId, titulo: x.titulo, capa: x.capa }, null);
}


// ---------- Fórum: 3 salas, mensagens somem em 7 dias ----------
const FORUM_SALAS = [{ k: "geral", n: "Geral", d: "Conversa livre sobre mangás" }, { k: "rec", n: "Recomendações", d: "Peça e dê dicas de leitura" }, { k: "spo", n: "Spoilers", d: "Tudo aqui fica coberto até tocar" }];
const nomeSala = (k) => (FORUM_SALAS.find(x => x.k === k) || {}).n || k;
const forumEstado = { sala: null };
const forumPC = () => matchMedia("(min-width:760px)").matches;
// Moderação: palavrões leves passam; pesados ganham asteriscos; ofensas a pessoas não são enviadas
const L = "[\\p{L}\\p{N}]";
const palavra = (src) => new RegExp(`(?<!${L})(?:${src})(?!${L})`, "giu");
const MOD_ASTER = palavra("filh[oa]s? da puta|put[oa]s?|fod[ea]r|fuder|fdp|arrombad[oa]s?|cuz[aã]o|cuz[oõ]es|vsf|vtnc|desgra[cç]ad[oa]s?");
const MOD_BLOQ = [
  [palavra("(?:seu|sua|teu|tua|esse|essa|seus|suas|vai|cara de) macac[oa]s?|crioul[oa]s?|nig+[ae]r|nig+a|negr[oa] imund[oa]|volta pr[ao] senzala"), "ofensa racista"],
  [palavra("viad[oa]s?|bichas?|bichinha|traveco|sapat[aã]o|boiola|baitola|faggot"), "ofensa homofóbica"],
  [palavra("retardad[oa]s?|mongol|mongoloide|aleijad[oa]"), "ofensa capacitista"],
  [palavra("vou te matar|te mato|vou matar voc[eê]|vai morrer|se mata|vai se matar|te pego na sa[ií]da"), "ameaça"],
  [palavra("manda nudes?|manda foto pelad[oa]|nudes"), "assédio"],
  [palavra("nazis\\p{L}*|hitler|heil|pedofil\\p{L}*|estupr\\p{L}*"), "conteúdo proibido"],
];
function moderar(txt) {
  for (const [re, mot] of MOD_BLOQ) { re.lastIndex = 0; if (re.test(txt)) return { erro: `Mensagem não enviada: ${mot}. As regras da comunidade não permitem.` }; }
  let mudou = false;
  const out = txt.replace(MOD_ASTER, (m) => { mudou = true; return m.replace(/(\S)(\S*)/g, (_, a, b) => a + "*".repeat(b.length)); });
  return { texto: out, mudou };
}
const RE_MENCAO = /@([A-Za-z0-9áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]{3,20})/g;
const corDe = (uid) => ["#2563eb", "#be185d", "#b91c1c", "#15803d", "#6d28d9", "#0e7490", "#c2410c", "#475569", "#7e22ce", "#0f766e"][[...String(uid || "")].reduce((a, c) => a + c.charCodeAt(0), 0) % 10];
const fotoCache = {};
const vistoKey = () => "estante-forum-visto-" + (currentUser ? currentUser.uid : "");
function vistoLer() { try { return JSON.parse(localStorage.getItem(vistoKey()) || "{}"); } catch (e) { return {}; } }
function vistoMarcar(sala) { const v = vistoLer(); v[sala] = Date.now(); try { localStorage.setItem(vistoKey(), JSON.stringify(v)); } catch (e) {} }
const horaDe = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const diaDe = (ms) => { const d = new Date(ms), h = new Date(); const z = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const dif = Math.round((z(h) - z(d)) / 864e5); return dif === 0 ? "Hoje" : dif === 1 ? "Ontem" : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`; };
const REGRAS_HTML = `<ol class="regras">
  <li><b>Respeito acima de tudo.</b> Nada de ofender, ameaçar ou humilhar ninguém, por nenhum motivo.</li>
  <li><b>Spoiler só coberto.</b> Use o botão Spoiler, ou escreva na sala Spoilers.</li>
  <li><b>Nada de conteúdo adulto</b>, nem links ou GIFs impróprios.</li>
  <li><b>Sem spam ou propaganda.</b> Uma mensagem a cada 5 segundos.</li>
  <li><b>Palavrão leve passa</b>; os pesados aparecem com asteriscos; ofensas a pessoas não são enviadas.</li>
  <li><b>As mensagens somem em 7 dias.</b> Viu algo errado? Toque na mensagem e em Denunciar.</li>
  <li>Quem descumprir pode ser silenciado (5 minutos, 1 hora, 24 horas ou 7 dias).</li></ol>`;
function abrirRegras() {
  abrirFolha(`<div class="mhead"><h2 class="fh">Regras da comunidade</h2><button type="button" class="icon-btn" data-fx>✕</button></div><div class="mbody">${REGRAS_HTML}</div>`);
}
function montarForum(root) {
  const box = root.querySelector("#forum"), me = currentUser.uid;
  const msgs = { geral: [], rec: [], spo: [] }, unsubs = [];
  let silAte = 0, espera = 0, esperaT = null, resp = null, spoiler = false, gifAberto = false, rascunho = "";
  if (!forumEstado.sala && forumPC()) forumEstado.sala = "geral";
  const naoLidas = (k) => { const v = vistoLer()[k] || 0; return msgs[k].filter(m => (m.criadoEm || 0) > v && m.uid !== me).length; };
  const salasHTML = () => `<div class="fsalas"><div class="fsalash">Salas</div>${FORUM_SALAS.map(x => {
      const u = msgs[x.k][msgs[x.k].length - 1], n = forumEstado.sala === x.k ? 0 : naoLidas(x.k);
      return `<button type="button" class="fsala ${forumEstado.sala === x.k ? "on" : ""}" data-sala="${x.k}"><b>${x.n}${n ? `<span class="fnlid">${n > 99 ? "99+" : n}</span>` : ""}</b><small>${x.d}</small>${!forumPC() && u ? `<span class="fult">@${esc(u.apelido)}: ${u.apagada ? "mensagem apagada" : u.spoiler ? "Spoiler" : u.gif && !u.texto ? "GIF" : esc(u.texto)}</span>` : ""}</button>`; }).join("")}
    <div class="fsalasfoot"><label class="fsw"><input type="checkbox" id="fDnd" ${forumDnd ? "checked" : ""}><span class="fsl"></span><span>Não perturbe<small>Sem avisos do fórum no sino</small></span></label><button type="button" class="fregras" id="fRegras">Regras da comunidade</button></div></div>`;
  const msgHTML = (m) => {
    if (m.apagada) return `<div class="fmsg apagada"><span class="fav" style="background:#bbb"></span><div class="fmc"><div class="fbal">Mensagem apagada pelo administrador.</div></div></div>`;
    const ap = myProfile && myProfile.apelido ? myProfile.apelido.toLowerCase() : "";
    const praMim = (ap && (m.texto || "").toLowerCase().includes("@" + ap)) || (m.resp && m.resp.uid === me);
    const txt = esc(m.texto || "").replace(RE_MENCAO, '<span class="fmen">@$1</span>');
    return `<div class="fmsg ${praMim ? "pramim" : ""}" data-id="${esc(m.id)}"><span class="fav" data-fav="${esc(m.uid)}" style="background:${corDe(m.uid)}">${fotoCache[m.uid] ? `<img src="${esc(fotoCache[m.uid])}" alt="">` : esc((m.apelido || "?").slice(0, 1).toUpperCase())}</span><div class="fmc">
      <div class="fmt"><b>@${esc(m.apelido)}</b><time>${horaDe(m.criadoEm)}</time></div>
      ${m.resp ? `<div class="fcit">Respondendo @${esc(m.resp.apelido)}: ${esc(m.resp.trecho || "")}</div>` : ""}
      ${m.texto ? `<div class="fbal">${m.spoiler ? `<span class="fspo">${txt}</span>` : txt}</div>` : ""}
      ${m.gif ? `<div class="fbal">${m.spoiler && !m.texto ? `<span class="fspo"><img class="fgif" src="${esc(m.gif)}" alt="GIF" loading="lazy" referrerpolicy="no-referrer"></span>` : `<img class="fgif" src="${esc(m.gif)}" alt="GIF" loading="lazy" referrerpolicy="no-referrer">`}</div>` : ""}
      </div><div class="facoes"><button type="button" data-a="resp">Responder</button>${m.uid !== me ? `<button type="button" data-a="den">Denunciar</button>` : ""}</div></div>`;
  };
  const listaHTML = () => {
    const l = msgs[forumEstado.sala]; let dia = "", out = "";
    for (const m of l) { const d = diaDe(m.criadoEm); if (d !== dia) { dia = d; out += `<div class="fdia">${d}</div>`; } out += msgHTML(m); }
    return out || `<p class="fvazio">Nenhuma mensagem ainda. Comece a conversa!</p>`;
  };
  const podeEscrever = () => !!(myProfile && myProfile.apelido);
  const compHTML = () => {
    if (!podeEscrever()) return `<div class="fcomp"><p class="fhint">Para escrever no fórum, crie seu apelido em Meu perfil.</p></div>`;
    if (silAte > Date.now()) return `<div class="fcomp"><p class="fhint">Você está silenciado no fórum até ${diaDe(silAte) === "Hoje" ? "" : diaDe(silAte) + " às "}${horaDe(silAte)}.</p></div>`;
    const temGif = temBuscaGif(), spo = forumEstado.sala === "spo";
    return `<div class="fcomp">
      ${resp ? `<div class="fresp"><span>Respondendo @${esc(resp.apelido)}</span><button type="button" data-c="cancresp">✕</button></div>` : ""}
      ${gifAberto ? `<div class="fgifbox"><div class="fgifbusca"><input id="fGifQ" placeholder="Buscar GIF (ex.: one piece)" autocomplete="off"><button type="button" class="fbt" data-c="gifbusca">Buscar</button><button type="button" class="fbt" data-c="gif">Fechar</button></div><div class="fgifs" id="fGifs"><p class="fhint">Busque um GIF para enviar.</p></div><p class="fcred">GIFs: Powered by GIPHY · KLIPY</p></div>` : ""}
      <div class="flinha"><textarea id="fTxt" maxlength="500" rows="1" placeholder="${forumPC() ? "Escreva uma mensagem…  (@ para mencionar)" : "Escreva uma mensagem…"}">${esc(rascunho)}</textarea>
        <span class="fextra">${temGif ? `<button type="button" class="fbt ${gifAberto ? "on" : ""}" data-c="gif">GIF</button>` : ""}${spo ? "" : `<button type="button" class="fbt ${spoiler ? "on" : ""}" data-c="spo">Spoiler</button>`}</span>
        <button type="button" class="fbt env" data-c="env" ${espera ? "disabled" : ""}>${espera ? `Aguarde ${espera}s` : "Enviar"}</button></div>
      <div class="finfo"><span class="fst"></span><span class="fextra2">${temGif ? `<button type="button" class="fbt ${gifAberto ? "on" : ""}" data-c="gif">GIF</button>` : ""}${spo ? "" : `<button type="button" class="fbt ${spoiler ? "on" : ""}" data-c="spo">Spoiler</button>`}</span><span class="fcnt">${rascunho.length}/500</span></div></div>`;
  };
  const convHTML = () => `<div class="fconv"><div class="fconvh">${forumPC() ? "" : `<button type="button" class="fvoltar" data-c="voltar">‹ Salas</button>`}<b>${esc(nomeSala(forumEstado.sala))}</b><small>Mensagens somem 7 dias depois</small></div>
    <div class="fmsgs">${listaHTML()}</div>${compHTML()}</div>`;
  const pintaLista = () => {
    const ms = box.querySelector(".fmsgs"); if (!ms) return;
    const noFim = ms.scrollHeight - ms.scrollTop - ms.clientHeight < 80;
    ms.innerHTML = listaHTML(); carregaFotos(ms);
    grudaNoFim(ms, noFim);
  };
  const desenha = () => {
    const tabs = root.querySelector(".ctabs"), conversa = !!forumEstado.sala;
    root.querySelector(".mbody").classList.toggle("fconversa", conversa && !forumPC());
    if (tabs) tabs.style.display = conversa && !forumPC() ? "none" : "";
    box.innerHTML = forumPC() ? salasHTML() + (conversa ? convHTML() : "") : (conversa ? convHTML() : salasHTML());
    const ms = box.querySelector(".fmsgs"); if (ms) { carregaFotos(ms); grudaNoFim(ms, true); }
    const ta = box.querySelector("#fTxt");
    if (ta) {
      ta.addEventListener("input", () => { rascunho = ta.value; box.querySelectorAll(".fcnt").forEach(c => c.textContent = ta.value.length + "/500"); const st = box.querySelector(".fst"); if (st) { st.textContent = ""; st.className = "fst"; } });
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && forumPC()) { e.preventDefault(); enviar(); } });
    }
    const gq = box.querySelector("#fGifQ"); if (gq) gq.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscarGif(); } });
    const dnd = box.querySelector("#fDnd"); if (dnd) dnd.onchange = () => { setDoc(doc(db, "users", me, "config", "forum"), { dnd: dnd.checked }).catch(() => {}); forumDnd = dnd.checked; updateBell(); toast(dnd.checked ? "Não perturbe ligado: o fórum não avisa no sino." : "Avisos do fórum ligados."); };
    const rg = box.querySelector("#fRegras"); if (rg) rg.onclick = abrirRegras;
    if (forumEstado.sala) vistoMarcar(forumEstado.sala);
  };
  // fica no fim da conversa, inclusive quando os GIFs terminam de carregar
  function grudaNoFim(ms, agora) {
    let grudado = agora;
    if (agora) ms.scrollTop = ms.scrollHeight;
    ms.onscroll = () => { grudado = ms.scrollHeight - ms.scrollTop - ms.clientHeight < 80; };
    ms.querySelectorAll("img").forEach(i => i.addEventListener("load", () => { if (grudado) ms.scrollTop = ms.scrollHeight; }, { once: true }));
  }
  function carregaFotos(el) {
    el.querySelectorAll("[data-fav]").forEach(a => {
      const uid = a.dataset.fav; if (fotoCache[uid] !== undefined) return;
      fotoCache[uid] = "";
      getDoc(doc(db, "perfis", uid)).then(d => { const f = d.exists() ? safeFoto((d.data() || {}).foto) : ""; fotoCache[uid] = f; if (f) box.querySelectorAll(`[data-fav="${uid}"]`).forEach(x => { x.innerHTML = `<img src="${esc(f)}" alt="">`; }); }).catch(() => {});
    });
  }
  const msgDe = (id) => (msgs[forumEstado.sala] || []).find(m => m.id === id);
  async function buscarGif() {
    const q = box.querySelector("#fGifQ"), res = box.querySelector("#fGifs"); if (!q || !res) return;
    const t = q.value.trim(); if (!t) { q.focus(); return; }
    res.innerHTML = `<p class="fhint">Buscando…</p>`;
    try {
      const l = (await buscaGifs(t)).slice(0, 24);
      res.innerHTML = l.length ? l.map(g => `<button type="button" class="fgifopt" data-gifu="${esc(g.thumb || g.url)}"><img src="${esc(g.thumb || g.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join("") : `<p class="fhint">Nenhum GIF encontrado.</p>`;
    } catch (e) { res.innerHTML = `<p class="fhint">Não consegui buscar agora.</p>`; }
  }
  const comeca5s = () => {
    espera = 5; clearInterval(esperaT);
    esperaT = setInterval(() => { espera--; const b = box.querySelector('[data-c="env"]'); if (b) { b.disabled = espera > 0; b.textContent = espera > 0 ? `Aguarde ${espera}s` : "Enviar"; } if (espera <= 0) clearInterval(esperaT); }, 1000);
  };
  async function enviar(gif) {
    if (espera || !podeEscrever()) return;
    const ta = box.querySelector("#fTxt"), st = box.querySelector(".fst");
    const bruto = (ta ? ta.value : "").trim().slice(0, 500);
    if (!bruto && !gif) return;
    const r = bruto ? moderar(bruto) : { texto: "", mudou: false };
    if (r.erro) { if (st) { st.className = "fst ferro"; st.textContent = r.erro; } return; }
    const sala = forumEstado.sala;
    const m = { uid: me, apelido: myProfile.apelido, texto: r.texto, spoiler: sala === "spo" || spoiler, criadoEm: Date.now(), ts: serverTimestamp() };
    if (gif) m.gif = String(gif).slice(0, 600);
    if (resp) m.resp = { uid: resp.uid, apelido: String(resp.apelido || "").slice(0, 30), trecho: String(resp.trecho || "").slice(0, 120) };
    const b = writeBatch(db);
    b.set(doc(collection(db, "forum", sala, "msgs")), m);
    b.set(doc(db, "forumUsers", me), { ultima: serverTimestamp() }, { merge: true });
    comeca5s();
    const alvoResp = resp; rascunho = ""; resp = null; spoiler = false; gifAberto = false; desenha();
    try { await b.commit(); }
    catch (e) {
      toast(e && e.code === "permission-denied" ? "Não foi possível enviar. Espere alguns segundos (ou você pode estar silenciado)." : "Não foi possível enviar. Verifique a internet.", 4500);
      rascunho = bruto; desenha(); return;
    }
    if (r.mudou) toast("Algumas palavras foram suavizadas com asteriscos.", 3200);
    // avisa no sino quem foi mencionado ou respondido
    const trecho = (r.texto || (gif ? "GIF" : "")).slice(0, 120), avisados = new Set([me]);
    const avisa = (uid, tipo) => { if (!uid || avisados.has(uid)) return; avisados.add(uid); addDoc(collection(db, "users", uid, "avisos"), { tipo, de: me, apelido: myProfile.apelido, sala, trecho: m.spoiler ? "Spoiler" : trecho, em: Date.now() }).catch(() => {}); };
    if (alvoResp) avisa(alvoResp.uid, "resposta");
    for (const [, ap] of (r.texto || "").matchAll(RE_MENCAO)) {
      try { const d = await getDoc(doc(db, "apelidos", ap.toLowerCase())); if (d.exists()) avisa((d.data() || {}).uid, "mencao"); } catch (e) {}
    }
  }
  box.addEventListener("click", (e) => {
    const sp = e.target.closest(".fspo"); if (sp && !sp.classList.contains("ver")) { sp.classList.add("ver"); return; }
    const s = e.target.closest("[data-sala]"); if (s) { forumEstado.sala = s.dataset.sala; resp = null; rascunho = ""; gifAberto = false; desenha(); return; }
    const a = e.target.closest("[data-a]");
    if (a) {
      const m = msgDe(a.closest("[data-id]").dataset.id); if (!m) return;
      if (a.dataset.a === "resp") { resp = { uid: m.uid, apelido: m.apelido, trecho: m.spoiler ? "Spoiler" : (m.texto || "GIF") }; desenha(); const ta = box.querySelector("#fTxt"); if (ta) ta.focus(); }
      if (a.dataset.a === "den") abrirDenunciaForum(m, forumEstado.sala);
      return;
    }
    const g = e.target.closest("[data-gifu]"); if (g) { enviar(g.dataset.gifu); return; }
    const c = e.target.closest("[data-c]");
    if (c) {
      const k = c.dataset.c;
      if (k === "voltar") { forumEstado.sala = null; desenha(); }
      else if (k === "cancresp") { resp = null; desenha(); }
      else if (k === "spo") { spoiler = !spoiler; box.querySelectorAll('[data-c="spo"]').forEach(x => x.classList.toggle("on", spoiler)); }
      else if (k === "gif") { gifAberto = !gifAberto; desenha(); const q = box.querySelector("#fGifQ"); if (q) q.focus(); }
      else if (k === "gifbusca") buscarGif();
      else if (k === "env") enviar();
      return;
    }
    const msg = e.target.closest(".fmsg[data-id]");
    if (msg) { box.querySelectorAll(".fmsg.aberta").forEach(x => x !== msg && x.classList.remove("aberta")); msg.classList.toggle("aberta"); }
  });
  // mensagens em tempo real (as 100 mais novas de cada sala, só dos últimos 7 dias)
  for (const x of FORUM_SALAS) {
    unsubs.push(onSnapshot(query(collection(db, "forum", x.k, "msgs"), orderBy("criadoEm", "desc"), limit(100)), (snap) => {
      const limite = Date.now() - 7 * 864e5;
      msgs[x.k] = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => (m.criadoEm || 0) > limite).sort((a, b) => (a.criadoEm || 0) - (b.criadoEm || 0));
      if (!box.isConnected) return;
      if (forumEstado.sala === x.k) { pintaLista(); vistoMarcar(x.k); }
      if (!forumEstado.sala || forumPC()) { const ss = box.querySelector(".fsalas"); if (ss) { const novo = document.createElement("div"); novo.innerHTML = salasHTML(); ss.replaceWith(novo.firstElementChild); const dnd = box.querySelector("#fDnd"); if (dnd) dnd.onchange = () => { setDoc(doc(db, "users", me, "config", "forum"), { dnd: dnd.checked }).catch(() => {}); forumDnd = dnd.checked; updateBell(); }; const rg = box.querySelector("#fRegras"); if (rg) rg.onclick = abrirRegras; } }
    }, () => { if (box.isConnected && forumEstado.sala === x.k) { const ms = box.querySelector(".fmsgs"); if (ms) ms.innerHTML = `<p class="fvazio">Não consegui carregar as mensagens agora.</p>`; } }));
  }
  getDoc(doc(db, "forumUsers", me)).then(d => { const t = d.exists() && (d.data() || {}).silenciadoAte; silAte = t && t.toMillis ? t.toMillis() : 0; if (silAte > Date.now() && box.isConnected) desenha(); }).catch(() => {});
  const aoMudarTela = () => { if (box.isConnected) desenha(); };
  const mq = matchMedia("(min-width:760px)"); mq.addEventListener("change", aoMudarTela);
  desenha();
  return () => { unsubs.forEach(u => u()); clearInterval(esperaT); mq.removeEventListener("change", aoMudarTela); fecharFolha(); };
}
const MOTIVOS_FORUM = { ofensa: "Ofensa ou desrespeito", spoiler: "Spoiler sem aviso", improprio: "Conteúdo impróprio", spam: "Spam ou propaganda", outro: "Outro motivo" };
function abrirDenunciaForum(m, sala) {
  abrirFolha(`<form id="fdenF"><div class="mhead"><h2 class="fh">Denunciar mensagem</h2><button type="button" class="icon-btn" data-fx>✕</button></div>
    <div class="mbody"><p class="hint" style="margin-top:0">Mensagem de <b>@${esc(m.apelido)}</b> em ${esc(nomeSala(sala))}. A pessoa não fica sabendo quem denunciou.</p>
      <div class="menu-list">${Object.entries(MOTIVOS_FORUM).map(([k, v], i) => `<label class="chk"><input type="radio" name="m" value="${k}" ${i ? "" : "checked"}> <span>${v}</span></label>`).join("")}</div>
      <label class="f">Detalhes (opcional)<textarea name="t" maxlength="300" rows="2"></textarea></label>
      <div class="mfoot" style="padding:0;border:0"><span class="grow"></span><button type="button" class="btn ghost" data-fx>Cancelar</button><button type="submit" class="btn primary">Enviar denúncia</button></div></div></form>`, (f) => {
    f.querySelector("#fdenF").addEventListener("submit", async (e) => {
      e.preventDefault();
      const me = currentUser.uid, sb = e.target.querySelector("[type=submit]"); sb.disabled = true;
      const den = { de: me, apelidoDe: String((myProfile && myProfile.apelido) || "").slice(0, 30), alvo: m.uid, alvoApelido: String(m.apelido || "").slice(0, 30),
        mangaId: `f-${sala}-${m.id}`.slice(0, 100), titulo: ("Fórum · " + nomeSala(sala)).slice(0, 120), motivo: e.target.m.value, texto: e.target.t.value.trim().slice(0, 300),
        criadoEm: Date.now(), resolvido: false, tipo: "forum", sala, msgId: String(m.id).slice(0, 40), trecho: String(m.texto || (m.gif ? "[GIF] " + m.gif : "")).slice(0, 300) };
      try { await setDoc(doc(db, "denuncias", `${me}_${m.uid}_${den.mangaId}`), den); fecharFolha(); toast("Denúncia enviada. Obrigado por ajudar a manter a comunidade legal!", 4000); }
      catch (x) { sb.disabled = false; toast(x.code === "permission-denied" ? "Você já denunciou esta mensagem." : "Não foi possível enviar agora.", 4000); }
    });
  });
}

// ---------- Tutorial do primeiro acesso ----------
// Só para contas criadas a partir do lançamento desta função, com a estante vazia. Fica salvo na conta.
const TUT_DESDE = Date.parse("2026-11-25T14:00:00Z");
const TUT_KEY = (uid) => "estante-tutorial-" + uid;
async function talvezTutorial(uid) {
  try { if (localStorage.getItem(TUT_KEY(uid))) return; } catch (e) {}
  if (membroDesdeAuth() < TUT_DESDE) return;
  try { const d = await getDoc(doc(db, "users", uid, "config", "tutorial")); if (d.exists()) { try { localStorage.setItem(TUT_KEY(uid), "1"); } catch (e) {} return; } } catch (e) { return; }
  // espera a estante carregar e a abertura terminar
  await new Promise(r => setTimeout(r, 1500));
  for (let i = 0; i < 40 && document.getElementById("abertura"); i++) await new Promise(r => setTimeout(r, 150));
  if (!currentUser || currentUser.uid !== uid || items.size || $("#bd").classList.contains("open")) return;
  iniciarTutorial(false);
}
function marcarTutorialVisto() {
  if (!currentUser) return;
  try { localStorage.setItem(TUT_KEY(currentUser.uid), "1"); } catch (e) {}
  setDoc(doc(db, "users", currentUser.uid, "config", "tutorial"), { visto: true }).catch(() => {});
}
const espera = (ms) => new Promise(r => setTimeout(r, ms));
async function esperaEl(sel, ms = 9000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = document.querySelector(sel); if (e) return e; await espera(120); } return null; }
const ICO_TUT = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 6q-4-2-8-1v13q4-1 8 1q4-2 8-1V5q-4-1-8 1z"/><path d="M12 6v13"/></svg>`;
const tic = (t, cls = "") => `<span class="tic ${cls}">${t}</span>`;
function cardDoExemplo() {
  const cards = [...document.querySelectorAll("#grid .card")];
  return cards.find(c => /one piece/i.test(c.textContent)) || cards[0] || null;
}
function uniao(els) {
  const rs = els.filter(Boolean).map(e => e.getBoundingClientRect()); if (!rs.length) return null;
  const x = Math.min(...rs.map(r => r.left)), y = Math.min(...rs.map(r => r.top)), x2 = Math.max(...rs.map(r => r.right)), y2 = Math.max(...rs.map(r => r.bottom));
  return { left: x, top: y, width: x2 - x, height: y2 - y };
}
function iniciarTutorial(rever) {
  if (document.getElementById("tut")) return;
  closeModal();
  let passo = 0, fase2 = false, timers = [], acabou = false, criouExemplo = false;
  const PASSOS = [
    { t: "Bem-vindo à Estante de Mangás!", p: "Em 1 minuto você conhece o essencial. Dá para pular quando quiser." },
    { alvo: () => $("#addBtn"), t: "Adicione seus mangás", p: "Toque aqui para adicionar um mangá à sua estante.",
      prox: async () => {
        openEditor();
        const q = await esperaEl("#catQ", 3000); if (!q) return;
        q.value = "One Piece"; const go = document.querySelector("#catGo"); if (go) go.click();
        await esperaEl("#catRes .catitem", 9000);
      } },
    { alvo: () => document.querySelector("#catBox"), t: "Encontre no catálogo", p: "Encontre seu mangá no catálogo: digite o nome e toque no resultado.",
      prox: async () => {
        const r = document.querySelector("#catRes .catitem");
        if (r) { r.click(); for (let i = 0; i < 80 && !/vinculado/.test(($("#catStatus") || {}).textContent || ""); i++) await espera(150); }
        const ch = document.querySelector('#ed [name="chapter"]'); if (ch && !ch.value) ch.value = "1";
        const st = document.querySelector('#ed [name="status"]'); if (st) st.scrollIntoView({ block: "center" });
        await espera(250);
      } },
    { alvo: () => uniao([document.querySelector('#ed [name="chapter"]'), document.querySelector('#ed [name="status"]'), document.querySelector('#ed [name="link"]')]), margem: 10,
      t: "Ajuste sua leitura", p: "Diga em que capítulo você está e escolha o status do seu mangá. Se quiser, cole o link do site onde você lê. Depois, toque em Salvar.", lista: true,
      prox: async () => {
        const f = document.querySelector("#ed");
        const jaTem = [...items.values()].some(it => /one piece/i.test(it.title));
        if (f && !jaTem) { criouExemplo = true; f.requestSubmit(); await esperaEl("#grid .card", 4000); await espera(500); }
        else closeModal();
        await espera(200);
      } },
    { alvo: () => cardDoExemplo(), t: "Seu card de leitura", icones: true,
      ul: [tic("−") + "volta um capítulo", tic("+", "pl") + "avança um capítulo", tic("1", "num") + "toque no número para digitar o capítulo", tic("Ler ↗", "ler") + "abre o site onde você lê",
        tic("i", "inf") + "detalhes, sinopse e sua nota", tic("✎") + "edita o mangá", tic(ICO_TUT) + "deixa este mangá privado: só você vê, mesmo com perfil público"] },
    { alvo: () => $("#bellBtn"), mostraSino: true, t: "Novidades", p: "O sino avisa capítulo novo, menção no fórum e anime anunciado. “Limpar” esvazia a lista." },
    { alvo: () => $("#peopleBtn"), t: "Social", ul: ["<b>Meu perfil</b>: sua vitrine, foto e favoritos", "<b>Comunidade</b>: visite estantes de outros leitores", "<b>Ranking</b> e <b>Fórum</b>"] },
    { alvo: () => $("#peopleBtn"), t: "Sua estante pública", p: "Sua estante é pública: outros leitores podem visitá-la e se inspirar. Prefere só para você? Em Social › Meu perfil, feche o perfil quando quiser." },
    { alvo: () => $("#menuBtn"), t: "Menu", p: "Toque no ☰ para abrir o menu.",
      depois: { alvo: () => uniao([...document.querySelectorAll("#modal .acct, #modal .menu-list .btn")].filter(b => b.classList.contains("acct") || /Guia|Lixeira|Reportar|senha|backup/i.test(b.textContent))), t: "Menu", p: "Aqui ficam sua conta, a lixeira, os backups e o Guia do app, com tudo explicado para quando precisar.", fim: true },
      abrir: () => openMenu() },
  ];
  const raiz = document.createElement("div"); raiz.id = "tut";
  raiz.innerHTML = `<div class="tut-bloq"></div><div class="tut-foco"></div><div class="tut-bal" role="dialog" aria-live="polite"></div>`;
  document.documentElement.appendChild(raiz);
  const foco = raiz.querySelector(".tut-foco"), bal = raiz.querySelector(".tut-bal");
  const limpa = () => { timers.forEach(clearTimeout); timers = []; raiz.querySelectorAll(".tut-toque,.tut-lista").forEach(x => x.remove()); };
  const fecha = (msg, ms) => {
    if (acabou) return; acabou = true; limpa(); raiz.remove(); window.removeEventListener("resize", posiciona); window.removeEventListener("scroll", posiciona, true);
    if ($("#bd").classList.contains("open") && (document.querySelector("#ed") || document.querySelector("#mGuia"))) closeModal();
    updateBell(); marcarTutorialVisto();
    if (msg) setTimeout(() => toast(msg, ms), 250);
  };
  function posiciona() {
    if (acabou) return;
    const P = fase2 ? PASSOS[passo].depois : PASSOS[passo];
    const W = window.innerWidth, H = window.innerHeight, pc = W >= 1100;
    const seta = bal.querySelector(".tut-seta");
    const el = P.alvo ? P.alvo() : null;
    const r = el ? (el.getBoundingClientRect ? el.getBoundingClientRect() : el) : null;
    if (!r || !r.width) { foco.className = "tut-foco centro"; foco.style.cssText = `left:${W / 2}px;top:${H / 2}px`; bal.style.left = (W - bal.offsetWidth) / 2 + "px"; bal.style.top = Math.max(16, (H - bal.offsetHeight) / 2) + "px"; if (seta) seta.style.display = "none"; return; }
    const m = P.margem || 8, x = r.left, y = r.top, w = r.width, h = r.height;
    foco.className = "tut-foco"; foco.style.cssText = `left:${x - m}px;top:${y - m}px;width:${w + 2 * m}px;height:${h + 2 * m}px`;
    const bw = bal.offsetWidth, bh = bal.offsetHeight; let bx, by;
    const cabeLado = x + w + m + 24 + bw < W || x - m - 24 - bw > 0;
    if (pc && cabeLado) {
      const dir = x + w + m + 24 + bw < W;
      bx = dir ? x + w + m + 24 : x - m - 24 - bw; by = Math.max(16, Math.min(H - bh - 16, y + h / 2 - bh / 2));
      const sy = Math.max(16, Math.min(bh - 30, y + h / 2 - by - 7));
      seta.style.cssText = dir ? `left:-9px;top:${sy}px;transform:rotate(-45deg)` : `right:-9px;top:${sy}px;transform:rotate(135deg)`;
    } else {
      const embaixo = y + h + m + 16 + bh < H - 10;
      bx = Math.max(10, Math.min(W - bw - 10, x + w / 2 - bw / 2)); by = embaixo ? y + h + m + 16 : Math.max(10, y - m - 16 - bh);
      const sx = Math.max(16, Math.min(bw - 30, x + w / 2 - bx - 7));
      seta.style.cssText = embaixo ? `top:-9px;left:${sx}px` : `bottom:-9px;left:${sx}px;transform:rotate(225deg)`;
    }
    bal.style.left = bx + "px"; bal.style.top = by + "px";
    const L = raiz.querySelector(".tut-lista"), sel = document.querySelector('#ed [name="status"]');
    if (L && sel) { const rs = sel.getBoundingClientRect(); L.style.cssText = `left:${rs.left}px;top:${rs.bottom + 4}px;width:${rs.width}px`; }
  }
  function mostra(f2) {
    limpa(); fase2 = !!f2;
    const base = PASSOS[passo], P = fase2 ? base.depois : base;
    if (base.mostraSino) $("#bellBtn").classList.remove("hidden"); else updateBell();
    const fim = P.fim || (!base.depois && passo === PASSOS.length - 1);
    bal.innerHTML = `<div class="tut-pas">Passo ${passo + 1} de ${PASSOS.length}</div><h3>${P.t}</h3>${P.p ? `<p>${P.p}</p>` : ""}${P.ul ? `<ul class="${P.icones ? "icones" : ""}">${P.ul.map(x => `<li>${x}</li>`).join("")}</ul>` : ""}
      <div class="tut-barra">${PASSOS.map((_, i) => `<i class="${i <= passo ? "on" : ""}"></i>`).join("")}</div>
      <div class="tut-acoes">${fim ? "" : `<button type="button" class="tut-pular" data-t="pular">Pular tutorial</button>`}${passo ? `<button type="button" class="tut-bt" data-t="volta">Voltar</button>` : ""}<button type="button" class="tut-bt pri" data-t="prox">${fim ? "Começar" : passo ? "Próximo" : "Vamos lá"}</button></div><span class="tut-seta"></span>`;
    if (P.lista) { const L = document.createElement("div"); L.className = "tut-lista"; L.innerHTML = Object.entries(STATUS).map(([k, v], i) => `<div class="s-${k} ${i ? "" : "on"}"><i></i>${v.label}</div>`).join(""); raiz.appendChild(L); }
    posiciona(); setTimeout(posiciona, 60); setTimeout(posiciona, 450);
    if (base.depois && !fase2) {
      timers.push(setTimeout(() => {
        const el = P.alvo(); if (!el) return; const r = el.getBoundingClientRect();
        const t = document.createElement("span"); t.className = "tut-toque"; t.style.left = (r.left + r.width / 2) + "px"; t.style.top = (r.top + r.height / 2) + "px"; raiz.appendChild(t);
        timers.push(setTimeout(() => abreDepois(), 650));
      }, 1600));
    }
  }
  async function abreDepois() { limpa(); const base = PASSOS[passo]; if (base.abrir) base.abrir(); await espera(350); mostra(true); }
  let ocupado = false;
  bal.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-t]"); if (!b || ocupado) return;
    const a = b.dataset.t, base = PASSOS[passo];
    if (a === "pular") { fecha("Se precisar, o Guia do app fica no menu ☰.", 5000); return; }
    if (a === "volta") {
      if (fase2) { closeModal(); mostra(false); return; }
      // voltar não desfaz o que já foi feito: só mostra o passo anterior
      passo = Math.max(0, passo - 1); mostra(false); return;
    }
    if (base.depois && !fase2) { abreDepois(); return; }
    if (fase2 || passo === PASSOS.length - 1) { fecha("Tudo pronto! Boa leitura.", 4000); return; }
    ocupado = true; b.disabled = true; b.textContent = "…";
    try { if (base.prox) await base.prox(); } catch (x) {}
    ocupado = false; if (acabou) return;
    passo++; mostra(false);
  });
  window.addEventListener("resize", posiciona); window.addEventListener("scroll", posiciona, true);
  mostra(false);
}

// ---------- Guia do app (menu ☰) ----------
const GUIA = [
  ["Adicionar e editar mangá", "adicionar", "<ol><li>Toque em <b>+ Adicionar</b>.</li><li>Escreva o nome e escolha a obra no catálogo.</li><li>Ajuste capítulo, status e link e salve. Para editar depois, toque no ✎ do card.</li></ol>"],
  ["Capítulos e status", "card", "<ol><li>Use <b>−</b> e <b>+</b> para mudar o capítulo, ou toque no número para digitar.</li><li>O status (Lendo, Na fila, Pausado, Concluído) muda no editor.</li></ol>"],
  ["Nota e comentário", "nota", "<ol><li>No editor, dê uma nota de 0 a 10 e escreva um comentário curto.</li><li>As notas entram no ranking “Os mais bem avaliados”.</li></ol>"],
  ["Link e capítulo novo", "sino", "<ol><li>Coloque no editor o link do site onde você lê.</li><li>O app confere o site e o sino avisa quando sai capítulo novo.</li></ol>"],
  ["Catálogo", "info", "<ol><li>Ao escolher a obra no catálogo, vêm capa, nomes, gêneros e sinopse.</li><li>Toque no <b>ⓘ</b> do card para ver tudo.</li></ol>"],
  ["Buscar no catálogo", "adicionar", "<ol><li>Toque na <b>lupa</b> ao lado do sino.</li><li>Busque por qualquer nome: inglês, japonês, português, coreano ou chinês.</li><li>Toque na obra para ver detalhes ou em <b>+ Estante</b> para adicionar.</li></ol>"],
  ["Anime anunciado", "card", "<ol><li>O selo amarelo <b>Anime anunciado</b> aparece na capa quando sai o anúncio, e o sino avisa.</li><li>Depois que você abre o mangá, vira o selo escuro <b>Anime</b>.</li></ol>"],
  ["Vitrine e foto de perfil", "perfil", "<ol><li>Em Social › <b>Meu perfil</b>, toque em Editar vitrine.</li><li>Escolha capa (imagem ou GIF), cor, bio e até 3 favoritos.</li></ol>"],
  ["Comunidade e visitas", "comunidade", "<ol><li>Em Social › <b>Comunidade</b>, veja os leitores.</li><li>Toque em alguém para visitar a estante e adicionar mangás dela à sua.</li></ol>"],
  ["Ranking", "ranking", "<ol><li>Em Social › <b>Ranking</b>: Todos os tempos, Em alta (os mais lidos em 7 dias), Este mês e Por gênero.</li><li><b>Para você</b> traz sugestões pelo que você lê.</li></ol>"],
  ["Privacidade", "privacidade", "<ol><li>O ícone de mangá no card deixa aquele mangá privado: só você vê.</li><li>Em Meu perfil, escolha estante pública ou fechada.</li></ol>"],
  ["Fórum e regras", "forum", "<ol><li>Em Social › <b>Fórum</b>: salas Geral, Recomendações e Spoilers.</li><li>Use Spoiler para cobrir revelações. As mensagens somem em 7 dias.</li></ol>"],
  ["Aparência", "aparencia", "<ol><li>No botão de quadradinhos ao lado dos filtros.</li><li>Escolha cards por linha, tamanho do texto, tema e a abertura do app.</li></ol>"],
  ["Lixeira", "lixeira", "<ol><li>No menu ☰ › <b>Lixeira</b>.</li><li>O que você apagou fica lá e pode ser restaurado.</li></ol>"],
  ["Conta (senha, excluir)", "menu", "<ol><li>No menu ☰: <b>Trocar senha</b> e <b>Excluir minha conta</b>.</li><li>Excluir apaga a conta e todos os seus dados.</li></ol>"],
  ["Instalar e atualizar", "menu", "<ol><li>O app se atualiza sozinho ao abrir.</li><li>Quando sai uma versão nova para baixar, aparece um aviso no topo.</li></ol>"],
];
function openGuia() {
  openModal(`
    <div class="mhead"><h2>Guia do app</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody guia">
      <div class="gtop"><label class="gbusca"><input id="gq" type="search" placeholder="Busque: como trocar a capa?" autocomplete="off"></label><button type="button" class="btn primary" id="gRever">Rever o tutorial</button></div>
      <div class="secth">Tópicos</div>
      <div class="glista">${GUIA.map(([t, img, tx], i) => `<div class="git" data-i="${i}"><button type="button" class="gith"><span class="gn">${i + 1}</span>${esc(t)}<span class="gch">▾</span></button>
        <div class="gcont"><div class="gimg"><img data-src="guia/${img}.webp" alt=""></div><div class="gtxt">${tx}</div></div></div>`).join("")}</div>
      <p class="hint" id="gVazio" style="display:none;text-align:center">Nada encontrado. Tente outra palavra.</p>
    </div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const abre = (it, sim) => { it.classList.toggle("aberto", sim); const im = it.querySelector("img[data-src]"); if (sim && im) { im.src = im.dataset.src; im.removeAttribute("data-src"); } };
    root.querySelectorAll(".gith").forEach(b => b.onclick = () => { const it = b.parentElement; abre(it, !it.classList.contains("aberto")); });
    const q = root.querySelector("#gq");
    q.oninput = () => {
      const t = norm(q.value.trim()); let n = 0;
      root.querySelectorAll(".git").forEach(it => { const ok = !t || norm(it.textContent).includes(t); it.style.display = ok ? "" : "none"; if (ok) { n++; if (t) abre(it, true); } });
      root.querySelector("#gVazio").style.display = n ? "none" : "";
    };
    root.querySelector("#gRever").onclick = () => { closeModal(); setTimeout(() => iniciarTutorial(true), 200); };
  }, { wide: true });
}

// ---------- vitrine do perfil ----------
const soVisiveis = () => new Map([...items].filter(([, it]) => !it.privado));
const CORES = { roxo: "#7c3aed", azul: "#2563eb", ciano: "#0891b2", verde: "#16a34a", laranja: "#ea580c", vermelho: "#dc2626", rosa: "#db2777", grafite: "#475569" };
const CORES_NOME = { roxo: "Roxo", azul: "Azul", ciano: "Ciano", verde: "Verde", laranja: "Laranja", vermelho: "Vermelho", rosa: "Rosa", grafite: "Grafite" };
const membroDesdeAuth = () => (currentUser && Date.parse(currentUser.metadata && currentUser.metadata.creationTime)) || Date.now();
function safeBanner(b) {
  b = String(b || "");
  if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(b) && b.length <= 450000) return b;
  if (/^https:\/\/[^\s"'<>]+$/.test(b) && b.length <= 600) return b;
  return "";
}
const ehVideo = (u) => /\.mp4($|\?)/i.test(String(u || ""));
function midiaBanner(u, pos, extra = "") {
  const st = `object-position:50% ${posBanner(pos)}%`;
  return ehVideo(u) ? `<video src="${esc(u)}" autoplay muted loop playsinline preload="auto" style="${st}" ${extra}></video>` : `<img src="${esc(u)}" alt="" referrerpolicy="no-referrer" style="${st}" ${extra}>`;
}
const PC_LARG = 1400;   // abaixo disso a capa fica borrada em telas grandes
const posBanner = (v) => { const n = Number(v); return isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50; };
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
    <div class="vtban">${bn ? midiaBanner(bn, p.bannerPos) : ""}</div>
    <div class="vtin">
      <div class="vthead">${avatarHTML(p.foto, p.apelido, "vtav")}<div class="vtname"><b>@${esc(p.apelido || "")}</b>${p.membroDesde ? `<small>Membro desde ${mesAno(p.membroDesde)}</small>` : ""}</div></div>
      ${p.bio ? `<p class="vtbio">${esc(p.bio)}</p>` : ""}
      <div class="vtcnt"><span><i style="background:var(--c-lendo)"></i>${cnt.lendo} lendo</span><span><i style="background:var(--c-fila)"></i>${cnt.fila} na fila</span><span><i style="background:var(--c-pausa)"></i>${plural(cnt.pausado, "pausado", "pausados")}</span><span><i style="background:var(--c-fim)"></i>${plural(cnt.concluido, "concluído", "concluídos")}</span></div>
      ${favs.length ? `<div class="vtsec">Mangás favoritos</div><div class="vtfavs">${favs.map(it => `<button type="button" class="vtfav" data-mid="${esc(it.id)}">${capaMini(it, "vtfc")}<span>${esc(it.title)}</span></button>`).join("")}</div>` : ""}
    </div>
  </div>
  <div class="vtmais">
    ${lendo ? `<div class="vtbox"><div class="vtsec">Lendo agora</div><button type="button" class="vtrow" data-mid="${esc(lendo.id)}">${capaMini(lendo, "vtrc")}<span><b>${esc(lendo.title)}</b><small>Capítulo ${fmtCap(lendo.chapter)}</small></span></button></div>` : ""}
    ${ativ.length ? `<div class="vtbox"><div class="vtsec">Atividade recente</div>${ativ.map(it => `<button type="button" class="vtrow" data-mid="${esc(it.id)}">${capaMini(it, "vtrc")}<span>${visita ? `@${esc(p.apelido || "")}` : "Você"} ${verbo(it)} <b>${esc(it.title)}</b><small>${haQuanto(it.updatedAt || it.createdAt)}</small></span></button>`).join("")}</div>` : ""}
  </div>`;
}
// liga os cliques (abre o ⓘ do mangá) e calcula os gêneros favoritos pelo catálogo
function ligarVitrine(box, its, fechar) {
  box.querySelectorAll("[data-mid]").forEach(b => b.onclick = () => { const id = b.dataset.mid; if (fechar) closeModal(); openInfo(id); });
  // na vitrine de outra pessoa, capas de obras 18+ ficam borradas
  if (!fechar) box.querySelectorAll("[data-mid]").forEach(b => { const it = its.get(b.dataset.mid); if (it && it.catId) lerCatalogo(it.catId).then(c => { if (c && idadeDe(c) === "18+") b.classList.add("borrado18"); }); });
}
async function bannerDaGaleria(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const W = 2400, H = 680, c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const r = Math.max(W / img.naturalWidth, H / img.naturalHeight), w = W / r, h = H / r;
    ctx.drawImage(img, (img.naturalWidth - w) / 2, (img.naturalHeight - h) / 2, w, h, 0, 0, W, H);
    for (const [s, qs] of [[1, [0.86, 0.76, 0.66]], [0.8, [0.8, 0.68]], [0.6, [0.75, 0.6]]]) {
      let cv = c; if (s < 1) { cv = document.createElement("canvas"); cv.width = W * s; cv.height = H * s; cv.getContext("2d").drawImage(c, 0, 0, cv.width, cv.height); }
      for (const q of qs) { let o = cv.toDataURL("image/webp", q); if (!o.startsWith("data:image/webp")) o = cv.toDataURL("image/jpeg", q); if (o.length <= 450000) return o; }
    }
    throw new Error("grande");
  } finally { URL.revokeObjectURL(url); }
}
// ---------- acervo de imagens dentro do app: AniList + MyAnimeList + Kitsu + Wallhaven ----------
const AL = (query, variables) => httpJSON("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables }) });
const okUrl = (u) => typeof u === "string" && /^https:\/\//.test(u) && u.length <= 600;
async function imgAniList(q, tipo) {   // tipo: "banner" (largas) ou "capa" (em pé)
  const j = await AL(`query($q:String){Page(perPage:20){media(search:$q,isAdult:false,sort:SEARCH_MATCH){bannerImage coverImage{extraLarge} title{romaji english}}}}`, { q });
  return ((j.data && j.data.Page && j.data.Page.media) || []).map(m => ({ url: tipo === "banner" ? m.bannerImage : (m.coverImage && m.coverImage.extraLarge), nome: (m.title.english || m.title.romaji || "").trim(), fonte: "AniList" })).filter(x => okUrl(x.url));
}
async function imgKitsu(q, tipo) {
  const out = [];
  for (const t of ["manga", "anime"]) {
    const j = await httpJSON(`https://kitsu.app/api/edge/${t}?filter%5Btext%5D=${encodeURIComponent(q)}&page%5Blimit%5D=8`, { headers: { Accept: "application/vnd.api+json" } });
    for (const d of (j.data || [])) {
      const a = d.attributes || {}; if (a.nsfw) continue;
      const im = tipo === "banner" ? a.coverImage : a.posterImage;
      const url = im && (im.original || im.large);
      if (okUrl(url)) out.push({ url, nome: (a.canonicalTitle || "").trim(), fonte: "Kitsu" });
    }
  }
  return out;
}
async function imgMAL(q) {   // várias capas da mesma obra (volumes, edições)
  const j = await httpJSON(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(q)}&limit=3&sfw=true`);
  const out = [];
  for (const m of (j.data || []).slice(0, 2)) {
    const nome = (m.title_english || m.title || "").trim();
    const capa = m.images && m.images.jpg && m.images.jpg.large_image_url; if (okUrl(capa)) out.push({ url: capa, nome, fonte: "MyAnimeList" });
    try {
      const p = await httpJSON(`https://api.jikan.moe/v4/manga/${m.mal_id}/pictures`);
      for (const f of (p.data || [])) { const u = f.jpg && (f.jpg.large_image_url || f.jpg.image_url); if (okUrl(u)) out.push({ url: u, nome, fonte: "MyAnimeList" }); }
    } catch (e) {}
  }
  return out;
}
async function imgWallhaven(q, tipo) {   // só conteúdo seguro (purity=100), categoria anime
  const j = await httpJSON(`https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(q)}&categories=010&purity=100&sorting=relevance${tipo === "banner" ? "&atleast=1920x600" : ""}`);
  return (j.data || []).filter(w => w.purity === "sfw").filter(w => { const r = (w.dimension_x || 1) / (w.dimension_y || 1); return tipo === "banner" ? r >= 1.4 : r <= 0.85; })
    .filter(w => (w.dimension_x || 0) <= 4000).map(w => ({ url: w.path, thumb: w.thumbs && (w.thumbs.large || w.thumbs.small), nome: `${w.dimension_x}×${w.dimension_y}`, fonte: "Wallhaven", hd: (w.dimension_x || 0) >= 1920 }))
    .sort((a, b) => (b.hd ? 1 : 0) - (a.hd ? 1 : 0)).filter(x => okUrl(x.url));
}
// junta todas as fontes, sem repetir, intercalando para misturar
async function buscaImagens(q, tipo) {
  const tarefas = tipo === "banner" ? [imgAniList(q, "banner"), imgWallhaven(q, "banner"), imgKitsu(q, "banner")]
    : [imgAniList(q, "capa"), imgMAL(q), imgKitsu(q, "capa"), imgWallhaven(q, "capa")];
  const res = await Promise.allSettled(tarefas);
  const listas = res.filter(r => r.status === "fulfilled").map(r => r.value);
  if (!listas.length) throw new Error("falhou");
  const out = [], vistos = new Set();
  for (let i = 0; i < 40; i++) for (const l of listas) { const x = l[i]; if (x && !vistos.has(x.url)) { vistos.add(x.url); out.push(x); } }
  return tipo === "banner" ? out.sort((a, b) => (b.hd ? 1 : 0) - (a.hd ? 1 : 0)) : out;
}
// personagens (para a foto de perfil): os dos mangás da estante + busca por nome
async function personagensDaEstante() {
  const mal = [...new Set([...items.values()].map(it => it.catId).filter(k => /^mal\d+$/.test(k || "")).map(k => Number(k.slice(3))))].slice(0, 10);
  const al = [...new Set([...items.values()].map(it => it.catId).filter(k => /^al\d+$/.test(k || "")).map(k => Number(k.slice(2))))].slice(0, 10);
  if (!mal.length && !al.length) return [];
  const campos = `title{romaji english} characters(sort:[ROLE,FAVOURITES_DESC],perPage:8){nodes{name{full} image{large}}}`;
  const j = await AL(`query($m:[Int],$a:[Int]){m:Page(perPage:10){media(idMal_in:$m,type:MANGA){${campos}}} a:Page(perPage:10){media(id_in:$a){${campos}}}}`, { m: mal.length ? mal : [0], a: al.length ? al : [0] });
  const ms = [...((j.data && j.data.m && j.data.m.media) || []), ...((j.data && j.data.a && j.data.a.media) || [])];
  const out = [];
  for (const m of ms) for (const c of ((m.characters && m.characters.nodes) || [])) {
    const u = c.image && c.image.large; if (okUrl(u) && !/default\.jpg/.test(u)) out.push({ url: u, nome: c.name.full, obra: (m.title.english || m.title.romaji || "") });
  }
  return out;
}
async function buscaPersonagens(q) {
  const j = await AL(`query($q:String){Page(perPage:30){characters(search:$q,sort:FAVOURITES_DESC){name{full} image{large} media(perPage:1){nodes{title{romaji english}}}}}}`, { q });
  return ((j.data && j.data.Page && j.data.Page.characters) || []).map(c => ({ url: c.image && c.image.large, nome: c.name.full, obra: ((c.media && c.media.nodes && c.media.nodes[0] && c.media.nodes[0].title) || {}).romaji || "" })).filter(x => okUrl(x.url) && !/default\.jpg/.test(x.url));
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
    const w = Number(im.original && im.original.width) || 0;
    // versão em vídeo da melhor qualidade que existir (muito mais nítida que o .gif)
    const vids = [im["4k"], im.hd, im.original].map(v => v && v.mp4 ? { url: String(v.mp4).split("?")[0], w: Number(v.width) || 0 } : null).filter(v => v && /^https:\/\//.test(v.url) && v.w <= 3840);
    const vid = vids[0] || null, vw = vid ? vid.w : w;
    return { url: full.split("?")[0], thumb, fonte: "GIPHY", w: vw, video: vid ? vid.url : "", hd: vw >= 1000 };
  }).filter(g => /^https:\/\//.test(g.url));
}
async function buscaKlipy(q, key) {
  const cid = encodeURIComponent((currentUser && currentUser.uid) || "anon");
  const j = await httpJSON(`https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/search?q=${encodeURIComponent(q)}&per_page=24&page=1&customer_id=${cid}&locale=pt_BR&content_filter=medium`);
  const lista = (j.data && (j.data.data || j.data)) || [];
  return (Array.isArray(lista) ? lista : []).filter(g => g && g.file && g.type !== "ad").map(g => {
    const hdf = g.file.hd && (g.file.hd.mp4 || g.file.hd.gif || g.file.hd.webp); const w = Number(hdf && hdf.width) || 0;
    const mp4 = g.file.hd && g.file.hd.mp4 && g.file.hd.mp4.url;
    return { url: urlGif(g.file, ["hd", "md", "sm"]), thumb: urlGif(g.file, ["sm", "xs", "md"]), fonte: "KLIPY", w, video: typeof mp4 === "string" && /^https:\/\//.test(mp4) ? mp4 : "", hd: w >= 1000 };
  }).filter(g => g.url);
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
  return out.sort((a, b) => (b.hd ? 1 : 0) - (a.hd ? 1 : 0));   // alta resolução primeiro
}
const testaImagem = (u) => new Promise((res) => { const i = new Image(); i.referrerPolicy = "no-referrer"; const t = setTimeout(() => res(false), 12000); i.onload = () => { clearTimeout(t); res(i.naturalWidth > 0); }; i.onerror = () => { clearTimeout(t); res(false); }; i.src = u; });

function openVitrineEdit() {
  const p = myProfile || {};
  const d = { banner: safeBanner(p.banner), pos: posBanner(p.bannerPos), cor: CORES[p.cor] ? p.cor : "roxo", bio: String(p.bio || ""), favoritos: (p.favoritos || []).filter(id => items.has(id)).slice(0, 3) };
  const meus = [...items.values()].sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
  openModal(`
    <div class="mhead"><h2>✏️ Editar vitrine</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody vedit">
      <div class="sect vecapa">
        <div class="secth">Capa do perfil</div>
        <div class="vtban edit" id="veBan" style="--vt:${CORES[d.cor]}"></div>
        <div class="vemodo">
          <button type="button" class="btn" data-modo="cat">📚 Catálogo</button>
          <button type="button" class="btn" data-modo="gal">🖼️ Galeria</button>
          <button type="button" class="btn" data-modo="gif">🎞️ GIF</button>
        </div>
        <div id="vePainel"></div>
        <label class="vepos hidden" id="vePosL">Enquadramento <small>(arraste para escolher a parte da imagem que aparece)</small><input type="range" id="vePos" min="0" max="100" step="1"></label>
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
        <div class="secth">Mangás favoritos <small id="veFavN"></small></div>
        <p class="hint">Escolha até 3 mangás da sua estante. Você pode trocar quando quiser.</p>
        <div class="search" style="height:40px">🔍<input id="veFq" type="search" placeholder="Filtrar sua estante…" autocomplete="off"></div>
        <div id="veFavs" class="vefavs"></div>
      </div>
    </div>
    <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="button" class="btn primary" id="veSave">Salvar</button></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const ban = root.querySelector("#veBan"), painel = root.querySelector("#vePainel"), rm = root.querySelector("#veRm");
    setTimeout(() => carregarVerificador().catch(() => {}), 600);
    const showBan = () => {
      ban.style.setProperty("--vt", CORES[d.cor]);
      ban.innerHTML = d.banner ? midiaBanner(d.banner, d.pos) : `<span>Sem capa: fica na cor do perfil</span>`;
      rm.classList.toggle("hidden", !d.banner); root.querySelector("#vePosL").classList.toggle("hidden", !d.banner);
    };
    showBan();
    rm.onclick = () => { d.banner = ""; showBan(); };
    const posI = root.querySelector("#vePos"); posI.value = d.pos;
    posI.addEventListener("input", () => { d.pos = posBanner(posI.value); const im = ban.querySelector("img,video"); if (im) im.style.objectPosition = `50% ${d.pos}%`; });
    const modos = root.querySelectorAll("[data-modo]");
    const marca = (m) => modos.forEach(b => b.classList.toggle("on", b.dataset.modo === m));
    root.querySelector('[data-modo="cat"]').onclick = () => {
      marca("cat");
      const sug = (d.favoritos.map(id => items.get(id)).filter(Boolean)[0] || meus[0] || {}).title || "";
      painel.innerHTML = `<p class="hint">Imagens de AniList, Wallhaven e Kitsu. Busque pelo nome da obra ou do personagem e toque em uma.</p>
        <div class="urlrow"><input id="vbQ" placeholder="Nome da obra (ex.: Eleceed)" value="${esc(sug)}"><button type="button" class="btn" id="vbGo">Buscar</button></div>
        <div id="vbRes" class="vbres"></div>`;
      const q = painel.querySelector("#vbQ"), res = painel.querySelector("#vbRes");
      const buscar = async () => {
        const t = q.value.trim(); if (!t) return;
        if (!navigator.onLine) { res.innerHTML = `<p class="hint">📴 Sem internet.</p>`; return; }
        res.innerHTML = `<p class="hint">Buscando…</p>`;
        try {
          const l = await buscaImagens(t, "banner");
          res.innerHTML = l.length ? l.map(b => `<button type="button" class="vbopt" data-u="${esc(b.url)}" title="${esc(b.nome)}"><img src="${esc(b.thumb || b.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${b.hd ? `<i class="hdtag">HD</i>` : ""}<small>${esc(b.fonte)} · ${esc(b.nome)}</small></button>`).join("")
            : `<p class="hint">Nenhum banner encontrado para "${esc(t)}". Tente o nome em inglês ou japonês, ou use Galeria/GIF.</p>`;
          res.querySelectorAll("[data-u]").forEach(b => b.onclick = () => { d.banner = safeBanner(b.dataset.u); showBan(); res.querySelectorAll(".vbopt").forEach(x => x.classList.toggle("on", x === b)); });
        } catch (e) { res.innerHTML = `<p class="err">Não consegui buscar agora. Tente de novo.</p>`; }
      };
      painel.querySelector("#vbGo").onclick = buscar;
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscar(); } });
      if (sug) buscar();
    };
    root.querySelector('[data-modo="gal"]').onclick = () => {
      marca("gal"); painel.innerHTML = `<p class="hint">Escolha uma imagem do seu PC ou celular. Ela é cortada no formato de capa (bem larga, em alta resolução).</p>`;
      const f = $("#file"); f.value = "";
      f.onchange = async () => {
        if (!f.files[0]) return;
        painel.innerHTML = `<p class="hint">Preparando a imagem…</p>`;
        try {
          const larg = await new Promise(r => { const u = URL.createObjectURL(f.files[0]); const i = new Image(); i.onload = () => { r(i.naturalWidth); URL.revokeObjectURL(u); }; i.onerror = () => r(0); i.src = u; });
          d.banner = await bannerDaGaleria(f.files[0]); showBan();
          painel.innerHTML = larg && larg < PC_LARG ? `<p class="hint">⚠️ Essa imagem tem ${larg} px de largura: no celular fica boa, mas no PC pode ficar borrada. Para ficar nítida em telas grandes, use uma com ${PC_LARG} px ou mais (o Wallhaven, no Catálogo, tem várias).</p>` : `<p class="hint">✅ Imagem pronta (${larg} px). Toque em Salvar.</p>`;
        }
        catch (e) { painel.innerHTML = `<p class="err">Não consegui usar essa imagem. Tente outra.</p>`; }
      };
      f.click();
    };
    root.querySelector('[data-modo="gif"]').onclick = () => {
      marca("gif");
      const busca = temBuscaGif();
      painel.innerHTML = `${busca ? `<div class="urlrow"><input id="vgQ" placeholder="Buscar GIF (ex.: solo leveling)" autocomplete="off"><button type="button" class="btn" id="vgBusca">Buscar</button></div>
        <label class="sohd"><input type="checkbox" id="vgHD" ${window.innerWidth >= 1100 ? "checked" : ""}> Mostrar só os de alta qualidade (ficam nítidos no PC)</label>
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
            const todos = await buscaGifs(t);
            const soHD = painel.querySelector("#vgHD").checked;
            const l = soHD ? todos.filter(g => g.w >= PC_LARG * 0.7) : todos;
            res.innerHTML = l.length ? l.map(g => `<button type="button" class="vgopt" data-u="${esc(g.video || g.url)}" title="${esc(g.fonte)} · ${g.w || "?"} px"><img src="${esc(g.thumb || g.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${g.w >= PC_LARG * 0.7 ? `<i class="hdtag">HD</i>` : `<i class="hdtag peq">⚠️ pequena p/ PC</i>`}</button>`).join("")
              : `<p class="hint">${todos.length && soHD ? `Nenhum GIF em alta qualidade para "${esc(t)}". Desmarque "só alta qualidade" para ver todos, ou tente outro nome.` : `Nenhum GIF encontrado para "${esc(t)}". Tente em inglês (ex.: "solo leveling anime").`}</p>`;
            res.querySelectorAll("[data-u]").forEach(b => b.onclick = () => {
              const u = safeBanner(b.dataset.u); if (!u || u.startsWith("data:")) return;
              d.banner = u; showBan(); res.querySelectorAll(".vgopt").forEach(x => x.classList.toggle("on", x === b));
            });
          } catch (e) { res.innerHTML = `<p class="err">Não consegui buscar agora (o limite de buscas por hora pode ter acabado). Tente daqui a pouco ou cole um link.</p>`; }
        };
        painel.querySelector("#vgBusca").onclick = buscar;
        painel.querySelector("#vgHD").onchange = buscar;
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
      const patch = { banner: d.banner, bannerPos: d.pos, cor: d.cor, bio: texto, favoritos: d.favoritos.slice(0, 3) };
      if (d.banner && d.banner !== safeBanner(p.banner)) {
        const sb = root.querySelector("#veSave"); sb.disabled = true; sb.textContent = "Verificando a imagem…";
        const r = await verificarImagem(d.banner);
        sb.disabled = false; sb.textContent = "Salvar";
        if (r === "adulto") { toast("Essa imagem parece ter conteúdo adulto e não pode ser usada na vitrine (todos veem). Escolha outra.", 6000); return; }
      }
      try {
        await setDoc(doc(db, "perfis", currentUser.uid), perfilData(patch));
        myProfile = { ...myProfile, ...patch };
        toast("Vitrine salva!"); openPeople("perfil");
      } catch (x) {
        toast(x.code === "permission-denied" ? "O servidor recusou. As regras novas do Firebase ainda não foram publicadas." : (x.code === "invalid-argument" ? "A imagem da capa ficou grande demais. Tente outra." : "Não foi possível salvar agora. Verifique a internet."), 5000);
      }
    };
  }, { wide: true });
}

function openFotoEdit() {
  const p = myProfile || {};
  let foto = safeFoto(p.foto);
  openModal(`
    <div class="mhead"><h2>📷 Foto de perfil</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody vedit vfoto">
      <div class="sect vecapa">
        <div class="fotoprev" id="fpPrev"></div>
        <div class="vemodo">
          <button type="button" class="btn" data-fm="gal">🖼️ Galeria</button>
          <button type="button" class="btn" data-fm="per">👤 Personagens</button>
          <button type="button" class="btn" data-fm="gif">🎞️ GIF</button>
        </div>
        <button type="button" class="btn ghost" id="fpRm">Remover foto</button>
      </div>
      <div class="sect"><div id="fpPainel"><p class="hint">Escolha de onde vem a foto: da sua galeria, de um personagem ou de um GIF animado.</p></div></div>
    </div>
    <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="button" class="btn primary" id="fpSave">Salvar</button></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const prev = root.querySelector("#fpPrev"), painel = root.querySelector("#fpPainel");
    setTimeout(() => carregarVerificador().catch(() => {}), 600);
    const mostra = () => { prev.innerHTML = avatarHTML(foto, p.apelido, "huge"); root.querySelector("#fpRm").classList.toggle("hidden", !foto); };
    mostra();
    root.querySelector("#fpRm").onclick = () => { foto = ""; mostra(); };
    const modos = root.querySelectorAll("[data-fm]"); const marca = (m) => modos.forEach(b => b.classList.toggle("on", b.dataset.fm === m));
    const grade = (lista, cls) => lista.map(x => `<button type="button" class="${cls}" data-u="${esc(x.url)}" title="${esc(x.nome || "")}"><img src="${esc(x.thumb || x.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${x.hd ? `<i class="hdtag">HD</i>` : ""}${x.nome ? `<small>${esc(x.nome)}</small>` : ""}</button>`).join("");
    const ligar = (res) => res.querySelectorAll("[data-u]").forEach(b => b.onclick = () => { const u = safeFoto(b.dataset.u); if (!u) return; foto = u; mostra(); res.querySelectorAll("[data-u]").forEach(x => x.classList.toggle("on", x === b)); });
    const busca = (ph, fn, cls, inicial) => {
      painel.innerHTML = `<div class="urlrow"><input id="fpQ" placeholder="${esc(ph)}" autocomplete="off"><button type="button" class="btn" id="fpGo">Buscar</button></div><div id="fpRes" class="fpres"></div>`;
      const q = painel.querySelector("#fpQ"), res = painel.querySelector("#fpRes");
      const go = async (txt) => {
        if (!navigator.onLine) { res.innerHTML = `<p class="hint">📴 Sem internet.</p>`; return; }
        res.innerHTML = `<p class="hint">Buscando…</p>`;
        try { const l = await fn(txt); res.innerHTML = l.length ? grade(l, cls) : `<p class="hint">Nada encontrado. Tente outro nome (em inglês costuma achar mais).</p>`; ligar(res); }
        catch (e) { res.innerHTML = `<p class="err">Não consegui buscar agora. Tente de novo daqui a pouco.</p>`; }
      };
      painel.querySelector("#fpGo").onclick = () => { const t = q.value.trim(); if (t) go(t); else q.focus(); };
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); painel.querySelector("#fpGo").click(); } });
      if (inicial) inicial(res, go);
    };
    root.querySelector('[data-fm="gal"]').onclick = () => {
      marca("gal"); painel.innerHTML = `<p class="hint">Escolha uma foto do seu PC ou celular. Ela é cortada em círculo.</p>`;
      const f = $("#file"); f.value = "";
      f.onchange = async () => { if (!f.files[0]) return; try { foto = await imageToAvatar(f.files[0]); mostra(); painel.innerHTML = `<p class="hint">✅ Foto pronta. Toque em Salvar.</p>`; } catch (e) { painel.innerHTML = `<p class="err">Não consegui usar essa imagem.</p>`; } };
      f.click();
    };
    root.querySelector('[data-fm="per"]').onclick = () => {
      marca("per");
      busca("Nome do personagem (ex.: Sung Jinwoo, Luffy)", buscaPersonagens, "fpopt", async (res) => {
        res.innerHTML = `<p class="hint">Carregando personagens dos mangás da sua estante…</p>`;
        try {
          const l = await personagensDaEstante();
          res.innerHTML = l.length ? `<p class="hint fpsub">Dos mangás da sua estante:</p>${grade(l, "fpopt")}` : `<p class="hint">Busque pelo nome do personagem. (Para sugestões automáticas, vincule seus mangás ao catálogo.)</p>`;
          ligar(res);
        } catch (e) { res.innerHTML = `<p class="hint">Busque pelo nome do personagem.</p>`; }
      });
    };
    root.querySelector('[data-fm="gif"]').onclick = () => {
      marca("gif");
      if (!temBuscaGif()) { painel.innerHTML = `<p class="hint">A busca de GIF não está disponível nesta versão.</p>`; return; }
      busca("Buscar GIF (ex.: sung jinwoo)", buscaGifs, "fpopt gif", null);
      painel.insertAdjacentHTML("beforeend", `<p class="vgcred">GIFs: Powered by GIPHY · KLIPY</p>`);
    };
    root.querySelector("#fpSave").onclick = async () => {
      if (foto && foto !== safeFoto(p.foto)) {
        const sb = root.querySelector("#fpSave"); sb.disabled = true; sb.textContent = "Verificando a foto…";
        const r = await verificarImagem(foto);
        sb.disabled = false; sb.textContent = "Salvar";
        if (r === "adulto") { toast("Essa foto parece ter conteúdo adulto e não pode ser usada no perfil (todos veem). Escolha outra.", 6000); return; }
      }
      try { await setDoc(doc(db, "perfis", currentUser.uid), perfilData({ foto })); myProfile = { ...myProfile, foto }; updateMeBtn(); toast("Foto atualizada!"); openPeople("perfil"); }
      catch (x) { toast("Não foi possível salvar a foto. Verifique a internet.", 4000); }
    };
  }, { wide: true });
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

// ---------- denúncias ----------
const MOTIVOS_DEN = { capa: "Capa imprópria (conteúdo adulto ou violento)", nome: "Nome ofensivo", comentario: "Comentário ofensivo", spam: "Spam ou propaganda", outro: "Outro motivo" };
function openDenuncia(visit, mid, it) {
  openModal(`
    <form id="denF">
      <div class="mhead"><h2>🚩 Denunciar</h2><button type="button" class="icon-btn" data-x>✕</button></div>
      <div class="mbody">
        <p class="hint" style="margin-top:0">Denunciando <b>${esc(it.title)}</b> na estante de <b>@${esc(visit.apelido)}</b>. A pessoa não fica sabendo quem denunciou.</p>
        <div class="menu-list">${Object.entries(MOTIVOS_DEN).map(([k, v], i) => `<label class="chk"><input type="radio" name="m" value="${k}" ${i ? "" : "checked"}> <span>${v}</span></label>`).join("")}</div>
        <label class="f">Detalhes (opcional)<textarea name="t" maxlength="300" rows="3" placeholder="Conte o que está errado."></textarea></label>
      </div>
      <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Cancelar</button><button type="submit" class="btn primary">Enviar denúncia</button></div>
    </form>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelector("#denF").addEventListener("submit", async (e) => {
      e.preventDefault();
      const me = currentUser.uid, sb = e.target.querySelector("[type=submit]"); sb.disabled = true;
      const den = { de: me, apelidoDe: String((myProfile && myProfile.apelido) || "").slice(0, 30), alvo: visit.uid, alvoApelido: String(visit.apelido || "").slice(0, 30),
        mangaId: mid, titulo: String(it.title || "").slice(0, 120), motivo: e.target.m.value, texto: e.target.t.value.trim().slice(0, 300), criadoEm: Date.now(), resolvido: false };
      try { await setDoc(doc(db, "denuncias", `${me}_${visit.uid}_${mid}`), den); closeModal(); toast("Denúncia enviada. Obrigado por ajudar a manter a comunidade legal! 🙌", 4000); }
      catch (x) { sb.disabled = false; toast(x.code === "permission-denied" ? "Você já denunciou este mangá. Ele está em análise." : "Não foi possível enviar agora. Verifique a internet.", 4500); }
    });
  });
}
function openDenuncias() {
  let un = null;
  openModal(`
    <div class="mhead"><h2>🚩 Denúncias</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody"><div id="dlist" class="menu-list"><div class="hint">Carregando…</div></div></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const dl = root.querySelector("#dlist");
    let lista = [];
    un = onSnapshot(collection(db, "denuncias"), (snap) => {
      lista = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.resolvido - b.resolvido) || (b.criadoEm || 0) - (a.criadoEm || 0));
      // quantas pessoas denunciaram o mesmo mangá
      const conta = {}; lista.forEach(r => { const k = r.alvo + "/" + r.mangaId; conta[k] = (conta[k] || 0) + (r.resolvido ? 0 : 1); });
      dl.innerHTML = lista.length ? lista.map(r => r.tipo === "forum" ? `
        <div class="report ${r.resolvido ? "done" : ""}" data-id="${esc(r.id)}">
          <div class="rmeta">${r.resolvido ? "✅" : "🚩"} <b>Fórum · ${esc(nomeSala(r.sala))}</b> · mensagem de <b>@${esc(r.alvoApelido || "?")}</b>${!r.resolvido && conta[r.alvo + "/" + r.mangaId] > 1 ? ` · <b style="color:var(--red)">${conta[r.alvo + "/" + r.mangaId]} denúncias</b>` : ""}</div>
          <div class="rmeta">${esc(MOTIVOS_FORUM[r.motivo] || MOTIVOS_DEN[r.motivo] || r.motivo)} · por @${esc(r.apelidoDe || "?")} · ${new Date(r.criadoEm || 0).toLocaleString("pt-BR")}</div>
          ${r.trecho ? `<div class="rtext">“${esc(r.trecho)}”</div>` : ""}${r.texto ? `<div class="rtext">${esc(r.texto)}</div>` : ""}
          <div class="ract"><button class="mini" data-r="apmsg">Apagar mensagem</button><span class="silwrap"><button class="mini" data-r="sil">Silenciar ▾</button></span>${r.resolvido ? "" : `<button class="mini" data-r="ok">✓ Resolvido</button>`}<button class="mini" data-r="del" style="color:var(--red)">Apagar</button></div>
        </div>` : `
        <div class="report ${r.resolvido ? "done" : ""}" data-id="${esc(r.id)}">
          <div class="rmeta">${r.resolvido ? "✅" : "🚩"} <b>${esc(r.titulo)}</b> · estante de <b>@${esc(r.alvoApelido || "?")}</b>${!r.resolvido && conta[r.alvo + "/" + r.mangaId] > 1 ? ` · <b style="color:var(--red)">${conta[r.alvo + "/" + r.mangaId]} denúncias</b>` : ""}</div>
          <div class="rmeta">${esc(MOTIVOS_DEN[r.motivo] || r.motivo)} · por @${esc(r.apelidoDe || "?")} · ${new Date(r.criadoEm || 0).toLocaleString("pt-BR")}</div>
          ${r.texto ? `<div class="rtext">${esc(r.texto)}</div>` : ""}
          <div class="ract"><button class="mini" data-r="ver">Ver estante</button>${r.resolvido ? "" : `<button class="mini" data-r="ok">✓ Resolvido</button>`}<button class="mini" data-r="del" style="color:var(--red)">Apagar</button></div>
        </div>`).join("") : `<div class="hint">Nenhuma denúncia. 🎉</div>`;
    }, () => { dl.innerHTML = `<div class="err">Sem permissão para ver as denúncias.</div>`; });
    dl.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-r]"); if (!b) return;
      const id = b.closest("[data-id]").dataset.id, r = lista.find(x => x.id === id); if (!r) return;
      try {
        if (b.dataset.r === "ver") { openVisit(r.alvo, r.alvoApelido, ""); return; }
        if (b.dataset.r === "apmsg") {
          if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Apagar mesmo?"; return; }
          await updateDoc(doc(db, "forum", r.sala, "msgs", r.msgId), { apagada: true, texto: "", gif: deleteField() });
          await updateDoc(doc(db, "denuncias", id), { resolvido: true }).catch(() => {});
          toast("Mensagem apagada."); return;
        }
        if (b.dataset.r === "sil") {
          const w = b.closest(".silwrap"); const aberto = w.querySelector(".silmenu");
          dl.querySelectorAll(".silmenu").forEach(x => x.remove()); if (aberto) return;
          w.insertAdjacentHTML("beforeend", `<div class="silmenu">${[["5 minutos", 5], ["1 hora", 60], ["24 horas", 1440], ["7 dias", 10080]].map(([l, m]) => `<button class="mini" data-r="silt" data-min="${m}">${l}</button>`).join("")}<button class="mini" data-r="silt" data-min="0">Tirar silêncio</button></div>`);
          return;
        }
        if (b.dataset.r === "silt") {
          const min = Number(b.dataset.min);
          await setDoc(doc(db, "forumUsers", r.alvo), { silenciadoAte: min ? new Date(Date.now() + min * 60e3) : deleteField() }, { merge: true });
          dl.querySelectorAll(".silmenu").forEach(x => x.remove());
          toast(min ? `@${r.alvoApelido} silenciado por ${b.textContent}.` : `@${r.alvoApelido} pode escrever de novo.`, 3500); return;
        }
        if (b.dataset.r === "ok") await updateDoc(doc(db, "denuncias", id), { resolvido: true });
        else { if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Apagar?"; return; } await deleteDoc(doc(db, "denuncias", id)); }
      } catch (x) { toast("Não foi possível alterar."); }
    });
    return () => { if (un) un(); };
  });
}

// aviso do card: explica o problema e leva ao editor
function avisoCard(id, tipo) {
  const it = items.get(id); if (!it) return;
  const img = tipo === "warnimg";
  openModal(`
    <div class="mhead"><h2>⚠️ ${img ? "Capa com problema" : "Link com problema"}</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody"><p style="margin:0;line-height:1.5">${img
      ? `A imagem da capa de <b>${esc(it.title)}</b> não abriu. O site de onde ela veio pode ter tirado a imagem do ar. Troque por outra (galeria, link ou “Buscar imagem”).`
      : `O link de <b>${esc(it.title)}</b> não está funcionando há pelo menos 2 dias: a página não existe mais ou o site não responde. Confira o endereço e coloque o link novo.`}</p>
      ${img ? "" : `<p class="hint" style="margin:8px 0 0">Link atual: ${esc(fixLink(it.link))}</p>`}</div>
    <div class="mfoot"><span class="grow"></span><button type="button" class="btn ghost" data-x>Agora não</button><button type="button" class="btn primary" id="avGo">${img ? "Trocar capa" : "Editar link"}</button></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    root.querySelector("#avGo").onclick = () => {
      openEditor(id);
      setTimeout(() => { const el = document.querySelector(img ? ".cover-edit" : '#ed [name="link"]'); if (el) { el.scrollIntoView({ block: "center" }); if (!img) el.focus(); } }, 120);
    };
  });
}

// ---------- eventos ----------
$("#grid").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  const act = btn.dataset.act;
  if (ui.visit) {                       // estante de outra pessoa: só ver detalhes e abrir o site
    const cv = btn.closest(".cover");
    if (cv && cv.classList.contains("borrado")) { e.preventDefault(); cv.classList.remove("borrado"); return; }   // 18+: primeiro toque revela
    if (act === "info") { e.preventDefault(); openInfo(id); }
    return;
  }
  const it = items.get(id); if (!it) return;
  const c = Number(it.chapter) || 0;
  if (act === "read") { markSeen(id); return; }
  if (act === "info") { e.preventDefault(); openInfo(id); return; }
  if (act === "warnimg" || act === "warnlink") { e.preventDefault(); e.stopPropagation(); avisoCard(id, act); return; }
  if (act === "vis") { e.preventDefault(); trocarPrivado(id, !it.privado); return; }
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
// ---------- Aparência (por aparelho): cards por linha, tamanho do texto e tema ----------
const APAR_KEY = "estante-aparencia-v1";
const APAR = { pc: [4, 6, 8, 12], cel: [2, 3, 4, 5], texto: { normal: ["Normal", 1], grande: ["Grande", 1.15], extra: ["Extra grande", 1.3] }, tema: { sistema: "Do sistema", claro: "Claro", escuro: "Escuro" } };
let apar = {};
try { apar = JSON.parse(localStorage.getItem(APAR_KEY) || "{}") || {}; } catch (e) { apar = {}; }
const modoTela = () => window.matchMedia("(max-width: 520px)").matches ? "cel" : "pc";
function aplicarAparencia() {
  const h = document.documentElement, modo = modoTela();
  const cols = modo === "cel" ? apar.colsCel : apar.colsPC;
  if (cols && APAR[modo].includes(cols)) { h.dataset.cols = cols; h.style.setProperty("--cols", cols); }
  else { delete h.dataset.cols; h.style.removeProperty("--cols"); }
  // cards bem pequenos: esconde o rodapé e compacta (celular 4-5, PC 12)
  h.classList.toggle("dens-alta", !!cols && ((modo === "cel" && cols >= 4) || (modo === "pc" && cols >= 12)));
  const z = (APAR.texto[apar.texto] || APAR.texto.normal)[1];
  document.body.style.zoom = z === 1 ? "" : String(z);
  // alguns navegadores aumentam também a altura "100vh" com o zoom: mede e compensa só quando precisa
  let fator = 1;
  if (z !== 1) { const pr = document.createElement("div"); pr.style.cssText = "position:fixed;top:0;left:0;width:1px;height:100vh;visibility:hidden"; document.body.appendChild(pr); const alt = pr.getBoundingClientRect().height; pr.remove(); if (alt > window.innerHeight * 1.05) fator = z; }
  h.style.setProperty("--z", String(fator));
  if (apar.tema === "claro" || apar.tema === "escuro") h.dataset.tema = apar.tema; else delete h.dataset.tema;
}
const salvarAparencia = () => { try { localStorage.setItem(APAR_KEY, JSON.stringify(apar)); } catch (e) {} aplicarAparencia(); };
aplicarAparencia();
window.matchMedia("(max-width: 520px)").addEventListener("change", aplicarAparencia);
function openAparencia() {
  const modo = modoTela(), chaveCols = modo === "cel" ? "colsCel" : "colsPC", padrao = modo === "cel" ? 3 : 6;
  openModal(`
    <div class="mhead"><h2>Aparência</h2><button type="button" class="icon-btn" data-x>✕</button></div>
    <div class="mbody apar">
      <p class="hint" style="margin:0">Vale só para este aparelho. A estante muda na hora.</p>
      <div class="sect"><div class="secth">Mangás por linha</div>
        <div class="aparopts" data-k="cols">${APAR[modo].map(n => `<button type="button" class="aparopt" data-v="${n}"><span class="aparmini" style="--n:${Math.min(n, 6)}">${"<i></i>".repeat(Math.min(n, 6))}</span>${n}${n === padrao ? " <small>(padrão)</small>" : ""}</button>`).join("")}</div></div>
      <div class="sect"><div class="secth">Tamanho do texto</div>
        <div class="aparopts" data-k="texto">${Object.entries(APAR.texto).map(([k, v]) => `<button type="button" class="aparopt" data-v="${k}"><span style="font-size:${Math.round(14 * v[1])}px;font-weight:900">Aa</span> ${v[0]}</button>`).join("")}</div></div>
      <div class="sect"><div class="secth">Abertura ao abrir o app</div>
        <div class="aparopts" data-k="abertura"><button type="button" class="aparopt" data-v="on">Ligada</button><button type="button" class="aparopt" data-v="off">Desligada</button></div></div>
      <div class="sect"><div class="secth">Som da abertura</div>
        <div class="aparopts" data-k="aberturaSom"><button type="button" class="aparopt" data-v="on">Ligado</button><button type="button" class="aparopt" data-v="off">Desligado</button></div></div>
      <div class="sect"><div class="secth">Tema</div>
        <div class="aparopts" data-k="tema">${Object.entries(APAR.tema).map(([k, v]) => `<button type="button" class="aparopt" data-v="${k}">${k === "claro" ? "☀️" : k === "escuro" ? "🌙" : "📱"} ${v}</button>`).join("")}</div></div>
    </div>
    <div class="mfoot"><button type="button" class="btn ghost" id="aparReset">Voltar ao padrão</button><span class="grow"></span><button type="button" class="btn primary" data-x>Pronto</button></div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const marca = () => {
      const atual = { cols: String(apar[chaveCols] || padrao), texto: apar.texto || "normal", tema: apar.tema || "sistema", abertura: apar.abertura || "on", aberturaSom: apar.aberturaSom || "on" };
      root.querySelectorAll(".aparopts").forEach(g => g.querySelectorAll(".aparopt").forEach(b => b.classList.toggle("on", b.dataset.v === atual[g.dataset.k])));
    };
    root.querySelectorAll(".aparopts").forEach(g => g.querySelectorAll(".aparopt").forEach(b => b.onclick = () => {
      const k = g.dataset.k, v = b.dataset.v;
      if (k === "cols") apar[chaveCols] = Number(v); else apar[k] = v;
      salvarAparencia(); marca();
    }));
    root.querySelector("#aparReset").onclick = () => { apar = {}; salvarAparencia(); marca(); };
    marca();
  });
}
$("#aparBtn").addEventListener("click", openAparencia);
// No PC (tela larga), a busca e a ordenação sobem para a barra do logo; no celular ficam embaixo
(function posicionaBusca() {
  const mq = window.matchMedia("(min-width: 1100px)");
  const row = document.querySelector(".tools .row") || document.querySelector(".bar .row");
  const ajusta = () => {
    if (!row) return;
    if (mq.matches) { const sp = document.querySelector(".bar .spacer"); if (row.parentElement !== sp.parentElement) sp.replaceWith(row); row.classList.add("toprow"); }
    else if (row.classList.contains("toprow")) { const sp = document.createElement("div"); sp.className = "spacer"; row.replaceWith(sp); document.querySelector(".tools").prepend(row); row.classList.remove("toprow"); }
  };
  ajusta(); (mq.addEventListener ? mq.addEventListener("change", ajusta) : mq.addListener(ajusta));
})();
$("#bellBtn").addEventListener("click", openBell);
$("#lupaBtn").addEventListener("click", openLupa);
$("#visitBack").addEventListener("click", closeVisit);
window.addEventListener("beforeunload", (e) => { if (pending.size) { for (const id of [...pending.keys()]) { clearTimeout(pending.get(id)); flush(id); } } });
document.addEventListener("visibilitychange", () => { if (document.hidden) for (const id of [...pending.keys()]) { clearTimeout(pending.get(id)); flush(id); } else render(); });

