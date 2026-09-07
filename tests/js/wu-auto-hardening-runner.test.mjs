import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner, STATE, STOP_REASON } = require('../../desktop/protocol/auto-runner.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

// A controllable scheduler: timers do NOT fire on their own — the test advances them
// explicitly, so there are no real random sleeps (§54).
function fakeScheduler() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fireAll() { const fns = [...timers.values()].map((t) => t.fn); timers.clear(); for (const fn of fns) fn(); },
    pending() { return timers.size; },
    lastDelay() { const arr = [...timers.values()]; return arr.length ? arr[arr.length - 1].ms : null; },
  };
}

function make({ host = 'http://localhost:8080/game', exec, random, scheduler, config } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const execImpl = exec || ((opts) => opts.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } } : { result: 'ACK' });
  const harness = { execute: async (opts) => { const cr = observer.currentRound(); sends.push({ command: opts.command, sidAtSend: cr ? cr.sid : null }); return execImpl(opts, sends); } };
  const diag = { events: [], log(e) { this.events.push(e); } };
  const clock = { t: 0 };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => host, now: () => clock.t, random, scheduler, diag });
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });
  const betCount = () => sends.filter((s) => s.command === 'bet').length;
  const cashCount = () => sends.filter((s) => s.command === 'cashout').length;
  return { tracker, observer, runner, harness, sends, feed, clock, betCount, cashCount, diag };
}
async function playQualifying(feed, sid, odds = [2.5]) {
  feed(`{"cmd":100005,"sid":${sid}}`); await flush();
  for (const o of odds) feed(`{"cmd":100009,"sid":${sid},"odd":${o}}`);
  await flush();
}
const DELAY = { roundCount: 3, amount: 5000, stopOdd: 2.0, betDelayMinMs: 0, betDelayMaxMs: 1000 };

// ===========================================================================
// PART A — Auto execution identity (§2/§3)
// ===========================================================================
test('a new Auto start mints a new autoExecutionId; snapshot exposes it', () => {
  const { runner } = make();
  const r1 = runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2 });
  const id1 = r1.autoExecutionId;
  assert.ok(id1);
  assert.equal(runner.snapshot().autoExecutionId, id1);
  runner.stop();
  const r2 = runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2 });
  assert.notEqual(r2.autoExecutionId, id1, 'a fresh start is a new execution');
});

test('recovery pause preserves the execution id and does NOT emit a terminal execution', () => {
  const { runner } = make();
  const finals = [];
  runner.on('executionFinalized', (rec) => finals.push(rec));
  const id = runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2 }).autoExecutionId;
  runner.stop({ reason: 'SESSION_RECOVERY' });
  assert.equal(finals.length, 0, 'recovery pause is not a terminal execution row (§20)');
  assert.equal(runner.pausedForRecovery(), true);
  assert.equal(runner.recoveryCount(), 1);
  // Resume preserves the SAME id and carries the recovery count forward (§7).
  const r = runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2 }, { resumeExecutionId: id, recoveryCount: 1 });
  assert.equal(r.autoExecutionId, id);
  assert.equal(runner.recoveryCount(), 1);
});

// ===========================================================================
// PART B — liveness (§4/§5/§9)
// ===========================================================================
test('liveness: running maps to a legitimate active state; idle intent is broken', () => {
  const { runner } = make();
  assert.deepEqual(runner.liveness(), { autoIntentActive: false, state: STATE.IDLE, ok: true, reason: null });
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2 });
  const l = runner.liveness();
  assert.equal(l.autoIntentActive, true);
  assert.equal(l.ok, true);
  // Force the forbidden condition (§5): intent active but state IDLE.
  runner._state = STATE.IDLE;
  assert.deepEqual(runner.liveness(), { autoIntentActive: true, state: STATE.IDLE, ok: false, reason: 'AUTO_LIVENESS_BROKEN' });
});

test('WAITING_NEXT_BET_DELAY is a legitimate active state, never AUTO_LIVENESS_BROKEN (§61)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed } = make({ scheduler, random: () => 0.5, config: DELAY });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);
  feed('{"cmd":100005,"sid":107}'); await flush();
  assert.equal(runner.state(), STATE.WAITING_NEXT_BET_DELAY);
  assert.equal(runner.liveness().ok, true);
});

// ===========================================================================
// PART A — non-manual stop captures authoritative ODD (§15/§16/§17/§18)
// ===========================================================================
test('AUTO_ERROR mid-round captures the authoritative stopOdd (7.42)', async () => {
  const { runner, observer, feed } = make();
  const finals = [];
  runner.on('executionFinalized', (rec) => finals.push(rec));
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 100 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":7.42}'); await flush();
  assert.equal(observer.currentRound().currentOdd, 7.42);
  runner.stop({ reason: 'AUTO_ERROR', errorCode: 'BOOM' });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].stopReason, STOP_REASON.AUTO_ERROR);
  assert.equal(finals[0].stopOdd, 7.42);
  assert.equal(finals[0].stopOddSource, 'ROUND_OBSERVER');
  assert.equal(finals[0].errorCode, 'BOOM');
});

test('stopOdd is null (never fabricated) when no authoritative current round odd exists (§18)', () => {
  const { runner } = make();
  const finals = [];
  runner.on('executionFinalized', (rec) => finals.push(rec));
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2 });
  runner.stop({ reason: 'AUTO_ERROR' }); // no round observed yet
  assert.equal(finals[0].stopOdd, null);
  assert.equal(finals[0].stopOddSource, null);
});

test('stale ODD from an ended round is rejected (§17)', async () => {
  const { runner, feed } = make();
  const finals = [];
  runner.on('executionFinalized', (rec) => finals.push(rec));
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 100 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":3.3}');
  feed('{"cmd":100007,"sid":100,"odd":3.3}'); await flush(); // round ended -> terminalReason set
  runner.stop({ reason: 'AUTO_ERROR' });
  assert.equal(finals[0].stopOdd, null, 'ended-round odd is stale, not captured');
});

test('unhandled exception in the frame path becomes a terminal AUTO_ERROR, not silent (§8/§56)', async () => {
  const { runner, observer, feed, diag } = make();
  const finals = [];
  runner.on('executionFinalized', (rec) => finals.push(rec));
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 100 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":7.42}'); await flush();
  // Sabotage the observer so the next frame handler throws inside the runner.
  const orig = observer.currentRound.bind(observer);
  let thrown = false;
  observer.currentRound = () => { if (!thrown) { thrown = true; throw new Error('boom'); } return orig(); };
  feed('{"cmd":100009,"sid":100,"odd":7.50}'); await flush();
  assert.equal(finals.length, 1);
  assert.equal(finals[0].stopReason, STOP_REASON.AUTO_ERROR);
  assert.ok(diag.events.some((e) => e.event === 'UNHANDLED_AUTO_EXCEPTION'));
});

// ===========================================================================
// PART E — next-round random BET delay
// ===========================================================================
test('timer starts from the NEXT ROUND_OPEN, not the CASHOUT send (§40)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed, betCount, cashCount } = make({ scheduler, random: () => 0.742 });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);              // round 1: immediate bet + cashout
  assert.equal(betCount(), 1);
  assert.equal(cashCount(), 1);
  assert.equal(scheduler.pending(), 0, 'no timer scheduled off the cashout send');
  assert.equal(runner.state(), STATE.WAITING_NEXT_ROUND);
  feed('{"cmd":100005,"sid":107}'); await flush(); // NEXT round opens -> NOW the timer arms
  assert.equal(scheduler.pending(), 1);
  assert.equal(betCount(), 1, 'no bet before the delay fires');
  scheduler.fireAll(); await flush();
  assert.equal(betCount(), 2, 'bet fires only after the delay elapsed for round N+1');
});

test('delay boundaries: min=max=0 -> immediate; 1000 -> one bet after firing', async () => {
  for (const d of [0, 1, 500, 1000]) {
    const scheduler = fakeScheduler();
    const { runner, feed, betCount } = make({ scheduler, random: () => (d === 1000 ? 1 : d === 0 ? 0 : d / 1000) });
    runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2, betDelayMinMs: d, betDelayMaxMs: d, nextRoundBetDelay: true });
    await playQualifying(feed, 100);
    feed('{"cmd":100005,"sid":107}'); await flush();
    assert.equal(scheduler.lastDelay(), d, `delay should be exactly ${d}`);
    assert.equal(betCount(), 1, 'no second bet before firing');
    scheduler.fireAll(); await flush();
    assert.equal(betCount(), 2, `exactly one bet after firing for delay ${d}`);
  }
});

test('USER_STOP during the delay cancels the pending bet (§44)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed, betCount, diag } = make({ scheduler, random: () => 0.85 });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);
  feed('{"cmd":100005,"sid":107}'); await flush();
  assert.equal(scheduler.pending(), 1);
  runner.stop();                                  // USER_STOP mid-delay
  assert.equal(scheduler.pending(), 0, 'timer cleared');
  scheduler.fireAll(); await flush();             // even a stray fire must not bet
  assert.equal(betCount(), 1);
  assert.ok(diag.events.some((e) => e.event === 'NEXT_BET_DELAY_CANCELLED' && e.reason === 'USER_STOP'));
});

test('ROUND_CHANGED during the delay cancels the stale bet and reschedules for the new sid (§45)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed, sends, betCount } = make({ scheduler, random: () => 0.5 });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);
  feed('{"cmd":100005,"sid":107}'); await flush(); // schedule for 107
  feed('{"cmd":100005,"sid":130}'); await flush(); // round changes to 130 before firing
  scheduler.fireAll(); await flush();
  assert.equal(betCount(), 2);
  const betSids = sends.filter((s) => s.command === 'bet').map((s) => s.sidAtSend);
  assert.deepEqual(betSids, [100, 130], 'never bet the stale 107; bet the current 130');
});

test('ROUND_LOCK during the delay cancels the bet (§46)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed, betCount } = make({ scheduler, random: () => 0.5 });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);
  feed('{"cmd":100005,"sid":107}'); await flush();
  feed('{"cmd":100006,"sid":107}'); await flush(); // LOCK -> no longer bet-eligible
  scheduler.fireAll(); await flush();
  assert.equal(betCount(), 1, 'locked round is not bet');
});

test('duplicate ROUND_OPEN for the scheduled sid arms only one timer / one bet (§51)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed, betCount } = make({ scheduler, random: () => 0.5 });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);
  feed('{"cmd":100005,"sid":107}'); await flush();
  feed('{"cmd":100005,"sid":107}'); await flush(); // duplicate open, same sid
  assert.equal(scheduler.pending(), 1, 'still exactly one pending timer');
  scheduler.fireAll(); await flush();
  assert.equal(betCount(), 2, 'exactly one bet for the eligible round');
});

test('recovery pause during the delay cancels the pending bet before invalidating (§47)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed, betCount, diag } = make({ scheduler, random: () => 0.85 });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);
  feed('{"cmd":100005,"sid":107}'); await flush();
  runner.stop({ reason: 'SESSION_RECOVERY' });
  assert.equal(scheduler.pending(), 0);
  scheduler.fireAll(); await flush();
  assert.equal(betCount(), 1);
  assert.ok(diag.events.some((e) => e.event === 'NEXT_BET_DELAY_CANCELLED' && e.reason === 'SESSION_RECOVERY'));
});

test('multi-browser timers are independent (B2 may fire before B1)', async () => {
  const s1 = fakeScheduler(); const s2 = fakeScheduler();
  const B1 = make({ scheduler: s1, random: () => 0.9 });
  const B2 = make({ scheduler: s2, random: () => 0.1 });
  B1.runner.start('T', DELAY); B2.runner.start('T', DELAY);
  await playQualifying(B1.feed, 100); await playQualifying(B2.feed, 200);
  B1.feed('{"cmd":100005,"sid":107}'); await flush();
  B2.feed('{"cmd":100005,"sid":207}'); await flush();
  // Fire ONLY B2 — B1 must be untouched.
  s2.fireAll(); await flush();
  assert.equal(B2.betCount(), 2, 'B2 bet independently');
  assert.equal(B1.betCount(), 1, 'B1 timer still pending, not affected by B2');
  s1.fireAll(); await flush();
  assert.equal(B1.betCount(), 2);
});

test('no fake BET history when the delay is cancelled before firing (§53/§60)', async () => {
  const scheduler = fakeScheduler();
  const { runner, feed } = make({ scheduler, random: () => 0.85 });
  runner.start('T', DELAY);
  await playQualifying(feed, 100);
  feed('{"cmd":100005,"sid":107}'); await flush();
  runner.stop();
  // Exactly one round in history (the completed round 100); no phantom row for 107.
  assert.equal(runner.history().length, 1);
  assert.equal(runner.history()[0].sid, 100);
});
