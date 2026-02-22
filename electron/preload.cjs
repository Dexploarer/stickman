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

  let channelMap = listenerRegistry.get(callback);
  if (!channelMap) {
    channelMap = new Map();
    listenerRegistry.set(callback, channelMap);
  }

  channelMap.set(channel, wrapped);
  ipcRenderer.on(channel, wrapped);

  return () => {
    const nextMap = listenerRegistry.get(callback);
    const currentWrapped = nextMap?.get(channel);
    if (!currentWrapped) {
      return;
    }
    ipcRenderer.removeListener(channel, currentWrapped);
    nextMap.delete(channel);
    if (!nextMap.size) {
      listenerRegistry.delete(callback);
    }
  };
};

const removeSafeListener = (channel, callback) => {
  const channelMap = listenerRegistry.get(callback);
  const wrapped = channelMap?.get(channel);
  if (!wrapped) {
    return;
  }
  ipcRenderer.removeListener(channel, wrapped);
  channelMap.delete(channel);
  if (!channelMap.size) {
    listenerRegistry.delete(callback);
  }
};

contextBridge.exposeInMainWorld("podDesktop", {
  getAppInfo: () => ipcRenderer.invoke("pod:get-app-info"),
  openExternal: (url) => ipcRenderer.invoke("pod:open-external", url),
  executeContextAction: (payload) => ipcRenderer.invoke("pod:context-action:execute", payload),

  getDesktopCapabilities: () => ipcRenderer.invoke("pod:desktop:capabilities:get"),
  getDesktopCommands: () => ipcRenderer.invoke("pod:desktop:commands:get"),
  getDesktopPreferences: () => ipcRenderer.invoke("pod:desktop:preferences:get"),
  setDesktopPreferences: (patch) => ipcRenderer.invoke("pod:desktop:preferences:set", patch),
  executeDesktopCommand: (commandId, payload) =>
    ipcRenderer.invoke("pod:desktop:command:execute", {
      commandId,
      payload,
    }),
  requestQuit: () => ipcRenderer.invoke("pod:app:quit"),

  onContextAction: (callback) => addSafeListener("pod:context-action", callback),
  offContextAction: (callback) => removeSafeListener("pod:context-action", callback),

  onDesktopCommand: (callback) => addSafeListener("pod:desktop-command", callback),
  offDesktopCommand: (callback) => removeSafeListener("pod:desktop-command", callback),

  onDesktopLiveEvent: (callback) => addSafeListener("pod:desktop-live-event", callback),
  offDesktopLiveEvent: (callback) => removeSafeListener("pod:desktop-live-event", callback),

  onDesktopCapabilities: (callback) => addSafeListener("pod:desktop-capabilities", callback),
  offDesktopCapabilities: (callback) => removeSafeListener("pod:desktop-capabilities", callback),

  onDesktopPreferences: (callback) => addSafeListener("pod:desktop-preferences", callback),
  offDesktopPreferences: (callback) => removeSafeListener("pod:desktop-preferences", callback),
});
