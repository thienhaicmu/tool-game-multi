import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../../desktop/analytics/query/statistics.cjs');
const { wilson, sampleQuality } = require('../../desktop/analytics/query/confidence.cjs');
const { normalizeFilter, FilterError, buildWhere } = require('../../desktop/analytics/query/analytics-filter.cjs');
const { DIST_BUCKETS } = require('../../desktop/analytics/query/analytics-query-engine.cjs');

// ---- Wilson CI (§36.20-23) ----
test('Wilson 50/100 matches reference [0.4038,0.5962]', () => {
  const w = wilson(50, 100);
  assert.equal(w.rate, 0.5);
  assert.ok(Math.abs(w.low - 0.4038) < 0.001);
  assert.ok(Math.abs(w.high - 0.5962) < 0.001);
});
test('Wilson n=0 → null (no NaN/Infinity)', () => { const w = wilson(0, 0); assert.equal(w.rate, null); assert.equal(w.low, null); assert.equal(w.high, null); });
test('Wilson zero successes / all successes', () => {
  assert.equal(wilson(0, 40).rate, 0); assert.ok(wilson(0, 40).low >= 0);
  assert.equal(wilson(40, 40).rate, 1); assert.ok(wilson(40, 40).high <= 1);
});
test('sample quality thresholds', () => {
  assert.equal(sampleQuality(29), 'VERY_LOW'); assert.equal(sampleQuality(30), 'LOW');
  assert.equal(sampleQuality(100), 'MODERATE'); assert.equal(sampleQuality(1000), 'GOOD');
});

// ---- quantiles (§36.27-30) ----
test('quantile odd/even + P50==median', () => {
  assert.equal(S.median([1, 2, 3]), 2);
  assert.equal(S.median([1, 2, 3, 4]), 2.5);
  assert.equal(S.quantile([1, 2, 3, 4], 0.5), S.median([1, 2, 3, 4]));
  const d = S.describe([10, 20, 30, 40, 50]);
  assert.equal(d.median, 30); assert.equal(d.p50, 30); assert.equal(d.min, 10); assert.equal(d.max, 50);
});

// ---- distribution (§36.24-26) ----
test('distribution boundaries are half-open [min,max); no overlap; sum invariant', () => {
  const vals = [1.19, 1.20, 1.49, 1.50, 2.00, 999.99, 1000, 1500];
  const d = S.distribution(vals, DIST_BUCKETS);
  const byLabel = Object.fromEntries(d.buckets.map((b) => [b.label, b.count]));
  assert.equal(byLabel['<1.20'], 1);          // 1.19
  assert.equal(byLabel['1.20–1.49'], 2);      // 1.20, 1.49
  assert.equal(byLabel['1.50–1.99'], 1);      // 1.50
  assert.equal(byLabel['2.00–2.99'], 1);      // 2.00
  assert.equal(byLabel['500.00–999.99'], 1);  // 999.99
  assert.equal(byLabel['>=1000'], 2);         // 1000, 1500
  const sum = d.buckets.reduce((a, b) => a + b.count, 0);
  assert.equal(sum, d.total); assert.equal(sum, vals.length);
});

// ---- streaks (§36.48-51) ----
test('streaks: current excluded from completed; longest includes current', () => {
  // <2: [1.1,1.1 (run2 completed by 3.0), 1.5 (run1 completed by 5), then trailing 1.1,1.1,1.1 current=3]
  const v = [1.1, 1.1, 3.0, 1.5, 5.0, 1.1, 1.1, 1.1];
  const s = S.streaks(v, 2);
  assert.equal(s.currentStreak, 3);
  assert.equal(s.completedStreakCount, 2);          // runs of 2 and 1
  assert.equal(s.longestStreak, 3);                  // trailing current run
  assert.deepEqual(s.distribution['1'], 1);
  assert.deepEqual(s.distribution['2'], 1);
  assert.equal(s.medianCompletedStreak, 1.5);
});

// ---- gaps (§36.52-57) ----
test('gap off-by-one: positions 10 & 15 → completed gap 4', () => {
  const v = new Array(16).fill(1); v[10] = 20; v[15] = 20;
  const g = S.gaps(v, 10);
  assert.equal(g.occurrences, 2); assert.equal(g.completedGapCount, 1);
  assert.equal(g.averageGapRounds, 4); assert.equal(g.currentGapRounds, 0); assert.equal(g.hasPriorOccurrence, true);
});
test('gap: no occurrence → hasPriorOccurrence=false, currentGap=n', () => {
  const g = S.gaps([1, 1, 1, 1], 10);
  assert.equal(g.occurrences, 0); assert.equal(g.hasPriorOccurrence, false);
  assert.equal(g.currentGapRounds, 4); assert.equal(g.averageGapRounds, null);
});
test('gap: single occurrence → no completed gaps, current gap after it', () => {
  const v = [1, 20, 1, 1]; const g = S.gaps(v, 10);
  assert.equal(g.occurrences, 1); assert.equal(g.completedGapCount, 0); assert.equal(g.currentGapRounds, 2);
});
test('gap: multiple occurrences percentiles', () => {
  const v = new Array(30).fill(1); [0, 3, 10, 12].forEach((i) => (v[i] = 50)); // gaps: 2,6,1
  const g = S.gaps(v, 50);
  assert.equal(g.occurrences, 4); assert.equal(g.completedGapCount, 3);
  assert.equal(g.minGapRounds, 1); assert.equal(g.maxGapRounds, 6);
});

// ---- rolling (§36.44-46) ----
test('rolling N=10 exact fixture; first point is a full window; deterministic order', () => {
  const vals = [1, 3, 1, 3, 3, 1, 1, 3, 3, 3, 1, 3]; // 12 values, >=2 flags
  const series = S.rolling(vals, 2, 10);
  assert.equal(series.length, 3);                 // indices 9,10,11
  assert.equal(series[0].index, 9); assert.equal(series[0].windowSize, 10);
  // first window flags[0..9]: 0,1,0,1,1,0,0,1,1,1 => 6 reached
  assert.equal(series[0].reachedCount, 6); assert.equal(series[0].observedRate, 0.6);
  assert.ok(series[1].index < series[2].index);
});
test('rolling returns empty when fewer than window rounds', () => {
  assert.deepEqual(S.rolling([3, 3], 2, 10), []);
});

// ---- filter validation (§36.61-62) ----
test('normalizeFilter rejects invalid jackpot basis and invalid N', () => {
  assert.throws(() => normalizeFilter({ jackpotBasis: 'NONSENSE' }), (e) => e instanceof FilterError);
  assert.throws(() => normalizeFilter({ lastNRounds: -5 }), (e) => e instanceof FilterError);
  assert.throws(() => normalizeFilter({ hourFrom: 99 }), (e) => e instanceof FilterError);
  assert.throws(() => normalizeFilter({ specificDate: 'nope' }), (e) => e instanceof FilterError);
});
test('normalizeFilter defaults: COMPLETE only, jackpot basis AT_OPEN; clamps N', () => {
  const f = normalizeFilter({});
  assert.deepEqual(f.completeness, ['COMPLETE']);
  assert.equal(f.jackpotBasis, 'JACKPOT_AT_OPEN');
  assert.equal(normalizeFilter({ lastNRounds: 9e9 }).lastNRounds, 100000); // MAX_LAST_N clamp
});
test('buildWhere default is COMPLETE-only and combines AND', () => {
  const f = normalizeFilter({ browserId: 'B-1', maxOddMin: 2, jackpotMin: 300 });
  const w = buildWhere(f, { includeAnalytic: true });
  assert.match(w.clause, /completeness IN/);
  assert.match(w.clause, /max_odd >= \?/);
  assert.match(w.clause, /jackpot_at_open IS NOT NULL/);
  assert.match(w.clause, / AND /);
});
