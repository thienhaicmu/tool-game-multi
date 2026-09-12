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
  // mobile device profiles (per slot)
  devicePresets: () => ipcRenderer.invoke('phom:device-presets'),
  profileList: () => ipcRenderer.invoke('phom:profile-list'),
  profileUpsert: (slot, input) => ipcRenderer.invoke('phom:profile-upsert', slot, input),
  profileDelete: (slot) => ipcRenderer.invoke('phom:profile-delete', slot),
  onDeviceApplied: (cb) => ipcRenderer.on('phom:device-applied', (_e, p) => cb(p)),
  // browser + HOST/FOLLOWER controlled-table session
  openProfile: (cfg) => ipcRenderer.invoke('phom:open-profile', cfg),
  startSession: (cfg) => ipcRenderer.invoke('phom:start-session', cfg),
  setHost: (id) => ipcRenderer.invoke('phom:set-host', id),
  selectStake: (stake) => ipcRenderer.invoke('phom:select-stake', stake),
  acquireHost: () => ipcRenderer.invoke('phom:acquire-host'),
  joinFollowers: () => ipcRenderer.invoke('phom:join-followers'),
  applyReady: () => ipcRenderer.invoke('phom:apply-ready'),
  rejoinFollower: (id) => ipcRenderer.invoke('phom:rejoin-follower', id),
  recoverHost: () => ipcRenderer.invoke('phom:recover-host'),
  restoreLayout: () => ipcRenderer.invoke('phom:restore-layout'),
  focusBrowser: (runId) => ipcRenderer.invoke('phom:focus-browser', runId),
  leaveAll: () => ipcRenderer.invoke('phom:leave-all'),
  stop: () => ipcRenderer.invoke('phom:stop'),
  sessionState: () => ipcRenderer.invoke('phom:session-state'),
  verifyTable: () => ipcRenderer.invoke('phom:verify-table'),
  onSession: (cb) => ipcRenderer.on('phom:session', (_e, snap) => cb(snap)),
  onHands: (cb) => ipcRenderer.on('phom:hands', (_e, hands) => cb(hands)),
  onKick: (cb) => ipcRenderer.on('phom:kick', (_e, k) => cb(k)),
  // offline rule analyzer (QA / no live)
  analyzerStatus: () => ipcRenderer.invoke('phom:analyzer-status'),
  analyzerAnalyze: (input) => ipcRenderer.invoke('phom:analyzer-analyze', input),
});
