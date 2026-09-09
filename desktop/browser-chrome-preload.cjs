const { contextBridge, ipcRenderer } = require('electron');

// CONTROL-V3 — preload for a profile's EXTERNAL browser window (the minimal browser chrome).
// It exposes ONLY same-window navigation bound to this window's run. No generic evaluate/debug,
// no protocol/CDP surface — the site itself is a native child WebContentsView the user drives.
contextBridge.exposeInMainWorld('browserChrome', {
  nav: (runId, action, url) => ipcRenderer.invoke('browser-nav', runId, action, url),
  navState: (runId) => ipcRenderer.invoke('browser-nav-state', runId),
  onUrl: (callback) => ipcRenderer.on('browser-url', (_event, payload) => callback(payload)),
});
