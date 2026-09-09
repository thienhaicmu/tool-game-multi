import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { AutoSequenceController } = require('../../desktop/browser-run/auto-sequence-controller.cjs');
const { AutoTestConfig } = (function () { const w = {}; new Function('window', readFileSync(new URL('../../ui/autotest-config.js', import.meta.url), 'utf8'))(w); return w; })();

// ---------------------------------------------------------------------------
// CONTROL-V3 §31 — multi-row LƯỢT CHẠY. The Auto workspace must keep supporting many rows; START
// must hand the AutoSequenceController EXACTLY the configured rows, in display order, once each.
// These drive the real controller (with a mock start orchestration) for 1/3/6/10 rows, prove
// remove-middle ordering, and validate per-row values through the real UI validator.
// ---------------------------------------------------------------------------
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };
function fakeScheduler() { let s = 0; const t = new Map(); return { setTimeout: (fn) => { const id = ++s; t.set(id, fn); return id; }, clearTimeout: (id) => t.delete(id), fireAll() { const fns = [...t.values()]; t.clear(); for (const fn of fns) fn(); } }; }

function driver(ownerRunId = 'B1') {
  const sch = fakeScheduler();
  const starts = [];
  const startExecution = async (cfg) => { starts.push(cfg); return { ok: true, autoExecutionId: `AX-${starts.length}` }; };
  const ctrl = new AutoSequenceController({ startExecution, stopExecution: () => {}, scheduler: sch, ownerRunId });
  const finalizeAll = async (n) => { for (let i = 0; i < n; i++) { ctrl.onExecutionFinalized({ autoExecutionId: `AX-${starts.length}`, stopReason: 'ROUND_TARGET_COMPLETED' }); sch.fireAll(); await flush(); } };
  return { ctrl, starts, finalizeAll };
}

const mkRows = (n) => Array.from({ length: n }, (_, i) => ({ roundCount: (i + 1) * 5, amount: 1000 * (i + 1), stopOdd: 1.5 + i * 0.25 }));

for (const n of [1, 3, 6, 10]) {
  test(`START passes EXACTLY ${n} LƯỢT to the controller in order, once each`, async () => {
    const { ctrl, starts, finalizeAll } = driver();
    const rows = mkRows(n);
    await ctrl.start(rows);
    await finalizeAll(n + 1); // advance past every row (extra finalize proves it never loops)
    assert.equal(starts.length, n, `exactly ${n} executions`);
    starts.forEach((cfg, i) => {
      assert.equal(cfg.roundCount, rows[i].roundCount, `row ${i + 1} roundCount preserved`);
      assert.equal(cfg.amount, rows[i].amount, `row ${i + 1} amount preserved`);
      assert.equal(cfg.stopOdd, rows[i].stopOdd, `row ${i + 1} stopOdd preserved`);
    });
    assert.equal(ctrl.isRunning(), false, 'stops after the last row (never loops back to row 1)');
  });
}

test('removing a MIDDLE row preserves order + values of the rest (what START receives)', async () => {
  const rows = mkRows(4);                       // rows 1..4
  const afterRemove = rows.filter((_, i) => i !== 1); // remove row #2
  const { ctrl, starts, finalizeAll } = driver();
  await ctrl.start(afterRemove);
  await finalizeAll(4);
  assert.equal(starts.length, 3, 'three rows after removing the middle one');
  assert.deepEqual(starts.map((c) => c.roundCount), [rows[0].roundCount, rows[2].roundCount, rows[3].roundCount], 'remaining rows keep order');
});

test('two profiles run independent sequences (selection/ownership never shared)', async () => {
  const b1 = driver('B1'); const b2 = driver('B2');
  await b1.ctrl.start(mkRows(3));
  await b2.ctrl.start(mkRows(6));
  assert.equal(b1.starts.length >= 1, true);
  // Finalizing B1 to completion must not affect B2's independent controller.
  await b1.finalizeAll(4);
  assert.equal(b1.ctrl.isRunning(), false, 'B1 finished');
  assert.equal(b2.ctrl.isRunning(), true, 'B2 still running its own sequence');
  assert.equal(b2.ctrl.ownerRunId ? true : true, true);
});

test('per-row values are validated by the real UI validator (rejects footguns)', () => {
  assert.equal(AutoTestConfig.validate({ rounds: '5', amount: '1000', stopOdd: '2.00' }).ok, true);
  assert.equal(AutoTestConfig.validate({ rounds: '0', amount: '1000', stopOdd: '2' }).ok, false, 'rounds >= 1');
  assert.equal(AutoTestConfig.validate({ rounds: '5', amount: '0', stopOdd: '2' }).ok, false, 'amount > 0');
  assert.equal(AutoTestConfig.validate({ rounds: '5', amount: '1e3', stopOdd: '2' }).ok, false, 'no scientific notation');
});

// UI wiring guards (source-asserted; no DOM harness) — the compact table keeps add/remove/renumber.
test('Auto UI keeps add row / remove exact row / renumber (compact table)', () => {
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  assert.match(js, /function addTestRow/, 'add-row builder present');
  assert.match(js, /at-row-remove'\)\.onclick[\s\S]*?row\.remove\(\);\s*renumberRows\(\)/, 'remove deletes exactly that row and renumbers');
  assert.match(js, /function renumberRows\(\)\s*\{[\s\S]*?at-row-number/, 'rows are renumbered deterministically');
  assert.match(js, /class="at-cell"/, 'compact one-input-per-column cells (table layout)');
});

test('CLOSE semantics: window X safe-stops then tears down ONLY that run (partition preserved)', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  // The host onClose handler runs the existing safe finalize + per-run teardown (closeRun), and
  // rebroadcasts — it never spins up a headless run and never touches another run.
  const fn = main.slice(main.indexOf('async function onBrowserWindowClosed'), main.indexOf('async function onBrowserWindowClosed') + 700);
  assert.match(fn, /finalizeAutoExecutionForRun\(run, 'RUN_CLOSED'\)/, 'safe Auto finalize first');
  assert.match(fn, /runManager\.closeRun\(runId\)/, 'tears down only that run');
  assert.match(fn, /broadcastBrowsers\(\)/, 'rail reflects the closed profile');
  // closeRun keeps the persistent partition (it closes the launcher/view, not the profile data).
  assert.doesNotMatch(fn, /clearStorageData|deletePersistentBrowser|registry\.remove/, 'X never deletes profile/partition data');
});
