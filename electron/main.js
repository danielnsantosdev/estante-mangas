// Janela do app no Windows (Electron)
const { app, BrowserWindow, shell, Menu, ipcMain, net } = require("electron");
const path = require("path");

if (!app.requestSingleInstanceLock()) app.quit();
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 380, minHeight: 500,
    backgroundColor: "#f4efe5", autoHideMenuBar: true, title: "Estante de Mangás",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile(path.join(__dirname, "..", "www", "index.html"));
  // Links externos (site do mangá) abrem no navegador normal.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
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
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
app.on("window-all-closed", () => app.quit());
