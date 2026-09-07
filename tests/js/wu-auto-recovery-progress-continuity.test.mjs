// WU-AUTO-RECOVERY-PROGRESS-CONTINUITY — the SAME Auto execution resumes with only its
// REMAINING budget after a SESSION_RECOVERY pause. Deterministic, Electron-free.
//
// Proven semantics (see wu10-auto-runner "threshold cashout resets progress…" / "does not start
// more than roundCount…"): roundCount is the number of CONSECUTIVE non-completed rounds tolerated;
// a COMPLETED threshold cashout resets the cycle (_attempted -> 0). _attempted is therefore the
// authoritative budget-consumption counter. Continuity = carry _attempted / _history / start-time
// across resume; never replay an unknown in-flight action.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner, STATE, RESULT, STOP_REASON } = require('../../desktop/protocol/auto-runner.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

function make({ host = 'http://localhost:8080/game', exec } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const execImpl = exec || ((opts) => opts.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } } : { result: 'ACK' });
  const harness = { execute: async (opts) => { sends.push({ command: opts.command }); return execImpl(opts, sends); } };
  const diag = { events: [], log(e) { this.events.push(e); } };
  const clock = { t: 0 };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => host, now: () => clock.t, diag });
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });
  const betCount = () => sends.filter((s) => s.command === 'bet').length;
  const cashCount = () => sends.filter((s) => s.command === 'cashout').length;
  return { tracker, observer, runner, harness, sends, feed, clock, betCount, cashCount, diag };
}

// A round that ends below stopOdd → ROUND_ENDED_BEFORE_THRESHOLD (non-completed → consumes budget).
async function playNonWin(feed, sid) {
  feed(`{"cmd":100005,"sid":${sid}}`); await flush();
  feed(`{"cmd":100009,"sid":${sid},"odd":1.5}`); await flush();
  feed(`{"cmd":100007,"sid":${sid}}`); await flush();
}
// A round that crosses stopOdd → threshold cashout → COMPLETED (resets the cycle).
async function playWin(feed, sid) {
  feed(`{"cmd":100005,"sid":${sid}}`); await flush();
  feed(`{"cmd":100009,"sid":${sid},"odd":2.5}`); await flush();
  feed(`{"cmd":100007,"sid":${sid}}`); await flush();
}
const NW = { roundCount: 10, amount: 5000, stopOdd: 100 };  // stopOdd high → playNonWin never wins
const WIN = { roundCount: 10, amount: 5000, stopOdd: 2 };    // stopOdd low  → playWin cashes out

// 1 — 10-round budget, recover after 6 consumed → only 4 remain.
test('recover after 6 consumed rounds → exactly 4 remain (budget not restarted)', async () => {
  const { runner, feed } = make();
  const id = runner.start('T', NW).autoExecutionId;
  let sid = 100;
  for (let i = 0; i < 6; i++) await playNonWin(feed, sid++);
  assert.equal(runner.snapshot().progress.attempted, 6);
  runner.stop({ reason: 'SESSION_RECOVERY' });
  runner.start('T', NW, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
  assert.equal(runner.snapshot().progress.attempted, 6, 'consumed budget carried across recovery');
  // 3 more non-wins must NOT terminate (9 < 10) …
  for (let i = 0; i < 3; i++) await playNonWin(feed, sid++);
  assert.equal(runner.isRunning(), true, 'still running at 9 consumed');
  // … the 4th (10th total) terminates the SAME execution.
  await playNonWin(feed, sid++);
  assert.equal(runner.isRunning(), false);
  assert.equal(runner.state(), STATE.COMPLETED);
  assert.equal(runner.executionRecord().stopReason, STOP_REASON.ROUND_TARGET_COMPLETED);
});

// 2 — recover before the first eligible round → full budget remains.
test('recover before first round (0 consumed) → full budget remains', async () => {
  const { runner, feed } = make();
  const id = runner.start('T', NW).autoExecutionId;
  runner.stop({ reason: 'SESSION_RECOVERY' });
  runner.start('T', NW, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
  assert.equal(runner.snapshot().progress.attempted, 0);
  let sid = 200;
  for (let i = 0; i < 9; i++) await playNonWin(feed, sid++);
  assert.equal(runner.isRunning(), true, 'full 10-round budget available after early recovery');
  await playNonWin(feed, sid++);
  assert.equal(runner.isRunning(), false, 'terminates only after the full 10 rounds');
});

// 3 — multiple recoveries do not reset progress.
test('progress survives multiple recoveries (3 + 3 + 4 = terminate at 10)', async () => {
  const { runner, feed } = make();
  const id = runner.start('T', NW).autoExecutionId;
  let sid = 300;
  const resume = () => { runner.stop({ reason: 'SESSION_RECOVERY' }); runner.start('T', NW, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() }); };
  for (let i = 0; i < 3; i++) await playNonWin(feed, sid++);
  resume(); assert.equal(runner.snapshot().progress.attempted, 3);
  for (let i = 0; i < 3; i++) await playNonWin(feed, sid++);
  resume(); assert.equal(runner.snapshot().progress.attempted, 6);
  for (let i = 0; i < 3; i++) await playNonWin(feed, sid++);
  assert.equal(runner.isRunning(), true, 'still running at 9');
  await playNonWin(feed, sid++);
  assert.equal(runner.isRunning(), false, 'terminates at 10 across recoveries');
  assert.equal(runner.recoveryCount(), 2);
});

// 4 — same autoExecutionId across every recovery.
test('same autoExecutionId across all recoveries and at terminal record', async () => {
  const { runner, feed } = make();
  const id = runner.start('T', NW).autoExecutionId;
  let sid = 400;
  for (let n = 0; n < 3; n++) {
    for (let i = 0; i < 2; i++) await playNonWin(feed, sid++);
    runner.stop({ reason: 'SESSION_RECOVERY' });
    const r = runner.start('T', NW, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
    assert.equal(r.autoExecutionId, id);
  }
  assert.equal(runner.snapshot().autoExecutionId, id);
});

// 5 — a genuinely NEW manual execution starts from zero (no carry-over).
test('new manual execution (no resumeExecutionId) resets progress + mints a new id', async () => {
  const { runner, feed } = make();
  const id1 = runner.start('T', NW).autoExecutionId;
  let sid = 500;
  for (let i = 0; i < 4; i++) await playNonWin(feed, sid++);
  assert.equal(runner.snapshot().progress.attempted, 4);
  runner.stop(); // terminal manual stop, NOT a recovery pause
  const id2 = runner.start('T', NW).autoExecutionId; // fresh start
  assert.notEqual(id2, id1, 'fresh execution id');
  assert.equal(runner.snapshot().progress.attempted, 0, 'no progress carried into a new execution');
  assert.equal(runner.history().length, 0, 'fresh history');
});

// 6 — an unknown in-flight BET is not replayed after resume.
test('unknown in-flight BET is not re-sent after recovery (same SID never re-bet)', async () => {
  const { runner, feed, betCount } = make();
  const id = runner.start('T', WIN).autoExecutionId;
  feed('{"cmd":100005,"sid":100}'); await flush();     // bet sent, ACKed, now WATCHING_ODD (no cashout yet)
  assert.equal(betCount(), 1);
  runner.stop({ reason: 'SESSION_RECOVERY' });          // interrupt with the round in flight
  runner.start('T', WIN, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
  feed('{"cmd":100005,"sid":100}'); await flush();      // same SID reappears after reconnect
  assert.equal(betCount(), 1, 'the interrupted SID is NOT re-bet (no replay)');
  feed('{"cmd":100005,"sid":101}'); await flush();      // a genuinely new round still bets
  assert.equal(betCount(), 2);
});

// 7 — an unknown in-flight CASHOUT is not replayed after resume.
test('unknown in-flight CASHOUT is not re-sent after recovery', async () => {
  const { runner, feed, betCount, cashCount } = make({
    exec: (opts) => opts.command === 'cashout' ? new Promise(() => {}) : { result: 'ACK' }, // cashout never ACKs
  });
  const id = runner.start('T', WIN).autoExecutionId;
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":2.5}'); await flush(); // triggers cashout (never resolves)
  assert.equal(cashCount(), 1);
  runner.stop({ reason: 'SESSION_RECOVERY' });               // cashout ACK unknown at pause
  runner.start('T', WIN, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
  feed('{"cmd":100005,"sid":100}'); await flush();           // same SID reappears
  feed('{"cmd":100009,"sid":100,"odd":2.5}'); await flush();
  assert.equal(cashCount(), 1, 'no blind cashout replay');
  assert.equal(betCount(), 1, 'and no re-bet of the interrupted SID');
});

// 8 — duplicate ROUND_OPEN does not consume budget twice.
test('duplicate ROUND_OPEN for the same SID consumes budget once', async () => {
  const { runner, feed, betCount } = make();
  runner.start('T', NW);
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100005,"sid":100}'); await flush(); // duplicate open
  assert.equal(betCount(), 1);
  assert.equal(runner.snapshot().progress.attempted, 1, 'one attempt for one SID');
});

// 9 — a stale pre-recovery SID after resume does not consume budget or re-bet.
test('stale SID after recovery neither re-bets nor consumes budget', async () => {
  const { runner, feed, betCount } = make();
  const id = runner.start('T', NW).autoExecutionId;
  await playNonWin(feed, 100); // consumes 1, SID 100 now in the dedup set
  assert.equal(runner.snapshot().progress.attempted, 1);
  runner.stop({ reason: 'SESSION_RECOVERY' });
  runner.start('T', NW, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
  const betsBefore = betCount();
  feed('{"cmd":100005,"sid":100}'); await flush(); // stale SID reappears
  assert.equal(betCount(), betsBefore, 'stale SID not re-bet');
  assert.equal(runner.snapshot().progress.attempted, 1, 'budget not consumed by a stale SID');
});

// 10 — terminal completion is emitted exactly once across a recover-and-complete flow.
test('terminal executionFinalized fires exactly once (recovery pause is not terminal)', async () => {
  const { runner, feed } = make();
  const finals = [];
  runner.on('executionFinalized', (rec) => finals.push(rec));
  const id = runner.start('T', NW).autoExecutionId;
  let sid = 600;
  for (let i = 0; i < 5; i++) await playNonWin(feed, sid++);
  runner.stop({ reason: 'SESSION_RECOVERY' });
  assert.equal(finals.length, 0, 'no terminal row for a recovery pause');
  runner.start('T', NW, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
  for (let i = 0; i < 5; i++) await playNonWin(feed, sid++); // reaches 10 → terminate
  assert.equal(runner.isRunning(), false);
  assert.equal(finals.length, 1, 'exactly one terminal execution row');
  assert.equal(finals[0].autoExecutionId, id);
});

// 11 — History totals span pre- and post-recovery within the same execution.
test('History completed totals span pre/post recovery (one execution)', async () => {
  const { runner, feed } = make();
  const id = runner.start('T', WIN).autoExecutionId;
  await playWin(feed, 100); // pre-recovery win
  await playWin(feed, 101); // pre-recovery win
  assert.equal(runner.history().length, 2);
  runner.stop({ reason: 'SESSION_RECOVERY' });
  runner.start('T', WIN, { resumeExecutionId: id, recoveryCount: runner.recoveryCount() });
  assert.equal(runner.history().length, 2, 'pre-recovery history preserved on resume');
  await playWin(feed, 102); // post-recovery win
  const rec = runner.executionRecord();
  assert.equal(rec.autoExecutionId, id);
  assert.equal(runner.history().length, 3, 'history spans pre + post');
  assert.equal(rec.roundsCompleted, 3, 'completed total counts the whole execution');
});

// 12 — one browser's recovery progress does not affect another's runner.
test('B1 recovery/progress does not affect B2 (isolated runner instances)', async () => {
  const b1 = make(); const b2 = make();
  const id1 = b1.runner.start('T', NW).autoExecutionId;
  b2.runner.start('T', NW);
  let s1 = 700, s2 = 800;
  for (let i = 0; i < 5; i++) await playNonWin(b1.feed, s1++);
  for (let i = 0; i < 2; i++) await playNonWin(b2.feed, s2++);
  b1.runner.stop({ reason: 'SESSION_RECOVERY' });
  b1.runner.start('T', NW, { resumeExecutionId: id1, recoveryCount: b1.runner.recoveryCount() });
  assert.equal(b1.runner.snapshot().progress.attempted, 5, 'B1 preserved its own progress');
  assert.equal(b2.runner.snapshot().progress.attempted, 2, 'B2 untouched by B1 recovery');
  assert.equal(b2.runner.recoveryCount(), 0, 'B2 never entered recovery');
  assert.equal(b2.runner.isRunning(), true);
});
