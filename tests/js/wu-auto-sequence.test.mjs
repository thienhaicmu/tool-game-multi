import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AutoSequenceController, CONTINUABLE_STOP_REASON } = require('../../desktop/browser-run/auto-sequence-controller.cjs');
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner, RESULT } = require('../../desktop/protocol/auto-runner.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// Controllable scheduler: timers do NOT fire on their own; the test advances them.
function fakeScheduler({ leaky = false } = {}) {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    // leaky=true → clearTimeout is a no-op, so a queued fire still runs. Used to prove the
    // generation guard alone (not just timer cancellation) blocks a post-STOP advance.
    clearTimeout: (id) => { if (!leaky) timers.delete(id); },
    fireAll() { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); },
    pending() { return timers.size; },
  };
}

// ---------------------------------------------------------------------------
// UNIT — AutoSequenceController with a MOCK start orchestration. Records every row
// start (config + first flag + minted execId) and lets the test drive completions.
// ---------------------------------------------------------------------------
function mockCtrl({ startResults, ownerRunId = 'B1', scheduler } = {}) {
  const sch = scheduler || fakeScheduler();
  const starts = [];
  let seq = 0;
  const startExecution = async (cfg, o) => {
    seq += 1;
    const execId = `AX-${ownerRunId}-${seq}`;
    starts.push({ cfg, first: !!(o && o.first), execId });
    const r = startResults ? startResults(seq, cfg) : null;
    if (r && r.error) return r;
    return { ok: true, autoExecutionId: execId };
  };
  const ctrl = new AutoSequenceController({ startExecution, scheduler: sch, ownerRunId });
  const lastId = () => (starts.length ? starts[starts.length - 1].execId : null);
  const finalize = (reason = CONTINUABLE_STOP_REASON, execId) => ctrl.onExecutionFinalized({ autoExecutionId: execId || lastId(), stopReason: reason });
  const advance = async () => { sch.fireAll(); await flush(); };
  return { ctrl, sch, starts, finalize, advance, lastId };
}

const ROW = (roundCount, amount = 5000, stopOdd = 2.0) => ({ roundCount, amount, stopOdd });

// TEST 1 — one row runs exactly once, then stops.
test('SEQ one row → one execution, no second', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1000)]);
  assert.equal(starts.length, 1);
  finalize(); await advance();
  assert.equal(starts.length, 1, 'no second execution for a single-row sequence');
  assert.equal(ctrl.isRunning(), false);
});

// TEST 2 — three rows run in display order.
test('SEQ three rows → C1→C2→C3 in order then stop', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1000), ROW(500), ROW(2000)]);
  finalize(); await advance();
  finalize(); await advance();
  finalize(); await advance();
  assert.deepEqual(starts.map((s) => s.cfg.roundCount), [1000, 500, 2000]);
  assert.equal(starts.length, 3);
  assert.equal(ctrl.isRunning(), false);
});

// TEST 3 — arbitrary N (no hardcoded length).
test('SEQ arbitrary N=7 → exactly 7 executions, no 8th', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ROW(100 + i));
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start(rows);
  for (let i = 0; i < 10; i++) { finalize(); await advance(); }   // over-drive: extra completes must not restart
  assert.equal(starts.length, 7);
  assert.deepEqual(starts.map((s) => s.cfg.roundCount), rows.map((r) => r.roundCount));
  assert.equal(ctrl.isRunning(), false);
});

// TEST 4 — each execution receives its OWN exact row config.
test('SEQ per-row config isolation', async () => {
  const rows = [ROW(11, 5000, 1.5), ROW(22, 10000, 2.5), ROW(33, 15000, 3.5)];
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start(rows);
  finalize(); await advance();
  finalize(); await advance();
  assert.deepEqual(starts.map((s) => s.cfg), rows);
});

// TEST 5 (mock) — distinct minted execution ids; only the FIRST row is resume-capable.
test('SEQ distinct execution ids; only row 0 is first=true', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2), ROW(3)]);
  finalize(); await advance();
  finalize(); await advance();
  const ids = starts.map((s) => s.execId);
  assert.equal(new Set(ids).size, ids.length, 'all execution ids distinct');
  assert.deepEqual(starts.map((s) => s.first), [true, false, false], 'only row 0 keeps recovery-resume continuity');
});

// TEST 7 — duplicate COMPLETED for the same execution advances ONCE.
test('SEQ duplicate COMPLETED advances exactly once', async () => {
  const { ctrl, starts, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2), ROW(3)]);
  const id0 = starts[0].execId;
  ctrl.onExecutionFinalized({ autoExecutionId: id0, stopReason: CONTINUABLE_STOP_REASON });
  ctrl.onExecutionFinalized({ autoExecutionId: id0, stopReason: CONTINUABLE_STOP_REASON });
  ctrl.onExecutionFinalized({ autoExecutionId: id0, stopReason: CONTINUABLE_STOP_REASON });
  await advance();
  assert.equal(starts.length, 2, 'only one next row started for a duplicated COMPLETED');
  assert.equal(starts[1].cfg.roundCount, 2);
});

// TEST 8 — STOP mid-sequence prevents the following rows.
test('SEQ STOP during a middle row → no further rows', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2), ROW(3), ROW(4), ROW(5)]);
  finalize(); await advance();                 // row0 done → row1 (C2) started
  assert.equal(starts.length, 2);
  ctrl.stop('USER_STOP');                       // user STOP during C2
  assert.equal(ctrl.isRunning(), false);
  finalize(CONTINUABLE_STOP_REASON); await advance(); // a late C2 finalize must not advance
  assert.equal(starts.length, 2, 'C3 never starts after STOP');
});

// TEST 9 — STOP wins the transition race even if the queued timer still fires (generation guard).
test('SEQ STOP after completion but before next-row fire → next row never starts', async () => {
  const sch = fakeScheduler({ leaky: true });       // clearTimeout is a no-op
  const { ctrl, starts, finalize } = mockCtrl({ scheduler: sch });
  await ctrl.start([ROW(1), ROW(2), ROW(3)]);
  finalize();                                        // schedules row1 (pending timer)
  assert.equal(sch.pending(), 1);
  ctrl.stop('USER_STOP');                            // bumps generation
  sch.fireAll(); await flush();                      // stale timer fires anyway
  assert.equal(starts.length, 1, 'generation guard blocks the stale advance');
  assert.equal(ctrl.isRunning(), false);
});

// TEST 11 — hard/abnormal terminal reasons do NOT advance.
for (const reason of ['USER_STOP', 'STOP_1000X_REACHED', 'LOGIN_REQUIRED', 'RECOVERY_FAILED', 'AUTO_ERROR', 'RUN_CLOSED', 'APP_CLOSED', 'LICENSE_BLOCKED', 'UNKNOWN']) {
  test(`SEQ hard stop (${reason}) does not advance`, async () => {
    const { ctrl, starts, advance } = mockCtrl();
    await ctrl.start([ROW(1), ROW(2)]);
    ctrl.onExecutionFinalized({ autoExecutionId: starts[0].execId, stopReason: reason });
    await advance();
    assert.equal(starts.length, 1, `${reason} must not start the next row`);
    assert.equal(ctrl.isRunning(), false);
  });
}

// TEST 12 — the active sequence is an IMMUTABLE snapshot (later edits don't change it).
test('SEQ active sequence snapshot is immutable', async () => {
  const rows = [ROW(1), ROW(2), ROW(3)];
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start(rows);
  rows[1].roundCount = 999;                 // mutate caller array AFTER start
  rows.push(ROW(4));                          // add a row AFTER start
  finalize(); await advance();               // row1 must use the ORIGINAL snapshot value
  assert.equal(starts[1].cfg.roundCount, 2, 'row 1 kept its snapshot value, not the mutated 999');
  finalize(); await advance();
  finalize(); await advance();
  assert.equal(starts.length, 3, 'the added row is ignored by the running sequence');
});

// TEST 13 — sequence is bound to its OWNER; advancement always uses the SAME orchestration.
test('SEQ bound to owner run id; advancement never retargets', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl({ ownerRunId: 'B1' });
  await ctrl.start([ROW(1), ROW(2)]);
  assert.equal(ctrl.ownerRunId(), 'B1');
  finalize(); await advance();
  assert.ok(starts.every((s) => s.execId.startsWith('AX-B1-')), 'all rows started through the owner-bound orchestration');
});

// TEST 14 — two independent per-run sequences do not cross-route.
test('SEQ two simultaneous sequences are isolated (no shared index/owner)', async () => {
  const A = mockCtrl({ ownerRunId: 'B1' });
  const B = mockCtrl({ ownerRunId: 'B2' });
  await A.ctrl.start([ROW(1), ROW(2)]);
  await B.ctrl.start([ROW(10), ROW(20), ROW(30)]);
  // Interleave completions.
  A.finalize(); await A.advance();
  B.finalize(); await B.advance();
  B.finalize(); await B.advance();
  A.finalize(); await A.advance();     // A already on its last row → no restart
  B.finalize(); await B.advance();
  assert.deepEqual(A.starts.map((s) => s.cfg.roundCount), [1, 2]);
  assert.deepEqual(B.starts.map((s) => s.cfg.roundCount), [10, 20, 30]);
  assert.equal(A.ctrl.isRunning(), false);
  assert.equal(B.ctrl.isRunning(), false);
});

// TEST — empty sequence is rejected without side effects.
test('SEQ empty rows → AUTO_SEQUENCE_EMPTY, nothing started', async () => {
  const { ctrl, starts } = mockCtrl();
  const res = await ctrl.start([]);
  assert.ok(res.error && res.error.code === 'AUTO_SEQUENCE_EMPTY');
  assert.equal(starts.length, 0);
  assert.equal(ctrl.isRunning(), false);
});

// TEST — a failed row-0 start surfaces the error and does not mark the sequence running.
test('SEQ row-0 start error aborts the sequence', async () => {
  const { ctrl, starts } = mockCtrl({ startResults: (n) => (n === 1 ? { error: { code: 'LOGIN_REQUIRED' } } : null) });
  const res = await ctrl.start([ROW(1), ROW(2)]);
  assert.ok(res.error && res.error.code === 'LOGIN_REQUIRED');
  assert.equal(starts.length, 1);
  assert.equal(ctrl.isRunning(), false);
});

// ---------------------------------------------------------------------------
// INTEGRATION — AutoSequenceController driving a REAL AutoRunner. Proves distinct
// autoExecutionIds, one finalize per row, recovery continuity, and that roundCount /
// BET / CASHOUT semantics are untouched by the outer loop.
// ---------------------------------------------------------------------------
function makeReal({ ownerRunId = 'B1' } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const harness = {
    execute: async (opts) => {
      sends.push(opts.command);
      return opts.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } } : { result: 'ACK' };
    },
  };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'http://localhost:8080/game' });
  const scheduler = fakeScheduler();
  const starts = [];
  const finalized = [];
  const startExecution = async (cfg) => {
    const r = runner.start('T', cfg);
    if (r.error) return { error: r.error };
    starts.push({ cfg, execId: r.autoExecutionId });
    return { ok: true, autoExecutionId: r.autoExecutionId };
  };
  const ctrl = new AutoSequenceController({ startExecution, scheduler, ownerRunId });
  runner.on('executionFinalized', (rec) => { finalized.push(rec); ctrl.onExecutionFinalized(rec); });
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });
  const betCount = () => sends.filter((c) => c === 'bet').length;
  const cashCount = () => sends.filter((c) => c === 'cashout').length;
  const advance = async () => { scheduler.fireAll(); await flush(); };
  return { tracker, observer, runner, ctrl, scheduler, starts, finalized, feed, betCount, cashCount, advance };
}
async function playLose(feed, sid) {
  feed(`{"cmd":100005,"sid":${sid}}`); await flush();   // bet sent + ACK → WATCHING_ODD
  feed(`{"cmd":100007,"sid":${sid}}`); await flush();    // ROUND_END before threshold → terminal COMPLETED (roundCount=1)
}
async function playWin(feed, sid) {
  feed(`{"cmd":100005,"sid":${sid}}`); await flush();     // bet ACK
  feed(`{"cmd":100009,"sid":${sid},"odd":2.50}`); await flush(); // >= stopOdd → cashout ACK → RESULT.COMPLETED (resets _attempted)
}

// TEST 5/6 (real) + TEST 4 — three rows: distinct ids, one finalize each, exact configs, order.
test('SEQ (real AutoRunner) 3 rows → distinct ids, one History finalize per row, ordered', async () => {
  const { ctrl, starts, finalized, feed, advance, runner } = makeReal();
  await ctrl.start([
    { roundCount: 1, amount: 5000, stopOdd: 2 },
    { roundCount: 1, amount: 10000, stopOdd: 2 },
    { roundCount: 1, amount: 15000, stopOdd: 2 },
  ]);
  await playLose(feed, 100); await advance();
  await playLose(feed, 200); await advance();
  await playLose(feed, 300); await advance();
  assert.equal(starts.length, 3, 'exactly 3 executions');
  assert.deepEqual(starts.map((s) => s.cfg.amount), [5000, 10000, 15000], 'each execution used its own row config');
  const ids = finalized.map((r) => r.autoExecutionId);
  assert.equal(ids.length, 3, 'one terminal execution record per row');
  assert.equal(new Set(ids).size, 3, 'all autoExecutionIds distinct (A != B != C)');
  assert.ok(finalized.every((r) => r.stopReason === 'ROUND_TARGET_COMPLETED'));
  assert.equal(ctrl.isRunning(), false, 'no loop back to row 1');
  assert.equal(runner.isRunning(), false);
});

// TEST 10 (real) — recovery stays on the SAME row/execution id; next row gets a NEW id.
test('SEQ (real) recovery preserves execution id, not confused with next-row', async () => {
  const { ctrl, feed, advance, runner } = makeReal();
  await ctrl.start([{ roundCount: 1, amount: 5000, stopOdd: 2 }, { roundCount: 1, amount: 5000, stopOdd: 2 }]);
  const idA = runner.autoExecutionId();
  // Pause for SESSION_RECOVERY BEFORE any bet (emits NO executionFinalized).
  runner.stop({ reason: 'SESSION_RECOVERY' });
  assert.equal(runner.pausedForRecovery(), true);
  assert.equal(ctrl.index(), 0, 'recovery pause does not advance the sequence');
  // Resume the SAME execution (mirrors resumePausedAuto: resumeExecutionId, never a new id).
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2 }, { resumeExecutionId: idA }); await flush();
  assert.equal(runner.autoExecutionId(), idA, 'resume kept the same autoExecutionId');
  assert.equal(ctrl.index(), 0, 'still on row 0 after resume');
  // Now the row completes normally → advance to row 1 with a NEW id.
  await playLose(feed, 100); await advance();
  assert.equal(ctrl.index(), 1, 'advanced to the next row after normal completion');
  assert.notEqual(runner.autoExecutionId(), idA, 'row 2 minted a NEW execution id');
});

// ITEM 1 — a MID-sequence row (#2..#N) retains the SAME SESSION_RECOVERY behavior. Proves
// sequenceNext:true does NOT disable recovery: recovery resume runs through resumePausedAuto
// (autoRunner.start with resumeExecutionId) — never through startAutoExecution — so the paused
// row keeps its id and index, and only its genuine completion advances to the next row.
test('SEQ (real) row #2 recovery keeps execId=B and index; C3 only after C2 completes', async () => {
  const C1 = { roundCount: 1, amount: 5000, stopOdd: 2 };
  const C2 = { roundCount: 1, amount: 10000, stopOdd: 2 };
  const C3 = { roundCount: 1, amount: 15000, stopOdd: 2 };
  const { ctrl, feed, advance, runner, finalized } = makeReal();
  await ctrl.start([C1, C2, C3]);
  const idA = runner.autoExecutionId();
  // Row 1 (C1) completes → advance to row 2 (C2), NEW id = B.
  await playLose(feed, 100); await advance();
  assert.equal(ctrl.index(), 1, 'on row #2 (C2)');
  const idB = runner.autoExecutionId();
  assert.notEqual(idB, idA, 'C2 minted a new execution id B');
  // SESSION_RECOVERY while C2 is active. Emits NO executionFinalized (recovery pause branch).
  runner.stop({ reason: 'SESSION_RECOVERY' });
  assert.equal(runner.pausedForRecovery(), true);
  assert.equal(ctrl.index(), 1, 'recovery pause did NOT advance the sequence');
  assert.equal(finalized.length, 1, 'no terminal record for a recovery pause (only C1 finalized so far)');
  // Resume C2 exactly as resumePausedAuto does: same id via resumeExecutionId, cfg = run._runConfig (C2).
  runner.start('T', C2, { resumeExecutionId: idB }); await flush();
  assert.equal(runner.autoExecutionId(), idB, 'resume preserved execution id B (sequenceNext did NOT disable recovery)');
  assert.equal(ctrl.index(), 1, 'still on row #2 after resume');
  // C2 now completes normally → only NOW advance to row 3 (C3), NEW id = C.
  await playLose(feed, 200); await advance();
  assert.equal(ctrl.index(), 2, 'advanced to row #3 only after C2 genuinely completed');
  const idC = runner.autoExecutionId();
  assert.notEqual(idC, idB, 'C3 minted a new execution id C (B != C)');
  assert.notEqual(idC, idA);
  // C3 completes → sequence done, no loop-back.
  await playLose(feed, 300); await advance();
  assert.equal(ctrl.isRunning(), false, 'sequence complete');
  assert.deepEqual(finalized.map((r) => r.autoExecutionId), [idA, idB, idC], 'exactly three terminal records: A, B, C');
});

// TEST 15 (real) — roundCount / win-reset / BET / CASHOUT semantics unchanged inside a sequenced row.
test('SEQ (real) win resets _attempted within a row; row still terminates on a later loss', async () => {
  const { ctrl, feed, advance, betCount, cashCount, finalized } = makeReal();
  await ctrl.start([{ roundCount: 1, amount: 5000, stopOdd: 2 }, { roundCount: 1, amount: 5000, stopOdd: 2 }]);
  // A WINNING round (odd >= stopOdd) cashes out → RESULT.COMPLETED resets _attempted to 0,
  // so the execution does NOT terminate on the win (existing semantics, unchanged).
  await playWin(feed, 100);
  assert.equal(finalized.length, 0, 'winning round did not terminate the execution (roundCount reset intact)');
  // A subsequent LOSING round consumes the budget → terminal COMPLETED → advance.
  await playLose(feed, 107); await advance();
  assert.equal(finalized.length, 1, 'execution finalized once after the losing round');
  assert.equal(cashCount(), 1, 'exactly one cashout (the winning round)');
  assert.equal(betCount(), 2, 'one bet per played SID; no cross-execution SID reuse');
  assert.equal(ctrl.index(), 1, 'sequence advanced to row 2');
});
