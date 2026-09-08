'use strict';

const S = require('./statistics.cjs');
const { wilson, sampleQuality } = require('./confidence.cjs');
const { buildWhere, basisColumn, JACKPOT_BASIS_COLUMN } = require('./analytics-filter.cjs');
const { thresholdKey, columnsFor } = require('../thresholds.cjs');
const { spearman, kendallTauB } = require('../statistics/rank-correlation.cjs');
const { chiSquareContingency } = require('../statistics/contingency.cjs');
const { kruskalWallis } = require('../statistics/distribution-tests.cjs');
const { benjaminiHochberg } = require('../statistics/multiple-testing.cjs');
const { interpretCorrelation, interpretCramersV } = require('../statistics/effect-size.cjs');
const { STATUS } = require('../statistics/guards.cjs');

// ---------------------------------------------------------------------------
// JackpotReport — JACKPOT-FIRST comparison layer over the normalized round data.
// Every perspective (overview / last-N / ODD / time / timing / streak / gap) is
// returned with an ALL baseline AND a per-Jackpot-range breakdown that always
// exposes the sample size N and the exposure baseline (how many rounds fall in
// each Jackpot range), so the user can distinguish EXPOSURE from EVENT COUNT from
// OBSERVED RATE. Descriptive only — no prediction. Reuses the accepted stats.
//
// Jackpot ranges are half-open [min, max); final range max=null is open-ended, so
// buckets never overlap. Missing (NULL) basis values are excluded and counted.
// ---------------------------------------------------------------------------

const CMP_THRESHOLDS = [1.50, 2, 3, 5, 10, 20, 50, 100, 500, 1000];
const TIMING_THRESHOLDS = [1.20, 1.50, 2, 3, 5, 10, 20, 50];
const STREAK_THRESHOLDS = [1.20, 1.50, 2, 3, 5];
const GAP_THRESHOLDS = [10, 20, 50, 100, 500, 1000];
const LASTN_WINDOWS = [20, 50, 100, 200, 500, 1000];
const SAFETY_ROW_CAP = 500000;

const DIST_BUCKETS = [
  { label: '<1.20', min: 0, max: 1.20 }, { label: '1.20–1.49', min: 1.20, max: 1.50 },
  { label: '1.50–1.99', min: 1.50, max: 2.00 }, { label: '2.00–2.99', min: 2.00, max: 3.00 },
  { label: '3.00–4.99', min: 3.00, max: 5.00 }, { label: '5.00–9.99', min: 5.00, max: 10.00 },
  { label: '10.00–19.99', min: 10.00, max: 20.00 }, { label: '20.00–49.99', min: 20.00, max: 50.00 },
  { label: '50.00–99.99', min: 50.00, max: 100.00 }, { label: '100.00–499.99', min: 100.00, max: 500.00 },
  { label: '500.00–999.99', min: 500.00, max: 1000.00 }, { label: '>=1000', min: 1000.00, max: null },
];
const DEFAULT_JP_RANGES = [
  { label: '0–100', min: 0, max: 100 }, { label: '100–200', min: 100, max: 200 }, { label: '200–300', min: 200, max: 300 },
  { label: '300–500', min: 300, max: 500 }, { label: '500–750', min: 500, max: 750 }, { label: '750–1000', min: 750, max: 1000 },
  { label: '1000–2000', min: 1000, max: 2000 }, { label: '>=2000', min: 2000, max: null },
];

function normalizeJpConfig(cfg = {}) {
  const basis = (cfg.basis && JACKPOT_BASIS_COLUMN[cfg.basis]) ? cfg.basis : 'JACKPOT_AT_OPEN';
  let ranges = Array.isArray(cfg.ranges) && cfg.ranges.length ? cfg.ranges : DEFAULT_JP_RANGES;
  ranges = ranges.map((r) => ({ label: String(r.label), min: Number(r.min), max: r.max == null ? null : Number(r.max) }));
  return { basis, ranges };
}
function inRange(v, r) { return v >= r.min && (r.max == null ? true : v < r.max); }

class JackpotReport {
  constructor({ store } = {}) {
    if (!store) throw new Error('JackpotReport requires a store');
    this._store = store; this._db = store.db;
    const cols = ['r.sequence_number AS seq', 'r.max_odd', 'r.opened_at_ms', 'r.duration_ms', 'r.completeness',
      'r.jackpot_at_open', 'r.jackpot_at_lock', 'r.jackpot_at_first_odd', 'r.jackpot_at_end', 'r.jackpot_min', 'r.jackpot_max', 'r.jackpot_avg', 'r.jackpot_delta',
      'm.timing_censored'];
    for (const t of TIMING_THRESHOLDS) cols.push(`m.${columnsFor(t).time} AS t_${thresholdKey(t)}`);
    this._cols = cols.join(', ');
    this._basisField = JACKPOT_BASIS_COLUMN;
  }

  _load(spec) {
    const { clause, params } = buildWhere(spec, { includeAnalytic: true });
    const limit = spec.lastNRounds != null ? spec.lastNRounds : SAFETY_ROW_CAP;
    const rows = this._db.prepare(`SELECT ${this._cols} FROM rounds r LEFT JOIN round_metrics m ON m.round_id = r.id ${clause} ORDER BY r.sequence_number DESC LIMIT ?`).all(...params, limit);
    rows.reverse();
    return rows;
  }
  _basisVal(row, basis) { return row[this._basisField[basis]]; }
  _eligible(rows) { return rows.filter((r) => Number.isFinite(r.max_odd)); }

  _statBlock(rows) {
    const maxOdds = rows.map((r) => r.max_odd).filter(Number.isFinite);
    const durations = rows.filter((r) => r.completeness === 'COMPLETE' && Number.isFinite(r.duration_ms)).map((r) => r.duration_ms);
    const d = S.describe(maxOdds);
    const thresholds = CMP_THRESHOLDS.map((t) => {
      const c = S.thresholdCounts(maxOdds, [t])[0]; const ci = wilson(c.reachedCount, c.sampleCount);
      return { threshold: t, reachedCount: c.reachedCount, sampleCount: c.sampleCount, observedRate: ci.rate, ci95Low: ci.low, ci95High: ci.high, sampleQuality: sampleQuality(c.sampleCount) };
    });
    return { n: maxOdds.length, medianMaxOdd: d.median, meanMaxOdd: d.mean, p90: d.p90, p95: d.p95, p99: d.p99, avgDurationMs: S.mean(durations), medianDurationMs: S.median(durations), thresholds };
  }

  _bucketRows(rows, jp) {
    const buckets = jp.ranges.map((r) => ({ range: r, rows: [] }));
    let missing = 0;
    for (const row of rows) {
      const v = this._basisVal(row, jp.basis);
      if (!Number.isFinite(v)) { missing++; continue; }
      const b = buckets.find((x) => inRange(v, x.range));
      if (b) b.rows.push(row);
    }
    return { buckets, missing };
  }

  _summary(spec, rows, jp, missing) {
    const opened = rows.map((r) => r.opened_at_ms).filter(Number.isFinite);
    return { matchedRounds: this._eligible(rows).length, totalRows: rows.length, jackpotBasis: jp.basis, missingJackpotBasis: missing,
      firstRoundAt: opened.length ? Math.min(...opened) : null, lastRoundAt: opened.length ? Math.max(...opened) : null };
  }

  // ---- OVERVIEW × JACKPOT (with exposure baseline) ----
  overview(spec, jpConfig) {
    const jp = normalizeJpConfig(jpConfig);
    const rows = this._eligible(this._load(spec));
    const { buckets, missing } = this._bucketRows(rows, jp);
    const total = rows.length;
    return {
      summary: this._summary(spec, rows, jp, missing),
      jackpotBasis: jp.basis, ranges: jp.ranges,
      all: this._statBlock(rows),
      byRange: buckets.map((b) => ({ label: b.range.label, min: b.range.min, max: b.range.max, exposureN: b.rows.length, exposureShare: total ? b.rows.length / total : null, ...this._statBlock(b.rows) })),
    };
  }

  // ---- LAST-N × JACKPOT ----
  lastNByJackpot(spec, jpConfig, windows = LASTN_WINDOWS) {
    const jp = normalizeJpConfig(jpConfig);
    const all = this._eligible(this._load(spec)); // ascending
    const out = windows.map((n) => {
      const slice = all.slice(-n);
      const { buckets } = this._bucketRows(slice, jp);
      return { window: n, available: slice.length, byRange: buckets.map((b) => {
        const mo = b.rows.map((r) => r.max_odd);
        return { label: b.range.label, n: b.rows.length, rate2: rate(mo, 2), rate5: rate(mo, 5), rate10: rate(mo, 10), median: S.median(mo), p90: S.quantile(mo, 0.90) };
      }) };
    });
    return { summary: this._summary(spec, all, jp, 0), jackpotBasis: jp.basis, ranges: jp.ranges, windows: out };
  }

  // ---- ODD × JACKPOT matrix (+ exposure) ----
  oddMatrix(spec, jpConfig) {
    const jp = normalizeJpConfig(jpConfig);
    const rows = this._eligible(this._load(spec));
    const { buckets, missing } = this._bucketRows(rows, jp);
    const matrix = DIST_BUCKETS.map((ob) => ({
      label: ob.label, min: ob.min, max: ob.max,
      cells: buckets.map((jb) => { const c = jb.rows.filter((r) => r.max_odd >= ob.min && (ob.max == null ? true : r.max_odd < ob.max)).length; return { count: c, observedRate: jb.rows.length ? c / jb.rows.length : null }; }),
    }));
    return {
      summary: this._summary(spec, rows, jp, missing), jackpotBasis: jp.basis,
      jackpotRanges: buckets.map((b) => ({ label: b.range.label, exposureN: b.rows.length })), // exposure baseline (column totals)
      oddBuckets: matrix,
    };
  }

  // ---- TIME (hour-of-day) × JACKPOT ----
  timeByHour(spec, jpConfig) {
    const jp = normalizeJpConfig(jpConfig);
    const rows = this._eligible(this._load(spec)).filter((r) => Number.isFinite(r.opened_at_ms));
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, byRange: jp.ranges.map((r) => ({ label: r.label, rows: [] })) }));
    for (const row of rows) {
      const v = this._basisVal(row, jp.basis); if (!Number.isFinite(v)) continue;
      const ri = jp.ranges.findIndex((r) => inRange(v, r)); if (ri < 0) continue;
      hours[new Date(row.opened_at_ms).getHours()].byRange[ri].rows.push(row);
    }
    const buckets = hours.map((h) => ({ hour: h.hour, byRange: h.byRange.map((b) => { const mo = b.rows.map((r) => r.max_odd); return { label: b.label, n: b.rows.length, median: S.median(mo), rate2: rate(mo, 2), rate5: rate(mo, 5), rate10: rate(mo, 10), rate100: rate(mo, 100) }; }) }));
    return { summary: this._summary(spec, rows, jp, 0), jackpotBasis: jp.basis, ranges: jp.ranges, hours: buckets };
  }

  // ---- TIMING (time-to-threshold) × JACKPOT ----
  timing(spec, jpConfig, stat = 'median') {
    const jp = normalizeJpConfig(jpConfig);
    const rows = this._eligible(this._load(spec));
    const { buckets, missing } = this._bucketRows(rows, jp);
    const q = stat === 'p75' ? 0.75 : stat === 'p90' ? 0.90 : 0.50;
    const thresholds = TIMING_THRESHOLDS.map((t) => {
      const k = thresholdKey(t);
      const cell = (rws) => { const reached = rws.filter((r) => r.max_odd >= t); const times = reached.filter((r) => !r.timing_censored && Number.isFinite(r[`t_${k}`])).map((r) => r[`t_${k}`]); return { reachedN: reached.length, timingN: times.length, statMs: S.quantile(times, q) }; };
      return { threshold: t, all: cell(rows), byRange: buckets.map((b) => ({ label: b.range.label, ...cell(b.rows) })) };
    });
    return { summary: this._summary(spec, rows, jp, missing), jackpotBasis: jp.basis, stat, ranges: jp.ranges, thresholds };
  }

  // ---- STREAK × JACKPOT (context explicitly labelled) ----
  streak(spec, jpConfig) {
    if (spec.browserId == null) return { disabled: true, reason: 'SEQUENCE_REQUIRES_SINGLE_BROWSER' };
    const jp = normalizeJpConfig(jpConfig);
    const rows = this._eligible(this._load(spec)); // ascending sequence
    const seq = rows.map((r) => r.max_odd);
    const overall = STREAK_THRESHOLDS.map((t) => S.streaks(seq, t));
    // JP context for <2x streaks: distribution of JP for rounds INSIDE streaks, and at streak START / END.
    const T = 2; const inside = [], starts = [], ends = [];
    let run = [];
    const flush = () => { if (run.length) { starts.push(run[0]); ends.push(run[run.length - 1]); for (const r of run) inside.push(r); } run = []; };
    for (const r of rows) { if (r.max_odd < T) run.push(r); else flush(); }
    flush();
    const distOf = (rws) => { const { buckets } = this._bucketRows(rws, jp); return buckets.map((b) => ({ label: b.range.label, n: b.rows.length })); };
    return {
      summary: this._summary(spec, rows, jp, 0), jackpotBasis: jp.basis, ranges: jp.ranges, overall,
      context: { threshold: T, insideStreaks: distOf(inside), atStart: distOf(starts), atEnd: distOf(ends) },
    };
  }

  // ---- GAP × JACKPOT (exposure baseline mandatory) ----
  gap(spec, jpConfig) {
    if (spec.browserId == null) return { disabled: true, reason: 'SEQUENCE_REQUIRES_SINGLE_BROWSER' };
    const jp = normalizeJpConfig(jpConfig);
    const rows = this._eligible(this._load(spec));
    const seq = rows.map((r) => r.max_odd);
    const overall = GAP_THRESHOLDS.map((t) => S.gaps(seq, t));
    const { buckets, missing } = this._bucketRows(rows, jp);
    const exposure = GAP_THRESHOLDS.map((t) => ({ threshold: t, byRange: buckets.map((b) => { const occ = b.rows.filter((r) => r.max_odd >= t).length; return { label: b.range.label, eligibleN: b.rows.length, occurrences: occ, observedRate: b.rows.length ? occ / b.rows.length : null }; }) }));
    return { summary: this._summary(spec, rows, jp, missing), jackpotBasis: jp.basis, ranges: jp.ranges, overall, exposure };
  }

  // ---- JACKPOT DELTA × ODD (within-round change) ----
  delta(spec, jpConfig) {
    const rows = this._eligible(this._load(spec));
    const groups = [
      { label: 'Large decrease', test: (d) => d <= -50 }, { label: 'Decrease', test: (d) => d < 0 && d > -50 },
      { label: 'Stable (0)', test: (d) => d === 0 }, { label: 'Increase', test: (d) => d > 0 && d < 50 }, { label: 'Large increase', test: (d) => d >= 50 },
    ];
    const withDelta = rows.filter((r) => Number.isFinite(r.jackpot_delta));
    const byGroup = groups.map((g) => { const rws = withDelta.filter((r) => g.test(r.jackpot_delta)); const mo = rws.map((r) => r.max_odd); return { label: g.label, n: rws.length, median: S.median(mo), rate2: rate(mo, 2), rate5: rate(mo, 5), rate10: rate(mo, 10) }; });
    return { summary: { matchedRounds: rows.length, withDelta: withDelta.length, missingDelta: rows.length - withDelta.length }, thresholdsNote: 'delta groups are documented, configurable buckets', byGroup };
  }
}

function rate(maxOdds, t) { const vals = maxOdds.filter(Number.isFinite); if (!vals.length) return null; let r = 0; for (const v of vals) if (v >= t) r++; return r / vals.length; }

// Coarse ODD buckets for the contingency test (kept small so expected-cell-count
// assumptions can actually be met — the 12-bucket distribution is too sparse for χ²).
const STAT_ODD_BUCKETS = [
  { label: '<2×', min: 0, max: 2 }, { label: '2–5×', min: 2, max: 5 },
  { label: '5–10×', min: 5, max: 10 }, { label: '≥10×', min: 10, max: null },
];
const STAT_THRESHOLDS = [2, 5, 10, 20, 50, 100];
const ALL_BASES = Object.keys(JACKPOT_BASIS_COLUMN);
const oddIndex = (v) => STAT_ODD_BUCKETS.findIndex((b) => v >= b.min && (b.max == null ? true : v < b.max));

// ---------------------------------------------------------------------------
// StatEngine V1 — RETROSPECTIVE Jackpot↔outcome relationship analysis. Operates on
// the SAME qualified population every report uses (this._load(spec): time/hour/browser
// /basis/Jackpot-Range/Last-N). It NEVER re-filters, predicts, or emits betting signal.
// ---------------------------------------------------------------------------
JackpotReport.prototype.statistics = function statistics(spec, jpConfig) {
  const jp = normalizeJpConfig(jpConfig);
  const basis = jp.basis;
  const loaded = this._load(spec);                                  // identical population to every report view
  const eligible = loaded.filter((r) => Number.isFinite(r.max_odd));
  const withBasis = eligible.filter((r) => Number.isFinite(this._basisVal(r, basis)));
  const jpVals = withBasis.map((r) => this._basisVal(r, basis));
  const moVals = withBasis.map((r) => r.max_odd);
  const rangeFiltered = spec.jackpotRangeMin != null || spec.jackpotRangeMax != null;

  const population = {
    nTotal: loaded.length, nEligible: eligible.length,
    nMissingJackpot: eligible.length - withBasis.length, nMissingOutcome: loaded.length - eligible.length,
    basis, rangeFiltered, quality: sampleQuality(withBasis.length),
  };
  const dJp = S.describe(jpVals), dMo = S.describe(moVals);
  const descriptive = {
    jackpot: { n: dJp.count, min: dJp.min, max: dJp.max, mean: dJp.mean, median: dJp.median, p25: dJp.p25, p75: dJp.p75, p90: dJp.p90, p95: dJp.p95 },
    maxOdd: { n: dMo.count, min: dMo.min, max: dMo.max, mean: dMo.mean, median: dMo.median, p25: dMo.p25, p75: dMo.p75, p90: dMo.p90, p95: dMo.p95, p99: dMo.p99 },
  };

  const sp = spearman(jpVals, moVals); sp.effect = interpretCorrelation(sp.rho);
  const kd = kendallTauB(jpVals, moVals); kd.effect = interpretCorrelation(kd.tau);
  const correlation = { spearman: sp, kendall: kd };

  // Contingency + Kruskal–Wallis need MULTIPLE Jackpot ranges; a global single-range
  // selection makes them meaningless — declared explicitly, never silently ignored (§28).
  let contingency, distribution;
  if (rangeFiltered) {
    contingency = { status: STATUS.NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE };
    distribution = { kruskal: { status: STATUS.NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE, H: null, df: null, pValue: null, groupCount: null, n: withBasis.length } };
  } else {
    const R = jp.ranges.length, C = STAT_ODD_BUCKETS.length;
    const observed = Array.from({ length: R }, () => new Array(C).fill(0));
    const groups = Array.from({ length: R }, () => []);
    for (let i = 0; i < withBasis.length; i++) {
      const ri = jp.ranges.findIndex((r) => inRange(jpVals[i], r)); if (ri < 0) continue;
      const ci = oddIndex(moVals[i]); if (ci < 0) continue;
      observed[ri][ci]++; groups[ri].push(moVals[i]);
    }
    const ct = chiSquareContingency(observed, { rowLabels: jp.ranges.map((r) => r.label), colLabels: STAT_ODD_BUCKETS.map((b) => b.label) });
    ct.effect = ct.status === STATUS.OK ? interpretCramersV(ct.cramersV, Math.min(ct.rows, ct.cols)) : 'NONE';
    contingency = ct;
    distribution = { kruskal: kruskalWallis(groups) };
  }

  // Per-threshold observed rate (Wilson CI, reused) per Jackpot range, plus a
  // range×{reached,not} χ² per threshold; BH-corrected across thresholds (§15/§16).
  const thEntries = STAT_THRESHOLDS.map((t) => {
    const byRange = jp.ranges.map((r) => {
      const inb = []; for (let i = 0; i < withBasis.length; i++) if (inRange(jpVals[i], r)) inb.push(moVals[i]);
      const succ = inb.filter((v) => v >= t).length; const w = wilson(succ, inb.length);
      return { label: r.label, successes: succ, n: inb.length, observedRate: w.rate, ci95Low: w.low, ci95High: w.high, quality: sampleQuality(inb.length) };
    });
    let cont = { status: rangeFiltered ? STATUS.NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE : STATUS.INSUFFICIENT_SAMPLE, chiSquare: null, df: null, pValue: null };
    if (!rangeFiltered) {
      const obs = byRange.filter((b) => b.n > 0).map((b) => [b.successes, b.n - b.successes]);
      if (obs.length >= 2) cont = chiSquareContingency(obs);
    }
    return { threshold: t, byRange, contingency: { status: cont.status, chiSquare: cont.chiSquare, df: cont.df, pValue: cont.pValue }, _p: cont.pValue };
  });
  const bh = benjaminiHochberg(thEntries.map((e, i) => ({ key: i, p: e._p })));
  const thresholds = thEntries.map((e, i) => ({ threshold: e.threshold, byRange: e.byRange, contingency: e.contingency,
    rawP: bh[i].rawP, adjustedP: bh[i].adjustedP, significantRaw: bh[i].significantRaw, significantAdjusted: bh[i].significantAdjusted }));

  const stability = this._stability(withBasis, jpVals, moVals);
  const basisComparison = this._basisComparison(eligible);

  return { mode: 'RETROSPECTIVE', population, descriptive, correlation, contingency, distribution, thresholds, stability, basisComparison, quality: population.quality,
    oddBuckets: STAT_ODD_BUCKETS.map((b) => b.label), ranges: jp.ranges.map((r) => r.label) };
};

// Chronological thirds (population is ascending sequence). Transparent per-slice values;
// a single conservative verdict. Criteria are documented in JACKPOT_STATISTICAL_INTELLIGENCE.md.
JackpotReport.prototype._stability = function _stability(rows, jpVals, moVals) {
  const n = rows.length;
  if (n < 3 * 5) return { method: 'CHRONOLOGICAL_THIRDS', slices: [], directionConsistent: null, magnitudeSpread: null, status: 'INSUFFICIENT_DATA' };
  const third = Math.floor(n / 3);
  const bounds = [[0, third], [third, 2 * third], [2 * third, n]];
  const slices = bounds.map(([a, b], i) => {
    const jx = jpVals.slice(a, b), mx = moVals.slice(a, b);
    const sp = spearman(jx, mx);
    return { label: 'S' + (i + 1), n: b - a, spearmanRho: sp.rho, spearmanStatus: sp.status,
      rate2: rate(mx, 2), rate5: rate(mx, 5), rate10: rate(mx, 10) };
  });
  const okRhos = slices.filter((s) => s.spearmanStatus === STATUS.OK && Number.isFinite(s.spearmanRho)).map((s) => s.spearmanRho);
  if (okRhos.length < 3) return { method: 'CHRONOLOGICAL_THIRDS', slices, directionConsistent: null, magnitudeSpread: null, status: 'INSUFFICIENT_DATA' };
  const spread = Math.max(...okRhos) - Math.min(...okRhos);
  const signs = okRhos.map((r) => (Math.abs(r) < 0.05 ? 0 : Math.sign(r)));
  const nonZero = signs.filter((s) => s !== 0);
  const hasPos = nonZero.some((s) => s > 0), hasNeg = nonZero.some((s) => s < 0);
  const directionConsistent = !(hasPos && hasNeg);
  let status;
  if (hasPos && hasNeg) status = 'UNSTABLE';                        // sign flip across slices
  else if (directionConsistent && spread < 0.15) status = 'STABLE';
  else status = 'MIXED';
  return { method: 'CHRONOLOGICAL_THIRDS', slices, directionConsistent, magnitudeSpread: spread, status };
};

// Historical association per Jackpot basis (descriptive comparison; NOT a "best basis" ranking).
JackpotReport.prototype._basisComparison = function _basisComparison(eligible) {
  const total = eligible.length;
  return ALL_BASES.map((b) => {
    const jv = [], mv = [];
    for (const r of eligible) { const v = this._basisVal(r, b); if (Number.isFinite(v)) { jv.push(v); mv.push(r.max_odd); } }
    const sp = spearman(jv, mv); const kd = kendallTauB(jv, mv);
    return { basis: b, nEligible: jv.length, nMissing: total - jv.length, missingRate: total ? (total - jv.length) / total : null,
      spearman: { rho: sp.rho, pValue: sp.pValue, status: sp.status, effect: interpretCorrelation(sp.rho) },
      kendall: { tau: kd.tau, pValue: kd.pValue, status: kd.status },
      quality: sampleQuality(jv.length) };
  });
};

module.exports = { JackpotReport, normalizeJpConfig, DEFAULT_JP_RANGES, DIST_BUCKETS, CMP_THRESHOLDS, STAT_ODD_BUCKETS, STAT_THRESHOLDS };
