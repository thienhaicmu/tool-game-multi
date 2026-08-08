import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver, validateConfig, RESULT, PHASE, STATUS } = require('../../desktop/protocol/round-observer.cjs');

// tracker + observer wired as in main, with a controllable monotonic clock.
function makeObs(config = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const clock = { t: 0 };
  const observer = new RoundObserver({ roundTracker: tracker, config, now: () => clock.t });
  const feed = (raw, direction = 'recv') => tracker.observe({ raw, direction, targetId: 'T', url: 'wss://game.host/ws' });
  return { tracker, observer, clock, feed };
}

// ---------------------------------------------------------------------------
// Read-only guarantee: the observer exposes no way to send.
// ---------------------------------------------------------------------------
test('observer is strictly read-only (no send/execute seam)', () => {
  const { observer } = makeObs();
  assert.equal(typeof observer.send, 'undefined');
  assert.equal(typeof observer.execute, 'undefined');
  assert.equal(typeof observer.sendRaw, 'undefined');
  assert.equal(observer.snapshot().readOnly, true);
});

// ---------------------------------------------------------------------------
// §1/§22 — full round state machine, phases, latencies, server odd/wm.
// ---------------------------------------------------------------------------
test('full round: OPEN -> bet ack -> odd -> cashout ack -> end => COMPLETED', () => {
  const { observer, clock, feed } = makeObs({ targetOdd: 1.50 });
  feed('{"cmd":100005,"iOE":true,"sid":100}');
  clock.t = 1000; feed('{"cmd":100002,"b":5000,"sid":100,"aid":1,"eid":1}', 'send');
  clock.t = 1040; feed('{"cmd":100002,"eid":1,"b":5000}');           // bet ack (no sid)
  feed('{"cmd":100006,"sid":100}');
  feed('{"cmd":100009,"sid":100,"odd":1.10}');
  feed('{"cmd":100009,"sid":100,"odd":1.49}');
  feed('{"cmd":100009,"sid":100,"odd":1.51}');                       // first >= target
  clock.t = 2000; feed('{"cmd":100003,"sid":100,"aid":1,"eid":1}', 'send');
  clock.t = 2035; feed('{"cmd":100003,"eid":1,"b":5000,"wm":7750,"odd":1.55}'); // cashout ack
  feed('{"cmd":100007,"sid":100,"odd":1.87}');

  const r = observer.rounds()[0];
  assert.equal(r.sid, 100);
  assert.equal(r.result, RESULT.COMPLETED);
  assert.equal(r.phase, PHASE.ROUND_FINISHED);
  assert.equal(r.triggerOdd, 1.51, 'trigger = first server odd >= target');
  assert.equal(r.serverOdd, 1.55, 'server-returned odd from cashout ack');
  assert.equal(r.wm, 7750);
  assert.equal(r.betLatencyMs, 40);
  assert.equal(r.cashoutLatencyMs, 35);
});

// ---------------------------------------------------------------------------
// §9 — trigger marker is set exactly once and never re-armed.
// ---------------------------------------------------------------------------
test('trigger marker latches on the FIRST qualifying server odd only', () => {
  const { observer, feed } = makeObs({ targetOdd: 1.50 });
  feed('{"cmd":100005,"sid":100}');
  for (const o of [1.49, 1.50, 1.51, 1.52, 1.60]) feed(`{"cmd":100009,"sid":100,"odd":${o}}`);
  const r = observer.activeRound();
  assert.equal(r.triggerOdd, 1.50, 'first value satisfying odd >= 1.50');
  assert.equal(r.maxOdd, 1.60);
});

// ---------------------------------------------------------------------------
// §13 — non-sequential SID: observer records exact server sids, never sid+1.
// ---------------------------------------------------------------------------
test('records exact server SIDs across rounds (no sid++)', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"sid":100}'); feed('{"cmd":100007,"sid":100}');
  feed('{"cmd":100005,"sid":107}'); feed('{"cmd":100007,"sid":107}');
  feed('{"cmd":100005,"sid":130}');
  assert.deepEqual(observer.rounds().map((r) => r.sid), [100, 107, 130]);
  assert.ok(!observer.rounds().some((r) => r.sid === 101), 'never fabricated 101');
});

// ---------------------------------------------------------------------------
// §14/§37 — round ends before the target odd is reached.
// ---------------------------------------------------------------------------
test('round ends before target => ROUND_ENDED_BEFORE_TRIGGER, no cashout', () => {
  const { observer, feed } = makeObs({ targetOdd: 5.00 });
  feed('{"cmd":100005,"sid":200}');
  for (const o of [1.10, 1.30, 1.80]) feed(`{"cmd":100009,"sid":200,"odd":${o}}`);
  feed('{"cmd":100007,"sid":200,"odd":1.80}');
  const r = observer.rounds()[0];
  assert.equal(r.result, RESULT.ROUND_ENDED_BEFORE_TRIGGER);
  assert.equal(r.cashout, null);
  assert.equal(r.triggerOdd, null);
});

// ---------------------------------------------------------------------------
// §16 — metrics across multiple completed rounds.
// ---------------------------------------------------------------------------
test('metrics average latencies and odds over completed rounds', () => {
  const { observer, clock, feed } = makeObs({ targetOdd: 1.50 });
  const playRound = (sid, betSent, betAck, stopSent, stopAck, serverOdd, wm) => {
    feed(`{"cmd":100005,"sid":${sid}}`);
    clock.t = betSent; feed(`{"cmd":100002,"b":5000,"sid":${sid},"aid":1,"eid":1}`, 'send');
    clock.t = betAck; feed('{"cmd":100002,"eid":1,"b":5000}');
    feed(`{"cmd":100009,"sid":${sid},"odd":1.51}`);
    clock.t = stopSent; feed(`{"cmd":100003,"sid":${sid},"aid":1,"eid":1}`, 'send');
    clock.t = stopAck; feed(`{"cmd":100003,"eid":1,"b":5000,"wm":${wm},"odd":${serverOdd}}`);
    feed(`{"cmd":100007,"sid":${sid}}`);
  };
  playRound(100, 0, 20, 100, 130, 1.55, 7750);   // bet 20ms, stop 30ms
  playRound(107, 0, 40, 100, 150, 1.53, 7650);   // bet 40ms, stop 50ms
  const m = observer.metrics();
  assert.equal(m.observed, 2);
  assert.equal(m.completed, 2);
  assert.equal(m.avgBetLatencyMs, 30);           // (20+40)/2
  assert.equal(m.avgCashoutLatencyMs, 40);       // (30+50)/2
  assert.equal(m.avgTriggerOdd, 1.51);
  assert.equal(m.avgServerOdd, 1.54);            // (1.55+1.53)/2
});

// ---------------------------------------------------------------------------
// status transitions + observeRounds bound.
// ---------------------------------------------------------------------------
test('status: IDLE -> OBSERVING -> WAITING_ROUND -> COMPLETED after N', () => {
  const { observer, feed } = makeObs({ observeRounds: 2 });
  assert.equal(observer.status(), STATUS.IDLE);
  feed('{"cmd":100005,"sid":1}');
  assert.equal(observer.status(), STATUS.OBSERVING);
  feed('{"cmd":100007,"sid":1}');
  assert.equal(observer.status(), STATUS.WAITING_ROUND);
  feed('{"cmd":100005,"sid":2}'); feed('{"cmd":100007,"sid":2}');
  assert.equal(observer.status(), STATUS.COMPLETED);
});

// ---------------------------------------------------------------------------
// §3/§30 — config validation returns typed errors.
// ---------------------------------------------------------------------------
test('config validation rejects invalid values with typed errors', () => {
  assert.equal(validateConfig({ targetOdd: 0 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(validateConfig({ targetOdd: -1 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(validateConfig({ observeRounds: 0 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(validateConfig({ observeRounds: 2.5 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(validateConfig({ oddBufferLimit: 99999 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.ok(validateConfig({ targetOdd: 1.5, observeRounds: 10 }).config);

  const { observer } = makeObs();
  assert.equal(observer.setConfig({ targetOdd: -3 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(observer.setConfig({ targetOdd: 1.5 }).config.targetOdd, 1.5);
});

// ---------------------------------------------------------------------------
// §14 — odd buffer is bounded.
// ---------------------------------------------------------------------------
test('odd buffer is bounded to oddBufferLimit', () => {
  const { observer, feed } = makeObs({ oddBufferLimit: 5 });
  feed('{"cmd":100005,"sid":1}');
  for (let i = 0; i < 20; i++) feed(`{"cmd":100009,"sid":1,"odd":${(1 + i / 100).toFixed(2)}}`);
  assert.equal(observer.activeRound().oddBuffer.length, 5);
});
