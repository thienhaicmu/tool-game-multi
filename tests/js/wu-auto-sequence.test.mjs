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
  const stops = [];               // recorded stopExecution(reason) calls (WIN reset terminations)
  let seq = 0;
  let curId = null;               // last successfully started execution id (mirrors _currentExecId)
  const startExecution = async (cfg, o) => {
    seq += 1;
    const execId = `AX-${ownerRunId}-${seq}`;
    starts.push({ cfg, first: !!(o && o.first), execId });
    const r = startResults ? startResults(seq, cfg) : null;
    if (r && r.error) return r;
    curId = execId;
    return { ok: true, autoExecutionId: execId };
  };
  // Mirror production: finalizeExecution(reason) synchronously emits executionFinalized, which
  // re-enters onExecutionFinalized for the (now win-consumed) execution — proving the guard.
  const stopExecution = (reason) => { stops.push({ reason, execId: curId }); ctrl.onExecutionFinalized({ autoExecutionId: curId, stopReason: reason }); };
  const ctrl = new AutoSequenceController({ startExecution, stopExecution, scheduler: sch, ownerRunId });
  const lastId = () => (starts.length ? starts[starts.length - 1].execId : null);
  const finalize = (reason = CONTINUABLE_STOP_REASON, execId) => ctrl.onExecutionFinalized({ autoExecutionId: execId || lastId(), stopReason: reason });
  // Signal an authoritative round WIN for the CURRENT (or an explicit) execution id.
  const win = (execId) => ctrl.onRoundWin({ autoExecutionId: execId !== undefined ? execId : curId });
  const advance = async () => { sch.fireAll(); await flush(); };
  return { ctrl, sch, starts, stops, finalize, win, advance, lastId };
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
// winReset:false → the legacy harness (only executionFinalized wired), used to prove AutoRunner's
// own _attempted/win semantics in ISOLATION. winReset:true → also wires the production WIN bridge
// (roundFinalized[result===COMPLETED] → onRoundWin) + stopExecution(finalizeExecution), so a round
// WIN resets the sequence to row 0 exactly as main.cjs does. cashout lets a test force a non-ACK.
function makeReal({ ownerRunId = 'B1', winReset = false, cashout } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const harness = {
    execute: async (opts) => {
      sends.push(opts.command);
      if (opts.command === 'cashout') return cashout || { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } };
      return { result: 'ACK' };
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
  const stopExecution = (reason) => { try { runner.finalizeExecution(reason); } catch { /* best effort */ } };
  const ctrl = new AutoSequenceController({ startExecution, stopExecution, scheduler, ownerRunId });
  const rounds = [];   // every roundFinalized pub (the authoritative per-round result feed)
  runner.on('executionFinalized', (rec) => { finalized.push(rec); ctrl.onExecutionFinalized(rec); });
  runner.on('roundFinalized', (pub) => {
    rounds.push({ ...pub, execId: runner.autoExecutionId() });
    // Production bridge (main.cjs): only an authoritative WIN (RESULT.COMPLETED) resets the LƯỢT.
    if (winReset && pub && pub.result === RESULT.COMPLETED) ctrl.onRoundWin({ autoExecutionId: runner.autoExecutionId() });
  });
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });
  const betCount = () => sends.filter((c) => c === 'bet').length;
  const cashCount = () => sends.filter((c) => c === 'cashout').length;
  const advance = async () => { scheduler.fireAll(); await flush(); };
  return { tracker, observer, runner, ctrl, scheduler, starts, finalized, rounds, feed, betCount, cashCount, advance };
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

// ===========================================================================
// WIN-RESET — an authoritative round WIN (RESULT.COMPLETED, the cashout-ACK evidence path)
// in the CURRENT LƯỢT resets the sequence to LƯỢT 1 / index 0 and starts it as a NEW execution.
// WIN ownership stays in AutoRunner; the controller owns the LƯỢT transition. These prove the
// transition + every reentrancy/dedup/stale/stop/recovery guard the spec requires.
// ===========================================================================

// T1 — L1 WIN → a NEW L1 execution (semantic reason SEQUENCE_WIN_RESET; distinct id).
test('WIN T1 — L1 win restarts L1 as a new execution', async () => {
  const { ctrl, starts, stops, win, advance } = mockCtrl();
  await ctrl.start([ROW(1000)]);
  assert.equal(starts.length, 1);
  win(); await advance();
  assert.equal(ctrl.index(), 0, 'reset to LƯỢT 1');
  assert.equal(ctrl.isRunning(), true, 'sequence keeps running');
  assert.equal(starts.length, 2, 'LƯỢT 1 restarted');
  assert.deepEqual(starts.map((s) => s.cfg.roundCount), [1000, 1000], 'restarted with row-0 config');
  assert.equal(stops.length, 1, 'winning execution cleanly terminated once');
  assert.equal(stops[0].reason, 'SEQUENCE_WIN_RESET', 'terminated with the semantic win reason, not a fake failure');
  assert.notEqual(starts[1].execId, starts[0].execId, 'NEW autoExecutionId (A != B)');
});

// T2 — L2 WIN → L1.
test('WIN T2 — win in L2 resets to L1', async () => {
  const { ctrl, starts, finalize, win, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2), ROW(3)]);
  finalize(); await advance();                 // L1 → L2
  assert.equal(ctrl.index(), 1);
  win(); await advance();                       // WIN in L2 → L1
  assert.equal(ctrl.index(), 0, 'back to LƯỢT 1');
  assert.equal(starts[starts.length - 1].cfg.roundCount, 1, 'restarted at row-0 config');
});

// T3 — L3 WIN → L1.
test('WIN T3 — win in L3 resets to L1', async () => {
  const { ctrl, starts, finalize, win, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2), ROW(3)]);
  finalize(); await advance(); finalize(); await advance();   // → L3
  assert.equal(ctrl.index(), 2);
  win(); await advance();
  assert.equal(ctrl.index(), 0);
  assert.equal(starts[starts.length - 1].cfg.roundCount, 1);
});

// T4 — WIN in the LAST LƯỢT → L1 (a win never "completes" the sequence like a normal last-row finalize).
test('WIN T4 — win in the final LƯỢT resets to L1 (not sequence-complete)', async () => {
  const { ctrl, starts, finalize, win, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2)]);
  finalize(); await advance();                 // → L2 (last row)
  assert.equal(ctrl.index(), 1);
  win(); await advance();
  assert.equal(ctrl.index(), 0, 'win in last row loops to L1, does not end the sequence');
  assert.equal(ctrl.isRunning(), true);
  assert.equal(starts[starts.length - 1].cfg.roundCount, 1);
});

// T5 + T6 (real) — new L1 id != winning id; the winning ROUND stays RESULT.COMPLETED; the terminal
// EXECUTION record is SEQUENCE_WIN_RESET, never a fabricated losing result.
test('WIN T5/T6 (real) — new L1 id != winning id; winning round stays COMPLETED', async () => {
  const { ctrl, runner, feed, advance, rounds, finalized } = makeReal({ winReset: true });
  await ctrl.start([{ roundCount: 1, amount: 5000, stopOdd: 2 }, { roundCount: 1, amount: 5000, stopOdd: 2 }]);
  const idA = runner.autoExecutionId();
  await playWin(feed, 100);                     // authoritative WIN → cashout ACK → RESULT.COMPLETED
  await advance();                              // win-reset fires: end A, start L1 as B
  const idB = runner.autoExecutionId();
  assert.notEqual(idB, idA, 'LƯỢT 1 minted a NEW execution id (A != B)');
  const wins = rounds.filter((r) => r.result === RESULT.COMPLETED);
  assert.equal(wins.length, 1, 'exactly one winning round');
  assert.equal(wins[0].result, RESULT.COMPLETED, 'winning round remains WIN/COMPLETED');
  assert.equal(wins[0].execId, idA, 'the winning round belongs to the OLD (winning) execution');
  assert.ok(finalized.some((f) => f.autoExecutionId === idA && f.stopReason === 'SEQUENCE_WIN_RESET'), 'winning execution ended with the semantic win reason');
  assert.ok(!finalized.some((f) => f.stopReason === 'USER_STOP' || f.stopReason === 'UNKNOWN'), 'never recorded as a manual/unknown stop');
  assert.equal(ctrl.index(), 0);
});

// T7 (real, no bridge) — AutoRunner's own _attempted/win semantics are UNCHANGED in isolation:
// a win resets _attempted to 0 and the execution keeps running (does NOT self-finalize).
test('WIN T7 (real) — AutoRunner _attempted semantics unchanged in isolation', async () => {
  const { runner, ctrl, feed, finalized } = makeReal({ winReset: false });
  await ctrl.start([{ roundCount: 3, amount: 5000, stopOdd: 2 }]);
  await playWin(feed, 100);
  assert.equal(finalized.length, 0, 'win did not finalize the execution');
  assert.equal(runner.isRunning(), true, 'execution still running after a win');
  assert.equal(runner.snapshot().progress.attempted, 0, '_attempted reset to 0 on win (unchanged)');
});

// T8 — a bare BET ACK (no qualifying odd, no round finalized) is NOT a win → no reset.
test('WIN T8 (real) — bare BET ACK does not reset the LƯỢT', async () => {
  const { ctrl, feed, advance, starts, rounds } = makeReal({ winReset: true });
  await ctrl.start([{ roundCount: 1, amount: 5000, stopOdd: 2 }, { roundCount: 1, amount: 5000, stopOdd: 2 }]);
  feed(`{"cmd":100005,"sid":100}`); await flush();   // bet sent + ACK → WATCHING_ODD; no round finalized
  await advance();
  assert.equal(rounds.filter((r) => r.result === RESULT.COMPLETED).length, 0, 'no COMPLETED round');
  assert.equal(ctrl.index(), 0);
  assert.equal(starts.length, 1, 'no restart from a bare BET ACK');
});

// T9 — a CASHOUT request that does NOT ACK (TIMEOUT) is NOT a win. It is a normal non-win outcome,
// so it consumes the round budget and advances normally — it never triggers a WIN reset.
test('WIN T9 (real) — cashout request without ACK is not a win (no reset)', async () => {
  const { ctrl, feed, advance, finalized } = makeReal({ winReset: true, cashout: { result: 'TIMEOUT' } });
  await ctrl.start([{ roundCount: 1, amount: 5000, stopOdd: 2 }, { roundCount: 1, amount: 5000, stopOdd: 2 }]);
  await playWin(feed, 100);                     // odd crosses → cashout REQUEST → TIMEOUT (not COMPLETED)
  await advance();
  assert.ok(!finalized.some((f) => f.stopReason === 'SEQUENCE_WIN_RESET'), 'cashout timeout is not a win');
  assert.equal(ctrl.index(), 1, 'treated as normal non-win progression → advanced to L2');
});

// T10 — a ROUND_END before threshold (loss) is NOT a win → normal progression, no reset.
test('WIN T10 (real) — round-end loss does not reset (normal advance)', async () => {
  const { ctrl, feed, advance, finalized } = makeReal({ winReset: true });
  await ctrl.start([{ roundCount: 1, amount: 5000, stopOdd: 2 }, { roundCount: 1, amount: 5000, stopOdd: 2 }]);
  await playLose(feed, 100); await advance();
  assert.ok(!finalized.some((f) => f.stopReason === 'SEQUENCE_WIN_RESET'));
  assert.equal(ctrl.index(), 1, 'loss advances normally, never a win reset');
});

// T11 — an UNKNOWN terminal reason stops the sequence (existing behavior) and never win-resets.
test('WIN T11 (mock) — UNKNOWN terminal never triggers a win reset', async () => {
  const { ctrl, starts, stops, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2)]);
  finalize('UNKNOWN'); await advance();
  assert.equal(ctrl.isRunning(), false, 'UNKNOWN stops the sequence');
  assert.equal(stops.length, 0, 'no SEQUENCE_WIN_RESET termination');
  assert.equal(starts.length, 1, 'no L1 restart');
});

// T12/T13/T14 (real, bridge ON) — non-win progression + final-row stop are byte-for-byte unchanged.
test('WIN T12/T13/T14 (real) — non-win progression L1→L2→L3 then stop, with bridge active', async () => {
  const { ctrl, feed, advance, finalized } = makeReal({ winReset: true });
  await ctrl.start([
    { roundCount: 1, amount: 5000, stopOdd: 2 },
    { roundCount: 1, amount: 10000, stopOdd: 2 },
    { roundCount: 1, amount: 15000, stopOdd: 2 },
  ]);
  await playLose(feed, 100); await advance();  assert.equal(ctrl.index(), 1, 'L1 loss → L2');
  await playLose(feed, 200); await advance();  assert.equal(ctrl.index(), 2, 'L2 loss → L3');
  await playLose(feed, 300); await advance();
  assert.equal(ctrl.isRunning(), false, 'final-row loss ends the sequence (unchanged)');
  assert.ok(finalized.every((f) => f.stopReason === 'ROUND_TARGET_COMPLETED'), 'all normal terminal records; no win reset involved');
});

// T15 — duplicate WIN for the SAME winning execution → exactly ONE L1 start.
test('WIN T15 (mock) — duplicate win same round → exactly one reset', async () => {
  const { ctrl, starts, stops, win, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2)]);
  win(); win(); win();                          // three emits for the SAME current execution
  await advance();
  assert.equal(stops.length, 1, 'exactly one termination');
  assert.equal(starts.length, 2, 'exactly one L1 restart (WIN_RESET_COUNT_PER_WINNING_ROUND = 1)');
});

// T16 — after a reset, ANY late event from the OLD winning execution cannot affect the new L1.
test('WIN T16 (mock) — stale events from the old winning execution are inert', async () => {
  const { ctrl, starts, win, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2), ROW(3)]);
  const idA = starts[0].execId;
  win(idA); await advance();                    // reset → new L1 (idB)
  const n = starts.length;
  win(idA);                                     // stale duplicate win from A
  ctrl.onExecutionFinalized({ autoExecutionId: idA, stopReason: 'ROUND_TARGET_COMPLETED' });
  await advance();
  assert.equal(ctrl.index(), 0, 'stale A cannot move the new L1');
  assert.equal(starts.length, n, 'no extra start from stale A');
  assert.equal(ctrl.isRunning(), true);
});

// T17 — WIN then a stale ROUND_TARGET_COMPLETED from the old execution → stays L1 (no wrong advance).
test('WIN T17 (mock) — win then stale ROUND_TARGET_COMPLETED does not advance', async () => {
  const { ctrl, starts, win, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2), ROW(3)]);
  const idA = starts[0].execId;
  win(idA); await advance();
  const n = starts.length;
  ctrl.onExecutionFinalized({ autoExecutionId: idA, stopReason: 'ROUND_TARGET_COMPLETED' });
  await advance();
  assert.equal(ctrl.index(), 0, 'WIN_THEN_STALE_FINALIZE_WRONG_ADVANCE = 0');
  assert.equal(starts.length, n);
});

// T18 — WIN queued then STOP (generation guard beats the queued reset even if the timer still fires).
test('WIN T18 (mock) — win queued + STOP → no L1 restart', async () => {
  const sch = fakeScheduler({ leaky: true });   // clearTimeout is a no-op
  const { ctrl, starts, win } = mockCtrl({ scheduler: sch });
  await ctrl.start([ROW(1), ROW(2)]);
  win();
  assert.equal(sch.pending(), 1, 'reset queued');
  ctrl.stop('USER_STOP');                        // bumps generation
  sch.fireAll(); await flush();                  // stale reset timer fires anyway
  assert.equal(starts.length, 1, 'no L1 restart after STOP');
  assert.equal(ctrl.isRunning(), false);
});

// T19 — STOP then a late WIN → nothing happens (STOP_RESURRECTION = 0).
test('WIN T19 (mock) — STOP then late win → no resurrection', async () => {
  const { ctrl, starts, win, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2)]);
  ctrl.stop('USER_STOP');
  win(); await advance();
  assert.equal(starts.length, 1);
  assert.equal(ctrl.isRunning(), false);
});

// T20 — SESSION_RECOVERY pause while on L3 → stays L3 (recovery is orthogonal to WIN).
test('WIN T20 (real) — recovery pause on L3 preserves the current LƯỢT', async () => {
  const C = (amount) => ({ roundCount: 1, amount, stopOdd: 2 });
  const { ctrl, feed, advance, runner } = makeReal({ winReset: true });
  await ctrl.start([C(5000), C(10000), C(15000)]);
  await playLose(feed, 100); await advance();
  await playLose(feed, 200); await advance();
  assert.equal(ctrl.index(), 2, 'on L3');
  runner.stop({ reason: 'SESSION_RECOVERY' });   // pause: emits neither executionFinalized nor a COMPLETED round
  assert.equal(runner.pausedForRecovery(), true);
  assert.equal(ctrl.index(), 2, 'recovery pause did NOT reset the LƯỢT');
});

// T23 (covers T21/T22 mechanism) — a WIN on a RECOVERED (resumed) L3 execution resets to L1 exactly
// once. Proves recovery/context-loss/login re-entry never win-resets, but a real WIN afterwards does.
test('WIN T23 (real) — win after a recovered L3 execution resets to L1 exactly once', async () => {
  const C = (amount) => ({ roundCount: 1, amount, stopOdd: 2 });
  const { ctrl, feed, advance, runner, starts } = makeReal({ winReset: true });
  await ctrl.start([C(5000), C(10000), C(15000)]);
  await playLose(feed, 100); await advance();
  await playLose(feed, 200); await advance();
  assert.equal(ctrl.index(), 2, 'on L3');
  const idC = runner.autoExecutionId();
  runner.stop({ reason: 'SESSION_RECOVERY' });                       // context-loss/login recovery pause
  runner.start('T', C(15000), { resumeExecutionId: idC }); await flush(); // resume SAME id (no reset)
  assert.equal(ctrl.index(), 2, 'still L3 after resume');
  assert.equal(runner.autoExecutionId(), idC, 'recovery kept the execution id');
  const nBefore = starts.length;
  await playWin(feed, 300); await advance();                          // authoritative WIN on recovered L3
  assert.equal(ctrl.index(), 0, 'win resets to L1');
  assert.equal(starts.length, nBefore + 1, 'exactly one L1 restart');
  assert.notEqual(runner.autoExecutionId(), idC, 'L1 minted a new id');
});

// T24 — multi-browser isolation: B1 win resets only B1; B2's current LƯỢT is untouched.
test('WIN T24 (mock) — a win in one run does not reset another run', async () => {
  const A = mockCtrl({ ownerRunId: 'B1' });
  const B = mockCtrl({ ownerRunId: 'B2' });
  await A.ctrl.start([ROW(1), ROW(2)]);
  await B.ctrl.start([ROW(10), ROW(20)]);
  A.finalize(); await A.advance();             // A → L2
  B.finalize(); await B.advance();             // B → L2
  A.win(); await A.advance();                  // A WIN → L1
  assert.equal(A.ctrl.index(), 0, 'B1 reset to L1');
  assert.equal(B.ctrl.index(), 1, 'B2 unaffected');
  assert.equal(B.starts.length, 2, 'B2 no extra start');
  assert.ok(B.starts.every((s) => s.execId.startsWith('AX-B2-')), 'no cross-run retarget');
});

// ---------------------------------------------------------------------------
// LOOP — start({ loop:true }): the final row wrapping back to row 0, indefinitely.
// ---------------------------------------------------------------------------

// LOOP-1 — the last row completing wraps back to row 0 and keeps running (NEW execution).
test('LOOP last row complete → wraps to row 0 and keeps running', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1000), ROW(500)], { loop: true });
  finalize(); await advance();                 // L1 done → L2
  assert.equal(ctrl.index(), 1);
  finalize(); await advance();                 // L2 (last) done → LOOP back to L1
  assert.equal(ctrl.index(), 0, 'wrapped back to the first Level');
  assert.equal(ctrl.isRunning(), true, 'still running after the last Level');
  assert.equal(starts.length, 3, 'a NEW execution started for the looped row 0');
  assert.deepEqual(starts.map((s) => s.cfg.roundCount), [1000, 500, 1000]);
  assert.equal(starts[2].first, false, 'a looped row is never a resume-capable first row');
});

// LOOP-2 — multiple full passes; each looped row is a distinct NEW execution; loopCount tracks.
test('LOOP runs the whole sequence repeatedly with distinct execution ids', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(10), ROW(20), ROW(30)], { loop: true });
  // Drive 2 full passes (6 completions) + into a 3rd pass' first row.
  for (let i = 0; i < 7; i++) { finalize(); await advance(); }
  assert.equal(ctrl.isRunning(), true);
  assert.equal(starts.length, 8, '3+3+2 executions across the looped passes');
  assert.deepEqual(starts.map((s) => s.cfg.roundCount), [10, 20, 30, 10, 20, 30, 10, 20]);
  const ids = starts.map((s) => s.execId);
  assert.equal(new Set(ids).size, ids.length, 'every looped execution id is distinct');
  assert.equal(ctrl.snapshot().loopCount, 2, 'two full passes completed');
  assert.equal(ctrl.snapshot().loop, true);
});

// LOOP-3 — single-row sequence also loops (last Level == only Level).
test('LOOP single row repeats after each completion', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1000)], { loop: true });
  finalize(); await advance();
  finalize(); await advance();
  assert.equal(starts.length, 3, 'the one row restarted each completion');
  assert.equal(ctrl.isRunning(), true);
});

// LOOP-4 — default (no loop opt) still STOPS after the last row (contract preserved).
test('LOOP default OFF — last row still ends the sequence', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2)]);          // no { loop:true }
  finalize(); await advance();
  finalize(); await advance();
  assert.equal(ctrl.isRunning(), false, 'no loop by default');
  assert.equal(starts.length, 2);
  assert.equal(ctrl.snapshot().loop, false);
});

// LOOP-5 — a user STOP after the last row completes (but before the wrapped fire) blocks the
// restart via the generation guard, even with a leaky scheduler that still runs queued timers.
test('LOOP STOP race — a STOP before the wrapped row fires prevents the restart', async () => {
  const sch = fakeScheduler({ leaky: true });
  const { ctrl, starts, finalize, advance } = mockCtrl({ scheduler: sch });
  await ctrl.start([ROW(1), ROW(2)], { loop: true });
  finalize(); await advance();                 // → L2
  finalize();                                  // L2 done → schedules the LOOP wrap (not yet fired)
  ctrl.stop('USER_STOP');                      // user STOP wins the race (bumps generation)
  await advance();                             // leaky timer still runs, but the guard rejects it
  assert.equal(ctrl.isRunning(), false);
  assert.equal(starts.length, 2, 'no looped restart after STOP');
});

// LOOP-6 — a non-continuable terminal reason on the last row halts (never loops).
test('LOOP non-continuable terminal on the last row halts (no wrap)', async () => {
  const { ctrl, starts, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(1), ROW(2)], { loop: true });
  finalize(); await advance();                 // → L2
  finalize('USER_STOP'); await advance();      // last row ended by a STOP, not a normal completion
  assert.equal(ctrl.isRunning(), false, 'a non-continuable terminal never loops');
  assert.equal(starts.length, 2);
});
