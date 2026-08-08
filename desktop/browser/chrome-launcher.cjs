'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { allocateFreePort } = require('./port-allocator.cjs');

function findChromeExecutable(env = process.env) {
  const candidates = [
    env.OBSERVATORY_CHROME,
    env.CHROME_PATH,
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
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
  constructor({ profilePath, env = process.env, onRuntime = () => {} } = {}) {
    this.profilePath = profilePath;
    this.env = env;
    this.onRuntime = onRuntime;
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
    });
    this.onRuntime({ cdpPort: port, chromePid: this.process.pid, chromeProfile: profile });
    return { ok: true, reused: false, endpoint: { host: '127.0.0.1', port }, profile, pid: this.process.pid };
  }

  snapshot() {
    return { cdpPort: this.port, chromePid: this.process && !this.process.killed ? this.process.pid : null, chromeProfile: this.env.OBSERVATORY_CHROME_PROFILE || this.profilePath };
  }
}

module.exports = { ChromeLauncher, findChromeExecutable, ensureChromePersistentSession };
