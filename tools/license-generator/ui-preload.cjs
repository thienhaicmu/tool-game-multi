'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseGenerator', {
  keyStatus: () => ipcRenderer.invoke('key-status'),
  choosePrivateKey: () => ipcRenderer.invoke('choose-private-key'),
  generateLicense: input => ipcRenderer.invoke('generate-license', input),
  copy: text => ipcRenderer.invoke('copy', text),
});
