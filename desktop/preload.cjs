const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopCapture', {
  setScope: hosts => ipcRenderer.invoke('scope-set', hosts),
  setPaused: paused => ipcRenderer.invoke('capture-toggle', paused),
  replay: (id, overrides) => ipcRenderer.invoke('replay-request', id, overrides),
  openDetail: payload => ipcRenderer.send('open-request-detail', payload),
  onDetailData: callback => ipcRenderer.on('detail-data', (_event, payload) => callback(payload)),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('capture-event', listener);
    return () => ipcRenderer.removeListener('capture-event', listener);
  }
});
