const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("CDCaseSettings", {
  getCacheDirectory: () => ipcRenderer.invoke("cd-cache:get"),
  chooseCacheDirectory: () => ipcRenderer.invoke("cd-cache:choose"),
  resetCacheDirectory: () => ipcRenderer.invoke("cd-cache:reset"),
  openCacheDirectory: () => ipcRenderer.invoke("cd-cache:open"),
  readArtwork: url => ipcRenderer.invoke("cd-cache:read-artwork", url),
  writeArtwork: (url, data) => ipcRenderer.invoke("cd-cache:write-artwork", url, data),
});


contextBridge.exposeInMainWorld("CDCaseAudio", {
  open: (url, format) => ipcRenderer.invoke("cd-audio:open", url, format),
  close: token => ipcRenderer.invoke("cd-audio:close", token),
  decoder: () => ipcRenderer.invoke("cd-av3a:get"),
  chooseDecoder: () => ipcRenderer.invoke("cd-av3a:choose"),
  clearDecoder: () => ipcRenderer.invoke("cd-av3a:clear"),
  decode: token => ipcRenderer.invoke("cd-av3a:decode", token),
  codec: token => ipcRenderer.invoke("cd-audio:codec", token),
  error: token => ipcRenderer.invoke("cd-audio:error", token),
});

contextBridge.exposeInMainWorld("CDCaseApp", {
  minimizeToTray: () => ipcRenderer.send("app:minimize-to-tray"),
  quitApp: () => ipcRenderer.send("app:quit-app"),
  setCloseAction: action => ipcRenderer.send("app:set-close-action", action),
  onCloseRequested: callback => {
    ipcRenderer.on("app:request-close-confirm", () => callback());
  },
  onTrayAction: callback => {
    ipcRenderer.on("app:tray-action", (_, action) => callback(action));
  },
  setShortcutsConfig: config => ipcRenderer.send("app:set-shortcuts-config", config),
  onShortcutAction: callback => {
    ipcRenderer.on("app:shortcut-action", (_, action) => callback(action));
  },
  updateTrackStatus: status => {
    ipcRenderer.send("app:update-track", status);
  },
});
