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

const { app, BrowserWindow, ipcMain, protocol, safeStorage, screen, net, session, shell: electronShell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { redactDiagnostic } = require('./protocol/phom/diagnostic-redaction.cjs');

const { ChromeRuntime } = require('./browser/chrome-runtime.cjs');
const { lifecycleLog } = require('./browser/chrome-launcher.cjs');
const phomChromium = require('./browser/phom-chromium-runtime.cjs');
const browserRuntimeResolver = require('./browser/browser-runtime-resolver.cjs');
const { resolveSandboxPolicy, DIAGNOSTIC_ENV } = require('./browser/chromium-sandbox-policy.cjs');
const { BrowserRunManager, STATUS: RUN_STATUS } = require('./browser-run/browser-run-manager.cjs');
const { CaptureCorrelator } = require('./cdp/capture.cjs');
const { WsReplay } = require('./cdp/ws-replay.cjs');
const { HostSessionManager } = require('./protocol/phom/host-session-manager.cjs');
const { createSafeCardAnalyzer } = require('./protocol/phom/phom-safe-card-analyzer.cjs'); // PHASE 6.3.3.3 — read-only analyzer
const { isPhomRelevant } = require('./protocol/phom/phom-ws-filter.cjs');
const { PhomClusterCdpManager } = require('./protocol/phom/phom-cluster-cdp-manager.cjs');
const { createFrameRecorder } = require('./protocol/phom/frame-recorder.cjs');
const { ProxyConfigStore } = require('./browser-run/proxy-config-store.cjs');
const { ProxySecretStore } = require('./browser-run/proxy-secret-store.cjs');
const { ProxyTester } = require('./browser-run/proxy-tester.cjs');
const { resolveLaunchProxy } = require('./browser-run/proxy-config.cjs');
const { PhomProfileStore } = require('./browser-run/phom-profile-store.cjs');
const { PhomDeviceProfilesStore } = require('./browser-run/phom-device-profiles-store.cjs');
const { runEnterGameViaSite } = require('./protocol/cocos-lobby-entry.cjs');
const { GAME_ID: PHOM_GAME_ID } = require('./protocol/phom/phom-frame-classify.cjs');
const browserAgent = require('./browser-run/browser-agent.cjs');
const { bindProxyAuth } = require('./browser-run/proxy-auth-handler.cjs');
const { LicenseGuard } = require('./licensing/license-guard.cjs');
const { resolveDevBypass, FORBIDDEN_CODE: DEV_BYPASS_FORBIDDEN } = require('./licensing/dev-bypass.cjs');
const { parseObservedIp } = require('./browser-run/ip-parse.cjs');
const { rectForSlot, toolWindowBounds, arrangeClusterWindows } = require('./protocol/phom/grid-layout.cjs');
const gameHeader = require('./protocol/phom/game-header.cjs');
const headerBridge = require('./protocol/phom/phom-header-bridge.cjs');
const anDanh = require('./protocol/phom/an-danh.cjs');
const crypto = require('node:crypto');
const windowLayout = require('./protocol/phom/window-layout.cjs');
const { createRoundJournal } = require('./protocol/phom/round-journal.cjs');
const { deriveBrowserState } = require('./protocol/phom/browser-state.cjs');
const headerActionGuard = require('./protocol/phom/header-action-guard.cjs');
const { evaluateHeaderAction } = headerActionGuard;
const { normalizeWindowBounds } = require('./window-bounds.cjs');

const PRODUCT_NAME = 'Phom QA';
const GAME_PRODUCT = 'PHOM';
// §11 — the tool defaults to the bottom-right quadrant (≈ 1/4 work area). The minimums
// are kept small enough to fit a quadrant on common resolutions (a 1920-wide work area
// has ~956px quadrants); the compact Setup/Control layouts scroll if a quadrant is
// smaller than the minimum on low-resolution displays.
const WIN_DEFAULTS = Object.freeze({ minWidth: 380, minHeight: 480 });
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
  var deviceProfilesStore = null; // PHASE-6.3.1 flexible N-profile store
  var phomSessions = null;
  // Lọc Bài: one analyzer PER account, so each P1/P2/P3 column is computed (and memoised) on its own — every one of
  // them from the SAME shared observation, i.e. with the cards of all three accounts known.
  const slotAnalyzers = { B1: createSafeCardAnalyzer(), B2: createSafeCardAnalyzer(), B3: createSafeCardAnalyzer() };
  const SLOTS_ABC = ['A', 'B', 'C'];
  const RESERVE_SLOTS = ['D', 'E']; // the 4th/5th ticked profile: open, not playing, behind the tool

  const phomRoot = () => path.join(PHOM_USERDATA, 'phom');
  const ensureDir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ } };

  // ---- capture + send seam (shared, target-keyed) ----
  // Only Phỏm frames get past the capture (phom-ws-filter), and none is retained: the tool never reads one back.
  const capture = new CaptureCorrelator({ resolveClient: (tid) => resolveTargetClient(tid), keepWsFrames: false, wsFilter: isPhomRelevant });
  const wsReplay = new WsReplay({ resolveClient: (tid) => resolveTargetClient(tid), getCaptured: (id) => capture.get(id) });
  // TEST D — passive recorder of the game's own frames between a user START/STOP (see frame-recorder.cjs).
  const frameRecorder = createFrameRecorder();
  // Stop the recording and write it as JSON + a readable one-line-per-frame .txt under userData/phom-captures.
  function stopAndSaveCapture() {
    const out = frameRecorder.stop();
    if (!out) return { ok: false, error: { code: 'PHOM_NOT_RECORDING', message: 'Chưa bắt đầu ghi gói' } };
    try {
      const dir = path.join(app.getPath('userData'), 'phom-captures');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.join(dir, 'test-D-' + stamp);
      fs.writeFileSync(base + '.json', JSON.stringify(out, null, 2), 'utf8');
      const lines = ['# ' + (out.label || 'Test D') + ' — ' + out.frameCount + ' gói trong ' + Math.round(out.durationMs / 1000) + 's' + (out.dropped ? ', bỏ ' + out.dropped : '')];
      for (const f of out.frames) lines.push(String(f.t).padStart(7) + 'ms  [' + (f.label || f.runId) + ']  ' + f.summary);
      fs.writeFileSync(base + '.txt', lines.join('\n'), 'utf8');
      const name = path.basename(base + '.txt');
      return { ok: true, path: base + '.json', txtPath: base + '.txt', fileName: name, frameCount: out.frameCount, dropped: out.dropped, byType: out.byType, preview: lines.slice(0, 60), runIds: out.runIds };
    } catch (e) {
      return { ok: false, error: { code: 'PHOM_CAPTURE_WRITE_FAILED', message: String(e && e.message || e) } };
    }
  }
  // ALWAYS-ON co-seat wire log → userData/phom-captures/coseat.jsonl. One JSON line per JOIN request/response +
  // resulting table membership + room code, so "who landed at which table with which code" can be read directly
  // from a file (no Test D recorder, no env var). Truncated once per app launch, and size-capped so it can't grow
  // without bound. Room codes ARE kept here (this is the co-seat evidence); it carries no login credential.
  let _coseatInit = false;
  function coseatLogPath() { return path.join(app.getPath('userData'), 'phom-captures', 'coseat.jsonl'); }
  function _archiveCoseat(dir, reason) {
    try { const p = coseatLogPath(); if (fs.existsSync(p)) { const arch = path.join(dir, 'coseat-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl'); fs.renameSync(p, arch); } } catch { /* best effort */ }
    try { fs.writeFileSync(coseatLogPath(), '# SESSION ' + (reason || '') + ' ' + new Date().toISOString() + '\n'
        // Every line goes through redactDiagnostic (appendCoseatLog): passwords / tokens / cookies are masked, and the
        // few server frames kept verbatim (a refused join, a kick) are dropped when they could hold a secret. It still
        // names accounts, tables and money — share it only with whoever debugs the tool.
        + '# Nhật ký chẩn đoán Phỏm QA — mật khẩu/token đã được che; vẫn có tên acc, số bàn, tiền: chỉ gửi cho người hỗ trợ.\n', 'utf8'); } catch { /* best effort */ }
  }
  // §ws-log — the capture is ALWAYS ON and takes EVERY non-heartbeat frame of all three browsers, so it used
  // to do one BLOCKING fs.appendFileSync per frame on the Electron main process — the same thread that serves
  // CDP, IPC and the header pushes. Batch instead: queue the lines and write them in ONE call at most every
  // COSEAT_FLUSH_MS. Same bytes, same rotation, same ordering; the per-frame stall is gone. A crash can lose
  // at most one flush interval, which is the right trade for a diagnostic log.
  const COSEAT_FLUSH_MS = 250;
  const COSEAT_MAX_QUEUE = 2000; // a burst flushes immediately rather than growing without bound
  let _coseatQueue = [];
  let _coseatFlushTimer = null;
  function _coseatFlush() {
    if (_coseatFlushTimer) { try { clearTimeout(_coseatFlushTimer); } catch { /* ignore */ } _coseatFlushTimer = null; }
    if (!_coseatQueue.length) return;
    const batch = _coseatQueue; _coseatQueue = [];
    try {
      const dir = path.join(app.getPath('userData'), 'phom-captures'); fs.mkdirSync(dir, { recursive: true });
      const p = coseatLogPath();
      // NEVER overwrite: on the first write of a run ARCHIVE the previous session's log (rename by time) so
      // history is kept; and ROTATE (archive) when it grows large instead of dropping frames.
      if (!_coseatInit) { _archiveCoseat(dir, 'start'); _coseatInit = true; }
      else { try { if (fs.statSync(p).size > 60 * 1024 * 1024) _archiveCoseat(dir, 'rotate'); } catch { /* file may not exist yet */ } }
      fs.appendFileSync(p, batch.join('\n') + '\n', 'utf8');
    } catch { /* never throw from logging */ }
  }
  function appendCoseatLog(entry) {
    let line; try { line = JSON.stringify(redactDiagnostic(entry)); } catch { return; }
    _coseatQueue.push(line);
    if (_coseatQueue.length >= COSEAT_MAX_QUEUE) _coseatFlush();
    else if (!_coseatFlushTimer) _coseatFlushTimer = setTimeout(_coseatFlush, COSEAT_FLUSH_MS);
  }
  // Resolve + validate the pinned custom Chromium runtime once (dev vs packaged). No
  // system-Chrome fallback: an invalid runtime blocks browser launches with a typed error.
  var _chromiumRuntime = null;
  function chromiumRuntime() {
    if (_chromiumRuntime) return _chromiumRuntime;
    _chromiumRuntime = phomChromium.resolveAndValidate({ env: process.env, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, projectRoot: path.join(__dirname, '..') });
    return _chromiumRuntime;
  }
  // PHASE 6.3.2.2 — BROWSER RUNTIME preference (AUTO | CUSTOM_CHROMIUM | GOOGLE_CHROME), persisted so the
  // choice survives restarts. AUTO uses the pinned custom Chromium and falls back to Google Chrome.
  function browserRuntimeSettingPath() { return path.join(phomRoot(), 'browser-runtime.json'); }
  // nothing saved yet → the bundled Chromium (user 2026-10-05)
  const DEFAULT_BROWSER_RUNTIME = 'CUSTOM_CHROMIUM';
  var _browserRuntimePref = null;
  function browserRuntimePref() {
    if (_browserRuntimePref) return _browserRuntimePref;
    try { const j = JSON.parse(fs.readFileSync(browserRuntimeSettingPath(), 'utf8')); _browserRuntimePref = browserRuntimeResolver.normalizePreference(j && j.preference); }
    catch { _browserRuntimePref = DEFAULT_BROWSER_RUNTIME; }
    return _browserRuntimePref;
  }
  function setBrowserRuntimePref(p) {
    _browserRuntimePref = browserRuntimeResolver.normalizePreference(p);
    try { ensureDir(phomRoot()); fs.writeFileSync(browserRuntimeSettingPath(), JSON.stringify({ preference: _browserRuntimePref }, null, 2), 'utf8'); } catch { /* best effort */ }
    return _browserRuntimePref;
  }
  // Resolve the executable for a launch given the current preference (custom Chromium result injected).
  function resolveBrowserRuntimeChoice() {
    return browserRuntimeResolver.resolveBrowserRuntime({ preference: browserRuntimePref(), customChromium: chromiumRuntime(), env: process.env });
  }
  const chromeRuntime = new ChromeRuntime({
    chromeExecutable: (() => { const r = chromiumRuntime(); return r && r.ok ? r.executable : null; })(),
    // A run's Chrome exited on its OWN (user closed the window / crash). Mark ONLY that
    // slot closed and disconnect ITS routing — never cascade a close to the other browsers
    // and never treat it as an orchestration teardown (§10).
    onRunExit: (runId, record) => {
      let closed = null;
      try { lifecycleLog('MAIN_ON_RUN_EXIT', { runId, reason: record && record.reason }); if (runManager) runManager.disconnectRun(runManager.get(runId)); phomSessions.routeDisconnect(runId); if (phomCluster && phomCluster.markRunClosed) closed = phomCluster.markRunClosed(runId, record && record.reason); } catch { /* best effort */ }
      // N4 — a closed RESERVE leaves the Phỏm session (no dead member); MỞ LẠI on its card adds it back
      try { if (closed && closed.ok && RESERVE_SLOTS.includes(closed.slot) && phomSessions) phomSessions.removeRun(runId); } catch { /* best effort */ }
      autoReplaceFromReserve(runId, closed);
    },
  });
  // Runs the TOOL is closing (⏻, Thay profile, Đóng tất cả) — their exit is the user's own choice in the tool, so no
  // reserve is swapped in for them.
  const toolClosingRuns = new Set();
  // A PLAYING browser (P1/P2/P3) was closed straight from its window: the first open reserve (P4, then P5) takes that
  // slot at once — same place, same Phỏm session position. Closing from the tool never does this.
  function autoReplaceFromReserve(runId, closed) {
    const rid = String(runId);
    if (toolClosingRuns.delete(rid)) return;
    if (!closed || !closed.ok || !SLOTS_ABC.includes(closed.slot) || !phomCluster || !phomCluster.active()) return;
    const snap = phomCluster.getClusterSnapshot();
    const reserve = RESERVE_SLOTS.find((r) => snap.reserves && snap.reserves[r] && snap.reserves[r].profileId && snap.reserves[r].browserState === 'OPEN');
    if (!reserve) return;
    swapSlot(closed.slot, reserve)
      .then((res) => {
        lifecycleLog('SLOT_AUTO_REPLACED', { slot: closed.slot, reserve, closedRun: rid, ok: !!(res && res.ok) });
        send('phom:notice', res && res.ok
          ? { event: 'SLOT_AUTO_REPLACED', slot: closed.slot, reserve, label: res.label || null }
          : { event: 'SLOT_AUTO_REPLACE_FAILED', slot: closed.slot, error: res && res.error });
      })
      .catch(() => {});
  }

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
    // PHASE-6.3.1 — the canonical flexible profile LIST store (N profiles; add/edit/delete + selection).
    deviceProfilesStore = new PhomDeviceProfilesStore({ filePath: path.join(phomRoot(), 'phom-device-profiles.json') });
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
    // §9 lag fix — coalesce the per-frame 'update'/'hands' storm (leading+trailing throttle). pushHeaderStates
    // dedupes unchanged states so steady-state WS traffic costs ~0 CDP evaluates.
    phomSessions.on('update', (snap) => { scheduleSessionBroadcast(snap); });
    phomSessions.on('cards', (cards) => { scheduleCardsBroadcast(cards); }); // PHASE 6.3.3.2 — card observation

    phomSessions.on('kick', (k) => send('phom:kick', k));
    // docs/phom-kich-ban.md — what the group flow just did (created, joined, kicked, table lost, rejoined…).
    // The screen turns these into one plain-Vietnamese line, so a paced operation never looks like a freeze.
    phomSessions.on('notice', (n) => send('phom:notice', n));
    phomSessions.on('log', (l) => { try { if (l && l.tag === 'PHOM-COSEAT') appendCoseatLog(l); } catch {} try { if (process.env.PHOM_LIFECYCLE_LOG === '1') console.log(`[${l.tag}] ${l.event}`, JSON.stringify(l)); } catch {} });
    return phomSessions;
  }

  function phomAuthorizedEnv() {
    // A valid product license (or the dev bypass) IS the authorization for manual QA control — that is the
    // gate an end user passes by activating the app. The legacy env/IP opt-in stays for headless CI runs
    // that have no license, but is no longer required for a normally licensed desktop app.
    if (licenseActive()) return true;
    if (process.env.PHOM_QA_ENABLED !== '1') return false;
    return process.env.PHOM_QA_AUTHORIZED === '1' || IP_CHECK_ALLOWLIST.length > 0;
  }

  // ---- PhomClusterCdpManager: control-plane over the three independent CDP clients ----
  var phomCluster = null;
  // LOCAL RUNTIME TEST (§3): dev-only, opens browsers WITHOUT a proxy for browser/CDP/
  // device verification against a local page. Honored ONLY when the development license
  // bypass is active — it never relaxes the production proxy gate or any live workflow.
  var clusterLocalTest = false;
  function localTestActive() { return clusterLocalTest && devBypass.allowed === true; }

  // Decide the Chromium sandbox policy for a specific launch. Sandbox is ON by default;
  // the dev diagnostic bypass is refused in packaged/production and requires every guard
  // (dev bypass + local runtime test + no game endpoint + no live proxy). See
  // chromium-sandbox-policy.cjs. Returns the pure decision object.
  function sandboxPolicyFor({ url, runProxy } = {}) {
    const hasGameEndpoint = !!(url && !/^about:blank$/i.test(String(url).trim()));
    return resolveSandboxPolicy({
      isPackaged: app.isPackaged,
      nodeEnv: process.env.NODE_ENV || (app.isPackaged ? 'production' : 'development'),
      devBypassAllowed: devBypass.allowed === true,
      localTest: localTestActive(),
      diagnosticFlag: process.env[DIAGNOSTIC_ENV] === '1',
      hasGameEndpoint,
      hasLiveProxy: !!runProxy,
    });
  }
  var lastSandboxPolicy = { mode: 'SANDBOX_ENABLED', sandboxDisabled: false };
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
  // PHASE-6.3.1 — is a flexible profile currently backing a LIVE Chromium? (guards delete/proxy-change §30)
  function profileInUse(profileId) {
    try { return runManager && runManager.list().some((r) => { if (r.status === RUN_STATUS.CLOSED) return false; const run = runManager.get(r.id); return run && String(run.profileId) === String(profileId); }); }
    catch { return false; }
  }
  // Open 3 browsers from the SELECTED flexible profiles (selection order → B1/B2/B3 via internal slots
  // A/B/C). Each browser gets ITS profile's own device + proxy; a shared Game URL is used for all three.
  function openSelectedProfiles({ profileIds, gameUrl, localTest } = {}) {
    ensureStores();
    const ids = Array.isArray(profileIds) ? profileIds.map((x) => String(x)) : [];
    // 3 play (P1/P2/P3); a 4th/5th opens as a RESERVE behind the tool, swapped in from the Phỏm tab
    if (ids.length < 3 || ids.length > 3 + RESERVE_SLOTS.length || new Set(ids).size !== ids.length) return { ok: false, error: { code: 'PHOM_SELECT_THREE', message: 'Chọn 3 đến 5 hồ sơ khác nhau.' } };
    clusterLocalTest = !!(localTest && devBypass.allowed);
    // A typed Game URL (if any) OVERRIDES + is REMEMBERED; otherwise each profile falls back to its own
    // saved gameUrl so the URL never has to be re-typed on the next launch (§6.3.2-fix).
    const typedUrl = !localTestActive() && gameUrl != null ? String(gameUrl).trim() : '';
    const profiles = [];
    for (let i = 0; i < ids.length; i++) {
      const p = deviceProfilesStore.get(ids[i]);
      if (!p) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `Hồ sơ ${ids[i]} không tồn tại.` } };
      const profUrl = localTestActive() ? 'about:blank' : (typedUrl || (p.gameUrl ? String(p.gameUrl).trim() : ''));
      if (!localTestActive() && !profUrl) return { ok: false, error: { code: 'PHOM_GAME_URL_REQUIRED', message: 'Nhập Game URL (hoặc lưu URL trong hồ sơ) trước khi mở.' } };
      // Remember the URL on the profile so the next app launch reuses it (with the persistent user-data-dir
      // this returns straight to the logged-in game — no re-login).
      if (!localTestActive() && profUrl && profUrl !== (p.gameUrl || '')) { try { deviceProfilesStore.update(ids[i], { gameUrl: profUrl }); } catch { /* best effort */ } }
      // slot A/B/C = the runtime B1/B2/B3 window; browserProfileId carries the flexible profile id.
      profiles.push({ slot: i < 3 ? SLOTS_ABC[i] : RESERVE_SLOTS[i - 3], browserProfileId: p.id, profileId: p.id, agent: deviceProfilesStore.agentFor(p.id), proxyRef: p.proxyRef || null, gameUrl: profUrl, label: p.name });
    }
    const clusterUrl = localTestActive() ? 'about:blank' : (profiles[0] ? profiles[0].gameUrl : typedUrl);
    const res = ensureCluster().createCluster({ clusterProfileId: null, hostSlot: 'A', selectedStake: null, gameUrl: clusterUrl, profiles: profiles.slice(0, 3), reserves: profiles.slice(3) });
    if (res && res.ok === false) return res;
    return res && res.ok ? { ...res, localTest: localTestActive(), gameUrl: clusterUrl, mapping: ids.map((id, i) => ({ browser: 'B' + (i + 1), profileId: id })) } : res;
  }

  function ensureCluster() {
    if (phomCluster) return phomCluster;
    ensureRunManager(); ensurePhomSessions(); ensureStores();
    phomCluster = new PhomClusterCdpManager({
      // In LOCAL RUNTIME TEST the browser opens at a neutral local page (about:blank, §7)
      // for browser/CDP/device verification; otherwise it navigates to the profile's
      // AUTHORITATIVE shared game URL (used only after the CTA, never at boot). Proxy is
      // OPTIONAL: a slot with a proxyRef runs PROXY (enforced, no silent fallback); a slot
      // without one runs DIRECT. The browser profile identity comes from the saved profile
      // projection, not the slot.
      openProfile: (slot, cfg) => openProfile({
        slot,
        profileKey: (cfg && cfg.browserProfileId) || slot,
        // PHASE-6.3.1 — a flexible selected profile carries its own id (as browserProfileId) + its agent.
        profileId: (cfg && (cfg.profileId || cfg.browserProfileId)) || null,
        agent: (cfg && cfg.agent) || null,
        url: localTestActive() ? 'about:blank' : ((cfg && cfg.gameUrl) || 'about:blank'),
        // The cluster projection is AUTHORITATIVE for proxy: pass the resolved ref EXPLICITLY
        // (null = DIRECT). Never send `undefined`, which would make openProfile silently fall
        // back to the per-slot profile's stale proxyRef — the DIRECT-has-no-network bug where a
        // "DIRECT" slot inherited an old (dead) proxy from phom-profiles.json metadata.
        proxyRef: (cfg && cfg.proxyRef) ? cfg.proxyRef : null,
        proxyRequired: false, // proxy optional: presence of proxyRef governs PROXY vs DIRECT
        label: (cfg && cfg.label) || `Profile ${slot}`,
      }),
      getRunClient: runClientFor,
      applyAgentToClient: (client, agent) => applyBrowserAgent(client, agent, null),
      testProxy: (ref) => testProxyById(ref),
      closeRun: (runId) => runManager.closeRun(runId),
      getRunInfo: runInfoFor,
      hostSession: ensurePhomSessions(),
    });
    phomCluster.on('update', (snap) => { send('phom:cluster', snap); syncToolOnTop(snap); });
    return phomCluster;
  }
  // A RESERVE browser (P4/P5) sits exactly where the tool is; Chromium windows that open (or get focus) later would
  // cover it. While any reserve is open the tool stays above them (always-on-top); with no reserve it is a normal
  // window again. Changed only when the reserve count flips.
  let _toolOnTop = false;
  function syncToolOnTop(snap) {
    const rs = (snap && snap.reserves) || {};
    const want = !!(snap && !snap.stopped && Object.values(rs).some((r) => r && r.profileId && r.browserState === 'OPEN'));
    if (want === _toolOnTop) return;
    _toolOnTop = want;
    try { if (shell && !shell.isDestroyed()) { shell.setAlwaysOnTop(want); if (want) shell.moveTop(); } } catch { /* best effort */ }
    headerLog('TOOL_ON_TOP', { on: want });
  }

  function send(channel, payload) { try { if (shell && !shell.isDestroyed()) shell.webContents.send(channel, payload); } catch { /* best effort */ } }

  // 2×2 workspace geometry for a profile slot, resolved against the control window's
  // current display work area. Browsers tile TL/TR/BL; the control window sits BR.
  function currentWorkArea() {
    try { const b = shell && !shell.isDestroyed() ? shell.getBounds() : null; const d = b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay(); return d.workArea; } catch { return { x: 0, y: 0, width: 1280, height: 800 }; }
  }
  function gridRectForSlot(slot) { return rectForSlot(currentWorkArea(), slot, { gap: 8 }); }
  // PHASE-6 — the deterministic 3-window arrangement across the LIVE display topology (one browser per
  // monitor when ≥3 monitors; tiled otherwise). Uses the three slot devices' viewports so each window
  // fits its mobile-landscape content. Pure geometry (grid-layout); the placement is applied via each
  // run's chrome --window-position/--window-size at launch.
  // §7/§8 — carry BOTH the OS window size and the emulated viewport to grid-layout.
  // A device may request an explicit desktop OS window (e.g. 960×540) that is
  // independent from its game viewport (e.g. 851×393). Legacy mobile-only profiles
  // carry osWindow=null; the geometry layer falls back to viewport + chrome.
  // PHASE-6.2 — the FOUR-window arrangement (3 desktop Chromium windows + the Tool window). Browsers use
  // .slots[1..3]; the Tool window is placed at .tool.
  // User rule 2026-10-05: every game window is ONE QUARTER of a screen — always the 2×2 grid on the monitor the
  // tool is on (P1 TL · P2 TR · P3 BL · tool BR, reserves behind the tool), whatever the number of monitors. With 2+
  // monitors the old per-monitor layout made a browser fill a whole screen.
  function clusterFourWindowArrangement() { return arrangeClusterWindows([currentWorkArea()], { gap: 8 }); }
  // The window of a slot: A/B/C = the three playing places; a RESERVE browser (D/E, not playing) sits exactly where
  // the Phỏm tool is, behind it.
  // MỨC CƯỢC — the last stake the user picked is remembered across restarts (stake.json), not picked again each time.
  function stakePath() { return path.join(phomRoot(), 'stake.json'); }
  function savedStake() { try { const v = Number(JSON.parse(fs.readFileSync(stakePath(), 'utf8')).stake); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } }
  function saveStake(stake) {
    const v = Number(stake);
    try { ensureDir(phomRoot()); fs.writeFileSync(stakePath(), JSON.stringify({ stake: Number.isFinite(v) && v > 0 ? v : null }, null, 2), 'utf8'); } catch { /* best effort */ }
  }
  // The quarter each window takes follows the user's LAYOUT (window-layout.cjs; default P2|P3 over P1|Tool), saved in
  // window-layout.json. A reserve (D/E) sits in the tool's quarter, behind it.
  function windowLayoutPath() { return path.join(phomRoot(), 'window-layout.json'); }
  let _windowLayout = null;
  function currentWindowLayout() {
    if (_windowLayout) return _windowLayout;
    try { _windowLayout = windowLayout.normalizeLayout(JSON.parse(fs.readFileSync(windowLayoutPath(), 'utf8'))); }
    catch { _windowLayout = { ...windowLayout.DEFAULT_LAYOUT }; }
    return _windowLayout;
  }
  function setWindowLayout(layout) {
    _windowLayout = windowLayout.normalizeLayout(layout);
    try { ensureDir(phomRoot()); fs.writeFileSync(windowLayoutPath(), JSON.stringify(_windowLayout, null, 2), 'utf8'); } catch { /* best effort */ }
    return _windowLayout;
  }
  function windowRectForSlot(slot) {
    const item = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E' }[slot] || 'TOOL';
    let r = null;
    try { r = windowLayout.rectForItem(item, clusterFourWindowArrangement(), currentWindowLayout()); } catch { r = null; }
    return r || gridRectForSlot(item === 'B' || item === 'C' ? item : 'A');
  }
  // Move a RUNNING browser's window (CDP Browser.setWindowBounds through its own page client). Best effort.
  async function moveRunWindow(runId, rect) {
    const client = runClientFor(runId);
    if (!client || !client.Browser || !rect) return false;
    try {
      const { windowId } = await client.Browser.getWindowForTarget({});
      await client.Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      await client.Browser.setWindowBounds({ windowId, bounds: { left: Math.round(rect.x), top: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
      return true;
    } catch { return false; }
  }
  // Re-tile all owned session runs into the 2×2 grid + place the control window BR.
  function restoreLayout() {
    try {
      const wa = currentWorkArea();
      // The Tool is the 4th quarter (bottom-right) of the 2×2 grid on its own monitor. Falls back to the
      // bottom-right quadrant if the arrangement is unavailable.
      let control = null;
      try { control = windowLayout.rectForItem('TOOL', clusterFourWindowArrangement(), currentWindowLayout()); } catch { control = null; }
      if (!control) control = toolWindowBounds(wa, { minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight });
      if (shell && !shell.isDestroyed() && control) shell.setBounds({ x: Math.round(control.x), y: Math.round(control.y), width: Math.round(control.width), height: Math.round(control.height) });
      // XẾP CỬA SỔ also puts every OPEN browser back into its quarter (P1/P2/P3) or behind the tool (P4/P5) — no
      // reopen needed to fix windows that were moved or opened full-size.
      try {
        const snap = phomCluster && phomCluster.active() ? phomCluster.getClusterSnapshot() : null;
        if (snap) {
          for (const s of SLOTS_ABC) { const p = snap.profiles[s]; if (p && p.profileId && p.browserState === 'OPEN') moveRunWindow(p.profileId, windowRectForSlot(s)).catch(() => {}); }
          for (const r of RESERVE_SLOTS) { const p = snap.reserves && snap.reserves[r]; if (p && p.profileId && p.browserState === 'OPEN') moveRunWindow(p.profileId, windowRectForSlot(r)).catch(() => {}); }
        }
      } catch { /* best effort */ }
      // reserve browsers (4th/5th profile) open at the tool's place — keep the tool in front of them
      if (shell && !shell.isDestroyed()) shell.moveTop();
      // Only our own runs are moved (through each run's own CDP client); no other window is touched.
    } catch { /* best effort */ }
    return { ok: true };
  }

  // ---- VÀO GAME PHỎM — trigger the VERIFIED entry action id `vgcg_8` (§1-§5) ---------------
  // We do NOT guess a URL/deep-link/selector and do NOT send a raw protocol frame. We REUSE the
  // exact in-engine ACTION mechanism Aviator uses (runEnterGameViaSite): resolve the NewLobby
  // Cocos tile node whose NAME == the Phỏm game id (`vgcg_8`) and fire ITS OWN wired cc.Button —
  // the site's own handlers then perform the authenticated entry. INVOKED != ENTERED: readiness is
  // confirmed ONLY by the authoritative Simms session signal (socketReady+uid), never the click.
  async function phomEnterGame(runId) {
    const client = runClientFor(String(runId));
    if (!client || !client.Runtime) return { ok: false, error: { code: 'PHOM_ENTRY_NO_CLIENT', message: `no CDP client for run ${runId}` } };
    const diag = (f) => { try { lifecycleLog('PHOM_ENTER_GAME', { runId: String(runId), gameId: PHOM_GAME_ID, ...f }); } catch { /* ignore */ } };
    const r = await runEnterGameViaSite(client, undefined, PHOM_GAME_ID, diag);
    if (r && r.ok) return { ok: true, gameId: PHOM_GAME_ID };
    return { ok: false, gameId: PHOM_GAME_ID, error: (r && r.error) || { code: 'ENTRY_SITE_SEAM_UNAVAILABLE' } };
  }

  // ---- PHASE 6.3.2 — IN-CHROMIUM GAME HEADER bridge ---------------------------------------------
  // Each managed Chromium gets a tool-owned control bar (game-header.cjs) injected via CDP. Button
  // clicks arrive here through the window.__phomAction binding; we route them to the SAME manual APIs
  // the (now read-only) Tool screen used, and push a freshly-derived state back into every page. Main is
  // pure glue: the button decision lives in the pure deriveHeaderState; the coordinator remains the only
  // source of business truth (find/join/leave semantics unchanged).
  const headerEntering = Object.create(null); // runId -> true while VÀO GAME is in flight (transient)
  const headerError = Object.create(null);    // runId -> last action error message (transient, per browser)
  const headerActionBusy = Object.create(null); // runId -> true while ANY header op is in flight (dup guard)
  const headerLastActionId = Object.create(null); // runId -> last ACCEPTED actionId (dedupes re-delivery)
  const headerReady = Object.create(null);      // runId -> true once the header bridge installed (binding ready)
  const headerDomPresent = Object.create(null); // runId -> true when the PAGE confirmed #__phom_header exists
  const headerLastPushed = Object.create(null); // runId -> last pushed state JSON (skip unchanged evaluates)
  const headerKeys = Object.create(null); // runId -> Set of secrets its bar was booted with (N3)
  let anDanhOn = false; // the tool's ẨN DANH switch — default OFF (the game's own default is ON)
  const headerEnterStartedAt = Object.create(null); // runId -> monotonic ms at ENTER_GAME accept (latency)
  const headerEnterTimer = Object.create(null);     // runId -> bounded ENTERING timeout handle (§10 not-stuck)
  // PHASE 6.3.6 — the USER-selected FINDER (room anchor), by Player index 1/2/3; null = none chosen yet (every
  // browser may FIND). NEVER defaulted to Player 1. Independent of the analyzer's selected player.

  const nowMs = () => { try { return require('node:perf_hooks').performance.now(); } catch { return Date.now(); } };
  // PHASE 6.3.6 — cancel a run's bounded ENTERING timeout (evidence arrived / failed / reset / re-enter).
  function clearHeaderEnterTimer(rid) { const t = headerEnterTimer[rid]; if (t) { try { clearTimeout(t); } catch { /* ignore */ } delete headerEnterTimer[rid]; } }
  // PHASE 6.3.6 §10 — arm the BOUNDED ENTERING timeout. The tile click is INVOKED != ENTERED, so if no
  // authoritative inGame evidence arrives within the window we clear the transient and re-push, reverting the
  // header to NOT_IN_GAME ("VÀO GAME") instead of a permanent "ĐANG VÀO GAME…". Re-arming cancels any prior.
  function armEnterTimeout(rid) {
    clearHeaderEnterTimer(rid);
    headerEnterTimer[rid] = setTimeout(() => {
      delete headerEnterTimer[rid];
      if (headerEntering[rid]) { delete headerEntering[rid]; delete headerEnterStartedAt[rid]; headerLog('ENTER_GAME_TIMEOUT', { runId: rid, elapsedMs: gameHeader.ENTER_GAME_TIMEOUT_MS }); pushHeaderStates(); }
    }, gameHeader.ENTER_GAME_TIMEOUT_MS);
  }

  // VÀO GAME on one browser — the header button and the auto entry both come through here. Starts the click→ENTERED
  // clock, shows ĐANG VÀO GAME, fires the vgcg_8 tile (INVOKED != ENTERED) and arms the bounded ENTERING timeout.
  async function startEnterGame(rid, meta = {}) {
    headerEnterStartedAt[rid] = nowMs(); // T6 — start the click→ENTERED latency clock (§2/§17)
    headerEntering[rid] = true;
    armEnterTimeout(rid); // §10 — bounded ENTERING (INVOKED != ENTERED): reverts to NOT_IN_GAME if no evidence
    pushHeaderStates();
    headerLog('ENTER_GAME_START', { runId: rid, ...meta, elapsedMs: 0 });
    let res;
    try { res = await phomEnterGame(rid); } catch (e) { res = { ok: false, error: { code: 'PHOM_ENTRY_FAILED', message: safeMsg(e) } }; }
    if (!res || res.ok === false) { delete headerEntering[rid]; delete headerEnterStartedAt[rid]; clearHeaderEnterTimer(rid); }
    headerLog(res && res.ok ? 'ENTER_GAME_ACTION_SENT' : 'ENTER_GAME_FAIL', { runId: rid, ...meta, ok: !!(res && res.ok), elapsedMs: Math.round(nowMs() - (headerEnterStartedAt[rid] != null ? headerEnterStartedAt[rid] : nowMs())) });
    return res;
  }

  // §auto-enter — as soon as a browser has LOGGED IN (the server pushed the account's own identity, cmd 100, on its
  // game socket) and is not in Phỏm yet, the tool presses VÀO GAME for it. Once per page load: when Phỏm is reached it
  // stops for good (leaving Phỏm on purpose is not undone); a click that did not get in is retried a few times — the
  // lobby scene may still be building right after login. PHOM_AUTO_ENTER=0 turns it off.
  const AUTO_ENTER_SETTLE_MS = 1500;   // after login, let the lobby scene finish building
  const AUTO_ENTER_NOT_READY_MS = 3000; // the tile did not resolve yet → look again soon
  const AUTO_ENTER_MAX_TRIES = 5;
  const autoEnterState = Object.create(null); // runId -> { tries, nextAt, done, timer }
  function resetAutoEnter(rid) { const st = autoEnterState[rid]; if (st && st.timer) clearTimeout(st.timer); delete autoEnterState[rid]; }
  function maybeAutoEnter(rid, view, b) {
    if (process.env.PHOM_AUTO_ENTER === '0') return;
    if (!b || !b.loggedIn || !view.opened || view.dataStale) return;
    const st = autoEnterState[rid] || (autoEnterState[rid] = { tries: 0, nextAt: nowMs() + AUTO_ENTER_SETTLE_MS, done: false, timer: null });
    if (view.inGame) { if (!st.done) { st.done = true; headerLog('AUTO_ENTER_DONE', { runId: rid, tries: st.tries }); } return; }
    if (st.done || st.tries >= AUTO_ENTER_MAX_TRIES || headerEntering[rid] || headerActionBusy[rid]) return;
    const wait = st.nextAt - nowMs();
    if (wait > 0) { if (!st.timer) st.timer = setTimeout(() => { st.timer = null; pushHeaderStates(); }, wait + 20); return; }
    st.tries += 1;
    st.nextAt = Infinity; // nothing else fires until this attempt settles
    headerActionBusy[rid] = true;
    startEnterGame(rid, { source: 'auto', attempt: st.tries })
      .then((res) => { st.nextAt = nowMs() + (res && res.ok ? gameHeader.ENTER_GAME_TIMEOUT_MS : AUTO_ENTER_NOT_READY_MS); })
      .catch(() => { st.nextAt = nowMs() + AUTO_ENTER_NOT_READY_MS; })
      .finally(() => { delete headerActionBusy[rid]; if (st.tries >= AUTO_ENTER_MAX_TRIES) headerLog('AUTO_ENTER_GAVE_UP', { runId: rid, tries: st.tries }); pushHeaderStates(); });
  }

  // Per-browser RUNTIME status for the READ-ONLY Screen 2 (browser kind · CDP · header). No actions.
  // §2/§12 — HEADER distinguishes three facts: CDP connected, binding installed, and the header DOM actually
  // present in the page (confirmed by the page itself via __HEADER_STATUS). READY only when ALL hold; when
  // the binding is up but the DOM was removed (SPA rebuild, mid-remount) it reports RECOVERING, never READY.
  function browserRuntimeStatus(runId) {
    const rid = String(runId);
    const run = runManager && runManager.get(rid);
    const cdp = !!runClientFor(rid);
    let header = 'NOT_READY';
    if (cdp && headerReady[rid]) header = headerDomPresent[rid] ? 'READY' : 'RECOVERING';
    return { runtimeKind: (run && run.browserKind) || null, cdp: cdp ? 'CONNECTED' : 'DISCONNECTED', header };
  }

  // Structured header lifecycle log (§24) — one line per step so an intermittent failure is diagnosable.
  // Gated behind PHOM_HEADER_LOG / PHOM_LIFECYCLE_LOG. NEVER logs cookies/tokens/secrets.
  // The few steps that explain "the browser opened but never got into the game" always go to coseat.jsonl.
  const ALWAYS_LOGGED = new Set(['GAME_URL_FOLLOWS_LOGIN', 'AUTO_ENTER_DONE', 'AUTO_ENTER_GAVE_UP', 'DOCUMENT_REPLACED', 'capture-rehook', 'PROXY_AUTH_FAILED', 'PROXY_NAVIGATE']);
  function headerLog(event, data = {}) {
    if (ALWAYS_LOGGED.has(event)) { try { appendCoseatLog({ tag: 'PHOM-RUN', event, at: new Date().toISOString(), ...data }); } catch { /* best effort */ } }
    if (process.env.PHOM_HEADER_LOG !== '1' && process.env.PHOM_LIFECYCLE_LOG !== '1') return;
    try { lifecycleLog('PHOM_HEADER', { event, ...data }); } catch { /* best effort */ }
  }

  // The group's số bàn (SS), the same value the Tool window shows. Null until Tạo found the KEY's table.
  // §38 — the shared room comes from the coordinator's single source of truth (sharedRid()), which the Tool window
  // reads too. Rules unchanged: the USER-selected finder's own VALIDATED room (never a provisional anchor that has
  // not passed the post-anchor capacity check); no finder chosen → whichever browser actually found+joined; never
  // hard-coded to Player 1. Deriving it here separately is what let the Tool and the header disagree.
  function headerSharedRid() {
    return phomSessions && phomSessions.active() ? phomSessions.sharedRid() : null;
  }

  // Build the raw header view for ONE browser from authoritative snapshots (no button logic here — that
  // is deriveHeaderState). opened = a live (non-closed) run; inGame mirrors the renderer's slotInPhom
  // (socketReady + connected + channelList received). account = the logged-in display name (dn) or —.
  function headerViewFor(runId, browsers, sharedRid) {
    const run = runManager && runManager.get(String(runId));
    const opened = !!(run && run.status !== RUN_STATUS.CLOSED);
    const b = (browsers || []).find((x) => x && String(x.profileId) === String(runId)) || {};
    const inGame = opened && !!b.socketReady && !!b.connected && (b.channelCount || 0) > 0;
    const account = b.username && b.username !== 'USER_UNKNOWN' ? b.username : null;
    return {
      account, accountId: b.accountId || null, money: b.money != null ? b.money : null, opened, inGame,
      players: Array.isArray(b.players) ? b.players : [], playerCount: b.playerCount || 0,
      // PHASE 6.3.6 — ENTERING is BOUNDED: shown only while pending + not authoritatively inGame + within the
      // timeout window since the click. A fired-but-never-entered click reverts to NOT_IN_GAME (never stuck).
      entering: opened && gameHeader.enteringActive({ pending: !!headerEntering[String(runId)], inGame, startedAt: headerEnterStartedAt[String(runId)] != null ? headerEnterStartedAt[String(runId)] : null, now: nowMs() }),
      manualState: b.manualState || null,
      // live search progress ("ĐANG DÒ BÀN KEY 12s · lần 6") so a long search never looks like a hang
      searchElapsedSec: b.searchElapsedSec || 0,
      searchAttempt: b.searchAttempt || 0,
      searchKind: b.searchKind || null,
      rejoinOn: !!b.rejoinOn,
      rid: b.rid != null ? b.rid : null,
      joinedViaChannel: !!b.joinedViaChannel, // §stake-channel — label it KÊNH, never SS (see deriveHeaderState)
      lastRid: b.lastRid != null ? b.lastRid : null,
      sharedRid,
      // The session stake (picked in the tool) — shown on the bar and used by its TẠO.
      stake: phomSessions && phomSessions.active() ? phomSessions.selectedStake() : null,
      groupRole: b.groupRole || null,
      // DÒ KEY done somewhere else: the KEY is sitting at its table, so TẠO here has a table to look for.
      keySeated: b.groupRole !== 'KEY' && (browsers || []).some((x) => x && x.groupRole === 'KEY' && x.manualState === 'JOINED'),
      // Data freshness: frames were seen once but stopped (lost hook after a reload / target swap) → say it.
      dataStale: !!(opened && b.lastFrameAt != null && (nowMs() - Number(b.lastFrameAt)) > HEADER_STALE_MS),
      staleSec: b.lastFrameAt != null ? Math.round((nowMs() - Number(b.lastFrameAt)) / 1000) : null,
      // a RESERVE (P4/P5, behind the tool): same bar, marked DỰ BỊ
      ...reserveViewFor(runId),
      // TỰ ĐỘNG on: the bar says so (and, GĐ3, locks its table buttons)
      auto: !!(phomSessions && phomSessions.active() && phomSessions.autoActive && phomSessions.autoActive()),
      autoBusy: phomSessions && phomSessions.active() && phomSessions.groupBusy ? (GROUP_BUSY_WORD[phomSessions.groupBusy()] || null) : null,
      error: headerError[String(runId)] || null,
    };
  }
  // Is this run a RESERVE (cluster slot D/E = P4/P5)? Read from the cluster snapshot — the one place that knows.
  // Cached for 250ms: the bars repaint often and the cluster snapshot is not free.
  let _reserveMap = null, _reserveMapAt = 0;
  function reserveViewFor(runId) {
    if (!_reserveMap || nowMs() - _reserveMapAt > 250) {
      _reserveMap = Object.create(null); _reserveMapAt = nowMs();
      const snap = phomCluster && phomCluster.active() ? phomCluster.getClusterSnapshot() : null;
      const rs = (snap && snap.reserves) || {};
      RESERVE_SLOTS.forEach((k, i) => { if (rs[k] && rs[k].profileId != null) _reserveMap[String(rs[k].profileId)] = 'P' + (4 + i); });
    }
    const label = _reserveMap[String(runId)];
    return label ? { reserve: true, reserveLabel: label } : { reserve: false };
  }
  // The bar's table buttons (locked while TỰ ĐỘNG runs, rule D1). VÀO GAME / TẢI LẠI stay usable.
  const headerFindConfirm = Object.create(null); // runId -> until (ms): a Dò Key asked to confirm replacing the group
  const HEADER_TABLE_ACTIONS = new Set(['FIND_TABLE', 'SCAN_TABLE', 'JOIN_CODE', 'REJOIN', 'LEAVE', 'CANCEL_FIND']);
  // What the group is doing right now, in the words the TỰ ĐỘNG chip on every bar shows.
  const GROUP_BUSY_WORD = Object.freeze({ AUTO_ON: 'đang lập bàn', REGROUP: 'đang lập lại bàn', FIND: 'đang Dò Key', JOIN: 'đang vào bàn', REPLACE_JOIN: 'acc thay đang vào bàn', READY: 'sẵn sàng', START: 'đang bắt đầu ván', TABLE_LOST: 'mất bàn — lập lại', LEAVE: 'đang rời bàn', LEAVE_ALL: 'đang thoát tất cả' });
  // GĐ2 — an error shown on a bar belongs to the state it happened in: once that browser's state changes (it got in,
  // left, was kicked…) the old error is cleared instead of sticking until the next click.
  const headerErrorState = Object.create(null); // runId -> state code when the error was set
  function settleHeaderError(rid, code) {
    if (headerError[rid] == null) { delete headerErrorState[rid]; return; }
    if (headerErrorState[rid] == null) { headerErrorState[rid] = code; return; }
    if (headerErrorState[rid] !== code) { delete headerError[rid]; delete headerErrorState[rid]; }
  }
  // The ONE state of a browser (browser-state.cjs) — the same object the bar renders, for the tool window's cards.
  function browserStateFor(runId, browsers, sharedRid) {
    return deriveBrowserState(headerViewFor(runId, browsers, sharedRid));
  }
  // A browser whose game frames stopped arriving is reported as such after this long (and re-hooked, see
  // maybeRehookCapture) instead of silently reading "CHƯA VÀO GAME".
  const HEADER_STALE_MS = 20000;
  // A browser whose game frames stopped arriving lost its capture hook (the page reloaded / the game swapped the
  // target it runs in). Re-enable the CDP network events and re-inject the send hook on that run's CURRENT session
  // instead of leaving the tool blind — at most once every 30s per browser, and only while its Chromium is open.
  const _lastRehookAt = Object.create(null);
  function maybeRehookCapture(browsers) {
    const now = nowMs();
    for (const b of (browsers || [])) {
      if (!b || b.profileId == null || b.lastFrameAt == null) continue;
      if (now - Number(b.lastFrameAt) <= HEADER_STALE_MS) continue;
      const rid = String(b.profileId);
      if (_lastRehookAt[rid] && now - _lastRehookAt[rid] < 30000) continue;
      const run = runManager && runManager.get(rid);
      if (!run || run.status === RUN_STATUS.CLOSED) continue;
      const targets = runManager.targetsForRun(rid) || [];
      for (const t of targets) {
        const sess = run.targetManager && run.targetManager.getSession(t);
        if (!sess || !sess.client) continue;
        _lastRehookAt[rid] = now;
        headerLog('capture-rehook', { runId: rid, targetId: t, staleSec: Math.round((now - Number(b.lastFrameAt)) / 1000) });
        try { attachCapture(sess.client, { cdpTargetId: t }); } catch { /* best effort */ }
        try { wsReplay.injectSession(sess.client, undefined).catch(() => {}); } catch { /* best effort */ }
      }
    }
  }
  // Recompute + push the header state into every open Chromium (best-effort). Called after every session
  // update and after every header action so the bars stay live without a Tool screen.
  function pushHeaderStates() {
    if (!phomSessions || !runManager) return;
    let browsers = []; try { browsers = phomSessions.manualBrowserSnapshot() || []; } catch { browsers = []; }
    maybeRehookCapture(browsers); // a browser whose frames stopped gets its hook re-installed (§data-stale)
    const sharedRid = headerSharedRid();
    for (const run of runManager.list()) {
      if (run.status === RUN_STATUS.CLOSED) continue;
      const client = runClientFor(run.id);
      if (!client) continue;
      const view = headerViewFor(run.id, browsers, sharedRid);
      const rid = String(run.id);
      maybeAutoEnter(rid, view, browsers.find((x) => x && String(x.profileId) === rid));
      rememberLoginOrigin(run, browsers.find((x) => x && String(x.profileId) === rid));
      if (view.inGame) {
        // Real authoritative evidence (socketReady+connected+channelList) — clear the ENTERING transient
        // and log the click→ENTERED latency once, then stop timing this run.
        delete headerEntering[rid]; clearHeaderEnterTimer(rid); // §10 — evidence arrived → cancel the bounded timeout
        if (headerEnterStartedAt[rid] != null) { headerLog('ENTER_GAME_EVIDENCE', { runId: rid, slotId: run.slot, elapsedMs: Math.round(nowMs() - headerEnterStartedAt[rid]) }); delete headerEnterStartedAt[rid]; }
      }
      // §5/§14 lag fix — the coordinator emits 'update' on EVERY observed WS frame; deriving is cheap but a
      // CDP Runtime.evaluate per frame per browser is an evaluate STORM that saturates the client the click
      // rides on. Skip the round-trip when this browser's derived state is byte-identical to the last push.
      settleHeaderError(rid, deriveBrowserState(view).code); // a stale error goes once the state moved on
      view.error = headerError[rid] || null;
      const json = JSON.stringify(gameHeader.deriveHeaderState(view));
      if (headerLastPushed[rid] === json) continue;
      headerLastPushed[rid] = json;
      client.Runtime.evaluate({ expression: `window.__phomHeaderRender && window.__phomHeaderRender(${json})` }).catch((e) => headerLog('push-error', { runId: rid, error: String(e && e.message || e) }));
    }
  }

  // §9 lag fix — the coordinator emits 'update'/'hands' on EVERY observed WS frame. Broadcasting each one to
  // the renderer (IPC) + pushing every header (CDP) per frame is an IPC/CDP storm during normal play. These
  // leading+trailing throttles coalesce a burst into at most ~2 emits per window while always delivering the
  // LATEST snapshot — the header dedupe above then skips unchanged CDP evaluates entirely. State still
  // converges; only redundant churn is removed (no authoritative evidence is dropped).
  const BROADCAST_MS = 120;
  let _sessTimer = null; let _sessPending = null;
  function scheduleSessionBroadcast(snap) {
    _sessPending = snap;
    if (_sessTimer) return; // a trailing flush is already pending → coalesce
    const s = _sessPending; _sessPending = null; if (s) send('phom:session', s); pushHeaderStates(); // leading edge
    _sessTimer = setTimeout(() => { _sessTimer = null; if (_sessPending) { const t = _sessPending; _sessPending = null; send('phom:session', t); pushHeaderStates(); } }, BROADCAST_MS);
  }
  // PHASE 6.3.3.2 — coalesce the per-frame card-observation snapshot the same way (leading + trailing).
  let _cardsTimer = null; let _cardsPending = null;
  function scheduleCardsBroadcast(cards) {
    _cardsPending = cards;
    if (_cardsTimer) return;
    const c = _cardsPending; _cardsPending = null; if (c) sendUiAndJournal(); // leading edge
    _cardsTimer = setTimeout(() => { _cardsTimer = null; if (_cardsPending) { _cardsPending = null; sendUiAndJournal(); } }, BROADCAST_MS);
  }
  // ONE snapshot for the whole Phỏm screen (module scope: the IPC AND the throttled cards push call it — it used to live
  // inside registerIpc(), so the push threw a swallowed ReferenceError and LỌC BÀI only refreshed on the window's poll). The renderer used to make six IPC round-trips per refresh
  // (browsers + remaining + cards + one analyze per account) and repeat them on every push; now main builds the
  // payload once — the analyzer is memoised by content, so an unchanged round costs nothing — and the renderer
  // reads or receives exactly one object.
  function phomUiSnapshot() {
    if (!phomSessions || !phomSessions.active()) return { ok: true, browsers: [], sharedRid: null, sharedRidOwner: null, coSeat: null, group: null, remaining: null, cards: null, analyses: {} };
    const browsers = phomSessions.manualBrowserSnapshot() || [];
    const shared = headerSharedRid();
    for (const b of browsers) {
      if (!b || b.profileId == null) continue;
      Object.assign(b, browserRuntimeStatus(b.profileId));
      b.state = browserStateFor(b.profileId, browsers, shared); // the same state the bar shows (GĐ2)
    }
    const cards = phomSessions.cardObserverSnapshot();
    const analyses = {};
    const binding = (cards && cards.slotBinding) || {};
    for (const slot of ['B1', 'B2', 'B3']) {
      const uid = binding[slot];
      if (uid) analyses[slot] = slotAnalyzers[slot].analyze({ snapshot: cards, targetPlayerUid: uid });
    }
    return {
      ok: true, browsers, cards, analyses,
      remaining: phomSessions.remainingCards(),
      sharedRid: phomSessions.sharedRid(), sharedRidOwner: phomSessions.sharedRidOwner(),
      coSeat: phomSessions.coSeatStatus(), group: phomSessions.groupSnapshot(),
    };
  }
  // N5 — the snapshot the tool window gets also feeds the round journal (no second analysis: same object, same rate)
  function sendUiAndJournal() {
    const snap = phomUiSnapshot();
    try { ensureRoundJournal().observe(snap.cards, snap.analyses); } catch { /* the journal never breaks the UI push */ }
    send('phom:ui', snap);
  }
  let roundJournal = null;
  function ensureRoundJournal() {
    if (!roundJournal) roundJournal = createRoundJournal({ dir: path.join(app.getPath('userData'), 'phom-captures', 'rounds') });
    return roundJournal;
  }

  // PHASE 6.3.8 — shared RELOAD / CLOSE run helpers, reused by BOTH the IPC handlers (phom:reload-web /
  // phom:close-browser) AND the in-Chromium header's ⟳/⏻ buttons. Pure extraction of the existing logic —
  // no behavior change, no new IPC contract. The header routes RELOAD/STOP/FOCUS through phomHeaderAction.
  async function reloadWebRun(runId) {
    const rid = String(runId == null ? '' : runId);
    if (!rid || !runManager) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no browser' } };
    const client = runClientFor(rid);
    const run = runManager.get(rid);
    const url = run && run.launchUrl ? run.launchUrl : null;
    if (!client || !client.Page) return { ok: false, error: { code: 'PHOM_RELOAD_NO_CLIENT', message: 'Trang không còn hoạt động — hãy MỞ CHROMIUM.' } };
    const resetPhom = () => { try { if (phomSessions && phomSessions.resetBrowser) phomSessions.resetBrowser(rid); } catch { /* best effort */ } delete headerEntering[rid]; clearHeaderEnterTimer(rid); delete headerError[rid]; headerDomPresent[rid] = false; delete headerLastPushed[rid]; delete headerEnterStartedAt[rid]; pushHeaderStates(); };
    try { await client.Page.enable().catch(() => {}); await client.Page.reload({ ignoreCache: false }); resetPhom(); return { ok: true, action: 'RELOAD' }; }
    catch (e) { if (url) { try { await client.Page.navigate({ url }); resetPhom(); return { ok: true, action: 'NAVIGATE' }; } catch { /* fall through */ } } return { ok: false, error: { code: 'PHOM_RELOAD_FAILED', message: safeMsg(e) } }; }
  }
  // §54 — the page of a run loaded a NEW DOCUMENT (F5 in Chromium, the header's ⟳, a redirect back to the web
  // lobby). The old document's game socket, channel list and table are gone with it, so this browser's Phỏm
  // state is reset — exactly what the tool's own ⟳ always did. A reload the USER did (F5) never went through
  // the tool, so the header kept showing the old state (in game / at a table) while the page sat at the web
  // lobby and never offered VÀO GAME. Runs at commit time, so no frame of the old document can re-bind the
  // state afterwards. VÀO GAME in flight is kept: that navigation is the one it is waiting for.
  // The game keeps its login in localStorage (token / user_token / isAutoLogin), which belongs to ONE origin — and
  // the site moves between mirror domains (v.hitclub.tienda → .guitars …). A profile whose saved Game URL is another
  // mirror opens where no token is stored, so every reopen asked for a login (found 2026-10-05: tokens under
  // .guitars, all profiles saved as .tienda). Once an account is LOGGED IN, the origin it is on becomes the profile's
  // Game URL, so the next open lands where the login is. Only the origin is stored (no path/query); once per change.
  function rememberLoginOrigin(run, b) {
    if (!run || !b || !b.loggedIn || !deviceProfilesStore) return;
    if (!run.lastTopUrl) {
      // the page loaded before the tool attached (no navigation seen): ask it once where it is
      const client = runClientFor(run.id);
      if (client && !run._originAsked) {
        run._originAsked = true;
        client.Runtime.evaluate({ expression: 'location.href', returnByValue: true })
          .then((r) => { const v = r && r.result && r.result.value; if (typeof v === 'string') run.lastTopUrl = v; else run._originAsked = false; })
          .catch(() => { run._originAsked = false; });
      }
      return;
    }
    let origin; try { const u = new URL(run.lastTopUrl); if (!/^https?:$/.test(u.protocol)) return; origin = u.origin + '/'; } catch { return; }
    if (run._loginOriginSaved === origin) return;
    run._loginOriginSaved = origin;
    const pid = run.profileId != null ? String(run.profileId) : null;
    const p = pid ? deviceProfilesStore.get(pid) : null;
    if (!p) return;
    let savedOrigin = null; try { savedOrigin = p.gameUrl ? new URL(p.gameUrl).origin + '/' : null; } catch { savedOrigin = null; }
    if (savedOrigin === origin) return;
    try { deviceProfilesStore.update(pid, { gameUrl: origin }); headerLog('GAME_URL_FOLLOWS_LOGIN', { runId: run.id, from: savedOrigin, to: origin }); } catch { /* best effort */ }
  }
  function onRunDocumentReplaced(runId, url) {
    const rid = String(runId);
    if (!url || /^about:/i.test(url)) return; // the proxy-auth launch page, not the game
    { const run = runManager && runManager.get(rid); if (run) run.lastTopUrl = String(url); } // where the game really is (login origin)
    try { if (phomSessions && phomSessions.resetBrowser) phomSessions.resetBrowser(rid); } catch { /* best effort */ }
    resetAutoEnter(rid); // a new page = a new login → auto VÀO GAME again
    delete headerError[rid]; headerDomPresent[rid] = false; delete headerLastPushed[rid];
    headerLog('DOCUMENT_REPLACED', { runId: rid });
    pushHeaderStates();
  }

  async function closeBrowserRun(runId) {
    const rid = String(runId == null ? '' : runId);
    if (!rid || !runManager) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no browser' } };
    toolClosingRuns.add(rid); // the tool closes it → no automatic reserve swap
    try {
      await runManager.closeRun(rid);
      const closed = phomCluster && phomCluster.markRunClosed ? phomCluster.markRunClosed(rid, 'USER_CLOSED_WINDOW') : null;
      if (closed && closed.ok && RESERVE_SLOTS.includes(closed.slot) && phomSessions) phomSessions.removeRun(rid); // N4
      return { ok: true };
    }
    catch (e) { toolClosingRuns.delete(rid); return { ok: false, error: { code: 'PHOM_CLOSE_FAILED', message: safeMsg(e) } }; }
  }

  // THAY PROFILE / MỞ LẠI one slot (A/B/C = P1/P2/P3): an open browser is closed first; with a profileId the slot is
  // pointed at that saved profile (its own login, proxy, agent), else it reopens its own. Only THAT slot opens; the new
  // run takes the old one's place in the Phỏm session, so the other two keep their table and roles.
  async function replaceSlot(slot, deviceProfileId) {
    const s = String(slot || '').toUpperCase();
    if (!SLOTS_ABC.includes(s)) return { ok: false, error: { code: 'PHOM_SLOT_UNKNOWN', message: `Ô ${slot} không tồn tại.` } };
    if (!phomCluster || !phomCluster.active()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'Chưa mở trình duyệt nào — mở 3 profile ở tab Profile trước.' } };
    ensureStores();
    const before = phomCluster.getClusterSnapshot().profiles[s];
    const oldRun = before.profileId;
    if (oldRun && before.browserState === 'OPEN') {
      if (phomSessions) { try { await phomSessions.leaveNow(oldRun); } catch { /* closing drops the seat anyway */ } }
      const closed = await closeBrowserRun(oldRun);
      if (!closed.ok) return closed;
    }
    if (deviceProfileId) {
      const p = deviceProfilesStore.get(String(deviceProfileId));
      if (!p) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `Hồ sơ ${deviceProfileId} không tồn tại.` } };
      const url = localTestActive() ? 'about:blank' : (p.gameUrl ? String(p.gameUrl).trim() : '');
      if (!localTestActive() && !url) return { ok: false, error: { code: 'PHOM_GAME_URL_REQUIRED', message: `Profile ${p.name || p.id} chưa có Game URL.` } };
      const r = phomCluster.reassignSlot(s, { browserProfileId: p.id, label: p.name, proxyRef: p.proxyRef || null, agent: deviceProfilesStore.agentFor(p.id), gameUrl: url });
      if (!r.ok) return r;
    }
    const open = await phomCluster.openCluster();
    const after = phomCluster.getClusterSnapshot().profiles[s];
    const newRun = after.profileId;
    if (!newRun || after.browserState !== 'OPEN') {
      const res = (open.results || []).find((x) => x.slot === s);
      return { ok: false, error: (res && res.error) || after.error || { code: 'PHOM_CHROMIUM_LAUNCH_FAILED', message: 'Không mở được trình duyệt.' } };
    }
    for (let i = 0; i < 8 && !runClientFor(newRun); i++) await new Promise((r) => setTimeout(r, 800)); // CDP needs a moment after launch
    phomCluster.connectClusterCdp();
    try { await phomCluster.applyClusterAgents(); } catch { /* the WEB agent applies nothing anyway */ }
    let replaced = false;
    if (phomSessions && oldRun && String(oldRun) !== String(newRun)) replaced = !!phomSessions.replaceRun(oldRun, newRun).replaced;
    lifecycleLog('SLOT_REPLACED', { slot: s, oldRun, newRun, deviceProfileId: after.deviceProfileId, replacedInSession: replaced });
    pushHeaderStates();
    return { ok: true, slot: s, runId: newRun, deviceProfileId: after.deviceProfileId, label: after.label };
  }

  // N4 — MỞ LẠI a closed reserve (P4/P5) with its own profile, behind the tool, back in the Phỏm session (warm).
  async function reopenReserve(reserve) {
    const r = String(reserve || '').toUpperCase();
    if (!RESERVE_SLOTS.includes(r)) return { ok: false, error: { code: 'PHOM_SLOT_UNKNOWN', message: `Ô ${reserve} không phải dự bị.` } };
    if (!phomCluster || !phomCluster.active()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'Chưa mở trình duyệt nào.' } };
    const ro = phomCluster.reopenReserve(r);
    if (!ro.ok) return ro;
    await phomCluster.openCluster();
    const rs = phomCluster.getClusterSnapshot().reserves[r];
    if (!rs || !rs.profileId || rs.browserState !== 'OPEN') return { ok: false, error: (rs && rs.error) || { code: 'PHOM_CHROMIUM_LAUNCH_FAILED', message: 'Không mở được trình duyệt.' } };
    for (let i = 0; i < 8 && !runClientFor(rs.profileId); i++) await new Promise((res) => setTimeout(res, 800));
    phomCluster.connectClusterCdp();
    if (phomSessions) phomSessions.addRun(rs.profileId);
    _reserveMap = null;
    lifecycleLog('RESERVE_REOPENED', { reserve: r, runId: rs.profileId });
    pushHeaderStates();
    return { ok: true, reserve: r, runId: rs.profileId };
  }

  // ĐỔI NGƯỜI CHƠI — the reserve browser (D/E) plays in slot A/B/C at once (no close, no reload): it takes the slot's
  // window place and its place in the Phỏm session; the browser it replaces (if still open) goes behind the tool.
  async function swapSlot(slot, reserve) {
    const s = String(slot || '').toUpperCase(), r = String(reserve || '').toUpperCase();
    if (!phomCluster || !phomCluster.active()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'Chưa mở trình duyệt nào.' } };
    const snap0 = phomCluster.getClusterSnapshot();
    const before = snap0.profiles[s];
    const oldRun = before ? before.profileId : null;
    if (!snap0.reserves || !snap0.reserves[r] || snap0.reserves[r].browserState !== 'OPEN') return { ok: false, error: { code: 'PHOM_RESERVE_NOT_OPEN', message: 'Trình duyệt dự bị này đã tắt.' } };
    // 1. the browser leaving the slot gives its seat back first (it stays open as a reserve, so it would keep it)
    if (oldRun && before.browserState === 'OPEN' && phomSessions) {
      const lv = await phomSessions.leaveNow(oldRun);
      lifecycleLog('SLOT_SWAP_LEAVE', { slot: s, run: oldRun, ok: !!(lv && lv.ok) });
    }
    // 2. swap the cluster places, 3. the new browser takes the old one's place + role in the Phỏm session (main below)
    const res = phomCluster.swapSlot(s, r);
    if (!res.ok) return res;
    _reserveMap = null; // who is a reserve just changed
    const playRun = runManager && runManager.get(res.playingRun);
    if (playRun) playRun.slot = s;
    const benchRun = res.benchedRun && runManager && runManager.get(res.benchedRun);
    if (benchRun) benchRun.slot = r;
    let replaced = false;
    // the reserve is a warm member of the session already: the two swap places (it takes the role and sits at once)
    if (phomSessions && oldRun && String(oldRun) !== String(res.playingRun)) replaced = !!phomSessions.swapRuns(oldRun, res.playingRun).replaced;
    // N4 — the slot's browser was already CLOSED: it moved to the reserve position dead — drop it from the session
    if (phomSessions && oldRun && !res.benchedRun) phomSessions.removeRun(oldRun);
    await moveRunWindow(res.playingRun, windowRectForSlot(s));
    if (res.benchedRun) await moveRunWindow(res.benchedRun, windowRectForSlot(r));
    try { if (shell && !shell.isDestroyed()) shell.moveTop(); } catch { /* the tool stays where it is */ }
    const after = phomCluster.getClusterSnapshot().profiles[s];
    lifecycleLog('SLOT_SWAPPED', { slot: s, reserve: r, playingRun: res.playingRun, benchedRun: res.benchedRun, replacedInSession: replaced });
    pushHeaderStates();
    return { ok: true, slot: s, runId: res.playingRun, deviceProfileId: after.deviceProfileId, label: after.label };
  }

  // Route ONE header button click (from the in-page binding) to the coordinator's manual API. The action
  // set mirrors the old Tool controls exactly; stake comes from the page's bet picker (server options).
  async function phomHeaderAction(runId, payload) {
    const rid = String(runId == null ? '' : runId);
    const action = payload && payload.action;
    const actionId = (payload && payload.actionId) || null;
    // N3 — only our own bar may act: the message must carry a key this run was given (a page script cannot know it)
    const keys = headerKeys[rid];
    if (!keys || !payload || typeof payload.key !== 'string' || !keys.has(payload.key)) {
      headerLog('action-rejected', { runId: rid, action, reason: 'BAD_KEY' });
      return { ok: false, error: { code: 'PHOM_HEADER_FORGED', message: 'Lệnh không đến từ thanh của tool — bỏ qua.' } };
    }
    // §3/§8/§12 — INTERNAL: the page reports its real header DOM presence (on mount/remount, NOT per frame).
    // Record it (drives the honest Tool indicator) and force a state re-push so the freshly (re)mounted bar
    // gets its current content. This is the ONLY header-DOM signal — never a per-WS-frame CDP verify (§11).
    if (action === '__HEADER_STATUS') {
      headerDomPresent[rid] = !!(payload && payload.present);
      headerLog('HEADER_DOM_PRESENT', { runId: rid, slotId: payload && payload.slotId, present: headerDomPresent[rid] });
      delete headerLastPushed[rid]; // force the next push (re-fill the fresh bar)
      pushHeaderStates();
      return { ok: true, internal: true };
    }
    headerLog('action-route', { runId: rid, slotId: payload && payload.slotId, action, actionId });
    // §A2/§A8 — single-flight + IDENTITY guard (pure). Rejects a click that belongs to a stale run/profile
    // (e.g. fired by an OLD header after reopen), a re-delivered duplicate actionId, or a second op while
    // one is already running. The bound runId is authoritative; the payload identity is the cross-check.
    const runRec = runManager && runManager.get(rid);
    const guard = evaluateHeaderAction({ payload: payload || {}, boundRunId: rid, runProfileId: runRec && runRec.profileId, busy: !!headerActionBusy[rid], lastActionId: headerLastActionId[rid] || null });
    if (!guard.ok) { headerLog('action-rejected', { runId: rid, action, actionId, reason: guard.reason }); return { ok: false, busy: guard.reason === 'DUPLICATE_ACTION', error: { code: guard.code, message: guard.message } }; }
    // Rule D1 — while TỰ ĐỘNG drives the table the bar's table buttons are locked; a click that still arrives (an old bar
    // not repainted yet) is refused here too, so a manual press never runs alongside the automation.
    if (HEADER_TABLE_ACTIONS.has(action) && phomSessions && phomSessions.active() && phomSessions.autoActive()) {
      headerLog('action-rejected', { runId: rid, action, actionId, reason: 'AUTO_ACTIVE' });
      return { ok: false, error: { code: 'PHOM_AUTO_ACTIVE', message: 'Đang TỰ ĐỘNG — bỏ tích ô Tự động ở tool Phỏm để bấm tay.' } };
    }
    // §12 — never route into a dead CDP session (page crashed / target closed).
    if (!runClientFor(rid)) { headerLog('action-no-client', { runId: rid, action, actionId }); headerError[rid] = 'Chromium mất kết nối — MỞ lại trình duyệt.'; pushHeaderStates(); return { ok: false, error: { code: 'PHOM_HEADER_NO_CLIENT', message: 'no live CDP client' } }; }
    // §34 — a busy-exempt action (HỦY / ⟳ / ⏻ / ↑) runs ALONGSIDE the long operation it is meant to escape, so
    // it must not take or clear the single-flight flag: doing so would release the flag that the still-running
    // TÌM BÀN owns and let a second table operation stack on top of it.
    const exempt = headerActionGuard.isBusyExempt(action);
    if (!exempt) headerActionBusy[rid] = true;
    if (actionId != null) headerLastActionId[rid] = actionId;
    delete headerError[rid];
    const _t0 = nowMs(); // 6.3.2.10 — main-side handler duration (M1→M4) for ALL actions
    let res = { ok: true };
    try {
      if (action === 'ENTER_GAME') {
        res = await startEnterGame(rid, { source: 'header', slotId: payload && payload.slotId, actionId });
      } else if (action === 'FIND_TABLE') {
        // T1 — DÒ KEY at the stake chosen in the Phỏm tool (the bar has no picker; it never invents a stake): this
        // browser sits alone at an empty public table and becomes KEY.
        ensurePhomSessions();
        const stake = phomSessions.selectedStake();
        // Rule D2 — a second Dò Key on this bar within 5s confirms "huỷ nhóm cũ"
        const force = headerFindConfirm[rid] != null && nowMs() <= headerFindConfirm[rid];
        delete headerFindConfirm[rid];
        res = await phomSessions.findTable(rid, { stake, force });
        if (res && res.needsConfirm) headerFindConfirm[rid] = nowMs() + 5000;
      } else if (action === 'SCAN_TABLE') {
        // T2a — TẠO: find the KEY's table (its số bàn) and sit there; the số bàn then fills every bar's SS.
        ensurePhomSessions();
        res = await phomSessions.scanTable(rid);
      } else if (action === 'JOIN_CODE') {
        // §create — VÀO SỐ BÀN typed/picked in the header (no password is ever sent — §no-password).
        ensurePhomSessions();
        const joinRid = payload && payload.rid != null ? Number(payload.rid) : null;
        res = await phomSessions.joinTable(rid, joinRid);
      } else if (action === 'CANCEL_FIND') {
        // §34 — DỪNG: stop the DÒ KEY / TẠO this browser is running. Runs alongside it (exempt from single-flight);
        // the coordinator's search generation is what actually ends it.
        ensurePhomSessions();
        res = await phomSessions.cancelFind(rid);
      } else if (action === 'REJOIN') {
        ensurePhomSessions();
        res = await phomSessions.rejoinTable(rid);
      } else if (action === 'LEAVE') {
        ensurePhomSessions();
        res = await phomSessions.leaveTable(rid);
      } else if (action === 'RELOAD') {
        // TẢI LẠI WEB (shown when the frames stopped) — the same reload as the tool window's ⟳.
        res = await reloadWebRun(rid);
      } else {
        res = { ok: false, error: { code: 'PHOM_HEADER_UNKNOWN_ACTION', message: `unknown action ${action}` } };
      }
    } catch (e) { res = { ok: false, error: { code: 'PHOM_HEADER_ACTION_FAILED', message: safeMsg(e) } }; }
    finally { if (!exempt) delete headerActionBusy[rid]; }
    if (res && res.ok === false) headerError[rid] = (res.error && (res.error.message || res.error.code)) || 'LỖI';
    headerLog('action-done', { runId: rid, action, actionId, ok: !!(res && res.ok), error: res && res.error && res.error.code, elapsedMs: Math.round(nowMs() - _t0) });
    pushHeaderStates();
    return res;
  }

  // ---- per-run capture attach + phom frame routing (mirrors Control's seam) ----
  capture.on('request', (req) => {
    if (!req || !req.isWebSocket || !req.wsDirection || !runManager) return;
    const run = runManager.runForTarget(req.targetId);
    if (!run) return;
    // TEST D — record the raw frames (both directions) BEFORE routing, so a player's own click is captured even
    // when no session has been started. Passive and cheap when idle; never allowed to break capture.
    try { if (frameRecorder.isRecording()) frameRecorder.record(run.id, { raw: req.body && req.body.raw, direction: req.wsDirection, url: req.url, label: run.profileLabel || null }); } catch { /* never break capture */ }
    try {
      // When a cluster is active, frames flow through the cluster envelope (validation +
      // aggregate), which routes to the host session; otherwise route directly.
      if (phomCluster && phomCluster.active()) {
        phomCluster.ingestEvent(run.id, { raw: req.body && req.body.raw, direction: req.wsDirection, seq: req.seq, targetId: req.targetId, cdpSessionId: req.cdpSessionId, url: req.url });
      } else {
        // no session yet → the manager keeps the frames (the login identity above all) for when one starts
        ensurePhomSessions().routeFrame(run, req);
      }
    } catch { /* never break capture */ }
  });

  // PH-2 — a game WebSocket closed. Map it to the owning run and let the coordinator decide if it
  // was that profile's bound game socket (it ignores unrelated sockets). This makes a bare WS drop
  // flip the authoritative snapshot immediately (host → HOST_LOST) so the UI reflects it at once,
  // instead of waiting for a stale-state timeout. Routed in BOTH modes (cluster active or not).
  capture.on('websocket-closed', (info) => {
    if (!info || !runManager) return;
    try {
      const run = runManager.runForTarget(info.targetId);
      if (!run) return;
      if (phomSessions) phomSessions.routeSocketClosed(run.id, { targetId: info.targetId, url: info.url });
    } catch { /* never break capture */ }
  });

  async function connectRunEndpoint(run, endpoint) {
    const manager = runManager.setTargetManager(run, endpoint);
    if (!manager) return { ok: false, error: { code: 'RUN_CLOSED', message: 'run closed' } };
    manager.on('attached', ({ target, client }) => {
      runManager.registerTarget(target.cdpTargetId, run);
      if (!run.selectedTargetId) run.selectedTargetId = target.cdpTargetId;
      attachCapture(client, target);
      // Apply this run's browser AGENT (a mobile user-agent string, or nothing for the web
       // agent) on the run's OWN client. No viewport/scale/touch emulation: the window is the
       // viewport, which is what stopped the game from lagging.
      if (run.browserAgent) applyBrowserAgent(client, run.browserAgent, run).catch(() => {});
      // Ensure the WS send-hook is present before the game opens its socket.
      wsReplay.injectSession(client, undefined).catch(() => {});
      // ẨN DANH switch (default OFF) — this document now + every later one (reload / VÀO GAME).
      if (!target.type || target.type === 'PAGE') anDanh.applyAnDanh(client, anDanhOn).catch(() => {});
      // Inject the tool-owned in-page GAME HEADER (VÀO GAME / TÌM BÀN / VÀO BÀN / REJOIN / THOÁT PHÒNG)
      // and route its clicks to the coordinator. The boot carries this run's IDENTITY (slot/profile/run)
      // so every action is self-labelled. Best-effort; a CDP hiccup never blocks attach. On a re-attach
      // (transient CDP drop → poll re-adds the target with a NEW client) this runs again → header + binding
      // are reinstalled and the state re-pushed (§11 reattach). (§6.3.2 / §6.3.2.2)
      headerLog('cdp-attach', { runId: run.id, slotId: run.slot, targetId: target.cdpTargetId });
      // N3 — a fresh secret per attach; every key issued to this run stays valid (a page booted by an earlier attach
      // keeps working), any other caller is refused in phomHeaderAction.
      const headerKey = crypto.randomBytes(16).toString('hex');
      (headerKeys[String(run.id)] || (headerKeys[String(run.id)] = new Set())).add(headerKey);
      const boot = gameHeader.bootScript({ nonce: headerKey, slotId: run.slot || null, profileId: run.profileId || null, runId: run.id, observerLog: process.env.PHOM_HEADER_OBSERVER_LOG === '1', clickLog: process.env.PHOM_CLICK_LOG === '1' || process.env.PHOM_HEADER_LOG === '1' });
      // §54 — a new top-level document on this run's PAGE resets its Phỏm state (see onRunDocumentReplaced).
      if ((!target.type || target.type === 'PAGE') && client.Page && !client.__phomDocNav) {
        client.__phomDocNav = true;
        client.Page.enable().catch(() => {});
        client.Page.frameNavigated((p) => { if (p && p.frame && !p.frame.parentId) onRunDocumentReplaced(run.id, p.frame.url); });
      }
      headerBridge.installHeader(client, { runId: run.id, slotId: run.slot || null, boot, onAction: (rid, payload) => phomHeaderAction(rid, payload), log: headerLog })
        .then((r) => { headerReady[String(run.id)] = !!(r && r.ok); pushHeaderStates(); }).catch(() => {});
      // Bind proxy auth on the run's OWN client when its proxy requires it (unverified).
      if (run.proxy && run.proxy.requiresAuth) {
        bindProxyAuth(client, {
          runProxy: run.proxy,
          username: run.proxyUsername || null,
          resolvePassword: () => proxyConfigStore && run.proxy ? proxyConfigStore.resolvePassword(run.proxy.id) : null,
          onAuthFailure: (code) => { headerLog('PROXY_AUTH_FAILED', { runId: run.id, slotId: run.slot, code }); send('phom:proxy-auth', { runId: run.id, code }); },
        }).then((detach) => {
          run._detachProxyAuth = detach;
          // §52 — the proxy challenge is now answered by the tool, so the page may finally leave about:blank.
          // Only the PAGE target navigates, and only once (a re-attach must never reload the game).
          const pending = run._pendingNavigateUrl;
          if (pending && (!target.type || target.type === 'PAGE')) {
            run._pendingNavigateUrl = null;
            headerLog('PROXY_NAVIGATE', { runId: run.id, slotId: run.slot, watchdog: false });
            client.Page.navigate({ url: pending }).catch(() => {});
          }
        }).catch(() => {});
      }
    });
    manager.on('target-removed', (id) => {
      runManager.unregisterTarget(id);
      if (run.selectedTargetId === id) run.selectedTargetId = null;
      // §11/§12 — the CDP session for this run's page is gone (transient drop or real close). Mark the
      // header NOT READY so Screen 2 reflects it and no action is routed into a dead session. If the OS
      // window is still alive, the 1.5s target poll re-attaches → installHeader re-runs on the new client.
      if (!runManager.targetsForRun(run.id).length) { headerReady[String(run.id)] = false; headerDomPresent[String(run.id)] = false; delete headerLastPushed[String(run.id)]; delete headerEnterStartedAt[String(run.id)]; headerLog('cdp-detached', { runId: run.id }); runManager.disconnectRun(run); try { phomSessions.routeDisconnect(run.id); } catch { /* best effort */ } pushHeaderStates(); }
    });
    if (!manager.start) return { ok: true };
    try { await manager.start(); return { ok: true }; }
    catch (e) { return { ok: false, error: { code: 'PHOM_CHROMIUM_CDP_TIMEOUT', message: safeMsg(e) } }; }
  }
  // Newly launched Chromium needs ~1-2s before its CDP endpoint answers; retry connect.
  async function connectRunEndpointWithRetry(run, endpoint, attempt = 0) {
    const result = await connectRunEndpoint(run, endpoint);
    if ((!result || !result.ok) && attempt < 15 && run.status !== RUN_STATUS.CLOSED) {
      setTimeout(() => { connectRunEndpointWithRetry(run, endpoint, attempt + 1).catch(() => {}); }, 1000);
    }
    return result;
  }

  // Apply a run's browser AGENT to its own client: the MOBILE agent overrides the user agent,
  // the WEB agent overrides nothing. A user-agent override survives navigation, so there is no
  // re-apply listener — and there is no metrics/touch emulation at all, which is what used to
  // render the Cocos canvas at 2–3× the pixels and synthesise a touch event per mouse move.
  async function applyBrowserAgent(client, agent, run) {
    if (!client || !client.Emulation) return { applied: [], unsupported: ['Emulation'] };
    const cmds = browserAgent.emulationCommands(agent);
    const applied = [], unsupported = [];
    for (const c of cmds) {
      const short = c.method.split('.')[1];
      try { await client.Emulation[short](c.params); applied.push(short); } catch { unsupported.push(short); }
    }
    if (run) { run._agentApplied = applied; run._agentUnsupported = unsupported; }
    try { send('phom:agent-applied', { runId: run && run.id, applied, unsupported, agent: browserAgent.publicSnapshot(agent) }); } catch {}
    return { applied, unsupported };
  }

  // Only the game's WebSocket is of interest, so only the WebSocket events are subscribed:
  // the HTTP request/response/loadingFinished/loadingFailed events were a Cocos game's worth of
  // per-asset traffic crossing CDP for nothing (capture.on('request') ignores everything that is
  // not a WS frame). Network.enable's buffers are kept small for the same reason — the tool never
  // reads a response body, so Chromium must not retain them.
  function attachCapture(client, target) {
    const { Network } = client;
    client.__phomCaptureTid = target.cdpTargetId; // the listeners read the CURRENT target of this client
    Network.enable({ maxTotalBufferSize: 1048576, maxResourceBufferSize: 262144, maxPostDataSize: 0 }).catch(() => { Network.enable().catch(() => {}); });
    // Listeners once per client: a re-hook only re-enables Network. Registering them again on every re-hook made each
    // WS frame be handled N times (N growing every 30s while a browser read as stale) — the game lagged more and more.
    if (client.__phomCaptureAttached) return;
    client.__phomCaptureAttached = true;
    Network.webSocketCreated((p, sid) => capture.onWebSocketCreated(client.__phomCaptureTid, p, sid));
    Network.webSocketFrameSent((p, sid) => capture.onWebSocketFrameSent(client.__phomCaptureTid, p, sid));
    Network.webSocketFrameReceived((p, sid) => capture.onWebSocketFrameReceived(client.__phomCaptureTid, p, sid));
    Network.webSocketClosed((p, sid) => capture.onWebSocketClosed(client.__phomCaptureTid, p, sid));
  }

  // §4/§6 — open ONE profile's browser with its resolved proxy (no direct fallback)
  // AND its saved mobile device profile (viewport emulation is separate from the
  // native 2×2 window size). The device belongs to the slot (browser profile), so the
  // same device is reapplied every time this slot's browser is (re)opened.
  async function openProfile({ slot, profileKey, url, proxyRef, proxyRequired, label, username, agent: agentArg, profileId }) {
    ensureRunManager(); ensurePhomSessions(); ensureStores();
    // PHASE 6.3.2.2 — resolve the browser runtime (custom Chromium OR Google Chrome) per the saved
    // preference. AUTO prefers custom Chromium; if it is unavailable it falls back to Chrome (logged).
    const rt = chromiumRuntime();
    const rtChoice = resolveBrowserRuntimeChoice();
    if (!rtChoice.ok) return rtChoice; // no usable runtime at all → typed error, never a hidden fallback
    const usingChrome = rtChoice.kind === 'chrome';
    if (rtChoice.fellBack) headerLog('runtime-fallback-chrome', { executable: rtChoice.executable });
    // The custom-Chromium sandbox ACL only applies when we actually launch the custom runtime.
    if (!usingChrome && !rt.ok) return rt;
    // §3/§4 — the AUTHORITATIVE browser profile key (user-data-dir/device/proxy owner).
    // The cluster passes the saved profile's browserProfileId here; the legacy per-slot
    // open path defaults it to the window slot. The window slot (A/B/C) still drives the
    // 2×2 grid placement, but profile identity is resolved from profileKey.
    const pk = (profileKey != null && String(profileKey).trim()) ? String(profileKey).trim() : slot;
    // Prefer the saved profile's proxy/device; explicit args override.
    const saved = profileStore.get(pk) || {};
    const effProxyRef = proxyRef !== undefined ? proxyRef : (saved.proxyRef || null);
    // Proxy is OPTIONAL: no proxyRef => DIRECT. A bound proxyRef must resolve (no silent
    // fallback). `proxyRequired` stays an explicit opt-IN (default optional).
    const gate = resolveLaunchProxy({ proxyRef: effProxyRef || null, proxyRequired: proxyRequired === true }, (ref) => proxyConfigStore && proxyConfigStore.get(ref));
    if (!gate.ok) return gate; // PROXY_CONFIG_NOT_FOUND / DISABLED (bound proxy) — launch blocked; DIRECT is allowed
    // A selected profile passes its AGENT explicitly; otherwise fall back to the legacy per-slot
    // agent, then to the default. The persistent user-data-dir is keyed by the profile identity so
    // each profile keeps its own Chromium data + reopens the SAME identity.
    const agentNorm = browserAgent.normalizeAgent(agentArg || profileStore.agentFor(pk));
    const agent = agentNorm.ok ? agentNorm.agent : browserAgent.DEFAULT_AGENT;
    const udKey = (profileId != null && String(profileId).trim()) ? String(profileId).trim() : pk;
    // Chromium sandbox policy for THIS launch (sandbox ON unless the fully-gated dev
    // diagnostic bypass applies). When the sandbox stays ON we self-heal the runtime's
    // AppContainer ACL so it launches WITHOUT --no-sandbox (the real 0x5 fix).
    const sandbox = sandboxPolicyFor({ url, runProxy: gate.runProxy });
    lastSandboxPolicy = sandbox;
    // The AppContainer ACL self-heal is a CUSTOM-Chromium concern (its copied files may lack the sandbox
    // helper ACLs). Google Chrome manages its own sandbox, so skip the ACL step when running Chrome.
    if (!usingChrome && !sandbox.sandboxDisabled && rt.ok) {
      const acl = phomChromium.ensureSandboxAccess(rt.root);
      if (!acl.ok && phomChromium.sandboxAccessPresent(rt.root) === false) {
        return { ok: false, error: { code: 'PHOM_CHROMIUM_SANDBOX_REQUIRED', message: 'Chromium sandbox cannot be enabled: runtime filesystem permissions (AppContainer read+execute) could not be granted. Launch blocked (no silent --no-sandbox retry).' } };
      }
    }
    // Per-profile persistent user-data-dir so reopening a slot reuses ITS profile's dir
    // (keyed by the authoritative browser profile, not the window slot) (§12).
    const profileDir = path.join(phomRoot(), 'browser-profiles', udKey || slot || 'X');
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* best effort */ }
    // PHASE-6 — DETERMINISTIC multi-monitor placement. Browser slot A/B/C ⇒ window 1/2/3 (stable, never
    // by launch/PID order). Each window FILLS its region of the live display topology (on one monitor:
    // a quadrant of the 2×2 grid whose fourth cell is the Tool), so the four windows cover the screen and
    // the page's viewport is simply that window minus the browser chrome — nothing is emulated or scaled.
    const slotIndex = { A: 1, B: 2, C: 3 }[slot] || 1;
    let windowRect;
    try { windowRect = windowRectForSlot(slot); } catch { windowRect = gridRectForSlot(slotIndex === 1 ? 'A' : slot); }
    const run = runManager.createRun({ launchUrl: String(url || ''), proxy: gate.runProxy, windowRect, profileDir, sandboxDisabled: sandbox.sandboxDisabled });
    run.profileLabel = label || saved.name || `Profile ${slot}`;
    run.slot = slot;
    run.profileId = udKey; // PHASE-6.3.1 — runtime browserRunId → profileId mapping (active-guard + reopen)
    run.browserAgent = agent; // re-applied on every attach
    // PHASE 6.3.2.2 — per-run executable so each browser launches from the resolved runtime. The launcher
    // uses run.chromeExecutable first (chrome-runtime.cjs); null keeps the runtime's pinned custom Chromium.
    run.chromeExecutable = usingChrome ? rtChoice.executable : null;
    run.browserKind = rtChoice.kind; // 'chromium' | 'chrome' — surfaced read-only on Screen 2
    headerLog('browser-launch', { runId: run.id, slotId: slot, kind: rtChoice.kind, profileDir });
    run.proxyUsername = username || (gate.config && gate.config.username) || null;
    // §52 — an AUTHENTICATED proxy must be answerable BEFORE the first request leaves the browser. Chromium used
    // to be launched straight onto the game URL: the very first request hit the proxy's 407 while the tool's CDP
    // connection was still ~1-2s away, so Chromium showed its own "Sign in — the proxy requires a username and
    // password" dialog and the credentials the tool holds were never used. Now such a browser starts on
    // about:blank; the game URL is loaded only once the proxy-auth handler is live (see the attach handler).
    const authFirst = !!(gate.runProxy && gate.runProxy.requiresAuth);
    run._pendingNavigateUrl = authFirst ? String(url || '') : null;
    const launched = await run.launcher.open(authFirst ? 'about:blank' : String(url || ''));
    if (!launched.ok) { runManager.failRun(run, launched.error); return { ok: false, error: launched.error }; }
    run.cdpEndpoint = launched.endpoint;
    connectRunEndpointWithRetry(run, launched.endpoint).catch(() => {});
    // Safety net: the browser must never be left on about:blank. If the page target's auth bind never ran (the
    // attach was missed / failed), load the game anyway — at worst Chromium asks for the proxy password itself.
    if (authFirst) {
      const PROXY_NAVIGATE_WATCHDOG_MS = 12000;
      setTimeout(() => {
        const pending = run._pendingNavigateUrl;
        if (!pending || run.status === RUN_STATUS.CLOSED) return;
        const client = runClientFor(run.id);
        headerLog('PROXY_NAVIGATE', { runId: run.id, slotId: slot, watchdog: true, client: !!client });
        if (!client || !client.Page) return;
        run._pendingNavigateUrl = null;
        client.Page.navigate({ url: pending }).catch(() => {});
      }, PROXY_NAVIGATE_WATCHDOG_MS);
    }
    return { ok: true, runId: run.id, proxy: gate.runProxy, agent: browserAgent.publicSnapshot(agent) };
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
    const wa = display.workArea;
    // §11 — first run (no saved bounds) opens in the bottom-right quadrant (≈ 1/4). A
    // previously-saved position/size is respected but re-clamped to the current work area
    // (multi-monitor / resolution changes never strand the window off-screen).
    if (!hasPos) return { ...toolWindowBounds(wa, { minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight }), minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight };
    const quarter = toolWindowBounds(wa, { minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight });
    return normalizeWindowBounds({ saved, workArea: wa, defaults: { width: quarter.width, height: quarter.height, minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight } });
  }
  function createWindow() {
    const bounds = fitToCurrentDisplay(loadWindowState());
    shell = new BrowserWindow({
      ...bounds, backgroundColor: '#f4f6fb', title: PRODUCT_NAME,
      // autoplay without a gesture: the 4th-player bell must ring even if nobody clicked the tool window first
      webPreferences: { preload: path.join(__dirname, 'phom-preload.cjs'), contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    shell.on('close', saveWindowState);
    shell.loadURL('phom-app://ui/index.html');
  }

  // ---- IPC (phom: namespace only) ----
  function registerIpc() {
    ipcMain.handle('phom:license-status', () => licenseStatus());
    ipcMain.handle('phom:license-activate', async (_e, key) => { if (!licenseGuard) return licenseStatus(); const s = await licenseGuard.activateAsync(String(key || '')); return { ...s, gameProduct: GAME_PRODUCT }; });
    ipcMain.handle('phom:machine-id', () => ({ machineId: licenseGuard ? licenseGuard.machineId() : null }));
    ipcMain.handle('phom:capabilities', () => ({ featureEnabled: process.env.PHOM_QA_ENABLED === '1', authorized: phomAuthorizedEnv(), licensed: licenseActive(), devBypass: devBypass.allowed === true, licenseMode: devBypass.allowed ? 'DEVELOPMENT_BYPASS' : 'LICENSED', proxySecret: (ensureStores(), proxySecretStore.capability()), chromiumSandbox: { mode: lastSandboxPolicy.mode, disabled: !!lastSandboxPolicy.sandboxDisabled, banner: lastSandboxPolicy.banner || null } }));

    // Proxy config (metadata only; passwords never returned to the renderer).
    ipcMain.handle('phom:proxy-list', guarded(() => { ensureStores(); return { ok: true, proxies: proxyConfigStore.list() }; }));
    // §3/§4 — expose the FULL catalog (mobile + desktop + laptop + laptop-small +
    // laptop-small + mobile-landscape). The UI groups them by profileType.
    ipcMain.handle('phom:agents', () => ({ ok: true, agents: browserAgent.AGENTS.map((a) => ({ agent: a, ...browserAgent.publicSnapshot(a) })), defaultAgent: browserAgent.DEFAULT_AGENT }));
    // ---- PHASE-6.3.1 — flexible N-profile CRUD + open-from-selection ----
    ipcMain.handle('phom:profiles-list', guarded(() => { ensureStores(); return { ok: true, profiles: deviceProfilesStore.list() }; }));
    ipcMain.handle('phom:profile-create', guarded((_e, input) => { ensureStores(); return deviceProfilesStore.create(input && typeof input === 'object' ? input : {}); }));
    ipcMain.handle('phom:profile-update-x', guarded((_e, id, patch) => { ensureStores(); return deviceProfilesStore.update(String(id == null ? '' : id), patch && typeof patch === 'object' ? patch : {}); }));
    // Delete blocked while the profile backs a LIVE Chromium (§11/§30) — close the browser first.
    ipcMain.handle('phom:profile-delete-x', guarded((_e, id) => {
      ensureStores();
      const pid = String(id == null ? '' : id);
      if (profileInUse(pid)) return { ok: false, error: { code: 'PHOM_PROFILE_IN_USE', message: 'Hồ sơ đang được một trình duyệt sử dụng. Hãy tắt trình duyệt đó trước.' } };
      return deviceProfilesStore.remove(pid);
    }));
    // Bulk-proxy apply: bind one proxy config (created here) to a profile by its id.
    ipcMain.handle('phom:profile-set-proxy', guarded((_e, id, proxyInput) => {
      ensureStores();
      const pid = String(id == null ? '' : id);
      if (profileInUse(pid)) return { ok: false, error: { code: 'PHOM_PROFILE_IN_USE', message: 'Hồ sơ đang chạy — không đổi proxy giữa chừng.' } };
      if (proxyInput == null || proxyInput === '') return deviceProfilesStore.setProxyRef(pid, null);
      const created = proxyConfigStore.upsert(typeof proxyInput === 'string' ? { input: proxyInput } : (proxyInput || {}));
      if (!created || created.ok === false) return created;
      return deviceProfilesStore.setProxyRef(pid, created.id);
    }));
    // Open 3 browsers from the SELECTED profiles (selection order → B1/B2/B3). Builds the cluster config
    // from each profile's own device + proxy; reuses the existing cluster manager (internal slots A/B/C).
    ipcMain.handle('phom:open-selected', guarded((_e, cfg) => openSelectedProfiles(cfg || {})));

    // The Phỏm session (3 runs): the table group + coordinator. Table actions themselves come from the in-page bars.
    ipcMain.handle('phom:start-session', guarded((_e, cfg) => {
      ensurePhomSessions();
      const r = phomSessions.startSession({ runIds: (cfg && cfg.runIds) || [], hostId: cfg && cfg.hostId, selectedStake: cfg && cfg.selectedStake });
      // the last stake the user picked is the session's stake from the start (bars + Dò Key / Tạo use it)
      const saved = savedStake(); if (r && r.ok !== false && saved != null) phomSessions.setStake(saved);
      return r;
    }));
    // §13 — Find-Table stake source: request the server channel list + read the
    // AUTHORITATIVE distinct stakes it reports (never a hard-coded fallback).
    // §35 — optionally scoped to ONE browser; seated browsers are always skipped (coordinator).
    ipcMain.handle('phom:request-channels', guarded(async (_e, cfg) => { ensurePhomSessions(); return phomSessions.requestChannels({ profileId: cfg && cfg.browserId != null ? cfg.browserId : null }); }));
    ipcMain.handle('phom:leave-all', guarded(() => { ensurePhomSessions(); return phomSessions.leaveAllTables(); }));
    ipcMain.handle('phom:session-state', () => (phomSessions ? phomSessions.snapshot() : null));
    // PHASE-2 — read the monotonic discovery/sync milestone timeline (telemetry for latency inspection).
    // TEST D — record the game client's own frames while the player acts by hand (e.g. clicks a table), then
    // write them to a file (secrets redacted) so the real protocol can be read instead of guessed.
    ipcMain.handle('phom:frames-record-start', (_e, cfg) => {
      const runIds = cfg && Array.isArray(cfg.runIds) ? cfg.runIds.filter((x) => x != null).map(String) : null;
      return { ok: true, ...frameRecorder.start({ runIds, label: cfg && cfg.label != null ? String(cfg.label) : null, keepRoomCodes: false }) };
    });
    ipcMain.handle('phom:frames-record-status', () => ({ ok: true, ...frameRecorder.status() }));
    ipcMain.handle('phom:frames-record-stop', () => stopAndSaveCapture());
    ipcMain.handle('phom:frames-open-folder', (_e, p) => { try { if (p) electronShell.showItemInFolder(String(p)); return { ok: true }; } catch (e) { return { ok: false, error: { code: 'OPEN_FAILED', message: String(e && e.message || e) } }; } });
    // PHASE-3 · PART B — observe-only native-JOIN experiment (A→B→C, same stake, no room forcing).
    // Authorized+licensed only; observes server matchmaking from ps[], never changes production flow.
    // PHASE-4 — HOST ROOM ANCHOR test (A→room→B/C). Authorized+licensed; observe-only, does not touch
    // the production discovery flow. A native-joins, is confirmed in ps[], its room is bound, then B/C
    // join THAT exact room id and are confirmed co-seated.
    // §auto — the Phỏm tool's TỰ ĐỘNG checkbox. ON forms the group (finder = browserId, KEY; the others READY /
    // NOT_READY) unless one exists, then rejoins kicked members and takes another table when one is lost. OFF stops it.
    ipcMain.handle('phom:auto-set', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.setAuto(!!(cfg && cfg.on), { creatorId: cfg && cfg.browserId, stake: cfg && cfg.stake != null ? Number(cfg.stake) : null }); }));
    // THE mức cược lives in the Phỏm tool; the in-page bars search at this stake (they have no picker of their own).
    ipcMain.handle('phom:set-stake', guarded((_e, cfg) => { ensurePhomSessions(); saveStake(cfg && cfg.stake); return phomSessions.setStake(cfg && cfg.stake); }));
    ipcMain.handle('phom:stake-get', () => ({ ok: true, stake: savedStake() }));
    ipcMain.handle('phom:new-table', guarded(() => { ensurePhomSessions(); return phomSessions.newTable(); }));
    // ẨN DANH switch (default OFF) — forced into every open browser now and into every one opened later.
    ipcMain.handle('phom:an-danh-get', () => ({ ok: true, on: anDanhOn }));
    ipcMain.handle('phom:an-danh-set', guarded(async (_e, cfg) => {
      anDanhOn = !!(cfg && cfg.on);
      const results = {};
      for (const run of (runManager ? runManager.list() : [])) {
        if (run.status === RUN_STATUS.CLOSED) continue;
        const client = runClientFor(run.id);
        if (client) results[run.id] = await anDanh.applyAnDanh(client, anDanhOn);
      }
      headerLog('AN_DANH_SET', { on: anDanhOn, results });
      return { ok: true, on: anDanhOn, results };
    }));
    ipcMain.handle('phom:ui-snapshot', () => phomUiSnapshot());
    // PHASE 6.3.2.2 — BROWSER RUNTIME preference (AUTO | CUSTOM_CHROMIUM | GOOGLE_CHROME). get returns the
    // saved preference + what each option currently resolves to (so SETUP can show availability).
    ipcMain.handle('phom:browser-runtime-get', () => {
      const custom = chromiumRuntime();
      const chrome = browserRuntimeResolver.resolveGoogleChrome({ env: process.env });
      return { ok: true, preference: browserRuntimePref(), customAvailable: !!(custom && custom.ok), chromeAvailable: !!(chrome && chrome.ok), resolved: (() => { const r = resolveBrowserRuntimeChoice(); return r.ok ? { kind: r.kind, fellBack: !!r.fellBack } : { error: r.error }; })() };
    });
    ipcMain.handle('phom:browser-runtime-set', guarded((_e, cfg) => ({ ok: true, preference: setBrowserRuntimePref(cfg && cfg.preference) })));
    // PHASE-6.2.2 — browser lifecycle, all scoped to ONE run (never touches the Tool or the other browsers).
    // ↻ WEB: reload the page in the SAME Chromium; if the page is gone, re-navigate to the game URL — never
    // launches a second Chromium OS window.
    // ↻ WEB: reload the page in the SAME Chromium (re-navigates to the game URL if the page is gone). Shared
    // logic with the in-Chromium header's ⟳ button (reloadWebRun) — unchanged behavior, same IPC contract.
    ipcMain.handle('phom:reload-web', guarded(async (_e, cfg) => reloadWebRun(cfg && cfg.browserId)));
    // ⏻ TẮT CHROMIUM: close ONLY this run's Chromium window/process (Tool + other browsers untouched).
    ipcMain.handle('phom:close-browser', guarded(async (_e, cfg) => closeBrowserRun(cfg && cfg.browserId)));
    ipcMain.handle('phom:cluster-open', guarded(() => ensureCluster().openCluster()));
    // THAY PROFILE / MỞ LẠI one slot: { slot:'A'|'B'|'C', profileId? } — no profileId = reopen the slot's own profile.
    // ĐỔI NGƯỜI CHƠI: { slot:'A'|'B'|'C', reserve:'D'|'E' } — an open reserve browser plays in that slot at once.
    // N5 — open the folder of saved rounds (LỌC BÀI review): one JSON per round, the newest 50 kept.
    ipcMain.handle('phom:rounds-open', async () => {
      try { const j = ensureRoundJournal(); j.flush('OPEN_FOLDER'); fs.mkdirSync(j.dir(), { recursive: true }); const err = await electronShell.openPath(j.dir()); return err ? { ok: false, error: { code: 'OPEN_FAILED', message: err } } : { ok: true, dir: j.dir() }; }
      catch (e) { return { ok: false, error: { code: 'OPEN_FAILED', message: safeMsg(e) } }; }
    });
    // BỐ CỤC — which quarter each window takes (P1/P2/P3/Tool); set = save + arrange at once
    ipcMain.handle('phom:layout-get', () => ({ ok: true, layout: currentWindowLayout(), defaultLayout: { ...windowLayout.DEFAULT_LAYOUT } }));
    ipcMain.handle('phom:layout-set', guarded((_e, cfg) => { const layout = setWindowLayout(cfg && cfg.layout); restoreLayout(); return { ok: true, layout }; }));
    ipcMain.handle('phom:reserve-reopen', guarded(async (_e, cfg) => reopenReserve(cfg && cfg.reserve)));
    ipcMain.handle('phom:slot-swap', guarded(async (_e, cfg) => swapSlot(cfg && cfg.slot, cfg && cfg.reserve)));
    ipcMain.handle('phom:slot-replace', guarded(async (_e, cfg) => replaceSlot(cfg && cfg.slot, cfg && cfg.profileId ? String(cfg.profileId) : null)));
    ipcMain.handle('phom:cluster-connect', guarded(() => ensureCluster().connectClusterCdp()));
    ipcMain.handle('phom:cluster-apply-agents', guarded(() => ensureCluster().applyClusterAgents()));
    // ĐÓNG 3 TRÌNH DUYỆT = EXPLICIT browser close (the ONLY app path that closes the runs).
    ipcMain.handle('phom:cluster-stop', guarded(async () => { lifecycleLog('IPC_CLUSTER_STOP', {}); return ensureCluster().stopCluster(); }));
    ipcMain.handle('phom:cluster-snapshot', () => (phomCluster ? phomCluster.getClusterSnapshot() : null));

    // 2×2 workspace layout controls (§9/§21).
    ipcMain.handle('phom:restore-layout', guarded(() => restoreLayout()));
    // VÀO GAME PHỎM — trigger the verified `vgcg_8` entry action via the site's own Cocos node.
    ipcMain.handle('phom:enter-game', guarded((_e, runId) => phomEnterGame(String(runId == null ? '' : runId))));


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
  app.on('window-all-closed', () => { lifecycleLog('APP_WINDOW_ALL_CLOSED', {}); if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { lifecycleLog('APP_BEFORE_QUIT', { stack: (new Error().stack || '').split('\n').slice(1, 6).join(' | ') }); });
  app.on('will-quit', () => { lifecycleLog('APP_WILL_QUIT', {}); _coseatFlush(); }); // §ws-log — never lose the last batch
}

module.exports = { PRODUCT_NAME, GAME_PRODUCT };
