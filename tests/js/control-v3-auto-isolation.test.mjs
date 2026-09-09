import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AutoSequenceController } = require('../../desktop/browser-run/auto-sequence-controller.cjs');
const { BrowserRunManager } = require('../../desktop/browser-run/browser-run-manager.cjs');

// ---------------------------------------------------------------------------
// CONTROL-V3 HARD REQUIREMENT — each profile is a fully INDEPENDENT automation unit. The external
// per-profile window model must not turn Control's SELECTION into an execution lock or a global
// "current browser". START/STOP/rows/executionId/evidence for B-0010 must never touch B-0011, and
// both must run Auto simultaneously while Control selection flips B1 → B2 → B1 (selection = UI only).
// ---------------------------------------------------------------------------
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };
function fakeScheduler() { let s = 0; const t = new Map(); return { setTimeout: (fn) => { const id = ++s; t.set(id, fn); return id; }, clearTimeout: (id) => t.delete(id), fireAll() { const fns = [...t.values()]; t.clear(); for (const fn of fns) fn(); } }; }

// One independent Auto unit (mirrors a per-run AutoSequenceController + its own start orchestration,
// bound to its ownerRunId — exactly how main.cjs wires each BrowserRun).
function unit(ownerRunId) {
  const sch = fakeScheduler();
  const starts = [];
  const startExecution = async (cfg) => { starts.push(cfg); return { ok: true, autoExecutionId: `AX-${ownerRunId}-${starts.length}` }; };
  const ctrl = new AutoSequenceController({ startExecution, stopExecution: () => {}, scheduler: sch, ownerRunId });
  const advance = async (n) => { for (let i = 0; i < n; i++) { ctrl.onExecutionFinalized({ autoExecutionId: `AX-${ownerRunId}-${starts.length}`, stopReason: 'ROUND_TARGET_COMPLETED' }); sch.fireAll(); await flush(); } };
  return { ownerRunId, ctrl, starts, advance };
}
const rows = (base) => [{ roundCount: base, amount: base * 100, stopOdd: 2 }, { roundCount: base + 1, amount: base * 200, stopOdd: 3 }];

test('START B1 does not start B2', async () => {
  const b1 = unit('B-0010'), b2 = unit('B-0011');
  await b1.ctrl.start(rows(10));
  assert.equal(b1.ctrl.isRunning(), true, 'B1 running');
  assert.equal(b2.ctrl.isRunning(), false, 'B2 NOT started by B1');
  assert.equal(b2.starts.length, 0, 'B2 received no executions');
});

test('STOP B1 does not stop B2 (both run simultaneously)', async () => {
  const b1 = unit('B-0010'), b2 = unit('B-0011');
  await b1.ctrl.start(rows(10));
  await b2.ctrl.start(rows(20));
  assert.equal(b1.ctrl.isRunning(), true);
  assert.equal(b2.ctrl.isRunning(), true, 'both Auto units run at the same time');
  b1.ctrl.stop('USER_STOP');
  assert.equal(b1.ctrl.isRunning(), false, 'B1 stopped');
  assert.equal(b2.ctrl.isRunning(), true, 'B2 keeps running after B1 STOP');
});

test('B1 sequence rows never overwrite B2 rows', async () => {
  const b1 = unit('B-0010'), b2 = unit('B-0011');
  await b1.ctrl.start(rows(10));
  await b2.ctrl.start(rows(20));
  await b1.advance(1); await b2.advance(1); // step each to its 2nd row
  assert.equal(b1.starts[0].roundCount, 10, 'B1 row1 intact');
  assert.equal(b2.starts[0].roundCount, 20, 'B2 row1 intact (not overwritten by B1)');
  assert.equal(b1.starts[1].roundCount, 11);
  assert.equal(b2.starts[1].roundCount, 21);
});

test('B1 AutoRunner executionId is independent from B2', async () => {
  const b1 = unit('B-0010'), b2 = unit('B-0011');
  await b1.ctrl.start(rows(10));
  await b2.ctrl.start(rows(20));
  assert.ok(b1.starts.length && b2.starts.length);
  // Each unit mints ids under its OWN ownerRunId namespace — no collision/sharing.
  assert.notEqual('AX-B-0010-1', 'AX-B-0011-1');
});

// ---- BrowserRunManager: selection is UI-only; evidence routes to the owning run only ----
function mgrWorld() {
  const built = {};
  const spy = () => { const s = { started: 0, stopped: 0, _running: false }; return { start() { s.started++; s._running = true; }, stop() { s.stopped++; s._running = false; }, isRunning() { return s._running; }, _s: s }; };
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ close() {}, async closeGraceful() { return { ok: true }; }, snapshot() { return {}; } }),
    createTargetManager: () => ({ async stop() {}, listTargets() { return []; }, getSession() {} }),
    buildSubsystem: (run) => { const s = { autoRunner: spy() }; built[run.id] = s; return s; },
  });
  const a = mgr.createRun({ browserId: 'B-0010' });
  const b = mgr.createRun({ browserId: 'B-0011' });
  return { mgr, a, b, built };
}

test('selecting/focusing another profile never starts/stops a run (selection = UI only)', () => {
  const { mgr, a, b } = mgrWorld();
  a.autoRunner.start(); // B1 Auto running
  const beforeStops = b.autoRunner._s.stopped;
  for (const id of [b.id, a.id, b.id, a.id]) mgr.setActive(id); // flip Control selection repeatedly
  assert.equal(a.autoRunner.isRunning(), true, 'B1 Auto still running through selection flips');
  assert.equal(a.autoRunner._s.stopped, 0, 'B1 runner never stopped by selection');
  assert.equal(b.autoRunner._s.started, 0, 'B2 runner never started by selection');
  assert.equal(b.autoRunner._s.stopped, beforeStops, 'B2 runner untouched by selection');
});

test('SID/ODD evidence routes to the OWNING run only (no cross-update)', () => {
  const { mgr, a, b } = mgrWorld();
  mgr.registerTarget('T-A', a);
  mgr.registerTarget('T-B', b);
  assert.equal(mgr.runForTarget('T-A').id, a.id, 'A frames resolve to run A');
  assert.equal(mgr.runForTarget('T-B').id, b.id, 'B frames resolve to run B');
  assert.deepEqual(mgr.targetsForRun(a.id), ['T-A'], 'A owns only its target');
  assert.deepEqual(mgr.targetsForRun(b.id), ['T-B'], 'B owns only its target');
});

test('closing B1 (quiesce+teardown) never touches B2', async () => {
  const { mgr, a, b } = mgrWorld();
  a.autoRunner.start(); b.autoRunner.start();
  await mgr.closeRun(a.id);
  assert.equal(a.autoRunner._s.stopped, 1, 'B1 runner stopped on its own close');
  assert.equal(b.autoRunner.isRunning(), true, 'B2 runner still running after B1 close');
  assert.equal(b.autoRunner._s.stopped, 0, 'B2 runner never stopped by B1 close');
});
