import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { RoundHistoryStore } = require('../../desktop/browser-run/round-history-store.cjs');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wvpt-hist-')); }
function store(dir) { return new RoundHistoryStore({ dir }); }
function rec(over = {}) {
  return {
    browserId: 'B-0001', runId: 'BR-0001', sid: 100,
    startedAt: '2023-11-14T00:00:00.000Z', endedAt: '2023-11-14T00:00:05.000Z',
    requestedBet: 5000, acceptedBet: 5000, stopOdd: 2,
    triggerOdd: 2.1, cashoutAckOdd: 2.1, highestObservedOdd: 3.5,
    payout: null, wmRaw: 7750, result: 'WIN', resultEvidence: { source: 'CASHOUT_ACK' },
    participated: true, terminationReason: 'COMPLETED', ...over,
  };
}

// §50 — persistence across a fresh store instance.
test('persistence: a finalized record survives a store reload', () => {
  const dir = tmpDir();
  const s1 = store(dir);
  s1.upsert(rec({ sid: 123 }));
  const s2 = store(dir);
  const list = s2.list('B-0001');
  assert.equal(list.length, 1);
  assert.equal(list[0].sid, 123);
  assert.equal(list[0].result, 'WIN');
  assert.equal(list[0].resultEvidence.source, 'CASHOUT_ACK');
});

// §51 — history is owned per persistent browser.
test('ownership: listBrowserRounds returns only that browser\'s records', () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(rec({ browserId: 'B-0001', runId: 'BR-A', sid: 123 }));
  s.upsert(rec({ browserId: 'B-0002', runId: 'BR-B', sid: 456 }));
  assert.deepEqual(s.list('B-0001').map((r) => r.sid), [123]);
  assert.deepEqual(s.list('B-0002').map((r) => r.sid), [456]);
});

// §39 — the SAME sid on two browsers stays two distinct records.
test('same SID across browsers is never merged', () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(rec({ browserId: 'B-0001', runId: 'BR-A', sid: 123, result: 'WIN' }));
  s.upsert(rec({ browserId: 'B-0002', runId: 'BR-B', sid: 123, result: 'UNKNOWN' }));
  assert.equal(s.list('B-0001').length, 1);
  assert.equal(s.list('B-0002').length, 1);
  assert.equal(s.list('B-0001')[0].result, 'WIN');
  assert.equal(s.list('B-0002')[0].result, 'UNKNOWN');
});

// §40 — same browser, different runs, both kept.
test('same browser reopen: records from different runs both persist', () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(rec({ runId: 'BR-A', sid: 100 }));
  s.upsert(rec({ runId: 'BR-B', sid: 101 }));
  const list = s.list('B-0001');
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.runId).sort(), ['BR-A', 'BR-B']);
});

// §19/§53 — idempotent upsert: same identity does not duplicate.
test('duplicate terminal evidence yields one logical record (idempotent upsert)', () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(rec({ sid: 100, result: 'UNKNOWN' }));
  const r2 = s.upsert(rec({ sid: 100, result: 'WIN' })); // late authoritative enrich
  assert.equal(r2.updated, true);
  const list = s.list('B-0001');
  assert.equal(list.length, 1, 'no duplicate record');
  assert.equal(list[0].result, 'WIN');
});

// §55 — statistics formulas (participated WIN/WIN/LOSS/UNKNOWN).
test('stats: totals, resolved win-rate denominator, and unknown handling', () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(rec({ sid: 1, result: 'WIN', acceptedBet: 5000, highestObservedOdd: 1.2 }));
  s.upsert(rec({ sid: 2, result: 'WIN', acceptedBet: 5000, highestObservedOdd: 2.4 }));
  s.upsert(rec({ sid: 3, result: 'LOSS', acceptedBet: 5000, highestObservedOdd: 8.75 }));
  s.upsert(rec({ sid: 4, result: 'UNKNOWN', acceptedBet: null, highestObservedOdd: 4.1 }));
  const st = s.stats('B-0001');
  assert.equal(st.totalRounds, 4);
  assert.equal(st.wins, 2);
  assert.equal(st.losses, 1);
  assert.equal(st.unknown, 1);
  assert.equal(st.resolvedWinRate, 2 / 3, 'wins/(wins+losses), not wins/total');
  // §57 — highest odd, unscaled.
  assert.equal(st.highestObservedOdd, 8.75);
});

// §56 — unproven monetary fields are null, never fabricated 0.
test('null money: payout and net are unavailable (never 0)', () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(rec({ sid: 1, acceptedBet: 5000 }));
  s.upsert(rec({ sid: 2, acceptedBet: null }));            // unknown accepted bet
  const st = s.stats('B-0001');
  assert.equal(st.totalPayout, null);
  assert.equal(st.netResult, null);
  assert.equal(st.payoutAvailable, false);
  assert.equal(st.totalBet, 5000, 'sums only proven accepted bets');
  assert.equal(st.betUnknownCount, 1);
});

test('stats: win-rate is null (not NaN) when no resolved rounds', () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(rec({ sid: 1, result: 'UNKNOWN', acceptedBet: null }));
  const st = s.stats('B-0001');
  assert.equal(st.resolvedWinRate, null);
  assert.equal(st.totalBet, null, 'participated but no proven bet -> null, not 0');
});

// §58 — restart: reload yields the same records, no fabricated runtime state.
test('restart: reload preserves all records', () => {
  const dir = tmpDir();
  const s1 = store(dir);
  for (let i = 1; i <= 5; i++) s1.upsert(rec({ sid: i }));
  const s2 = store(dir);
  assert.equal(s2.count('B-0001'), 5);
});

// §49 — corruption is reported and never silently overwritten.
test('corrupt history file is preserved and never overwritten', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'B-0001.json');
  fs.writeFileSync(file, '{ broken json ', 'utf8');
  const s = store(dir);
  assert.deepEqual(s.list('B-0001'), []);
  assert.equal(s.isCorrupt('B-0001'), true);
  const up = s.upsert(rec({ sid: 1 }));
  assert.equal(up.error.code, 'BROWSER_HISTORY_CORRUPT');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken json ', 'corrupt file preserved');
});

// Record validation guards.
test('records without browserId/runId/sid are rejected', () => {
  const s = store(tmpDir());
  assert.equal(s.upsert({ runId: 'BR-A', sid: 1 }).error.code, 'BROWSER_HISTORY_INVALID_RECORD');
  assert.equal(s.upsert({ browserId: 'B-1', sid: 1 }).error.code, 'BROWSER_HISTORY_INVALID_RECORD');
});
