import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsQueryEngine, normalizeFilter } = require('../../desktop/analytics/query/analytics-query-engine.cjs');
const { THRESHOLDS, thresholdKey } = require('../../desktop/analytics/thresholds.cjs');

function fresh() {
  const store = new AnalyticsStore({ file: ':memory:' });
  const engine = new AnalyticsQueryEngine({ store });
  const sessionByBrowser = new Map();
  function session(b) { if (!sessionByBrowser.has(b)) sessionByBrowser.set(b, store.sessions.start({ browserId: b, startedAtMs: 0 })); return sessionByBrowser.get(b); }
  let seq = 0;
  function seed(browserId, o) {
    const sid = session(browserId);
    seq += 1;
    const openedAtMs = o.openedAtMs != null ? o.openedAtMs : seq * 60000;
    const completeness = o.completeness || 'COMPLETE';
    const id = store.rounds.insertRound({ captureSessionId: sid, browserId, sid: seq, sequenceNumber: seq, openedAtMs, completeness });
    store.rounds.updateRound(id, {
      sid: seq, openedAtMs, firstOddAtMs: openedAtMs, endedAtMs: openedAtMs + 5000, durationMs: 5000,
      firstOdd: 1, lastOdd: o.maxOdd, maxOdd: o.maxOdd,
      jackpotAtOpen: o.jackpotAtOpen != null ? o.jackpotAtOpen : null, jackpotAtEnd: o.jackpotAtEnd != null ? o.jackpotAtEnd : null,
      oddSampleCount: 1, jackpotSampleCount: 0, completeness,
    });
    const reached = {}, timings = {};
    for (const t of THRESHOLDS) { const k = thresholdKey(t); reached[k] = o.maxOdd >= t; timings[k] = o.maxOdd >= t ? (o.timeTo != null ? o.timeTo : 1000) : null; }
    store.rounds.upsertMetrics(id, { reached, timings, censored: !!o.timingCensored });
    return id;
  }
  return { store, engine, seed };
}
const F = (o) => normalizeFilter(o);

// ---- filters (§36.1-13) ----
test('browser filter isolates populations', () => {
  const { engine, seed } = fresh();
  for (const m of [1.1, 2, 3]) seed('B-1', { maxOdd: m });
  for (const m of [5, 10]) seed('B-2', { maxOdd: m });
  assert.equal(engine.overview(F({ browserId: 'B-1' })).summary.matchedRounds, 3);
  assert.equal(engine.overview(F({ browserId: 'B-2' })).summary.matchedRounds, 2);
});

test('last-N selects the chronologically latest N after other filters', () => {
  const { engine, seed } = fresh();
  const vals = [1.1, 1.5, 2, 3, 5, 10, 1.2, 1.8, 2.5, 50];
  for (const m of vals) seed('B-1', { maxOdd: m });
  const ov = engine.overview(F({ browserId: 'B-1', lastNRounds: 3 }));
  assert.equal(ov.summary.matchedRounds, 3);
  // last 3 seq → maxOdds 1.8,2.5,50 → >=2 count = 2
  const t2 = ov.thresholds.find((t) => t.threshold === 2);
  assert.equal(t2.sampleCount, 3); assert.equal(t2.reachedCount, 2);
});

test('maxOdd range filter', () => {
  const { engine, seed } = fresh();
  for (const m of [1.1, 2, 5, 10, 50]) seed('B-1', { maxOdd: m });
  assert.equal(engine.overview(F({ browserId: 'B-1', maxOddMin: 5 })).summary.matchedRounds, 3);
});

test('jackpot basis range filter excludes NULL basis and reports missing count', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 2, jackpotAtOpen: 350 });
  seed('B-1', { maxOdd: 3, jackpotAtOpen: 800 });
  seed('B-1', { maxOdd: 4, jackpotAtOpen: null }); // no basis value
  const ov = engine.overview(F({ browserId: 'B-1', jackpotBasis: 'JACKPOT_AT_OPEN', jackpotMin: 300, jackpotMax: 500 }));
  assert.equal(ov.summary.matchedRounds, 1);                 // only the 350 round
  assert.equal(ov.summary.missingJackpotBasis, 1);           // the NULL basis round among candidates
});

test('completeness default excludes partial; opt-in includes', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 2, completeness: 'COMPLETE' });
  seed('B-1', { maxOdd: 3, completeness: 'PARTIAL_START' });
  assert.equal(engine.overview(F({ browserId: 'B-1' })).summary.matchedRounds, 1);
  assert.equal(engine.overview(F({ browserId: 'B-1', completeness: ['COMPLETE', 'PARTIAL_START'] })).summary.matchedRounds, 2);
});

test('hour filter (derived from openedAt local hour)', () => {
  const { engine, seed } = fresh();
  const base = Date.now();
  const h = new Date(base).getHours();
  seed('B-1', { maxOdd: 2, openedAtMs: base });
  // a round 3 hours earlier (different local hour, wrap-safe pick)
  seed('B-1', { maxOdd: 3, openedAtMs: base - 3 * 3600000 });
  const only = engine.overview(F({ browserId: 'B-1', hourFrom: h, hourTo: h }));
  assert.equal(only.summary.matchedRounds, 1);
});

test('combined AND intersection', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 2, jackpotAtOpen: 400 });
  seed('B-1', { maxOdd: 8, jackpotAtOpen: 400 });
  seed('B-1', { maxOdd: 8, jackpotAtOpen: 900 });
  const ov = engine.overview(F({ browserId: 'B-1', maxOddMin: 5, jackpotMin: 300, jackpotMax: 500 }));
  assert.equal(ov.summary.matchedRounds, 1); // maxOdd>=5 AND jp in 300..500 → only the 8/400 round
});

// ---- thresholds (§36.14-19) ----
test('threshold counts, denominator and observed rate', () => {
  const { engine, seed } = fresh();
  for (const m of [1.1, 1.5, 2, 3, 5, 10, 1.2, 1.8, 2.5, 50]) seed('B-1', { maxOdd: m });
  const t = engine.thresholds(F({ browserId: 'B-1' })).thresholds.find((x) => x.threshold === 2);
  assert.equal(t.sampleCount, 10);
  assert.equal(t.reachedCount, 6); // 2,3,5,10,2.5,50
  assert.equal(t.observedRate, 0.6);
});

test('n=0 threshold returns null rate (no NaN)', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 2 });
  const t = engine.thresholds(F({ browserId: 'B-1', maxOddMin: 999 })).thresholds[0];
  assert.equal(t.sampleCount, 0); assert.equal(t.observedRate, null);
});

// ---- distribution (§36.24-26) ----
test('distribution sum invariant equals eligible count', () => {
  const { engine, seed } = fresh();
  for (const m of [1.1, 1.3, 1.7, 2.5, 4, 8, 15, 30, 80, 300, 700, 1500]) seed('B-1', { maxOdd: m });
  const d = engine.distribution(F({ browserId: 'B-1' }));
  assert.equal(d.invariant.ok, true);
  assert.equal(d.invariant.bucketSum, d.summary.matchedRounds);
});

// ---- timing (§36.40-43) ----
test('timing excludes censored partial-start rows but counts them in reach', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 3, completeness: 'COMPLETE', timeTo: 1000, timingCensored: false });
  seed('B-1', { maxOdd: 3, completeness: 'PARTIAL_START', timeTo: 2000, timingCensored: true });
  const t = engine.timing(F({ browserId: 'B-1', completeness: ['COMPLETE', 'PARTIAL_START'] })).thresholds.find((x) => x.threshold === 2);
  assert.equal(t.eligibleRoundCount, 2);
  assert.equal(t.reachedCount, 2);          // both reached >=2 (reach rate denominator)
  assert.equal(t.timingSampleCount, 1);     // only the uncensored COMPLETE contributes timing
  assert.equal(t.timing.median, 1000);
});

// ---- jackpot buckets (§36.35-39) ----
test('jackpot basis switching changes population; custom buckets no overlap; missing count', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 2, jackpotAtOpen: 50, jackpotAtEnd: 1500 });
  seed('B-1', { maxOdd: 3, jackpotAtOpen: 250, jackpotAtEnd: 250 });
  seed('B-1', { maxOdd: 4, jackpotAtOpen: null, jackpotAtEnd: 300 });
  const open = engine.jackpotBuckets(F({ browserId: 'B-1', jackpotBasis: 'JACKPOT_AT_OPEN' }));
  assert.equal(open.missingBasisCount, 1); // the null-at-open round
  const end = engine.jackpotBuckets(F({ browserId: 'B-1', jackpotBasis: 'JACKPOT_AT_END' }));
  assert.equal(end.missingBasisCount, 0);  // all have at-end
  // buckets are mutually exclusive: total samples across buckets == rows with basis
  const openSum = open.buckets.reduce((a, b) => a + b.samples, 0);
  assert.equal(openSum, 2);
});

// ---- time / hourly (§36.31-32) ----
test('hourly always returns 24 buckets; empty hours retained', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 2, openedAtMs: Date.now() });
  const h = engine.hourly(F({ browserId: 'B-1' }));
  assert.equal(h.buckets.length, 24);
  assert.ok(h.buckets.some((b) => b.sampleCount === 0)); // most hours empty
});

// ---- rolling / sequence continuity (§36.44-47) ----
test('rolling requires a single browser (no interleaving)', () => {
  const { engine, seed } = fresh();
  seed('B-1', { maxOdd: 3 });
  const disabled = engine.rolling(F({}), 2, 10);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.reason, 'SEQUENCE_REQUIRES_SINGLE_BROWSER');
});

test('rolling series over a single browser is deterministic full-window', () => {
  const { engine, seed } = fresh();
  for (const m of [1, 3, 1, 3, 3, 1, 1, 3, 3, 3, 1, 3]) seed('B-1', { maxOdd: m });
  const r = engine.rolling(F({ browserId: 'B-1' }), 2, 10);
  assert.equal(r.series.length, 3);
  assert.equal(r.series[0].observedRate, 0.6);
});

// ---- streaks / gaps (§36.48-57) ----
test('streaks over a browser sequence', () => {
  const { engine, seed } = fresh();
  for (const m of [1.1, 1.1, 3.0, 1.5, 5.0, 1.1, 1.1, 1.1]) seed('B-1', { maxOdd: m });
  const s = engine.streaks(F({ browserId: 'B-1' })).thresholds.find((x) => x.threshold === 2);
  assert.equal(s.currentStreak, 3);
  assert.equal(s.completedStreakCount, 2);
});

test('gaps over a browser sequence with off-by-one', () => {
  const { engine, seed } = fresh();
  const vals = new Array(16).fill(1); vals[10] = 20; vals[15] = 20;
  for (const m of vals) seed('B-1', { maxOdd: m });
  const g = engine.gaps(F({ browserId: 'B-1' })).thresholds.find((x) => x.threshold === 10);
  assert.equal(g.occurrences, 2); assert.equal(g.averageGapRounds, 4); assert.equal(g.currentGapRounds, 0);
});

// ---- lastN snapshot ----
test('lastN snapshot returns available counts', () => {
  const { engine, seed } = fresh();
  for (const m of [2, 3, 1, 5]) seed('B-1', { maxOdd: m });
  const snap = engine.lastNSnapshot(F({ browserId: 'B-1' }));
  const last10 = snap.snapshots.find((s) => s.n === 10);
  const t2 = last10.thresholds.find((t) => t.threshold === 2);
  assert.equal(t2.available, 4); assert.equal(t2.reachedCount, 3); // 2,3,5 >=2
});
