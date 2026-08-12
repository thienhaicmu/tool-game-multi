import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { instancePaths, sanitizeInstanceId } = require('../../desktop/instance/paths.cjs');
const { RuntimeLock } = require('../../desktop/instance/runtime-lock.cjs');
const { InstanceManager } = require('../../desktop/instance/instance-manager.cjs');
const { ChromeLauncher } = require('../../desktop/browser/chrome-launcher.cjs');

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

test('instance manager creates registry and distinct default instances', () => {
  const dir = tempRoot();
  try {
    const a = new InstanceManager({ baseUserDataPath: dir, argv: ['app'], env: {} }).start();
    const b = new InstanceManager({ baseUserDataPath: dir, argv: ['app'], env: {} }).start();
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.instanceId, b.instanceId);
    assert.notEqual(a.paths.chromeProfile, b.paths.chromeProfile);
    a.lock.release();
    b.lock.release();
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

test('main process is wired to instance-owned storage and browser runtime', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(/new InstanceManager/.test(main));
  assert.ok(/app\.setPath\('userData', appInstance\.paths\.appData\)/.test(main));
  assert.ok(/appInstance\.paths\.sessions/.test(main));
  assert.ok(/appInstance\.paths\.cookieVault/.test(main));
  assert.ok(/appInstance\.paths\.windowState/.test(main));
  assert.ok(/new ChromeLauncher/.test(main));
  assert.ok(/handle\('instance-info'/.test(main));
  assert.ok(!/requestSingleInstanceLock/.test(main), 'global single-instance lock is not used');
});
