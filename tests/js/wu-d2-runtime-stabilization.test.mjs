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
const { ChromeLauncher, findChromeExecutable } = require('../../desktop/browser/chrome-launcher.cjs');
const { TargetManager } = require('../../desktop/cdp/target-manager.cjs');
const CDP = require('chrome-remote-interface');

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
// D2-002 — a run that never attached and whose Chrome exits must become an
// actionable ERROR (retryable, non-terminal), carrying the precise code.
// ---------------------------------------------------------------------------
test('D2-002: early Chrome exit surfaces ERROR/CHROME_EXITED_BEFORE_CDP (retryable)', () => {
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ open: async () => ({ ok: true }), close: () => {} }),
    createTargetManager: () => ({}),
    buildSubsystem: () => ({}),
  });
  const run = mgr.createRun({ browserId: 'B-0001', profileDir: 'x' });
  assert.equal(run.status, STATUS.STARTING);
  // Simulate the onExit-while-STARTING path from main.createRunLauncher.
  mgr.failRun(run, { code: 'CHROME_EXITED_BEFORE_CDP', message: 'exited before CDP' });
  const s = mgr.summary(run);
  assert.equal(s.status, STATUS.ERROR);
  assert.equal(s.error.code, 'CHROME_EXITED_BEFORE_CDP');
  // ERROR is NOT terminal: the browser can be closed then reopened ("Mở lại").
  assert.equal(mgr.liveRunForBrowser('B-0001').id, run.id);
});

// ---------------------------------------------------------------------------
// D2-001 / D2-002 — assert main.cjs is actually wired for shutdown cleanup and
// actionable early-exit (mirrors the existing "main process is wired" source test).
// ---------------------------------------------------------------------------
test('D2-001: main.cjs terminates managed Chrome on quit and reports early exit', () => {
  const main = require('node:fs').readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(/function killAllManagedBrowsers\s*\(/.test(main), 'defines killAllManagedBrowsers');
  assert.ok(/before-quit[\s\S]{0,120}killAllManagedBrowsers\(\)/.test(main), 'before-quit kills managed Chrome');
  assert.ok(/will-quit[\s\S]{0,80}killAllManagedBrowsers\(\)/.test(main), 'will-quit kills managed Chrome');
  assert.ok(/CHROME_EXITED_BEFORE_CDP/.test(main), 'surfaces CHROME_EXITED_BEFORE_CDP on early exit');
});

// ---------------------------------------------------------------------------
// REAL browser-launch smoke — actually spawns the configured Chrome, verifies the
// CDP endpoint answers and a page target is discoverable via the real TargetManager,
// then confirms close frees the profile for a reliable reopen. Skips ONLY if Chrome
// is genuinely not installed (never faked).
// ---------------------------------------------------------------------------
test('REAL smoke: managed Chrome spawns, CDP reachable, target attaches, reopen works', { timeout: 60000 }, async (t) => {
  const exe = findChromeExecutable();
  if (!exe || !existsSync(exe)) { t.skip('Chrome executable not found on this machine'); return; }

  const base = tempBase();
  const profile = join(base, 'profiles', 'B-0001');
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitCdp = async (host, port) => { for (let i = 0; i < 20; i++) { try { return await CDP.List({ host, port }); } catch { await new Promise((r) => setTimeout(r, 500)); } } return null; };

  let l1, l2, tm;
  try {
    // 1) real spawn + CDP
    l1 = new ChromeLauncher({ profilePath: profile, env: {} });
    const r1 = await l1.open('https://example.com');
    assert.equal(r1.ok, true, 'launcher reports ok');
    assert.ok(r1.pid > 0, 'has a pid');
    const list = await waitCdp(r1.endpoint.host, r1.endpoint.port);
    assert.ok(list && list.length, 'CDP endpoint reachable with targets');

    // 2) real TargetManager attaches a page target
    tm = new TargetManager({ host: r1.endpoint.host, port: r1.endpoint.port, pollIntervalMs: 400 });
    const attached = await new Promise((resolve) => { tm.once('attached', ({ target }) => resolve(target)); tm.start().catch(() => {}); });
    assert.ok(attached && attached.cdpTargetId, 'TargetManager attached a real target');
    await tm.stop(); tm = null;

    // 3) close frees the profile; reopen on the SAME profile spawns a fresh CDP endpoint
    l1.close(); l1 = null;
    await new Promise((r) => setTimeout(r, 2000));
    l2 = new ChromeLauncher({ profilePath: profile, env: {} });
    const r2 = await l2.open('https://example.com');
    const list2 = await waitCdp(r2.endpoint.host, r2.endpoint.port);
    assert.ok(list2 && list2.length, 'reopen on the same profile is reliable (profile was freed)');
    assert.equal(pidAlive(r2.pid), true, 'reopened Chrome is alive');
  } finally {
    try { if (tm) await tm.stop(); } catch { /* ignore */ }
    try { if (l1) l1.close(); } catch { /* ignore */ }
    try { if (l2) l2.close(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(base, { recursive: true, force: true });
  }
});
