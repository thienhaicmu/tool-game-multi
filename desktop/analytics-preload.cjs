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
  webLog: {
    query: (filter, page) => ipcRenderer.invoke('analytics-weblog-query', filter, page),
    detail: (kind, id) => ipcRenderer.invoke('analytics-weblog-detail', kind, id),
    summary: (filter) => ipcRenderer.invoke('analytics-weblog-summary', filter),
    wsConnection: (id) => ipcRenderer.invoke('analytics-weblog-ws-connection', id),
    wsFrames: (id, opts) => ipcRenderer.invoke('analytics-weblog-ws-frames', id, opts),
  },
  network: {
    overview: (filter) => ipcRenderer.invoke('analytics-net-overview', filter),
    endpoints: (filter) => ipcRenderer.invoke('analytics-net-endpoints', filter),
    hosts: (filter) => ipcRenderer.invoke('analytics-net-hosts', filter),
    timeline: (filter, granularity) => ipcRenderer.invoke('analytics-net-timeline', filter, granularity),
  },
  report: {
    overview: (filter, jp) => ipcRenderer.invoke('analytics-jr-overview', filter, jp),
    lastN: (filter, jp) => ipcRenderer.invoke('analytics-jr-lastn', filter, jp),
    odd: (filter, jp) => ipcRenderer.invoke('analytics-jr-odd', filter, jp),
    time: (filter, jp) => ipcRenderer.invoke('analytics-jr-time', filter, jp),
    timing: (filter, jp, stat) => ipcRenderer.invoke('analytics-jr-timing', filter, jp, stat),
    streak: (filter, jp) => ipcRenderer.invoke('analytics-jr-streak', filter, jp),
    gap: (filter, jp) => ipcRenderer.invoke('analytics-jr-gap', filter, jp),
    delta: (filter, jp) => ipcRenderer.invoke('analytics-jr-delta', filter, jp),
    stats: (filter, jp) => ipcRenderer.invoke('analytics-jr-stats', filter, jp),
  },
  // Forward Research V1 — RESEARCH evidence only (leakage-safe, out-of-sample). No prediction/betting.
  forward: {
    run: (opts) => ipcRenderer.invoke('analytics-fwd-run', opts),
    matrix: (opts) => ipcRenderer.invoke('analytics-fwd-matrix', opts),
  },
  // Prediction Research & Evaluation platform — DESCRIPTIVE research evidence only
  // (registry + fingerprinted, persisted, versioned out-of-sample evaluation). No
  // prediction action / betting / cashout channel of any kind.
  research: {
    algorithms: () => ipcRenderer.invoke('analytics-research-algorithms'),
    overview: () => ipcRenderer.invoke('analytics-research-overview'),
    readinessMatrix: (opts) => ipcRenderer.invoke('analytics-research-readiness-matrix', opts),
    readiness: (opts) => ipcRenderer.invoke('analytics-research-readiness', opts),
    evaluate: (opts) => ipcRenderer.invoke('analytics-research-evaluate', opts),
    evaluateAll: (opts) => ipcRenderer.invoke('analytics-research-evaluate-all', opts),
    history: (opts) => ipcRenderer.invoke('analytics-research-history', opts),
    run: (runId) => ipcRenderer.invoke('analytics-research-run', runId),
    compare: (opts) => ipcRenderer.invoke('analytics-research-compare', opts),
    drift: (opts) => ipcRenderer.invoke('analytics-research-drift', opts),
    monitoring: () => ipcRenderer.invoke('analytics-research-monitoring'),
    familyMonitoring: () => ipcRenderer.invoke('analytics-research-family-monitoring'),
    batches: () => ipcRenderer.invoke('analytics-research-batches'),
    batchRuns: (opts) => ipcRenderer.invoke('analytics-research-batch-runs', opts),
    ledger: (runId) => ipcRenderer.invoke('analytics-research-ledger', runId),
  },
  export: {
    rounds: (filter) => ipcRenderer.invoke('analytics-export-rounds', filter),
    roundDetail: (roundId) => ipcRenderer.invoke('analytics-export-round-detail', roundId),
    rawEvents: (opts) => ipcRenderer.invoke('analytics-export-raw', opts),
    webLog: (filter) => ipcRenderer.invoke('analytics-export-weblog', filter),
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
