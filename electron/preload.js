// Ponte segura: deixa a página pedir ao app o HTML de um site (para conferir capítulos novos).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("estanteNative", {
  fetchText: (url) => ipcRenderer.invoke("fetch-text", String(url || "")),
});
