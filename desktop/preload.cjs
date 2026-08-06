const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopCapture', {
  setScope: hosts => ipcRenderer.invoke('scope-set', hosts),
  setPaused: paused => ipcRenderer.invoke('capture-toggle', paused),
  replay: (id, overrides) => ipcRenderer.invoke('replay-request', id, overrides),
  openDetail: payload => ipcRenderer.send('open-request-detail', payload),
  openBrowser: url => ipcRenderer.invoke('open-browser', url),
  onBrowserTarget: callback => ipcRenderer.on('browser-target', (_event, url) => callback(url)),
  listSessions: () => ipcRenderer.invoke('list-sessions'),
  readSession: sessionId => ipcRenderer.invoke('read-session', sessionId),
  exportSession: sessionId => ipcRenderer.invoke('export-session', sessionId),
  exportSessionReport: (sessionId, format) => ipcRenderer.invoke('export-session-report', sessionId, format),
  analyzeSession: sessionId => ipcRenderer.invoke('analyze-session', sessionId),
  browserReplay: (id, payload) => ipcRenderer.invoke('browser-replay', id, payload),
  onBrowserReplay: callback => ipcRenderer.on('browser-replay', (_event, token, payload) => callback(token, payload)),
  browserReplayResult: (token, result) => ipcRenderer.invoke('browser-replay-result', token, result),
  onDetailData: callback => ipcRenderer.on('detail-data', (_event, payload) => callback(payload)),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('capture-event', listener);
    return () => ipcRenderer.removeListener('capture-event', listener);
  }
});
