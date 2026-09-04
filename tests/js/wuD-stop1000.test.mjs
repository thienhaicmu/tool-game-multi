import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');
const { Stop1000Guard, STOP_1000X_THRESHOLD, REASON } = require('../../desktop/protocol/stop1000-guard.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

// Wire tracker -> observer -> runner -> Stop1000Guard exactly as main.cjs does. The
// guard reads the observer's authoritative odd, never the runner's per-round listener.
function make({ browserId = 'B-0001', runId = 'BR-0001', clockMs = 1000 } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const harness = {
    execute: async (opts) => {
      sends.push({ command: opts.command });
      return opts.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } } : { result: 'ACK' };
    },
  };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'https://casino.example.com/game' });
  const wall = { t: clockMs };
  const events = [];
  const guard = new Stop1000Guard({ observer, autoRunner: runner, browserId, browserRunId: runId, now: () => wall.t });
  guard.on('stop1000', (e) => events.push(e));
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });
  const betCount = () => sends.filter((s) => s.command === 'bet').length;
  const cashCount = () => sends.filter((s) => s.command === 'cashout').length;
  return { tracker, observer, runner, guard, events, feed, betCount, cashCount, wall };
}

// Open a round and push the bet through to WATCHING_ODD (bet is auto-acked).
async function openRound(feed, sid) { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); }
async function odd(feed, sid, o) { feed(`{"cmd":100009,"sid":${sid},"odd":${o}}`); await flush(); }

// ---------------------------------------------------------------------------
// §7.5 — Stop-1000x mandatory tests
// ---------------------------------------------------------------------------

test('threshold + reason constants are the fixed product values', () => {
  assert.equal(STOP_1000X_THRESHOLD, 1000);
  assert.equal(REASON, 'STOPPED_1000X_REACHED');
});

test('default false: never triggers even at 2000x', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 }); // stopOdd high: no per-round cashout
  guard.arm({}); // stopAutoAt1000x omitted -> disabled
  await openRound(feed, 500);
  await odd(feed, 500, 2000);
  assert.equal(guard.fired(), false);
  assert.equal(events.length, 0);
  assert.equal(runner.isRunning(), true);
});

test('999.99 does not trigger; exact 1000 triggers', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 501);
  await odd(feed, 501, 999.99);
  assert.equal(guard.fired(), false, '999.99 < 1000 must not trigger');
  await odd(feed, 501, 1000);
  assert.equal(guard.fired(), true, 'exactly 1000 must trigger');
  assert.equal(events.length, 1);
  assert.equal(runner.isRunning(), false);
});

test('> 1000 triggers and records the exact observed odd', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 502);
  await odd(feed, 502, 1234.5);
  assert.equal(guard.fired(), true);
  assert.equal(events[0].observedOdd, 1234.5);
  assert.equal(events[0].threshold, 1000);
  assert.equal(events[0].reason, REASON);
  assert.equal(events[0].sid, 502);
  assert.equal(events[0].browserId, 'B-0001');
  assert.equal(events[0].browserRunId, 'BR-0001');
});

test('fires exactly once across a burst of qualifying frames', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 503);
  await odd(feed, 503, 1000);
  await odd(feed, 503, 1200);
  await odd(feed, 503, 1500);
  assert.equal(events.length, 1, 'a burst above 1000 produces exactly one stop');
});

test('terminal reason is STOPPED_1000X_REACHED, distinct from manual STOPPED', async () => {
  const { runner, guard, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 504);
  await odd(feed, 504, 1500);
  assert.equal(runner.snapshot().terminationReason, 'STOPPED_1000X_REACHED');
});

test('manual Stop keeps a distinct MANUAL terminationReason', async () => {
  const { runner, guard, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 2 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 505);
  runner.stop(); // manual
  assert.equal(runner.snapshot().terminationReason, 'MANUAL');
  assert.equal(guard.fired(), false);
});

test('normal N-round completion keeps a distinct COMPLETED terminationReason', async () => {
  const { runner, feed } = make();
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2 });
  await openRound(feed, 506);
  feed('{"cmd":100007,"sid":506}'); await flush(); // ROUND_END before threshold -> round finished; count exhausted
  assert.equal(runner.isRunning(), false);
  assert.equal(runner.snapshot().terminationReason, 'COMPLETED');
});

test('stopOdd per-round cashout is unchanged when the guard is armed but below 1000', async () => {
  const { runner, guard, feed, cashCount } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 2 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 507);
  await odd(feed, 507, 2.05); // crosses stopOdd -> cashout this round
  assert.equal(cashCount(), 1, 'per-round cashout still fires at stopOdd');
  assert.equal(guard.fired(), false, '2.05 < 1000: session kill switch stays quiet');
  assert.equal(runner.isRunning(), true, 'Auto session continues after a per-round cashout');
});

test('Stop-1000x remains observable AFTER a per-round cashout', async () => {
  const { runner, guard, feed, cashCount } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 2 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 508);
  await odd(feed, 508, 2.05);       // cashout at stopOdd; runner resets, keeps running
  assert.equal(cashCount(), 1);
  assert.equal(runner.isRunning(), true);
  await odd(feed, 508, 1000);       // same round keeps climbing past 1000 after cashout
  assert.equal(guard.fired(), true, 'guard observes 1000x via RoundObserver, not the runner');
  assert.equal(runner.isRunning(), false);
});

test('a terminated session is not restarted by the next ROUND_OPEN or delayed frames', async () => {
  const { runner, guard, events, feed, betCount } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 509);
  const betsBefore = betCount();
  await odd(feed, 509, 1500);       // fire
  assert.equal(runner.isRunning(), false);
  await openRound(feed, 510);       // next ROUND_OPEN must NOT resurrect Auto
  await odd(feed, 510, 1500);       // delayed events must NOT re-fire
  feed('{"cmd":100007,"sid":510}'); await flush(); // ROUND_END must NOT restart
  assert.equal(betCount(), betsBefore, 'no new bet after termination');
  assert.equal(events.length, 1, 'no second stop event');
});

test('isolation: browser A reaching 1000x does not stop browser B', async () => {
  const A = make({ browserId: 'B-0001', runId: 'BR-0001' });
  const B = make({ browserId: 'B-0002', runId: 'BR-0002' });
  A.runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  B.runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  A.guard.arm({ stopAutoAt1000x: true });
  B.guard.arm({ stopAutoAt1000x: true });
  await openRound(A.feed, 600);
  await openRound(B.feed, 700);
  await odd(A.feed, 600, 1500);     // only A crosses 1000x
  assert.equal(A.guard.fired(), true);
  assert.equal(A.runner.isRunning(), false);
  assert.equal(B.guard.fired(), false, 'B is untouched');
  assert.equal(B.runner.isRunning(), true);
  assert.equal(B.events.length, 0);
});

test('re-arm resets the fired latch for a fresh session (run config snapshot)', async () => {
  const { runner, guard, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 800);
  await odd(feed, 800, 1500);
  assert.equal(guard.fired(), true);
  // A fresh Auto start re-arms; a new arm captures the new session's config and clears
  // the latch. Disabling for the new session means no fire even above 1000.
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: false });
  assert.equal(guard.fired(), false, 'latch cleared on re-arm');
  await openRound(feed, 801);
  await odd(feed, 801, 1500);
  assert.equal(guard.fired(), false, 'new session config (disabled) is honored');
});
