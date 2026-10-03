'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Phom QA preload — the typed surface the tool window uses, nothing more. No raw WS sender, no CDP client, no proxy
// password ever crosses back to the renderer (only metadata).
contextBridge.exposeInMainWorld('phomQA', {
  // license / identity
  licenseStatus: () => ipcRenderer.invoke('phom:license-status'),
  activateLicense: (key) => ipcRenderer.invoke('phom:license-activate', key),
  machineId: () => ipcRenderer.invoke('phom:machine-id'),
  capabilities: () => ipcRenderer.invoke('phom:capabilities'),
  onLicense: (cb) => ipcRenderer.on('phom:license', (_e, s) => cb(s)),
  // proxies (metadata only) + a proxy that refused the saved credentials
  proxyList: () => ipcRenderer.invoke('phom:proxy-list'),
  onProxyAuth: (cb) => ipcRenderer.on('phom:proxy-auth', (_e, p) => cb(p)),
  // device profiles: CRUD + open the three ticked ones
  agents: () => ipcRenderer.invoke('phom:agents'),
  profilesList: () => ipcRenderer.invoke('phom:profiles-list'),
  profileCreate: (input) => ipcRenderer.invoke('phom:profile-create', input),
  profileUpdateX: (id, patch) => ipcRenderer.invoke('phom:profile-update-x', id, patch),
  profileDeleteX: (id) => ipcRenderer.invoke('phom:profile-delete-x', id),
  profileSetProxy: (id, proxyInput) => ipcRenderer.invoke('phom:profile-set-proxy', id, proxyInput),
  openSelected: (cfg) => ipcRenderer.invoke('phom:open-selected', cfg),
  browserRuntimeGet: () => ipcRenderer.invoke('phom:browser-runtime-get'),
  browserRuntimeSet: (cfg) => ipcRenderer.invoke('phom:browser-runtime-set', cfg),
  // the three browsers
  clusterOpen: () => ipcRenderer.invoke('phom:cluster-open'),
  clusterConnect: () => ipcRenderer.invoke('phom:cluster-connect'),
  clusterApplyAgents: () => ipcRenderer.invoke('phom:cluster-apply-agents'),
  closeBrowsers: () => ipcRenderer.invoke('phom:cluster-stop'), // the only app path that closes all of them
  clusterSnapshot: () => ipcRenderer.invoke('phom:cluster-snapshot'),
  onCluster: (cb) => ipcRenderer.on('phom:cluster', (_e, snap) => cb(snap)),
  restoreLayout: () => ipcRenderer.invoke('phom:restore-layout'),
  reloadWeb: (browserId) => ipcRenderer.invoke('phom:reload-web', { browserId }),
  closeBrowser: (browserId) => ipcRenderer.invoke('phom:close-browser', { browserId }),
  // VÀO GAME PHỎM — the verified `vgcg_8` entry action via the site's own Cocos node
  enterGame: (runId) => ipcRenderer.invoke('phom:enter-game', runId),
  // the Phỏm session: observe the three runs, group actions, one snapshot for the whole screen
  startSession: (cfg) => ipcRenderer.invoke('phom:start-session', cfg),
  sessionState: () => ipcRenderer.invoke('phom:session-state'),
  requestChannels: (browserId) => ipcRenderer.invoke('phom:request-channels', { browserId: browserId != null ? browserId : null }),
  setAuto: (on, browserId, stake) => ipcRenderer.invoke('phom:auto-set', { on, browserId, stake }),
  setStake: (stake) => ipcRenderer.invoke('phom:set-stake', { stake }),
  newTable: (browserId) => ipcRenderer.invoke('phom:new-table', { browserId }),
  leaveAll: () => ipcRenderer.invoke('phom:leave-all'),
  uiSnapshot: () => ipcRenderer.invoke('phom:ui-snapshot'),
  onSession: (cb) => ipcRenderer.on('phom:session', (_e, snap) => cb(snap)),
  onUi: (cb) => ipcRenderer.on('phom:ui', (_e, snap) => cb(snap)),
  onNotice: (cb) => ipcRenderer.on('phom:notice', (_e, n) => cb(n)),
  onKick: (cb) => ipcRenderer.on('phom:kick', (_e, k) => cb(k)),
  // GHI WS (Test D) — record the game's own frames while the player acts, save them for a bug report
  framesRecordStart: (cfg) => ipcRenderer.invoke('phom:frames-record-start', cfg || {}),
  framesRecordStatus: () => ipcRenderer.invoke('phom:frames-record-status'),
  framesRecordStop: () => ipcRenderer.invoke('phom:frames-record-stop'),
  framesOpenFolder: (p) => ipcRenderer.invoke('phom:frames-open-folder', p),
});
