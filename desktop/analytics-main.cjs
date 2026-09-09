'use strict';

// ===========================================================================
// Aviator Analytics — SECOND PRODUCT composition root (M2).
//
// This is a completely separate Electron application from Aviator Control Studio
// (desktop/main.cjs). It shares ONLY passive, observe-only runtime components and
// has NO protocol action path:
//   - no WsReplay / sendRaw / sendProtocol
//   - no AutoRunner / Harness / AmountValidator
//   - no AviatorEntryGate / JackpotGate / Stop1000Guard
//   - no replay / intercept engine
//   - no action IPC channel
//
// Identity, userData and Chromium partitions are all namespaced to Analytics so
// the two products never share a writable data root or a persistent partition.
// ===========================================================================

const { app, BrowserWindow, ipcMain, protocol, dialog, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { normalizeWindowBounds } = require('./window-bounds.cjs');

// Preferred window size + minimums (identical policy to Control; only the numbers differ).
// Never exceeds the current work area — normalizeWindowBounds clamps size AND minimums.
const WIN_DEFAULTS = Object.freeze({ width: 1280, height: 860, minWidth: 940, minHeight: 600 });

const { InAppRuntime } = require('./browser/inapp-runtime.cjs');
const { CaptureCorrelator } = require('./cdp/capture.cjs');
const { BrowserRegistry } = require('./browser-run/browser-registry.cjs');
const { AnalyticsRuntime } = require('./analytics/analytics-runtime.cjs');
const { AnalyticsStore } = require('./analytics/db/analytics-store.cjs');
const { AnalyticsPersistence } = require('./analytics/persistence.cjs');
const { AnalyticsQueryEngine, normalizeFilter } = require('./analytics/query/analytics-query-engine.cjs');
const { FilterError } = require('./analytics/query/analytics-filter.cjs');
const exporter = require('./analytics/export/exporter.cjs');
const { WebLogQuery, NetworkReport, normalizeNetworkFilter } = require('./analytics/query/web-log-query.cjs');
const { JackpotReport } = require('./analytics/query/jackpot-report.cjs');
const { ForwardResearch } = require('./analytics/forward-research/forward-research.cjs');
const { ResearchService } = require('./analytics/research/research-service.cjs');

const PRODUCT_NAME = 'Aviator Analytics';

// ---- renderer scheme MUST be privileged, registered BEFORE app 'ready' ----
// The renderer is served over the custom 'analytics-app' scheme. Unless the scheme
// is registered as a standard, secure origin, its origin does NOT satisfy the page's
// CSP `'self'`, so Chromium refuses to load analytics.css AND analytics.js — the app
// renders unstyled (dark text on default background, native controls). Registering it
// privileged makes 'self' match and the stylesheet + script load normally.
protocol.registerSchemesAsPrivileged([
  { scheme: 'analytics-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ---- product identity + userData isolation (distinct from Control) ----
// Setting the app name BEFORE app-ready reroutes getPath('userData') to
// %APPDATA%/Aviator Analytics, guaranteeing a separate writable root.
app.setName(PRODUCT_NAME);
const ANALYTICS_USERDATA = path.join(app.getPath('appData'), PRODUCT_NAME);
try { fs.mkdirSync(ANALYTICS_USERDATA, { recursive: true }); } catch { /* created on first write */ }
app.setPath('userData', ANALYTICS_USERDATA);

// ---- single-instance ownership (independent of Control: keyed on Analytics userData) ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }
app.on('second-instance', () => { if (shell && !shell.isDestroyed()) { if (shell.isMinimized()) shell.restore(); shell.focus(); } });

let shell = null;
let runtime = null;
let store = null;
let persistence = null;
let engine = null;
let webLog = null;
let netReport = null;
let jackpotReport = null;
let forwardResearch = null;
let research = null;

function analyticsRoot() { return path.join(ANALYTICS_USERDATA, 'analytics'); }

function ensureStore() {
  if (store) return store;
  const root = analyticsRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* best effort */ }
  store = new AnalyticsStore({ file: path.join(root, 'analytics.db') });
  try { store.reconcileOnStartup(); } catch { /* reconciliation best-effort; DB still usable */ }
  persistence = new AnalyticsPersistence({ store });
  engine = new AnalyticsQueryEngine({ store });
  webLog = new WebLogQuery({ store });
  netReport = new NetworkReport({ store });
  jackpotReport = new JackpotReport({ store });
  forwardResearch = new ForwardResearch({ store });
  research = new ResearchService({ store });
  return store;
}

function ensureRuntime() {
  if (runtime) return runtime;
  const root = analyticsRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* best effort */ }
  ensureStore();
  const registry = new BrowserRegistry({
    filePath: path.join(root, 'browser-registry.json'),
    profilesRoot: path.join(root, 'browser-profiles'),
    entitlement: () => ({ maxBrowsers: null }), // M2: no license gate on Analytics profiles
  });
  registry.load();
  const inappRuntime = new InAppRuntime({ getHostWindow: () => shell, partitionPrefix: 'persist:analytics-' });
  // Late-bound resolver avoids the capture<->runtime construction cycle.
  const capture = new CaptureCorrelator({ resolveClient: (tid) => (runtime ? runtime.clientForTarget(tid) : null) });
  runtime = new AnalyticsRuntime({ registry, inappRuntime, capture, persistence });

  // Push live updates to the renderer, throttled, for the SELECTED browser only.
  let dirty = false;
  const flush = () => {
    dirty = false;
    if (!shell || shell.isDestroyed()) return;
    const sel = runtime.selectedBrowserId();
    shell.webContents.send('analytics-live-update', runtime.liveSummary(sel, { eventsLimit: 200 }));
    shell.webContents.send('analytics-browsers-changed', runtime.listBrowsers());
  };
  const scheduleFlush = () => { if (dirty) return; dirty = true; setTimeout(flush, 120); };
  runtime.on('browser-updated', scheduleFlush);
  runtime.on('browsers-changed', () => { if (shell && !shell.isDestroyed()) { shell.webContents.send('analytics-browsers-changed', runtime.listBrowsers()); } scheduleFlush(); });
  return runtime;
}

// ---- window bounds persistence + current-display fit (mirrors Control) ----
function windowStatePath() { return path.join(ANALYTICS_USERDATA, 'window-state.json'); }
function loadWindowState() { try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); } catch { return null; } }
function saveWindowState() { try { if (shell && !shell.isDestroyed() && !shell.isMinimized()) fs.writeFileSync(windowStatePath(), JSON.stringify(shell.getBounds()), 'utf8'); } catch { /* best effort */ } }

// Resolve BrowserWindow bounds against the ACTUAL current display work area so the window
// always opens fully on-screen and correctly sized — no first-open overflow, no manual
// maximize/restore. Stale bounds from another/disconnected monitor recover safely.
// DPI-safe (workArea is already in DIP).
function fitToCurrentDisplay(saved) {
  const hasPos = saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y));
  const display = hasPos
    ? screen.getDisplayMatching({ x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.width), height: Math.round(saved.height) })
    : screen.getPrimaryDisplay();
  return normalizeWindowBounds({ saved, workArea: display.workArea, defaults: WIN_DEFAULTS });
}

function createWindow() {
  const bounds = fitToCurrentDisplay(loadWindowState());
  shell = new BrowserWindow({
    ...bounds,
    backgroundColor: '#0f1419',
    title: PRODUCT_NAME,
    webPreferences: { preload: path.join(__dirname, 'analytics-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  shell.on('close', saveWindowState);
  ensureRuntime();
  shell.loadURL('analytics-app://ui/index.html');
}

// ---- passive IPC surface (validated in main; no action channels) ----
function registerIpc() {
  ipcMain.handle('analytics-browser-list', () => ensureRuntime().listBrowsers());
  ipcMain.handle('analytics-browser-create', (_e, input) => {
    const res = ensureRuntime().createBrowser(input || {});
    if (res && res.error) return res;
    return { ok: true, browser: res.browser, browsers: runtime.listBrowsers() };
  });
  ipcMain.handle('analytics-browser-update', (_e, browserId, patch) => ensureRuntime()._registry.update(String(browserId), patch || {}));
  ipcMain.handle('analytics-browser-delete', (_e, browserId) => ensureRuntime().deleteBrowser(String(browserId)));
  ipcMain.handle('analytics-browser-open', async (_e, browserId) => ensureRuntime().open(String(browserId)));
  ipcMain.handle('analytics-browser-close', async (_e, browserId) => ensureRuntime().close(String(browserId)));
  ipcMain.handle('analytics-browser-select', (_e, browserId) => ensureRuntime().select(String(browserId)));
  ipcMain.handle('analytics-live-summary', (_e, browserId) => ensureRuntime().liveSummary(browserId != null ? String(browserId) : null, { eventsLimit: 200 }));
  ipcMain.handle('analytics-inapp-view', (_e, browserId, bounds, visible) => ensureRuntime().setViewBounds(String(browserId), bounds, visible));
  ipcMain.handle('analytics-instance-info', () => ({ productName: PRODUCT_NAME, userData: ANALYTICS_USERDATA, partitionPrefix: 'persist:analytics-' }));

  // ---- round persistence query API (validated; no raw SQL) ----
  ipcMain.handle('analytics-rounds-query', (_e, query) => {
    ensureRuntime();
    const q = query || {};
    return store.listRounds({
      browserId: q.browserId != null ? String(q.browserId) : null,
      captureSessionId: q.captureSessionId != null ? Number(q.captureSessionId) : null,
      limit: clampInt(q.limit, 50, 1, 1000),
      offset: clampInt(q.offset, 0, 0, 10_000_000),
      sort: typeof q.sort === 'string' ? q.sort : 'sequence_number',
      dir: q.dir === 'ASC' ? 'ASC' : 'DESC',
    });
  });
  ipcMain.handle('analytics-round-detail', (_e, roundId) => { ensureRuntime(); return store.getRoundDetail(roundId); });
  ipcMain.handle('analytics-db-info', () => { ensureRuntime(); const dbPath = path.join(analyticsRoot(), 'analytics.db'); let sizeBytes = null; try { sizeBytes = fs.statSync(dbPath).size; } catch { /* not yet created */ } return { dbPath, sizeBytes, ...store.counts() }; });

  // ---- export + safe backup (main-process only; save dialogs; no arbitrary FS) ----
  async function chooseSave(defaultName, filters) {
    const res = await dialog.showSaveDialog(shell && !shell.isDestroyed() ? shell : undefined, { defaultPath: defaultName, filters });
    return res.canceled ? null : res.filePath;
  }
  ipcMain.handle('analytics-export-rounds', async (_e, filter) => {
    ensureRuntime();
    let spec; try { spec = normalizeFilter(filter || {}); } catch (err) { return { error: { code: 'INVALID_FILTER', message: String(err && err.message || err) } }; }
    const out = await chooseSave('aviator-rounds.csv', [{ name: 'CSV', extensions: ['csv'] }]);
    if (!out) return { canceled: true };
    try { return exporter.exportRoundsCsv(store, spec, out); } catch (err) { return { error: { code: 'EXPORT_FAILED', message: String(err && err.message || err) } }; }
  });
  ipcMain.handle('analytics-export-round-detail', async (_e, roundId) => {
    ensureRuntime();
    const id = Number(roundId); if (!Number.isInteger(id) || id <= 0) return { error: { code: 'INVALID_ROUND_ID', message: 'roundId must be a positive integer' } };
    const out = await chooseSave(`aviator-round-${id}.json`, [{ name: 'JSON', extensions: ['json'] }]);
    if (!out) return { canceled: true };
    try { return exporter.exportRoundDetailJson(store, id, out); } catch (err) { return { error: { code: 'EXPORT_FAILED', message: String(err && err.message || err) } }; }
  });
  ipcMain.handle('analytics-export-raw', async (_e, opts) => {
    ensureRuntime();
    const o = opts || {};
    const scope = { captureSessionId: o.captureSessionId != null ? Number(o.captureSessionId) : null, browserId: o.browserId != null ? String(o.browserId) : null, fromMs: o.fromMs != null ? Number(o.fromMs) : null, toMs: o.toMs != null ? Number(o.toMs) : null };
    const out = await chooseSave('aviator-raw-events.jsonl', [{ name: 'JSON Lines', extensions: ['jsonl'] }]);
    if (!out) return { canceled: true };
    try { return exporter.exportRawEventsJsonl(store, scope, out); } catch (err) { return { error: { code: 'EXPORT_FAILED', message: String(err && err.message || err) } }; }
  });
  ipcMain.handle('analytics-backup-db', async () => {
    ensureRuntime();
    const out = await chooseSave('aviator-analytics-backup.db', [{ name: 'SQLite DB', extensions: ['db'] }]);
    if (!out) return { canceled: true };
    const res = await store.backup(out);
    if (res.error) return res;
    let integrity = null; try { integrity = AnalyticsStore.integrityCheck(out); } catch (err) { integrity = 'check_failed:' + String(err && err.message || err); }
    return { ...res, integrity };
  });

  // ---- read-only statistical analytics API (validated filter; no raw SQL) ----
  const stat = (fn) => (_e, filter, ...args) => {
    ensureRuntime();
    let spec;
    try { spec = normalizeFilter(filter || {}); }
    catch (err) { return { error: { code: err instanceof FilterError ? err.code : 'INVALID_FILTER', message: String(err && err.message || err) } }; }
    try { return fn(spec, ...args); } catch (err) { return { error: { code: 'ANALYTICS_QUERY_FAILED', message: String(err && err.message || err) } }; }
  };
  ipcMain.handle('analytics-stats-overview', stat((spec) => engine.overview(spec)));
  ipcMain.handle('analytics-stats-thresholds', stat((spec) => engine.thresholds(spec)));
  ipcMain.handle('analytics-stats-distribution', stat((spec) => engine.distribution(spec)));
  ipcMain.handle('analytics-stats-timing', stat((spec) => engine.timing(spec)));
  ipcMain.handle('analytics-stats-time-buckets', stat((spec, granularity) => engine.timeBuckets(spec, typeof granularity === 'string' ? granularity : '1h')));
  ipcMain.handle('analytics-stats-hourly', stat((spec) => engine.hourly(spec)));
  ipcMain.handle('analytics-stats-jackpot-buckets', stat((spec, bucketDefs) => engine.jackpotBuckets(spec, Array.isArray(bucketDefs) ? bucketDefs : undefined)));
  ipcMain.handle('analytics-stats-rolling', stat((spec, threshold, window) => engine.rolling(spec, clampNum(threshold, 2, 1.01, 100000), clampInt(window, 100, 2, 100000))));
  ipcMain.handle('analytics-stats-streaks', stat((spec) => engine.streaks(spec)));
  ipcMain.handle('analytics-stats-gaps', stat((spec) => engine.gaps(spec)));
  ipcMain.handle('analytics-stats-lastn', stat((spec) => engine.lastNSnapshot(spec)));

  // ---- WEB LOG (read-only; no replay/resend/edit/intercept) ----
  const guard = (fn) => (_e, ...args) => { ensureRuntime(); try { return fn(...args); } catch (err) { return { error: { code: 'WEBLOG_QUERY_FAILED', message: String(err && err.message || err) } }; } };
  ipcMain.handle('analytics-weblog-query', guard((filter, page) => webLog.query(filter || {}, page || {})));
  ipcMain.handle('analytics-weblog-detail', guard((kind, id) => webLog.detail(String(kind), id)));
  ipcMain.handle('analytics-weblog-summary', guard((filter) => webLog.summary(filter || {})));
  ipcMain.handle('analytics-weblog-ws-connection', guard((id) => webLog.wsConnection(id)));
  ipcMain.handle('analytics-weblog-ws-frames', guard((id, opts) => webLog.wsFrames(id, opts || {})));
  ipcMain.handle('analytics-net-overview', guard((filter) => netReport.overview(filter || {})));
  ipcMain.handle('analytics-net-endpoints', guard((filter) => netReport.endpoints(filter || {})));
  ipcMain.handle('analytics-net-hosts', guard((filter) => netReport.hosts(filter || {})));
  ipcMain.handle('analytics-net-timeline', guard((filter, granularity) => netReport.timeline(filter || {}, typeof granularity === 'string' ? granularity : '5m')));

  // ---- JACKPOT-FIRST report (read-only; validated round filter + jackpot config) ----
  const jr = (fn) => (_e, filter, jpConfig, ...args) => {
    ensureRuntime();
    let spec; try { spec = normalizeFilter(filter || {}); } catch (err) { return { error: { code: err instanceof FilterError ? err.code : 'INVALID_FILTER', message: String(err && err.message || err) } }; }
    try { return fn(spec, jpConfig || {}, ...args); } catch (err) { return { error: { code: 'REPORT_QUERY_FAILED', message: String(err && err.message || err) } }; }
  };
  ipcMain.handle('analytics-jr-overview', jr((spec, jp) => jackpotReport.overview(spec, jp)));
  ipcMain.handle('analytics-jr-lastn', jr((spec, jp) => jackpotReport.lastNByJackpot(spec, jp)));
  ipcMain.handle('analytics-jr-odd', jr((spec, jp) => jackpotReport.oddMatrix(spec, jp)));
  ipcMain.handle('analytics-jr-time', jr((spec, jp) => jackpotReport.timeByHour(spec, jp)));
  ipcMain.handle('analytics-jr-timing', jr((spec, jp, stat) => jackpotReport.timing(spec, jp, typeof stat === 'string' ? stat : 'median')));
  ipcMain.handle('analytics-jr-streak', jr((spec, jp) => jackpotReport.streak(spec, jp)));
  ipcMain.handle('analytics-jr-gap', jr((spec, jp) => jackpotReport.gap(spec, jp)));
  ipcMain.handle('analytics-jr-delta', jr((spec, jp) => jackpotReport.delta(spec, jp)));
  // StatEngine V1 — RETROSPECTIVE Jackpot↔outcome relationship analysis over the SAME
  // qualified population (never re-filters, never predicts).
  ipcMain.handle('analytics-jr-stats', jr((spec, jp) => jackpotReport.statistics(spec, jp)));
  // Forward Research V1 — leakage-safe, time-split, out-of-sample RESEARCH (not a predictor).
  ipcMain.handle('analytics-fwd-run', (_e, opts) => { ensureRuntime(); const o = opts || {}; try { return forwardResearch.run({ modelStage: String(o.modelStage || 'ROUND_OPEN'), target: o.target || { name: 'reached_2x', threshold: 2 }, browserId: o.browserId != null ? String(o.browserId) : null }); } catch (err) { return { error: { code: 'FWD_FAILED', message: String(err && err.message || err) } }; } });
  ipcMain.handle('analytics-fwd-matrix', (_e, opts) => { ensureRuntime(); const o = opts || {}; try { return forwardResearch.matrix({ browserId: o.browserId != null ? String(o.browserId) : null }); } catch (err) { return { error: { code: 'FWD_FAILED', message: String(err && err.message || err) } }; } });

  // ---- Prediction Research & Evaluation platform (descriptive/research only; NO action surface) ----
  const rsvc = (fn) => (_e, ...args) => { ensureRuntime(); try { return fn(research, ...args); } catch (err) { return { error: { code: 'RESEARCH_FAILED', message: String(err && err.message || err) } }; } };
  const str = (v) => (v != null ? String(v) : null);
  ipcMain.handle('analytics-research-algorithms', rsvc((s) => ({ algorithms: s.algorithms(), targets: s.targetList(), stages: s.stages() })));
  ipcMain.handle('analytics-research-overview', rsvc((s) => s.overview()));
  ipcMain.handle('analytics-research-readiness-matrix', rsvc((s, o) => s.readinessMatrix({ browserScope: str((o || {}).browserScope) })));
  ipcMain.handle('analytics-research-readiness', rsvc((s, o) => s.readiness({ algorithmId: String((o || {}).algorithmId), modelStage: String((o || {}).modelStage || 'ROUND_OPEN'), target: String((o || {}).target || 'reached_2x'), browserScope: str((o || {}).browserScope) })));
  ipcMain.handle('analytics-research-evaluate', rsvc((s, o) => s.evaluate({ algorithmId: String((o || {}).algorithmId), modelStage: String((o || {}).modelStage || 'ROUND_OPEN'), target: String((o || {}).target || 'reached_2x'), browserScope: str((o || {}).browserScope), persist: (o || {}).persist !== false })));
  ipcMain.handle('analytics-research-evaluate-all', rsvc((s, o) => s.evaluateAll({ browserScope: str((o || {}).browserScope), persist: (o || {}).persist !== false })));
  ipcMain.handle('analytics-research-history', rsvc((s, o) => s.history({ algorithmId: String((o || {}).algorithmId), version: (o || {}).version, target: String((o || {}).target || 'reached_2x'), modelStage: String((o || {}).modelStage || 'ROUND_OPEN'), browserScope: str((o || {}).browserScope) })));
  ipcMain.handle('analytics-research-run', rsvc((s, runId) => s.getRun(runId)));
  ipcMain.handle('analytics-research-compare', rsvc((s, o) => s.compare({ runIds: Array.isArray((o || {}).runIds) ? (o || {}).runIds : [] })));
  ipcMain.handle('analytics-research-drift', rsvc((s, o) => s.drift({ algorithmId: String((o || {}).algorithmId), version: (o || {}).version, target: String((o || {}).target || 'reached_2x'), modelStage: String((o || {}).modelStage || 'ROUND_OPEN'), browserScope: str((o || {}).browserScope) })));
  ipcMain.handle('analytics-research-monitoring', rsvc((s) => s.monitoring()));
  ipcMain.handle('analytics-research-family-monitoring', rsvc((s) => s.familyMonitoring()));
  ipcMain.handle('analytics-research-batches', rsvc((s) => s.batches()));
  ipcMain.handle('analytics-research-batch-runs', rsvc((s, o) => s.batchRuns(Number((o || {}).batchId))));
  ipcMain.handle('analytics-research-ledger', rsvc((s, runId) => s.ledger(runId)));
  ipcMain.handle('analytics-export-weblog', async (_e, filter) => {
    ensureRuntime();
    const out = await chooseSave('aviator-weblog.csv', [{ name: 'CSV', extensions: ['csv'] }]);
    if (!out) return { canceled: true };
    try { return exporter.exportWebLogCsv(webLog, normalizeNetworkFilter(filter || {}), out); } catch (err) { return { error: { code: 'EXPORT_FAILED', message: String(err && err.message || err) } }; }
  });
}

function clampNum(v, def, lo, hi) { const n = Number(v); if (!Number.isFinite(n)) return def; return Math.max(lo, Math.min(hi, n)); }

function clampInt(v, def, lo, hi) { const n = Number(v); if (!Number.isFinite(n)) return def; return Math.max(lo, Math.min(hi, Math.trunc(n))); }

app.whenReady().then(() => {
  // Scheme mapped to the Analytics renderer folder only (never the Control UI).
  protocol.registerFileProtocol('analytics-app', (request, callback) => {
    const pathname = new URL(request.url).pathname.replace(/^\/+/, '');
    callback({ path: path.join(__dirname, '..', 'ui-analytics', pathname) });
  });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  try { if (runtime) for (const b of runtime.listBrowsers()) if (b.open) runtime.close(b.browserId); } catch { /* best effort */ }
  try { if (store) store.close(); } catch { /* best effort */ }
});

module.exports = { PRODUCT_NAME, ANALYTICS_USERDATA };
