'use strict';

// ---------------------------------------------------------------------------
// ChromeLauncher — one real chrome.exe process per BrowserRun.
//
// Each launcher OWNS exactly one Chrome process with:
//   - its OWN persistent profile directory (--user-data-dir=<run.profileDir>), so
//     cookies/storage/login survive close→reopen and NEVER mix between runs;
//   - its OWN unique CDP port (--remote-debugging-port), allocated per run so two
//     runs launched back-to-back cannot collide; there is no global debugging port;
//   - a 720x405 DEFAULT opening window (--window-size). This is the opening size
//     ONLY — Chrome stays fully resizable/movable/minimizable/maximizable and we
//     never re-assert the size at runtime and never lock the aspect ratio.
//
// The facade (open / close / closeGraceful / snapshot) is drop-in compatible with
// the BrowserRunManager launcher contract, so nothing above the transport boundary
// (protocol/AutoRunner/recovery) changes.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { allocateFreePort } = require('./port-allocator.cjs');
const { toChromeArgs } = require('../browser-run/proxy-config.cjs');
const CDP = require('chrome-remote-interface');

const DEFAULT_WINDOW = Object.freeze({ width: 720, height: 405 });

// ---------------------------------------------------------------------------
// EXIT CLASSIFICATION (browser-auto-close root cause). The process we spawn is a
// BOOTSTRAP process: Chromium routinely hands the browser session to a REPLACEMENT
// main process and the bootstrap exits 0 within a second or two (relaunch on a fresh
// --user-data-dir, ProcessSingleton hand-off, sandbox re-exec, …). Treating that
// bootstrap `exit` as "the browser closed" is the bug — it flips the slot to
// CLOSED_BY_USER / ĐÃ ĐÓNG while the real window is still on screen.
//
// So on bootstrap exit we do NOT assume death: we PROBE the run's CDP endpoint. If it
// still answers, the run is alive on a replacement PID (TRACKED_PID_REPLACED) — keep it
// OPEN. Only when CDP is truly gone do we fire onExit, with an HONEST reason (never a
// blanket CLOSED_BY_USER).
const EXIT_REASONS = Object.freeze({
  APP_REQUESTED_CLOSE: 'APP_REQUESTED_CLOSE',   // we called close()/closeGraceful()/destroy()
  USER_CLOSED_WINDOW: 'USER_CLOSED_WINDOW',     // browser was fully up, then exited cleanly (window closed)
  CHROMIUM_CRASH: 'CHROMIUM_CRASH',             // killed by a signal / non-zero exit code
  TRACKED_PID_REPLACED: 'TRACKED_PID_REPLACED', // bootstrap exited but CDP still answers (alive)
  PROFILE_LOCK: 'PROFILE_LOCK',                 // ProcessSingleton / user-data-dir lock hand-off
  UNKNOWN_EXIT: 'UNKNOWN_EXIT',                 // exited before ever becoming a browser — ambiguous
});

// Default CDP liveness probe: an HTTP GET on the DevTools /json/version endpoint. A
// live browser answers with JSON regardless of which main process now owns the port.
function defaultProbeCdp({ host = '127.0.0.1', port = null, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    if (!port) { resolve({ alive: false }); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.get({ host, port, path: '/json/version', timeout: Math.max(200, timeoutMs) }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; if (body.length > 65536) { try { req.destroy(); } catch { /* ignore */ } } });
        res.on('end', () => {
          let ws = null; try { ws = (JSON.parse(body) || {}).webSocketDebuggerUrl || null; } catch { /* non-JSON but answered */ }
          finish({ alive: res.statusCode >= 200 && res.statusCode < 500, webSocketDebuggerUrl: ws });
        });
      });
    } catch { finish({ alive: false }); return; }
    req.on('error', () => finish({ alive: false }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } finish({ alive: false }); });
  });
}

// Classify a GENUINE gone-exit (CDP already confirmed dead). Never returns
// USER_CLOSED_WINDOW without positive evidence (the browser had actually come up).
function classifyGoneExit({ code, signal, elapsedMs, cdpEverUp, stderr }) {
  const s = String(stderr || '');
  if (/SingletonLock|ProcessSingleton|already running|profile.*in use|The profile appears to be in use/i.test(s)) return EXIT_REASONS.PROFILE_LOCK;
  if (signal) return EXIT_REASONS.CHROMIUM_CRASH;             // terminated by a signal (incl. job-object kill)
  if (typeof code === 'number' && code !== 0) return EXIT_REASONS.CHROMIUM_CRASH;
  if (cdpEverUp) return EXIT_REASONS.USER_CLOSED_WINDOW;      // was a live browser, clean exit ⇒ window closed
  // Exited 0 having NEVER become a browser — a hand-off/relaunch we could not follow.
  return EXIT_REASONS.UNKNOWN_EXIT;
}

// Redact anything credential-shaped from a stderr tail / arg list before it is stored
// or surfaced (defence in depth — the CLI is already credential-free by construction).
// Diagnostic lifecycle log (browser open/close/exit forensics). Opt-in via
// PHOM_LIFECYCLE_LOG=1 so it is silent in normal use; writes one tagged JSON line per
// event to stderr (captured by the repro harness). NEVER logs a secret (payload is
// pre-redacted). This is instrumentation, not control flow.
function lifecycleLog(event, data) {
  try {
    if (!process.env.PHOM_LIFECYCLE_LOG) return;
    const line = JSON.stringify({ t: new Date().toISOString(), tag: 'PHOMLC', event, ...data });
    process.stderr.write(line + '\n');
  } catch { /* never throw from instrumentation */ }
}

function redact(text) {
  return String(text == null ? '' : text)
    .replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//<redacted>@')      // user:pass@ in URLs
    .replace(/(password|passwd|token|authorization|cookie)=[^\s&]+/gi, '$1=<redacted>');
}
function sanitizeArgs(args) { return (Array.isArray(args) ? args : []).map((a) => redact(a)); }

// Credential-free --proxy-server / --proxy-bypass-list for a run's proxy (or []).
function proxyArgs(proxy) { return toChromeArgs(proxy); }

const canRead = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

// Authoritative Windows lookup for a non-standard Chrome install: the "App Paths"
// registry key records chrome.exe's full path regardless of install directory.
function registryChromePath() {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  for (const key of keys) {
    try {
      const res = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
      const m = res && res.status === 0 && res.stdout && res.stdout.match(/REG_SZ\s+(.+\.exe)/i);
      if (m && canRead(m[1].trim())) return m[1].trim();
    } catch { /* best effort */ }
  }
  return null;
}

// Discover a Chromium browser to drive over CDP. Order: explicit env override →
// standard Chrome locations (env-derived AND absolute, so a stripped PROGRAMFILES
// doesn't hide a default install) → registry → Chromium-based Edge as a last resort.
// NOTE: this override selects the BINARY only (safe to share across runs); the
// per-run PROFILE and PORT are never overridable, so run isolation is structural.
function findChromeExecutable(env = process.env) {
  const pf = env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : null);
  const chromeRel = 'Google\\Chrome\\Application\\chrome.exe';

  for (const p of [env.OBSERVATORY_CHROME, env.CHROME_PATH]) if (canRead(p)) return p;

  const chromeCandidates = [
    local && path.join(local, chromeRel),
    path.join(pf, chromeRel),
    path.join(pf86, chromeRel),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of chromeCandidates) if (canRead(p)) return p;

  const reg = registryChromePath();
  if (reg) return reg;

  // Last resort: Microsoft Edge is Chromium and speaks the same CDP protocol.
  const edgeRel = 'Microsoft\\Edge\\Application\\msedge.exe';
  for (const p of [path.join(pf86, edgeRel), path.join(pf, edgeRel)]) if (canRead(p)) return p;

  return null;
}

// Prepare the profile so Chrome opens with EXACTLY ONE clean tab (the game URL passed on
// the command line) and NEVER restores a previous session.
//
// ROOT CAUSE this fixes (proven by runtime bisection): a previous crash/close left the
// profile with a saved session; on the next launch Chrome restored those tabs. Over
// repeated crashes the tab count snowballed (observed 8-9 tabs/browser). The app then
// applied its per-target CDP work (Network capture + device emulation + WS hook) to EVERY
// restored target, and driving that many targets access-violated the browser process
// (0xC0000005) ~5-10s in — i.e. the "browsers auto-close after ~10s" symptom AND the
// "extra/overlapping tabs" symptom were the SAME bug. A clean single tab survives full CDP.
//
// We (a) mark the profile as exited-cleanly + disable session restore in Preferences, and
// (b) remove ONLY the session/tab-restore state files. Cookies, Login Data, Local/IndexedDB
// storage, Web Data, etc. are NEVER touched, so the user's login survives close→reopen.
const SESSION_RESTORE_FILES = Object.freeze(['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']);
function ensureChromePersistentSession(profile) {
  try {
    const dir = path.join(profile, 'Default');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(file)) { try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { prefs = {}; } }
    prefs.profile = Object.assign({}, prefs.profile, { exit_type: 'Normal', exited_cleanly: true });
    // restore_on_startup=5 => open the New Tab Page (i.e. do NOT restore the last session).
    // The command-line game URL still opens as the single tab; this only stops restore.
    prefs.session = Object.assign({}, prefs.session, { restore_on_startup: 5, startup_urls: [] });
    fs.writeFileSync(file, JSON.stringify(prefs), 'utf8');
    // Delete stale session/tab-restore state (NOT cookies/login). This is what Chrome reads
    // to reopen previous tabs; removing it guarantees a single fresh tab.
    for (const f of SESSION_RESTORE_FILES) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* best effort */ } }
    try { fs.rmSync(path.join(dir, 'Sessions'), { recursive: true, force: true }); } catch { /* best effort */ }
  } catch { /* best effort */ }
}

class ChromeLauncher {
  constructor({ profilePath, env = process.env, windowSize = DEFAULT_WINDOW, windowPosition = null, mobileTouch = false, chromeExecutable = null, sandboxDisabled = false, onRuntime = () => {}, onExit = () => {}, spawn: spawnFn = spawn, cdp = CDP, proxy = null, probeCdp = defaultProbeCdp, now = () => Date.now(), instanceId = null, livenessWatchMs = 4000 } = {}) {
    this.profilePath = profilePath;               // per-run persistent user-data-dir
    this.env = env;
    // Per-launcher instance id — one launcher owns one browser run for its whole life.
    this.instanceId = instanceId || `LNCH-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // Injectable CDP liveness probe + clock (real defaults; overridden in tests).
    this._probe = typeof probeCdp === 'function' ? probeCdp : defaultProbeCdp;
    this._now = typeof now === 'function' ? now : (() => Date.now());
    // After a TRACKED_PID_REPLACED swap we no longer own the browser's process handle, so
    // a later genuine close is detected by POLLING the CDP endpoint. 0 disables the poll
    // (unit tests that drive exits directly). The timer is always unref'd.
    this._watchIntervalMs = Number.isFinite(livenessWatchMs) ? livenessWatchMs : 4000;
    this._watchTimer = null;
    // Explicit pinned Chromium executable (PHOM custom runtime). null = discover system Chrome.
    this.chromeExecutable = chromeExecutable || null;
    this.windowSize = windowSize || DEFAULT_WINDOW;
    // Optional { x, y } opening position for 2×2 workspace tiling (null = OS default).
    this.windowPosition = windowPosition && Number.isFinite(windowPosition.x) && Number.isFinite(windowPosition.y) ? { x: Math.round(windowPosition.x), y: Math.round(windowPosition.y) } : null;
    // PHOM mobile: browser-level touch events (all tabs) for a consistent mobile view.
    this.mobileTouch = !!mobileTouch;
    // Chromium sandbox is ON by default. This is set true ONLY by the fully-gated
    // dev diagnostic path (resolveSandboxPolicy) — NEVER a production default. The
    // real 0x5 fix is an AppContainer ACL grant on the runtime, not this flag.
    this.sandboxDisabled = !!sandboxDisabled;
    this.onRuntime = onRuntime;
    this.onExit = onExit;
    this._spawn = spawnFn;        // injectable for tests
    this._cdp = cdp;              // injectable for tests
    // Credential-free proxy descriptor { protocol, host, port, bypassList } for THIS
    // run only. null = direct (existing behaviour). Credentials are NEVER on the CLI.
    this.proxy = proxy || null;
    this.process = null;
    this.port = null;
    // ---- exit-classification / instrumentation state ----
    this._appClosing = false;   // set by close()/closeGraceful() ⇒ APP_REQUESTED_CLOSE (no cascade)
    this._cdpEverUp = false;    // becomes true once CDP has answered (attach or probe)
    this._alive = false;        // logical browser liveness (survives a bootstrap PID swap)
    this._spawnedAt = null;     // process spawn timestamp
    this._bootstrapPid = null;  // the ORIGINAL spawned (bootstrap) pid
    this._trackedPid = null;    // the currently-tracked live pid (may be a replacement)
    this._executable = null;    // resolved executable path (instrumentation)
    this._launchArgs = [];      // sanitized launch args (instrumentation)
    this._stderrTail = '';      // bounded, redacted stderr tail
    this.lastExit = null;       // most recent exit record
    this.exitRecords = [];      // bounded history of exit records (instrumentation)
  }

  // Called by the CDP transport once a target attaches — positive evidence the browser
  // fully came up, so a later clean exit can be honestly classified USER_CLOSED_WINDOW.
  markCdpUp() { this._cdpEverUp = true; }

  _recordExit(rec) {
    const full = { instanceId: this.instanceId, cdpPort: this.port, at: this._now(), ...rec };
    this.lastExit = full;
    this.exitRecords.push(full);
    if (this.exitRecords.length > 20) this.exitRecords.shift();
    lifecycleLog('LAUNCHER_EXIT', { instanceId: this.instanceId, port: this.port, bootstrapPid: full.bootstrapPid, reason: full.reason, exitCode: full.exitCode, signal: full.signal, elapsedMs: full.elapsedMs, fired: full.fired, cdpAlive: full.cdpAlive, viaWatcher: !!full.viaWatcher, udd: this.profilePath, stderrTail: (full.stderrTail || '').slice(-400) });
    return full;
  }

  // A fresh OS-assigned free port, owned by THIS run's Chrome for its whole life.
  async cdpPort() {
    if (this.port) return this.port;
    this.port = await allocateFreePort();
    return this.port;
  }

  async open(url) {
    // Prefer an explicit pinned executable (PHOM custom Chromium runtime); otherwise
    // discover the system Chrome (unchanged Control/Aviator behaviour).
    const executable = this.chromeExecutable || findChromeExecutable(this.env);
    if (!executable) return { ok: false, error: { code: 'CHROME_NOT_FOUND', message: 'Chrome executable was not found' } };
    if (!this.profilePath) return { ok: false, error: { code: 'CHROME_PROFILE_MISSING', message: 'No profile directory for this run' } };
    const port = await this.cdpPort();
    const profile = this.profilePath;
    if (this.process && !this.process.killed) {
      return { ok: true, reused: true, endpoint: { host: '127.0.0.1', port }, profile, pid: this.process.pid };
    }
    ensureChromePersistentSession(profile);
    const w = Math.max(1, Number(this.windowSize.width) || DEFAULT_WINDOW.width);
    const h = Math.max(1, Number(this.windowSize.height) || DEFAULT_WINDOW.height);
    const args = [
      // Loopback-only CDP (§11): never bind the debugging port to 0.0.0.0.
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${w},${h}`,   // DEFAULT opening size only; Chrome stays resizable
      // Optional 2×2 tiling position (null adds nothing — unchanged behaviour).
      ...(this.windowPosition ? [`--window-position=${this.windowPosition.x},${this.windowPosition.y}`] : []),
      // Optional browser-level touch events for mobile emulation (null adds nothing).
      ...(this.mobileTouch ? ['--touch-events=enabled'] : []),
      // Sandbox stays ON by default (security boundary). The copied-runtime "Access
      // denied (0x5)" is fixed by granting AppContainer read+execute on the runtime
      // (ensureSandboxAccess), NOT by --no-sandbox. --no-sandbox is added ONLY when the
      // fully-gated dev diagnostic policy set sandboxDisabled — never in production.
      ...(this.sandboxDisabled ? ['--no-sandbox'] : []),
      // Per-run proxy (credential-free). Placed before --new-window/url so it applies to
      // THIS chrome.exe only; a null proxy adds nothing (unchanged direct behaviour).
      ...proxyArgs(this.proxy),
      '--new-window',
      url,
    ];
    // stderr is PIPED (not ignored) so a lock/crash leaves a redacted diagnostic tail;
    // stdin/stdout stay ignored. detached+unref keeps the browser independent of us.
    this._spawnedAt = this._now();
    this._executable = executable;
    this._launchArgs = sanitizeArgs(args);
    this._appClosing = false;
    this._cdpEverUp = false;
    this._stderrTail = '';
    this.process = this._spawn(executable, args, { detached: true, windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
    if (this.process && this.process.unref) this.process.unref();
    this._bootstrapPid = this.process.pid;
    this._trackedPid = this.process.pid;
    this._alive = true;
    lifecycleLog('LAUNCHER_SPAWN', { instanceId: this.instanceId, pid: this.process.pid, port, udd: profile, executable, sandboxDisabled: this.sandboxDisabled });
    if (this.process.stderr && this.process.stderr.on) {
      try { this.process.stderr.unref && this.process.stderr.unref(); } catch { /* ignore */ }
      this.process.stderr.on('data', (chunk) => {
        this._stderrTail = redact((this._stderrTail + String(chunk)).slice(-4096));
      });
      this.process.stderr.on('error', () => { /* stream may drop as chrome exits */ });
    }
    // Do NOT declare the browser dead on the bootstrap `exit`: verify via CDP first.
    this.process.once('exit', (code, signal) => { this._onChildExit(code, signal); });
    this.onRuntime({ cdpPort: port, chromePid: this.process.pid, chromeProfile: profile });
    return { ok: true, reused: false, endpoint: { host: '127.0.0.1', port }, profile, pid: this.process.pid };
  }

  // The tracked (bootstrap) process exited. Decide — with evidence — whether the BROWSER
  // is actually gone. Returns the exit record (also for tests). onExit fires ONLY for a
  // genuine, non-app-initiated close, with an honest reason.
  async _onChildExit(code, signal) {
    const bootstrapPid = this._bootstrapPid;
    const elapsedMs = this._spawnedAt != null ? this._now() - this._spawnedAt : null;
    this.process = null;
    this.onRuntime({ chromePid: null });

    // We asked for the close — authoritative, no probe, no cascade to onExit.
    if (this._appClosing) {
      this._alive = false; this._trackedPid = null; this._stopLivenessWatch();
      return this._recordExit({ reason: EXIT_REASONS.APP_REQUESTED_CLOSE, exitCode: code == null ? null : code, signal: signal || null, elapsedMs, bootstrapPid, cdpAlive: false, cdpEverUp: this._cdpEverUp, fired: false, stderrTail: this._stderrTail, executable: this._executable, userDataDir: this.profilePath, launchArgs: this._launchArgs });
    }

    // Probe: is the browser still answering CDP on our port? (bounded, retried once.)
    let probe = { alive: false };
    for (let i = 0; i < 2 && !(probe && probe.alive); i++) {
      try { probe = await this._probe({ host: '127.0.0.1', port: this.port, timeoutMs: 1500 }); } catch { probe = { alive: false }; }
    }

    if (probe && probe.alive) {
      // TRACKED_PID_REPLACED — the browser lives on a replacement main process. Keep the
      // run OPEN, re-track, and DO NOT fire onExit (this is the auto-close root-cause fix).
      this._cdpEverUp = true;
      this._alive = true;
      this._trackedPid = probe.pid != null ? probe.pid : this._trackedPid;
      // We no longer own the browser's process handle — poll CDP so a later real close is
      // still detected (otherwise the slot would be stuck OPEN forever).
      this._startLivenessWatch();
      return this._recordExit({ reason: EXIT_REASONS.TRACKED_PID_REPLACED, exitCode: code == null ? null : code, signal: signal || null, elapsedMs, bootstrapPid, replacementPid: this._trackedPid, cdpAlive: true, cdpEverUp: true, fired: false, stderrTail: this._stderrTail, executable: this._executable, userDataDir: this.profilePath, launchArgs: this._launchArgs });
    }

    // Genuinely gone. Classify honestly — never a blanket CLOSED_BY_USER.
    this._alive = false;
    this._trackedPid = null;
    const reason = classifyGoneExit({ code, signal, elapsedMs, cdpEverUp: this._cdpEverUp, stderr: this._stderrTail });
    const record = this._recordExit({ reason, exitCode: code == null ? null : code, signal: signal || null, elapsedMs, bootstrapPid, cdpAlive: false, cdpEverUp: this._cdpEverUp, fired: true, stderrTail: this._stderrTail, executable: this._executable, userDataDir: this.profilePath, launchArgs: this._launchArgs });
    try { this.onExit(record); } catch { /* best effort */ }
    return record;
  }

  // Poll CDP after a TRACKED_PID_REPLACED swap. When the replacement browser finally stops
  // answering, fire onExit ONCE with an honest reason. Disabled when _watchIntervalMs<=0.
  _startLivenessWatch() {
    if (this._watchTimer || !(this._watchIntervalMs > 0)) return;
    const schedule = () => {
      this._watchTimer = setTimeout(run, this._watchIntervalMs);
      if (this._watchTimer && this._watchTimer.unref) this._watchTimer.unref();  // never keeps the app alive
    };
    const run = async () => {
      this._watchTimer = null;
      if (!this._alive || this._appClosing) return;
      let probe = { alive: false };
      try { probe = await this._probe({ host: '127.0.0.1', port: this.port, timeoutMs: 1500 }); } catch { probe = { alive: false }; }
      if (!this._alive || this._appClosing) return;
      if (probe && probe.alive) { if (probe.pid != null) this._trackedPid = probe.pid; schedule(); return; }
      // The replacement browser is now gone for real.
      this._alive = false; this._trackedPid = null;
      const reason = this._cdpEverUp ? EXIT_REASONS.USER_CLOSED_WINDOW : EXIT_REASONS.UNKNOWN_EXIT;
      const record = this._recordExit({ reason, exitCode: null, signal: null, elapsedMs: null, bootstrapPid: this._bootstrapPid, cdpAlive: false, cdpEverUp: this._cdpEverUp, fired: true, viaWatcher: true, stderrTail: this._stderrTail, executable: this._executable, userDataDir: this.profilePath, launchArgs: this._launchArgs });
      try { this.onExit(record); } catch { /* best effort */ }
    };
    schedule();
  }
  _stopLivenessWatch() { if (this._watchTimer) { try { clearTimeout(this._watchTimer); } catch { /* ignore */ } this._watchTimer = null; } }

  // Terminate the browser this launcher owns (used when a BrowserRun is closed
  // from the app rather than by the user closing the window). Best effort.
  close() {
    lifecycleLog('LAUNCHER_CLOSE', { instanceId: this.instanceId, pid: this._trackedPid, stack: (new Error().stack || '').split('\n').slice(1, 6).join(' | ') });
    this._appClosing = true;   // mark app-initiated so the exit is APP_REQUESTED_CLOSE (no cascade)
    this._alive = false;
    this._stopLivenessWatch();
    const proc = this.process;
    if (proc && !proc.killed) { try { proc.kill(); } catch { /* already gone */ } }
    this.process = null;
  }

  // WU-E.1B — graceful close so Chrome FLUSHES its profile (cookies/login) to disk before
  // exiting. A hard kill (close()) can drop lazily-committed cookies, so a login set shortly
  // before close is lost. We ask Chrome to close via CDP Browser.close, wait a BOUNDED time
  // for the process to exit, then FORCE KILL if it is still alive — so the D2-001 guarantee
  // (no phantom Chrome, no stuck profile lock) is preserved even if graceful close hangs.
  async closeGraceful(timeoutMs = 3500) {
    lifecycleLog('LAUNCHER_CLOSE_GRACEFUL', { instanceId: this.instanceId, pid: this._trackedPid, stack: (new Error().stack || '').split('\n').slice(1, 6).join(' | ') });
    this._appClosing = true;   // app-initiated ⇒ APP_REQUESTED_CLOSE (never a spurious user-close)
    this._stopLivenessWatch();
    const proc = this.process;
    if (!proc || proc.killed) { this.process = null; this._alive = false; return { ok: true, graceful: false, reason: 'not-running' }; }
    const exited = new Promise((res) => proc.once('exit', () => res(true)));
    const port = this.port;
    // Fire the graceful close request but NEVER block on it: a frozen Chrome could make
    // Browser.close hang forever, which would hang Close/quit. The exit-or-timeout race
    // below bounds the whole method regardless, and force-kills on timeout (D2-001 safe).
    if (port) {
      (async () => {
        try {
          const client = await this._cdp({ host: '127.0.0.1', port });
          try { await client.Browser.close(); } catch { /* chrome may drop the socket as it exits */ }
          try { await client.close(); } catch { /* connection dropped by Browser.close */ }
        } catch { /* CDP unreachable — force kill happens on timeout */ }
      })();
    }
    const timedOut = await Promise.race([exited.then(() => false), new Promise((res) => setTimeout(() => res(true), Math.max(500, timeoutMs)))]);
    if (timedOut && proc && !proc.killed) { try { proc.kill(); } catch { /* already gone */ } }
    this.process = null;
    this._alive = false;
    return { ok: true, graceful: !timedOut, forced: !!timedOut };
  }

  // Liveness reflects the BROWSER, not the bootstrap process handle: it survives a
  // TRACKED_PID_REPLACED swap (bootstrap gone, browser alive on a replacement PID).
  alive() { return !!this._alive; }

  snapshot() {
    return {
      instanceId: this.instanceId,
      cdpPort: this.port,
      // Report the tracked live pid (a replacement main pid survives a bootstrap swap);
      // null only when the browser is actually gone.
      chromePid: this._alive ? this._trackedPid : null,
      bootstrapPid: this._bootstrapPid,
      chromeProfile: this.profilePath,
      executable: this._executable,
      alive: this._alive,
      spawnedAt: this._spawnedAt,
      lastExit: this.lastExit,
    };
  }
}

module.exports = { ChromeLauncher, findChromeExecutable, ensureChromePersistentSession, DEFAULT_WINDOW, EXIT_REASONS, classifyGoneExit, defaultProbeCdp, lifecycleLog };
