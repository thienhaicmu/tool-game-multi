'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only SAFE operations/state are exposed. There is deliberately NO bridge method to
// read the signing key, the Google credential secret, the raw credential JSON, or to
// pick credential files — the seller Generator is self-contained (bundled resources).
contextBridge.exposeInMainWorld('licenseGenerator', {
  signingStatus: () => ipcRenderer.invoke('signing-status'),
  gameConfigs: () => ipcRenderer.invoke('game-configs'),
  productInfo: gameProduct => ipcRenderer.invoke('product-info', gameProduct),
  generateLicense: input => ipcRenderer.invoke('generate-license', input),
  // Operator diagnostics: { license, game, machineId? } -> per-step checks + final verdict.
  diagnoseLicense: input => ipcRenderer.invoke('diagnose-license', input),
  previewExpiry: input => ipcRenderer.invoke('preview-expiry', input),
  copy: text => ipcRenderer.invoke('copy', text),
  // Google Sheet ledger status + retry (no credentials ever cross this bridge).
  sheetStatus: () => ipcRenderer.invoke('sheet-status'),
  syncLicense: record => ipcRenderer.invoke('sheet-sync', record),
});
