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
//   - proxy-config / proxy-secret-store / proxy-auth-handler
//   - licensing/*                        (verifier + guard, expectedGameProduct PHOM)
//
// It does NOT import the Control renderer, the Analytics renderer/store, the
// Aviator UI/coordinator, or any Control/Analytics singleton.
// ===========================================================================

const { app, BrowserWindow, ipcMain, protocol, safeStorage, screen, shell: electronShell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { redactDiagnostic } = require('./protocol/phom/diagnostic-redaction.cjs');

const { ChromeRuntime } = require('./browser/chrome-runtime.cjs');
const phomChromium = require('./browser/phom-chromium-runtime.cjs');
const browserRuntimeResolver = require('./browser/browser-runtime-resolver.cjs');
const { resolveSandboxPolicy, DIAGNOSTIC_ENV } = require('./browser/chromium-sandbox-policy.cjs');
const chromiumProfileName = require('./browser/chromium-profile-name.cjs');
const { createSessionRegistry } = require('./phom/core/session-registry.cjs');
const { createFeatureSet } = require('./phom/core/feature-set.cjs');
const { createLogger } = require('./phom/core/logger.cjs');
const { createMemoryWatchFeature } = require('./phom/features/memory-watch.cjs');
const { createCaptureFeature } = require('./phom/features/capture.cjs');
const { createBrowserAgentFeature, applyAgent } = require('./phom/features/browser-agent.cjs');
const { createWsHookFeature } = require('./phom/features/ws-hook.cjs');
const { createAnDanhFeature } = require('./phom/features/an-danh.cjs');
const { createDocNavFeature } = require('./phom/features/doc-nav.cjs');
const { createProxyAuthFeature } = require('./phom/features/proxy-auth.cjs');
const { createEnterGameFeature } = require('./phom/features/enter-game.cjs');
const { createLoginOriginFeature } = require('./phom/features/login-origin.cjs');
const { createHeaderFeature } = require('./phom/features/header.cjs');
const { createWindowFramesFeature } = require('./phom/features/window-frames.cjs');
const { createPlayActionsFeature } = require('./phom/features/play-actions.cjs');
const { createAutoPlayFeature } = require('./phom/features/auto-play.cjs');
const playHelp = require('./protocol/phom/phom-play-help.cjs');
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
const { resolveLaunchProxy } = require('./browser-run/proxy-config.cjs');
const { PhomProfileStore } = require('./phom/stores/profile-store.cjs');
const { createSettingsStore } = require('./phom/stores/settings-store.cjs');
const { runEnterGameViaSite } = require('./protocol/cocos-lobby-entry.cjs');
const { GAME_ID: PHOM_GAME_ID } = require('./protocol/phom/phom-frame-classify.cjs');
const browserAgent = require('./browser-run/browser-agent.cjs');
const { bindProxyAuth } = require('./browser-run/proxy-auth-handler.cjs');
const { LicenseGuard } = require('./licensing/license-guard.cjs');
const { resolveDevBypass, FORBIDDEN_CODE: DEV_BYPASS_FORBIDDEN } = require('./licensing/dev-bypass.cjs');
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
  var deviceProfilesStore = null; // PHASE-6.3.1 flexible N-profile store
  var phomSessions = null;
  // 3.2 core — one session object per open browser (desktop/phom/core) + the features that act on browsers.
  const sessions = createSessionRegistry();
  // Lọc Bài: one analyzer PER account, so each P1/P2/P3 column is computed (and memoised) on its own — every one of
  // them from the SAME shared observation, i.e. with the cards of all three accounts known.
  const slotAnalyzers = { B1: createSafeCardAnalyzer(), B2: createSafeCardAnalyzer(), B3: createSafeCardAnalyzer() };
  const SLOTS_ABC = ['A', 'B', 'C'];
  const RESERVE_SLOTS = ['D', 'E']; // the 4th/5th ticked profile: open, not playing, behind the tool

  const phomRoot = () => path.join(PHOM_USERDATA, 'phom');
  const ensureDir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ } };
  // where a store copies the files it takes over (3.2 migration), once per day at most
  const backupDir = () => path.join(phomRoot(), 'backup-3.2-' + new Date().toISOString().slice(0, 10));

  // ---- SETTINGS (desktop/phom/stores/settings-store.cjs) — the tool's own choices in phom-settings.json ----
  // Each key declares its default, how a value is cleaned, and the pre-3.2 file it is taken over from once.
  let _settings = null;
  function settings() {
    if (_settings) return _settings;
    const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
    const autoPlayStrategy = (v) => {
      const x = v && typeof v === 'object' ? v : {};
      return { lowMoney: x.lowMoney === true, twoPhomCaU: x.twoPhomCaU === true, blockThirdEat: x.blockThirdEat !== false };
    };
    _settings = createSettingsStore({
      file: path.join(phomRoot(), 'phom-settings.json'),
      backupDir: backupDir(),
      log: (e, d) => headerLog(e, d),
      keys: {
        // MỨC CƯỢC — the last stake the user picked, remembered across restarts
        stake: { default: null, normalize: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null), legacy: { file: path.join(phomRoot(), 'stake.json'), pick: (j) => j.stake } },
        // BỐ CỤC — which quarter each window takes (window-layout.cjs; default P2|P3 over P1|Tool)
        windowLayout: { default: { ...windowLayout.DEFAULT_LAYOUT }, normalize: windowLayout.normalizeLayout, legacy: { file: path.join(phomRoot(), 'window-layout.json') } },
        // the browser runtime (AUTO | CUSTOM_CHROMIUM | GOOGLE_CHROME); nothing saved → the bundled Chromium (user 2026-10-05)
        browserRuntime: { default: 'CUSTOM_CHROMIUM', normalize: browserRuntimeResolver.normalizePreference, legacy: { file: path.join(phomRoot(), 'browser-runtime.json'), pick: (j) => j.preference } },
        autoPlayStrategy: { default: { lowMoney: false, twoPhomCaU: false, blockThirdEat: true }, normalize: autoPlayStrategy },
        // the tool window's last bounds (re-clamped to the current display on start)
        toolWindow: { default: null, normalize: (v) => (v && typeof v === 'object' && num(v.x) != null && num(v.width) != null ? { x: num(v.x), y: num(v.y), width: num(v.width), height: num(v.height) } : null), legacy: { file: path.join(PHOM_USERDATA, 'window-state.json') } },
      },
    });
    return _settings;
  }

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
  // ---- the ONE diagnostic log (desktop/phom/core/logger.cjs) → userData/phom-captures/coseat.jsonl ----
  // the coordinator's wire events, the group's decisions and the browser steps that explain a stuck browser; redacted.
  const log = createLogger({ dir: () => path.join(app.getPath('userData'), 'phom-captures'), redact: redactDiagnostic });
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
  // (saved in the settings store — key browserRuntime; nothing saved yet → the bundled Chromium, user 2026-10-05)
  // Google Chrome keeps its profiles apart from the bundled Chromium's, so switching the runtime never hands one
  // browser a profile another version wrote (an older Chrome refuses a profile from a newer version). Measured
  // 2026-10-07: 149 ↔ 154 both open each other's profile when the first browser has fully exited — the folder split is a
  // precaution, not the proven cause of "Chrome opens no browser". Chrome needs one game login of its own.
  function profilesRootFor(kind) { return path.join(phomRoot(), kind === 'chrome' ? 'browser-profiles-chrome' : 'browser-profiles'); }
  // Resolve the executable for a launch given the current preference (custom Chromium result injected).
  function resolveBrowserRuntimeChoice() {
    return browserRuntimeResolver.resolveBrowserRuntime({ preference: settings().get('browserRuntime'), customChromium: chromiumRuntime(), env: process.env });
  }
  const chromeRuntime = new ChromeRuntime({
    chromeExecutable: (() => { const r = chromiumRuntime(); return r && r.ok ? r.executable : null; })(),
    // A run's Chrome exited on its OWN (user closed the window / crash). Mark ONLY that
    // slot closed and disconnect ITS routing — never cascade a close to the other browsers
    // and never treat it as an orchestration teardown (§10).
    onRunExit: (runId, record) => {
      let closed = null;
      try { log.trace('MAIN_ON_RUN_EXIT', { runId, reason: record && record.reason }); if (runManager) runManager.disconnectRun(runManager.get(runId)); phomSessions.routeDisconnect(runId); if (phomCluster && phomCluster.markRunClosed) closed = phomCluster.markRunClosed(runId, record && record.reason); } catch { /* best effort */ }
      // N4 — a closed RESERVE leaves the Phỏm session (no dead member); MỞ LẠI on its card adds it back
      try { if (closed && closed.ok && RESERVE_SLOTS.includes(closed.slot) && phomSessions) phomSessions.removeRun(runId); } catch { /* best effort */ }
      autoReplaceFromReserve(runId, closed);
      dropRunSession(runId);
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
        log.trace('SLOT_AUTO_REPLACED', { slot: closed.slot, reserve, closedRun: rid, ok: !!(res && res.ok) });
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
    // The ONE profile store (N profiles; add/edit/delete + selection). The old per-slot store (phom-profiles.json) is
    // gone (3.2): every open path passes proxy + agent explicitly, and its stale proxyRef once made a DIRECT slot
    // inherit a dead proxy.
    // 3.2 — it also keeps each profile's account + folder name (account-names.json / profile-folders.json taken over once)
    deviceProfilesStore = new PhomProfileStore({
      filePath: path.join(phomRoot(), 'phom-device-profiles.json'),
      legacy: { accountNames: path.join(phomRoot(), 'account-names.json'), folders: path.join(phomRoot(), 'profile-folders.json') },
      backupDir: backupDir(),
      log: headerLog,
    });
  }
  function safeMsg(e) { return String((e && e.message) || e || '').slice(0, 200); }

  function ensureRunManager() {
    if (runManager) return runManager;
    runManager = new BrowserRunManager({
      createLauncher: (run) => chromeRuntime.launcher(run),
      createTargetManager: (endpoint, run) => chromeRuntime.targetManager(run, endpoint),
      buildSubsystem: () => ({}), // Phom uses the coordinator, not a per-run Aviator subsystem
    });
    runManager.on('run-closed', (s) => { if (s && s.id != null) dropRunSession(s.id); }); // the tool closed it
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
    // the group's own decisions (roles, ready / start, why the full-table step waits) go to coseat.jsonl too — without
    // them a "acc 3 did not ready" report could not be explained from the log (2026-10-05)
    phomSessions.on('log', (l) => { try { if (l && l.tag === 'PHOM-COSEAT') log.file(l); else if (l && l.tag === 'PHOM-GROUP') log.file({ at: Date.now(), ...l }); } catch {} try { if (process.env.PHOM_LIFECYCLE_LOG === '1') console.log(`[${l.tag}] ${l.event}`, JSON.stringify(l)); } catch {} });
    return phomSessions;
  }

  function phomAuthorizedEnv() {
    // A valid product license (or the dev bypass) IS the authorization for manual QA control — that is the
    // gate an end user passes by activating the app. The env opt-in stays for headless CI runs without a license.
    if (licenseActive()) return true;
    return process.env.PHOM_QA_ENABLED === '1' && process.env.PHOM_QA_AUTHORIZED === '1';
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
  // Every OPEN browser with its window place: A/B/C = the three playing places, D/E = the reserves (behind the tool).
  function openRunSlots() {
    const snap = phomCluster && phomCluster.active() ? phomCluster.getClusterSnapshot() : null;
    const out = [];
    if (!snap) return out;
    for (const s of SLOTS_ABC) { const p = snap.profiles[s]; if (p && p.profileId && p.browserState === 'OPEN') out.push([p.profileId, s]); }
    for (const r of RESERVE_SLOTS) { const p = snap.reserves && snap.reserves[r]; if (p && p.profileId && p.browserState === 'OPEN') out.push([p.profileId, r]); }
    return out;
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
    const diag = (f) => { try { log.trace('PHOM_ENTER_GAME', { runId: String(runId), gameId: PHOM_GAME_ID, ...f }); } catch { /* ignore */ } };
    const r = await runEnterGameViaSite(client, undefined, PHOM_GAME_ID, diag);
    if (r && r.ok) return { ok: true, gameId: PHOM_GAME_ID };
    return { ok: false, gameId: PHOM_GAME_ID, error: (r && r.error) || { code: 'ENTRY_SITE_SEAM_UNAVAILABLE' } };
  }

  // ---- IN-CHROMIUM GAME HEADER + VÀO GAME — the header, enter-game and login-origin features (desktop/phom/features).
  // Main keeps only the glue: the per-browser VIEW (headerViewFor, from the coordinator's snapshot) and the routes
  // the bar's buttons map to. The button decision lives in the pure deriveHeaderState; the coordinator stays the
  // only source of business truth (find/join/leave semantics unchanged).
  const nowMs = () => { try { return require('node:perf_hooks').performance.now(); } catch { return Date.now(); } };

  // Per-browser RUNTIME status for the READ-ONLY Screen 2 (browser kind · CDP · header). No actions.
  // §2/§12 — HEADER distinguishes three facts: CDP connected, binding installed, and the header DOM actually
  // present in the page (confirmed by the page itself via __HEADER_STATUS). READY only when ALL hold; when
  // the binding is up but the DOM was removed (SPA rebuild, mid-remount) it reports RECOVERING, never READY.
  function browserRuntimeStatus(runId) {
    const rid = String(runId);
    const run = runManager && runManager.get(rid);
    const cdp = !!runClientFor(rid);
    const bar = headerFeature().status(rid);
    let header = 'NOT_READY';
    if (cdp && bar.ready) header = bar.domPresent ? 'READY' : 'RECOVERING';
    return { runtimeKind: (run && run.browserKind) || null, cdp: cdp ? 'CONNECTED' : 'DISCONNECTED', header };
  }

  // A browser step: noted on its session (the last steps, attached to a memory alarm) and logged (logger.run decides
  // which steps always reach coseat.jsonl; all of them with PHOM_HEADER_LOG=1). NEVER logs cookies/tokens/secrets.
  function headerLog(event, data = {}) {
    // the tool's last steps for each browser (event names + time only) — attached to a memory alarm so the log says
    // what happened right before a browser blew up
    if (data && data.runId != null) sessions.note(data.runId, event);
    log.run(event, data);
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
      entering: opened && gameHeader.enteringActive({ ...enterFeature().pending(runId), inGame, now: nowMs() }),
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
      error: headerFeature().errorOf(runId),
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
  const HEADER_TABLE_ACTIONS = new Set(['FIND_TABLE', 'SCAN_TABLE', 'JOIN_CODE', 'REJOIN', 'LEAVE', 'CANCEL_FIND']);
  // What the group is doing right now, in the words the TỰ ĐỘNG chip on every bar shows.
  const GROUP_BUSY_WORD = Object.freeze({ AUTO_ON: 'đang lập bàn', REGROUP: 'đang lập lại bàn', FIND: 'đang Dò Key', JOIN: 'đang vào bàn', REPLACE_JOIN: 'acc thay đang vào bàn', READY: 'sẵn sàng', START: 'đang bắt đầu ván', TABLE_LOST: 'mất bàn — lập lại', LEAVE: 'đang rời bàn', LEAVE_ALL: 'đang thoát tất cả' });
  // The ONE state of a browser (browser-state.cjs) — the same object the bar renders, for the tool window's cards.
  function browserStateFor(runId, browsers, sharedRid) {
    return deriveBrowserState(headerViewFor(runId, browsers, sharedRid));
  }
  // A browser whose game frames stopped arriving is reported as such after this long (and re-hooked by the capture
  // feature) instead of silently reading "CHƯA VÀO GAME".
  const HEADER_STALE_MS = 20000;
  // Recompute + push the header state into every open Chromium (best-effort). Called after every session
  // update and after every header action so the bars stay live without a Tool screen.
  function pushHeaderStates() {
    if (!phomSessions || !runManager) return;
    let browsers = []; try { browsers = phomSessions.manualBrowserSnapshot() || []; } catch { browsers = []; }
    const sharedRid = headerSharedRid();
    for (const summary of runManager.list()) {
      if (summary.status === RUN_STATUS.CLOSED) continue;
      if (!runClientFor(summary.id)) continue;
      const rid = String(summary.id);
      const run = runManager.get(rid);
      if (!run) continue;
      const view = headerViewFor(rid, browsers, sharedRid);
      // every feature's push, in order: capture re-hooks a browser whose frames stopped · enter-game (auto entry +
      // evidence) · login-origin · header LAST (settles a stale error, pushes the bar only when its state changed —
      // a CDP evaluate per WS frame per browser was the storm the clicks rode on)
      features().push({ run, session: sessions.get(rid), view, browser: browsers.find((x) => x && String(x.profileId) === rid) || null });
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
    const uiSettings = { autoPlayStrategy: settings().get('autoPlayStrategy') };
    if (!phomSessions || !phomSessions.active()) return { ok: true, browsers: [], sharedRid: null, sharedRidOwner: null, coSeat: null, group: null, remaining: null, cards: null, analyses: {}, play: {}, autoPlay: {}, settings: uiSettings };
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
    // ĐÁNH BÀI tab: per account, from its OWN hand + public facts only (phom-play-help publicView)
    const play = {};
    for (const slot of ['B1', 'B2', 'B3']) { const uid = binding[slot]; if (uid) { try { play[slot] = playHelp.playHelp(cards, uid); } catch { play[slot] = null; } } }
    return {
      ok: true, browsers, cards, analyses, play,
      autoPlay: _autoPlayFeature ? _autoPlayFeature.status() : {}, // TỰ ĐÁNH per runId: { on, message }
      settings: uiSettings,
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
  // no behavior change, no new IPC contract. The header feature routes RELOAD through reloadWebRun.
  async function reloadWebRun(runId) {
    const rid = String(runId == null ? '' : runId);
    if (!rid || !runManager) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no browser' } };
    const client = runClientFor(rid);
    const run = runManager.get(rid);
    const url = run && run.launchUrl ? run.launchUrl : null;
    if (!client || !client.Page) return { ok: false, error: { code: 'PHOM_RELOAD_NO_CLIENT', message: 'Trang không còn hoạt động — hãy MỞ CHROMIUM.' } };
    const resetPhom = () => { try { if (phomSessions && phomSessions.resetBrowser) phomSessions.resetBrowser(rid); } catch { /* best effort */ } enterFeature().reset(rid); headerFeature().reset(rid); pushHeaderStates(); };
    try { await client.Page.enable().catch(() => {}); await client.Page.reload({ ignoreCache: false }); resetPhom(); return { ok: true, action: 'RELOAD' }; }
    catch (e) { if (url) { try { await client.Page.navigate({ url }); resetPhom(); return { ok: true, action: 'NAVIGATE' }; } catch { /* fall through */ } } return { ok: false, error: { code: 'PHOM_RELOAD_FAILED', message: safeMsg(e) } }; }
  }
  // §54 — the page of a run loaded a NEW DOCUMENT (F5 in Chromium, the header's ⟳, a redirect back to the web
  // lobby). The old document's game socket, channel list and table are gone with it, so this browser's Phỏm
  // state is reset — exactly what the tool's own ⟳ always did. A reload the USER did (F5) never went through
  // the tool, so the header kept showing the old state (in game / at a table) while the page sat at the web
  // lobby and never offered VÀO GAME. Runs at commit time, so no frame of the old document can re-bind the
  // state afterwards. Each feature's documentReplaced does its part (enter-game re-arms the auto entry, login-origin
  // notes where the game is, header forgets the old bar).
  function onRunDocumentReplaced(runId, url) {
    const rid = String(runId);
    if (!url || /^about:/i.test(url)) return; // the proxy-auth launch page, not the game
    try { if (phomSessions && phomSessions.resetBrowser) phomSessions.resetBrowser(rid); } catch { /* best effort */ }
    features().documentReplaced({ run: runManager && runManager.get(rid), session: sessions.get(rid), url: String(url) });
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

  // ---- 3.2 features: what the tool does to a browser, one module each (desktop/phom/features) ----
  // Built on first use (they reference functions declared further down). PHOM_FEATURES_OFF=<id,…> switches any off.
  let _features = null; let _memoryFeature = null; let _anDanhFeature = null; let _enterFeature = null; let _headerFeature = null; let _windowFeature = null;
  let _playFeature = null; let _autoPlayFeature = null;
  const enterFeature = () => (features(), _enterFeature);
  const headerFeature = () => (features(), _headerFeature);
  const windows = () => (features(), _windowFeature);
  function features() {
    if (_features) return _features;
    _windowFeature = createWindowFramesFeature({
      sessions,
      layout: { get: () => settings().get('windowLayout'), set: (l) => settings().set('windowLayout', l), defaults: windowLayout.DEFAULT_LAYOUT },
      rectForItem: (item, layout) => windowLayout.rectForItem(item, clusterFourWindowArrangement(), layout),
      fallbackRect: gridRectForSlot,
      toolFallback: () => toolWindowBounds(currentWorkArea(), { minWidth: WIN_DEFAULTS.minWidth, minHeight: WIN_DEFAULTS.minHeight }),
      openRuns: openRunSlots,
      clientFor: runClientFor,
      tool: () => shell,
      lockOn: () => features().enabled('window-frames'), // PHOM_FEATURES_OFF=window-frames stops KHÓA KHUNG
      log: headerLog,
    });
    _enterFeature = createEnterGameFeature({
      sessions,
      enter: (rid) => phomEnterGame(rid),
      timeoutMs: gameHeader.ENTER_GAME_TIMEOUT_MS,
      autoEnabled: () => process.env.PHOM_AUTO_ENTER !== '0', // PHOM_AUTO_ENTER=0 → only the bar's VÀO GAME enters
      log: headerLog,
      refresh: () => pushHeaderStates(),
      now: nowMs,
    });
    // Route ONE bar click to the coordinator's manual API (the stake comes from the Phỏm tool's picker — never invented).
    const sess = () => ensurePhomSessions();
    _headerFeature = createHeaderFeature({
      sessions,
      bootScript: (o) => gameHeader.bootScript({ ...o, observerLog: process.env.PHOM_HEADER_OBSERVER_LOG === '1', clickLog: process.env.PHOM_CLICK_LOG === '1' || process.env.PHOM_HEADER_LOG === '1' }),
      installHeader: headerBridge.installHeader,
      clientFor: runClientFor,
      runOf: (rid) => runManager && runManager.get(rid),
      evaluateHeaderAction,
      isBusyExempt: headerActionGuard.isBusyExempt,
      tableActions: HEADER_TABLE_ACTIONS,
      autoActive: () => !!(phomSessions && phomSessions.active() && phomSessions.autoActive()),
      routes: {
        ENTER_GAME: (rid, p, ctx) => _enterFeature.start(rid, { source: 'header', slotId: p.slotId, actionId: ctx.actionId }),
        // T1 — DÒ KEY: this browser sits alone at an empty public table and becomes KEY (rule D2: force = confirmed)
        FIND_TABLE: (rid, p, ctx) => sess().findTable(rid, { stake: sess().selectedStake(), force: ctx.force }),
        SCAN_TABLE: (rid) => sess().scanTable(rid),                                            // T2a — TẠO
        JOIN_CODE: (rid, p) => sess().joinTable(rid, p.rid != null ? Number(p.rid) : null),  // VÀO SỐ BÀN (no password)
        CANCEL_FIND: (rid) => sess().cancelFind(rid),                                          // §34 — DỪNG (busy-exempt)
        REJOIN: (rid) => sess().rejoinTable(rid),
        LEAVE: (rid) => sess().leaveTable(rid),
        RELOAD: (rid) => reloadWebRun(rid),                                                    // TẢI LẠI WEB = the tool's ⟳
      },
      deriveHeaderState: gameHeader.deriveHeaderState,
      stateCode: (view) => deriveBrowserState(view).code,
      log: headerLog,
      refresh: () => pushHeaderStates(),
      now: nowMs,
      newKey: () => crypto.randomBytes(16).toString('hex'),
    });
    _memoryFeature = createMemoryWatchFeature({
      // the Chromium root is a prefix of the Chrome one (browser-profiles / browser-profiles-chrome): one marker covers both
      marker: () => profilesRootFor('chromium'),
      runs: () => (runManager ? runManager.list().map((s) => runManager.get(s.id)).filter(Boolean).map((r) => ({ id: r.id, slot: r.slot, profileDir: r.profileDir, profileLabel: r.profileLabel, browserKind: r.browserKind, closed: r.status === RUN_STATUS.CLOSED })) : []),
      closeRun: (rid) => closeBrowserRun(rid),
      log: headerLog,
      notice: (n) => send('phom:notice', n),
      sessions,
    });
    // every attached target of a run with its own client (the capture re-hook re-arms them all)
    const runTargets = (rid) => (runManager ? runManager.targetsForRun(rid) : []).map((t) => { const run = runManager.get(rid); const sess = run && run.targetManager && run.targetManager.getSession(t); return { targetId: t, client: sess && sess.client }; });
    _anDanhFeature = createAnDanhFeature({
      anDanh,
      pageClients: () => (runManager ? runManager.list() : []).filter((r) => r.status !== RUN_STATUS.CLOSED).map((r) => ({ runId: r.id, client: runClientFor(r.id) })).filter((x) => x.client),
      log: headerLog,
    });
    // Bốc / Ăn / Đánh / Hạ / Gửi from the tool — the game's own button, only while the game offers it
    _playFeature = createPlayActionsFeature({ clientFor: runClientFor, log: headerLog, precheck: (rid, action, cards) => {
      // picked cards checked against what the table shows; the game still decides
      const uid = phomSessions && phomSessions.active() ? phomSessions.uidOf(rid) : null;
      return uid ? playHelp.checkPlay(phomSessions.cardObserverSnapshot(), uid, action, cards) : { ok: true };
    }, manualBlocked: (rid) => ((_autoPlayFeature && (_autoPlayFeature.status()[rid] || {}).on) ? 'Acc này đang Tự đánh — tắt Tự đánh trước khi bấm tay' : null) });
    // TỰ ĐÁNH — per account, switched on by the user; every press goes through the play-actions feature above
    _autoPlayFeature = createAutoPlayFeature({
      act: (rid, input) => (features().enabled('play-actions') ? _playFeature.act(rid, input) : { ok: false, error: { code: 'PHOM_FEATURE_OFF', message: 'Nút đánh bài đang tắt (PHOM_FEATURES_OFF)' } }),
      clientFor: runClientFor,
      snapshot: () => (phomSessions && phomSessions.active() ? phomSessions.cardObserverSnapshot() : {}),
      uidOf: (rid) => (phomSessions && phomSessions.active() ? phomSessions.uidOf(rid) : null),
      autoOptions: () => {
        const moneyByUid = {};
        const browsers = phomSessions && phomSessions.active() ? (phomSessions.manualBrowserSnapshot() || []) : [];
        for (const b of browsers) {
          const uid = phomSessions.uidOf(b.profileId);
          const money = Number(b.money);
          if (uid != null && Number.isFinite(money)) moneyByUid[String(uid)] = money;
        }
        return { strategy: settings().get('autoPlayStrategy'), moneyByUid };
      },
      licensed: autoPlayLicensed, // the key's "Cho dùng Tự đánh" (signed features.autoRun)
      log: headerLog,
      refresh: () => scheduleCardsBroadcast(true),
    });
    _features = createFeatureSet({
      log: headerLog,
      // ORDER MATTERS: the send hook before the game opens its socket; header + an-danh new-document scripts before
      // proxy-auth lets a proxied page navigate to the game; on push, enter-game before header (the bar shows the
      // entering state the auto entry just set).
      features: [
        createCaptureFeature({ capture, targetsOf: runTargets, injectSendHook: (client) => wsReplay.injectSession(client, undefined), log: headerLog, now: nowMs }),
        createBrowserAgentFeature({ browserAgent, notify: (p) => send('phom:agent-applied', p) }),
        createWsHookFeature({ injectSendHook: (client) => wsReplay.injectSession(client, undefined) }),
        _anDanhFeature,
        createDocNavFeature({ onDocument: (rid, url) => onRunDocumentReplaced(rid, url) }),
        _enterFeature,
        createLoginOriginFeature({ profiles: () => deviceProfilesStore, clientFor: runClientFor, log: headerLog }),
        _headerFeature,
        createProxyAuthFeature({ bindProxyAuth, resolvePassword: (id) => (proxyConfigStore ? proxyConfigStore.resolvePassword(id) : null), log: headerLog, onAuthFailure: (run, code) => send('phom:proxy-auth', { runId: run.id, code }) }),
        _memoryFeature,
        _windowFeature,
        _playFeature,
        _autoPlayFeature,
      ],
    });
    return _features;
  }
  // A browser is gone (closed by the tool or by the user): its features let go, its session is dropped.
  function dropRunSession(runId) {
    const rid = String(runId);
    const s = sessions.peek(rid);
    if (!s) return;
    try { features().closed({ run: runManager && runManager.get(rid), session: s }); } catch { /* best effort */ }
    sessions.drop(rid);
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
    log.trace('SLOT_REPLACED', { slot: s, oldRun, newRun, deviceProfileId: after.deviceProfileId, replacedInSession: replaced });
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
    log.trace('RESERVE_REOPENED', { reserve: r, runId: rs.profileId });
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
      log.trace('SLOT_SWAP_LEAVE', { slot: s, run: oldRun, ok: !!(lv && lv.ok) });
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
    await windows().move(res.playingRun, windows().rectFor(s));
    if (res.benchedRun) await windows().move(res.benchedRun, windows().rectFor(r));
    try { if (shell && !shell.isDestroyed()) shell.moveTop(); } catch { /* the tool stays where it is */ }
    const after = phomCluster.getClusterSnapshot().profiles[s];
    log.trace('SLOT_SWAPPED', { slot: s, reserve: r, playingRun: res.playingRun, benchedRun: res.benchedRun, replacedInSession: replaced });
    pushHeaderStates();
    return { ok: true, slot: s, runId: res.playingRun, deviceProfileId: after.deviceProfileId, label: after.label };
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
      // ONE frame path (3.2): an active cluster only gates the frame (a browser not in it, a duplicate or late seq is
      // dropped); every accepted frame goes to the Phỏm session — which keeps a run's frames (the login identity
      // above all) until a session covers it.
      if (phomCluster && phomCluster.active() && !phomCluster.acceptFrame(run.id, { raw: req.body && req.body.raw, direction: req.wsDirection, seq: req.seq, targetId: req.targetId, cdpSessionId: req.cdpSessionId, url: req.url }).accepted) return;
      ensurePhomSessions().routeFrame(run, req);
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
      headerLog('cdp-attach', { runId: run.id, slotId: run.slot, targetId: target.cdpTargetId });
      // 3.2 — every feature that acts on a browser, in order (desktop/phom/features; see features())
      features().attach({ run, target, client, session: sessions.get(run.id) });
    });
    manager.on('target-removed', (id) => {
      runManager.unregisterTarget(id);
      if (run.selectedTargetId === id) run.selectedTargetId = null;
      // §11/§12 — the CDP session for this run's page is gone (transient drop or real close). Mark the
      // header NOT READY so Screen 2 reflects it and no action is routed into a dead session. If the OS
      // window is still alive, the 1.5s target poll re-attaches → installHeader re-runs on the new client.
      if (!runManager.targetsForRun(run.id).length) { headerFeature().detached(run.id); enterFeature().detached(run.id); headerLog('cdp-detached', { runId: run.id }); runManager.disconnectRun(run); try { phomSessions.routeDisconnect(run.id); } catch { /* best effort */ } pushHeaderStates(); }
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
  // The cluster's "apply agents" fan-out uses the same agent code as the browser-agent feature.
  async function applyBrowserAgent(client, agent, run) {
    const r = await applyAgent(browserAgent, client, agent);
    if (run) { run._agentApplied = r.applied; run._agentUnsupported = r.unsupported; }
    try { send('phom:agent-applied', { runId: run && run.id, applied: r.applied, unsupported: r.unsupported, agent: browserAgent.publicSnapshot(agent) }); } catch { /* best effort */ }
    return r;
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
    // The saved profile (the one profile store) fills what the caller did not pass; an explicit proxyRef — null
    // included, meaning DIRECT — always wins.
    const saved = deviceProfilesStore.get(pk) || {};
    const effProxyRef = proxyRef !== undefined ? proxyRef : (saved.proxyRef || null);
    // Proxy is OPTIONAL: no proxyRef => DIRECT. A bound proxyRef must resolve (no silent
    // fallback). `proxyRequired` stays an explicit opt-IN (default optional).
    const gate = resolveLaunchProxy({ proxyRef: effProxyRef || null, proxyRequired: proxyRequired === true }, (ref) => proxyConfigStore && proxyConfigStore.get(ref));
    if (!gate.ok) return gate; // PROXY_CONFIG_NOT_FOUND / DISABLED (bound proxy) — launch blocked; DIRECT is allowed
    // A selected profile passes its AGENT explicitly; otherwise the saved profile's, then the default. The
    // persistent user-data-dir is keyed by the profile identity so each profile reopens the SAME identity.
    const agentNorm = browserAgent.normalizeAgent(agentArg || deviceProfilesStore.agentFor(pk));
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
    // ONE name everywhere (user 2026-10-06 "làm cho đồng bộ"): the game account last seen in this profile, else the
    // tool's profile name — for the cookie FOLDER (browser-profiles/<name>, renamed while the browser is closed; the
    // profile id stays the key in profile-folders.json) and for the Chromium profile name. The tab shows it as well.
    const profileName = deviceProfilesStore.accountOf(udKey) || label || saved.name || `Profile ${slot}`;
    const profilesRoot = profilesRootFor(rtChoice.kind);
    let profileDir = path.join(profilesRoot, udKey || slot || 'X');
    try {
      const pd = chromiumProfileName.resolveProfileDir({ root: profilesRoot, key: udKey || slot || 'X', name: profileName, map: deviceProfilesStore.folders() });
      profileDir = pd.dir;
      if (pd.renamedFrom || pd.renameError) headerLog('profile-folder', { slotId: slot, profileId: udKey, renamed: !!pd.renamedFrom, error: pd.renameError || null });
    } catch { /* never blocks a launch */ }
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* best effort */ }
    // Written now, while this profile's browser is closed (Chromium reads it at start, rewrites it at exit).
    try {
      const pn = chromiumProfileName.applyProfileName(profileDir, profileName);
      if (pn.changed) headerLog('profile-name', { slotId: slot, profileId: udKey, fromAccount: !!deviceProfilesStore.accountOf(udKey) });
    } catch { /* never blocks a launch */ }
    // PHASE-6 — DETERMINISTIC multi-monitor placement. Browser slot A/B/C ⇒ window 1/2/3 (stable, never
    // by launch/PID order). Each window FILLS its region of the live display topology (on one monitor:
    // a quadrant of the 2×2 grid whose fourth cell is the Tool), so the four windows cover the screen and
    // the page's viewport is simply that window minus the browser chrome — nothing is emulated or scaled.
    const slotIndex = { A: 1, B: 2, C: 3 }[slot] || 1;
    let windowRect;
    try { windowRect = windows().rectFor(slot); } catch { windowRect = gridRectForSlot(slotIndex === 1 ? 'A' : slot); }
    // The executable goes INTO createRun: the launcher is built inside it and reads run.chromeExecutable once. Setting
    // it afterwards (as before 3.1.30) was too late — "Chrome" silently launched the custom Chromium, and without the
    // sandbox ACL step that Chrome skips, so on a fresh machine no window appeared while the tool said it opened.
    const run = runManager.createRun({ launchUrl: String(url || ''), proxy: gate.runProxy, windowRect, profileDir, sandboxDisabled: sandbox.sandboxDisabled, chromeExecutable: usingChrome ? rtChoice.executable : null });
    run.profileLabel = label || saved.name || `Profile ${slot}`;
    run.slot = slot;
    run.profileId = udKey; // PHASE-6.3.1 — runtime browserRunId → profileId mapping (active-guard + reopen)
    run.browserAgent = agent; // re-applied on every attach
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
  // TỰ ĐÁNH needs its own signed right: a PHOM v2 key with features.autoRun === true (Generator: "Cho dùng Tự đánh").
  // A key signed without it — every PHOM key before this right existed — is refused. The dev bypass has no key: allowed.
  function autoPlayLicensed() {
    if (devBypass.allowed) return true;
    if (!licenseActive()) return false;
    const p = licenseGuard && licenseGuard.status().payload;
    return !!(p && p.v === 2 && p.features && p.features.autoRun === true);
  }
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
  function saveWindowState() { try { if (shell && !shell.isDestroyed() && !shell.isMinimized()) settings().set('toolWindow', shell.getBounds()); } catch { /* best effort */ } }
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
    const bounds = fitToCurrentDisplay(settings().get('toolWindow'));
    // dev runs electron.exe (its own icon): show the Phỏm QA logo on the window too — packaged, Phom QA.exe has it
    const devIcon = app.isPackaged ? null : path.join(__dirname, '..', 'build', 'phom-icon.png');
    shell = new BrowserWindow({
      ...bounds, backgroundColor: '#f4f6fb', title: PRODUCT_NAME,
      ...(devIcon && fs.existsSync(devIcon) ? { icon: devIcon } : {}),
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
    ipcMain.handle('phom:capabilities', () => ({ featureEnabled: process.env.PHOM_QA_ENABLED === '1', authorized: phomAuthorizedEnv(), licensed: licenseActive(), autoPlayLicensed: autoPlayLicensed(), devBypass: devBypass.allowed === true, licenseMode: devBypass.allowed ? 'DEVELOPMENT_BYPASS' : 'LICENSED', proxySecret: (ensureStores(), proxySecretStore.capability()), chromiumSandbox: { mode: lastSandboxPolicy.mode, disabled: !!lastSandboxPolicy.sandboxDisabled, banner: lastSandboxPolicy.banner || null } }));

    // Proxy config (metadata only; passwords never returned to the renderer).
    ipcMain.handle('phom:proxy-list', guarded(() => { ensureStores(); return { ok: true, proxies: proxyConfigStore.list() }; }));
    // §3/§4 — expose the FULL catalog (mobile + desktop + laptop + laptop-small +
    // laptop-small + mobile-landscape). The UI groups them by profileType.
    ipcMain.handle('phom:agents', () => ({ ok: true, agents: browserAgent.AGENTS.map((a) => ({ agent: a, ...browserAgent.publicSnapshot(a) })), defaultAgent: browserAgent.DEFAULT_AGENT }));
    // ---- PHASE-6.3.1 — flexible N-profile CRUD + open-from-selection ----
    ipcMain.handle('phom:profiles-list', guarded(() => { ensureStores(); return { ok: true, profiles: deviceProfilesStore.list() }; }));
    // A profile created / renamed in the tool gets its Chromium profile at once — the cookie folder and the Chromium
    // profile name (user 2026-10-06: "tạo profile xong thì cũng phải tạo profile trên web"); not while its browser is open.
    const syncBrowserProfile = (res) => {
      try {
        const p = res && res.ok && res.profile; if (!p || !p.id || profileInUse(String(p.id))) return res;
        const name = deviceProfilesStore.accountOf(p.id) || p.name || p.id;
        const rtNow = resolveBrowserRuntimeChoice();
        const pd = chromiumProfileName.resolveProfileDir({ root: profilesRootFor(rtNow.ok ? rtNow.kind : 'chromium'), key: String(p.id), name, map: deviceProfilesStore.folders() });
        chromiumProfileName.applyProfileName(pd.dir, name);
        headerLog('profile-synced', { profileId: p.id, folder: pd.folder, renamed: !!pd.renamedFrom });
      } catch { /* the next launch syncs it anyway */ }
      return res;
    };
    ipcMain.handle('phom:profile-create', guarded((_e, input) => { ensureStores(); return syncBrowserProfile(deviceProfilesStore.create(input && typeof input === 'object' ? input : {})); }));
    ipcMain.handle('phom:profile-update-x', guarded((_e, id, patch) => { ensureStores(); return syncBrowserProfile(deviceProfilesStore.update(String(id == null ? '' : id), patch && typeof patch === 'object' ? patch : {})); }));
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
      const saved = settings().get('stake'); if (r && r.ok !== false && saved != null) phomSessions.setStake(saved);
      return r;
    }));
    // §13 — Find-Table stake source: request the server channel list + read the
    // AUTHORITATIVE distinct stakes it reports (never a hard-coded fallback).
    // §35 — optionally scoped to ONE browser; seated browsers are always skipped (coordinator).
    ipcMain.handle('phom:request-channels', guarded(async (_e, cfg) => { ensurePhomSessions(); return phomSessions.requestChannels({ profileId: cfg && cfg.browserId != null ? cfg.browserId : null }); }));
    ipcMain.handle('phom:leave-all', guarded(() => { ensurePhomSessions(); return phomSessions.leaveAllTables(); }));
    ipcMain.handle('phom:session-state', () => (phomSessions ? phomSessions.snapshot() : null));
    // TEST D — record the game client's own frames while the player acts by hand (e.g. clicks a table), then
    // write them to a file (secrets redacted) so the real protocol can be read instead of guessed.
    ipcMain.handle('phom:frames-record-start', (_e, cfg) => {
      const runIds = cfg && Array.isArray(cfg.runIds) ? cfg.runIds.filter((x) => x != null).map(String) : null;
      return { ok: true, ...frameRecorder.start({ runIds, label: cfg && cfg.label != null ? String(cfg.label) : null, keepRoomCodes: false }) };
    });
    ipcMain.handle('phom:frames-record-status', () => ({ ok: true, ...frameRecorder.status() }));
    ipcMain.handle('phom:frames-record-stop', () => stopAndSaveCapture());
    ipcMain.handle('phom:frames-open-folder', (_e, p) => { try { if (p) electronShell.showItemInFolder(String(p)); return { ok: true }; } catch (e) { return { ok: false, error: { code: 'OPEN_FAILED', message: String(e && e.message || e) } }; } });
    // §auto — the Phỏm tool's TỰ ĐỘNG checkbox. ON forms the group (finder = browserId, KEY; the others READY /
    // NOT_READY) unless one exists, then rejoins kicked members and takes another table when one is lost. OFF stops it.
    ipcMain.handle('phom:auto-set', guarded((_e, cfg) => { ensurePhomSessions(); return phomSessions.setAuto(!!(cfg && cfg.on), { creatorId: cfg && cfg.browserId, stake: cfg && cfg.stake != null ? Number(cfg.stake) : null }); }));
    // THE mức cược lives in the Phỏm tool; the in-page bars search at this stake (they have no picker of their own).
    ipcMain.handle('phom:set-stake', guarded((_e, cfg) => { ensurePhomSessions(); settings().set('stake', cfg && cfg.stake); return phomSessions.setStake(cfg && cfg.stake); }));
    ipcMain.handle('phom:stake-get', () => ({ ok: true, stake: settings().get('stake') }));
    ipcMain.handle('phom:auto-play-strategy-set', guarded((_e, cfg) => {
      const strategy = settings().set('autoPlayStrategy', cfg && cfg.autoPlayStrategy);
      sendUiAndJournal();
      return { ok: true, autoPlayStrategy: strategy };
    }));
    ipcMain.handle('phom:new-table', guarded(() => { ensurePhomSessions(); return phomSessions.newTable(); }));
    // 3.2 — each feature registers its own channels (an-danh: phom:an-danh-get / phom:an-danh-set)
    features().registerIpc((channel, fn, opts) => ipcMain.handle(channel, opts && opts.guarded ? guarded(fn) : fn));
    ipcMain.handle('phom:ui-snapshot', () => phomUiSnapshot());
    // PHASE 6.3.2.2 — BROWSER RUNTIME preference (AUTO | CUSTOM_CHROMIUM | GOOGLE_CHROME). get returns the
    // saved preference + what each option currently resolves to (so SETUP can show availability).
    ipcMain.handle('phom:browser-runtime-get', () => {
      const custom = chromiumRuntime();
      const chrome = browserRuntimeResolver.resolveGoogleChrome({ env: process.env });
      return { ok: true, preference: settings().get('browserRuntime'), customAvailable: !!(custom && custom.ok), chromeAvailable: !!(chrome && chrome.ok), resolved: (() => { const r = resolveBrowserRuntimeChoice(); return r.ok ? { kind: r.kind, fellBack: !!r.fellBack } : { error: r.error }; })() };
    });
    ipcMain.handle('phom:browser-runtime-set', guarded((_e, cfg) => ({ ok: true, preference: settings().set('browserRuntime', cfg && cfg.preference) })));
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
    // BỐ CỤC / XẾP CỬA SỔ (phom:layout-get/-set, phom:restore-layout) — the window-frames feature
    ipcMain.handle('phom:reserve-reopen', guarded(async (_e, cfg) => reopenReserve(cfg && cfg.reserve)));
    ipcMain.handle('phom:slot-swap', guarded(async (_e, cfg) => swapSlot(cfg && cfg.slot, cfg && cfg.reserve)));
    ipcMain.handle('phom:slot-replace', guarded(async (_e, cfg) => replaceSlot(cfg && cfg.slot, cfg && cfg.profileId ? String(cfg.profileId) : null)));
    ipcMain.handle('phom:cluster-connect', guarded(() => ensureCluster().connectClusterCdp()));
    ipcMain.handle('phom:cluster-apply-agents', guarded(() => ensureCluster().applyClusterAgents()));
    // ĐÓNG 3 TRÌNH DUYỆT = EXPLICIT browser close (the ONLY app path that closes the runs).
    ipcMain.handle('phom:cluster-stop', guarded(async () => { log.trace('IPC_CLUSTER_STOP', {}); return ensureCluster().stopCluster(); }));
    ipcMain.handle('phom:cluster-snapshot', () => (phomCluster ? phomCluster.getClusterSnapshot() : null));

    // 2×2 workspace layout controls (§9/§21).
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
    windows().start();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { log.trace('APP_WINDOW_ALL_CLOSED', {}); if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { log.trace('APP_BEFORE_QUIT', { stack: (new Error().stack || '').split('\n').slice(1, 6).join(' | ') }); });
  app.on('will-quit', () => { log.trace('APP_WILL_QUIT', {}); log.flush(); try { if (_memoryFeature) _memoryFeature.stop(); } catch { /* gone */ } }); // §ws-log — never lose the last batch
}

module.exports = { PRODUCT_NAME, GAME_PRODUCT };
