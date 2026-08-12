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

let shell;
let targetManager = null;
let selectedTargetId = null;
const capturedClients = new WeakSet();
let allowedHosts = new Set();
let capturePaused = false;
let sessionId = randomUUID();
let journal;
let licenseGuard;
// Tier 2: populated by initProtocolSubsystem() once a valid license unlocks the
// sealed protocol modules. Every IPC that touches these is Tier-1 gated, so they are
// never referenced before initialization.
let aviator, harness, protocolContext, observer, autoRunner, amountValidator;
let protocolSubsystemReady = false;
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
const chromeLauncher = new ChromeLauncher({
  profilePath: appInstance.paths.chromeProfile,
  env: process.env,
  onRuntime: (patch) => appInstance.lock.update(patch),
});

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
  const normalized = normalizeCaptureEvent(event, sessionId);
  if (!normalized) return;
  try { journal?.append(normalized); } catch { /* journal failure must not stop capture */ }
  if (shell && !shell.isDestroyed()) shell.webContents.send('capture-event', normalized);
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
  // Auto-save the session so a fresh login is captured for next time.
  const cookieTimer = setInterval(() => { if (selectedTargetId) saveCookiesFor(selectedTargetId).catch(() => {}); }, 12_000);
  if (cookieTimer.unref) cookieTimer.unref();
  shell.loadURL('app://ui/product.html');
}

async function openBrowserWindow(url) {
  const launched = await chromeLauncher.open(url);
  if (!launched.ok) return false;
  connectEndpointWithRetry(launched.endpoint);
  return true;
}

// Unlock the sealed protocol subsystem the moment a license verifies active. Safe to
// call with any status (no-op unless active) and idempotent. Failure to unlock is
// surfaced but must not crash the license flow.
function ensureProtocolSubsystem(status) {
  try { if (status && status.active) initProtocolSubsystem(); }
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
async function connectEndpointWithRetry(endpoint, attempt = 0) {
  const result = await connectEndpoint(endpoint);
  if (!result.ok && attempt < 12) { setTimeout(() => connectEndpointWithRetry(endpoint, attempt + 1), 1000); }
  return result;
}

// Shared correlator: holds RAW evidence (unredacted) for all attached targets and
// resolves response bodies through each request's OWN target client.
function resolveTargetClient(targetId) { const s = targetManager && targetManager.getSession(targetId); return s ? s.client : null; }
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
// and wired up here — AFTER a genuine, machine-matched license unlocks the seal key.
// Building it lazily means the code does not exist in a runnable form until a valid
// license is present, so flipping the renderer flag or patching the Tier-1 gate is not
// enough to get the features. Idempotent; safe to call on every license change.
function initProtocolSubsystem() {
  if (protocolSubsystemReady) return true;
  const license = licenseGuard && licenseGuard.storedLicense ? licenseGuard.storedLicense() : null;
  const key = deriveFeatureKey({ license, machineId: licenseGuard ? licenseGuard.machineId() : null });
  installSealedLoader({ key, files: SEALED_BASENAMES.map((name) => path.join(__dirname, 'protocol', `${name}.cjs`)) });
  const { RoundTracker } = require('./protocol/aviator.cjs');
  const { ProtocolHarness } = require('./protocol/harness.cjs');
  const { RoundObserver } = require('./protocol/round-observer.cjs');
  const { AutoRunner } = require('./protocol/auto-runner.cjs');
  const { AmountValidator } = require('./protocol/amount-validator.cjs');
  const { ProtocolContext } = require('./protocol/protocol-context.cjs');

  // WU7: Aviator protocol observer — classifies WS frames, tracks the authoritative
  // CurrentRound (sid from server cmd:100005 ONLY, never arithmetic), SID history and
  // send->ack ActionTraces. Fed from captured WebSocket data frames.
  aviator = new RoundTracker();
  capture.on('request', req => {
    if (req && req.isWebSocket && req.wsDirection) {
      aviator.observe({ targetId: req.targetId, cdpSessionId: req.cdpSessionId, url: req.url, direction: req.wsDirection, raw: req.body && req.body.raw });
    }
  });
  aviator.on('round', r => { if (shell && !shell.isDestroyed()) shell.webContents.send('aviator-round', r); });
  // Session aid/eid — learned from observed frames, owned here (never hardcoded /
  // user-entered). Protocol testing stays disabled until this is ready.
  protocolContext = new ProtocolContext({ roundTracker: aviator });
  protocolContext.on('change', c => { if (shell && !shell.isDestroyed()) shell.webContents.send('protocol-context', c); });
  aviator.on('actiontrace', t => { if (shell && !shell.isDestroyed()) shell.webContents.send('aviator-actiontrace', t); });
  // WU7: Protocol Test Harness — authorized QA sender bound to the selected target's
  // own live socket (via wsReplay.sendRaw). Gated by an explicit host allowlist.
  harness = new ProtocolHarness({
    roundTracker: aviator,
    send: (ctx, payload) => wsReplay.sendProtocol(ctx, payload),
    getTargetUrl: targetId => { const s = targetManager && targetManager.getSession(targetId); return s ? s.target.url : ''; },
    allowlist: (process.env.OBSERVATORY_TEST_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),
    environmentGuard: protocolEnvironmentGuard,
  });
  harness.on('execution', ex => {
    try { journal?.append(normalizeCaptureEvent({ kind: 'protocol-test', id: ex.id, targetId: ex.targetId, timestamp: ex.sentAt, exec: ex }, sessionId)); } catch { /* journal failure must not stop testing */ }
    if (shell && !shell.isDestroyed()) shell.webContents.send('protocol-execution', ex);
  });
  // WU8: READ-ONLY multi-round observer. Consumes the RoundTracker frame stream and
  // records per-round evidence (sid, odd stream, bet/cashout timing, server odd/wm,
  // latencies). It never sends — RoundTracker stays the sole owner of sid/odd/state.
  observer = new RoundObserver({ roundTracker: aviator });
  let observerDirty = false;
  observer.on('update', () => {
    if (observerDirty) return; observerDirty = true;
    setTimeout(() => { observerDirty = false; if (shell && !shell.isDestroyed()) shell.webContents.send('observer-update', observer.snapshot()); }, 120);
  });
  // WU10: offline automated round test runner. Event-driven over the frame stream;
  // reuses the observer (sid/odd owner) + harness (send + ack). HARD-BOUND to local/
  // test endpoints — start() refuses any non-allowlisted host and the UI can't override.
  autoRunner = new AutoRunner({
    roundTracker: aviator, observer, harness,
    getTargetUrl: targetId => { const s = targetManager && targetManager.getSession(targetId); return s ? s.target.url : ''; },
    environmentGuard: protocolEnvironmentGuard,
  });
  let autoDirty = false;
  autoRunner.on('update', () => {
    if (autoDirty) return; autoDirty = true;
    setTimeout(() => { autoDirty = false; if (shell && !shell.isDestroyed()) shell.webContents.send('autotest-update', autoRunner.snapshot()); }, 100);
  });
  // WU10.2: separate bet-amount server-validation mode (bet-only; sends the EXACT
  // tester value; never clamps/snaps; hard-bound to local/test like the runner).
  amountValidator = new AmountValidator({
    roundTracker: aviator, harness,
    getTargetUrl: targetId => { const s = targetManager && targetManager.getSession(targetId); return s ? s.target.url : ''; },
    environmentGuard: protocolEnvironmentGuard,
  });
  let bvalDirty = false;
  amountValidator.on('update', () => {
    if (bvalDirty) return; bvalDirty = true;
    setTimeout(() => { bvalDirty = false; if (shell && !shell.isDestroyed()) shell.webContents.send('bvalidate-update', amountValidator.snapshot()); }, 100);
  });
  protocolSubsystemReady = true;
  return true;
}
// Persistent session store (cookies) — independent of launching Chrome, so a
// login survives reconnects on Chrome / WebView / WebView2 / CEF alike.
let cookieVault;
function targetHost(targetId) { const s = targetManager && targetManager.getSession(targetId); try { return s ? new URL(s.target.url).hostname : ''; } catch { return ''; } }
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

function broadcastTargets() {
  if (shell && !shell.isDestroyed() && targetManager) shell.webContents.send('targets-changed', targetManager.listTargets());
}

async function connectEndpoint({ host = '127.0.0.1', port = 9222, runtimeHint = null } = {}) {
  if (targetManager) { try { await targetManager.stop(); } catch { /* ignore */ } targetManager = null; selectedTargetId = null; }
  const manager = new TargetManager({ host, port, runtimeHint });
  manager.on('attached', ({ target, client }) => {
    if (!selectedTargetId) selectedTargetId = target.cdpTargetId; // auto-select first attachable target
    attachCdpCapture(client, target);
    autoRestoreOnAttach(target.cdpTargetId).catch(() => {});
    broadcastTargets();
  });
  manager.on('target-added', broadcastTargets);
  manager.on('target-updated', broadcastTargets);
  manager.on('target-removed', id => { intercept.onTargetDetached(id); observer.onDisconnect(id); if (selectedTargetId === id) { selectedTargetId = null; protocolContext.reset(); } broadcastTargets(); });
  manager.on('error', err => { if (shell && !shell.isDestroyed()) shell.webContents.send('cdp-error', err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) }); });
  try {
    await manager.start();
    targetManager = manager;
    broadcastTargets();
    return { ok: true, targets: manager.listTargets() };
  } catch (err) {
    return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err && err.message || err) } };
  }
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
  chromeProfile: chromeLauncher.snapshot().chromeProfile,
  runtime: chromeLauncher.snapshot(),
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
handle('cookies-save', (_event, targetId) => saveCookiesFor(String(targetId || selectedTargetId || '')));
handle('cookies-restore', (_event, targetId, reload) => restoreCookiesFor(String(targetId || selectedTargetId || ''), !!reload));
// WU4 intercept IPC. Default scope is the selected target only.
handle('intercept-enable', (_event, rule = {}, targetId) => intercept.enable(String(targetId || selectedTargetId || ''), rule || {}));
handle('intercept-disable', (_event, targetId) => intercept.disable(String(targetId || selectedTargetId || '')));
handle('intercept-list', () => intercept.listPaused());
handle('intercept-update-draft', (_event, id, patch = {}) => intercept.updateDraft(String(id), patch));
handle('intercept-continue', (_event, id) => intercept.continue(String(id)));
handle('intercept-continue-modified', (_event, id, patch) => intercept.continueModified(String(id), patch));
handle('intercept-abort', (_event, id) => intercept.abort(String(id)));
handle('get-response-body', (_event, capturedId) => capture.getResponseBody(String(capturedId)));
handle('get-request-detail', (_event, capturedId) => { const r = capture.get(String(capturedId)); return r || { error: { code: 'REQUEST_NOT_FOUND' } }; });
handle('cdp-connect', (_event, endpoint = {}) => connectEndpoint(endpoint));
handle('list-targets', () => targetManager ? targetManager.listTargets() : []);
handle('select-target', (_event, id) => {
  if (!targetManager) return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'Not connected to a CDP endpoint' } };
  const session = targetManager.getSession(id);
  if (!session) return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'Target is no longer available' } };
  selectedTargetId = String(id);
  return { ok: true, selectedTargetId };
});
handle('adb-list-webviews', async () => {
  try { return { ok: true, sockets: await androidBridge.listWebviewSockets(process.env.OBSERVATORY_ADB || 'adb') }; }
  catch (err) { return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) } }; }
});
handle('adb-forward-webview', async (_event, socket, localPort = 9223) => {
  try {
    const endpoint = await androidBridge.forwardSocket(process.env.OBSERVATORY_ADB || 'adb', localPort, String(socket));
    return await connectEndpoint(endpoint);
  } catch (err) { return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) } }; }
});
handle('capture-toggle', (_event, paused) => { capturePaused = Boolean(paused); return capturePaused; });
// WU7 — Protocol Test Harness IPC. Every send is target-bound and gated by the
// environment allowlist; sid is read from the observed server round, never guessed.
handle('protocol-environment', (_event, targetId) => harness.environmentFor(String(targetId || selectedTargetId || '')));
handle('protocol-allowlist', () => harness.allowlist());
handle('protocol-round-state', () => ({ current: aviator.currentRound(), sidHistory: aviator.sidHistory(), roundHistory: aviator.roundHistory(), actionTraces: aviator.actionTraces() }));
handle('protocol-template', (_event, command, overrides = {}) => { const payload = harness.buildTemplate(String(command), overrides || {}); return { payload, sidCheck: harness.checkSid(payload ? payload.sid : null) }; });
handle('protocol-check-sid', (_event, sid) => harness.checkSid(sid));
handle('protocol-execute', (_event, opts = {}) => harness.execute({ ...opts, targetId: opts.targetId || selectedTargetId || null }));
handle('protocol-executions', () => harness.executions());
handle('protocol-context', () => protocolContext.get());
// WU8 — read-only observer IPC (snapshot + display-only config; never sends).
handle('observer-snapshot', () => observer.snapshot());
handle('observer-config', (_event, patch = {}) => { const r = observer.setConfig(patch || {}); return r.error ? r : observer.snapshot(); });
// WU10 — automated runner IPC (hard-bound to local/test endpoints; start() gates).
handle('autotest-environment', (_event, targetId) => autoRunner.environmentFor(String(targetId || selectedTargetId || '')));
handle('autotest-start', (_event, config = {}) => { const r = autoRunner.start(String(selectedTargetId || ''), config || {}); return r.error ? r : autoRunner.snapshot(); });
handle('autotest-stop', () => { const r = autoRunner.stop(); return r.error ? r : autoRunner.snapshot(); });
handle('autotest-snapshot', () => autoRunner.snapshot());
// WU10.2 — bet-amount server-validation IPC (bet-only; local/test gated).
handle('bvalidate-environment', (_event, targetId) => amountValidator.environmentFor(String(targetId || selectedTargetId || '')));
handle('bvalidate-start', (_event, config = {}) => { const r = amountValidator.start(String(selectedTargetId || ''), config || {}); return r.error ? r : amountValidator.snapshot(); });
handle('bvalidate-stop', () => { const r = amountValidator.stop(); return r.error ? r : amountValidator.snapshot(); });
handle('bvalidate-snapshot', () => amountValidator.snapshot());
