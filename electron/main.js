// Janela do app no Windows (Electron)
const { app, BrowserWindow, shell, Menu, ipcMain, net } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// Abre links sempre no Google Chrome (se estiver instalado); senão, no navegador padrão.
function chromePath() {
  const bases = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
  for (const b of bases) {
    const p = path.join(b, "Google", "Chrome", "Application", "chrome.exe");
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}
function openLink(url) {
  if (!/^https?:\/\//i.test(url)) return;
  const chrome = chromePath();
  if (chrome) {
    try { spawn(chrome, [url], { detached: true, stdio: "ignore" }).unref(); return; } catch (e) {}
  }
  shell.openExternal(url);
}

if (!app.requestSingleInstanceLock()) app.quit();
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 380, minHeight: 500,
    backgroundColor: "#f4efe5", autoHideMenuBar: true, title: "Estante de Mangás",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.js") },
  });
  win.maximize();   // abre sempre ocupando a tela toda
  win.loadFile(path.join(__dirname, "..", "www", "index.html"));
  // Links externos (site do mangá) abrem no navegador normal.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) { e.preventDefault(); openLink(url); }
  });
}
// Busca o HTML de uma página (só http/https, até 3 MB, 15 s) para checar capítulos novos.
ipcMain.handle("fetch-text", async (_e, url) => {
  if (!/^https?:\/\//i.test(url)) throw new Error("url");
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await net.fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept-Language": "pt-BR,pt;q=0.9" } });
    if (!r.ok) throw new Error("http " + r.status);
    const txt = await r.text();
    return txt.slice(0, 3 * 1024 * 1024);
  } finally { clearTimeout(t); }
});
// Consultas ao catálogo (AniList, MyAnimeList, MangaDex) e ao tradutor. Só esses endereços são permitidos.
const API_OK = ["graphql.anilist.co", "api.jikan.moe", "api.mangadex.org", "api.mymemory.translated.net", "api.giphy.com", "api.klipy.com", "kitsu.app", "kitsu.io", "wallhaven.cc"];
ipcMain.handle("http", async (_e, req) => {
  const { url, method = "GET", headers = {}, body } = req || {};
  let host = ""; try { host = new URL(url).hostname; } catch (e) {}
  if (!/^https:\/\//i.test(url) || !API_OK.includes(host)) throw new Error("endereço não permitido");
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await net.fetch(url, { method, headers: { "User-Agent": "EstanteDeMangas/1.0", ...headers }, body: body || undefined, signal: ctrl.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error("http " + r.status);
    return txt.slice(0, 3 * 1024 * 1024);
  } finally { clearTimeout(t); }
});
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// deixa o som da abertura tocar sem precisar de um clique antes
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
app.on("window-all-closed", () => app.quit());
