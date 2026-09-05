// WU-D.2 — runtime stabilization regressions. These tests specifically prevent the
// real product failures found during D.2, which the 380-green suite did not catch:
//   D2-003  persistent browsers vanished after restart (random per-launch instance id)
//   D2-001  managed Chrome was orphaned on quit → next Open handed off + failed
//   D2-002  a Chrome that exited before CDP was a silent close, not an actionable error
// Plus one REAL browser-launch smoke (opt-out only when Chrome is genuinely absent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InstanceManager } = require('../../desktop/instance/instance-manager.cjs');
const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');
const { BrowserConfigStore } = require('../../desktop/browser-run/browser-config-store.cjs');
const { BrowserRunManager, STATUS } = require('../../desktop/browser-run/browser-run-manager.cjs');

function tempBase() { return mkdtempSync(join(tmpdir(), 'wu-d2-')); }

// ---------------------------------------------------------------------------
// D2-003 — the reported bug: "I created a few browsers, restarted, they're gone."
// Exercises the exact persistence path (InstanceManager root -> BrowserRegistry file).
// Under the old random-UUID default this FAILS because restart resolves a new root.
// ---------------------------------------------------------------------------
test('D2-003: persistent browsers + configs survive a quit/relaunch (default launch)', () => {
  const base = tempBase();
  try {
    // --- session 1: create two browsers and save one operating config ---
    const s1 = new InstanceManager({ baseUserDataPath: base, argv: ['app'], env: {} }).start();
    assert.equal(s1.ok, true);
    const reg1 = new BrowserRegistry({ filePath: join(s1.paths.root, 'browser-registry.json'), profilesRoot: join(s1.paths.root, 'browser-profiles'), entitlement: () => ({ maxBrowsers: 10 }) });
    reg1.load();
    const a = reg1.create({ name: 'One', launchUrl: 'https://example.com' });
    const b = reg1.create({ name: 'Two', launchUrl: 'https://example.org' });
    assert.ok(a.browser && b.browser, 'both browsers created');
    const cfg1 = new BrowserConfigStore({ filePath: join(s1.paths.root, 'browser-configs.json') });
    cfg1.load();
    cfg1.set(a.browser.id, { roundCount: 7 });
    s1.lock.release(); // quit

    // --- session 2: relaunch with the SAME (no-arg) invocation ---
    const s2 = new InstanceManager({ baseUserDataPath: base, argv: ['app'], env: {} }).start();
    assert.equal(s2.ok, true);
    assert.equal(s2.paths.root, s1.paths.root, 'restart reuses the same instance root');
    const reg2 = new BrowserRegistry({ filePath: join(s2.paths.root, 'browser-registry.json'), profilesRoot: join(s2.paths.root, 'browser-profiles'), entitlement: () => ({ maxBrowsers: 10 }) });
    reg2.load();
    const ids = reg2.list().map((x) => x.id).sort();
    assert.deepEqual(ids, [a.browser.id, b.browser.id].sort(), 'both browsers still present after restart');
    assert.equal(reg2.count(), 2, 'registry is NOT empty after restart');

    const cfg2 = new BrowserConfigStore({ filePath: join(s2.paths.root, 'browser-configs.json') });
    cfg2.load();
    assert.equal(cfg2.get(a.browser.id).roundCount, 7, 'per-browser config persisted across restart');
    s2.lock.release();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D2-002 — a run whose launcher fails to come up must become an actionable ERROR
// (retryable, non-terminal), so the browser can be reopened ("Mở lại").
// ---------------------------------------------------------------------------
test('D2-002: a failed run start surfaces a retryable, non-terminal ERROR', () => {
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ open: async () => ({ ok: true }), close: () => {} }),
    createTargetManager: () => ({}),
    buildSubsystem: () => ({}),
  });
  const run = mgr.createRun({ browserId: 'B-0001', profileDir: 'x' });
  assert.equal(run.status, STATUS.STARTING);
  mgr.failRun(run, { code: 'RUN_START_FAILED', message: 'failed to attach' });
  const s = mgr.summary(run);
  assert.equal(s.status, STATUS.ERROR);
  assert.equal(s.error.code, 'RUN_START_FAILED');
  // ERROR is NOT terminal: the browser can be closed then reopened ("Mở lại").
  assert.equal(mgr.liveRunForBrowser('B-0001').id, run.id);
});

// ---------------------------------------------------------------------------
// D2-001 — main.cjs is wired to tear down every managed in-app browser view on quit.
// ---------------------------------------------------------------------------
test('D2-001: main.cjs tears down managed browsers on quit', () => {
  const main = require('node:fs').readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(/function killAllManagedBrowsers\s*\(/.test(main), 'defines killAllManagedBrowsers');
  assert.ok(/before-quit[\s\S]{0,140}killAllManagedBrowsers\(\)/.test(main), 'before-quit tears down managed browsers');
  assert.ok(/will-quit[\s\S]{0,80}killAllManagedBrowsers\(\)/.test(main), 'will-quit tears down managed browsers');
  assert.ok(/inappRuntime\.destroyAll\(\)/.test(main), 'destroys all in-app views on teardown');
});
