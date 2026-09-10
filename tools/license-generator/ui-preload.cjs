'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only SAFE operations/state are exposed. There is deliberately NO bridge method to
// read the signing key, the Google credential secret, the raw credential JSON, or to
// pick credential files — the seller Generator is self-contained (bundled resources).
contextBridge.exposeInMainWorld('licenseGenerator', {
  signingStatus: () => ipcRenderer.invoke('signing-status'),
  generateLicense: input => ipcRenderer.invoke('generate-license', input),
  inspectLicense: license => ipcRenderer.invoke('inspect-license', license),
  planPresets: () => ipcRenderer.invoke('plan-presets'),
  planDefaults: () => ipcRenderer.invoke('plan-defaults'),
  previewExpiry: input => ipcRenderer.invoke('preview-expiry', input),
  copy: text => ipcRenderer.invoke('copy', text),
  // Google Sheet ledger status + retry (no credentials ever cross this bridge).
  sheetStatus: () => ipcRenderer.invoke('sheet-status'),
  syncLicense: record => ipcRenderer.invoke('sheet-sync', record),
});
