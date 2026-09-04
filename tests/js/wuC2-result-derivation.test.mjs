import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { RoundHistoryStore } = require('../../desktop/browser-run/round-history-store.cjs');
const { deriveRoundRecord, RoundHistoryCollector } = require('../../desktop/browser-run/round-history-collector.cjs');

// An AutoRunner publicRound shape (see auto-runner.cjs publicRound()).
function pub(over = {}) {
  return {
    index: 0, sid: 100, amount: 5000, stopOdd: 2,
    betResult: 'ACK', betLatencyMs: 12, betAckAmount: 5000,
    triggerOdd: null, ackOdd: null, wm: null, maxOdd: null,
    triggerToSendMs: null, cashoutLatencyMs: null,
    result: 'ROUND_ENDED_BEFORE_THRESHOLD', error: null,
    openedAtMs: 1_700_000_000_000, finishedAtMs: 1_700_000_005_000, finishedDay: '2023-11-14', ...over,
  };
}
const derive = (over) => deriveRoundRecord({ browserId: 'B-0001', runId: 'BR-0001', pub: pub(over), at: 1_700_000_005_000 });

// WIN path — the ONLY authoritative WIN evidence: server cashout ACK (COMPLETED).
test('WIN: server cashout ACK (COMPLETED) -> WIN with CASHOUT_ACK provenance', () => {
  const r = derive({ result: 'COMPLETED', ackOdd: 2.1, wm: 7750, maxOdd: 2.3 });
  assert.equal(r.result, 'WIN');
  assert.equal(r.resultEvidence.source, 'CASHOUT_ACK');
  assert.equal(r.resultEvidence.authoritative, true);
  assert.equal(r.cashoutAckOdd, 2.1);
});

// §54 — participation known but no settlement evidence -> UNKNOWN (not LOSS).
test('UNKNOWN: round ended before threshold -> UNKNOWN (never LOSS)', () => {
  const r = derive({ result: 'ROUND_ENDED_BEFORE_THRESHOLD' });
  assert.equal(r.result, 'UNKNOWN');
  assert.equal(r.resultEvidence.source, 'INSUFFICIENT_SERVER_EVIDENCE');
  assert.equal(r.terminationReason, 'ROUND_ENDED_BEFORE_THRESHOLD');
});

// §43 — client cashout requested but no confirmation must NOT be a WIN.
test('client cashout without confirmation (CASHOUT_ACK_TIMEOUT) -> UNKNOWN', () => {
  const r = derive({ result: 'CASHOUT_ACK_TIMEOUT', triggerOdd: 2.4 });
  assert.equal(r.result, 'UNKNOWN');
});

// §44 — ODD crossing the threshold alone is not a WIN without settlement.
test('odd threshold reached without cashout settlement -> UNKNOWN', () => {
  const r = derive({ result: 'ROUND_ENDED_BEFORE_THRESHOLD', stopOdd: 2, triggerOdd: null, maxOdd: 2.1 });
  assert.equal(r.result, 'UNKNOWN');
  assert.equal(r.highestObservedOdd, 2.1);
});

// §42 — wm presence alone never implies payout / WIN.
test('wm present but not COMPLETED -> UNKNOWN, payout null, wm kept raw only', () => {
  const r = derive({ result: 'CASHOUT_REJECTED', wm: 99999 });
  assert.equal(r.result, 'UNKNOWN');
  assert.equal(r.payout, null);
  assert.equal(r.wmRaw, 99999);
});

// §15 — requested vs accepted bet distinction preserved.
test('bet amounts: requested from client, accepted from server ACK; unknown -> null', () => {
  const accepted = derive({ betResult: 'ACK', amount: 7777, betAckAmount: 5000 });
  assert.equal(accepted.requestedBet, 7777);
  assert.equal(accepted.acceptedBet, 5000);
  assert.equal(accepted.participated, true);

  const rejected = derive({ betResult: 'REJECTED', result: 'BET_REJECTED', amount: 7777, betAckAmount: null });
  assert.equal(rejected.requestedBet, 7777);
  assert.equal(rejected.acceptedBet, null, 'no accepted amount when not ACKed');
  assert.equal(rejected.participated, false, 'rejected bet is not a played round');
});

// §14 — unknown numeric facts are null, not 0.
test('unknown odds/bet are null, never 0', () => {
  const r = derive({ betResult: 'TIMEOUT', result: 'BET_ACK_TIMEOUT', betAckAmount: null, triggerOdd: null, ackOdd: null, maxOdd: null });
  assert.equal(r.acceptedBet, null);
  assert.equal(r.triggerOdd, null);
  assert.equal(r.cashoutAckOdd, null);
  assert.equal(r.highestObservedOdd, null);
  assert.equal(r.payout, null);
});

// highestObservedOdd falls back to the strongest authoritative odds actually seen.
test('highestObservedOdd uses observer maxOdd, else authoritative trigger/ack', () => {
  assert.equal(derive({ maxOdd: 8.75, triggerOdd: 2.4, ackOdd: 2.4 }).highestObservedOdd, 8.75);
  assert.equal(derive({ maxOdd: null, triggerOdd: 2.4, ackOdd: 3.1, result: 'COMPLETED' }).highestObservedOdd, 3.1);
  assert.equal(derive({ maxOdd: null, triggerOdd: null, ackOdd: null }).highestObservedOdd, null);
});

// ---- Collector attribution (structural, never UI selection) ----
test('collector persists a finalized round under the OWNING run browserId', () => {
  const store = new RoundHistoryStore({}); // in-memory
  const runner = new EventEmitter();
  new RoundHistoryCollector({ store, browserId: 'B-0007', runId: 'BR-0042', autoRunner: runner });
  runner.emit('roundFinalized', pub({ sid: 555, result: 'COMPLETED', ackOdd: 2.0 }));
  const list = store.list('B-0007');
  assert.equal(list.length, 1);
  assert.equal(list[0].browserId, 'B-0007');
  assert.equal(list[0].runId, 'BR-0042');
  assert.equal(list[0].sid, 555);
  assert.equal(list[0].result, 'WIN');
  assert.equal(store.list('B-0001').length, 0);
});

// §38/§52 — concurrent runners attribute only to their own browser; a frame from A
// never lands under B, regardless of any UI selection (there is none here).
test('concurrent collectors: each runner writes only to its own browser history', () => {
  const store = new RoundHistoryStore({});
  const runnerA = new EventEmitter();
  const runnerB = new EventEmitter();
  new RoundHistoryCollector({ store, browserId: 'B-0001', runId: 'BR-A', autoRunner: runnerA });
  new RoundHistoryCollector({ store, browserId: 'B-0002', runId: 'BR-B', autoRunner: runnerB });

  runnerA.emit('roundFinalized', pub({ sid: 123, result: 'COMPLETED' }));
  runnerB.emit('roundFinalized', pub({ sid: 123, result: 'ROUND_ENDED_BEFORE_THRESHOLD' }));

  assert.deepEqual(store.list('B-0001').map((r) => [r.sid, r.result]), [[123, 'WIN']]);
  assert.deepEqual(store.list('B-0002').map((r) => [r.sid, r.result]), [[123, 'UNKNOWN']]);
  assert.equal(store.list('B-0001').length, 1);
  assert.equal(store.list('B-0002').length, 1);
});

// onPersisted fires with the owning browserId (drives targeted UI refresh).
test('collector notifies onPersisted with the owning browserId', () => {
  const store = new RoundHistoryStore({});
  const runner = new EventEmitter();
  let notified = null;
  new RoundHistoryCollector({ store, browserId: 'B-0003', runId: 'BR-X', autoRunner: runner, onPersisted: (bid) => { notified = bid; } });
  runner.emit('roundFinalized', pub({ sid: 1 }));
  assert.equal(notified, 'B-0003');
});
