import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Stop-1000x UX fix (Goal 1): the "Dừng khi đạt 1000x" checkbox is a POLICY toggle, never a Stop.
//  - Enabling it (arm or live setEnabled) must NOT itself stop Auto.
//  - It is EDGE-triggered: a stale/previous-round odd already >= 1000 at arm time must NOT fire;
//    only a FRESH authoritative odd >= 1000 arriving AFTER arm/enable fires (§4).
//  - Flipping it ON while Auto runs takes effect for the live session (next odd >= 1000 stops once).
//  - It stays strictly BrowserRun-scoped.
// Wiring mirrors main.cjs: tracker -> observer -> runner -> Stop1000Guard.

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');
const { Stop1000Guard } = require('../../desktop/protocol/stop1000-guard.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

function make({ browserId = 'B-0001', runId = 'BR-0001' } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const harness = { execute: async (o) => { sends.push({ command: o.command }); return o.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } } : { result: 'ACK' }; } };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'https://casino.example.com/game' });
  const events = [];
  const guard = new Stop1000Guard({ observer, autoRunner: runner, browserId, browserRunId: runId, now: () => 1000 });
  guard.on('stop1000', (e) => events.push(e));
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });
  return { observer, runner, guard, events, feed, betCount: () => sends.filter((s) => s.command === 'bet').length };
}
const openRound = async (feed, sid) => { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); };
const odd = async (feed, sid, o) => { feed(`{"cmd":100009,"sid":${sid},"odd":${o}}`); await flush(); };

test('§A enabling while running (live setEnabled ON) does NOT stop Auto', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: false });     // START with checkbox OFF
  await openRound(feed, 500);
  await odd(feed, 500, 3.5);                  // normal odd, running
  assert.equal(runner.isRunning(), true);
  guard.setEnabled(true);                     // user ticks the box mid-run
  assert.equal(runner.isRunning(), true, 'enabling the checkbox must not stop Auto');
  assert.equal(guard.fired(), false);
  assert.equal(events.length, 0);
  assert.equal(guard.enabled(), true, 'the policy is now enabled for the live session');
});

test('§B after enabling mid-run: odd 999 keeps running, odd 1000 stops exactly once', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: false });
  await openRound(feed, 501);
  guard.setEnabled(true);
  await odd(feed, 501, 999);
  assert.equal(runner.isRunning(), true, '999 < 1000 keeps running');
  assert.equal(guard.fired(), false);
  await odd(feed, 501, 1000);
  assert.equal(guard.fired(), true, 'authoritative 1000 stops');
  assert.equal(runner.isRunning(), false);
  await odd(feed, 501, 1100);
  assert.equal(events.length, 1, 'exactly one stop across the burst');
});

test('§C EDGE-triggered: a stale odd >= 1000 already present at arm time does NOT fire', async () => {
  const { runner, guard, events, feed } = make();
  // A prior round already flew past 1000x while the guard was NOT armed/enabled — the observer
  // still holds that stale odd. Arming a fresh session must NOT retro-fire off it (§4).
  await openRound(feed, 600);
  await odd(feed, 600, 1500);                 // stale historical odd sits in the observer
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });       // arming must not synchronously stop
  assert.equal(guard.fired(), false, 'arm() is edge-only: no fire on a stale/previous odd');
  assert.equal(runner.isRunning(), true);
  assert.equal(events.length, 0);
  // A genuinely fresh authoritative frame >= 1000 fires normally.
  await openRound(feed, 601);
  await odd(feed, 601, 1000);
  assert.equal(guard.fired(), true);
  assert.equal(events.length, 1);
});

test('§D setEnabled ON with no new qualifying frame never stops (policy only)', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: false });
  await openRound(feed, 700);
  await odd(feed, 700, 5);                     // current odd well below 1000
  guard.setEnabled(true);                      // flip on; no new frame follows
  await flush();
  assert.equal(runner.isRunning(), true);
  assert.equal(guard.fired(), false, 'enabling alone never fires');
  assert.equal(events.length, 0);
});

test('§E disabled (setEnabled OFF mid-run): odd >= 1000 does NOT stop', async () => {
  const { runner, guard, events, feed } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  guard.arm({ stopAutoAt1000x: true });        // started ON
  await openRound(feed, 800);
  guard.setEnabled(false);                     // user unticks mid-run
  await odd(feed, 800, 999);
  await odd(feed, 800, 1000);
  await odd(feed, 800, 1500);
  assert.equal(guard.fired(), false, 'disabled policy ignores >= 1000');
  assert.equal(runner.isRunning(), true);
  assert.equal(events.length, 0);
});

test('§F multi-browser isolation: B1 live-enable + 1000x stops B1 only', async () => {
  const A = make({ browserId: 'B-0001', runId: 'BR-0001' });
  const B = make({ browserId: 'B-0002', runId: 'BR-0002' });
  A.runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  B.runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 999999 });
  A.guard.arm({ stopAutoAt1000x: false });
  B.guard.arm({ stopAutoAt1000x: false });
  await openRound(A.feed, 900); await openRound(B.feed, 901);
  A.guard.setEnabled(true); B.guard.setEnabled(true);
  await odd(A.feed, 900, 1500);                // only A gets 1000x
  assert.equal(A.guard.fired(), true);
  assert.equal(A.runner.isRunning(), false);
  assert.equal(B.guard.fired(), false, 'B untouched by A');
  assert.equal(B.runner.isRunning(), true);
  assert.equal(B.events.length, 0);
});
