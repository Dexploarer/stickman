const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("podDesktop", {
  getAppInfo: () => ipcRenderer.invoke("pod:get-app-info"),
  openExternal: (url) => ipcRenderer.invoke("pod:open-external", url),
});
