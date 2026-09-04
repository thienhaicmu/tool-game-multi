import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { instancePaths, sanitizeInstanceId } = require('../../desktop/instance/paths.cjs');
const { RuntimeLock } = require('../../desktop/instance/runtime-lock.cjs');
const { InstanceManager, DEFAULT_INSTANCE_ID } = require('../../desktop/instance/instance-manager.cjs');
const { ChromeLauncher, findChromeExecutable } = require('../../desktop/browser/chrome-launcher.cjs');

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wso-inst-'));
}

test('instance paths isolate sessions, cookies, window state and Chrome profile', () => {
  const base = 'C:\\Users\\me\\AppData\\Roaming\\web-security-observatory-ui';
  const a = instancePaths(base, 'alpha');
  const b = instancePaths(base, 'beta');
  assert.notEqual(a.root, b.root);
  assert.ok(a.sessions.endsWith(join('instances', 'alpha', 'sessions')));
  assert.ok(a.cookieVault.endsWith(join('instances', 'alpha', 'cookie-vault.json')));
  assert.ok(a.windowState.endsWith(join('instances', 'alpha', 'window-state.json')));
  assert.ok(a.chromeProfile.endsWith(join('instances', 'alpha', 'chrome-profile')));
});

test('instance id is filesystem-safe and bounded', () => {
  assert.equal(sanitizeInstanceId(' abc/def:ghi '), 'abc-def-ghi');
  assert.equal(sanitizeInstanceId(''), '');
  assert.ok(sanitizeInstanceId('x'.repeat(200)).length <= 80);
});

test('runtime lock blocks a live process and clears stale locks', () => {
  const dir = tempRoot();
  try {
    const file = join(dir, 'runtime.lock.json');
    const first = new RuntimeLock(file, { instanceId: 'one' });
    assert.equal(first.acquire().ok, true);
    const second = new RuntimeLock(file, { instanceId: 'one' });
    assert.equal(second.acquire().ok, false, 'same live pid is locked');
    first.release();

    const stale = new RuntimeLock(file, { instanceId: 'one' });
    stale.data = { pid: 99999999 };
    stale.acquired = true;
    stale.update({ pid: 99999999 });
    stale.acquired = false;
    const takeover = new RuntimeLock(file, { instanceId: 'one' });
    assert.equal(takeover.acquire().ok, true, 'stale lock can be replaced');
    takeover.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// WU-D.2 (D2-003): a no-argument (customer double-click) launch MUST resolve to a
// STABLE instance id across restarts, so the persistent browser registry, per-browser
// configs, round history, chrome profiles and cookies survive a quit/relaunch. The old
// behaviour minted a random UUID per launch, which is exactly why created browsers
// vanished after restart ("0/10 — Chưa có trình duyệt").
test('default (no-arg) launch resolves to a STABLE instance so data persists across restart', () => {
  const dir = tempRoot();
  try {
    const first = new InstanceManager({ baseUserDataPath: dir, argv: ['app'], env: {} }).start();
    assert.equal(first.ok, true);
    assert.equal(first.instanceId, DEFAULT_INSTANCE_ID);
    const firstRoot = first.paths.root;
    const firstProfile = first.paths.chromeProfile;
    first.lock.release(); // simulate app quit

    // Relaunch (same no-arg invocation) must reuse the SAME on-disk store.
    const second = new InstanceManager({ baseUserDataPath: dir, argv: ['app'], env: {} }).start();
    assert.equal(second.ok, true);
    assert.equal(second.instanceId, DEFAULT_INSTANCE_ID);
    assert.equal(second.paths.root, firstRoot, 'restart must reuse the same instance root');
    assert.equal(second.paths.chromeProfile, firstProfile, 'restart must reuse the same chrome profile');
    second.lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A second concurrent default launch is refused by the runtime lock (single owner),
// while an explicit --instance-id still selects a SEPARATE isolated store.
test('concurrent default launch is refused; explicit --instance-id isolates a distinct store', () => {
  const dir = tempRoot();
  try {
    const a = new InstanceManager({ baseUserDataPath: dir, argv: ['app'], env: {} }).start();
    const b = new InstanceManager({ baseUserDataPath: dir, argv: ['app'], env: {} }).start();
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.error.code, 'INSTANCE_ALREADY_RUNNING');

    const other = new InstanceManager({ baseUserDataPath: dir, argv: ['app', '--instance-id=desk-2'], env: {} }).start();
    assert.equal(other.ok, true);
    assert.notEqual(other.paths.root, a.paths.root);
    assert.notEqual(other.paths.chromeProfile, a.paths.chromeProfile);
    a.lock.release();
    other.lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('instance manager honors explicit instance id and prevents duplicate active ownership', () => {
  const dir = tempRoot();
  try {
    const a = new InstanceManager({ baseUserDataPath: dir, argv: ['app', '--instance-id=desk-1'], env: {} }).start();
    const b = new InstanceManager({ baseUserDataPath: dir, argv: ['app', '--instance-id=desk-1'], env: {} }).start();
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.error.code, 'INSTANCE_ALREADY_RUNNING');
    a.lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ChromeLauncher keeps profile per instance and uses configured port only as an override', async () => {
  const launcher = new ChromeLauncher({ profilePath: 'X:\\profiles\\one', env: { OBSERVATORY_CDP_PORT: '9555' } });
  assert.equal(await launcher.cdpPort(), 9555);
  assert.equal(launcher.snapshot().chromeProfile, 'X:\\profiles\\one');

  const isolated = new ChromeLauncher({ profilePath: 'X:\\profiles\\two', env: {} });
  const port = await isolated.cdpPort();
  assert.equal(Number.isInteger(port), true);
  assert.ok(port > 0);
  assert.equal(await isolated.cdpPort(), port, 'port is stable for the launcher instance');
});

// Chrome discovery must be robust across customer machines: explicit overrides win,
// and a missing/stripped env must NOT hide a browser that actually exists on disk.
test('findChromeExecutable honors explicit overrides and does not depend on env vars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-exe-'));
  const fake = join(dir, 'chrome.exe');
  writeFileSync(fake, 'x');
  try {
    // 1) explicit overrides are authoritative
    assert.equal(findChromeExecutable({ CHROME_PATH: fake }), fake);
    assert.equal(findChromeExecutable({ OBSERVATORY_CHROME: fake }), fake);
    // 2) OBSERVATORY_CHROME takes precedence over CHROME_PATH
    assert.equal(findChromeExecutable({ OBSERVATORY_CHROME: fake, CHROME_PATH: 'X:/nope.exe' }), fake);
    // 3) a non-existent override + empty env resolves to a real path or null — never throws
    const res = findChromeExecutable({ CHROME_PATH: 'X:/does/not/exist.exe' });
    assert.ok(res === null || typeof res === 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main process is wired to instance-owned storage and browser runtime', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(/new InstanceManager/.test(main));
  assert.ok(/app\.setPath\('userData', appInstance\.paths\.appData\)/.test(main));
  assert.ok(/appInstance\.paths\.sessions/.test(main));
  assert.ok(/appInstance\.paths\.cookieVault/.test(main));
  assert.ok(/appInstance\.paths\.windowState/.test(main));
  assert.ok(/new ChromeLauncher/.test(main));
  assert.ok(/handle\('instance-info'/.test(main));
  // WU-C.4 supersedes the earlier multi-instance policy: the customer app now enforces
  // single-instance ownership (via the single-instance seam) before product runtime.
  assert.ok(/acquireSingleInstance/.test(main), 'WU-C.4: customer app enforces single-instance ownership');
  assert.ok(/singleInstance\.primary/.test(main), 'WU-C.4: secondary launches do not initialize product runtime');
});
