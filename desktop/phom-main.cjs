'use strict';

// ===========================================================================
// Phom QA — THIRD standalone Electron product (peer of Control desktop/main.cjs
// and Analytics desktop/analytics-main.cjs). It runs WITHOUT Control or Analytics:
// its own identity, userData, single-instance lock, license gate (gameProduct
// PHOM) and IPC namespace (`phom:*`).
//
// It REUSES the shared low-level owners (no second implementation):
//   - ChromeRuntime + BrowserRunManager  (per-run chrome.exe / profile / CDP port)
//   - CaptureCorrelator                  (shared, target-keyed WS/HTTP capture)
//   - WsReplay.sendProtocol              (the ONLY send seam — the run's own socket)
//   - PhomSessionManager + phom domain   (coordinator / reducer / classifier)
//   - proxy-config / proxy-secret-store / proxy-tester / proxy-auth-handler
//   - licensing/*                        (verifier + guard, expectedGameProduct PHOM)
//
// It does NOT import the Control renderer, the Analytics renderer/store, the
// Aviator UI/coordinator, or any Control/Analytics singleton.
// ===========================================================================

const { app, BrowserWindow, ipcMain, protocol, safeStorage, screen, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { ChromeRuntime } = require('./browser/chrome-runtime.cjs');
const { BrowserRunManager, STATUS: RUN_STATUS } = require('./browser-run/browser-run-manager.cjs');
const { CaptureCorrelator } = require('./cdp/capture.cjs');
const { WsReplay } = require('./cdp/ws-replay.cjs');
const { PhomSessionManager } = require('./protocol/phom/phom-session-manager.cjs');
const { ProxyConfigStore } = require('./browser-run/proxy-config-store.cjs');
const { ProxySecretStore } = require('./browser-run/proxy-secret-store.cjs');
const { ProxyTester, testAll } = require('./browser-run/proxy-tester.cjs');
const { resolveLaunchProxy } = require('./browser-run/proxy-config.cjs');
const { bindProxyAuth } = require('./browser-run/proxy-auth-handler.cjs');
const { LicenseGuard } = require('./licensing/license-guard.cjs');
const { normalizeWindowBounds } = require('./window-bounds.cjs');

const PRODUCT_NAME = 'Phom QA';
const GAME_PRODUCT = 'PHOM';
const WIN_DEFAULTS = Object.freeze({ width: 1400, height: 900, minWidth: 1024, minHeight: 640 });
// IP-check allowlist for proxy Observed-IP tests (§7). Explicit hosts only — never a
// wildcard, never a game endpoint, never promoted from a user-entered URL.
const IP_CHECK_ALLOWLIST = (process.env.PHOM_IP_CHECK_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const IP_CHECK_URL = process.env.PHOM_IP_CHECK_URL || null;

// ---- renderer scheme (privileged, before ready) ----
protocol.registerSchemesAsPrivileged([
  { scheme: 'phom-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ---- product identity + userData isolation (distinct from Control/Analytics) ----
app.setName(PRODUCT_NAME);
const PHOM_USERDATA = path.join(app.getPath('appData'), PRODUCT_NAME);
try { fs.mkdirSync(PHOM_USERDATA, { recursive: true }); } catch { /* first write */ }
app.setPath('userData', PHOM_USERDATA);

// ---- single-instance (independent of the other products: keyed on Phom userData) ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (shell && !shell.isDestroyed()) { if (shell.isMinimized()) shell.restore(); shell.focus(); } });

  var shell = null;
  var licenseGuard = null;
  var runManager = null;
  var proxyConfigStore = null;
  var proxySecretStore = null;
  var proxyTester = null;
  var phomSessions = null;

  const phomRoot = () => path.join(PHOM_USERDATA, 'phom');
  const ensureDir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ } };

  // ---- capture + send seam (shared, target-keyed) ----
  const capture = new CaptureCorrelator({ resolveClient: (tid) => resolveTargetClient(tid) });
  const wsReplay = new WsReplay({ resolveClient: (tid) => resolveTargetClient(tid), getCaptured: (id) => capture.get(id) });
  const chromeRuntime = new ChromeRuntime({ onRunExit: (runId) => { try { if (runManager) runManager.disconnectRun(runManager.get(runId)); phomSessions.routeDisconnect(runId); } catch { /* best effort */ } } });

  function resolveTargetClient(targetId) {
    const run = runManager && runManager.runForTarget(targetId);
    const s = run && run.targetManager && run.targetManager.getSession(targetId);
    return s ? s.client : null;
  }

  function ensureStores() {
    if (proxyConfigStore) return;
    ensureDir(phomRoot());
    proxySecretStore = new ProxySecretStore({ filePath: path.join(phomRoot(), 'proxy-secrets.dat'), safeStorage });
    proxyConfigStore = new ProxyConfigStore({ filePath: path.join(phomRoot(), 'proxies.json'), secretStore: proxySecretStore });
    proxyTester = new ProxyTester({
      allowlist: IP_CHECK_ALLOWLIST,
      ipCheckUrl: IP_CHECK_URL,
      transport: netProxyTransport,     // RUNTIME-UNVERIFIED without a real proxy
    });
  }

  // Proxy observed-IP transport via Electron net through the run's proxy. This is the
  // real transport but is UNVERIFIED in this phase (no authorized proxy available).
  async function netProxyTransport(/* { proxy, url, timeoutMs, signal, auth } */) {
    return { ok: false, error: { code: 'PROXY_TRANSPORT_UNVERIFIED', message: 'Observed-IP transport needs an authorized proxy + IP-check endpoint' } };
  }

  function ensureRunManager() {
    if (runManager) return runManager;
    runManager = new BrowserRunManager({
      createLauncher: (run) => chromeRuntime.launcher(run),
      createTargetManager: (endpoint, run) => chromeRuntime.targetManager(run, endpoint),
      buildSubsystem: () => ({}), // Phom uses the coordinator, not a per-run Aviator subsystem
    });
    return runManager;
  }

  function ensurePhomSessions() {
    if (phomSessions) return phomSessions;
    ensureStores();
    phomSessions = new PhomSessionManager({
      wsReplay,
      featureEnabled: () => true,
      authorized: phomAuthorizedEnv,
      resolveProfileMeta: (runId) => {
        const run = runManager && runManager.get(runId);
        return { displayName: (run && run.profileLabel) || runId, proxyRef: run && run.proxy ? run.proxy.id : null, uid: null };
      },
    });
    phomSessions.on('update', (snap) => send('phom:session', snap));
    phomSessions.on('hands', (hands) => send('phom:hands', hands));
    return phomSessions;
  }

  function phomAuthorizedEnv() {
    if (process.env.PHOM_QA_ENABLED !== '1') return false;
    return process.env.PHOM_QA_AUTHORIZED === '1' || IP_CHECK_ALLOWLIST.length > 0;
  }

  function send(channel, payload) { try { if (shell && !shell.isDestroyed()) shell.webContents.send(channel, payload); } catch { /* best effort */ } }

  // ---- per-run capture attach + phom frame routing (mirrors Control's seam) ----
  capture.on('request', (req) => {
    if (!req || !req.isWebSocket || !req.wsDirection || !runManager) return;
    const run = runManager.runForTarget(req.targetId);
    try { if (run && phomSessions) phomSessions.routeFrame(run, req); } catch { /* never break capture */ }
  });

  async function connectRunEndpoint(run, endpoint) {
    const manager = runManager.setTargetManager(run, endpoint);
    if (!manager) return { ok: false, error: { code: 'RUN_CLOSED', message: 'run closed' } };
    manager.on('attached', ({ target, client }) => {
      runManager.registerTarget(target.cdpTargetId, run);
      if (!run.selectedTargetId) run.selectedTargetId = target.cdpTargetId;
      attachCapture(client, target);
      // Ensure the WS send-hook is present before the game opens its socket.
      wsReplay.injectSession(client, undefined).catch(() => {});
      // Bind proxy auth on the run's OWN client when its proxy requires it (unverified).
      if (run.proxy && run.proxy.requiresAuth) {
        bindProxyAuth(client, {
          runProxy: run.proxy,
          username: run.proxyUsername || null,
          resolvePassword: () => proxyConfigStore && run.proxy ? proxyConfigStore.resolvePassword(run.proxy.id) : null,
          onAuthFailure: (code) => send('phom:proxy-auth', { runId: run.id, code }),
        }).then((detach) => { run._detachProxyAuth = detach; }).catch(() => {});
      }
    });
    manager.on('target-removed', (id) => {
      runManager.unregisterTarget(id);
      if (run.selectedTargetId === id) run.selectedTargetId = null;
      if (!runManager.targetsForRun(run.id).length) { runManager.disconnectRun(run); try { phomSessions.routeDisconnect(run.id); } catch { /* best effort */ } }
    });
    return manager.start ? manager.start() : { ok: true };
  }

  function attachCapture(client, target) {
    const { Network } = client;
    const tid = target.cdpTargetId;
    Network.enable().catch(() => {});
    Network.requestWillBeSent((p, sid) => capture.onRequestWillBeSent(tid, p, sid));
    Network.responseReceived((p, sid) => capture.onResponseReceived(tid, p, sid));
    Network.loadingFinished((p, sid) => capture.onLoadingFinished(tid, p, sid));
    Network.loadingFailed((p, sid) => capture.onLoadingFailed(tid, p, sid));
    Network.webSocketCreated((p, sid) => capture.onWebSocketCreated(tid, p, sid));
    Network.webSocketFrameSent((p, sid) => capture.onWebSocketFrameSent(tid, p, sid));
    Network.webSocketFrameReceived((p, sid) => capture.onWebSocketFrameReceived(tid, p, sid));
    Network.webSocketClosed((p, sid) => capture.onWebSocketClosed(tid, p, sid));
  }

  // §6 — open ONE profile's browser with its resolved proxy (no direct fallback).
  async function openProfile({ slot, url, proxyRef, proxyRequired, label, username }) {
    ensureRunManager(); ensurePhomSessions();
    const gate = resolveLaunchProxy({ proxyRef: proxyRef || null, proxyRequired: proxyRequired !== false }, (ref) => proxyConfigStore && proxyConfigStore.get(ref));
    if (!gate.ok) return gate; // PROXY_CONFIG_REQUIRED / NOT_FOUND — launch blocked
    const run = runManager.createRun({ launchUrl: String(url || ''), proxy: gate.runProxy });
    run.profileLabel = label || `Profile ${slot}`;
    run.proxyUsername = username || (gate.config && gate.config.username) || null;
    const launched = await run.launcher.open(String(url || ''));
    if (!launched.ok) { runManager.failRun(run, launched.error); return { ok: false, error: launched.error }; }
    run.cdpEndpoint = launched.endpoint;
    connectRunEndpoint(run, launched.endpoint).catch(() => {});
    return { ok: true, runId: run.id, proxy: gate.runProxy };
  }

  // ---- license gate ----
  function licenseActive() { const s = licenseGuard && licenseGuard.status(); return Boolean(s && s.active); }
  async function licenseStatus() {
    if (!licenseGuard) return { active: false, error: { code: 'LICENSE_MISSING', message: 'License guard not ready' }, gameProduct: GAME_PRODUCT };
    let status = licenseGuard.status();
    if (status.active) status = await licenseGuard.refreshAsync({ consumeLaunch: false });
    else status = await licenseGuard.refreshAsync();
    return { ...status, gameProduct: GAME_PRODUCT };
  }

  // Active orchestration IPC requires BOTH a valid PHOM license AND (later) an
  // authorized environment — the two gates are independent (§8).
  function guarded(fn) {
    return async (...args) => {
      if (!licenseActive()) return { ok: false, error: { code: 'LICENSE_REQUIRED', message: 'A valid Phỏm QA license is required.' } };
      return fn(...args);
    };
  }

  // ---- window ----
  function windowStatePath() { return path.join(PHOM_USERDATA, 'window-state.json'); }
  function loadWindowState() { try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); } catch { return null; } }
  function saveWindowState() { try { if (shell && !shell.isDestroyed() && !shell.isMinimized()) fs.writeFileSync(windowStatePath(), JSON.stringify(shell.getBounds()), 'utf8'); } catch { /* best effort */ } }
  function fitToCurrentDisplay(saved) {
    const hasPos = saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y));
    const display = hasPos ? screen.getDisplayMatching({ x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.width), height: Math.round(saved.height) }) : screen.getPrimaryDisplay();
    return normalizeWindowBounds({ saved, workArea: display.workArea, defaults: WIN_DEFAULTS });
  }
  function createWindow() {
    const bounds = fitToCurrentDisplay(loadWindowState());
    shell = new BrowserWindow({
      ...bounds, backgroundColor: '#0f1419', title: PRODUCT_NAME,
      webPreferences: { preload: path.join(__dirname, 'phom-preload.cjs'), contextIsolation: true, sandbox: true },
    });
    shell.on('close', saveWindowState);
    shell.loadURL('phom-app://ui/index.html');
  }

  // ---- IPC (phom: namespace only) ----
  function registerIpc() {
    ipcMain.handle('phom:license-status', () => licenseStatus());
    ipcMain.handle('phom:license-activate', async (_e, key) => { if (!licenseGuard) return licenseStatus(); const s = await licenseGuard.activateAsync(String(key || '')); return { ...s, gameProduct: GAME_PRODUCT }; });
    ipcMain.handle('phom:machine-id', () => ({ machineId: licenseGuard ? licenseGuard.machineId() : null }));
    ipcMain.handle('phom:instance-info', () => ({ productName: PRODUCT_NAME, gameProduct: GAME_PRODUCT, userData: PHOM_USERDATA, ipcPrefix: 'phom:' }));
    ipcMain.handle('phom:capabilities', () => ({ featureEnabled: process.env.PHOM_QA_ENABLED === '1', authorized: phomAuthorizedEnv(), licensed: licenseActive(), proxySecret: (ensureStores(), proxySecretStore.capability()) }));

    // Proxy config (metadata only; passwords never returned to the renderer).
    ipcMain.handle('phom:proxy-list', guarded(() => { ensureStores(); return { ok: true, proxies: proxyConfigStore.list() }; }));
    ipcMain.handle('phom:proxy-upsert', guarded((_e, input) => { ensureStores(); return proxyConfigStore.upsert(input || {}); }));
    ipcMain.handle('phom:proxy-remove', guarded((_e, id) => { ensureStores(); return proxyConfigStore.remove(String(id)); }));
    ipcMain.handle('phom:proxy-test', guarded(async (_e, id) => {
      ensureStores();
      const cfg = proxyConfigStore.get(String(id));
      if (!cfg) return { ok: false, error: { code: 'PROXY_CONFIG_NOT_FOUND', message: 'No such proxy' } };
      const { toRunProxy } = require('./browser-run/proxy-config.cjs');
      const res = await proxyTester.test(toRunProxy(cfg), { resolveAuth: () => ({ username: cfg.username, password: proxyConfigStore.resolvePassword(cfg.id) }) });
      return { ok: res.state === 'PASS', result: res };
    }));
    ipcMain.handle('phom:proxy-test-all', guarded(async (_e, ids) => {
      ensureStores();
      const { toRunProxy } = require('./browser-run/proxy-config.cjs');
      const out = await testAll((Array.isArray(ids) ? ids : []).map(String), async (id) => {
        const cfg = proxyConfigStore.get(id); if (!cfg) return { state: 'NOT_CONFIGURED' };
        return proxyTester.test(toRunProxy(cfg), { resolveAuth: () => ({ username: cfg.username, password: proxyConfigStore.resolvePassword(cfg.id) }) });
      }, 2);
      return { ok: true, results: Object.fromEntries(out) };
    }));

    // Browser + session lifecycle.
    ipcMain.handle('phom:open-profile', guarded((_e, cfg) => openProfile(cfg || {})));
    ipcMain.handle('phom:start-session', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.startSession({ runIds: (cfg && cfg.runIds) || [] }); }));
    ipcMain.handle('phom:request-channels', guarded(() => ensurePhomSessions().requestChannels()));
    ipcMain.handle('phom:select-channel', guarded((_e, ch) => ({ ok: true, selected: ensurePhomSessions().selectChannel(ch) })));
    ipcMain.handle('phom:join-together', guarded((_e, ch) => ensurePhomSessions().joinTogether(ch)));
    ipcMain.handle('phom:rejoin', guarded(() => ensurePhomSessions().rejoinMismatched()));
    ipcMain.handle('phom:ready-all', guarded(() => ensurePhomSessions().readyAll()));
    ipcMain.handle('phom:leave-all', guarded(() => ensurePhomSessions().leaveAll()));
    ipcMain.handle('phom:stop', guarded(() => { ensurePhomSessions().stop(); return { ok: true }; }));
    ipcMain.handle('phom:session-state', () => (phomSessions ? phomSessions.snapshot() : null));
    ipcMain.handle('phom:verify-table', () => (phomSessions ? phomSessions.verifyTable() : { result: 'IDLE' }));
  }

  app.whenReady().then(() => {
    protocol.registerFileProtocol('phom-app', (request, callback) => {
      const pathname = new URL(request.url).pathname.replace(/^\/+/, '');
      callback({ path: path.join(__dirname, '..', 'ui-phom', pathname.replace(/^ui\//, '')) });
    });
    licenseGuard = new LicenseGuard({ userDataPath: PHOM_USERDATA, safeStorage, expectedGameProduct: GAME_PRODUCT });
    licenseGuard.initialize();
    licenseGuard.initializeAsync().then((status) => { send('phom:license', { ...status, gameProduct: GAME_PRODUCT }); }).catch(() => {});
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { PRODUCT_NAME, GAME_PRODUCT };
