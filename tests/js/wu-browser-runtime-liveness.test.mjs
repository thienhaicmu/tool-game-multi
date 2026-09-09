import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// BROWSER RUNTIME LIVENESS — the corrected invariant:
//
//   selectedRunId  !=  runtime ownership
//
// CONTROL-V3: each run now lives in its OWN external browser window. Focusing/selecting one
// run must NEVER stop, pause, destroy, recreate or detach a non-selected BrowserRun. And
// browserRuntimeState is reported ALONGSIDE (never merged into) the game state: a run can be
// LIVE while its Aviator context is CONTEXT_LOST. These tests prove both at the two owning layers:
//   1. InAppRuntime (the WebContentsView owner) — focus/select touches only the focused run;
//      the legacy embed API (showOnly/hideAll/setBounds) is inert and never disposes a run.
//   2. BrowserRunManager (the run/summary owner) — selection never disposes a run and
//      browserRuntimeState is a distinct axis from aviatorContextState.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const { InAppRuntime } = require('../../desktop/browser/inapp-runtime.cjs');
const { BrowserRunManager } = require('../../desktop/browser-run/browser-run-manager.cjs');
const { BrowserRuntimeHealth, STATE: RUNTIME } = require('../../desktop/browser-run/browser-runtime-health.cjs');
const { AviatorContextTracker, STATE: CTX } = require('../../desktop/protocol/aviator-context.cjs');

// A fake WebContentsView record: records whether the webContents was closed/focused, so we can
// prove focusing/selecting a run never touches another run's webContents lifecycle.
function fakeRecord(browserId) {
  const wc = {
    _destroyed: false, _closes: 0, _focuses: 0,
    isDestroyed() { return this._destroyed; },
    close() { this._closes++; this._destroyed = true; },
    focus() { this._focuses++; },
  };
  const view = { _visible: null, _bounds: null, setVisible(v) { this._visible = v; }, setBounds(b) { this._bounds = b; } };
  return { view, wc, browserId, client: null };
}

// A fake BrowserWindowHost: one window per run, records focuses + destroys so we can prove
// per-run isolation without Electron.
function fakeHost() {
  const wins = new Map(); // runId -> { focuses, destroyed }
  return {
    wins,
    ensureWindow(run) { if (!wins.has(run.id)) wins.set(run.id, { focuses: 0, destroyed: false }); return wins.get(run.id); },
    has(runId) { return wins.has(runId); },
    focusWindow(runId) { const w = wins.get(runId); if (w && !w.destroyed) { w.focuses++; return true; } return false; },
    destroyWindow(runId) { const w = wins.get(runId); if (w) { w.destroyed = true; wins.delete(runId); } },
    destroyAll() { for (const id of [...wins.keys()]) this.destroyWindow(id); },
  };
}

// ---- Layer 1: focusing/selecting a run is isolated; legacy embed API is inert -------------
test('focusing one external window never closes/detaches a background run; embed API is inert', () => {
  const host = fakeHost();
  const rt = new InAppRuntime({ windowHost: host });
  const r1 = fakeRecord('B-0001');
  const r2 = fakeRecord('B-0002');
  rt._byRun.set('run-1', r1); host.ensureWindow({ id: 'run-1' });
  rt._byRun.set('run-2', r2); host.ensureWindow({ id: 'run-2' });

  // Focus run-1: its window is focused; run-2 is NOT closed/removed.
  rt.focus('run-1');
  assert.equal(host.wins.get('run-1').focuses, 1, 'run-1 window focused');
  assert.equal(r2.wc._closes, 0, 'background webContents NOT closed');
  assert.equal(r2.wc.isDestroyed(), false, 'background webContents alive');
  assert.equal(rt.has('run-2'), true, 'background run still owned by runtime');
  assert.equal(rt.webContents('run-2'), r2.wc, 'background webContents still reachable');

  // Flip focus back and forth: still no lifecycle churn on either webContents.
  rt.focus('run-2'); rt.focus('run-1'); rt.focus('run-2');
  assert.equal(r1.wc._closes, 0);
  assert.equal(r2.wc._closes, 0);
  assert.equal(r1.wc.isDestroyed(), false, 'run-1 survives being backgrounded');

  // The legacy embed API is a no-op that can never dispose a run (external windows own display).
  rt.showOnly('run-1'); rt.hideAll(); rt.setBounds('run-1', { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(r1.wc.isDestroyed(), false);
  assert.equal(r2.wc.isDestroyed(), false);
  assert.equal(rt.has('run-1') && rt.has('run-2'), true, 'inert embed API never disposes a run');
});

test('destroy(run) tears down ONLY that run (window + webContents); the other stays live', () => {
  const host = fakeHost();
  const rt = new InAppRuntime({ windowHost: host });
  const r1 = fakeRecord('B-0001');
  const r2 = fakeRecord('B-0002');
  rt._byRun.set('run-1', r1); host.ensureWindow({ id: 'run-1' });
  rt._byRun.set('run-2', r2); host.ensureWindow({ id: 'run-2' });

  rt.destroy('run-1');
  assert.equal(r1.wc._closes, 1, 'closed run webContents closed');
  assert.equal(host.has('run-1'), false, 'closed run window destroyed');
  assert.equal(rt.has('run-1'), false, 'closed run removed');
  assert.equal(rt.has('run-2'), true, 'other run untouched');
  assert.equal(host.has('run-2'), true, 'other run window still alive');
  assert.equal(r2.wc.isDestroyed(), false, 'other webContents still alive');
});

// ---- Layer 2: BrowserRunManager selection never disposes; state axes are distinct ----
function makeWorld() {
  const built = {};
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ close() {}, async closeGraceful() { return { ok: true }; }, snapshot() { return {}; } }),
    createTargetManager: () => ({ async stop() {}, listTargets() { return []; }, getSession() {} }),
    buildSubsystem: (run) => {
      const s = { browserHealth: new BrowserRuntimeHealth(), aviatorContext: new AviatorContextTracker({ config: { freshMs: 100, verifyWindowMs: 50, maxReentryAttempts: 3 } }) };
      built[run.id] = s;
      return s;
    },
  });
  const a = mgr.createRun({ browserId: 'B-0001' });
  const b = mgr.createRun({ browserId: 'B-0002' });
  return { mgr, a, b, built };
}

test('summary exposes browserRuntimeState per run, sourced from that run\'s own health', () => {
  const { mgr, a, b } = makeWorld();
  // Fresh runs: LAUNCHING until a page loads.
  assert.equal(mgr.summary(a).browserRuntimeState, RUNTIME.LAUNCHING);
  a.browserHealth.tick({ wcExists: true, wcDestroyed: false, pageLoaded: true });
  assert.equal(mgr.summary(a).browserRuntimeState, RUNTIME.LIVE, 'A LIVE after page load');
  assert.equal(mgr.summary(b).browserRuntimeState, RUNTIME.LAUNCHING, 'B independent — still LAUNCHING');
});

test('selection change (setActive) never alters or disposes a non-selected run\'s runtime', () => {
  const { mgr, a, b, built } = makeWorld();
  a.browserHealth.tick({ wcExists: true, wcDestroyed: false, pageLoaded: true });
  b.browserHealth.tick({ wcExists: true, wcDestroyed: false, pageLoaded: true });
  assert.equal(mgr.summary(a).browserRuntimeState, RUNTIME.LIVE);
  assert.equal(mgr.summary(b).browserRuntimeState, RUNTIME.LIVE);

  // Flip the active selection repeatedly.
  for (const id of [a.id, b.id, a.id, b.id, a.id]) mgr.setActive(id);

  // Neither run's subsystem was swapped, and neither runtime state changed.
  assert.equal(mgr.get(a.id).browserHealth, built[a.id].browserHealth, 'A subsystem identity intact');
  assert.equal(mgr.get(b.id).browserHealth, built[b.id].browserHealth, 'B subsystem identity intact');
  assert.equal(mgr.summary(a).browserRuntimeState, RUNTIME.LIVE, 'A still LIVE while B selected');
  assert.equal(mgr.summary(b).browserRuntimeState, RUNTIME.LIVE, 'B still LIVE while A selected');
});

test('browserRuntimeState is a DISTINCT axis: LIVE coexists with aviatorContextState=CONTEXT_LOST', () => {
  const { mgr, a } = makeWorld();
  let t = 0; const now = () => t;
  // Browser runtime is fully LIVE.
  a.browserHealth.tick({ wcExists: true, wcDestroyed: false, pageLoaded: true });
  // Drive the game-context tracker to CONTEXT_LOST: seen Aviator once, then silence while the
  // page stays healthy and intent persists — exactly the "healthy browser, lobby kick" case.
  a.aviatorContext.tick({ now: (t = 0), lastAviatorMono: 0, pageHealthy: true, hasIntent: true }); // ACTIVE
  a.aviatorContext.tick({ now: (t = 1000), lastAviatorMono: 0, pageHealthy: true, hasIntent: true }); // silent long enough
  const s = mgr.summary(a);
  assert.equal(s.browserRuntimeState, RUNTIME.LIVE, 'browser runtime LIVE');
  assert.equal(s.aviatorContextState, CTX.CONTEXT_LOST, 'game context lost');
  assert.notEqual(s.browserRuntimeState, s.aviatorContextState, 'the two axes are reported independently');
});
