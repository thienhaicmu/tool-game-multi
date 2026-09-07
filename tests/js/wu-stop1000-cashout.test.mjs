import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner, RESULT } = require('../../desktop/protocol/auto-runner.cjs');
const { Stop1000Guard } = require('../../desktop/protocol/stop1000-guard.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// cashoutResult lets a test script the server response to the 1000x cashout.
function make({ cashoutResult } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const cash = cashoutResult || { result: 'ACK', responsePayload: { odd: 1000, wm: 5000000 } };
  const harness = { execute: async (o) => { sends.push(o.command); return o.command === 'cashout' ? cash : { result: 'ACK' }; } };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'https://casino.example.com/game' });
  const finals = []; runner.on('executionFinalized', (r) => finals.push(r));
  const guard = new Stop1000Guard({ observer, autoRunner: runner, browserId: 'B-1', browserRunId: 'BR-1' });
  const events = []; guard.on('stop1000', (e) => events.push(e));
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://g/ws' });
  const betCount = () => sends.filter((s) => s === 'bet').length;
  const cashCount = () => sends.filter((s) => s === 'cashout').length;
  return { runner, observer, guard, events, feed, betCount, cashCount, finals };
}
async function openRound(feed, sid) { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); }
async function odd(feed, sid, o) { feed(`{"cmd":100009,"sid":${sid},"odd":${o}}`); await flush(); }

// ---------------------------------------------------------------------------
// Open bet at 1000x → CASHOUT is sent to secure the win, THEN the session stops.
// ---------------------------------------------------------------------------
test('1000x with an OPEN bet sends a cashout, then terminates the session', async () => {
  const { runner, guard, feed, cashCount, finals, events } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 }); // no early per-round cashout
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 900);                 // bet placed + ACK, bet stays OPEN
  await odd(feed, 900, 1000);                 // hits 1000x
  assert.equal(cashCount(), 1, 'a cashout was sent to secure the 1000x win');
  assert.equal(guard.fired(), true);
  assert.equal(events.length, 1);
  assert.equal(runner.isRunning(), false, 'session terminated after the cashout');
  const r = runner.history()[0];
  assert.equal(r.result, RESULT.COMPLETED, 'round result is the authoritative cashout WIN');
  assert.equal(r.triggerOdd, 1000, 'cashout triggered at the authoritative 1000x odd');
  assert.equal(runner.snapshot().terminationReason, 'STOPPED_1000X_REACHED');
  assert.equal(finals[0].stopReason, 'STOP_1000X_REACHED');
  assert.equal(finals[0].stopOdd, 1000, 'stopOdd captured from the authoritative observer odd');
});

// ---------------------------------------------------------------------------
// If the 1000x cashout does NOT get an ACK, the result is UNKNOWN (never fabricated),
// but the session still terminates with the 1000x reason.
// ---------------------------------------------------------------------------
test('1000x cashout timeout → UNKNOWN result, session still stops', async () => {
  const { runner, guard, feed, cashCount } = make({ cashoutResult: { result: 'TIMEOUT' } });
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 901);
  await odd(feed, 901, 1234.5);
  assert.equal(cashCount(), 1, 'cashout attempted');
  assert.equal(runner.history()[0].result, RESULT.CASHOUT_ACK_TIMEOUT, 'no ACK → not a fabricated WIN');
  assert.equal(runner.isRunning(), false, 'session still terminates');
  assert.equal(runner.snapshot().terminationReason, 'STOPPED_1000X_REACHED');
});

// ---------------------------------------------------------------------------
// If the round was ALREADY cashed out at stopOdd before 1000x, do NOT double-cashout.
// ---------------------------------------------------------------------------
test('already cashed out at stopOdd → no second cashout at 1000x, plain stop', async () => {
  const { runner, guard, feed, cashCount } = make({ cashoutResult: { result: 'ACK', responsePayload: { odd: 2.05 } } });
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 2 });  // per-round cashout at 2.0
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 902);
  await odd(feed, 902, 2.05);                 // round cashed out here (position closed)
  assert.equal(cashCount(), 1);
  await odd(feed, 902, 1000);                 // same round climbs to 1000x AFTER the cashout
  assert.equal(guard.fired(), true);
  assert.equal(cashCount(), 1, 'no duplicate cashout — the bet was already closed at stopOdd');
  assert.equal(runner.isRunning(), false, 'session terminated');
  assert.equal(runner.snapshot().terminationReason, 'STOPPED_1000X_REACHED');
});

// ---------------------------------------------------------------------------
// Exactly-once cashout under a burst of qualifying frames.
// ---------------------------------------------------------------------------
test('burst above 1000 yields exactly ONE cashout and one stop', async () => {
  const { runner, guard, feed, cashCount, events } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });
  await openRound(feed, 903);
  feed('{"cmd":100009,"sid":903,"odd":1000}');
  feed('{"cmd":100009,"sid":903,"odd":1200}');
  feed('{"cmd":100009,"sid":903,"odd":1500}');
  await flush();
  assert.equal(cashCount(), 1, 'exactly one cashout despite the burst');
  assert.equal(events.length, 1, 'exactly one stop event');
  assert.equal(runner.isRunning(), false);
});
