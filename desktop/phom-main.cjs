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
const { lifecycleLog } = require('./browser/chrome-launcher.cjs');
const phomChromium = require('./browser/phom-chromium-runtime.cjs');
const { resolveSandboxPolicy, DIAGNOSTIC_ENV } = require('./browser/chromium-sandbox-policy.cjs');
const { BrowserRunManager, STATUS: RUN_STATUS } = require('./browser-run/browser-run-manager.cjs');
const { CaptureCorrelator } = require('./cdp/capture.cjs');
const { WsReplay } = require('./cdp/ws-replay.cjs');
const { HostSessionManager } = require('./protocol/phom/host-session-manager.cjs');
const { PhomClusterCdpManager } = require('./protocol/phom/phom-cluster-cdp-manager.cjs');
const { projectRuntimeToManagerConfig } = require('./protocol/phom/cluster-runtime-projection.cjs');
const { parseQuickProxies, parseQuickProxyRows } = require('./browser-run/phom-quick-proxy.cjs');
const { applyQuickProxies } = require('./protocol/phom/quick-proxy-apply.cjs');
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
  // Records which saved cluster profile id (if any) backs the live ClusterSession, so
  // the store can block deleting a profile that is in use. Set on a profile-driven
  // create, cleared on stop/leave. This is provenance only — it never alters the Host
  // coordinator runtime (that integration is a later phase).
  var activeClusterProfileId = null;
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
    phomSessions.on('update', (snap) => { send('phom:session', snap); pushHeaderStates(); });
    phomSessions.on('hands', (hands) => send('phom:hands', hands));
    phomSessions.on('kick', (k) => send('phom:kick', k));
    phomSessions.on('log', (l) => { try { if (process.env.PHOM_LIFECYCLE_LOG === '1') console.log(`[${l.tag}] ${l.event}`, JSON.stringify(l)); } catch {} send('phom:log', l); });
    return phomSessions;
  }

  function phomAuthorizedEnv() {
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
    const url = localTestActive() ? 'about:blank' : (gameUrl != null ? String(gameUrl).trim() : '');
    if (!localTestActive() && !url) return { ok: false, error: { code: 'PHOM_GAME_URL_REQUIRED', message: 'Nhập Game URL trước khi mở.' } };
    const profiles = [];
    for (let i = 0; i < 3; i++) {
      const p = deviceProfilesStore.get(ids[i]);
      if (!p) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `Hồ sơ ${ids[i]} không tồn tại.` } };
      if (!p.device) return { ok: false, error: { code: 'PHOM_PROFILE_NO_DEVICE', message: `Hồ sơ "${p.name}" chưa có thiết bị.` } };
      // slot A/B/C = the runtime B1/B2/B3 window; browserProfileId carries the flexible profile id.
      profiles.push({ slot: SLOTS_ABC[i], browserProfileId: p.id, profileId: p.id, device: p.device, proxyRef: p.proxyRef || null, gameUrl: url, label: p.name });
    }
    const res = ensureCluster().createCluster({ clusterProfileId: null, hostSlot: 'A', selectedStake: null, gameUrl: url, profiles });
    if (res && res.ok === false) return res;
    activeClusterProfileId = null;
    return res && res.ok ? { ...res, localTest: localTestActive(), gameUrl: url, mapping: ids.map((id, i) => ({ browser: 'B' + (i + 1), profileId: id })) } : res;
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

  // The cluster's shared RID = the RID of the first browser already JOINED to a table. Other in-game
  // browsers then show VÀO BÀN (JOIN_SHARED) for that RID — no independent re-discovery (§ shared RID).
  function headerSharedRid(browsers) {
    const j = (browsers || []).find((b) => b && b.manualState === 'JOINED' && b.rid != null);
    return j ? Number(j.rid) : null;
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
      account, opened, inGame,
      entering: opened && !inGame && !!headerEntering[String(runId)],
      joining: false,
      manualState: b.manualState || null,
      rid: b.rid != null ? b.rid : null,
      lastRid: b.lastRid != null ? b.lastRid : null,
      sharedRid,
      betOptions: Array.isArray(b.betOptions) ? b.betOptions : [],
      error: headerError[String(runId)] || null,
    };
  }

  // Recompute + push the header state into every open Chromium (best-effort). Called after every session
  // update and after every header action so the bars stay live without a Tool screen.
  function pushHeaderStates() {
    if (!phomSessions || !runManager) return;
    let browsers = []; try { browsers = phomSessions.manualBrowserSnapshot() || []; } catch { browsers = []; }
    const sharedRid = headerSharedRid(browsers);
    for (const run of runManager.list()) {
      if (run.status === RUN_STATUS.CLOSED) continue;
      const client = runClientFor(run.id);
      if (!client) continue;
      const view = headerViewFor(run.id, browsers, sharedRid);
      if (view.inGame) delete headerEntering[String(run.id)]; // real evidence clears the transient
      headerBridge.pushHeaderState(client, gameHeader.deriveHeaderState(view));
    }
  }

  // Route ONE header button click (from the in-page binding) to the coordinator's manual API. The action
  // set mirrors the old Tool controls exactly; stake comes from the page's bet picker (server options).
  async function phomHeaderAction(runId, payload) {
    const rid = String(runId == null ? '' : runId);
    const action = payload && payload.action;
    delete headerError[rid];
    let res = { ok: true };
    try {
      if (action === 'ENTER_GAME') {
        headerEntering[rid] = true; pushHeaderStates();
        res = await phomEnterGame(rid);
        if (!res || res.ok === false) delete headerEntering[rid];
      } else if (action === 'FIND') {
        ensurePhomSessions();
        const selectedStake = payload && payload.stake != null ? Number(payload.stake) : null;
        res = await phomSessions.manualDiscoverTable(rid, { selectedStake });
      } else if (action === 'JOIN_SHARED' || action === 'JOIN') {
        ensurePhomSessions();
        const joinRid = payload && payload.rid != null ? Number(payload.rid) : null;
        res = await phomSessions.manualJoinRoom(rid, joinRid, {});
      } else if (action === 'REJOIN') {
        ensurePhomSessions();
        res = await phomSessions.manualRejoin(rid, {});
      } else if (action === 'LEAVE') {
        ensurePhomSessions();
        res = await phomSessions.manualLeave(rid);
      } else {
        res = { ok: false, error: { code: 'PHOM_HEADER_UNKNOWN_ACTION', message: `unknown action ${action}` } };
      }
    } catch (e) { res = { ok: false, error: { code: 'PHOM_HEADER_ACTION_FAILED', message: safeMsg(e) } }; }
    if (res && res.ok === false) headerError[rid] = (res.error && (res.error.message || res.error.code)) || 'LỖI';
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
      // and route its clicks to the coordinator. Best-effort; a CDP hiccup never blocks attach (§6.3.2).
      headerBridge.installHeader(client, { runId: run.id, boot: gameHeader.bootScript(), onAction: (rid, payload) => phomHeaderAction(rid, payload) })
        .then(() => pushHeaderStates()).catch(() => {});
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
    // §6 — the pinned custom Chromium runtime must validate; never fall back to system Chrome.
    const rt = chromiumRuntime();
    if (!rt.ok) return rt;
    ensureRunManager(); ensurePhomSessions(); ensureStores();
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
    if (!sandbox.sandboxDisabled) {
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
    run.proxyUsername = username || (gate.config && gate.config.username) || null;
    const launched = await run.launcher.open(String(url || ''));
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
    ipcMain.handle('phom:start-session', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.startSession({ runIds: (cfg && cfg.runIds) || [], hostId: cfg && cfg.hostId, selectedStake: cfg && cfg.selectedStake }); }));
    ipcMain.handle('phom:set-host', guarded((_e, hostId) => ensurePhomSessions().setHost(hostId)));
    ipcMain.handle('phom:select-stake', guarded((_e, stake) => ensurePhomSessions().selectStake(stake)));
    // §13 — Find-Table stake source: request the server channel list + read the
    // AUTHORITATIVE distinct stakes it reports (never a hard-coded fallback).
    ipcMain.handle('phom:request-channels', guarded(async () => { ensurePhomSessions(); return phomSessions.requestChannels(); }));
    ipcMain.handle('phom:stake-channels', guarded(() => { ensurePhomSessions(); return { ok: true, stakes: phomSessions.availableStakes(), sessionActive: !!(phomSessions && phomSessions.active()) }; }));
    ipcMain.handle('phom:acquire-host', guarded(() => ensurePhomSessions().acquireHost()));
    // §18/§22 — host-first find-again discovery loop (single orchestrator; validates from ps[]).
    ipcMain.handle('phom:discover', guarded(() => ensurePhomSessions().runDiscovery()));
    ipcMain.handle('phom:join-followers', guarded(() => ensurePhomSessions().joinFollowers()));
    ipcMain.handle('phom:apply-ready', guarded(() => ensurePhomSessions().applyReady()));
    ipcMain.handle('phom:rejoin-follower', guarded((_e, id) => ensurePhomSessions().rejoinFollower(id)));
    ipcMain.handle('phom:recover-host', guarded(() => ensurePhomSessions().recoverHost()));
    ipcMain.handle('phom:leave-all', guarded(() => ensurePhomSessions().leaveAll()));
    ipcMain.handle('phom:stop', guarded(() => { ensurePhomSessions().stop(); return { ok: true }; }));
    ipcMain.handle('phom:session-state', () => (phomSessions ? phomSessions.snapshot() : null));
    ipcMain.handle('phom:verify-table', () => (phomSessions ? phomSessions.verifySameTable() : { result: 'IDLE' }));
    // PHASE-2 — read the monotonic discovery/sync milestone timeline (telemetry for latency inspection).
    ipcMain.handle('phom:trace', () => ({ ok: true, trace: phomSessions ? phomSessions.trace() : [] }));
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
    ipcMain.handle('phom:manual-join', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.manualJoinRoom(cfg && cfg.browserId, cfg && cfg.rid, cfg && cfg.opts); }));
    ipcMain.handle('phom:manual-rejoin', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.manualRejoin(cfg && cfg.browserId, cfg && cfg.opts); }));
    ipcMain.handle('phom:manual-leave', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.manualLeave(cfg && cfg.browserId); }));
    ipcMain.handle('phom:manual-snapshot', () => (phomSessions ? { ok: true, browsers: phomSessions.manualBrowserSnapshot() } : { ok: true, browsers: [] }));
    // PHASE-6.2.2 — browser lifecycle, all scoped to ONE run (never touches the Tool or the other browsers).
    // ↻ WEB: reload the page in the SAME Chromium; if the page is gone, re-navigate to the game URL — never
    // launches a second Chromium OS window.
    ipcMain.handle('phom:reload-web', guarded(async (_e, cfg) => {
      const runId = cfg && cfg.browserId; if (!runId || !runManager) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no browser' } };
      const client = runClientFor(String(runId));
      const run = runManager.get(String(runId));
      const url = run && run.launchUrl ? run.launchUrl : null;
      if (!client || !client.Page) return { ok: false, error: { code: 'PHOM_RELOAD_NO_CLIENT', message: 'Trang không còn hoạt động — hãy MỞ CHROMIUM.' } };
      // The reloaded page leaves the Phỏm game, so reset this browser's Phỏm context — slotInPhom goes
      // false and the tool shows VÀO GAME again (socket/channels rebind from the new page's own frames).
      const resetPhom = () => { try { if (phomSessions && phomSessions.resetBrowser) phomSessions.resetBrowser(String(runId)); } catch { /* best effort */ } delete headerEntering[String(runId)]; delete headerError[String(runId)]; pushHeaderStates(); };
      try { await client.Page.enable().catch(() => {}); await client.Page.reload({ ignoreCache: false }); resetPhom(); return { ok: true, action: 'RELOAD' }; }
      catch (e) { if (url) { try { await client.Page.navigate({ url }); resetPhom(); return { ok: true, action: 'NAVIGATE' }; } catch { /* fall through */ } } return { ok: false, error: { code: 'PHOM_RELOAD_FAILED', message: safeMsg(e) } }; }
    }));
    // ⏻ TẮT CHROMIUM: close ONLY this run's Chromium window/process (Tool + other browsers untouched).
    ipcMain.handle('phom:close-browser', guarded(async (_e, cfg) => {
      const runId = cfg && cfg.browserId; if (!runId || !runManager) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no browser' } };
      try { await runManager.closeRun(String(runId)); if (phomCluster && phomCluster.markRunClosed) phomCluster.markRunClosed(String(runId), 'USER_CLOSED_WINDOW'); return { ok: true }; }
      catch (e) { return { ok: false, error: { code: 'PHOM_CLOSE_FAILED', message: safeMsg(e) } }; }
    }));
    // Screen 2 — cards REMAINING after removing all cards held by the 3 browsers (never "player 4").
    ipcMain.handle('phom:remaining-cards', () => (phomSessions ? { ok: true, ...phomSessions.remainingCards() } : { ok: true, count: 0, codes: [], cards: [] }));
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
  app.on('will-quit', () => { lifecycleLog('APP_WILL_QUIT', {}); });
}

module.exports = { PRODUCT_NAME, GAME_PRODUCT };
