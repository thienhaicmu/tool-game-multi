import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');
const { BrowserRunManager, STATUS } = require('../../desktop/browser-run/browser-run-manager.cjs');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wvpt-link-')); }
function makeRegistry(root, entitlement) {
  return new BrowserRegistry({ filePath: path.join(root, 'reg.json'), profilesRoot: path.join(root, 'profiles'), entitlement: entitlement || (() => ({ maxBrowsers: null })) });
}
// Minimal fake subsystem so the manager can create/close runs without Chrome.
function fakeSubsystem() {
  let auto = false;
  return {
    aviator: {}, protocolContext: { get: () => ({ ready: false }), reset() {} },
    observer: { onDisconnect() {}, currentRound() { return null; } },
    autoRunner: { isRunning: () => auto, start() { auto = true; return { ok: true }; }, stop() { auto = false; return { ok: true }; } },
    amountValidator: { isRunning: () => false, stop() {} },
    harness: { cancelWaiters() {} },
  };
}
function makeManager() {
  return new BrowserRunManager({
    createLauncher: () => ({ close() {}, snapshot() { return {}; } }),
    createTargetManager: () => ({ async stop() {}, listTargets() { return []; }, getSession() {} }),
    buildSubsystem: () => fakeSubsystem(),
  });
}
// Simulate main's openPersistentBrowser one-live-run guard + linkage.
function openBrowser(mgr, reg, browserId) {
  const b = reg.get(browserId);
  if (!b) return { error: { code: 'BROWSER_NOT_FOUND' } };
  const existing = mgr.liveRunForBrowser(browserId);
  if (existing) return { runId: existing.id, alreadyRunning: true };
  const run = mgr.createRun({ launchUrl: b.launchUrl, browserId: b.id, profileDir: b.profileDir });
  reg.touchOpened(b.id, run.id);
  return { runId: run.id, run };
}

// D + E + F. open/close/reopen linkage with stable profileDir.
test('D/E/F: open links browserId, close goes OFFLINE, reopen reuses profileDir', async () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const mgr = makeManager();
  const b = reg.create({ name: 'Main', launchUrl: 'https://game.test' }).browser;

  const o1 = openBrowser(mgr, reg, b.id);
  const runX = o1.run;
  assert.equal(runX.browserId, 'B-0001');
  assert.equal(mgr.summary(runX).browserId, 'B-0001');
  assert.equal(mgr.liveRunForBrowser('B-0001').id, runX.id);
  assert.equal(reg.get('B-0001').lastRunId, runX.id);

  // Close the runtime run: browser remains registered and becomes OFFLINE.
  await mgr.closeRun(runX.id);
  assert.equal(mgr.liveRunForBrowser('B-0001'), null, 'no live run -> OFFLINE');
  assert.ok(reg.get('B-0001'), 'browser still registered');

  // Reopen: NEW run id, SAME browserId, SAME profileDir.
  const o2 = openBrowser(mgr, reg, b.id);
  const runY = o2.run;
  assert.notEqual(runY.id, runX.id);
  assert.equal(runY.browserId, 'B-0001');
  assert.equal(runY.profileDir, runX.profileDir);
  assert.equal(runY.profileDir, reg.get('B-0001').profileDir);
});

// H/37. one live run per persistent browser.
test('H: opening an already-running browser reuses the run (no second launch)', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const mgr = makeManager();
  const b = reg.create({ name: 'A', launchUrl: 'https://a.test' }).browser;
  const o1 = openBrowser(mgr, reg, b.id);
  const o2 = openBrowser(mgr, reg, b.id);
  assert.equal(o2.alreadyRunning, true);
  assert.equal(o2.runId, o1.run.id, 'same run reused');
  // exactly one live run for this browser
  let live = 0; for (const s of mgr.list()) if (s.browserId === 'B-0001' && s.status !== STATUS.CLOSED) live++;
  assert.equal(live, 1);
});

// G/38. multiple browsers run concurrently, fully independent.
test('G: three persistent browsers hold independent concurrent runs', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const mgr = makeManager();
  const a = reg.create({ name: 'A', launchUrl: 'https://a.test' }).browser;
  const b = reg.create({ name: 'B', launchUrl: 'https://b.test' }).browser;
  const c = reg.create({ name: 'C', launchUrl: 'https://c.test' }).browser;
  const ra = openBrowser(mgr, reg, a.id).run;
  const rb = openBrowser(mgr, reg, b.id).run;
  const rc = openBrowser(mgr, reg, c.id).run;
  // distinct browserId + profileDir + run
  const ids = [ra, rb, rc].map((r) => r.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(new Set([ra, rb, rc].map((r) => r.profileDir)).size, 3);
  assert.equal(new Set([ra, rb, rc].map((r) => r.browserId)).size, 3);
  // concurrent auto runners, each independent
  ra.autoRunner.start(); rb.autoRunner.start();
  assert.equal(mgr.liveRunForBrowser('B-0001').autoRunner.isRunning(), true);
  assert.equal(mgr.liveRunForBrowser('B-0002').autoRunner.isRunning(), true);
  assert.equal(mgr.liveRunForBrowser('B-0003').autoRunner.isRunning(), false);
  // closing B stops only B's runtime
  mgr.liveRunForBrowser('B-0002').autoRunner.stop();
  assert.equal(mgr.liveRunForBrowser('B-0001').autoRunner.isRunning(), true);
});

// I. no stale protocol truth survives a "restart" (reload registry).
test('I: reload restores identity only — no live SID/ODD/protocol state', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const mgr = makeManager();
  const b = reg.create({ name: 'A', launchUrl: 'https://a.test' }).browser;
  openBrowser(mgr, reg, b.id); // records lastOpenedAt/lastRunId only

  // Simulate app restart: brand-new registry from disk, brand-new manager.
  const reg2 = makeRegistry(root); reg2.load();
  const mgr2 = makeManager();
  const restored = reg2.get('B-0001');
  assert.ok(restored);
  assert.equal('currentSid' in restored, false);
  assert.equal('currentOdd' in restored, false);
  assert.equal('aid' in restored, false);
  assert.equal(mgr2.liveRunForBrowser('B-0001'), null, 'no fabricated live run after restart');
});

// Offline-selection safety mechanism: an offline browser resolves to no runId.
test('offline browser resolves to no live run (execution cannot bind)', async () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const mgr = makeManager();
  const a = reg.create({ name: 'A', launchUrl: 'https://a.test' }).browser;
  const b = reg.create({ name: 'B', launchUrl: 'https://b.test' }).browser;
  const ra = openBrowser(mgr, reg, a.id).run;   // A live
  // B is offline (never opened)
  assert.equal(mgr.liveRunForBrowser('B-0002'), null, 'offline B has no runId');
  assert.equal(mgr.liveRunForBrowser('B-0001').id, ra.id, 'A unaffected');
});
