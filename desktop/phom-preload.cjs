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
  proxyQuickApply: (payload) => ipcRenderer.invoke('phom:proxy-quick-apply', payload),
  onProxyAuth: (cb) => ipcRenderer.on('phom:proxy-auth', (_e, p) => cb(p)),
  // mobile device profiles (per slot)
  devicePresets: () => ipcRenderer.invoke('phom:device-presets'),
  profileList: () => ipcRenderer.invoke('phom:profile-list'),
  profileUpsert: (slot, input) => ipcRenderer.invoke('phom:profile-upsert', slot, input),
  profileDelete: (slot) => ipcRenderer.invoke('phom:profile-delete', slot),
  // PHASE 6.3.1 — flexible N-profile store CRUD + open-from-selection
  profilesList: () => ipcRenderer.invoke('phom:profiles-list'),
  profileCreate: (input) => ipcRenderer.invoke('phom:profile-create', input),
  profileUpdateX: (id, patch) => ipcRenderer.invoke('phom:profile-update-x', id, patch),
  profileDeleteX: (id) => ipcRenderer.invoke('phom:profile-delete-x', id),
  profileSetProxy: (id, proxyInput) => ipcRenderer.invoke('phom:profile-set-proxy', id, proxyInput),
  openSelected: (cfg) => ipcRenderer.invoke('phom:open-selected', cfg),
  onDeviceApplied: (cb) => ipcRenderer.on('phom:device-applied', (_e, p) => cb(p)),
  // browser + HOST/FOLLOWER controlled-table session
  openProfile: (cfg) => ipcRenderer.invoke('phom:open-profile', cfg),
  startSession: (cfg) => ipcRenderer.invoke('phom:start-session', cfg),
  setHost: (id) => ipcRenderer.invoke('phom:set-host', id),
  selectStake: (stake) => ipcRenderer.invoke('phom:select-stake', stake),
  requestChannels: () => ipcRenderer.invoke('phom:request-channels'),
  stakeChannels: () => ipcRenderer.invoke('phom:stake-channels'),
  acquireHost: () => ipcRenderer.invoke('phom:acquire-host'),
  discover: () => ipcRenderer.invoke('phom:discover'),
  joinFollowers: () => ipcRenderer.invoke('phom:join-followers'),
  applyReady: () => ipcRenderer.invoke('phom:apply-ready'),
  rejoinFollower: (id) => ipcRenderer.invoke('phom:rejoin-follower', id),
  recoverHost: () => ipcRenderer.invoke('phom:recover-host'),
  restoreLayout: () => ipcRenderer.invoke('phom:restore-layout'),
  focusBrowser: (runId) => ipcRenderer.invoke('phom:focus-browser', runId),
  // VÀO GAME PHỎM — trigger the verified `vgcg_8` entry action via the site's own Cocos node.
  enterGame: (runId) => ipcRenderer.invoke('phom:enter-game', runId),
  leaveAll: () => ipcRenderer.invoke('phom:leave-all'),
  stop: () => ipcRenderer.invoke('phom:stop'),
  sessionState: () => ipcRenderer.invoke('phom:session-state'),
  verifyTable: () => ipcRenderer.invoke('phom:verify-table'),
  trace: () => ipcRenderer.invoke('phom:trace'),
  joinExperiment: (channel, opts) => ipcRenderer.invoke('phom:join-experiment', { channel, opts }),
  hostAnchoredJoin: (channel, opts) => ipcRenderer.invoke('phom:host-anchored-join', { channel, opts }),
  // PHASE-6 — manual per-browser control (browserId === browserRunId). No host/follower role.
  manualFind: (browserId, channel, opts) => ipcRenderer.invoke('phom:manual-find', { browserId, channel, opts }),
  manualDiscover: (browserId, opts) => ipcRenderer.invoke('phom:manual-discover', { browserId, opts }),
  reloadWeb: (browserId) => ipcRenderer.invoke('phom:reload-web', { browserId }),
  closeBrowser: (browserId) => ipcRenderer.invoke('phom:close-browser', { browserId }),
  manualJoin: (browserId, rid, opts) => ipcRenderer.invoke('phom:manual-join', { browserId, rid, opts }),
  manualRejoin: (browserId, opts) => ipcRenderer.invoke('phom:manual-rejoin', { browserId, opts }),
  manualLeave: (browserId) => ipcRenderer.invoke('phom:manual-leave', { browserId }),
  manualSnapshot: () => ipcRenderer.invoke('phom:manual-snapshot'),
  remainingCards: () => ipcRenderer.invoke('phom:remaining-cards'),
  // PHASE 6.3.3.2 — card observation engine snapshot (pull + push).
  cardsSnapshot: () => ipcRenderer.invoke('phom:cards'),
  onSession: (cb) => ipcRenderer.on('phom:session', (_e, snap) => cb(snap)),
  onHands: (cb) => ipcRenderer.on('phom:hands', (_e, hands) => cb(hands)),
  onCards: (cb) => ipcRenderer.on('phom:cards', (_e, cards) => cb(cards)),
  onKick: (cb) => ipcRenderer.on('phom:kick', (_e, k) => cb(k)),
  onLog: (cb) => ipcRenderer.on('phom:log', (_e, l) => cb(l)),
  // custom Chromium runtime + cluster control-plane
  chromiumStatus: () => ipcRenderer.invoke('phom:chromium-status'),
  // PHASE 6.3.2.2 — browser runtime preference (Custom Chromium / Google Chrome)
  browserRuntimeGet: () => ipcRenderer.invoke('phom:browser-runtime-get'),
  browserRuntimeSet: (cfg) => ipcRenderer.invoke('phom:browser-runtime-set', cfg),
  clusterCreate: (config) => ipcRenderer.invoke('phom:cluster-create', config),
  clusterOpen: () => ipcRenderer.invoke('phom:cluster-open'),
  clusterConnect: () => ipcRenderer.invoke('phom:cluster-connect'),
  clusterApplyDevices: () => ipcRenderer.invoke('phom:cluster-apply-devices'),
  clusterTestProxies: () => ipcRenderer.invoke('phom:cluster-test-proxies'),
  clusterAcquireHost: () => ipcRenderer.invoke('phom:cluster-acquire-host'),
  clusterJoinFollowers: () => ipcRenderer.invoke('phom:cluster-join-followers'),
  clusterApplyReady: () => ipcRenderer.invoke('phom:cluster-apply-ready'),
  clusterLeave: () => ipcRenderer.invoke('phom:cluster-leave'),
  // DỪNG — stop orchestration only (NEVER closes the browsers).
  orchestrationStop: () => ipcRenderer.invoke('phom:orchestration-stop'),
  // ĐÓNG 3 TRÌNH DUYỆT — explicit browser close (the only app path that closes runs).
  closeBrowsers: () => ipcRenderer.invoke('phom:cluster-stop'),
  clusterStop: () => ipcRenderer.invoke('phom:cluster-stop'),
  clusterSnapshot: () => ipcRenderer.invoke('phom:cluster-snapshot'),
  onCluster: (cb) => ipcRenderer.on('phom:cluster', (_e, snap) => cb(snap)),
  // cluster PROFILES (saved configs: shared game URL + 3 browser/device/proxy slots)
  clusterProfileList: () => ipcRenderer.invoke('phom:cluster-profile-list'),
  clusterProfileGet: (id) => ipcRenderer.invoke('phom:cluster-profile-get', id),
  clusterProfileCreate: (input) => ipcRenderer.invoke('phom:cluster-profile-create', input),
  clusterProfileUpdate: (id, patch) => ipcRenderer.invoke('phom:cluster-profile-update', id, patch),
  clusterProfileDelete: (id) => ipcRenderer.invoke('phom:cluster-profile-delete', id),
  clusterProfileDuplicate: (id, newName) => ipcRenderer.invoke('phom:cluster-profile-duplicate', id, newName),
  clusterProfileSelect: (id) => ipcRenderer.invoke('phom:cluster-profile-select', id),
  clusterProfileValidate: (id) => ipcRenderer.invoke('phom:cluster-profile-validate', id),
  // offline rule analyzer (QA / no live)
  analyzerStatus: () => ipcRenderer.invoke('phom:analyzer-status'),
  analyzerAnalyze: (input) => ipcRenderer.invoke('phom:analyzer-analyze', input),
  // offline REALTIME simulator (event-by-event replay, QA / no live)
  simDatasets: () => ipcRenderer.invoke('phom:sim-datasets'),
  simLoad: (input) => ipcRenderer.invoke('phom:sim-load', input),
  simControl: (action, arg) => ipcRenderer.invoke('phom:sim-control', action, arg),
  // QA rule monitor (D simulated, fixture/replay) — §19-§21
  qaMonitorDatasets: () => ipcRenderer.invoke('phom:qa-monitor-datasets'),
  qaMonitorLoad: (input) => ipcRenderer.invoke('phom:qa-monitor-load', input),
  qaMonitorControl: (action, arg) => ipcRenderer.invoke('phom:qa-monitor-control', action, arg),
});
