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
const { spawn, spawnSync } = require('node:child_process');
const { allocateFreePort } = require('./port-allocator.cjs');
const { toChromeArgs } = require('../browser-run/proxy-config.cjs');
const CDP = require('chrome-remote-interface');

const DEFAULT_WINDOW = Object.freeze({ width: 720, height: 405 });

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

// Mark the profile as having exited cleanly so Chrome does not show the "restore
// pages?" / crash bubble on the next open. We do NOT force restore_on_startup: the
// game URL is passed explicitly on launch and cookies/login persist via the profile
// directory regardless, so there is no need to reopen stale tabs.
function ensureChromePersistentSession(profile) {
  try {
    const dir = path.join(profile, 'Default');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(file)) { try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { prefs = {}; } }
    prefs.profile = Object.assign({}, prefs.profile, { exit_type: 'Normal', exited_cleanly: true });
    fs.writeFileSync(file, JSON.stringify(prefs), 'utf8');
  } catch { /* best effort */ }
}

class ChromeLauncher {
  constructor({ profilePath, env = process.env, windowSize = DEFAULT_WINDOW, windowPosition = null, mobileTouch = false, onRuntime = () => {}, onExit = () => {}, spawn: spawnFn = spawn, cdp = CDP, proxy = null } = {}) {
    this.profilePath = profilePath;               // per-run persistent user-data-dir
    this.env = env;
    this.windowSize = windowSize || DEFAULT_WINDOW;
    // Optional { x, y } opening position for 2×2 workspace tiling (null = OS default).
    this.windowPosition = windowPosition && Number.isFinite(windowPosition.x) && Number.isFinite(windowPosition.y) ? { x: Math.round(windowPosition.x), y: Math.round(windowPosition.y) } : null;
    // PHOM mobile: browser-level touch events (all tabs) for a consistent mobile view.
    this.mobileTouch = !!mobileTouch;
    this.onRuntime = onRuntime;
    this.onExit = onExit;
    this._spawn = spawnFn;        // injectable for tests
    this._cdp = cdp;              // injectable for tests
    // Credential-free proxy descriptor { protocol, host, port, bypassList } for THIS
    // run only. null = direct (existing behaviour). Credentials are NEVER on the CLI.
    this.proxy = proxy || null;
    this.process = null;
    this.port = null;
  }

  // A fresh OS-assigned free port, owned by THIS run's Chrome for its whole life.
  async cdpPort() {
    if (this.port) return this.port;
    this.port = await allocateFreePort();
    return this.port;
  }

  async open(url) {
    const executable = findChromeExecutable(this.env);
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
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${w},${h}`,   // DEFAULT opening size only; Chrome stays resizable
      // Optional 2×2 tiling position (null adds nothing — unchanged behaviour).
      ...(this.windowPosition ? [`--window-position=${this.windowPosition.x},${this.windowPosition.y}`] : []),
      // Optional browser-level touch events for mobile emulation (null adds nothing).
      ...(this.mobileTouch ? ['--touch-events=enabled'] : []),
      // Per-run proxy (credential-free). Placed before --new-window/url so it applies to
      // THIS chrome.exe only; a null proxy adds nothing (unchanged direct behaviour).
      ...proxyArgs(this.proxy),
      '--new-window',
      url,
    ];
    this.process = this._spawn(executable, args, { detached: true, windowsHide: false, stdio: 'ignore' });
    if (this.process && this.process.unref) this.process.unref();
    this.process.once('exit', () => {
      this.process = null;
      this.onRuntime({ chromePid: null });
      try { this.onExit(); } catch { /* best effort */ }
    });
    this.onRuntime({ cdpPort: port, chromePid: this.process.pid, chromeProfile: profile });
    return { ok: true, reused: false, endpoint: { host: '127.0.0.1', port }, profile, pid: this.process.pid };
  }

  // Terminate the browser this launcher owns (used when a BrowserRun is closed
  // from the app rather than by the user closing the window). Best effort.
  close() {
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
    const proc = this.process;
    if (!proc || proc.killed) { this.process = null; return { ok: true, graceful: false, reason: 'not-running' }; }
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
    return { ok: true, graceful: !timedOut, forced: !!timedOut };
  }

  snapshot() {
    return {
      cdpPort: this.port,
      chromePid: this.process && !this.process.killed ? this.process.pid : null,
      chromeProfile: this.profilePath,
    };
  }
}

module.exports = { ChromeLauncher, findChromeExecutable, ensureChromePersistentSession, DEFAULT_WINDOW };
