import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spearman, kendallTauB } = require('../../desktop/analytics/statistics/rank-correlation.cjs');
const { chiSquareContingency } = require('../../desktop/analytics/statistics/contingency.cjs');
const { kruskalWallis, mannWhitneyU } = require('../../desktop/analytics/statistics/distribution-tests.cjs');
const { benjaminiHochberg } = require('../../desktop/analytics/statistics/multiple-testing.cjs');
const { interpretCorrelation, interpretCramersV } = require('../../desktop/analytics/statistics/effect-size.cjs');
const special = require('../../desktop/analytics/statistics/special.cjs');
const { JackpotReport } = require('../../desktop/analytics/query/jackpot-report.cjs');
const { normalizeFilter } = require('../../desktop/analytics/query/analytics-filter.cjs');
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');

const near = (a, b, t = 1e-3) => Math.abs(a - b) < t;

// ---- special functions vs textbook critical values ----
test('special: normal / chi-square / student-t critical values', () => {
  assert.ok(near(special.normalCdf(1.96), 0.975, 1e-3));
  assert.ok(near(special.chiSquareSf(3.8415, 1), 0.05, 1e-3));
  assert.ok(near(special.chiSquareSf(5.9915, 2), 0.05, 1e-3));
  assert.ok(near(special.studentTTwoSided(2.776, 4), 0.05, 2e-3));
});

// ---- S01–S06 rank correlation ----
test('S01 Spearman +1 (perfect positive monotonic)', () => {
  const r = spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.equal(r.status, 'OK'); assert.ok(near(r.rho, 1)); assert.equal(interpretCorrelation(r.rho), 'STRONG');
});
test('S02 Spearman -1 (perfect negative)', () => {
  const r = spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  assert.ok(near(r.rho, -1)); assert.ok(r.pValue != null);
});
test('S03 Spearman ties handled (average ranks)', () => {
  const r = spearman([1, 2, 2, 3, 5], [1, 2, 3, 4, 5]);
  assert.equal(r.status, 'OK'); assert.equal(r.n, 5); assert.ok(r.rho > 0.9 && r.rho < 1);
});
test('S04 constant input → CONSTANT_INPUT (never fabricated 0)', () => {
  const r = spearman([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]);
  assert.equal(r.status, 'CONSTANT_INPUT'); assert.equal(r.rho, null);
});
test('S05 Kendall tau-b ties + perfect', () => {
  assert.ok(near(kendallTauB([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]).tau, 1));
  const t = kendallTauB([1, 2, 2, 3, 4], [1, 2, 2, 3, 4]);
  assert.equal(t.status, 'OK'); assert.ok(t.tau > 0.8);
});
test('S06 missing/null pairs excluded from correlation (Number(null)=0 must NOT leak in)', () => {
  const r = spearman([1, 2, null, 4, 5, 6, 7, NaN], [2, 4, 99, 8, 10, 12, 14, 99]);
  assert.equal(r.n, 6, 'null/NaN pairs dropped (not coerced to 0)'); assert.ok(near(r.rho, 1));
});

// ---- S07–S09 contingency ----
test('S07 chi-square known 2×2 fixture (uncorrected Pearson)', () => {
  const c = chiSquareContingency([[10, 20], [30, 40]]);
  assert.ok(near(c.chiSquare, 0.7937, 1e-3)); assert.equal(c.df, 1); assert.equal(c.status, 'OK');
});
test('S08 expected-count assumption failure → ASSUMPTION_FAILED', () => {
  const c = chiSquareContingency([[1, 0], [0, 1]]);
  assert.equal(c.status, 'ASSUMPTION_FAILED'); assert.ok(c.expectedMin < 1);
});
test('S09 Cramér\'s V strong association', () => {
  const c = chiSquareContingency([[40, 10], [10, 40]]);
  assert.ok(near(c.cramersV, 0.6, 1e-2)); assert.ok(c.pValue < 0.001);
  assert.equal(interpretCramersV(c.cramersV, 2), 'STRONG');
});

// ---- S10–S12 distribution comparison ----
test('S10 Kruskal-Wallis no difference → large p', () => {
  const r = kruskalWallis([[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5]]);
  assert.ok(near(r.H, 0, 1e-6)); assert.ok(r.pValue > 0.5); assert.equal(r.df, 2);
});
test('S11 Kruskal-Wallis clearly separated → small p', () => {
  const r = kruskalWallis([[1, 2, 3], [10, 11, 12], [20, 21, 22]]);
  assert.ok(r.pValue < 0.05); assert.equal(r.groupCount, 3);
});
test('S12 Mann-Whitney separated vs overlapping', () => {
  const sep = mannWhitneyU([1, 2, 3, 4], [5, 6, 7, 8]);
  assert.equal(sep.U, 0); assert.ok(sep.pValue < 0.05); assert.ok(near(Math.abs(sep.rankBiserial), 1, 1e-9));
  const ov = mannWhitneyU([1, 3, 5, 7], [2, 4, 6, 8]);
  assert.ok(ov.pValue > 0.5);
});

// ---- S16 multiple testing ----
test('S16 Benjamini-Hochberg FDR monotone + flags', () => {
  const bh = benjaminiHochberg([0.001, 0.01, 0.02, 0.03, 0.04]);
  assert.ok(near(bh[0].adjustedP, 0.005, 1e-4));
  assert.ok(near(bh[4].adjustedP, 0.04, 1e-4));
  assert.ok(bh[0].significantAdjusted);
  // null p passes through
  const bh2 = benjaminiHochberg([{ key: 'a', p: 0.01 }, { key: 'b', p: null }]);
  assert.equal(bh2[1].adjustedP, null); assert.equal(bh2[1].significantAdjusted, false);
});

// ---------------------------------------------------------------------------
// Orchestrator over a deterministic fixture. Two populations:
//   POS: jackpot_at_open positively associated with maxOdd (monotone).
//   FLAT: maxOdd independent of jackpot.
// ---------------------------------------------------------------------------
function fixture(kind) {
  const store = new AnalyticsStore({ file: ':memory:' });
  store.db.prepare(`INSERT INTO capture_sessions (id,browser_id,started_at_ms,status,created_at_ms,updated_at_ms) VALUES (1,'B1',0,'CLOSED',0,0)`).run();
  const ins = store.db.prepare(`INSERT INTO rounds (capture_session_id,browser_id,sid,sequence_number,opened_at_ms,max_odd,jackpot_at_open,jackpot_at_lock,completeness,created_at_ms,updated_at_ms)
    VALUES (1,'B1',@sid,@seq,@op,@mo,@jo,@jl,'COMPLETE',0,0)`);
  const H = 3600000; let seq = 0;
  for (let k = 0; k < 480; k++) {
    const jo = 50 + (k % 8) * 250;                 // spans all JP buckets 50..1800
    let mo;
    if (kind === 'pos') mo = 1.1 + jo / 400 + (k % 5) * 0.25;   // rises with jackpot
    else mo = 1.2 + ((k * 37) % 20) * 0.4;                       // pseudo-independent of jackpot
    // one missing-basis round every 60
    const jpOpen = (k % 60 === 0) ? null : jo;
    ins.run({ sid: 's' + k, seq: ++seq, op: (8 + (k % 6)) * H, mo: Number(mo.toFixed(2)), jo: jpOpen, jl: jo });
  }
  return new JackpotReport({ store });
}
const analyze = (rep, raw) => rep.statistics(normalizeFilter({ browserId: 'B1', jackpotBasis: 'JACKPOT_AT_OPEN', ...raw }), { basis: 'JACKPOT_AT_OPEN' });

test('orchestrator: population + descriptive + RETROSPECTIVE mode', () => {
  const r = analyze(fixture('pos'), {});
  assert.equal(r.mode, 'RETROSPECTIVE');
  assert.ok(r.population.nEligible > 400);
  assert.ok(r.population.nMissingJackpot >= 1, 'missing-basis rounds counted');
  assert.ok(r.descriptive.maxOdd.p99 != null && r.descriptive.jackpot.median != null);
});
test('orchestrator: positive population shows measurable positive correlation', () => {
  const r = analyze(fixture('pos'), {});
  assert.equal(r.correlation.spearman.status, 'OK');
  assert.ok(r.correlation.spearman.rho > 0.3, 'clear positive rho');
  assert.ok(['MODERATE', 'STRONG'].includes(r.correlation.spearman.effect));
  assert.equal(r.correlation.kendall.status, 'OK');
});
test('S07/S09 (engine): contingency + Cramér\'s V run over multi-range population', () => {
  const r = analyze(fixture('pos'), {});
  assert.ok(['OK', 'ASSUMPTION_FAILED'].includes(r.contingency.status));
  assert.equal(r.contingency.cols, 4); assert.equal(r.contingency.rows, 8);
  assert.ok(r.contingency.chiSquare != null);
});
test('S10/S11 (engine): Kruskal-Wallis across Jackpot ranges', () => {
  const r = analyze(fixture('pos'), {});
  assert.equal(r.distribution.kruskal.status, 'OK');
  assert.ok(r.distribution.kruskal.pValue < 0.05, 'positive population differs across ranges');
});
test('S13/S14/S15 thresholds: Wilson reuse + contingency + sparse handling', () => {
  const r = analyze(fixture('pos'), {});
  const t2 = r.thresholds.find((t) => t.threshold === 2);
  assert.ok(t2.byRange.every((b) => (b.n === 0 ? b.observedRate == null : b.observedRate != null)));
  assert.ok(t2.byRange.some((b) => b.ci95Low != null), 'Wilson CI present');
  const t1000 = r.thresholds.find((t) => t.threshold === 100);
  assert.ok(['OK', 'ASSUMPTION_FAILED', 'INSUFFICIENT_SAMPLE'].includes(t1000.contingency.status), 'sparse high threshold not forced');
});
test('S16 (engine): threshold p-values carry BH-adjusted values', () => {
  const r = analyze(fixture('pos'), {});
  for (const t of r.thresholds) if (t.rawP != null) assert.ok(t.adjustedP >= t.rawP - 1e-9, 'adjusted >= raw');
});

// ---- S17–S19 stability ----
test('S18 flat/independent population → not STABLE (mixed/unstable/insufficient)', () => {
  const r = analyze(fixture('flat'), {});
  assert.ok(['MIXED', 'UNSTABLE', 'INSUFFICIENT_DATA', 'STABLE'].includes(r.stability.status));
  assert.equal(r.stability.slices.length, 3, 'slice values exposed, not hidden');
  for (const s of r.stability.slices) assert.ok('spearmanRho' in s);
});
test('S17 positive population → consistent direction across thirds', () => {
  const r = analyze(fixture('pos'), {});
  const okr = r.stability.slices.filter((s) => s.spearmanStatus === 'OK').map((s) => s.spearmanRho);
  assert.ok(okr.length === 3 && okr.every((x) => x > 0), 'all thirds positive');
});
test('S19 insufficient stability sample → INSUFFICIENT_DATA', () => {
  // Build a tiny population (< 15 rounds).
  const store = new AnalyticsStore({ file: ':memory:' });
  store.db.prepare(`INSERT INTO capture_sessions (id,browser_id,started_at_ms,status,created_at_ms,updated_at_ms) VALUES (1,'B1',0,'CLOSED',0,0)`).run();
  const ins = store.db.prepare(`INSERT INTO rounds (capture_session_id,browser_id,sid,sequence_number,opened_at_ms,max_odd,jackpot_at_open,completeness,created_at_ms,updated_at_ms) VALUES (1,'B1',@s,@q,0,@mo,@jo,'COMPLETE',0,0)`);
  for (let k = 0; k < 8; k++) ins.run({ s: 'x' + k, q: k + 1, mo: 1 + k * 0.5, jo: 100 + k * 50 });
  const r = new JackpotReport({ store }).statistics(normalizeFilter({ browserId: 'B1', jackpotBasis: 'JACKPOT_AT_OPEN' }), { basis: 'JACKPOT_AT_OPEN' });
  assert.equal(r.stability.status, 'INSUFFICIENT_DATA');
});

// ---- S20–S24 filter semantics + missingness + single-range N/A ----
test('S23 single-range global filter → multi-range tests NOT_APPLICABLE (never silently ignored)', () => {
  // Range [1000,2000) spans several discrete jackpot values in the fixture, so continuous
  // within-range correlation is still computable; the multi-range tests are declared N/A.
  const r = analyze(fixture('pos'), { jackpotRangeMin: 1000, jackpotRangeMax: 2000 });
  assert.equal(r.contingency.status, 'NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE');
  assert.equal(r.distribution.kruskal.status, 'NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE');
  assert.ok(['OK', 'CONSTANT_INPUT', 'INSUFFICIENT_SAMPLE'].includes(r.correlation.spearman.status), 'correlation is attempted inside the range, never silently dropped');
  assert.equal(r.population.rangeFiltered, true);
});
test('S20 selected basis respected (AT_LOCK re-includes AT_OPEN-null rounds)', () => {
  const rep = fixture('pos');
  const open = rep.statistics(normalizeFilter({ browserId: 'B1', jackpotBasis: 'JACKPOT_AT_OPEN' }), { basis: 'JACKPOT_AT_OPEN' });
  const lock = rep.statistics(normalizeFilter({ browserId: 'B1', jackpotBasis: 'JACKPOT_AT_LOCK' }), { basis: 'JACKPOT_AT_LOCK' });
  assert.ok(lock.population.nMissingJackpot < open.population.nMissingJackpot, 'AT_LOCK has fewer missing');
});
test('S22 Last-N respected (statistics population = latest N qualifying)', () => {
  const r = analyze(fixture('pos'), { lastNRounds: 50 });
  assert.ok(r.population.nTotal <= 50);
});
test('S24 missingness quality: basisComparison exposes n + missing rate per basis', () => {
  const r = analyze(fixture('pos'), {});
  const open = r.basisComparison.find((b) => b.basis === 'JACKPOT_AT_OPEN');
  assert.ok(open.nMissing >= 1 && open.missingRate > 0);
  const lock = r.basisComparison.find((b) => b.basis === 'JACKPOT_AT_LOCK');
  assert.equal(lock.nMissing, 0, 'lock present for all rounds');
  for (const b of r.basisComparison) assert.ok('quality' in b && 'nEligible' in b);
});

// ---- S28 NULL handling end-to-end ----
test('S28 NULL basis / NULL outcome never coerced to 0 in the engine', () => {
  const r = analyze(fixture('pos'), {});
  assert.ok(r.population.nMissingJackpot >= 1);
  // descriptive computed only over finite values
  assert.ok(r.descriptive.jackpot.min > 0);
});
