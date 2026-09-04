'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { allocateFreePort } = require('./port-allocator.cjs');

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

function ensureChromePersistentSession(profile) {
  try {
    const dir = path.join(profile, 'Default');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(file)) { try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { prefs = {}; } }
    prefs.session = Object.assign({}, prefs.session, { restore_on_startup: 1 });
    prefs.profile = Object.assign({}, prefs.profile, { exit_type: 'Normal', exited_cleanly: true });
    fs.writeFileSync(file, JSON.stringify(prefs), 'utf8');
  } catch { /* best effort */ }
}

class ChromeLauncher {
  constructor({ profilePath, env = process.env, onRuntime = () => {}, onExit = () => {} } = {}) {
    this.profilePath = profilePath;
    this.env = env;
    this.onRuntime = onRuntime;
    this.onExit = onExit;
    this.process = null;
    this.port = null;
  }

  async cdpPort() {
    const configured = Number(this.env.OBSERVATORY_CDP_PORT || 0);
    if (Number.isInteger(configured) && configured > 0) return configured;
    if (this.port) return this.port;
    this.port = await allocateFreePort();
    return this.port;
  }

  async open(url) {
    const executable = findChromeExecutable(this.env);
    if (!executable) return { ok: false, error: { code: 'CHROME_NOT_FOUND', message: 'Chrome executable was not found' } };
    const port = await this.cdpPort();
    const profile = this.env.OBSERVATORY_CHROME_PROFILE || this.profilePath;
    if (this.process && !this.process.killed) {
      return { ok: true, reused: true, endpoint: { host: '127.0.0.1', port }, profile, pid: this.process.pid };
    }
    ensureChromePersistentSession(profile);
    const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--restore-last-session', '--new-window', url];
    this.process = spawn(executable, args, { detached: true, windowsHide: false, stdio: 'ignore' });
    this.process.unref();
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

  snapshot() {
    return { cdpPort: this.port, chromePid: this.process && !this.process.killed ? this.process.pid : null, chromeProfile: this.env.OBSERVATORY_CHROME_PROFILE || this.profilePath };
  }
}

module.exports = { ChromeLauncher, findChromeExecutable, ensureChromePersistentSession };
