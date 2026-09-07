'use strict';

// Aviator Analytics preload — PASSIVE API surface only.
//
// Every exposed method is either browser/profile lifecycle or read-only live
// observation. There is deliberately NO send / sendRaw / sendProtocol / bet /
// cashout / enter / replay / autotest / btest / jackpot-gate channel. Adding one
// would be caught by the passive-boundary tests.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('analytics', {
  browser: {
    list: () => ipcRenderer.invoke('analytics-browser-list'),
    create: (input) => ipcRenderer.invoke('analytics-browser-create', input),
    update: (browserId, patch) => ipcRenderer.invoke('analytics-browser-update', browserId, patch),
    delete: (browserId) => ipcRenderer.invoke('analytics-browser-delete', browserId),
    open: (browserId) => ipcRenderer.invoke('analytics-browser-open', browserId),
    close: (browserId) => ipcRenderer.invoke('analytics-browser-close', browserId),
    select: (browserId) => ipcRenderer.invoke('analytics-browser-select', browserId),
    view: (browserId, bounds, visible) => ipcRenderer.invoke('analytics-inapp-view', browserId, bounds, visible),
  },
  live: {
    getSummary: (browserId) => ipcRenderer.invoke('analytics-live-summary', browserId),
    onUpdate: (callback) => ipcRenderer.on('analytics-live-update', (_e, summary) => callback(summary)),
    onBrowsersChanged: (callback) => ipcRenderer.on('analytics-browsers-changed', (_e, browsers) => callback(browsers)),
  },
  rounds: {
    query: (query) => ipcRenderer.invoke('analytics-rounds-query', query),
    detail: (roundId) => ipcRenderer.invoke('analytics-round-detail', roundId),
  },
  db: {
    info: () => ipcRenderer.invoke('analytics-db-info'),
  },
  export: {
    rounds: (filter) => ipcRenderer.invoke('analytics-export-rounds', filter),
    roundDetail: (roundId) => ipcRenderer.invoke('analytics-export-round-detail', roundId),
    rawEvents: (opts) => ipcRenderer.invoke('analytics-export-raw', opts),
  },
  backup: {
    database: () => ipcRenderer.invoke('analytics-backup-db'),
  },
  stats: {
    overview: (filter) => ipcRenderer.invoke('analytics-stats-overview', filter),
    thresholds: (filter) => ipcRenderer.invoke('analytics-stats-thresholds', filter),
    distribution: (filter) => ipcRenderer.invoke('analytics-stats-distribution', filter),
    timing: (filter) => ipcRenderer.invoke('analytics-stats-timing', filter),
    timeBuckets: (filter, granularity) => ipcRenderer.invoke('analytics-stats-time-buckets', filter, granularity),
    hourly: (filter) => ipcRenderer.invoke('analytics-stats-hourly', filter),
    jackpotBuckets: (filter, bucketDefs) => ipcRenderer.invoke('analytics-stats-jackpot-buckets', filter, bucketDefs),
    rolling: (filter, threshold, window) => ipcRenderer.invoke('analytics-stats-rolling', filter, threshold, window),
    streaks: (filter) => ipcRenderer.invoke('analytics-stats-streaks', filter),
    gaps: (filter) => ipcRenderer.invoke('analytics-stats-gaps', filter),
    lastN: (filter) => ipcRenderer.invoke('analytics-stats-lastn', filter),
  },
  instanceInfo: () => ipcRenderer.invoke('analytics-instance-info'),
});
