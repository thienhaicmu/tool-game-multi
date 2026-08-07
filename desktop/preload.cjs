const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopCapture', {
  setScope: hosts => ipcRenderer.invoke('scope-set', hosts),
  setPaused: paused => ipcRenderer.invoke('capture-toggle', paused),
  replayCreateDraft: (capturedRequestId, options) => ipcRenderer.invoke('replay-create-draft', capturedRequestId, options),
  replayUpdateDraft: (draftId, patch) => ipcRenderer.invoke('replay-update-draft', draftId, patch),
  replayExecute: draftId => ipcRenderer.invoke('replay-execute', draftId),
  replayHistory: capturedRequestId => ipcRenderer.invoke('replay-history', capturedRequestId),
  timelineBuild: capturedRequestId => ipcRenderer.invoke('timeline-build', capturedRequestId),
  interceptEnable: (rule, targetId) => ipcRenderer.invoke('intercept-enable', rule, targetId),
  interceptDisable: targetId => ipcRenderer.invoke('intercept-disable', targetId),
  interceptList: () => ipcRenderer.invoke('intercept-list'),
  interceptUpdateDraft: (id, patch) => ipcRenderer.invoke('intercept-update-draft', id, patch),
  interceptContinue: id => ipcRenderer.invoke('intercept-continue', id),
  interceptContinueModified: (id, patch) => ipcRenderer.invoke('intercept-continue-modified', id, patch),
  interceptAbort: id => ipcRenderer.invoke('intercept-abort', id),
  onInterceptChanged: callback => ipcRenderer.on('intercept-changed', (_event, paused) => callback(paused)),
  openBrowser: url => ipcRenderer.invoke('open-browser', url),
  listSessions: () => ipcRenderer.invoke('list-sessions'),
  readSession: sessionId => ipcRenderer.invoke('read-session', sessionId),
  exportSession: sessionId => ipcRenderer.invoke('export-session', sessionId),
  exportSessionReport: (sessionId, format) => ipcRenderer.invoke('export-session-report', sessionId, format),
  analyzeSession: sessionId => ipcRenderer.invoke('analyze-session', sessionId),
  getResponseBody: capturedId => ipcRenderer.invoke('get-response-body', capturedId),
  getRequestDetail: capturedId => ipcRenderer.invoke('get-request-detail', capturedId),
  connect: endpoint => ipcRenderer.invoke('cdp-connect', endpoint),
  listTargets: () => ipcRenderer.invoke('list-targets'),
  selectTarget: id => ipcRenderer.invoke('select-target', id),
  adbListWebviews: () => ipcRenderer.invoke('adb-list-webviews'),
  adbForwardWebview: (socket, localPort) => ipcRenderer.invoke('adb-forward-webview', socket, localPort),
  onTargetsChanged: callback => ipcRenderer.on('targets-changed', (_event, targets) => callback(targets)),
  onCdpError: callback => ipcRenderer.on('cdp-error', (_event, error) => callback(error)),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('capture-event', listener);
    return () => ipcRenderer.removeListener('capture-event', listener);
  }
});
