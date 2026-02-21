const { contextBridge, ipcRenderer } = require("electron");

const listenerRegistry = new Map();

const addSafeListener = (channel, callback) => {
  if (typeof callback !== "function") {
    return () => {};
  }
  const wrapped = (_event, payload) => {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    callback(safePayload);
  };
  listenerRegistry.set(callback, { channel, wrapped });
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    listenerRegistry.delete(callback);
  };
};

const removeSafeListener = (callback) => {
  const binding = listenerRegistry.get(callback);
  if (!binding) {
    return;
  }
  ipcRenderer.removeListener(binding.channel, binding.wrapped);
  listenerRegistry.delete(callback);
};

contextBridge.exposeInMainWorld("podDesktop", {
  getAppInfo: () => ipcRenderer.invoke("pod:get-app-info"),
  openExternal: (url) => ipcRenderer.invoke("pod:open-external", url),
  executeContextAction: (payload) => ipcRenderer.invoke("pod:context-action:execute", payload),
  onContextAction: (callback) => addSafeListener("pod:context-action", callback),
  offContextAction: (callback) => removeSafeListener(callback),
  getDesktopCapabilities: () => ({ nativeContextMenu: true }),
});
