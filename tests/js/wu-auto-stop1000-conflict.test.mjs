import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner, STATE } = require('../../desktop/protocol/auto-runner.cjs');
const { Stop1000Guard } = require('../../desktop/protocol/stop1000-guard.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

// Deterministic scheduler for the next-round bet delay (no real sleeps).
function fakeScheduler() {
  let seq = 0; const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fireAll() { const fns = [...timers.values()].map((t) => t.fn); timers.clear(); fns.forEach((fn) => fn()); },
    pending() { return timers.size; },
  };
}

// Wire tracker -> observer -> AutoRunner (delay ON) -> Stop1000Guard, exactly as
// main.cjs does for a LOCAL endpoint: the guard reads the observer's authoritative
// odd, the runner owns the per-round cashout + the next-round random bet delay.
function make() {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const harness = { execute: async (o) => { sends.push(o.command); return o.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05 } } : { result: 'ACK' }; } };
  const scheduler = fakeScheduler();
  const finals = [];
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'https://casino.example.com/game', random: () => 0.5, scheduler });
  runner.on('executionFinalized', (r) => finals.push(r));
  const guard = new Stop1000Guard({ observer, autoRunner: runner, browserId: 'B-1', browserRunId: 'BR-1' });
  const events = []; guard.on('stop1000', (e) => events.push(e));
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://g/ws' });
  const betCount = () => sends.filter((s) => s === 'bet').length;
  return { runner, observer, guard, events, feed, scheduler, finals, betCount };
}
const CFG = { roundCount: 5, amount: 5000, stopOdd: 2, nextRoundBetDelay: true, betDelayMinMs: 0, betDelayMaxMs: 1000 };
async function playCashout(feed, sid) { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); feed(`{"cmd":100009,"sid":${sid},"odd":2.05}`); await flush(); }

// ---------------------------------------------------------------------------
// Stop-1000x fires while the runner is BETWEEN rounds (WAITING_NEXT_ROUND):
// same authoritative round keeps climbing to 1000 after the per-round cashout.
// ---------------------------------------------------------------------------
test('1000x during WAITING_NEXT_ROUND terminates cleanly, no conflict', async () => {
  const { runner, guard, events, feed, betCount } = make();
  runner.start('T', CFG);
  guard.arm({ stopAutoAt1000x: true });
  await playCashout(feed, 100);                 // round 1: bet + cashout at stopOdd=2
  assert.equal(runner.state(), STATE.WAITING_NEXT_ROUND);
  assert.equal(betCount(), 1);
  feed('{"cmd":100009,"sid":100,"odd":1000}'); await flush();  // same round climbs to 1000x
  assert.equal(guard.fired(), true, 'kill switch fires from the observer odd');
  assert.equal(runner.isRunning(), false, 'Auto session terminated');
  assert.equal(runner.snapshot().terminationReason, 'STOPPED_1000X_REACHED');
  assert.equal(events.length, 1);
  // A later ROUND_OPEN must not resurrect Auto.
  feed('{"cmd":100005,"sid":107}'); await flush();
  assert.equal(betCount(), 1, 'no new bet after 1000x termination');
});

// ---------------------------------------------------------------------------
// Stop-1000x fires while a next-round BET is scheduled (WAITING_NEXT_BET_DELAY):
// the pending timer must be cancelled and never fire a bet after termination.
// ---------------------------------------------------------------------------
test('1000x during WAITING_NEXT_BET_DELAY cancels the pending bet (no conflict)', async () => {
  const { runner, guard, events, feed, scheduler, finals, betCount } = make();
  runner.start('T', CFG);
  guard.arm({ stopAutoAt1000x: true });
  await playCashout(feed, 200);                 // round 1 cashout -> WAITING_NEXT_ROUND
  feed('{"cmd":100005,"sid":207}'); await flush();  // round 2 opens -> schedule delayed bet
  assert.equal(runner.state(), STATE.WAITING_NEXT_BET_DELAY);
  assert.equal(runner.liveness().ok, true, 'delay is a legitimate active state, not a liveness break');
  assert.equal(scheduler.pending(), 1, 'a delayed bet is pending');
  // The scheduled round rockets to 1000x during the delay window.
  feed('{"cmd":100009,"sid":207,"odd":1500}'); await flush();
  assert.equal(guard.fired(), true);
  assert.equal(runner.isRunning(), false);
  assert.equal(scheduler.pending(), 0, 'pending next-round bet timer was cancelled by the stop');
  scheduler.fireAll(); await flush();           // even a stray fire must not bet
  assert.equal(betCount(), 1, 'exactly the round-1 bet; the delayed round-2 bet never sent');
  assert.equal(events.length, 1);
  // Execution history records the 1000x terminal reason (not a fabricated bet).
  assert.equal(finals.length, 1);
  assert.equal(finals[0].stopReason, 'STOP_1000X_REACHED');
});

// ---------------------------------------------------------------------------
// The two thresholds are independent: stopOdd cashes out a round, the session
// continues, and the delay keeps working — 1000x only kills the whole session.
// ---------------------------------------------------------------------------
test('stopOdd cashout + next-round delay continue normally while 1000x stays armed but quiet', async () => {
  const { runner, guard, feed, scheduler, betCount } = make();
  runner.start('T', CFG);
  guard.arm({ stopAutoAt1000x: true });
  await playCashout(feed, 300);                 // round1 cashout at 2.05 (well below 1000)
  assert.equal(guard.fired(), false, 'kill switch quiet below 1000');
  assert.equal(runner.isRunning(), true, 'session continues after per-round cashout');
  feed('{"cmd":100005,"sid":307}'); await flush();  // round2 opens -> delay scheduled
  scheduler.fireAll(); await flush();           // delay elapses -> round2 bet
  assert.equal(betCount(), 2, 'next-round delayed bet fires normally when 1000x has not triggered');
  assert.equal(guard.fired(), false);
  assert.equal(runner.isRunning(), true);
});
