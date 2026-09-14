import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ensureChromePersistentSession } = require('../../desktop/browser/chrome-launcher.cjs');
const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

// ROOT CAUSE (runtime-proven): persistent profiles restored accumulated (crashed) tabs;
// the app then applied per-target CDP work across all restored targets and the browser
// access-violated (0xC0000005) ~10s in — the "auto-close after 10s" AND "extra tabs" bugs
// were the same bug. Fix: prepare the profile for exactly ONE clean tab (no session
// restore), WITHOUT touching cookies/login.

test('ensureChromePersistentSession removes session/tab-restore state so only one tab opens', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-sess-'));
  const def = path.join(profile, 'Default');
  fs.mkdirSync(def, { recursive: true });
  // simulate a profile left over from prior runs: restore state + login/cookies present
  fs.writeFileSync(path.join(def, 'Current Session'), 'binary-session');
  fs.writeFileSync(path.join(def, 'Current Tabs'), 'binary-tabs');
  fs.writeFileSync(path.join(def, 'Last Session'), 'binary-last-session');
  fs.writeFileSync(path.join(def, 'Last Tabs'), 'binary-last-tabs');
  fs.mkdirSync(path.join(def, 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(def, 'Sessions', 'Session_123'), 'x');
  // login/cookie artifacts that MUST survive
  fs.writeFileSync(path.join(def, 'Cookies'), 'COOKIEDB');
  fs.writeFileSync(path.join(def, 'Login Data'), 'LOGINDB');
  fs.mkdirSync(path.join(def, 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(def, 'Local Storage', 'leveldb.txt'), 'LS');

  ensureChromePersistentSession(profile);

  // session/tab restore state is gone
  for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    assert.equal(fs.existsSync(path.join(def, f)), false, `${f} must be cleared`);
  }
  assert.equal(fs.existsSync(path.join(def, 'Sessions')), false, 'Sessions dir must be cleared');
  // login/cookies untouched
  assert.equal(fs.readFileSync(path.join(def, 'Cookies'), 'utf8'), 'COOKIEDB', 'Cookies preserved');
  assert.equal(fs.readFileSync(path.join(def, 'Login Data'), 'utf8'), 'LOGINDB', 'Login Data preserved');
  assert.equal(fs.readFileSync(path.join(def, 'Local Storage', 'leveldb.txt'), 'utf8'), 'LS', 'Local Storage preserved');
  // Preferences mark exited-cleanly + disable restore
  const prefs = JSON.parse(fs.readFileSync(path.join(def, 'Preferences'), 'utf8'));
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.session.restore_on_startup, 5, 'restore_on_startup=5 (no session restore)');
  assert.deepEqual(prefs.session.startup_urls, []);
  fs.rmSync(profile, { recursive: true, force: true });
});

test('ensureChromePersistentSession merges into an existing Preferences without dropping other keys', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-sess2-'));
  const def = path.join(profile, 'Default');
  fs.mkdirSync(def, { recursive: true });
  fs.writeFileSync(path.join(def, 'Preferences'), JSON.stringify({ profile: { name: 'keep-me' }, extensions: { x: 1 } }));
  ensureChromePersistentSession(profile);
  const prefs = JSON.parse(fs.readFileSync(path.join(def, 'Preferences'), 'utf8'));
  assert.equal(prefs.profile.name, 'keep-me', 'existing profile keys preserved');
  assert.equal(prefs.extensions.x, 1, 'unrelated pref trees preserved');
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.session.restore_on_startup, 5);
  fs.rmSync(profile, { recursive: true, force: true });
});

// DIRECT-network fix: the cluster projection is authoritative for proxy. The cluster's
// openProfile wrapper must pass the resolved proxyRef EXPLICITLY (null = DIRECT), never
// `undefined` — which made openProfile silently fall back to the per-slot profile's stale
// proxyRef (a dead proxy) and break DIRECT networking.
test('cluster openProfile passes proxyRef explicitly (null=DIRECT), never falls back to stale ref', () => {
  const main = read('desktop/phom-main.cjs');
  const wrap = main.slice(main.indexOf('openProfile: (slot, cfg) => openProfile({'), main.indexOf('getRunClient: runClientFor'));
  assert.match(wrap, /proxyRef:\s*\(cfg && cfg\.proxyRef\)\s*\?\s*cfg\.proxyRef\s*:\s*null/, 'null passed explicitly = DIRECT');
  assert.equal(/proxyRef:\s*\(cfg && cfg\.proxyRef\)\s*\|\|\s*undefined/.test(wrap), false, 'the undefined-fallback bug is gone');
});
