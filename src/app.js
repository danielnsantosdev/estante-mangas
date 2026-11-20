// Estante de Mangás — app (Android/Windows) com Firebase: login por e-mail/senha + Firestore
import { initializeApp } from "firebase/app";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, onAuthStateChanged, signOut, reload,
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, setDoc, deleteDoc, onSnapshot, writeBatch,
  terminate, clearIndexedDbPersistence,
} from "firebase/firestore";
import { firebaseConfig, adminEmail, downloadUrl } from "./firebase-config.js";

const STATUS = {
  lendo:      { label: "Lendo" },
  acumulando: { label: "Acumulando caps" },
  pausado:    { label: "Pausado" },
  concluido:  { label: "Concluído" },
};
const $ = (s) => document.querySelector(s);
const show = (id) => ["setupScreen", "loginScreen", "verifyScreen", "deniedScreen", "appScreen"].forEach(x => $("#" + x).classList.toggle("hidden", x !== id));

let items = new Map();          // id -> mangá
const pending = new Map();      // id -> timer (alterações ainda não enviadas)
let col = null, unsub = null, loaded = false, currentUser = null;
let netState = { pendingWrites: false, fromCache: true };
let savedSort = "recent"; try { savedSort = localStorage.getItem("estante-sort") || "recent"; } catch (e) {}
const ui = { filter: "todos", q: "", sort: savedSort };
$("#sort").value = ui.sort;

// ---------- utilidades ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fmtCap = (n) => { n = Number(n) || 0; return Number.isInteger(n) ? String(n) : String(n).replace(".", ","); };
const parseCap = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0; };
function relTime(ms) {
  if (!ms) return "";
  const d = (Date.now() - ms) / 86400000;
  if (d < 1) return "lido hoje";
  if (d < 2) return "lido ontem";
  if (d < 30) return `lido há ${Math.floor(d)} dias`;
  const m = Math.floor(d / 30.4);
  if (m < 12) return m === 1 ? "lido há 1 mês" : `lido há ${m} meses`;
  const y = Math.floor(d / 365);
  return y === 1 ? "lido há 1 ano" : `lido há ${y} anos`;
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
    try { invited = email ? (await getDoc(doc(db, "convidados", email))).exists() : false; }
    catch (e) { invited = (e.code === "unavailable") ? null : false; } // sem internet: abre com o que está no aparelho
  }
  if (currentUser !== user) return;
  if (invited === false) { $("#deniedEmail").textContent = email || "(sem e-mail)"; show("deniedScreen"); return; }
  show("appScreen");
  startSync(user.uid);
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
    chapter: Math.min(99999, parseCap(it.chapter)),
    status: STATUS[it.status] ? it.status : "lendo",
    link: fixLink(it.link).slice(0, 2000),
    cover: safeCover(it.cover),
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
    else if (e.code === "permission-denied") toast("Sem permissão para salvar. Confira as regras do Firestore.", 4000);
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
function remove(id) { items.delete(id); render(); scheduleWrite(id, 0); }

// ---------- renderização ----------
function filtered() {
  const q = norm(ui.q);
  const arr = [...items.values()].filter(it => (ui.filter === "todos" || it.status === ui.filter) && (!q || norm(it.title).includes(q)));
  if (ui.sort === "name") arr.sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
  else if (ui.sort === "stale") arr.sort((a, b) => (a.lastReadAt || 0) - (b.lastReadAt || 0));
  else arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return arr;
}
function renderChips() {
  const counts = { todos: items.size };
  for (const k in STATUS) counts[k] = 0;
  for (const it of items.values()) if (counts[it.status] != null) counts[it.status]++;
  $("#chips").innerHTML = ["todos", ...Object.keys(STATUS)].map(k =>
    `<button class="chip ${ui.filter === k ? "on" : ""}" data-f="${k}">${k === "todos" ? "Todos" : STATUS[k].label}<span class="n">${counts[k]}</span></button>`).join("");
}
function phHTML(title, size) {
  const initials = esc((title || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase());
  return `<div class="ph"><span${size ? ` style="font-size:${size}px"` : ""}>${initials || "?"}</span></div>`;
}
function cardHTML(it) {
  const st = STATUS[it.status] ? it.status : "lendo";
  const cv = safeCover(it.cover), lk = fixLink(it.link);
  const cover = cv ? `<img src="${esc(cv)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback>` : phHTML(it.title);
  const days = it.lastReadAt ? (Date.now() - it.lastReadAt) / 86400000 : 0;
  const old = days > 60 && st !== "concluido";
  const link = lk ? `<a class="mini read" href="${esc(lk)}" target="_blank" rel="noopener noreferrer" title="Abrir site">Ler ↗</a>` : "";
  return `<article class="card" data-id="${esc(it.id)}">
    <div class="cover" data-act="edit">${cover}<span class="badge s-${st}"><i></i>${STATUS[st].label}</span></div>
    <div class="body">
      <div class="title" title="${esc(it.title)}">${esc(it.title)}</div>
      <div class="chap">
        <button data-act="minus" aria-label="Capítulo anterior">−</button>
        <button class="num" data-act="goto" aria-label="Definir capítulo"><small>CAPÍTULO</small><b>${fmtCap(it.chapter)}</b></button>
        <button class="plus" data-act="plus" aria-label="Próximo capítulo">+</button>
      </div>
      <div class="foot"><span class="when ${old ? "old" : ""}">${relTime(it.lastReadAt)}</span>${link}<button class="mini" data-act="edit" title="Editar">✎</button></div>
    </div>
  </article>`;
}
function render() {
  if (!currentUser) return;
  renderChips();
  const grid = $("#grid"), empty = $("#empty");
  if (!loaded) { grid.innerHTML = ""; empty.innerHTML = `<div class="loading">Carregando sua estante…</div>`; return; }
  const arr = filtered();
  grid.innerHTML = arr.map(cardHTML).join("");
  grid.querySelectorAll("img[data-fallback]").forEach(img => img.addEventListener("error", () => {
    const card = img.closest(".card"); const it = card && items.get(card.dataset.id);
    img.outerHTML = phHTML(it ? it.title : "?");
  }, { once: true }));
  if (!items.size) empty.innerHTML = `<div class="empty"><div class="big">Estante vazia!</div><p>Adicione o primeiro mangá que você está lendo — nome, capítulo e, se quiser, uma capa.</p><button class="btn primary" id="emptyAdd">+ Adicionar mangá</button></div>`;
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
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const W = 360, H = 480;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const r = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * r, h = img.naturalHeight * r;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    return c.toDataURL("image/jpeg", 0.82);
  } finally { URL.revokeObjectURL(url); }
}

function openEditor(id) {
  const it = id ? items.get(id) : null;
  let cover = it ? it.cover || "" : "";
  let confirmDel = false;
  const opts = Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(it ? it.status : "lendo") === k ? "selected" : ""}>${v.label}</option>`).join("");
  openModal(`
    <form id="ed" autocomplete="off">
      <div class="mhead"><h2>${it ? "Editar mangá" : "Novo mangá"}</h2><button type="button" class="icon-btn" data-x>✕</button></div>
      <div class="mbody">
        <label class="f">Nome<input name="title" required maxlength="120" placeholder="Ex.: One Piece" value="${esc(it ? it.title : "")}"></label>
        <div class="two">
          <label class="f">Último capítulo lido<input name="chapter" inputmode="decimal" placeholder="0" value="${it ? fmtCap(it.chapter) : ""}"></label>
          <label class="f">Status<select name="status">${opts}</select></label>
        </div>
        <label class="f">Link do site onde você lê <span style="font-weight:500;color:var(--muted)">(opcional)</span><input name="link" inputmode="url" placeholder="https://…" value="${esc(it ? it.link || "" : "")}"></label>
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
      remove(id); closeModal(); toast("Mangá excluído.");
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
      const data = { title, chapter, status: String(fd.get("status")), link, cover };
      if (it) {
        const patch = { ...data };
        if (chapter !== (Number(it.chapter) || 0)) patch.lastReadAt = Date.now();
        commit(id, patch); toast("Salvo!");
      } else { create(data); toast("Adicionado à estante!"); }
      closeModal();
    });
    if (!it) setTimeout(() => titleInput.focus(), 50);
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
        ${isAdmin(u) ? `<button class="btn primary" id="mAdmin">👑 Administrador — quem pode usar</button>` : ""}
        <button class="btn" id="mExport">💾 ${isNativeApp ? "Copiar backup" : "Baixar backup (arquivo .json)"}</button>
        <button class="btn" id="mImport">📂 Restaurar backup</button>
        <button class="btn danger" id="mOut">Sair da conta (apaga a cópia deste aparelho)</button>
      </div>
      <p class="hint">Seus mangás ficam salvos na sua conta e sincronizam entre todos os aparelhos em que você entrar. Sem internet, o app continua funcionando e envia as mudanças depois.</p>
    </div>`, (root) => {
    root.querySelectorAll("[data-x]").forEach(b => b.onclick = closeModal);
    const ab = root.querySelector("#mAdmin"); if (ab) ab.onclick = openAdmin;
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
      <p class="hint" style="font-size:13.5px">Só os e-mails desta lista conseguem usar o app (você sempre consegue). Cada pessoa vê apenas a própria estante.</p>
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
      try { await deleteDoc(doc(db, "convidados", email)); toast("Acesso removido."); } catch (x) { toast("Não foi possível remover."); }
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
// ---------- eventos ----------
$("#grid").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const id = btn.closest(".card").dataset.id; const it = items.get(id); if (!it) return;
  const act = btn.dataset.act; const c = Number(it.chapter) || 0;
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
window.addEventListener("beforeunload", (e) => { if (pending.size) { for (const id of [...pending.keys()]) { clearTimeout(pending.get(id)); flush(id); } } });
document.addEventListener("visibilitychange", () => { if (document.hidden) for (const id of [...pending.keys()]) { clearTimeout(pending.get(id)); flush(id); } else render(); });

