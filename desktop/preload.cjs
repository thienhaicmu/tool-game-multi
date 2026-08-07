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
  getResponseBody: capturedId => ipcRenderer.invoke('get-response-body', capturedId),
  getRequestDetail: capturedId => ipcRenderer.invoke('get-request-detail', capturedId),
  connect: endpoint => ipcRenderer.invoke('cdp-connect', endpoint),
  listTargets: () => ipcRenderer.invoke('list-targets'),
  selectTarget: id => ipcRenderer.invoke('select-target', id),
  adbListWebviews: () => ipcRenderer.invoke('adb-list-webviews'),
  adbForwardWebview: (socket, localPort) => ipcRenderer.invoke('adb-forward-webview', socket, localPort),
  onTargetsChanged: callback => ipcRenderer.on('targets-changed', (_event, targets) => callback(targets)),
  onCdpError: callback => ipcRenderer.on('cdp-error', (_event, error) => callback(error)),
  onDetailData: callback => ipcRenderer.on('detail-data', (_event, payload) => callback(payload)),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('capture-event', listener);
    return () => ipcRenderer.removeListener('capture-event', listener);
  }
});
