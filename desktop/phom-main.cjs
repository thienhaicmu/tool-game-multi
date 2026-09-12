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
//   - HostSessionManager + phom domain   (host coordinator / reducer / classifier)
//   - proxy-config / proxy-secret-store / proxy-tester / proxy-auth-handler
//   - licensing/*                        (verifier + guard, expectedGameProduct PHOM)
//
// It does NOT import the Control renderer, the Analytics renderer/store, the
// Aviator UI/coordinator, or any Control/Analytics singleton.
// ===========================================================================

const { app, BrowserWindow, ipcMain, protocol, safeStorage, screen, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { ChromeRuntime } = require('./browser/chrome-runtime.cjs');
const phomChromium = require('./browser/phom-chromium-runtime.cjs');
const { BrowserRunManager, STATUS: RUN_STATUS } = require('./browser-run/browser-run-manager.cjs');
const { CaptureCorrelator } = require('./cdp/capture.cjs');
const { WsReplay } = require('./cdp/ws-replay.cjs');
const { HostSessionManager } = require('./protocol/phom/host-session-manager.cjs');
const { PhomClusterCdpManager } = require('./protocol/phom/phom-cluster-cdp-manager.cjs');
const { ProxyConfigStore } = require('./browser-run/proxy-config-store.cjs');
const { ProxySecretStore } = require('./browser-run/proxy-secret-store.cjs');
const { ProxyTester, testAll } = require('./browser-run/proxy-tester.cjs');
const { resolveLaunchProxy } = require('./browser-run/proxy-config.cjs');
const { PhomProfileStore } = require('./browser-run/phom-profile-store.cjs');
const deviceProfile = require('./browser-run/device-profile.cjs');
const { bindProxyAuth } = require('./browser-run/proxy-auth-handler.cjs');
const { LicenseGuard } = require('./licensing/license-guard.cjs');
const { resolveDevBypass, FORBIDDEN_CODE: DEV_BYPASS_FORBIDDEN } = require('./licensing/dev-bypass.cjs');
const { parseObservedIp } = require('./browser-run/ip-parse.cjs');
const { rectForSlot } = require('./protocol/phom/grid-layout.cjs');
const offlineAnalyzer = require('./protocol/phom/offline-analyzer.cjs');
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
  // Development-only license bypass decision (§3). Computed once at startup from the
  // real packaged/env context; forbidden (and startup-blocking) in a packaged build.
  var devBypass = resolveDevBypass({ isPackaged: app.isPackaged, env: process.env });
  var runManager = null;
  var proxyConfigStore = null;
  var proxySecretStore = null;
  var proxyTester = null;
  var profileStore = null;
  var phomSessions = null;
  const SLOTS_ABC = ['A', 'B', 'C'];

  const phomRoot = () => path.join(PHOM_USERDATA, 'phom');
  const ensureDir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ } };

  // ---- capture + send seam (shared, target-keyed) ----
  const capture = new CaptureCorrelator({ resolveClient: (tid) => resolveTargetClient(tid) });
  const wsReplay = new WsReplay({ resolveClient: (tid) => resolveTargetClient(tid), getCaptured: (id) => capture.get(id) });
  // Resolve + validate the pinned custom Chromium runtime once (dev vs packaged). No
  // system-Chrome fallback: an invalid runtime blocks browser launches with a typed error.
  var _chromiumRuntime = null;
  function chromiumRuntime() {
    if (_chromiumRuntime) return _chromiumRuntime;
    _chromiumRuntime = phomChromium.resolveAndValidate({ env: process.env, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, projectRoot: path.join(__dirname, '..') });
    return _chromiumRuntime;
  }
  const chromeRuntime = new ChromeRuntime({
    chromeExecutable: (() => { const r = chromiumRuntime(); return r && r.ok ? r.executable : null; })(),
    onRunExit: (runId) => { try { if (runManager) runManager.disconnectRun(runManager.get(runId)); phomSessions.routeDisconnect(runId); } catch { /* best effort */ } },
  });

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
    profileStore = new PhomProfileStore({ filePath: path.join(phomRoot(), 'phom-profiles.json') });
    proxyTester = new ProxyTester({
      allowlist: IP_CHECK_ALLOWLIST,
      ipCheckUrl: IP_CHECK_URL,
      transport: netProxyTransport,     // RUNTIME-UNVERIFIED without a real proxy
    });
  }

  // Proxy observed-IP transport (§6): a dedicated, throwaway Electron session with the
  // run's proxy applied, fetching the allowlisted IP-check URL. It NEVER touches the
  // default session (no shared cookies), NEVER falls back to direct, and NEVER logs
  // credentials. Real code; RUNTIME-UNVERIFIED until an authorized proxy is supplied.
  async function netProxyTransport({ proxy, url, timeoutMs, auth } = {}) {
    if (!proxy || !proxy.host) return { ok: false, error: { code: 'PROXY_CONFIG_REQUIRED', message: 'no proxy' } };
    let ses;
    const partition = `phom-proxy-test-${proxy.id || Math.random().toString(36).slice(2)}-${Date.now()}`;
    try { ses = session.fromPartition(partition); } catch (e) { return { ok: false, error: { code: 'PROXY_SESSION_CREATE_FAILED', message: safeMsg(e) } }; }
    const rules = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
    // proxy auth via the session 'login' event, bound to THIS session only.
    const onLogin = (event, _details, authInfo, callback) => {
      if (authInfo && authInfo.isProxy && auth && auth.password) { event.preventDefault(); callback(auth.username || '', auth.password); }
      // else: let it fail (no direct fallback, no origin creds)
    };
    ses.on('login', onLogin);
    try {
      await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<-loopback>' });
      const body = await new Promise((resolve, reject) => {
        let done = false; const chunks = [];
        const timer = setTimeout(() => { if (!done) { done = true; try { req.abort(); } catch {} const e = new Error('timeout'); e.code = 'PROXY_TEST_TIMEOUT'; reject(e); } }, timeoutMs || 8000);
        const req = net.request({ url, session: ses, useSessionCookies: false });
        req.on('response', (res) => {
          if (res.statusCode === 407) { const e = new Error('proxy auth'); e.code = 'PROXY_AUTH_FAILED'; clearTimeout(timer); done = true; return reject(e); }
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => { if (!done) { done = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); } });
        });
        req.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); const err = new Error(safeMsg(e)); err.code = /ERR_PROXY/.test(String(e)) ? 'PROXY_CONNECT_FAILED' : 'PROXY_CONNECT_FAILED'; reject(err); } });
        req.end();
      });
      const ip = parseObservedIp(body);
      if (!ip) return { ok: false, error: { code: 'PROXY_IP_RESPONSE_INVALID', message: 'IP-check response had no usable IP' } };
      return { ok: true, ip };
    } catch (e) {
      return { ok: false, error: { code: e.code || 'PROXY_CONNECT_FAILED', message: safeMsg(e) } };
    } finally {
      try { ses.off('login', onLogin); } catch {}
      try { await ses.setProxy({ mode: 'direct' }); await ses.clearStorageData(); } catch {}
    }
  }
  function safeMsg(e) { return String((e && e.message) || e || '').slice(0, 200); }

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
    phomSessions = new HostSessionManager({
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
    phomSessions.on('kick', (k) => send('phom:kick', k));
    return phomSessions;
  }

  function phomAuthorizedEnv() {
    if (process.env.PHOM_QA_ENABLED !== '1') return false;
    return process.env.PHOM_QA_AUTHORIZED === '1' || IP_CHECK_ALLOWLIST.length > 0;
  }

  // ---- PhomClusterCdpManager: control-plane over the three independent CDP clients ----
  var phomCluster = null;
  function runClientFor(runId) {
    const run = runManager && runManager.get(runId);
    const s = run && run.targetManager && run.targetManager.getSession(run.selectedTargetId);
    return s ? s.client : null;
  }
  function runInfoFor(runId) {
    const run = runManager && runManager.get(runId);
    let snap = {}; try { if (run && run.launcher && run.launcher.snapshot) snap = run.launcher.snapshot() || {}; } catch { snap = {}; }
    return { pid: snap.chromePid != null ? snap.chromePid : null, port: snap.cdpPort != null ? snap.cdpPort : (run && run.cdpEndpoint ? run.cdpEndpoint.port : null), userDataDir: snap.chromeProfile || (run ? run.profileDir : null) };
  }
  async function testProxyById(id) {
    ensureStores();
    const cfg = proxyConfigStore.get(String(id));
    if (!cfg) return { state: 'NOT_CONFIGURED' };
    const { toRunProxy } = require('./browser-run/proxy-config.cjs');
    return proxyTester.test(toRunProxy(cfg), { resolveAuth: () => ({ username: cfg.username, password: proxyConfigStore.resolvePassword(cfg.id) }) });
  }
  function ensureCluster() {
    if (phomCluster) return phomCluster;
    ensureRunManager(); ensurePhomSessions(); ensureStores();
    phomCluster = new PhomClusterCdpManager({
      openProfile: (slot, cfg) => openProfile({ slot, url: 'about:blank', proxyRef: (cfg && cfg.proxyRef) || undefined, proxyRequired: true, label: `Profile ${slot}` }),
      getRunClient: runClientFor,
      applyDeviceToClient: (client, device) => applyDeviceEmulation(client, device, null),
      testProxy: (ref) => testProxyById(ref),
      closeRun: (runId) => runManager.closeRun(runId),
      getRunInfo: runInfoFor,
      hostSession: ensurePhomSessions(),
    });
    phomCluster.on('update', (snap) => send('phom:cluster', snap));
    return phomCluster;
  }

  function send(channel, payload) { try { if (shell && !shell.isDestroyed()) shell.webContents.send(channel, payload); } catch { /* best effort */ } }

  // 2×2 workspace geometry for a profile slot, resolved against the control window's
  // current display work area. Browsers tile TL/TR/BL; the control window sits BR.
  function currentWorkArea() {
    try { const b = shell && !shell.isDestroyed() ? shell.getBounds() : null; const d = b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay(); return d.workArea; } catch { return { x: 0, y: 0, width: 1280, height: 800 }; }
  }
  function gridRectForSlot(slot) { return rectForSlot(currentWorkArea(), slot, { gap: 8 }); }
  // Re-tile all owned session runs into the 2×2 grid + place the control window BR.
  function restoreLayout() {
    try {
      const wa = currentWorkArea();
      const control = rectForSlot(wa, 'control', { gap: 8 }) || require('./protocol/phom/grid-layout.cjs').computeGridLayout(wa, { gap: 8 }).control;
      if (shell && !shell.isDestroyed() && control) shell.setBounds({ x: control.x, y: control.y, width: control.width, height: control.height });
      // Owned browser windows are external Chrome; re-applying geometry to a running
      // chrome.exe requires reopening. We report the target rects so the UI can guide
      // a reopen; we never move a window that is not one of our runs.
    } catch { /* best effort */ }
    return { ok: true };
  }
  function focusBrowser(runId) {
    try { const wc = chromeRuntime.webContents(runId); if (wc && !wc.isDestroyed() && typeof wc.focus === 'function') wc.focus(); return { ok: true }; } catch { return { ok: false }; }
  }

  // Count non-terminal BrowserRuns — the analyzer is refused whenever ANY exist.
  function liveRunCount() { try { return runManager ? runManager.list().filter((r) => r.status !== RUN_STATUS.CLOSED).length : 0; } catch { return 0; } }

  // Run the offline analyzer with a hard offline context (§16/§23). It never touches
  // the network and refuses if a live run/session is present.
  function runOfflineAnalyzer(input) {
    const ctx = { sourceKind: input.sourceKind || 'TEST_FIXTURE', networkEnabled: false, liveRunCount: liveRunCount(), liveSessionId: (phomSessions && phomSessions.active()) ? 'ACTIVE' : null, endpoint: null };
    const consistency = offlineAnalyzer.analyzeConsistency({ knownHands: input.knownHands || [], publicCards: input.publicCards || [] }, ctx);
    if (consistency && consistency.ok === false) return consistency; // PHOM_ANALYZER_OFFLINE_ONLY
    const out = { ok: true, consistency, hands: [] };
    for (const hand of (input.knownHands || [])) out.hands.push({ cards: hand, melds: offlineAnalyzer.findMelds(hand) });
    if (input.serverMelds) out.serverMeldsValidation = offlineAnalyzer.validateServerMelds(input.serverMelds, ctx);
    // safe-discard: for a chosen player hand, which discards form a phom for others.
    if (Array.isArray(input.currentHand) && Array.isArray(input.otherHands)) {
      out.safeDiscard = input.currentHand.map((card) => {
        let eatable = false;
        for (const other of input.otherHands) { const r = offlineAnalyzer.discardFormsPhom(other, card, ctx); if (r && r.forms) { eatable = true; break; } }
        return { card, status: eatable ? 'EATABLE_BY_SIMULATED_PLAYER' : 'NOT_EATABLE_BY_SIMULATED_OTHERS' };
      });
    }
    return out;
  }

  // ---- per-run capture attach + phom frame routing (mirrors Control's seam) ----
  capture.on('request', (req) => {
    if (!req || !req.isWebSocket || !req.wsDirection || !runManager) return;
    const run = runManager.runForTarget(req.targetId);
    if (!run) return;
    try {
      // When a cluster is active, frames flow through the cluster envelope (validation +
      // aggregate), which routes to the host session; otherwise route directly.
      if (phomCluster && phomCluster.active()) {
        phomCluster.ingestEvent(run.id, { raw: req.body && req.body.raw, direction: req.wsDirection, seq: req.seq, targetId: req.targetId, cdpSessionId: req.cdpSessionId, url: req.url });
      } else if (phomSessions) {
        phomSessions.routeFrame(run, req);
      }
    } catch { /* never break capture */ }
  });

  async function connectRunEndpoint(run, endpoint) {
    const manager = runManager.setTargetManager(run, endpoint);
    if (!manager) return { ok: false, error: { code: 'RUN_CLOSED', message: 'run closed' } };
    manager.on('attached', ({ target, client }) => {
      runManager.registerTarget(target.cdpTargetId, run);
      if (!run.selectedTargetId) run.selectedTargetId = target.cdpTargetId;
      attachCapture(client, target);
      // Apply this run's mobile device emulation (viewport/screen/DSF/mobile/touch/UA)
      // on the run's OWN client, and reapply on navigation / new targets.
      if (run.deviceProfile) applyDeviceEmulation(client, run.deviceProfile, run).catch(() => {});
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

  // Apply CDP mobile emulation to a run's client (per-run ownership). Each command is
  // optional/guarded so an unsupported one never crashes the profile; the applied
  // capabilities are reported. Reapply on main-frame navigation (bounded — one
  // listener per client, torn down when the target detaches).
  async function applyDeviceEmulation(client, device, run) {
    if (!client || !client.Emulation) return { applied: [], unsupported: ['Emulation'] };
    const cmds = deviceProfile.emulationCommands(device);
    const metricsCmd = cmds.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    const applied = [], unsupported = [];
    for (const c of cmds) {
      const short = c.method.split('.')[1];
      try { await client.Emulation[short](c.params); applied.push(short); } catch { unsupported.push(short); }
    }
    // Reapply metrics after a real navigation creates a fresh context (once per client).
    try {
      if (client.Page && metricsCmd && !client.__phomEmuNav) {
        client.__phomEmuNav = true;
        await client.Page.enable().catch(() => {});
        client.Page.frameNavigated((p) => { if (p && p.frame && !p.frame.parentId) client.Emulation.setDeviceMetricsOverride(metricsCmd.params).catch(() => {}); });
      }
    } catch { /* best effort */ }
    if (run) { run._deviceEmuApplied = applied; run._deviceEmuUnsupported = unsupported; }
    try { send('phom:device-applied', { runId: run && run.id, applied, unsupported, device: deviceProfile.publicSnapshot(device) }); } catch {}
    return { applied, unsupported };
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

  // §4/§6 — open ONE profile's browser with its resolved proxy (no direct fallback)
  // AND its saved mobile device profile (viewport emulation is separate from the
  // native 2×2 window size). The device belongs to the slot (browser profile), so the
  // same device is reapplied every time this slot's browser is (re)opened.
  async function openProfile({ slot, url, proxyRef, proxyRequired, label, username }) {
    // §6 — the pinned custom Chromium runtime must validate; never fall back to system Chrome.
    const rt = chromiumRuntime();
    if (!rt.ok) return rt;
    ensureRunManager(); ensurePhomSessions(); ensureStores();
    // Prefer the saved profile's proxy/device; explicit args override.
    const saved = profileStore.get(slot) || {};
    const effProxyRef = proxyRef !== undefined ? proxyRef : (saved.proxyRef || null);
    const gate = resolveLaunchProxy({ proxyRef: effProxyRef || null, proxyRequired: proxyRequired !== false }, (ref) => proxyConfigStore && proxyConfigStore.get(ref));
    if (!gate.ok) return gate; // PROXY_CONFIG_REQUIRED / NOT_FOUND — launch blocked
    const device = profileStore.deviceFor(slot);
    const run = runManager.createRun({ launchUrl: String(url || ''), proxy: gate.runProxy, windowRect: gridRectForSlot(slot), mobileTouch: !!(device && device.touch) });
    run.profileLabel = label || saved.name || `Profile ${slot}`;
    run.slot = slot;
    run.deviceProfile = device || null; // reapplied on every attach/navigation
    run.proxyUsername = username || (gate.config && gate.config.username) || null;
    const launched = await run.launcher.open(String(url || ''));
    if (!launched.ok) { runManager.failRun(run, launched.error); return { ok: false, error: launched.error }; }
    run.cdpEndpoint = launched.endpoint;
    connectRunEndpoint(run, launched.endpoint).catch(() => {});
    return { ok: true, runId: run.id, proxy: gate.runProxy, device: device ? deviceProfile.publicSnapshot(device) : null };
  }

  // ---- license gate ----
  function licenseActive() {
    if (devBypass.forbidden) return false; // packaged + bypass flag → hard block
    const s = licenseGuard && licenseGuard.status();
    return Boolean(s && s.active);
  }
  async function licenseStatus() {
    // Startup assertion (§3): a bypass flag in a packaged build is forbidden.
    if (devBypass.forbidden) return { active: false, error: { code: DEV_BYPASS_FORBIDDEN, message: 'Development license bypass is not allowed in a packaged build.' }, gameProduct: GAME_PRODUCT };
    if (!licenseGuard) return { active: false, error: { code: 'LICENSE_MISSING', message: 'License guard not ready' }, gameProduct: GAME_PRODUCT };
    let status = licenseGuard.status();
    if (!devBypass.allowed) {
      if (status.active) status = await licenseGuard.refreshAsync({ consumeLaunch: false });
      else status = await licenseGuard.refreshAsync();
    }
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
    ipcMain.handle('phom:capabilities', () => ({ featureEnabled: process.env.PHOM_QA_ENABLED === '1', authorized: phomAuthorizedEnv(), licensed: licenseActive(), devBypass: devBypass.allowed === true, licenseMode: devBypass.allowed ? 'DEVELOPMENT_BYPASS' : 'LICENSED', proxySecret: (ensureStores(), proxySecretStore.capability()) }));

    // Proxy config (metadata only; passwords never returned to the renderer).
    ipcMain.handle('phom:proxy-list', guarded(() => { ensureStores(); return { ok: true, proxies: proxyConfigStore.list() }; }));
    ipcMain.handle('phom:proxy-upsert', guarded((_e, input) => { ensureStores(); return proxyConfigStore.upsert(input || {}); }));
    // §2 — delete guarded: refuse while a BrowserRun uses this proxy (stop first). A
    // saved profile reference alone doesn't block; it's cleared on delete.
    ipcMain.handle('phom:proxy-remove', guarded((_e, id) => {
      ensureStores();
      const pid = String(id);
      const inUse = runManager && runManager.list().some((r) => r.status !== RUN_STATUS.CLOSED && (() => { const run = runManager.get(r.id); return run && run.proxy && run.proxy.id === pid; })());
      if (inUse) return { ok: false, error: { code: 'PHOM_PROXY_IN_USE', message: 'Proxy đang được một browser sử dụng. Hãy Dừng/đóng browser đó trước.' } };
      // clear any saved profile references to this proxy
      for (const slot of profileStore.slotsUsingProxy(pid)) { const p = profileStore.get(slot); profileStore.upsert(slot, { proxyRef: null }); void p; }
      return proxyConfigStore.remove(pid);
    }));
    // Device presets + per-slot profile persistence (device belongs to the browser profile).
    ipcMain.handle('phom:chromium-status', () => { const r = chromiumRuntime(); return r.ok ? { ok: true, version: r.version, architecture: r.architecture, root: r.root, checksumVerified: r.checksumVerified } : r; });
    ipcMain.handle('phom:device-presets', () => ({ ok: true, presets: deviceProfile.listPresets() }));
    ipcMain.handle('phom:profile-list', guarded(() => { ensureStores(); return { ok: true, profiles: profileStore.list() }; }));
    ipcMain.handle('phom:profile-upsert', guarded((_e, slot, input) => { ensureStores(); return profileStore.upsert(String(slot), input || {}); }));
    ipcMain.handle('phom:profile-delete', guarded((_e, slot) => { ensureStores(); return profileStore.remove(String(slot)); }));
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
    // HOST/FOLLOWER controlled-table flow.
    ipcMain.handle('phom:start-session', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.startSession({ runIds: (cfg && cfg.runIds) || [], hostId: cfg && cfg.hostId, selectedStake: cfg && cfg.selectedStake }); }));
    ipcMain.handle('phom:set-host', guarded((_e, hostId) => ensurePhomSessions().setHost(hostId)));
    ipcMain.handle('phom:select-stake', guarded((_e, stake) => ensurePhomSessions().selectStake(stake)));
    ipcMain.handle('phom:acquire-host', guarded(() => ensurePhomSessions().acquireHost()));
    ipcMain.handle('phom:join-followers', guarded(() => ensurePhomSessions().joinFollowers()));
    ipcMain.handle('phom:apply-ready', guarded(() => ensurePhomSessions().applyReady()));
    ipcMain.handle('phom:rejoin-follower', guarded((_e, id) => ensurePhomSessions().rejoinFollower(id)));
    ipcMain.handle('phom:recover-host', guarded(() => ensurePhomSessions().recoverHost()));
    ipcMain.handle('phom:leave-all', guarded(() => ensurePhomSessions().leaveAll()));
    ipcMain.handle('phom:stop', guarded(() => { ensurePhomSessions().stop(); return { ok: true }; }));
    ipcMain.handle('phom:session-state', () => (phomSessions ? phomSessions.snapshot() : null));
    ipcMain.handle('phom:verify-table', () => (phomSessions ? phomSessions.verifySameTable() : { result: 'IDLE' }));
    // PhomClusterCdpManager — control-plane over the three independent CDP clients.
    ipcMain.handle('phom:cluster-create', guarded((_e, config) => { ensureStores(); const c = config || {}; const profiles = SLOTS_ABC.map((s) => { const p = profileStore.get(s) || {}; return { slot: s, proxyRef: (c.proxyRefs && c.proxyRefs[s]) || p.proxyRef || null, device: profileStore.deviceFor(s) }; }); return ensureCluster().createCluster({ hostSlot: c.hostSlot || 'A', selectedStake: c.selectedStake, profiles }); }));
    ipcMain.handle('phom:cluster-open', guarded(() => ensureCluster().openCluster()));
    ipcMain.handle('phom:cluster-connect', guarded(() => ensureCluster().connectClusterCdp()));
    ipcMain.handle('phom:cluster-apply-devices', guarded(() => ensureCluster().applyClusterDevices()));
    ipcMain.handle('phom:cluster-test-proxies', guarded(() => ensureCluster().testClusterProxies()));
    ipcMain.handle('phom:cluster-acquire-host', guarded(() => ensureCluster().acquireHostTable()));
    ipcMain.handle('phom:cluster-join-followers', guarded(() => ensureCluster().joinFollowers()));
    ipcMain.handle('phom:cluster-apply-ready', guarded(() => ensureCluster().applyReadyPolicy()));
    ipcMain.handle('phom:cluster-leave', guarded(() => ensureCluster().leaveCluster()));
    ipcMain.handle('phom:cluster-stop', guarded(() => ensureCluster().stopCluster()));
    ipcMain.handle('phom:cluster-snapshot', () => (phomCluster ? phomCluster.getClusterSnapshot() : null));
    // 2×2 workspace layout controls (§9/§21).
    ipcMain.handle('phom:restore-layout', guarded(() => restoreLayout()));
    ipcMain.handle('phom:focus-browser', guarded((_e, runId) => focusBrowser(runId)));

    // Offline rule analyzer (§16/§23). The domain enforces the boundary again, but we
    // also refuse at the IPC edge whenever ANY live BrowserRun / session exists.
    ipcMain.handle('phom:analyzer-status', () => ({ available: liveRunCount() === 0 && !(phomSessions && phomSessions.active()), liveRunCount: liveRunCount() }));
    ipcMain.handle('phom:analyzer-analyze', (_e, input = {}) => runOfflineAnalyzer(input || {}));
  }

  app.whenReady().then(() => {
    protocol.registerFileProtocol('phom-app', (request, callback) => {
      const pathname = new URL(request.url).pathname.replace(/^\/+/, '');
      callback({ path: path.join(__dirname, '..', 'ui-phom', pathname.replace(/^ui\//, '')) });
    });
    licenseGuard = new LicenseGuard({ userDataPath: PHOM_USERDATA, safeStorage, expectedGameProduct: GAME_PRODUCT, devBypass: devBypass.allowed });
    licenseGuard.initialize();
    licenseGuard.initializeAsync().then((status) => { send('phom:license', { ...status, gameProduct: GAME_PRODUCT }); }).catch(() => {});
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { PRODUCT_NAME, GAME_PRODUCT };
