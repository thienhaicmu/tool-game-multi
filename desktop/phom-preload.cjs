'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Phom QA preload — minimal typed surface. No raw WS sender, no CDP client, no
// proxy password ever crosses back to the renderer (only metadata + test results).
contextBridge.exposeInMainWorld('phomQA', {
  // license / identity
  licenseStatus: () => ipcRenderer.invoke('phom:license-status'),
  activateLicense: (key) => ipcRenderer.invoke('phom:license-activate', key),
  machineId: () => ipcRenderer.invoke('phom:machine-id'),
  instanceInfo: () => ipcRenderer.invoke('phom:instance-info'),
  capabilities: () => ipcRenderer.invoke('phom:capabilities'),
  onLicense: (cb) => ipcRenderer.on('phom:license', (_e, s) => cb(s)),
  // proxy (metadata only)
  proxyList: () => ipcRenderer.invoke('phom:proxy-list'),
  proxyUpsert: (input) => ipcRenderer.invoke('phom:proxy-upsert', input),
  proxyRemove: (id) => ipcRenderer.invoke('phom:proxy-remove', id),
  proxyTest: (id) => ipcRenderer.invoke('phom:proxy-test', id),
  proxyTestAll: (ids) => ipcRenderer.invoke('phom:proxy-test-all', ids),
  onProxyAuth: (cb) => ipcRenderer.on('phom:proxy-auth', (_e, p) => cb(p)),
  // browser + session
  openProfile: (cfg) => ipcRenderer.invoke('phom:open-profile', cfg),
  startSession: (cfg) => ipcRenderer.invoke('phom:start-session', cfg),
  requestChannels: () => ipcRenderer.invoke('phom:request-channels'),
  selectChannel: (ch) => ipcRenderer.invoke('phom:select-channel', ch),
  joinTogether: (ch) => ipcRenderer.invoke('phom:join-together', ch),
  rejoin: () => ipcRenderer.invoke('phom:rejoin'),
  readyAll: () => ipcRenderer.invoke('phom:ready-all'),
  leaveAll: () => ipcRenderer.invoke('phom:leave-all'),
  stop: () => ipcRenderer.invoke('phom:stop'),
  sessionState: () => ipcRenderer.invoke('phom:session-state'),
  verifyTable: () => ipcRenderer.invoke('phom:verify-table'),
  onSession: (cb) => ipcRenderer.on('phom:session', (_e, snap) => cb(snap)),
  onHands: (cb) => ipcRenderer.on('phom:hands', (_e, hands) => cb(hands)),
});
