const { app, BrowserWindow, ipcMain, protocol, net, dialog, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { EventJournal } = require('./event-journal.cjs');
const { normalizeCaptureEvent } = require('./event-contract.cjs');
const CDP = require('chrome-remote-interface');
const { TargetManager } = require('./cdp/target-manager.cjs');
const androidBridge = require('./cdp/android-bridge.cjs');
const { CaptureCorrelator } = require('./cdp/capture.cjs');
const { InteractionTracker } = require('./cdp/interaction-tracker.cjs');
const { WsReplay } = require('./cdp/ws-replay.cjs');
const { InterceptEngine } = require('./cdp/intercept.cjs');
const { CookieVault, hostMatches } = require('./cookie-vault.cjs');
const { ReplayEngine } = require('./replay/replay-engine.cjs');
const { Timeline } = require('./timeline.cjs');
// Tier 2: the crown-jewel protocol modules (aviator/harness/observer/runners) are
// sealed ciphertext and are required lazily inside initProtocolSubsystem(), only
// after a valid license unlocks the seal key. Do NOT require them here.
const { resolveBounds, DEFAULTS: WIN_DEFAULTS } = require('./window-state.cjs');
const { CdpError } = require('./cdp/errors.cjs');
const { environmentGuardEnabled } = require('./protocol/environment-gate.cjs');
const { InstanceManager } = require('./instance/instance-manager.cjs');
const { ChromeLauncher } = require('./browser/chrome-launcher.cjs');
const { LicenseGuard } = require('./licensing/license-guard.cjs');
const { deriveFeatureKey } = require('./licensing/feature-key.cjs');
const { install: installSealedLoader, SEALED_BASENAMES } = require('./protocol/sealed-loader.cjs');
const { BrowserRunManager, STATUS: RUN_STATUS } = require('./browser-run/browser-run-manager.cjs');
const { BrowserRegistry } = require('./browser-run/browser-registry.cjs');
const { AviatorEntryGate } = require('./protocol/aviator-entry.cjs');

let shell;
const capturedClients = new WeakSet();
let allowedHosts = new Set();
let capturePaused = false;
let sessionId = randomUUID();
let journal;
let licenseGuard;
// Tier 2: the sealed protocol classes are unlocked once per valid license
// (unsealProtocolClasses) and cached here. Each BrowserRun instantiates its OWN
// subsystem from them via buildProtocolSubsystem(); nothing protocol-related is a
// process-wide singleton. Every IPC that touches a subsystem is Tier-1 gated.
let protocolClasses = null;
// WU-A: ownership layer. One BrowserRun per "Open Browser", each owning its
// browser process, TargetManager and protocol subsystem.
let runManager = null;
// WU-C.1: persistent browser identity/profile ownership, separate from runtime runs.
let browserRegistry = null;
let importStarted = false;
let importInProgress = false;
let importTimer;
const protocolEnvironmentGuard = environmentGuardEnabled();
const baseUserDataPath = app.getPath('userData');
const instanceManager = new InstanceManager({ baseUserDataPath, argv: process.argv, env: process.env });
const instanceStart = instanceManager.start();
if (!instanceStart.ok) {
  throw new Error(instanceStart.error && instanceStart.error.message || 'Instance startup failed');
}
const appInstance = instanceStart;
app.setPath('userData', appInstance.paths.appData);

// Per-run browser profile. A persistent browser owns a STABLE profileDir (WU-C.1),
// reused across every open. Runs with no persistent owner (Advanced Debug / external
// attach) fall back to a runtime dir: run #1 reuses the instance profile (keeps
// existing verification setup), others get a per-run dir. Chrome locks a profile to
// one process, so concurrent persistent browsers each carry their own free port.
function runProfilePath(run) {
  if (run.profileDir) return run.profileDir; // persistent browser owns it
  return run.ordinal === 0 ? appInstance.paths.chromeProfile : path.join(appInstance.paths.chromeProfile, 'runs', run.id);
}
function runLauncherEnv(run) {
  if (!run.profileDir && run.ordinal === 0) return process.env; // legacy/advanced first run honours env overrides
  const env = { ...process.env };
  delete env.OBSERVATORY_CDP_PORT;     // force a fresh free port per concurrent run
  delete env.OBSERVATORY_CHROME_PROFILE; // use this run's own profile dir, not a shared override
  return env;
}

// ---- WU-C.1 persistent browser registry + license entitlement ----
// Browser capacity comes from VERIFIED license state: a future signed license may
// carry `maxBrowsers`; until then it is unlimited (null). An OBSERVATORY_MAX_BROWSERS
// env override exists as an ops/testing seam. The renderer never supplies this value.
function browserEntitlement() {
  const s = licenseGuard && licenseGuard.status ? licenseGuard.status() : null;
  const payload = s && s.payload ? s.payload : null;
  if (payload && payload.maxBrowsers != null && Number.isFinite(Number(payload.maxBrowsers))) return { maxBrowsers: Math.max(0, Number(payload.maxBrowsers)) };
  const envMax = process.env.OBSERVATORY_MAX_BROWSERS;
  if (envMax != null && envMax !== '' && Number.isFinite(Number(envMax))) return { maxBrowsers: Math.max(0, Number(envMax)) };
  return { maxBrowsers: null }; // unlimited when no signed/ops limit is present
}
function ensureBrowserRegistry() {
  if (browserRegistry) return browserRegistry;
  browserRegistry = new BrowserRegistry({
    filePath: path.join(appInstance.paths.root, 'browser-registry.json'),
    profilesRoot: path.join(appInstance.paths.root, 'browser-profiles'),
    entitlement: browserEntitlement,
  });
  const res = browserRegistry.load();
  if (res && res.error && shell && !shell.isDestroyed()) shell.webContents.send('cdp-error', res.error);
  return browserRegistry;
}
function createRunLauncher(run) {
  return new ChromeLauncher({
    profilePath: runProfilePath(run),
    env: runLauncherEnv(run),
    onRuntime: (patch) => appInstance.lock.update(patch),
    onExit: () => { if (runManager) runManager.closeRun(run.id).catch(() => {}); },
  });
}
// Snapshot of the active run's launcher for instance-info; safe default when idle.
function activeLauncherSnapshot() {
  const run = runManager && runManager.activeRun();
  if (run && run.launcher) return run.launcher.snapshot();
  return { cdpPort: null, chromePid: null, chromeProfile: appInstance.paths.chromeProfile };
}

function importJournalOnExit() {
  if (importStarted || !journal) return null;
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database) return null;
  importStarted = true;
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  const journalPath = path.join(appInstance.paths.sessions, sessionId + '.jsonl');
  return spawn(python, ['-m', 'websec_observer.cli.main', 'import-journal', journalPath, database, sessionId], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'ignore' });
}

function importJournalNow() {
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database || importInProgress || !journal) return;
  importInProgress = true;
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  const journalPath = path.join(appInstance.paths.sessions, sessionId + '.jsonl');
  const child = spawn(python, ['-m', 'websec_observer.cli.main', 'import-journal', journalPath, database, sessionId], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'ignore' });
  child.once('close', () => { importInProgress = false; });
  child.once('error', () => { importInProgress = false; });
}

function inScope(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    return allowedHosts.size === 0 || [...allowedHosts].some(pattern => pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1))));
  } catch { return false; }
}
function safeDisplayUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) if (/token|secret|password|key|session|auth/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    url.username = ''; url.password = '';
    return url.toString();
  } catch { return '[REDACTED URL]'; }
}
function safeHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) output[key] = /authorization|cookie|token|secret|api[-_]?key|password/i.test(key) ? '[REDACTED]' : String(value).slice(0, 1000);
  return output;
}

function emit(event) {
  // Tag evidence with the owning BrowserRun (by target). All runs are journaled;
  // the single-stream renderer only shows the ACTIVE run so lists stay coherent.
  const run = event && event.targetId != null && runManager ? runManager.runForTarget(event.targetId) : null;
  const normalized = normalizeCaptureEvent({ ...event, browserRunId: run ? run.id : (event && event.browserRunId) }, sessionId);
  if (!normalized) return;
  try { journal?.append(normalized); } catch { /* journal failure must not stop capture */ }
  const activeId = runManager ? runManager.activeRunId() : null;
  const forActive = !run || !activeId || run.id === activeId;
  if (forActive && shell && !shell.isDestroyed()) shell.webContents.send('capture-event', normalized);
}

function windowStatePath() { return appInstance.paths.windowState; }
function loadWindowState() { try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); } catch { return null; } }
function saveWindowState() { try { if (shell && !shell.isDestroyed() && !shell.isMinimized()) fs.writeFileSync(windowStatePath(), JSON.stringify(shell.getBounds()), 'utf8'); } catch { /* best effort */ } }

function migrateLegacyInstanceLicense() {
  const licensePath = path.join(baseUserDataPath, 'license.dat');
  if (fs.existsSync(licensePath)) return;
  const roots = path.join(baseUserDataPath, 'instances');
  let candidates = [];
  try {
    candidates = fs.readdirSync(roots, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(roots, entry.name, 'app', 'license.dat'))
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch { candidates = []; }
  if (!candidates.length) return;
  try {
    fs.copyFileSync(candidates[0].file, licensePath);
    const statePath = path.join(path.dirname(candidates[0].file), 'license-state.dat');
    if (fs.existsSync(statePath)) fs.copyFileSync(statePath, path.join(baseUserDataPath, 'license-state.dat'));
  } catch { /* best-effort migration; activation screen remains available */ }
}

function createWindow() {
  // Compact by default (Protocol Test tool, not an IDE); restore saved bounds if valid.
  if (!licenseGuard) {
    migrateLegacyInstanceLicense();
    licenseGuard = new LicenseGuard({ userDataPath: baseUserDataPath, safeStorage });
    ensureProtocolSubsystem(licenseGuard.initialize());
    licenseGuard.initializeAsync().then((status) => {
      ensureProtocolSubsystem(status);
      if (shell && !shell.isDestroyed()) shell.webContents.send('license-changed', status);
    }).catch(() => {});
  }
  const bounds = resolveBounds(loadWindowState());
  shell = new BrowserWindow({ ...bounds, minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight, backgroundColor: '#f4f6f8', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true } });
  shell.on('close', saveWindowState);
  const journalPath = path.join(appInstance.paths.sessions, sessionId + '.jsonl');
  journal = new EventJournal(journalPath);
  importTimer = setInterval(importJournalNow, 10_000);
  cookieVault = new CookieVault(appInstance.paths.cookieVault);
  // WU-C.1: load the persistent browser registry now so a corrupt file is reported
  // early and the rail can render registered browsers as OFFLINE at startup.
  ensureBrowserRegistry();
  // Auto-save the session so a fresh login is captured for next time.
  const cookieTimer = setInterval(() => { const tid = activeSelectedTargetId(); if (tid) saveCookiesFor(tid).catch(() => {}); }, 12_000);
  if (cookieTimer.unref) cookieTimer.unref();
  shell.loadURL('app://ui/product.html');
}

// WU-A: each Open Browser creates a NEW BrowserRun that owns its own Chrome
// process, TargetManager and protocol subsystem. A second press never reuses the
// first run's state — it creates BR-0002, and so on.
async function openBrowserWindow(url) {
  ensureRunManager();
  const run = runManager.createRun({ launchUrl: String(url) });
  runManager.setActive(run.id);
  const launched = await run.launcher.open(url);
  if (!launched.ok) { runManager.failRun(run, launched.error); return false; }
  run.cdpEndpoint = launched.endpoint;
  connectRunEndpointWithRetry(run, launched.endpoint);
  return true;
}

// Unlock the sealed protocol classes the moment a license verifies active. Safe to
// call with any status (no-op unless active) and idempotent. Each BrowserRun then
// instantiates its own subsystem from the cached classes. Failure to unlock is
// surfaced but must not crash the license flow.
function ensureProtocolSubsystem(status) {
  try { if (status && status.active) unsealProtocolClasses(); }
  catch (err) { if (shell && !shell.isDestroyed()) shell.webContents.send('cdp-error', { code: 'FEATURE_UNLOCK_FAILED', message: String((err && err.message) || err) }); }
  return status;
}

async function licenseStatus() {
  if (!licenseGuard) return { active: false, checking: false, error: { code: 'LICENSE_MISSING', message: 'License guard is not ready' } };
  let status = licenseGuard.status();
  if (status.active) status = await licenseGuard.refreshAsync({ consumeLaunch: false });
  else if (status.checking || (!status.active && status.error && status.error.code === 'TRUSTED_TIME_UNAVAILABLE')) {
    status = await licenseGuard.refreshAsync();
  }
  return ensureProtocolSubsystem(status);
}
// Newly launched Chrome needs ~1s before its CDP endpoint answers; retry connect.
async function connectRunEndpointWithRetry(run, endpoint, attempt = 0) {
  const result = await connectRunEndpoint(run, endpoint);
  if (!result.ok && attempt < 12 && run.status !== RUN_STATUS.CLOSED) {
    setTimeout(() => connectRunEndpointWithRetry(run, endpoint, attempt + 1), 1000);
  }
  return result;
}

// Shared correlator: holds RAW evidence (unredacted) for all attached targets and
// resolves response bodies through each request's OWN target client. With multiple
// runs, targetIds are globally unique, so we resolve the owning run's TargetManager.
function resolveTargetClient(targetId) {
  const run = runManager && runManager.runForTarget(targetId);
  const s = run && run.targetManager && run.targetManager.getSession(targetId);
  return s ? s.client : null;
}
function resolveTargetSession(targetId) {
  const run = runManager && runManager.runForTarget(targetId);
  return run && run.targetManager ? run.targetManager.getSession(targetId) : undefined;
}
const capture = new CaptureCorrelator({ resolveClient: resolveTargetClient });
// User-action tracking: records clicks in the target (page + iframes) and links
// each click to the requests it triggers, so you can see which action fired which
// request. Correlation is time-based on the same target.
const interactions = new InteractionTracker();
interactions.on('interaction', ev => emit({ kind: 'interaction', id: ev.id, targetId: ev.targetId, text: ev.text, tag: ev.tag, selector: ev.selector, url: ev.url, timestamp: ev.timestamp }));
// WebSocket "replace": resend a captured frame (with edited payload) over the
// page's own live socket — the only way to replay WS, since CDP can't inject frames.
const wsReplay = new WsReplay({ resolveClient: resolveTargetClient, getCaptured: id => capture.get(id) });
// WU4: live request interception (Fetch domain), target-bound.
const intercept = new InterceptEngine({ resolveClient: resolveTargetClient });
intercept.on('changed', () => { if (shell && !shell.isDestroyed()) shell.webContents.send('intercept-changed', intercept.listPaused()); });
// WU3: replay is driven from the immutable CapturedRequest held by `capture`.
const replay = new ReplayEngine({
  getCaptured: id => capture.get(id),
  resolveClient: resolveTargetClient,
  httpFetch: async (url, opts) => {
    const response = await net.fetch(url, { method: opts.method, headers: opts.headers, body: ['GET', 'HEAD'].includes(opts.method) ? undefined : opts.body });
    const text = await response.text();
    const headers = {}; response.headers.forEach((v, k) => { headers[k] = v; });
    return { status: response.status, statusText: response.statusText, headers, body: text };
  },
});
// WU5: read-only aggregation of capture + replay + intercept evidence.
const timeline = new Timeline({ capture, replay, intercept });
// WU7+: the Aviator protocol subsystem (RoundTracker, harness, observer, runners) is
// the crown-jewel logic. Its modules ship as sealed ciphertext and are only decrypted
// here — AFTER a genuine, machine-matched license unlocks the seal key. We unlock the
// CLASSES once (they do not exist in runnable form until a valid license is present),
// then every BrowserRun instantiates its OWN subsystem from them. Idempotent.
function unsealProtocolClasses() {
  if (protocolClasses) return protocolClasses;
  const license = licenseGuard && licenseGuard.storedLicense ? licenseGuard.storedLicense() : null;
  const key = deriveFeatureKey({ license, machineId: licenseGuard ? licenseGuard.machineId() : null });
  installSealedLoader({ key, files: SEALED_BASENAMES.map((name) => path.join(__dirname, 'protocol', `${name}.cjs`)) });
  const { RoundTracker } = require('./protocol/aviator.cjs');
  const { ProtocolHarness } = require('./protocol/harness.cjs');
  const { RoundObserver } = require('./protocol/round-observer.cjs');
  const { AutoRunner } = require('./protocol/auto-runner.cjs');
  const { AmountValidator } = require('./protocol/amount-validator.cjs');
  const { ProtocolContext } = require('./protocol/protocol-context.cjs');
  protocolClasses = { RoundTracker, ProtocolHarness, RoundObserver, AutoRunner, AmountValidator, ProtocolContext };
  return protocolClasses;
}

// Build ONE run's protocol subsystem. Every instance is bound to `run`: its events
// are tagged with run.id and only forwarded to the renderer while this run is the
// active run (the WU-A renderer shows a single stream). The send seam + getTargetUrl
// resolve through the run's own TargetManager.
function buildProtocolSubsystem(run) {
  const C = unsealProtocolClasses();
  const getTargetUrl = (targetId) => { const s = run.targetManager && run.targetManager.getSession(targetId); return s ? s.target.url : ''; };
  const toActive = (channel, payload) => { if (runManager && runManager.isActive(run) && shell && !shell.isDestroyed()) shell.webContents.send(channel, payload); };

  const aviator = new C.RoundTracker();
  aviator.on('round', r => { toActive('aviator-round', r); scheduleRunsBroadcast(); });
  aviator.on('actiontrace', t => toActive('aviator-actiontrace', t));

  // Session aid/eid — learned from observed frames, owned per run (never hardcoded).
  const protocolContext = new C.ProtocolContext({ roundTracker: aviator });
  protocolContext.on('change', c => { toActive('protocol-context', c); scheduleRunsBroadcast(); });

  // Protocol Test Harness — sender bound to this run's own live socket.
  const harness = new C.ProtocolHarness({
    roundTracker: aviator,
    send: (ctx, payload) => wsReplay.sendProtocol(ctx, payload),
    getTargetUrl,
    allowlist: (process.env.OBSERVATORY_TEST_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),
    environmentGuard: protocolEnvironmentGuard,
  });
  harness.on('execution', ex => {
    try { journal?.append(normalizeCaptureEvent({ kind: 'protocol-test', id: ex.id, targetId: ex.targetId, browserRunId: run.id, timestamp: ex.sentAt, exec: ex }, sessionId)); } catch { /* journal failure must not stop testing */ }
    toActive('protocol-execution', ex);
  });

  // READ-ONLY multi-round observer over this run's frame stream.
  const observer = new C.RoundObserver({ roundTracker: aviator });
  let observerDirty = false;
  observer.on('update', () => {
    scheduleRunsBroadcast();
    if (observerDirty) return; observerDirty = true;
    setTimeout(() => { observerDirty = false; toActive('observer-update', observer.snapshot()); }, 120);
  });

  // Automated round runner, bound to this run's observer + harness.
  const autoRunner = new C.AutoRunner({ roundTracker: aviator, observer, harness, getTargetUrl, environmentGuard: protocolEnvironmentGuard });
  let autoDirty = false;
  autoRunner.on('update', () => {
    if (runManager && autoRunner.isRunning()) runManager.setStatus(run, RUN_STATUS.AUTO_RUNNING);
    scheduleRunsBroadcast();
    if (autoDirty) return; autoDirty = true;
    setTimeout(() => { autoDirty = false; toActive('autotest-update', autoRunner.snapshot()); }, 100);
  });

  // Separate bet-amount server-validation mode (bet-only; sends the EXACT value).
  const amountValidator = new C.AmountValidator({ roundTracker: aviator, harness, getTargetUrl, environmentGuard: protocolEnvironmentGuard });
  let bvalDirty = false;
  amountValidator.on('update', () => {
    scheduleRunsBroadcast();
    if (bvalDirty) return; bvalDirty = true;
    setTimeout(() => { bvalDirty = false; toActive('bvalidate-update', amountValidator.snapshot()); }, 100);
  });

  // WU-C.1.1 — Aviator entry gate. Bound to THIS run's aviator (passive evidence) and
  // its OWN socket context (the enter request rides only this run's connection).
  const entryGate = new AviatorEntryGate({
    roundTracker: aviator,
    send: (ctx, wire) => wsReplay.sendProtocol(ctx, wire),
    getContext: () => { const tid = run.selectedTargetId; return tid != null ? aviator.socketContext(tid) : null; },
  });
  entryGate.on('state', () => scheduleRunsBroadcast());
  entryGate.on('entered', () => scheduleRunsBroadcast());

  return { aviator, protocolContext, observer, harness, autoRunner, amountValidator, entryGate };
}

// Lazily construct the BrowserRunManager and register the ONE shared capture->run
// frame router. Frames are routed to the owning run's aviator by targetId.
function ensureRunManager() {
  if (runManager) return runManager;
  runManager = new BrowserRunManager({
    createLauncher: createRunLauncher,
    createTargetManager: (endpoint) => new TargetManager(endpoint),
    buildSubsystem: buildProtocolSubsystem,
  });
  runManager.on('run-updated', () => { broadcastRuns(); broadcastBrowsers(); });
  runManager.on('run-created', () => { broadcastRuns(); broadcastBrowsers(); });
  runManager.on('run-closed', () => { broadcastRuns(); broadcastBrowsers(); });
  runManager.on('active-changed', () => { broadcastTargets(); broadcastRuns(); broadcastBrowsers(); });
  // Shared WS frame stream -> the owning run's protocol subsystem (never global).
  capture.on('request', req => {
    if (!req || !req.isWebSocket || !req.wsDirection) return;
    const run = runManager.runForTarget(req.targetId);
    if (run && run.aviator) run.aviator.observe({ targetId: req.targetId, cdpSessionId: req.cdpSessionId, url: req.url, direction: req.wsDirection, raw: req.body && req.body.raw });
  });
  return runManager;
}
function broadcastRuns() { if (shell && !shell.isDestroyed() && runManager) shell.webContents.send('runs-changed', runManager.list()); }

// WU-C.1 — the run rail now shows PERSISTENT browsers. A browser summary joins the
// registered record with its live run's summary (if any). Offline browsers carry no
// runtime values; live ones read them from the owning BrowserRun. No raw frame is
// forwarded — only the same coalesced aggregate summaries as WU-C.
function browserSummaries() {
  ensureBrowserRegistry();
  const capacity = browserRegistry.capacity();
  const browsers = browserRegistry.list().map((b) => {
    const run = runManager ? runManager.liveRunForBrowser(b.id) : null;
    const rs = run ? runManager.summary(run) : null;
    return {
      browserId: b.id, name: b.name, launchUrl: b.launchUrl, lastOpenedAt: b.lastOpenedAt, lastRunId: b.lastRunId,
      online: !!run, runId: run ? run.id : null, active: !!(run && runManager.isActive(run)),
      runtimeStatus: rs ? rs.status : 'OFFLINE',
      protocolReady: rs ? rs.protocolReady : false,
      currentSid: rs ? rs.currentSid : null, currentOdd: rs ? rs.currentOdd : null, phase: rs ? rs.phase : null,
      autoRunning: rs ? rs.autoRunning : false, testRunning: rs ? rs.testRunning : false,
      aviatorEntered: rs ? rs.aviatorEntered : false, entryState: rs ? rs.entryState : 'NOT_ENTERED',
      error: rs ? rs.error : null,
    };
  });
  return { browsers, capacity };
}
function broadcastBrowsers() { if (shell && !shell.isDestroyed()) shell.webContents.send('browsers-changed', browserSummaries()); }

// Coalesced live-summary push (WU-C). ODD frames can be frequent and there may be
// several runs, so we throttle instead of emitting per frame. Summaries are built
// from each run's own state — no raw frame is forwarded.
let _runsBroadcastTimer = null;
function scheduleRunsBroadcast() {
  if (_runsBroadcastTimer || !runManager) return;
  _runsBroadcastTimer = setTimeout(() => { _runsBroadcastTimer = null; broadcastRuns(); broadcastBrowsers(); }, 300);
  if (_runsBroadcastTimer.unref) _runsBroadcastTimer.unref();
}

// ---- WU-C.1 persistent browser lifecycle ----
// Open a registered browser: enforce one live run per persistent browser (never
// launch the same profileDir twice), link the new BrowserRun to browserId, and
// launch with the browser's stable profile. Never restores stale protocol state.
async function openPersistentBrowser(browserId) {
  ensureRunManager(); ensureBrowserRegistry();
  const browser = browserRegistry.get(String(browserId || ''));
  if (!browser) return { ok: false, error: { code: 'BROWSER_NOT_FOUND', message: 'No such browser' } };
  const existing = runManager.liveRunForBrowser(browser.id);
  if (existing) { runManager.setActive(existing.id); broadcastTargets(); broadcastBrowsers(); return { ok: true, runId: existing.id, browserId: browser.id, alreadyRunning: true }; }
  const run = runManager.createRun({ launchUrl: browser.launchUrl, browserId: browser.id, profileDir: browser.profileDir });
  runManager.setActive(run.id);
  browserRegistry.touchOpened(browser.id, run.id);
  broadcastBrowsers();
  const launched = await run.launcher.open(browser.launchUrl);
  if (!launched.ok) { runManager.failRun(run, launched.error); broadcastBrowsers(); return { ok: false, error: launched.error, browserId: browser.id, runId: run.id }; }
  run.cdpEndpoint = launched.endpoint;
  connectRunEndpointWithRetry(run, launched.endpoint);
  return { ok: true, runId: run.id, browserId: browser.id };
}
// Create a new persistent browser (capacity-checked in the registry), then open it.
async function createPersistentBrowser({ name, url } = {}) {
  ensureBrowserRegistry();
  const res = browserRegistry.create({ name, launchUrl: url });
  broadcastBrowsers();
  if (res.error) return { ok: false, error: res.error };
  const opened = await openPersistentBrowser(res.browser.id);
  return { ok: opened.ok, browserId: res.browser.id, runId: opened.runId, error: opened.error };
}
// Delete a persistent browser record (conservative: profile dir is retained). Refuse
// while a live run exists — Close is not Delete.
async function deletePersistentBrowser(browserId) {
  ensureRunManager(); ensureBrowserRegistry();
  if (runManager.liveRunForBrowser(String(browserId || ''))) return { ok: false, error: { code: 'BROWSER_ALREADY_RUNNING', message: 'Close the browser before deleting it.' } };
  const res = browserRegistry.remove(String(browserId || ''));
  broadcastBrowsers();
  return res.error ? { ok: false, error: res.error } : { ok: true, profileRetained: res.profileRetained };
}
// Persistent session store (cookies) — independent of launching Chrome, so a
// login survives reconnects on Chrome / WebView / WebView2 / CEF alike.
let cookieVault;
// Active run's currently-selected target (auto-selected first attachable, or the
// user's pick). Used by IPC handlers that historically relied on `selectedTargetId`.
function activeRun() { return runManager ? runManager.activeRun() : null; }
function activeSelectedTargetId() { const r = activeRun(); return r ? r.selectedTargetId : null; }
// Read-only "idle" subsystem so snapshot/context IPC has a well-formed shape to
// return before any browser is open. It is never wired to a live socket (its
// aviator is never fed a frame), so it always reports empty/idle state.
let _idleRun = null;
function idleRun() {
  if (_idleRun) return _idleRun;
  ensureRunManager();
  _idleRun = { id: 'BR-IDLE', ordinal: -1, status: 'IDLE', targetManager: null, selectedTargetId: null };
  Object.assign(_idleRun, buildProtocolSubsystem(_idleRun));
  return _idleRun;
}
// The run whose protocol subsystem answers a read-only protocol IPC when no runId
// is supplied: the active run, or the idle provider when no browser is open yet.
function protoRun() { return activeRun() || idleRun(); }

// EXECUTION ownership is ALWAYS explicit (WU-B): a bet/cashout/auto/b-Test run binds
// to the run named by the caller, NEVER to the active-run view pointer. Switching
// the active run in the UI therefore cannot retarget a running execution.
function execRun(runId) {
  const id = runId != null ? String(runId) : '';
  const run = id && runManager ? runManager.get(id) : null;
  if (!run) return { error: { code: 'RUN_NOT_FOUND', message: 'No such browser run — open a browser and pass its runId.' } };
  if (run.status === RUN_STATUS.CLOSED) return { error: { code: 'RUN_CLOSED', message: 'Browser run is closed.' } };
  return { run };
}
// Read-only DISPLAY ownership: the named run if given, else the active/idle provider.
function viewRun(runId) {
  const id = runId != null ? String(runId) : '';
  const named = id && runManager ? runManager.get(id) : null;
  return named || protoRun();
}
function targetHost(targetId) { const s = resolveTargetSession(targetId); try { return s ? new URL(s.target.url).hostname : ''; } catch { return ''; } }
async function saveCookiesFor(targetId) {
  const client = resolveTargetClient(targetId);
  if (!client || !cookieVault) return { ok: false, error: { code: 'TARGET_CONTEXT_UNAVAILABLE', message: 'No attached target' } };
  try { const { cookies } = await client.Network.getAllCookies(); return { ok: true, count: cookieVault.save(cookies), host: targetHost(targetId) }; }
  catch (e) { return { ok: false, error: { code: 'COOKIE_SAVE_FAILED', message: String(e && e.message || e) } }; }
}
async function restoreCookiesFor(targetId, reload) {
  const client = resolveTargetClient(targetId);
  if (!client || !cookieVault) return { ok: false, error: { code: 'TARGET_CONTEXT_UNAVAILABLE', message: 'No attached target' } };
  const host = targetHost(targetId);
  const params = host ? cookieVault.paramsForHost(host) : [];
  if (!params.length) return { ok: true, count: 0, host };
  try { await client.Network.setCookies({ cookies: params }); if (reload) { try { await client.Page.reload(); } catch { /* ignore */ } } return { ok: true, count: params.length, host }; }
  catch (e) { return { ok: false, error: { code: 'COOKIE_RESTORE_FAILED', message: String(e && e.message || e) } }; }
}
// On attach, restore the saved session ONLY if the target has none for its host
// (never clobber a live/newer login).
async function autoRestoreOnAttach(targetId) {
  const client = resolveTargetClient(targetId); const host = targetHost(targetId);
  if (!client || !cookieVault || !host || !cookieVault.hasForHost(host)) return;
  try {
    const { cookies } = await client.Network.getAllCookies();
    if ((cookies || []).some((c) => hostMatches(host, c.domain))) return;
    const params = cookieVault.paramsForHost(host);
    if (params.length) await client.Network.setCookies({ cookies: params });
  } catch { /* best effort */ }
}
// Bridge raw model -> the existing display/journal pipeline (which may mask
// secrets for display only; raw evidence stays in `capture`).
capture.on('request', req => {
  let origin = '/';
  try { origin = new URL(req.url).origin + '/'; } catch { /* opaque */ }
  const allowed = inScope(req.url);
  // Attribute meaningful requests (the ones a click actually fires) to the most
  // recent click on this target; noise like images/scripts is left unlinked.
  const rt = String(req.resourceType || 'other').toLowerCase();
  const causedBy = (rt === 'fetch' || rt === 'xhr' || rt === 'websocket') ? interactions.linkRequest(req) : null;
  emit({ kind: 'request', id: req.id, requestId: req.cdpRequestId, targetId: req.targetId, method: req.method, url: allowed ? safeDisplayUrl(req.url) : origin, resourceType: rt, scope: allowed ? 'allow_full' : 'allow_metadata_only', headers: allowed ? safeHeaders(req.headers) : {}, bodyPreview: allowed ? String((req.body && req.body.raw) || '').slice(0, 4000) : null, causedBy, timestamp: req.startedAt });
});
capture.on('response', req => { if (!req.response) return; emit({ kind: 'response', id: req.id, requestId: req.cdpRequestId, targetId: req.targetId, url: safeDisplayUrl(req.url), status: req.response.status, duration: Math.round(req.durationMs || 0), timestamp: new Date().toISOString() }); });
capture.on('update', req => { if (req.state === 'BODY_AVAILABLE' && req.response) emit({ kind: 'response', id: req.id, requestId: req.cdpRequestId, targetId: req.targetId, url: safeDisplayUrl(req.url), status: req.response.status, duration: Math.round(req.durationMs || 0), timestamp: new Date().toISOString() }); });

// WU2: attach full network capture to a target's own CDP client and route every
// event through the shared correlator, tagged with this target's id.
async function attachCdpCapture(client, target) {
  if (capturedClients.has(client)) return;
  capturedClients.add(client);
  const { Network } = client;
  const tid = target.cdpTargetId;
  try { await Network.enable(); } catch { return; }
  // CRI passes (params, sessionId): sessionId is undefined for this page's own
  // session and set for flattened child sessions (OOPIF / worker) — see below.
  Network.requestWillBeSent((p, sid) => capture.onRequestWillBeSent(tid, p, sid));
  Network.requestWillBeSentExtraInfo((p, sid) => capture.onRequestWillBeSentExtraInfo(tid, p, sid));
  Network.responseReceived((p, sid) => capture.onResponseReceived(tid, p, sid));
  Network.responseReceivedExtraInfo((p, sid) => capture.onResponseReceivedExtraInfo(tid, p, sid));
  Network.loadingFinished((p, sid) => capture.onLoadingFinished(tid, p, sid));
  Network.loadingFailed((p, sid) => capture.onLoadingFailed(tid, p, sid));
  // WebSocket frames — the bet/action of real-time games rides here, not HTTP.
  Network.webSocketCreated((p, sid) => capture.onWebSocketCreated(tid, p, sid));
  Network.webSocketWillSendHandshakeRequest((p, sid) => capture.onWebSocketWillSendHandshakeRequest(tid, p, sid));
  Network.webSocketHandshakeResponseReceived((p, sid) => capture.onWebSocketHandshakeResponseReceived(tid, p, sid));
  Network.webSocketFrameSent((p, sid) => capture.onWebSocketFrameSent(tid, p, sid));
  Network.webSocketFrameReceived((p, sid) => capture.onWebSocketFrameReceived(tid, p, sid));
  Network.webSocketClosed((p, sid) => capture.onWebSocketClosed(tid, p, sid));
  // Fetch events only fire once intercept.enable() calls Fetch.enable on this
  // client; harmless to subscribe always.
  client.Fetch.requestPaused((p, sid) => intercept.onRequestPaused(tid, p, sid));

  // Fix A: cross-origin iframes (OOPIFs) and workers run in their OWN CDP
  // session, so their network events never reach the page session. Auto-attach
  // (flatten) multiplexes those child sessions over THIS connection; we enable
  // Network on each so the game's requests/WS — often inside an embedded iframe —
  // are captured. Child events arrive on the handlers above with `sid` set.
  const autoAttachArgs = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
  try { await client.Target.setAutoAttach(autoAttachArgs); } catch { /* target may not support it */ }
  client.Target.attachedToTarget(async ({ sessionId, targetInfo }) => {
    const type = targetInfo && targetInfo.type;
    // Top-level pages/popups are discovered by the poll loop and get their own
    // dedicated client; capturing them here too would double-count. Only child
    // frames (OOPIF) and workers need this session.
    if (type === 'page') return;
    try {
      await client.Network.enable({}, sessionId);
      // Recurse so nested OOPIFs / workers under this child also attach.
      await client.Target.setAutoAttach(autoAttachArgs, sessionId);
    } catch { /* child gone or unsupported */ }
    // The game's buttons AND its WebSocket usually live in a cross-origin iframe —
    // inject the click hook + WS send-hook there too.
    if (type === 'iframe') {
      interactions.injectSession(client, tid, sessionId).catch(() => {});
      wsReplay.injectSession(client, sessionId).catch(() => {});
    }
  });
  // Root-session click tracking + WS send-hook.
  interactions.attach(client, tid).catch(() => {});
  wsReplay.injectSession(client, undefined).catch(() => {});
}

// The renderer (WU-A, single-stream UI) shows the ACTIVE run's targets.
function broadcastTargets() {
  const run = activeRun();
  if (shell && !shell.isDestroyed() && run && run.targetManager) shell.webContents.send('targets-changed', run.targetManager.listTargets());
}

// Attach a TargetManager to a specific run's CDP endpoint. All target/capture
// wiring is scoped to `run`; other runs are never touched.
async function connectRunEndpoint(run, { host = '127.0.0.1', port = 9222, runtimeHint = null } = {}) {
  if (!run || run.status === RUN_STATUS.CLOSED) return { ok: false, error: { code: 'RUN_CLOSED', message: 'Browser run is closed' } };
  const manager = runManager.setTargetManager(run, { host, port, runtimeHint });
  manager.on('attached', ({ target, client }) => {
    runManager.registerTarget(target.cdpTargetId, run);
    if (!run.selectedTargetId) run.selectedTargetId = target.cdpTargetId; // auto-select first attachable target
    attachCdpCapture(client, target);
    autoRestoreOnAttach(target.cdpTargetId).catch(() => {});
    if (runManager.isActive(run)) broadcastTargets();
    broadcastRuns();
  });
  manager.on('target-added', () => { if (runManager.isActive(run)) broadcastTargets(); });
  manager.on('target-updated', () => { if (runManager.isActive(run)) broadcastTargets(); });
  manager.on('target-removed', id => {
    intercept.onTargetDetached(id);
    if (run.observer) run.observer.onDisconnect(id);
    runManager.unregisterTarget(id);
    if (run.selectedTargetId === id) {
      run.selectedTargetId = null;
      if (run.protocolContext) run.protocolContext.reset();
      // WU-C.1.1 — the owning socket is gone: entry readiness must not be trusted.
      if (run.entryGate) run.entryGate.onDisconnect();
    }
    // Browser fully gone (no targets left): quiesce this run's protocol activity.
    if (!runManager.targetsForRun(run.id).length) runManager.disconnectRun(run);
    if (runManager.isActive(run)) broadcastTargets();
    broadcastRuns();
  });
  manager.on('error', err => { if (runManager.isActive(run) && shell && !shell.isDestroyed()) shell.webContents.send('cdp-error', err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) }); });
  try {
    await manager.start();
    runManager.setStatus(run, RUN_STATUS.CONNECTED);
    if (runManager.isActive(run)) broadcastTargets();
    broadcastRuns();
    return { ok: true, runId: run.id, targets: manager.listTargets() };
  } catch (err) {
    return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err && err.message || err) } };
  }
}

// Manual/adb connect flows (cdp-connect, adb-forward-webview): attach an endpoint
// that this app did not launch. Each gets its own run so evidence stays scoped.
async function connectExternalEndpoint(endpoint = {}) {
  ensureRunManager();
  const run = runManager.createRun({ launchUrl: '' });
  runManager.setActive(run.id);
  run.cdpEndpoint = { host: endpoint.host || '127.0.0.1', port: endpoint.port || 9222 };
  return connectRunEndpoint(run, endpoint);
}

// Tier 1 license enforcement — the real gate. The renderer only *hides* locked UI
// via CSS, which is trivially bypassable (DevTools can flip the flag). So every
// capability IPC is denied here in the main process unless a verified-active
// license is present. Only the channels needed by the activation screen itself
// (status, activate, copy Machine ID, instance metadata) stay open. Fail closed:
// while the license is still "checking" or has lapsed, status().active is false
// and every gated call is refused.
const LICENSE_OPEN_CHANNELS = new Set(['license-status', 'license-activate', 'copy-text', 'instance-info']);
function licenseActive() { const s = licenseGuard && licenseGuard.status(); return Boolean(s && s.active); }
function handle(channel, fn) {
  if (LICENSE_OPEN_CHANNELS.has(channel)) { ipcMain.handle(channel, fn); return; }
  ipcMain.handle(channel, async (event, ...args) => {
    if (!licenseActive()) return { ok: false, error: { code: 'LICENSE_REQUIRED', message: 'A valid license is required to use this feature.' } };
    return fn(event, ...args);
  });
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('app', (request, callback) => {
    const pathname = new URL(request.url).pathname.replace(/^\/+/, '');
    callback({ path: path.join(__dirname, '..', 'ui', pathname) });
  });
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (importTimer) clearInterval(importTimer);
  if (importStarted) return;
  const child = importJournalOnExit();
  if (!child) return;
  event.preventDefault();
  child.once('close', () => app.quit());
  child.once('error', () => app.quit());
});
app.on('will-quit', () => { try { appInstance.lock.release(); } catch { /* best effort */ } });
handle('scope-set', (_event, hosts) => { allowedHosts = new Set((hosts || []).map(String).map(x => x.toLowerCase())); return true; });
handle('license-status', () => licenseStatus());
handle('license-activate', async (_event, license) => {
  if (!licenseGuard) return licenseStatus();
  return ensureProtocolSubsystem(await licenseGuard.activateAsync(String(license || '')));
});
handle('copy-text', (_event, text) => { clipboard.writeText(String(text || '')); return true; });
handle('open-browser', (_event, url) => openBrowserWindow(String(url)));
handle('instance-info', () => ({
  instanceId: appInstance.instanceId,
  name: appInstance.registry && appInstance.registry.name,
  root: appInstance.paths.root,
  sessions: appInstance.paths.sessions,
  chromeProfile: activeLauncherSnapshot().chromeProfile,
  runtime: activeLauncherSnapshot(),
}));
handle('list-sessions', () => {
  const dir = appInstance.paths.sessions;
  try { return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => { const id = name.slice(0, -6); const file = path.join(dir, name); const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); const events = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); return { id, file: name, startedAt: events[0]?.timestamp || events[0]?.journaledAt || null, requestCount: events.filter(event => event.kind === 'request').length }; }); } catch { return []; }
});
handle('read-session', (_event, id) => {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) return [];
  const file = path.join(appInstance.paths.sessions, String(id) + '.jsonl');
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
});
handle('export-session', async (_event, id) => {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) return { ok: false, error: 'Invalid session id' };
  const source = path.join(appInstance.paths.sessions, String(id) + '.jsonl');
  if (!fs.existsSync(source)) return { ok: false, error: 'Session not found' };
  const choice = await dialog.showSaveDialog(shell, { defaultPath: `observatory-${id}.jsonl`, filters: [{ name: 'Session journal', extensions: ['jsonl'] }] });
  if (choice.canceled || !choice.filePath) return { ok: false, error: 'Export canceled' };
  fs.copyFileSync(source, choice.filePath); return { ok: true, path: choice.filePath };
});
handle('export-session-report', async (_event, id, format = 'html') => {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) return { ok: false, error: 'Invalid session id' };
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database) return { ok: false, error: 'OBSERVATORY_DATABASE is not configured' };
  const extension = format === 'har' ? 'har' : format === 'json' ? 'json' : 'html';
  const choice = await dialog.showSaveDialog(shell, { defaultPath: `observatory-${id}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
  if (choice.canceled || !choice.filePath) return { ok: false, error: 'Export canceled' };
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  const args = format === 'har' ? ['-m', 'websec_observer.cli.main', 'export', database, id, '--format', 'har'] : ['-m', 'websec_observer.cli.main', 'report', database, id, '--format', format, '--output', choice.filePath];
  return await new Promise(resolve => { execFile(python, args, { cwd: path.join(__dirname, '..'), windowsHide: true }, (error, stdout, stderr) => { if (error) resolve({ ok: false, error: String(stderr || error.message) }); else if (format === 'har') { fs.writeFileSync(choice.filePath, stdout, 'utf8'); resolve({ ok: true, path: choice.filePath }); } else resolve({ ok: true, path: choice.filePath }); }); });
});
handle('analyze-session', async (_event, id) => {
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database || !/^[a-f0-9-]{36}$/i.test(String(id))) return { ok: false, error: 'Analysis requires database and valid session id' };
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  return await new Promise(resolve => execFile(python, ['-m', 'websec_observer.cli.main', 'analyze', database, id], { cwd: path.join(__dirname, '..'), windowsHide: true }, (error, stdout, stderr) => error ? resolve({ ok: false, error: String(stderr || error.message) }) : resolve({ ok: true, output: stdout }))); 
});
// WU3: replay lifecycle. Draft duplicates an immutable CapturedRequest; execute
// runs it in the request's OWN target (WEBVIEW_CONTEXT) or via HTTP_DIRECT.
handle('replay-create-draft', (_event, capturedRequestId, options = {}) => replay.createDraft(String(capturedRequestId), options));
handle('replay-update-draft', (_event, draftId, patch = {}) => replay.updateDraft(String(draftId), patch));
handle('replay-execute', (_event, draftId) => replay.execute(String(draftId)));
handle('replay-history', (_event, capturedRequestId) => replay.history(String(capturedRequestId)));
handle('ws-send', (_event, capturedId, payload) => wsReplay.send(String(capturedId), payload == null ? '' : String(payload)));
handle('timeline-build', (_event, capturedRequestId) => timeline.build(String(capturedRequestId)));
handle('cookies-save', (_event, targetId) => saveCookiesFor(String(targetId || activeSelectedTargetId() || '')));
handle('cookies-restore', (_event, targetId, reload) => restoreCookiesFor(String(targetId || activeSelectedTargetId() || ''), !!reload));
// WU4 intercept IPC. Default scope is the active run's selected target only.
handle('intercept-enable', (_event, rule = {}, targetId) => intercept.enable(String(targetId || activeSelectedTargetId() || ''), rule || {}));
handle('intercept-disable', (_event, targetId) => intercept.disable(String(targetId || activeSelectedTargetId() || '')));
handle('intercept-list', () => intercept.listPaused());
handle('intercept-update-draft', (_event, id, patch = {}) => intercept.updateDraft(String(id), patch));
handle('intercept-continue', (_event, id) => intercept.continue(String(id)));
handle('intercept-continue-modified', (_event, id, patch) => intercept.continueModified(String(id), patch));
handle('intercept-abort', (_event, id) => intercept.abort(String(id)));
handle('get-response-body', (_event, capturedId) => capture.getResponseBody(String(capturedId)));
handle('get-request-detail', (_event, capturedId) => { const r = capture.get(String(capturedId)); return r || { error: { code: 'REQUEST_NOT_FOUND' } }; });
handle('cdp-connect', (_event, endpoint = {}) => connectExternalEndpoint(endpoint));
handle('list-targets', () => { const r = activeRun(); return r && r.targetManager ? r.targetManager.listTargets() : []; });
handle('select-target', (_event, id) => {
  const run = activeRun();
  if (!run || !run.targetManager) return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'Not connected to a CDP endpoint' } };
  const session = run.targetManager.getSession(id);
  if (!session) return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'Target is no longer available' } };
  run.selectedTargetId = String(id);
  return { ok: true, selectedTargetId: run.selectedTargetId, runId: run.id };
});
// WU-C.1 — persistent browser management (registry is the source of truth).
handle('browser-list', () => browserSummaries());
handle('browser-capacity', () => { ensureBrowserRegistry(); return browserRegistry.capacity(); });
handle('browser-create', (_event, input = {}) => createPersistentBrowser({ name: input && input.name, url: input && input.url }));
handle('browser-open', (_event, browserId) => openPersistentBrowser(String(browserId || '')));
handle('browser-update', (_event, browserId, patch = {}) => { ensureBrowserRegistry(); const r = browserRegistry.update(String(browserId || ''), patch || {}); broadcastBrowsers(); return r.error ? r : { ok: true, browser: r.browser }; });
handle('browser-delete', (_event, browserId) => deletePersistentBrowser(String(browserId || '')));
// WU-A — browser run introspection (runtime layer).
handle('list-runs', () => runManager ? runManager.list() : []);
handle('select-run', (_event, runId) => {
  if (!runManager || !runManager.setActive(String(runId))) return { ok: false, error: { code: 'RUN_NOT_FOUND', message: 'Browser run not found' } };
  return { ok: true, activeRunId: runManager.activeRunId() };
});
handle('close-run', async (_event, runId) => { if (runManager) await runManager.closeRun(String(runId)); return { ok: true }; });
handle('adb-list-webviews', async () => {
  try { return { ok: true, sockets: await androidBridge.listWebviewSockets(process.env.OBSERVATORY_ADB || 'adb') }; }
  catch (err) { return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) } }; }
});
handle('adb-forward-webview', async (_event, socket, localPort = 9223) => {
  try {
    const endpoint = await androidBridge.forwardSocket(process.env.OBSERVATORY_ADB || 'adb', localPort, String(socket));
    return await connectExternalEndpoint(endpoint);
  } catch (err) { return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) } }; }
});
handle('capture-toggle', (_event, paused) => { capturePaused = Boolean(paused); return capturePaused; });
// WU7 — Protocol Test Harness IPC. Every send is target-bound and gated by the
// environment allowlist; sid is read from the observed server round, never guessed.
// Read-only display IPC (named run or active/idle provider). Never sends.
handle('protocol-environment', (_event, runId, targetId) => { const run = viewRun(runId); return run.harness.environmentFor(String(targetId || run.selectedTargetId || '')); });
handle('protocol-allowlist', (_event, runId) => viewRun(runId).harness.allowlist());
handle('protocol-round-state', (_event, runId) => { const a = viewRun(runId).aviator; return { current: a.currentRound(), sidHistory: a.sidHistory(), roundHistory: a.roundHistory(), actionTraces: a.actionTraces() }; });
handle('protocol-template', (_event, runId, command, overrides = {}) => { const h = viewRun(runId).harness; const payload = h.buildTemplate(String(command), overrides || {}); return { payload, sidCheck: h.checkSid(payload ? payload.sid : null) }; });
handle('protocol-check-sid', (_event, runId, sid) => viewRun(runId).harness.checkSid(sid));
handle('protocol-executions', (_event, runId) => viewRun(runId).harness.executions());
handle('protocol-context', (_event, runId) => viewRun(runId).protocolContext.get());
// WU7 — manual send: bound to an EXPLICIT run, never the active-run pointer.
handle('protocol-execute', (_event, runId, opts = {}) => { const r = execRun(runId); if (r.error) return r; return r.run.harness.execute({ ...opts, targetId: opts.targetId || r.run.selectedTargetId || null }); });
// WU8 — read-only observer IPC (snapshot + display-only config; never sends).
handle('observer-snapshot', (_event, runId) => viewRun(runId).observer.snapshot());
handle('observer-config', (_event, runId, patch = {}) => { const o = viewRun(runId).observer; const res = o.setConfig(patch || {}); return res.error ? res : o.snapshot(); });
// WU10 — automated runner IPC. Execution binds to an EXPLICIT run so multiple runs
// may run their AutoRunner concurrently and UI switching never retargets a run.
handle('autotest-environment', (_event, runId, targetId) => { const run = viewRun(runId); return run.autoRunner.environmentFor(String(targetId || run.selectedTargetId || '')); });
handle('autotest-start', async (_event, runId, config = {}) => {
  const r = execRun(runId); if (r.error) return r;
  const run = r.run;
  // WU-C.1.1 — Aviator entry prerequisite: ensure THIS run's socket is in the game
  // before any bet. No BET (cmd 100002) is possible until entry is authoritatively
  // confirmed by the run's own server round evidence. Never sends through another run.
  if (run.entryGate) {
    const gate = await run.entryGate.ensureEntered();
    if (gate && gate.error) return { error: gate.error };
  }
  const res = run.autoRunner.start(String(run.selectedTargetId || ''), config || {});
  return res.error ? res : run.autoRunner.snapshot();
});
handle('autotest-stop', (_event, runId) => { const r = execRun(runId); if (r.error) return r; const res = r.run.autoRunner.stop(); return res.error ? res : r.run.autoRunner.snapshot(); });
handle('autotest-snapshot', (_event, runId) => viewRun(runId).autoRunner.snapshot());
// WU10.2 — bet-amount server-validation IPC (bet-only), bound to an EXPLICIT run.
handle('bvalidate-environment', (_event, runId, targetId) => { const run = viewRun(runId); return run.amountValidator.environmentFor(String(targetId || run.selectedTargetId || '')); });
handle('bvalidate-start', (_event, runId, config = {}) => { const r = execRun(runId); if (r.error) return r; const res = r.run.amountValidator.start(String(r.run.selectedTargetId || ''), config || {}); return res.error ? res : r.run.amountValidator.snapshot(); });
handle('bvalidate-stop', (_event, runId) => { const r = execRun(runId); if (r.error) return r; const res = r.run.amountValidator.stop(); return res.error ? res : r.run.amountValidator.snapshot(); });
handle('bvalidate-snapshot', (_event, runId) => viewRun(runId).amountValidator.snapshot());
