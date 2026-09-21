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

const { app, BrowserWindow, ipcMain, protocol, safeStorage, screen, net, session, dialog, shell: electronShell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { redactDiagnostic, maskSecret } = require('./protocol/phom/diagnostic-redaction.cjs');
const { TokenKeyStore } = require('./protocol/phom/token-key-store.cjs');

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
const { PhomClusterCdpManager } = require('./protocol/phom/phom-cluster-cdp-manager.cjs');
const { projectRuntimeToManagerConfig } = require('./protocol/phom/cluster-runtime-projection.cjs');
const { parseQuickProxies, parseQuickProxyRows } = require('./browser-run/phom-quick-proxy.cjs');
const { applyQuickProxies } = require('./protocol/phom/quick-proxy-apply.cjs');
const { createFrameRecorder } = require('./protocol/phom/frame-recorder.cjs');
const { ProxyConfigStore } = require('./browser-run/proxy-config-store.cjs');
const { ProxySecretStore } = require('./browser-run/proxy-secret-store.cjs');
const { ProxyTester, testAll } = require('./browser-run/proxy-tester.cjs');
const { resolveLaunchProxy } = require('./browser-run/proxy-config.cjs');
const { PhomProfileStore } = require('./browser-run/phom-profile-store.cjs');
const { PhomDeviceProfilesStore } = require('./browser-run/phom-device-profiles-store.cjs');
const { PhomClusterProfileStore } = require('./browser-run/phom-cluster-profile-store.cjs');
const { runEnterGameViaSite } = require('./protocol/cocos-lobby-entry.cjs');
const { GAME_ID: PHOM_GAME_ID } = require('./protocol/phom/phom-frame-classify.cjs');
const deviceProfile = require('./browser-run/device-profile.cjs');
const { bindProxyAuth } = require('./browser-run/proxy-auth-handler.cjs');
const { LicenseGuard } = require('./licensing/license-guard.cjs');
const { resolveDevBypass, FORBIDDEN_CODE: DEV_BYPASS_FORBIDDEN } = require('./licensing/dev-bypass.cjs');
const { parseObservedIp } = require('./browser-run/ip-parse.cjs');
const { rectForSlot, toolWindowBounds, desktopWindowRectForSlot, arrangeBrowserWindows, arrangeClusterWindows } = require('./protocol/phom/grid-layout.cjs');
const gameHeader = require('./protocol/phom/game-header.cjs');
const headerBridge = require('./protocol/phom/phom-header-bridge.cjs');
const headerActionGuard = require('./protocol/phom/header-action-guard.cjs');
const { evaluateHeaderAction } = headerActionGuard;
const offlineAnalyzer = require('./protocol/phom/offline-analyzer.cjs');
const { PhomOfflineSimulator } = require('./protocol/phom/offline-simulator.cjs');
const sampleDatasets = require('./protocol/phom/offline-sample-datasets.cjs');
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
  var clusterProfileStore = null;
  var phomSessions = null;
  // PHASE 6.3.3.3 — one read-only safe-card analyzer (deterministic, no state beyond a memo cache). The
  // selected target uid is owned by the renderer and passed per analyze() call — no duplicate target state.
  const safeCardAnalyzer = createSafeCardAnalyzer();
  // Records which saved cluster profile id (if any) backs the live ClusterSession, so
  // the store can block deleting a profile that is in use. Set on a profile-driven
  // create, cleared on stop/leave. This is provenance only — it never alters the Host
  // coordinator runtime (that integration is a later phase).
  var activeClusterProfileId = null;
  const SLOTS_ABC = ['A', 'B', 'C'];

  const phomRoot = () => path.join(PHOM_USERDATA, 'phom');
  const tokenKeyStore = new TokenKeyStore({ file: path.join(phomRoot(), 'token-keys.enc'),
    available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) });
  const ensureDir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ } };

  // ---- capture + send seam (shared, target-keyed) ----
  const capture = new CaptureCorrelator({ resolveClient: (tid) => resolveTargetClient(tid) });
  const wsReplay = new WsReplay({ resolveClient: (tid) => resolveTargetClient(tid), getCaptured: (id) => capture.get(id) });
  // TEST D — passive recorder of the game's own frames between a user START/STOP (see frame-recorder.cjs).
  const frameRecorder = createFrameRecorder();
  const lastCaptureByRun = Object.create(null); // runId -> file name of that browser's last Test D capture
  // Stop the recording and write it as JSON + a readable one-line-per-frame .txt under userData/phom-captures.
  // Shared by the Tool window (IPC) and the in-Chromium header (⋯ menu).
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
      for (const id of (out.runIds || [])) lastCaptureByRun[id] = name;
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
        // The file holds RAW protocol frames, which include this account's login/session token. It is a
        // local diagnostic capture, not something to paste into a chat or a bug report unedited.
        + '# CẢNH BÁO: file này chứa frame WebSocket thô, gồm cả token phiên đăng nhập — không chia sẻ nguyên văn.\n', 'utf8'); } catch { /* best effort */ }
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
  // §ws-inspect — export ALL captured WebSocket request/response to a readable .txt (one line per frame: time,
  // Player, → GỬI / ← NHẬN, and the raw frame) so the user can inspect exactly what the game sends/receives.
  function exportWsLog() {
    try {
      _coseatFlush(); // §ws-log — the newest frames may still be queued; the export must include them
      const src = coseatLogPath();
      if (!fs.existsSync(src)) return { ok: false, error: { code: 'PHOM_NO_WS_LOG', message: 'Chưa có log — hãy thao tác trong game trước.' } };
      const lines = fs.readFileSync(src, 'utf8').split('\n');
      const slotName = (r) => ({ B1: 'P1', B2: 'P2', B3: 'P3' })[r] || r || '?';
      const out = ['# WEBSOCKET LOG — toàn bộ request/response game gửi/nhận', ''];
      let base = null;
      for (const ln of lines) {
        if (!ln || ln.startsWith('#')) continue; let e; try { e = JSON.parse(ln); } catch { continue; }
        if (e.event !== 'WIRE') continue;
        if (base == null) base = e.at;
        const t = ((e.at - base) / 1000).toFixed(1) + 's';
        const dir = e.dir === 'req' ? '→ GỬI' : '← NHẬN';
        const body = e.bin ? `[nhị phân ${e.len}b] ${e.ascii || ''}` : (e.raw || '');
        out.push(`${String(t).padStart(8)}  ${slotName(e.slot).padEnd(3)} ${dir}  ${body}`);
      }
      const dir = path.join(app.getPath('userData'), 'phom-captures');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(dir, 'ws-log-' + stamp + '.txt');
      fs.writeFileSync(dest, out.join('\n'), 'utf8');
      try { electronShell.showItemInFolder(dest); } catch { /* best effort */ }
      return { ok: true, path: dest, frames: out.length - 2 };
    } catch (e) { return { ok: false, error: { code: 'PHOM_WS_EXPORT_FAILED', message: String(e && e.message || e) } }; }
  }
  // Is THIS browser currently being recorded (a recording of one browser, or of all)?
  function captureActiveFor(runId) {
    const st = frameRecorder.status();
    return !!(st && st.recording && (!st.runIds || st.runIds.includes(String(runId))));
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
  var _browserRuntimePref = null;
  function browserRuntimePref() {
    if (_browserRuntimePref) return _browserRuntimePref;
    try { const j = JSON.parse(fs.readFileSync(browserRuntimeSettingPath(), 'utf8')); _browserRuntimePref = browserRuntimeResolver.normalizePreference(j && j.preference); }
    catch { _browserRuntimePref = 'AUTO'; }
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
    onRunExit: (runId, record) => { try { lifecycleLog('MAIN_ON_RUN_EXIT', { runId, reason: record && record.reason }); if (runManager) runManager.disconnectRun(runManager.get(runId)); phomSessions.routeDisconnect(runId); if (phomCluster && phomCluster.markRunClosed) phomCluster.markRunClosed(runId, record && record.reason); } catch { /* best effort */ } },
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
    // PHASE-6.3.1 — the canonical flexible profile LIST store (N profiles; add/edit/delete + selection).
    deviceProfilesStore = new PhomDeviceProfilesStore({ filePath: path.join(phomRoot(), 'phom-device-profiles.json') });
    // Cluster profile store: MANY saved cluster configs (one shared game URL + three
    // browser/device/proxy slots). References are resolved against the existing per-slot
    // Phom profile store + proxy store (no second store stack); the active-session guard
    // is the live cluster provenance recorded in activeClusterProfileId.
    clusterProfileStore = new PhomClusterProfileStore({
      filePath: path.join(phomRoot(), 'phom-cluster-profiles.json'),
      resolveBrowserProfile: (bpid) => profileStore.getPublic(bpid),
      resolveDevice: (bpid, deviceId) => { const dev = profileStore.deviceFor(bpid); return dev && String(dev.id) === String(deviceId) ? deviceProfile.publicSnapshot(dev) : null; },
      resolveProxy: (ref) => proxyConfigStore.getPublic(ref),
      isActive: (id) => !!(phomCluster && phomCluster.active() && activeClusterProfileId && String(activeClusterProfileId) === String(id)),
      migrationSource: () => clusterMigrationSource(),
    });
    clusterProfileStore.load();
    try { clusterProfileStore.migrate(); } catch { /* migration is best-effort + additive */ }
    proxyTester = new ProxyTester({
      allowlist: IP_CHECK_ALLOWLIST,
      ipCheckUrl: IP_CHECK_URL,
      transport: netProxyTransport,     // RUNTIME-UNVERIFIED without a real proxy
    });
  }

  // Build the additive migration source from the EXISTING per-slot Phom selections:
  // only when all three slots A/B/C already have a saved device do we offer a default
  // cluster profile (references preserved). Never fabricates a game URL/proxy.
  function clusterMigrationSource() {
    if (!profileStore) return null;
    const slots = {};
    for (const s of SLOTS_ABC) {
      const dev = profileStore.deviceFor(s);
      if (!dev || !dev.id) return null; // incomplete — skip migration (no fake data)
      const saved = profileStore.get(s) || {};
      slots[s] = { browserProfileId: s, deviceProfileId: String(dev.id), proxyRef: saved.proxyRef || null };
    }
    return { name: 'Cụm mặc định', gameUrl: null, defaultHostSlot: 'A', slots };
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
    phomSessions.on('hands', (hands) => { scheduleHandsBroadcast(hands); });
    phomSessions.on('cards', (cards) => { scheduleCardsBroadcast(cards); }); // PHASE 6.3.3.2 — card observation

    phomSessions.on('kick', (k) => send('phom:kick', k));
    phomSessions.on('log', (l) => { try { if (l && l.tag === 'PHOM-COSEAT') appendCoseatLog(l); } catch {} try { if (process.env.PHOM_LIFECYCLE_LOG === '1') console.log(`[${l.tag}] ${l.event}`, JSON.stringify(l)); } catch {} send('phom:log', l); });
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
  // §3 — the SAVED cluster profile is the ONLY authoritative source for opening the
  // cluster. The renderer sends at most a clusterProfileId (+ non-persisted runtime
  // options like localTest); it can NOT inject executablePath/userDataDir/cdpPort/pid/
  // token/proxy password/raw BrowserRun/device to bypass the saved profile. We resolve
  // the id (explicit, else the persisted selection), project the store's READY runtime
  // config, and map it to the manager's createCluster shape. A non-ready profile fails
  // TYPED here — before a single browser is opened.
  function resolveClusterRuntime(config = {}) {
    ensureStores();
    const c = config && typeof config === 'object' ? config : {};
    const rawId = c.clusterProfileId != null ? String(c.clusterProfileId).trim() : '';
    const id = rawId || clusterProfileStore.selectedId();
    if (!id) return { ok: false, error: { code: 'PHOM_CLUSTER_PROFILE_REQUIRED', message: 'Chưa chọn hồ sơ cụm. Hãy chọn hoặc tạo một Cluster Profile trước.' } };
    const rt = clusterProfileStore.toRuntimeConfig(id); // typed NOT_FOUND / NOT_READY
    if (!rt.ok) return rt;
    const proj = projectRuntimeToManagerConfig(rt.config, {
      resolveRawDevice: (bpid, did) => { const dev = profileStore.deviceFor(bpid); return dev && (did == null || String(dev.id) === String(did)) ? dev : null; },
    });
    if (!proj.ok) return proj;
    return { ok: true, id, ...proj.config };
  }

  // §4–§7 — quick-3-proxy apply. Parse the textarea + selector into three descriptors
  // (authoritative in the domain, never the renderer), then atomically create the three
  // proxy configs (metadata + secret owner), bind each slot's browser profile proxyRef,
  // and update+revalidate the selected Cluster Profile. Rolls back on any failure. No
  // secret is ever returned; a running cluster's mapping is refused (IN_USE).
  function quickProxyApply(payload) {
    ensureStores();
    const p = payload && typeof payload === 'object' ? payload : {};
    // New UI sends slot-labeled rows [{slot,protocol,value}]; legacy path sends {text,protocol}.
    // Proxy is OPTIONAL (§10): the UI applies only non-empty rows (partial), leaving blank
    // slots on their existing binding (DIRECT or a previously-bound proxy).
    const parsed = Array.isArray(p.rows) ? parseQuickProxyRows(p.rows, { partial: p.partial !== false }) : parseQuickProxies(p.text, { protocol: p.protocol });
    if (!parsed.ok) return parsed; // typed parse error (never contains a credential)
    const clusterProfileId = p.clusterProfileId != null && String(p.clusterProfileId).trim() ? String(p.clusterProfileId).trim() : null;
    return applyQuickProxies({ slots: parsed.slots, clusterProfileId }, {
      isClusterActive: (id) => !!(phomCluster && phomCluster.active() && activeClusterProfileId && String(activeClusterProfileId) === String(id)),
      createProxy: ({ protocol, host, port, username, password }) => {
        const res = proxyConfigStore.upsert({ protocol, host, port, username: username || null, password: password != null ? password : null, label: `${protocol}://${host}:${port}` });
        return res && res.ok ? { ok: true, id: res.id } : res;
      },
      removeProxy: (id) => proxyConfigStore.remove(id),
      setProfileProxyRef: (bpid, proxyRef) => profileStore.upsert(String(bpid), { proxyRef }),
      getClusterProfile: (id) => clusterProfileStore.get(id),
      updateClusterProfile: (id, patch) => clusterProfileStore.update(id, patch),
      validateCluster: (id) => clusterProfileStore.validateReady(id),
    });
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
    if (ids.length !== 3 || new Set(ids).size !== 3) return { ok: false, error: { code: 'PHOM_SELECT_THREE', message: 'Chọn đúng 3 hồ sơ khác nhau.' } };
    clusterLocalTest = !!(localTest && devBypass.allowed);
    // A typed Game URL (if any) OVERRIDES + is REMEMBERED; otherwise each profile falls back to its own
    // saved gameUrl so the URL never has to be re-typed on the next launch (§6.3.2-fix).
    const typedUrl = !localTestActive() && gameUrl != null ? String(gameUrl).trim() : '';
    const profiles = [];
    for (let i = 0; i < 3; i++) {
      const p = deviceProfilesStore.get(ids[i]);
      if (!p) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `Hồ sơ ${ids[i]} không tồn tại.` } };
      if (!p.device) return { ok: false, error: { code: 'PHOM_PROFILE_NO_DEVICE', message: `Hồ sơ "${p.name}" chưa có thiết bị.` } };
      const profUrl = localTestActive() ? 'about:blank' : (typedUrl || (p.gameUrl ? String(p.gameUrl).trim() : ''));
      if (!localTestActive() && !profUrl) return { ok: false, error: { code: 'PHOM_GAME_URL_REQUIRED', message: 'Nhập Game URL (hoặc lưu URL trong hồ sơ) trước khi mở.' } };
      // Remember the URL on the profile so the next app launch reuses it (with the persistent user-data-dir
      // this returns straight to the logged-in game — no re-login).
      if (!localTestActive() && profUrl && profUrl !== (p.gameUrl || '')) { try { deviceProfilesStore.update(ids[i], { gameUrl: profUrl }); } catch { /* best effort */ } }
      // slot A/B/C = the runtime B1/B2/B3 window; browserProfileId carries the flexible profile id.
      profiles.push({ slot: SLOTS_ABC[i], browserProfileId: p.id, profileId: p.id, device: p.device, proxyRef: p.proxyRef || null, gameUrl: profUrl, label: p.name });
    }
    const clusterUrl = localTestActive() ? 'about:blank' : (profiles[0] ? profiles[0].gameUrl : typedUrl);
    const res = ensureCluster().createCluster({ clusterProfileId: null, hostSlot: 'A', selectedStake: null, gameUrl: clusterUrl, profiles });
    if (res && res.ok === false) return res;
    activeClusterProfileId = null;
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
        // PHASE-6.3.1 — a flexible selected profile carries its own id (as browserProfileId) + full device.
        profileId: (cfg && (cfg.profileId || cfg.browserProfileId)) || null,
        device: (cfg && cfg.device) || null,
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
  // PHASE-6 — the deterministic 3-window arrangement across the LIVE display topology (one browser per
  // monitor when ≥3 monitors; tiled otherwise). Uses the three slot devices' viewports so each window
  // fits its mobile-landscape content. Pure geometry (grid-layout); the placement is applied via each
  // run's chrome --window-position/--window-size at launch.
  function allDisplayWorkAreas() { try { return screen.getAllDisplays().map((d) => d.workArea); } catch { return [currentWorkArea()]; } }
  // §7/§8 — carry BOTH the OS window size and the emulated viewport to grid-layout.
  // A device may request an explicit desktop OS window (e.g. 960×540) that is
  // independent from its game viewport (e.g. 851×393). Legacy mobile-only profiles
  // carry osWindow=null; the geometry layer falls back to viewport + chrome.
  function clusterDevices() { return SLOTS_ABC.map((s) => { let d = null; try { d = profileStore && profileStore.deviceFor(s); } catch { d = null; } return d ? { osWindowWidth: d.osWindowWidth, osWindowHeight: d.osWindowHeight, viewportWidth: d.viewportWidth, viewportHeight: d.viewportHeight } : {}; }); }
  function clusterWindowArrangement() { return arrangeBrowserWindows(allDisplayWorkAreas(), clusterDevices(), { gap: 8 }); }
  // PHASE-6.2 — the FOUR-window arrangement (3 desktop Chromium windows + the Tool window). Browsers use
  // .slots[1..3]; the Tool window is placed at .tool.
  function clusterFourWindowArrangement() { return arrangeClusterWindows(allDisplayWorkAreas(), clusterDevices(), { gap: 8 }); }
  // Re-tile all owned session runs into the 2×2 grid + place the control window BR.
  function restoreLayout() {
    try {
      const wa = currentWorkArea();
      // PHASE-6.2 — place the Tool as the 4th window of the deterministic cluster arrangement (its own
      // monitor with ≥4 displays, else docked bottom-right of the last browser monitor / BR quadrant on
      // one display). Falls back to the bottom-right quadrant if the arrangement is unavailable.
      let control = null;
      try { const arr = clusterFourWindowArrangement(); control = arr && arr.tool; } catch { control = null; }
      if (!control) control = toolWindowBounds(wa, { minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight });
      if (shell && !shell.isDestroyed() && control) shell.setBounds({ x: Math.round(control.x), y: Math.round(control.y), width: Math.round(control.width), height: Math.round(control.height) });
      // Owned browser windows are external Chrome; re-applying geometry to a running
      // chrome.exe requires reopening. We report the target rects so the UI can guide
      // a reopen; we never move a window that is not one of our runs.
    } catch { /* best effort */ }
    return { ok: true };
  }
  function focusBrowser(runId) {
    try { const wc = chromeRuntime.webContents(runId); if (wc && !wc.isDestroyed() && typeof wc.focus === 'function') wc.focus(); return { ok: true }; } catch { return { ok: false }; }
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
  const headerEnterStartedAt = Object.create(null); // runId -> monotonic ms at ENTER_GAME accept (latency)
  const headerEnterTimer = Object.create(null);     // runId -> bounded ENTERING timeout handle (§10 not-stuck)
  // PHASE 6.3.6 — the USER-selected FINDER (room anchor), by Player index 1/2/3; null = none chosen yet (every
  // browser may FIND). NEVER defaulted to Player 1. Independent of the analyzer's selected player.
  let selectedFinderIndex = null;
  // Push the current finder choice into the live coordinator (its same-room-proof anchor). Best-effort: header
  // derivation already uses selectedFinderIndex directly, so this only keeps the coordinator's anchor in sync.
  function applyFinderToCoordinator() {
    try {
      if (!phomSessions) return;
      let profileId = null;
      if (selectedFinderIndex != null) { const b = (phomSessions.manualBrowserSnapshot() || []).find((x) => x.browserIndex === selectedFinderIndex); profileId = b ? b.profileId : null; }
      phomSessions.setFinder(profileId);
    } catch { /* best effort */ }
  }
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
  function headerLog(event, data = {}) {
    if (process.env.PHOM_HEADER_LOG !== '1' && process.env.PHOM_LIFECYCLE_LOG !== '1') return;
    try { lifecycleLog('PHOM_HEADER', { event, ...data }); } catch { /* best effort */ }
  }

  // The cluster's shared RID = the RID of the first browser already JOINED to a table. Other in-game
  // browsers then show VÀO BÀN (JOIN_SHARED) for that RID — no independent re-discovery (§ shared RID).
  // §38 — the shared room comes from the coordinator's single source of truth (sharedRid()), which the Tool window
  // reads too. Rules unchanged: the USER-selected finder's own VALIDATED room (never a provisional anchor that has
  // not passed the post-anchor capacity check); no finder chosen → whichever browser actually found+joined; never
  // hard-coded to Player 1. Deriving it here separately is what let the Tool and the header disagree.
  function headerSharedRid() {
    return phomSessions && phomSessions.active() ? phomSessions.sharedRid() : null;
  }

  // §co-seat — the moment the finder is seated, fire the OTHER in-game browsers' VÀO BÀN to its rid AT ONCE
  // (parallel, near-zero gap), so the server's fill-room seats them at the finder's table. Real capture proved
  // the grouping window is short (~1.3s co-seats, ~2.8s misses forever), so slow manual clicks are the problem.
  // Only browsers that are IN GAME and not already seated/joining are fired; each JOIN still proves co-seating
  // from ps[] (manualJoinShared). Best-effort, fire-and-forget.

  // §co-seat — the real số bàn + key are ONLY in the game's ENCRYPTED binary channel, decoded inside the game's
  // JS. So (like the reference tool) read them from the running game's memory: a bounded walk of `window`/the
  // Cocos runtime collecting 6–8 digit integers + key-like strings, ranked by how "room/table"-like their property
  // path is. Results go to coseat.jsonl (GAME_PROBE) so the exact variable holding the số bàn can be pinpointed.
  // §co-seat — the DECODED table list lives in the game's JS memory (the game decrypts the binary channel into an
  // array of room objects). Walk the runtime for ARRAYS whose elements look like table entries ({rid,b,uC,Mu}),
  // and for any single "current room" object — the 7-digit SỐ BÀN we need is right there.
  const GAME_ROOM_PROBE = `(function(){var out={globals:[],hits:[],both:[],scanned:0,xo:0};try{
    var seen=new Set(),count=0,CAP=800000;
    var SKIP=/loader|_pipes|md5|assets?|_cache|spriteFrame|texture|material|shader|font|audio|clip|atlas|prefab|bundle|_deps|dependUtil|prototype|constructor/i;
    function isWin(o){ try{ return o&&(o.window===o||o.self===o); }catch(e){ return true; } }
    function is7(v){ return (typeof v==='number'&&Number.isInteger(v)&&v>=1000000&&v<=9999999) || (typeof v==='string'&&/^[0-9]{7}$/.test(v)); }
    function isKey(v){ return typeof v==='string'&&/^[A-Za-z0-9]{6,12}$/.test(v)&&/[A-Za-z]/.test(v)&&/[0-9]/.test(v); }
    function shape(o){ var s={}; try{ for(var k in o){ var v=o[k]; var t=typeof v; if((t==='number'||t==='boolean')||(t==='string'&&v.length<=32)) s[k]=v; } }catch(e){} return s; }
    function walk(o,path,d){ try{
      if(count>CAP||d>16||o==null)return; var t=typeof o; if(t!=='object')return;
      if(isWin(o)&&path!=='w'){out.xo++;return;} if(seen.has(o))return; seen.add(o); count++;
      if(Array.isArray(o)){ if(o.length>4000)return; for(var i=0;i<Math.min(o.length,4000);i++)walk(o[i],path+'['+i+']',d+1); return; }
      // detect an object that holds a 7-digit number and/or an 8-char key (the room object with SS + key)
      var has7=false,hasK=false; try{ for(var kk in o){ var vv=o[kk]; if(is7(vv))has7=true; if(isKey(vv))hasK=true; } }catch(e){}
      if(has7 && hasK && out.both.length<60) out.both.push({path:path,shape:shape(o)});
      else if(has7 && out.hits.length<150) out.hits.push({path:path,shape:shape(o)});
      var ks; try{ks=Object.keys(o);}catch(e){out.xo++;return;} if(ks.length>6000)return;
      for(var j=0;j<ks.length;j++){ var k=ks[j]; if(SKIP.test(k)||k==='parent'||k==='_parent'||k==='node'||k==='frames'||k==='top'||k==='opener'||k==='window'||k==='self')continue; var v; try{v=o[k];}catch(e){continue;} walk(v,path+'.'+k,d+1); }
    }catch(e){ out.xo++; } }
    try{ out.globals=Object.getOwnPropertyNames(window).filter(function(k){ try{ if(/^(webkit|chrome|document|location|navigator|history|css|visual|screen|performance|external|caches|crypto|indexedDB|speech|customElements|trusted|on[a-z]|frames|length|closed|status|scroll|inner|outer|device|origin|top|self|window|parent|name)/i.test(k))return false; var v=window[k]; return v&&(typeof v==='object'||typeof v==='function'); }catch(e){return false;} }).slice(0,140); }catch(e){}
    walk(window,'w',0); out.scanned=count;
    return JSON.stringify(out);
  }catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()`;
  const _probeCtx = Object.create(null); // runId -> Map(contextId -> {origin,frameId,name})
  async function probeGameRoom(runId) {
    const client = runClientFor(runId);
    if (!client || !client.Runtime) return null;
    const rid = String(runId);
    // §co-seat — the game is a cross-origin iframe in the SAME process → no child session, but CDP can still
    // evaluate in its MAIN world via contextId. Enumerate EVERY frame's execution context (Runtime.enable
    // re-fires executionContextCreated for all existing contexts) and run the probe in each; the game frame's
    // context is the one that holds cc + the decoded table list.
    if (!_probeCtx[rid]) {
      _probeCtx[rid] = new Map();
      try { client.Runtime.executionContextCreated((p) => { try { if (p && p.context) _probeCtx[rid].set(p.context.id, { origin: p.context.origin, name: p.context.name, frameId: p.context.auxData && p.context.auxData.frameId }); } catch { /* ignore */ } }); } catch { /* ignore */ }
      try { client.Runtime.executionContextDestroyed((p) => { try { _probeCtx[rid].delete(p.executionContextId); } catch { /* ignore */ } }); } catch { /* ignore */ }
    }
    // Runtime was likely already enabled (header push) → a plain enable does NOT re-fire existing contexts.
    // DISABLE then ENABLE forces executionContextCreated for every current context (all frames).
    try { await client.Runtime.disable(); } catch { /* ignore */ }
    try { await client.Runtime.enable(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 600)); // let executionContextCreated events arrive
    // diagnostic: also dump the frame tree so the game frame's origin is visible even if contexts stay empty
    let frames = []; try { const ft = await client.Page.getFrameTree(); (function w(n){ if (n && n.frame) frames.push({ url: n.frame.url, origin: n.frame.securityOrigin, id: n.frame.id }); if (n && n.childFrames) n.childFrames.forEach(w); })(ft.frameTree); } catch { /* ignore */ }
    async function run(cid) {
      const args = { expression: GAME_ROOM_PROBE, returnByValue: true, timeout: 8000 };
      if (cid != null) args.contextId = cid;
      const r = await client.Runtime.evaluate(args);
      try { return JSON.parse(r && r.result && r.result.value); } catch { return null; }
    }
    // A HIT = the probe found a room-shaped object: `both` (a 7-digit số bàn AND a key-like string on the SAME
    // object — the room record we are after) or, failing that, `hits` (a 7-digit number somewhere). Those are the
    // fields GAME_ROOM_PROBE actually returns. It used to test `lists`/`cur`, the shape of an EARLIER version of
    // the probe, so hit() was false for every context: the walk (up to 800k objects) ran in EVERY frame instead
    // of stopping at the game's, and the result kept below was the FIRST one — the outer page, cross-origin and
    // holding no game state — so the game frame's findings were thrown away. `globals`/`scanned` come back from
    // every context and must never count as a hit.
    const hit = (x) => !!(x && ((x.both && x.both.length) || (x.hits && x.hits.length)));
    // How informative a non-hit result is, so the fallback keeps the GAME frame's walk instead of the first one.
    const score = (x) => (x ? ((x.both ? x.both.length : 0) * 1e6) + ((x.hits ? x.hits.length : 0) * 1e3) + Math.min(x.scanned || 0, 999) : -1);
    try {
      let best = null, bestCid = null;
      const ids = [null, ...[..._probeCtx[rid].keys()]];
      for (const cid of ids) {
        let parsed = null; try { parsed = await run(cid); } catch { parsed = null; }
        if (hit(parsed)) { appendCoseatLog({ tag: 'PHOM-COSEAT', event: 'GAME_PROBE', runId: rid, at: Date.now(), contextId: cid, ctx: _probeCtx[rid].get(cid) || null, result: parsed }); return parsed; }
        if (score(parsed) > score(best)) { best = parsed; bestCid = cid; }
      }
      appendCoseatLog({ tag: 'PHOM-COSEAT', event: 'GAME_PROBE', runId: rid, at: Date.now(), contextId: bestCid, ctx: bestCid != null ? (_probeCtx[rid].get(bestCid) || null) : null, contexts: [..._probeCtx[rid].values()], frames, result: best });
      return best;
    } catch (e) { appendCoseatLog({ tag: 'PHOM-COSEAT', event: 'GAME_PROBE_ERR', runId: rid, at: Date.now(), err: String(e && e.message || e) }); return null; }
  }

  // Build the raw header view for ONE browser from authoritative snapshots (no button logic here — that
  // is deriveHeaderState). opened = a live (non-closed) run; inGame mirrors the renderer's slotInPhom
  // (socketReady + connected + channelList received). account = the logged-in display name (dn) or —.
  function headerViewFor(runId, browsers, sharedRid, sharedRoomCode) {
    const run = runManager && runManager.get(String(runId));
    const opened = !!(run && run.status !== RUN_STATUS.CLOSED);
    const b = (browsers || []).find((x) => x && String(x.profileId) === String(runId)) || {};
    const inGame = opened && !!b.socketReady && !!b.connected && (b.channelCount || 0) > 0;
    const account = b.username && b.username !== 'USER_UNKNOWN' ? b.username : null;
    return {
      account, opened, inGame,
      // PHASE 6.3.6 — ENTERING is BOUNDED: shown only while pending + not authoritatively inGame + within the
      // timeout window since the click. A fired-but-never-entered click reverts to NOT_IN_GAME (never stuck).
      entering: opened && gameHeader.enteringActive({ pending: !!headerEntering[String(runId)], inGame, startedAt: headerEnterStartedAt[String(runId)] != null ? headerEnterStartedAt[String(runId)] : null, now: nowMs() }),
      joining: false,
      manualState: b.manualState || null,
      // §32/§34 — live search progress so the header shows "ĐANG TÌM BÀN… 12s · lần 6" instead of a label that
      // cannot be told apart from a hang, and offers HỦY.
      searchElapsedSec: b.searchElapsedSec || 0,
      // TEST D — recording state for THIS browser's ⋯ menu
      capturing: captureActiveFor(runId),
      lastCapture: lastCaptureByRun[String(runId)] || null,
      searchAttempt: b.searchAttempt || 0,
      rid: b.rid != null ? b.rid : null,
      joinedViaChannel: !!b.joinedViaChannel, // §stake-channel — label it KÊNH, never SS (see deriveHeaderState)
      lastRid: b.lastRid != null ? b.lastRid : null,
      // §co-seat — THIS browser's own room code (shown when it holds a table) + the shared code the followers use.
      // §room-key — a table the tool created shows its own key (the user may need it); otherwise the masked hpwd.
      roomCode: b.roomKey != null ? b.roomKey : (b.roomCode != null ? b.roomCode : null),
      sharedRoomCode,
      // PHASE 6.3.6 — FIND gating follows the USER's finder choice (selectedFinderIndex), NEVER browserIndex.
      // No finder chosen → every browser may FIND; a finder chosen → only that Player, others show WAIT_ANCHOR.
      isFinder: selectedFinderIndex == null ? true : (b.browserIndex === selectedFinderIndex),
      finderIndex: selectedFinderIndex, // drives the dynamic "CHỜ PLAYER N TÌM BÀN" label
      sharedRid,
      betOptions: Array.isArray(b.betOptions) ? b.betOptions : [],
      // The session stake (picked in the tool) — shown on the bar and used by its TẠO.
      stake: phomSessions && phomSessions.active() ? phomSessions.selectedStake() : null,
      // §group — role at the tool-created table + readiness + chủ bàn, for the bar's role chip. `seatedAtTable` says
      // whether this browser is REALLY sitting at that table right now (a role alone never implies a seat).
      groupRole: b.groupRole || null, ready: !!b.ready, isTableHost: !!b.isTableHost,
      seatedAtTable: b.manualState === 'JOINED' && b.rid != null,
      // Data freshness: frames were seen once but stopped (lost hook after a reload / target swap) → say it.
      dataStale: !!(opened && b.lastFrameAt != null && (nowMs() - Number(b.lastFrameAt)) > HEADER_STALE_MS),
      staleSec: b.lastFrameAt != null ? Math.round((nowMs() - Number(b.lastFrameAt)) / 1000) : null,
      error: headerError[String(runId)] || null,
      // §create — the SỐ BÀN list for the ⋯ menu: tables with a free seat, emptiest first. `roomListAt` (not an
      // age) so the pushed state stays byte-identical between frames and the push de-dup keeps working.
      ...headerRoomList(runId),
    };
  }
  // A browser whose game frames stopped arriving is reported as such after this long (and re-hooked, see
  // maybeRehookCapture) instead of silently reading "CHƯA VÀO GAME".
  const HEADER_STALE_MS = 20000;
  function headerRoomList(runId) {
    let l = null; try { l = phomSessions && phomSessions.active() ? phomSessions.roomList(runId) : null; } catch { l = null; }
    if (!l || !Array.isArray(l.rooms)) return { rooms: [], roomListAt: null };
    const rooms = l.rooms.filter((r) => !r.locked && Number(r.uC) < Number(r.Mu || 4))
      .sort((a, b) => (Number(a.uC) - Number(b.uC)) || (Number(a.b) - Number(b.b))).slice(0, 40);
    return { rooms, roomListAt: l.at };
  }

  // Recompute + push the header state into every open Chromium (best-effort). Called after every session
  // update and after every header action so the bars stay live without a Tool screen.
  // §co-seat — probe the game memory of any SEATED browser for the số bàn + key (debounced, ≤ once/30s per run),
  // so the reader runs even when the co-seat FIND (noStakeFallback) hasn't fired — the user just needs P3 at a table.
  const _lastProbeAt = Object.create(null);
  function maybeProbeSeated(browsers) {
    try { for (const b of (browsers || [])) { if (!b || b.manualState !== 'JOINED') continue; const k = String(b.profileId); const now = nowMs(); if (!_lastProbeAt[k] || now - _lastProbeAt[k] > 30000) { _lastProbeAt[k] = now; setTimeout(() => { probeGameRoom(k).catch(() => {}); }, 400); } } } catch { /* best effort */ }
  }
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
  function pushHeaderStates() {
    if (!phomSessions || !runManager) return;
    let browsers = []; try { browsers = phomSessions.manualBrowserSnapshot() || []; } catch { browsers = []; }
    maybeRehookCapture(browsers); // a browser whose frames stopped gets its hook re-installed (§data-stale)
    const sharedRid = headerSharedRid();
    const sharedRoomCode = maskSecret(phomSessions && phomSessions.active() && typeof phomSessions.sharedRoomCode === 'function' ? phomSessions.sharedRoomCode() : null);
    for (const run of runManager.list()) {
      if (run.status === RUN_STATUS.CLOSED) continue;
      const client = runClientFor(run.id);
      if (!client) continue;
      const view = headerViewFor(run.id, browsers, sharedRid, sharedRoomCode);
      const rid = String(run.id);
      if (view.inGame) {
        // Real authoritative evidence (socketReady+connected+channelList) — clear the ENTERING transient
        // and log the click→ENTERED latency once, then stop timing this run.
        delete headerEntering[rid]; clearHeaderEnterTimer(rid); // §10 — evidence arrived → cancel the bounded timeout
        if (headerEnterStartedAt[rid] != null) { headerLog('ENTER_GAME_EVIDENCE', { runId: rid, slotId: run.slot, elapsedMs: Math.round(nowMs() - headerEnterStartedAt[rid]) }); delete headerEnterStartedAt[rid]; }
      }
      // §5/§14 lag fix — the coordinator emits 'update' on EVERY observed WS frame; deriving is cheap but a
      // CDP Runtime.evaluate per frame per browser is an evaluate STORM that saturates the client the click
      // rides on. Skip the round-trip when this browser's derived state is byte-identical to the last push.
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
  let _handsTimer = null; let _handsPending = null;
  function scheduleHandsBroadcast(hands) {
    _handsPending = hands;
    if (_handsTimer) return;
    const h = _handsPending; _handsPending = null; if (h) send('phom:hands', h); // leading edge
    _handsTimer = setTimeout(() => { _handsTimer = null; if (_handsPending) { const t = _handsPending; _handsPending = null; send('phom:hands', t); } }, BROADCAST_MS);
  }
  // PHASE 6.3.3.2 — coalesce the per-frame card-observation snapshot the same way (leading + trailing).
  let _cardsTimer = null; let _cardsPending = null;
  function scheduleCardsBroadcast(cards) {
    _cardsPending = cards;
    if (_cardsTimer) return;
    const c = _cardsPending; _cardsPending = null; if (c) send('phom:cards', c); // leading edge
    _cardsTimer = setTimeout(() => { _cardsTimer = null; if (_cardsPending) { const t = _cardsPending; _cardsPending = null; send('phom:cards', t); } }, BROADCAST_MS);
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
  function onRunDocumentReplaced(runId, url) {
    const rid = String(runId);
    if (!url || /^about:/i.test(url)) return; // the proxy-auth launch page, not the game
    try { if (phomSessions && phomSessions.resetBrowser) phomSessions.resetBrowser(rid); } catch { /* best effort */ }
    delete headerError[rid]; headerDomPresent[rid] = false; delete headerLastPushed[rid];
    headerLog('DOCUMENT_REPLACED', { runId: rid });
    pushHeaderStates();
  }

  async function closeBrowserRun(runId) {
    const rid = String(runId == null ? '' : runId);
    if (!rid || !runManager) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no browser' } };
    try { await runManager.closeRun(rid); if (phomCluster && phomCluster.markRunClosed) phomCluster.markRunClosed(rid, 'USER_CLOSED_WINDOW'); return { ok: true }; }
    catch (e) { return { ok: false, error: { code: 'PHOM_CLOSE_FAILED', message: safeMsg(e) } }; }
  }

  // Route ONE header button click (from the in-page binding) to the coordinator's manual API. The action
  // set mirrors the old Tool controls exactly; stake comes from the page's bet picker (server options).
  async function phomHeaderAction(runId, payload) {
    const rid = String(runId == null ? '' : runId);
    const action = payload && payload.action;
    const actionId = (payload && payload.actionId) || null;
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
        headerEnterStartedAt[rid] = nowMs(); // T6 — start the click→ENTERED latency clock (§2/§17)
        headerEntering[rid] = true;
        armEnterTimeout(rid); // §10 — bounded ENTERING (INVOKED != ENTERED): reverts to NOT_IN_GAME if no evidence
        pushHeaderStates();
        headerLog('ENTER_GAME_START', { runId: rid, slotId: payload && payload.slotId, actionId, elapsedMs: 0 });
        res = await phomEnterGame(rid); // T8 — the in-engine tile click was fired (INVOKED != ENTERED)
        if (!res || res.ok === false) { delete headerEntering[rid]; delete headerEnterStartedAt[rid]; clearHeaderEnterTimer(rid); }
        headerLog(res && res.ok ? 'ENTER_GAME_ACTION_SENT' : 'ENTER_GAME_FAIL', { runId: rid, actionId, ok: !!(res && res.ok), elapsedMs: Math.round(nowMs() - (headerEnterStartedAt[rid] != null ? headerEnterStartedAt[rid] : nowMs())) });
      } else if (action === 'FIND' || action === 'FIND_EMPTY' || action === 'CHANGE_TABLE') {
        ensurePhomSessions();
        const selectedStake = payload && payload.stake != null ? Number(payload.stake) : null;
        // §co-seat (option A) — wait AGGRESSIVELY for the server's full 7-digit table list (broadcast rarely) so
        // the finder lands a REAL số bàn to share, polling CMD 300 often and holding off the stake-139 fallback.
        // §co-seat (option A) — POLL relentlessly (up to 300s), NEVER settle for kênh 139, and only accept a REAL
        // bàn chờ with **≥ 3 free seats** (need/minSeats = 3) so all three browsers can sit together. When such a
        // table appears in the list → its 7-digit số bàn → P1/P2 auto-join it (room for all).
        res = await phomSessions.findAndJoinGroup(rid, { selectedStake, emptyOnly: action === 'FIND_EMPTY', budgetMs: 300000, pollMs: 1500 });
      } else if (action === 'CREATE_TABLE' || action === 'CREATE_SOLO') {
        // T1 — TẠO BÀN at the stake chosen in the Phỏm tool (the bar has no picker; it never invents a stake).
        ensurePhomSessions();
        const stake = phomSessions.selectedStake();
        // T1 — this browser creates the keyed table (KEY); the others join with VÀO (first READY, then NOT_READY).
        res = await phomSessions.createTable(rid, { stake });
      } else if (action === 'CHANGE_KEY') {
        // ĐỔI KEY — the same group re-formed at a fresh table with a fresh key (the game has no key-change command).
        ensurePhomSessions();
        res = await phomSessions.changeKey();
      } else if (action === 'JOIN_CODE') {
        // §create — VÀO SỐ BÀN typed/picked in the header (no password is ever sent — §no-password).
        ensurePhomSessions();
        const joinRid = payload && payload.rid != null ? Number(payload.rid) : null;
        res = await phomSessions.joinTable(rid, joinRid);
      } else if (action === 'CAPTURE_START') {
        // TEST D from the header: record THIS browser (the one the player is about to click in by hand).
        const run = runManager && runManager.get(rid);
        res = { ok: true, ...frameRecorder.start({ runIds: [rid], label: 'Test D — ' + ((run && run.profileLabel) || rid) }) };
      } else if (action === 'CAPTURE_STOP') {
        res = stopAndSaveCapture();
        if (res && res.ok) { try { electronShell.showItemInFolder(res.txtPath); } catch { /* best effort */ } }
      } else if (action === 'CANCEL_FIND') {
        // §34 — stop the persistent search this browser is running. Runs alongside the pending FIND (exempt
        // from single-flight); the coordinator's generation bump is what actually resolves that FIND as stale.
        ensurePhomSessions();
        res = await phomSessions.cancelFind(rid);
      } else if (action === 'JOIN_SHARED') {
        ensurePhomSessions();
        // PHASE 6.3.5 — a FOLLOWER joins the anchor's shared RID with bounded same-RID retry + same-room proof.
        const joinRid = payload && payload.rid != null ? Number(payload.rid) : null;
        res = await phomSessions.joinTable(rid, joinRid);
      } else if (action === 'JOIN') {
        ensurePhomSessions();
        const joinRid = payload && payload.rid != null ? Number(payload.rid) : null;
        res = await phomSessions.manualJoinRoom(rid, joinRid, {});
      } else if (action === 'REJOIN') {
        ensurePhomSessions();
        res = await phomSessions.rejoinTable(rid);
      } else if (action === 'LEAVE') {
        ensurePhomSessions();
        res = await phomSessions.leaveTable(rid);
      } else if (action === 'RELOAD') {
        // PHASE 6.3.8 — the header's ⟳ button reuses the SAME reload logic as phom:reload-web (no new action).
        res = await reloadWebRun(rid);
      } else if (action === 'STOP') {
        // PHASE 6.3.8 — the header's ⏻ button reuses the SAME close logic as phom:close-browser.
        res = await closeBrowserRun(rid);
      } else if (action === 'FOCUS') {
        // PHASE 6.3.8 — bring this Chromium OS window to the front (reuses the existing focusBrowser).
        res = focusBrowser(rid) || { ok: true };
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

  // Count non-terminal BrowserRuns — the analyzer is refused whenever ANY exist.
  function liveRunCount() { try { return runManager ? runManager.list().filter((r) => r.status !== RUN_STATUS.CLOSED).length : 0; } catch { return 0; } }

  // The live-context snapshot fed to EVERY offline entry point (analyzer + simulator).
  // Rebuilt on each call so a browser/session/cluster that appears AFTER load still
  // refuses the offline engine (guard lives in the domain, not the UI — §7).
  function offlineContext(sourceKind) {
    return {
      sourceKind: sourceKind || 'TEST_FIXTURE',
      networkEnabled: false,
      liveRunCount: liveRunCount(),
      liveSessionId: (phomSessions && phomSessions.active()) ? 'ACTIVE' : null,
      clusterActive: !!(phomCluster && phomCluster.active()),
      endpoint: null,
    };
  }

  // The offline REALTIME simulator (event-by-event replay). One instance at a time;
  // it is PURE domain and cannot open a socket. Loaded via IPC, driven by transport
  // controls. The guard is re-checked inside the engine on every step.
  var offlineSim = null;
  function simResult(snapOrBlocked) { return snapOrBlocked; }
  function loadOfflineSimulator(input = {}) {
    const ds = input.datasetId ? sampleDatasets.getDataset(input.datasetId) : null;
    const events = ds ? ds.events : (Array.isArray(input.events) ? input.events : []);
    const sourceKind = ds ? ds.sourceKind : (input.sourceKind || 'TEST_FIXTURE');
    const owner = ds ? ds.simulatedOwnerUid : (input.simulatedOwnerUid != null ? input.simulatedOwnerUid : null);
    offlineSim = new PhomOfflineSimulator({ events, simulatedOwnerUid: owner, sourceKind, context: offlineContext(sourceKind) });
    if (!offlineSim.ok()) { const b = offlineSim.blockedResult(); offlineSim = null; return b; }
    return offlineSim.snapshot();
  }
  function controlOfflineSimulator(action, arg) {
    if (!offlineSim) return { ok: false, error: { code: 'PHOM_SIM_NOT_LOADED', message: 'No offline dataset is loaded.' } };
    // Re-check the live boundary before every transport action (§7).
    const blocked = offlineAnalyzer.assertOffline(offlineContext(offlineSim.snapshot().sourceKind));
    if (blocked) { offlineSim = null; return { ok: false, error: { code: 'PHOM_ANALYZER_OFFLINE_ONLY', message: 'A live browser/session/cluster is active — offline simulator refused.' } }; }
    switch (String(action)) {
      case 'next': return offlineSim.next();
      case 'previous': return offlineSim.previous();
      case 'step': return offlineSim.stepTo(Number(arg));
      case 'reset': return offlineSim.reset();
      case 'end': return offlineSim.end();
      case 'snapshot': return offlineSim.snapshot();
      default: return { ok: false, error: { code: 'PHOM_SIM_BAD_ACTION', message: `Unknown control: ${action}` } };
    }
  }

  // ---- QA RULE MONITOR · D MÔ PHỎNG (§19-§21) ----
  // The Screen-2 main monitor analyses a SIMULATED player D on FIXTURE/REPLAY data only
  // (never live hidden hands — §20). It reuses the SAME offline simulator engine + pure
  // findMelds (no second stack). Unlike the standalone simulator IPC, this fixture-display
  // instance is constructed with a CLEAN offline context: it is offline by construction
  // (it only ever consumes an allowed fixture/replay/simulator dataset and never touches a
  // live socket/CDP/hand), so it can coexist with the live cluster shown in the toolbar.
  var qaMonitorSim = null;
  function qaMonitorLoad(input = {}) {
    const ds = input.datasetId ? sampleDatasets.getDataset(input.datasetId) : null;
    const events = ds ? ds.events : (Array.isArray(input.events) ? input.events : []);
    const sourceKind = ds ? ds.sourceKind : (input.sourceKind || 'TEST_FIXTURE');
    const owner = ds ? ds.simulatedOwnerUid : (input.simulatedOwnerUid != null ? input.simulatedOwnerUid : null);
    // Clean offline context — fixture-only display path (§20/§21). No live flags.
    qaMonitorSim = new PhomOfflineSimulator({ events, simulatedOwnerUid: owner, sourceKind, context: { sourceKind, networkEnabled: false, liveRunCount: 0 } });
    if (!qaMonitorSim.ok()) { const b = qaMonitorSim.blockedResult(); qaMonitorSim = null; return b; }
    return qaMonitorSim.snapshot();
  }
  function qaMonitorControl(action, arg) {
    if (!qaMonitorSim) return qaMonitorLoad({ datasetId: 'basic-round' });
    switch (String(action)) {
      case 'next': return qaMonitorSim.next();
      case 'previous': return qaMonitorSim.previous();
      case 'step': return qaMonitorSim.stepTo(Number(arg));
      case 'reset': return qaMonitorSim.reset();
      case 'end': return qaMonitorSim.end();
      case 'snapshot': return qaMonitorSim.snapshot();
      default: return { ok: false, error: { code: 'PHOM_SIM_BAD_ACTION', message: `Unknown control: ${action}` } };
    }
  }

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
    // TEST D — record the raw frames (both directions) BEFORE routing, so a player's own click is captured even
    // when no session has been started. Passive and cheap when idle; never allowed to break capture.
    try { if (frameRecorder.isRecording()) frameRecorder.record(run.id, { raw: req.body && req.body.raw, direction: req.wsDirection, url: req.url, label: run.profileLabel || null }); } catch { /* never break capture */ }
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
      // Apply this run's mobile device emulation (viewport/screen/DSF/mobile/touch/UA)
      // on the run's OWN client, and reapply on navigation / new targets.
      if (run.deviceProfile) applyDeviceEmulation(client, run.deviceProfile, run).catch(() => {});
      // Ensure the WS send-hook is present before the game opens its socket.
      wsReplay.injectSession(client, undefined).catch(() => {});
      // Inject the tool-owned in-page GAME HEADER (VÀO GAME / TÌM BÀN / VÀO BÀN / REJOIN / THOÁT PHÒNG)
      // and route its clicks to the coordinator. The boot carries this run's IDENTITY (slot/profile/run)
      // so every action is self-labelled. Best-effort; a CDP hiccup never blocks attach. On a re-attach
      // (transient CDP drop → poll re-adds the target with a NEW client) this runs again → header + binding
      // are reinstalled and the state re-pushed (§11 reattach). (§6.3.2 / §6.3.2.2)
      headerLog('cdp-attach', { runId: run.id, slotId: run.slot, targetId: target.cdpTargetId });
      const boot = gameHeader.bootScript({ slotId: run.slot || null, profileId: run.profileId || null, runId: run.id, observerLog: process.env.PHOM_HEADER_OBSERVER_LOG === '1', clickLog: process.env.PHOM_CLICK_LOG === '1' || process.env.PHOM_HEADER_LOG === '1' });
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
          onAuthFailure: (code) => send('phom:proxy-auth', { runId: run.id, code }),
        }).then((detach) => {
          run._detachProxyAuth = detach;
          // §52 — the proxy challenge is now answered by the tool, so the page may finally leave about:blank.
          // Only the PAGE target navigates, and only once (a re-attach must never reload the game).
          const pending = run._pendingNavigateUrl;
          if (pending && (!target.type || target.type === 'PAGE')) {
            run._pendingNavigateUrl = null;
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
  async function openProfile({ slot, profileKey, url, proxyRef, proxyRequired, label, username, device: deviceArg, profileId }) {
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
    // PHASE-6.3.1 — a flexible selected profile passes its FULL device explicitly; otherwise fall back to
    // the legacy per-slot device. The persistent user-data-dir is keyed by the profile identity so each
    // profile keeps its own Chromium data + reopens the SAME identity.
    const device = deviceArg || profileStore.deviceFor(pk);
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
    // by launch/PID order). Sizes each window to the profile's MOBILE-LANDSCAPE viewport + chrome (device
    // metrics still applied over CDP — only the native window bounds change). Reads the live display
    // topology so the three windows are visible simultaneously across monitors. Falls back to the Phase-3
    // single-slot spread, then to the legacy quadrant (localTest / no device).
    // PHASE-6.2 — a DESKTOP Chromium window (title bar / min-max-close / resizable), sized to fill its
    // monitor region (NOT forced to a mobile size); the game viewport stays mobile-landscape via CDP.
    const slotIndex = { A: 1, B: 2, C: 3 }[slot] || 1;
    let windowRect;
    if (device) {
      // §7/§8 — pass BOTH osWindow* and viewport* to the geometry layer so an
      // explicit desktop OS window size (e.g. 960×540) is honored independently of
      // the emulated viewport (which stays a CDP concern).
      const geoDevice = { osWindowWidth: device.osWindowWidth, osWindowHeight: device.osWindowHeight, viewportWidth: device.viewportWidth, viewportHeight: device.viewportHeight };
      try {
        const arr = clusterFourWindowArrangement();
        windowRect = (arr && arr.slots && arr.slots[slotIndex]) || desktopWindowRectForSlot(currentWorkArea(), slot, geoDevice);
      } catch { windowRect = desktopWindowRectForSlot(currentWorkArea(), slot, geoDevice); }
    } else { windowRect = gridRectForSlot(slot); }
    const run = runManager.createRun({ launchUrl: String(url || ''), proxy: gate.runProxy, windowRect, mobileTouch: !!(device && device.touch), profileDir, sandboxDisabled: sandbox.sandboxDisabled });
    run.profileLabel = label || saved.name || `Profile ${slot}`;
    run.slot = slot;
    run.profileId = udKey; // PHASE-6.3.1 — runtime browserRunId → profileId mapping (active-guard + reopen)
    run.deviceProfile = device || null; // reapplied on every attach/navigation
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
    ipcMain.handle('phom:capabilities', () => ({ featureEnabled: process.env.PHOM_QA_ENABLED === '1', authorized: phomAuthorizedEnv(), licensed: licenseActive(), devBypass: devBypass.allowed === true, licenseMode: devBypass.allowed ? 'DEVELOPMENT_BYPASS' : 'LICENSED', proxySecret: (ensureStores(), proxySecretStore.capability()), chromiumSandbox: { mode: lastSandboxPolicy.mode, disabled: !!lastSandboxPolicy.sandboxDisabled, banner: lastSandboxPolicy.banner || null } }));

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
    // §3/§4 — expose the FULL catalog (mobile + desktop + laptop + laptop-small +
    // laptop-small + mobile-landscape). The UI groups them by profileType.
    ipcMain.handle('phom:device-presets', () => ({ ok: true, presets: deviceProfile.listProfilePresets() }));
    ipcMain.handle('phom:profile-list', guarded(() => { ensureStores(); return { ok: true, profiles: profileStore.list() }; }));
    ipcMain.handle('phom:profile-upsert', guarded((_e, slot, input) => { ensureStores(); return profileStore.upsert(String(slot), input || {}); }));
    ipcMain.handle('phom:profile-delete', guarded((_e, slot) => { ensureStores(); return profileStore.remove(String(slot)); }));
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
    ipcMain.handle('phom:proxy-test', guarded(async (_e, id) => {
      ensureStores();
      const cfg = proxyConfigStore.get(String(id));
      if (!cfg) return { ok: false, error: { code: 'PROXY_CONFIG_NOT_FOUND', message: 'No such proxy' } };
      const { toRunProxy } = require('./browser-run/proxy-config.cjs');
      const res = await proxyTester.test(toRunProxy(cfg), { resolveAuth: () => ({ username: cfg.username, password: proxyConfigStore.resolvePassword(cfg.id) }) });
      return { ok: res.state === 'PASS', result: res };
    }));
    // §4–§7 — atomic quick-3-proxy apply (parse + create + bind + cluster update).
    ipcMain.handle('phom:proxy-quick-apply', guarded((_e, payload) => quickProxyApply(payload || {})));
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
    ipcMain.handle('phom:start-session', guarded((_e, cfg) => { ensurePhomSessions(); const r = phomSessions.startSession({ runIds: (cfg && cfg.runIds) || [], hostId: cfg && cfg.hostId, selectedStake: cfg && cfg.selectedStake }); applyFinderToCoordinator(); return r; }));
    ipcMain.handle('phom:set-host', guarded((_e, hostId) => ensurePhomSessions().setHost(hostId)));
    ipcMain.handle('phom:select-stake', guarded((_e, stake) => ensurePhomSessions().selectStake(stake)));
    // §13 — Find-Table stake source: request the server channel list + read the
    // AUTHORITATIVE distinct stakes it reports (never a hard-coded fallback).
    // §35 — optionally scoped to ONE browser; seated browsers are always skipped (coordinator).
    ipcMain.handle('phom:request-channels', guarded(async (_e, cfg) => { ensurePhomSessions(); return phomSessions.requestChannels({ profileId: cfg && cfg.browserId != null ? cfg.browserId : null }); }));
    ipcMain.handle('phom:stake-channels', guarded(() => { ensurePhomSessions(); return { ok: true, stakes: phomSessions.availableStakes(), sessionActive: !!(phomSessions && phomSessions.active()) }; }));
    ipcMain.handle('phom:acquire-host', guarded(() => ensurePhomSessions().acquireHost()));
    // §18/§22 — host-first find-again discovery loop (single orchestrator; validates from ps[]).
    ipcMain.handle('phom:discover', guarded(() => ensurePhomSessions().runDiscovery()));
    ipcMain.handle('phom:join-followers', guarded(() => ensurePhomSessions().joinFollowers()));
    ipcMain.handle('phom:apply-ready', guarded(() => ensurePhomSessions().applyReady()));
    ipcMain.handle('phom:rejoin-follower', guarded((_e, id) => ensurePhomSessions().rejoinFollower(id)));
    ipcMain.handle('phom:recover-host', guarded(() => ensurePhomSessions().recoverHost()));
    ipcMain.handle('phom:leave-all', guarded(() => { ensurePhomSessions(); return phomSessions.leaveAllTables(); }));
    ipcMain.handle('phom:stop', guarded(() => { ensurePhomSessions().stop(); return { ok: true }; }));
    // PHASE 6.3.6 — USER selects which Player is the FINDER (room anchor). index null clears (every browser may
    // FIND); 1/2/3 selects. It re-derives + re-pushes every in-Chromium header immediately, and syncs the choice
    // to the coordinator (same-room proof anchor). It NEVER discovers/joins here — only ownership of the finder.
    ipcMain.handle('phom:set-finder', (_e, index) => {
      const idx = index == null ? null : Number(index);
      selectedFinderIndex = (idx === 1 || idx === 2 || idx === 3) ? idx : null;
      applyFinderToCoordinator(); // sync same-room-proof anchor (header derivation uses selectedFinderIndex directly)
      pushHeaderStates();
      return { ok: true, finderIndex: selectedFinderIndex };
    });
    ipcMain.handle('phom:get-finder', () => ({ ok: true, finderIndex: selectedFinderIndex }));
    ipcMain.handle('phom:session-state', () => (phomSessions ? phomSessions.snapshot() : null));
    ipcMain.handle('phom:verify-table', () => (phomSessions ? phomSessions.verifySameTable() : { result: 'IDLE' }));
    // PHASE-2 — read the monotonic discovery/sync milestone timeline (telemetry for latency inspection).
    ipcMain.handle('phom:trace', () => ({ ok: true, trace: phomSessions ? phomSessions.trace() : [] }));
    // TEST D — record the game client's own frames while the player acts by hand (e.g. clicks a table), then
    // write them to a file (secrets redacted) so the real protocol can be read instead of guessed.
    ipcMain.handle('phom:frames-record-start', (_e, cfg) => {
      const runIds = cfg && Array.isArray(cfg.runIds) ? cfg.runIds.filter((x) => x != null).map(String) : null;
      return { ok: true, ...frameRecorder.start({ runIds, label: cfg && cfg.label != null ? String(cfg.label) : null, keepRoomCodes: false }) };
    });
    // §ws-inspect — export ALL captured WebSocket request/response to a readable .txt and reveal it.
    ipcMain.handle('phom:export-ws-log', () => exportWsLog());
    ipcMain.handle('phom:frames-record-status', () => ({ ok: true, ...frameRecorder.status() }));
    ipcMain.handle('phom:frames-record-stop', () => stopAndSaveCapture());
    ipcMain.handle('phom:frames-open-folder', (_e, p) => { try { if (p) electronShell.showItemInFolder(String(p)); return { ok: true }; } catch (e) { return { ok: false, error: { code: 'OPEN_FAILED', message: String(e && e.message || e) } }; } });
    // PHASE-3 · PART B — observe-only native-JOIN experiment (A→B→C, same stake, no room forcing).
    // Authorized+licensed only; observes server matchmaking from ps[], never changes production flow.
    ipcMain.handle('phom:join-experiment', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.runJoinExperiment(cfg && cfg.channel, cfg && cfg.opts); }));
    // PHASE-4 — HOST ROOM ANCHOR test (A→room→B/C). Authorized+licensed; observe-only, does not touch
    // the production discovery flow. A native-joins, is confirmed in ps[], its room is bound, then B/C
    // join THAT exact room id and are confirmed co-seated.
    ipcMain.handle('phom:host-anchored-join', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.runHostAnchoredJoin(cfg && cfg.channel, cfg && cfg.opts); }));
    // PHASE-6 — MANUAL per-browser table control (browserId === browserRunId). Each command targets ONE
    // browser; there is no host/follower role. Confirmation is authoritative (own ps[]). Observe-only wire.
    ipcMain.handle('phom:manual-find', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.manualFindTable(cfg && cfg.browserId, cfg && cfg.channel, cfg && cfg.opts); }));
    // PHASE-6.2.1 — REAL discovery: qualifying empty table (rid + stake from the server table) → JOIN → ps[].
    ipcMain.handle('phom:manual-discover', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.manualDiscoverTable(cfg && cfg.browserId, cfg && cfg.opts); }));
    ipcMain.handle('phom:find-group', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.findAndJoinGroup(cfg && cfg.browserId, cfg && cfg.opts); }));
    // §create — TẠO BÀN (cmd 308): opts.gather=false creates on this browser only; default brings the others too.
    ipcMain.handle('phom:create-table', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.createTable(cfg && cfg.browserId, (cfg && cfg.opts) || {}); }));
    // §auto — the Phỏm tool's TỰ ĐỘNG checkbox. ON forms the group (creator = browserId, KEY; the others READY /
    // NOT_READY) unless one exists, then rejoins kicked members and re-creates a lost table. OFF stops all of it.
    ipcMain.handle('phom:auto-set', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.setAuto(!!(cfg && cfg.on), { creatorId: cfg && cfg.browserId, stake: cfg && cfg.stake != null ? Number(cfg.stake) : null }); }));
    // THE mức cược lives in the Phỏm tool; the in-page bars create at this stake (they have no picker of their own).
    ipcMain.handle('phom:set-stake', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.setStake(cfg && cfg.stake); }));
    ipcMain.handle('phom:group-snapshot', guarded(() => { ensurePhomSessions(); return { ok: true, group: phomSessions.groupSnapshot() }; }));
    ipcMain.handle('phom:change-key', guarded(() => { ensurePhomSessions(); return phomSessions.changeKey(); }));
    ipcMain.handle('phom:room-list', guarded((_e, cfg) => { ensurePhomSessions(); return { ok: true, ...phomSessions.roomList(cfg && cfg.browserId) }; }));
    ipcMain.handle('phom:token-keys', guarded(async () => {
      try { return { ok: true, ...await tokenKeyStore.snapshot() }; }
      catch { return { ok: false, error: { code: 'TOKEN_STORE_UNAVAILABLE', message: 'Không đọc được kho key đã mã hóa' } }; }
    }));
    ipcMain.handle('phom:token-import', guarded(async () => {
      const picked = await dialog.showOpenDialog({ title: 'Import Token Key', properties: ['openFile'], filters: [{ name: 'Danh sách key', extensions: ['txt', 'json'] }] });
      if (picked.canceled || !picked.filePaths[0]) return { ok: true, cancelled: true };
      try {
        const file = picked.filePaths[0];
        if ((await fs.promises.stat(file)).size > 1024 * 1024) throw new Error('TOO_LARGE');
        const text = (await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
        const values = text.trimStart().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/);
        if (!Array.isArray(values) || values.length > 10000 || values.some((v) => typeof v !== 'string' || v.length > 4096)) throw new Error('INVALID_KEYS');
        return { ok: true, ...await tokenKeyStore.import(values) };
      } catch { return { ok: false, error: { code: 'TOKEN_IMPORT_FAILED', message: 'Không import được key. Dùng file TXT mỗi dòng một key hoặc JSON gồm danh sách chuỗi, tối đa 1 MB.' } }; }
    }));
    ipcMain.handle('phom:token-enabled', guarded(async (_e, cfg) => {
      if (typeof cfg?.id !== 'string' || typeof cfg?.enabled !== 'boolean') return { ok: false, error: { code: 'INVALID_TOKEN_CONFIG' } };
      try { return { ok: true, ...await tokenKeyStore.setEnabled(cfg.id, cfg.enabled) }; }
      catch { return { ok: false, error: { code: 'TOKEN_UPDATE_FAILED', message: 'Không lưu được trạng thái key' } }; }
    }));
    ipcMain.handle('phom:manual-join', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.manualJoinRoom(cfg && cfg.browserId, cfg && cfg.rid, cfg && cfg.opts); }));
    // §co-seat — join a số bàn + key with retry through "sai mật khẩu phòng" (key defaults to the host token).
    ipcMain.handle('phom:manual-join-code', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.joinTable(cfg && cfg.browserId, cfg && cfg.rid); }));
    // §38 — the Tool window joins the shared room with the SAME semantics as the header's VÀO BÀN (bounded retry +
    // same-room proof), and can cancel a persistent search just like the header's HỦY.
    ipcMain.handle('phom:manual-join-shared', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.joinTable(cfg && cfg.browserId, cfg && cfg.rid); }));
    ipcMain.handle('phom:manual-cancel-find', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.cancelFind(cfg && cfg.browserId); }));
    ipcMain.handle('phom:manual-rejoin', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.rejoinTable(cfg && cfg.browserId); }));
    ipcMain.handle('phom:manual-leave', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.leaveTable(cfg && cfg.browserId); }));
    ipcMain.handle('phom:manual-snapshot', () => {
      const browsers = phomSessions ? phomSessions.manualBrowserSnapshot() : [];
      // PHASE 6.3.2.2 — merge the READ-ONLY runtime/CDP/header status per browser for Screen 2 (no actions).
      for (const b of browsers) { if (b && b.profileId != null) Object.assign(b, browserRuntimeStatus(b.profileId)); }
      // §38 — the SAME shared room the in-Chromium header publishes (single source), so the Tool never derives its own.
      const active = !!(phomSessions && phomSessions.active());
      // §co-seat — the cluster verdict (all browsers proven in the SAME ps[]), so the Tool can state "ĐỦ 3
      // BROWSER CÙNG BÀN" from server evidence instead of three independent JOINED flags.
      return { ok: true, browsers, sharedRid: active ? phomSessions.sharedRid() : null, sharedRidOwner: active ? phomSessions.sharedRidOwner() : null,
        sharedRidIsChannel: active ? phomSessions.sharedRidIsChannel() : false,
        coSeat: active ? phomSessions.coSeatStatus() : null,
        // §group — the tool-created table: số bàn, key, stake, keep flag and each member's role/ready/host state.
        group: active ? phomSessions.groupSnapshot() : null };
    });
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
    // Screen 2 — cards REMAINING after removing all cards held by the 3 browsers (never "player 4").
    ipcMain.handle('phom:remaining-cards', () => (phomSessions ? { ok: true, ...phomSessions.remainingCards() } : { ok: true, count: 0, codes: [], cards: [] }));
    // PHASE 6.3.3.2 — the full card-observation snapshot (players/discards/melds/remaining/capabilities).
    // Empty/unknown shape when no session is active — never fabricated.
    ipcMain.handle('phom:cards', () => (phomSessions ? { ok: true, ...phomSessions.cardObserverSnapshot() } : { ok: true, players: {}, remaining: { count: 0, codes: [], cards: [] }, discardPile: [], capabilities: {} }));
    // PHASE 6.3.3.3 — MONITOR / SAFE CARD ANALYZER (read-only). Runs the DETERMINISTIC analyzer over the
    // CURRENT observer snapshot for ONE selected target uid (the renderer owns the selection). It never
    // sends a game command / clicks / plays — it only classifies the target's cards for display.
    ipcMain.handle('phom:analyze-safe-cards', (_e, targetPlayerUid) => {
      const snapshot = phomSessions ? phomSessions.cardObserverSnapshot() : null;
      return { ok: true, ...safeCardAnalyzer.analyze({ snapshot, targetPlayerUid }) };
    });
    // PhomClusterCdpManager — control-plane over the three independent CDP clients.
    ipcMain.handle('phom:cluster-create', guarded((_e, config) => {
      ensureStores();
      const c = config && typeof config === 'object' ? config : {};
      clusterLocalTest = !!(c.localTest && devBypass.allowed);
      // §3 — authoritative projection from the SAVED profile. Loose renderer fields
      // (hostSlot/selectedStake/proxyRefs/device) are IGNORED; only clusterProfileId +
      // localTest are honored. A non-ready/missing profile returns a typed error and no
      // browser is opened.
      const resolved = resolveClusterRuntime(c);
      if (!resolved.ok) return resolved;
      const res = ensureCluster().createCluster({
        clusterProfileId: resolved.id,
        hostSlot: resolved.hostSlot,
        selectedStake: resolved.selectedStake,
        gameUrl: resolved.gameUrl,
        profiles: resolved.profiles,
      });
      if (res && res.ok) activeClusterProfileId = resolved.id;
      return res && res.ok ? { ...res, localTest: localTestActive(), clusterProfileId: resolved.id, gameUrl: resolved.gameUrl } : res;
    }));
    ipcMain.handle('phom:cluster-open', guarded(() => ensureCluster().openCluster()));
    ipcMain.handle('phom:cluster-connect', guarded(() => ensureCluster().connectClusterCdp()));
    ipcMain.handle('phom:cluster-apply-devices', guarded(() => ensureCluster().applyClusterDevices()));
    ipcMain.handle('phom:cluster-test-proxies', guarded(() => ensureCluster().testClusterProxies()));
    ipcMain.handle('phom:cluster-acquire-host', guarded(() => ensureCluster().acquireHostTable()));
    ipcMain.handle('phom:cluster-join-followers', guarded(() => ensureCluster().joinFollowers()));
    ipcMain.handle('phom:cluster-apply-ready', guarded(() => ensureCluster().applyReadyPolicy()));
    ipcMain.handle('phom:cluster-leave', guarded(async () => { const r = await ensureCluster().leaveCluster(); return r; }));
    // DỪNG = orchestration-only stop: cancels find-table/join/ready/rejoin automation and
    // subscriptions but NEVER closes the browsers (browser lifetime is independent). The
    // cluster stays open + activeClusterProfileId is preserved.
    ipcMain.handle('phom:orchestration-stop', guarded(() => { lifecycleLog('IPC_ORCHESTRATION_STOP', {}); return phomCluster ? phomCluster.stopOrchestration() : { ok: true, orchestrationStopped: true, browsersClosed: false }; }));
    // ĐÓNG 3 TRÌNH DUYỆT = EXPLICIT browser close (the ONLY app path that closes the runs).
    ipcMain.handle('phom:cluster-stop', guarded(async () => { lifecycleLog('IPC_CLUSTER_STOP', {}); const r = await ensureCluster().stopCluster(); activeClusterProfileId = null; return r; }));
    ipcMain.handle('phom:cluster-snapshot', () => (phomCluster ? phomCluster.getClusterSnapshot() : null));

    // Cluster PROFILE persistence (saved configs: shared game URL + 3 browser/device/
    // proxy slots). Metadata/references only — no secret, no live runtime state ever
    // crosses this seam, and the renderer can never set a runtime field (the model
    // whitelists its fields). Payloads are coerced; no filesystem path is accepted.
    ipcMain.handle('phom:cluster-profile-list', guarded(() => { ensureStores(); return { ok: true, profiles: clusterProfileStore.list(), selectedId: clusterProfileStore.selectedId() }; }));
    ipcMain.handle('phom:cluster-profile-get', guarded((_e, id) => { ensureStores(); const p = clusterProfileStore.getPublic(String(id == null ? '' : id)); return p ? { ok: true, profile: p } : { ok: false, error: { code: 'PHOM_CLUSTER_PROFILE_NOT_FOUND', message: `No cluster profile: ${id}` } }; }));
    ipcMain.handle('phom:cluster-profile-create', guarded((_e, input) => { ensureStores(); return clusterProfileStore.create(input && typeof input === 'object' ? input : {}); }));
    ipcMain.handle('phom:cluster-profile-update', guarded((_e, id, patch) => { ensureStores(); return clusterProfileStore.update(String(id == null ? '' : id), patch && typeof patch === 'object' ? patch : {}); }));
    ipcMain.handle('phom:cluster-profile-delete', guarded((_e, id) => { ensureStores(); return clusterProfileStore.delete(String(id == null ? '' : id)); }));
    ipcMain.handle('phom:cluster-profile-duplicate', guarded((_e, id, newName) => { ensureStores(); return clusterProfileStore.duplicate(String(id == null ? '' : id), String(newName == null ? '' : newName)); }));
    ipcMain.handle('phom:cluster-profile-select', guarded((_e, id) => { ensureStores(); if (id == null || String(id) === '') return clusterProfileStore.clearSelection(); return clusterProfileStore.select(String(id)); }));
    ipcMain.handle('phom:cluster-profile-validate', guarded((_e, id) => { ensureStores(); return clusterProfileStore.validateReady(String(id == null ? '' : id)); }));
    // 2×2 workspace layout controls (§9/§21).
    ipcMain.handle('phom:restore-layout', guarded(() => restoreLayout()));
    ipcMain.handle('phom:focus-browser', guarded((_e, runId) => focusBrowser(runId)));
    // VÀO GAME PHỎM — trigger the verified `vgcg_8` entry action via the site's own Cocos node.
    ipcMain.handle('phom:enter-game', guarded((_e, runId) => phomEnterGame(String(runId == null ? '' : runId))));

    // Offline rule analyzer (§16/§23). The domain enforces the boundary again, but we
    // also refuse at the IPC edge whenever ANY live BrowserRun / session exists.
    ipcMain.handle('phom:analyzer-status', () => ({ available: liveRunCount() === 0 && !(phomSessions && phomSessions.active()), liveRunCount: liveRunCount() }));
    ipcMain.handle('phom:analyzer-analyze', (_e, input = {}) => runOfflineAnalyzer(input || {}));

    // Offline REALTIME simulator (§7-§11). Event-by-event replay of a redacted /
    // fixture / local dataset. Same hard offline boundary as the analyzer.
    ipcMain.handle('phom:sim-datasets', () => ({ ok: true, datasets: sampleDatasets.listDatasets(), available: liveRunCount() === 0 && !(phomSessions && phomSessions.active()) && !(phomCluster && phomCluster.active()) }));
    ipcMain.handle('phom:sim-load', (_e, input = {}) => loadOfflineSimulator(input || {}));
    ipcMain.handle('phom:sim-control', (_e, action, arg) => controlOfflineSimulator(action, arg));
    // QA RULE MONITOR (D simulated, fixture/replay only) — §19-§21.
    ipcMain.handle('phom:qa-monitor-datasets', () => ({ ok: true, datasets: sampleDatasets.listDatasets() }));
    ipcMain.handle('phom:qa-monitor-load', (_e, input = {}) => qaMonitorLoad(input || {}));
    ipcMain.handle('phom:qa-monitor-control', (_e, action, arg) => qaMonitorControl(action, arg));
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
