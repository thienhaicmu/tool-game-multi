import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner, validateConfig, autoHostAllowed, RESULT, STATE } = require('../../desktop/protocol/auto-runner.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

// Wire tracker -> observer -> runner exactly as main.cjs does. The fake harness
// records what it WOULD send (and the current server sid at send time, which the
// real harness binds from RoundTracker) and returns a scripted ack.
function make({ host = 'http://localhost:8080/game', exec, wallNow } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker }); // constructed BEFORE runner
  const sends = [];
  const execImpl = exec || ((opts) => opts.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } } : { result: 'ACK' });
  const harness = {
    execute: async (opts) => {
      const cr = observer.currentRound();
      sends.push({ command: opts.command, overrides: opts.overrides, sidAtSend: cr ? cr.sid : null, passedSid: 'sid' in opts });
      return execImpl(opts, sends);
    },
  };
  const clock = { t: 0 };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => host, now: () => clock.t, wallNow, environmentGuard: true });
  const feed = (raw, direction = 'recv') => tracker.observe({ raw, direction, targetId: 'T', url: 'wss://game.local/ws' });
  const betCount = () => sends.filter((s) => s.command === 'bet').length;
  const cashCount = () => sends.filter((s) => s.command === 'cashout').length;
  return { tracker, observer, runner, harness, sends, feed, clock, betCount, cashCount };
}
async function playQualifying(feed, sid, odds) {
  feed(`{"cmd":100005,"sid":${sid}}`); await flush();          // bet sent + acked -> WATCHING_ODD
  for (const o of odds) feed(`{"cmd":100009,"sid":${sid},"odd":${o}}`);
  await flush();                                                // cashout sent + acked
}

// ---------------------------------------------------------------------------
// §2 — product targets are no longer local-gated.
// ---------------------------------------------------------------------------
test('autoHostAllowed: loopback + reserved test names only', () => {
  assert.equal(autoHostAllowed('localhost'), true);
  assert.equal(autoHostAllowed('127.0.0.1'), true);
  assert.equal(autoHostAllowed('game.test.local'), true);
  assert.equal(autoHostAllowed('dev.localhost'), true);
  assert.equal(autoHostAllowed('casino.example.com'), false);
  assert.equal(autoHostAllowed('aviator.realmoney.io'), false);
  assert.equal(autoHostAllowed('staging.acme.com', ['staging.acme.com']), true); // explicit env extension
});

test('start accepts a non-local target', () => {
  const { runner } = make({ host: 'https://casino.example.com/game' });
  const r = runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2 });
  assert.ok(r.ok);
  assert.equal(runner.isRunning(), true);
  assert.equal(runner.state(), STATE.WAITING_ROUND);
});

test('start accepts a local target', () => {
  const { runner } = make({ host: 'http://127.0.0.1:9000/game' });
  const r = runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2 });
  assert.ok(r.ok);
  assert.equal(runner.state(), STATE.WAITING_ROUND);
});

// ---------------------------------------------------------------------------
// §3/§31 — SID comes only from the server; never sid+1.
// ---------------------------------------------------------------------------
test('requests use the exact server SID (100, 107), never 101', async () => {
  const { runner, feed, sends } = make();
  runner.start('T', { roundCount: 2, amount: 5000, stopOdd: 2 });
  await playQualifying(feed, 100, [2.5]);
  feed('{"cmd":100007,"sid":100}');
  await playQualifying(feed, 107, [2.5]);
  const sids = sends.map((s) => s.sidAtSend);
  assert.ok(sids.includes(100) && sids.includes(107));
  assert.ok(!sids.includes(101), 'never fabricated 101');
  assert.ok(sends.every((s) => s.passedSid === false), 'runner never passes its own sid — harness binds the server sid');
});

// ---------------------------------------------------------------------------
// §5/§32 — live server odd drives state; trigger only at first odd >= stopOdd.
// ---------------------------------------------------------------------------
test('live odd updates; trigger occurs only at the first odd >= stopOdd', async () => {
  const { runner, observer, feed, cashCount } = make();
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2.0 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  const seen = [];
  for (const o of [1.50, 1.75, 1.99]) { feed(`{"cmd":100009,"sid":100,"odd":${o}}`); seen.push(observer.currentRound().currentOdd); }
  assert.deepEqual(seen, [1.50, 1.75, 1.99]);
  assert.equal(cashCount(), 0, 'no cashout below threshold');
  feed('{"cmd":100009,"sid":100,"odd":2.01}'); await flush();
  assert.equal(cashCount(), 1, 'cashout at the first qualifying server odd');
  assert.equal(runner.history()[0].triggerOdd, 2.01);
  assert.equal(runner.metrics().successfulStops, 1);
  assert.equal(runner.metrics().lastSuccessfulStopOdd, 2.05);
});

test('round snapshot 100008 starts an auto-run bet on the server SID', async () => {
  const { runner, feed, sends, betCount } = make();
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2.0 });
  feed('["5",{"cmd":100008,"sid":2989872}]'); await flush();
  assert.equal(betCount(), 1);
  assert.equal(sends[0].sidAtSend, 2989872);
});

// ---------------------------------------------------------------------------
// §14/§33 — EXACTLY-ONCE cashout under a burst of qualifying frames.
// ---------------------------------------------------------------------------
test('CRITICAL: a burst of qualifying odds yields exactly ONE cashout', async () => {
  const { runner, feed, cashCount } = make();
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2.0 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  for (const o of [2.00, 2.01, 2.02, 2.20, 3.00]) feed(`{"cmd":100009,"sid":100,"odd":${o}}`);
  await flush();
  assert.equal(cashCount(), 1);
  assert.equal(runner.history()[0].triggerOdd, 2.00, 'triggered on the first qualifying frame');
});

// ---------------------------------------------------------------------------
// §11/§34 — bet ACK gate: no ack => never evaluate stop => no cashout.
// ---------------------------------------------------------------------------
test('no bet ACK => cashout never sent', async () => {
  const { runner, feed, cashCount } = make({ exec: (opts) => opts.command === 'bet' ? { result: 'TIMEOUT' } : { result: 'ACK' } });
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2.0 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":2.50}'); await flush();
  assert.equal(cashCount(), 0);
  assert.equal(runner.history()[0].result, RESULT.BET_ACK_TIMEOUT);
});

// ---------------------------------------------------------------------------
// §18/§35 — round ends before threshold => no cashout.
// ---------------------------------------------------------------------------
test('round ends before threshold => no cashout, ROUND_ENDED_BEFORE_THRESHOLD', async () => {
  const { runner, feed, cashCount } = make();
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2.0 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  for (const o of [1.10, 1.40, 1.60]) feed(`{"cmd":100009,"sid":100,"odd":${o}}`);
  feed('{"cmd":100007,"sid":100,"odd":1.60}'); await flush();
  assert.equal(cashCount(), 0);
  assert.equal(runner.history()[0].result, RESULT.ROUND_ENDED_BEFORE_THRESHOLD);
});

// ---------------------------------------------------------------------------
// §16 — triggerOdd (server 100009) vs ackOdd (server 100003 ack) stored apart.
// ---------------------------------------------------------------------------
test('triggerOdd and server ackOdd are recorded separately', async () => {
  const { runner, feed } = make({ exec: (o) => o.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.09, wm: 8100 } } : { result: 'ACK' } });
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2.0 });
  await playQualifying(feed, 100, [1.9, 2.03]);
  const r = runner.history()[0];
  assert.equal(r.triggerOdd, 2.03);
  assert.equal(r.ackOdd, 2.09);
  assert.equal(r.wm, 8100);
  assert.notEqual(r.triggerOdd, r.ackOdd);
  assert.equal(runner.metrics().successfulStops, 1);
  assert.equal(runner.metrics().lastSuccessfulStopOdd, 2.09);
});

test('successful stops are grouped and filterable by local day', async () => {
  let wall = new Date(2026, 8, 3, 9, 0, 0).getTime();
  const { runner, feed } = make({ wallNow: () => wall });
  runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2.0 });
  await playQualifying(feed, 100, [2.5]);
  wall = new Date(2026, 8, 4, 10, 0, 0).getTime();
  await playQualifying(feed, 107, [2.5]);

  assert.deepEqual(runner.history().map((r) => r.finishedDay), ['2026-09-03', '2026-09-04']);
  assert.equal(runner.metricsForDay('2026-09-03').successfulStops, 1);
  assert.equal(runner.metricsForDay('2026-09-04').successfulStops, 1);
  assert.deepEqual(runner.dayGroups().map((g) => g.day), ['2026-09-04', '2026-09-03']);
});

// ---------------------------------------------------------------------------
// §20/§36 — multi-round: exact server sids; threshold cashout resets the cycle.
// ---------------------------------------------------------------------------
test('threshold cashout resets progress to the next cycle instead of continuing the old count', async () => {
  const { runner, feed, sends, betCount, cashCount } = make();
  runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2.0 });
  for (const sid of [100, 107, 130]) { await playQualifying(feed, sid, [2.5]); feed(`{"cmd":100007,"sid":${sid}}`); await flush(); }
  assert.equal(betCount(), 3);
  assert.equal(cashCount(), 3);
  assert.deepEqual(sends.filter((s) => s.command === 'bet').map((s) => s.sidAtSend), [100, 107, 130]);
  assert.equal(runner.state(), STATE.WAITING_ROUND);
  assert.equal(runner.isRunning(), true);
  assert.deepEqual(runner.history().map((r) => r.index), [0, 0, 0]);
  assert.deepEqual(runner.snapshot().progress, { attempted: 0, finished: 0, target: 3 });
  feed('{"cmd":100005,"sid":130}'); await flush();
  assert.equal(betCount(), 3, 'reset does not re-bet duplicate open/snapshot for the same sid');
  feed('{"cmd":100005,"sid":180}'); await flush();
  assert.equal(runner.snapshot().active.index, 0, 'next round starts as 1 / roundCount');
});

test('does not start more than roundCount rounds when no threshold reset happens', async () => {
  const { runner, feed, betCount } = make();
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2.0 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":1.5}');
  feed('{"cmd":100007,"sid":100}'); await flush();
  feed('{"cmd":100005,"sid":107}'); await flush(); // extra server round after target reached
  assert.equal(betCount(), 1, 'no bet for the 2nd round beyond roundCount');
  assert.equal(runner.state(), STATE.COMPLETED);
});

// ---------------------------------------------------------------------------
// §10 — duplicate 100005 for the same sid must not double-send.
// ---------------------------------------------------------------------------
test('duplicate 100005 for the same sid does not send a second bet', async () => {
  const { runner, feed, betCount } = make();
  runner.start('T', { roundCount: 2, amount: 5000, stopOdd: 2.0 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100005,"sid":100}'); await flush(); // duplicate announce, same sid
  assert.equal(betCount(), 1);
});

// ---------------------------------------------------------------------------
// §21/§37 — manual stop: no new rounds, no cashout just because we stopped.
// ---------------------------------------------------------------------------
test('stop: no new rounds start and no extra request is sent', async () => {
  const { runner, feed, betCount, cashCount } = make();
  runner.start('T', { roundCount: 5, amount: 5000, stopOdd: 2.0 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":1.50}');            // below threshold
  const s = runner.stop();
  assert.ok(s.ok);
  assert.equal(runner.state(), STATE.STOPPED);
  feed('{"cmd":100005,"sid":107}'); await flush();        // server opens another round
  assert.equal(betCount(), 1, 'no new bet after stop');
  assert.equal(cashCount(), 0, 'stop never triggers a cashout');
  assert.equal(runner.stop().error.code, 'AUTO_TEST_NOT_RUNNING');
});

// ---------------------------------------------------------------------------
// §6/§30 — config validation.
// ---------------------------------------------------------------------------
test('config validation rejects invalid values', () => {
  assert.equal(validateConfig({ roundCount: 0, amount: 5000, stopOdd: 2 }).error.code, 'INVALID_AUTO_TEST_CONFIG');
  assert.equal(validateConfig({ roundCount: 3, amount: 0, stopOdd: 2 }).error.code, 'INVALID_AUTO_TEST_CONFIG');
  assert.equal(validateConfig({ roundCount: 3, amount: 5000, stopOdd: 0 }).error.code, 'INVALID_AUTO_TEST_CONFIG');
  assert.equal(validateConfig({ roundCount: 3, amount: 5000, stopOdd: 2, aid: -1 }).error.code, 'INVALID_AUTO_TEST_CONFIG');
  assert.ok(validateConfig({ roundCount: 10, amount: 5000, stopOdd: 2 }).config);
});

test('start twice => AUTO_TEST_ALREADY_RUNNING', () => {
  const { runner } = make();
  runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2 });
  assert.equal(runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2 }).error.code, 'AUTO_TEST_ALREADY_RUNNING');
});
