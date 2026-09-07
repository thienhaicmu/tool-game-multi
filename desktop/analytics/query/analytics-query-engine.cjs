'use strict';

const S = require('./statistics.cjs');
const { wilson, sampleQuality } = require('./confidence.cjs');
const { normalizeFilter, buildWhere, basisColumn } = require('./analytics-filter.cjs');
const { THRESHOLDS, thresholdKey, columnsFor } = require('../thresholds.cjs');

// ---------------------------------------------------------------------------
// AnalyticsQueryEngine — read-only descriptive statistics over persisted rounds.
// It loads the eligible round set ONCE per call (bounded columns, bounded by
// Last-N) and computes each section deterministically. SQL does filtering +
// Last-N ordering; JS does quantiles/streaks/gaps/rolling/Wilson so every screen
// agrees. NOTHING here predicts, recommends or acts.
// ---------------------------------------------------------------------------

const THRESHOLDS_RATE = THRESHOLDS;                       // 1.20 … 1000
const STREAK_THRESHOLDS = [1.20, 1.50, 2, 3, 5];
const GAP_THRESHOLDS = [10, 20, 50, 100, 500, 1000];
const TIMING_THRESHOLDS = [1.20, 1.50, 2, 3, 5, 10, 20, 50];
const TIME_RATE_THRESHOLDS = [2, 3, 5, 10, 50, 100];
const JACKPOT_RATE_THRESHOLDS = [2, 3, 5, 10, 20, 50, 100, 500, 1000];
const ROLLING_WINDOWS = [10, 20, 50, 100, 200, 500, 1000];
const LAST_N_SNAPSHOT = [10, 20, 50, 100, 200, 500, 1000];
const SAFETY_ROW_CAP = 500000;

const DIST_BUCKETS = [
  { label: '<1.20', min: 0, max: 1.20 }, { label: '1.20–1.49', min: 1.20, max: 1.50 },
  { label: '1.50–1.99', min: 1.50, max: 2.00 }, { label: '2.00–2.99', min: 2.00, max: 3.00 },
  { label: '3.00–4.99', min: 3.00, max: 5.00 }, { label: '5.00–9.99', min: 5.00, max: 10.00 },
  { label: '10.00–19.99', min: 10.00, max: 20.00 }, { label: '20.00–49.99', min: 20.00, max: 50.00 },
  { label: '50.00–99.99', min: 50.00, max: 100.00 }, { label: '100.00–499.99', min: 100.00, max: 500.00 },
  { label: '500.00–999.99', min: 500.00, max: 1000.00 }, { label: '>=1000', min: 1000.00, max: null },
];
const DEFAULT_JACKPOT_BUCKETS = [
  { label: '0–100', min: 0, max: 100 }, { label: '100–200', min: 100, max: 200 }, { label: '200–300', min: 200, max: 300 },
  { label: '300–500', min: 300, max: 500 }, { label: '500–750', min: 500, max: 750 }, { label: '750–1000', min: 750, max: 1000 },
  { label: '1000–2000', min: 1000, max: 2000 }, { label: '>=2000', min: 2000, max: null },
];
const TIME_BUCKET_MS = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000 };

class AnalyticsQueryEngine {
  constructor({ store } = {}) {
    if (!store) throw new Error('AnalyticsQueryEngine requires a store');
    this._store = store;
    this._db = store.db;
    // LIGHT column set — only the round columns every non-timing section needs. The
    // (wide) round_metrics join is loaded ONLY by timing(), which actually needs it.
    this._lightCols = `r.id, r.sequence_number AS seq, r.opened_at_ms, r.ended_at_ms, r.duration_ms, r.max_odd, r.completeness,
      r.jackpot_at_open, r.jackpot_at_lock, r.jackpot_at_first_odd, r.jackpot_at_end, r.jackpot_min, r.jackpot_max, r.jackpot_avg, r.jackpot_delta`;
    this._basisField = { JACKPOT_AT_OPEN: 'jackpot_at_open', JACKPOT_AT_LOCK: 'jackpot_at_lock', JACKPOT_AT_FIRST_ODD: 'jackpot_at_first_odd', JACKPOT_AT_END: 'jackpot_at_end', JACKPOT_MIN: 'jackpot_min', JACKPOT_MAX: 'jackpot_max', JACKPOT_AVG: 'jackpot_avg', JACKPOT_DELTA: 'jackpot_delta' };
  }

  // Load eligible rounds (ascending by sequence_number) — light columns, flat rows.
  _load(spec) {
    const { clause, params } = buildWhere(spec, { includeAnalytic: true });
    const limit = spec.lastNRounds != null ? spec.lastNRounds : SAFETY_ROW_CAP;
    const sql = `SELECT ${this._lightCols} FROM rounds r ${clause} ORDER BY r.sequence_number DESC LIMIT ?`;
    const raw = this._db.prepare(sql).all(...params, limit);
    raw.reverse(); // ascending sequence order for sequential analytics
    return raw;    // flat snake_case rows (accessed via helpers below)
  }

  _basisVal(row, basis) { return row[this._basisField[basis] || 'jackpot_at_open']; }

  // Timing needs the metric columns; load only what timing uses (censored + time_to_T).
  _loadTiming(spec, thresholds) {
    const cols = ['r.max_odd', 'r.completeness', 'r.opened_at_ms', 'm.timing_censored'];
    for (const t of thresholds) cols.push(`m.${columnsFor(t).time} AS t_${thresholdKey(t)}`);
    const { clause, params } = buildWhere(spec, { includeAnalytic: true });
    const limit = spec.lastNRounds != null ? spec.lastNRounds : SAFETY_ROW_CAP;
    const sql = `SELECT ${cols.join(', ')} FROM rounds r LEFT JOIN round_metrics m ON m.round_id = r.id ${clause} ORDER BY r.sequence_number DESC LIMIT ?`;
    return this._db.prepare(sql).all(...params, limit);
  }

  _maxOdds(rows) { return rows.map((r) => r.max_odd).filter((v) => Number.isFinite(v)); }

  // ---- summary (candidate vs matched vs missing-basis) ----
  summary(spec, rows) {
    rows = rows || this._load(spec);
    const scope = buildWhere(spec, { includeAnalytic: false });
    const candidate = this._db.prepare(`SELECT COUNT(*) AS n FROM rounds r ${scope.clause}`).get(...scope.params).n;
    const col = basisColumn(spec);
    const missingBasis = this._db.prepare(`SELECT COUNT(*) AS n FROM rounds r ${scope.clause}${scope.clause ? ' AND' : ' WHERE'} r.${col} IS NULL`).get(...scope.params).n;
    let complete = 0, partial = 0;
    for (const r of rows) { if (r.completeness === 'COMPLETE') complete++; else partial++; }
    const opened = rows.map((r) => r.opened_at_ms).filter((v) => Number.isFinite(v));
    const maxOdds = this._maxOdds(rows);
    const d = S.describe(maxOdds);
    return {
      totalCandidateRounds: candidate, matchedRounds: rows.length, completeRounds: complete, partialRounds: partial,
      missingJackpotBasis: missingBasis, jackpotBasis: spec.jackpotBasis,
      firstRoundAt: opened.length ? Math.min(...opened) : null, lastRoundAt: opened.length ? Math.max(...opened) : null,
      minMaxOdd: d.min, maxMaxOdd: d.max, medianMaxOdd: d.median, meanMaxOdd: d.mean,
      truncated: spec.lastNRounds == null && rows.length >= SAFETY_ROW_CAP,
    };
  }

  // ---- overview ----
  overview(spec) {
    const rows = this._load(spec);
    const maxOdds = this._maxOdds(rows);
    const durations = rows.filter((r) => r.completeness === 'COMPLETE' && Number.isFinite(r.duration_ms)).map((r) => r.duration_ms);
    return {
      summary: this.summary(spec, rows),
      maxOdd: S.describe(maxOdds),
      duration: S.describe(durations),
      thresholds: this._thresholdRates(maxOdds),
      lastN: this._lastNSnapshot(maxOdds),
    };
  }

  _thresholdRates(maxOdds) {
    return S.thresholdCounts(maxOdds, THRESHOLDS_RATE).map((c) => {
      const ci = wilson(c.reachedCount, c.sampleCount);
      return { threshold: c.threshold, reachedCount: c.reachedCount, notReachedCount: c.notReachedCount, sampleCount: c.sampleCount,
        observedRate: ci.rate, ci95Low: ci.low, ci95High: ci.high, sampleQuality: sampleQuality(c.sampleCount) };
    });
  }
  thresholds(spec) { const rows = this._load(spec); return { summary: this.summary(spec, rows), thresholds: this._thresholdRates(this._maxOdds(rows)) }; }

  // ---- distribution (mutually exclusive buckets) ----
  distribution(spec) {
    const rows = this._load(spec);
    const maxOdds = this._maxOdds(rows);
    const dist = S.distribution(maxOdds, DIST_BUCKETS);
    const sum = dist.buckets.reduce((a, b) => a + b.count, 0);
    return { summary: this.summary(spec, rows), total: dist.total, buckets: dist.buckets, invariant: { bucketSum: sum, eligible: dist.total, ok: sum === dist.total } };
  }

  quantiles(spec) { const rows = this._load(spec); return { summary: this.summary(spec, rows), maxOdd: S.describe(this._maxOdds(rows)) }; }

  // ---- timing (censored partial-start excluded) ----
  timing(spec, thresholds = TIMING_THRESHOLDS) {
    const rows = this._loadTiming(spec, thresholds);
    const eligible = rows.filter((r) => Number.isFinite(r.max_odd));
    const out = thresholds.map((t) => {
      const k = thresholdKey(t);
      const reached = eligible.filter((r) => r.max_odd >= t);
      const times = reached.filter((r) => !r.timing_censored && Number.isFinite(r[`t_${k}`])).map((r) => r[`t_${k}`]);
      const ci = wilson(reached.length, eligible.length);
      return {
        threshold: t, eligibleRoundCount: eligible.length, reachedCount: reached.length,
        reachObservedRate: ci.rate, reachCi95Low: ci.low, reachCi95High: ci.high,
        timingSampleCount: times.length, timing: S.describe(times),
      };
    });
    return { summary: this.summary(spec, rows), thresholds: out };
  }

  // ---- time buckets ----
  timeBuckets(spec, granularity = '1h') {
    const rows = this._load(spec).filter((r) => Number.isFinite(r.opened_at_ms));
    const map = new Map();
    for (const r of rows) {
      const key = this._bucketKey(r.opened_at_ms, granularity);
      if (!map.has(key.key)) map.set(key.key, { key: key.key, label: key.label, rows: [] });
      map.get(key.key).rows.push(r);
    }
    const buckets = [...map.values()].sort((a, b) => (a.key > b.key ? 1 : a.key < b.key ? -1 : 0)).map((b) => this._bucketStats(b.label, b.rows, TIME_RATE_THRESHOLDS, b.key));
    return { summary: this.summary(spec, rows), granularity, buckets };
  }

  // ---- hour-of-day (always 0..23) ----
  hourly(spec) {
    const rows = this._load(spec).filter((r) => Number.isFinite(r.opened_at_ms));
    const byHour = Array.from({ length: 24 }, () => []);
    for (const r of rows) byHour[new Date(r.opened_at_ms).getHours()].push(r);
    const buckets = byHour.map((rws, h) => this._bucketStats(String(h).padStart(2, '0'), rws, TIME_RATE_THRESHOLDS, h));
    return { summary: this.summary(spec, rows), buckets };
  }

  _bucketStats(label, rows, thresholds, key) {
    const maxOdds = rows.map((r) => r.max_odd).filter((v) => Number.isFinite(v));
    const durations = rows.filter((r) => Number.isFinite(r.duration_ms)).map((r) => r.duration_ms);
    const rates = {};
    for (const t of thresholds) { const c = S.thresholdCounts(maxOdds, [t])[0]; rates[t] = c.sampleCount ? c.reachedCount / c.sampleCount : null; }
    return {
      key, label, sampleCount: rows.length,
      medianMaxOdd: S.median(maxOdds), meanMaxOdd: S.mean(maxOdds),
      averageDuration: S.mean(durations), medianDuration: S.median(durations),
      rates,
    };
  }

  _bucketKey(ms, granularity) {
    if (TIME_BUCKET_MS[granularity]) { const size = TIME_BUCKET_MS[granularity]; const start = Math.floor(ms / size) * size; return { key: String(start).padStart(16, '0'), label: new Date(start).toISOString() }; }
    const d = new Date(ms);
    if (granularity === 'day') { const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return { key: k, label: k }; }
    if (granularity === 'dow') { const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const w = d.getDay(); return { key: String(w), label: names[w] }; }
    const size = TIME_BUCKET_MS['1h']; const start = Math.floor(ms / size) * size; return { key: String(start).padStart(16, '0'), label: new Date(start).toISOString() };
  }

  // ---- jackpot buckets ----
  jackpotBuckets(spec, bucketDefs = DEFAULT_JACKPOT_BUCKETS) {
    const rows = this._load(spec);
    const basis = spec.jackpotBasis;
    let missing = 0;
    const withBasis = [];
    for (const r of rows) { const v = this._basisVal(r, basis); if (Number.isFinite(v)) withBasis.push({ r, v }); else missing++; }
    const buckets = bucketDefs.map((b) => {
      const inb = withBasis.filter(({ v }) => v >= b.min && (b.max == null ? true : v < b.max)).map(({ r }) => r);
      const maxOdds = inb.map((r) => r.max_odd).filter((x) => Number.isFinite(x));
      const durations = inb.filter((r) => Number.isFinite(r.duration_ms)).map((r) => r.duration_ms);
      const rates = {};
      for (const t of JACKPOT_RATE_THRESHOLDS) { const c = S.thresholdCounts(maxOdds, [t])[0]; rates[t] = c.sampleCount ? c.reachedCount / c.sampleCount : null; }
      return { label: b.label, min: b.min, max: b.max, samples: inb.length, medianMaxOdd: S.median(maxOdds), meanMaxOdd: S.mean(maxOdds), averageDuration: S.mean(durations), medianDuration: S.median(durations), rates };
    });
    return { summary: this.summary(spec, rows), basis, missingBasisCount: missing, buckets };
  }

  // ---- rolling (sequence-scoped: single browser required) ----
  rolling(spec, threshold = 2, window = 100) {
    const guard = this._requireSingleBrowser(spec); if (guard) return guard;
    const rows = this._load(spec);
    const maxOdds = rows.map((r) => r.max_odd); // sequence order; null treated as not-reached
    return { summary: this.summary(spec, rows), threshold, window, series: S.rolling(maxOdds.map((v) => (Number.isFinite(v) ? v : -Infinity)), threshold, window) };
  }

  // ---- streaks (single browser) ----
  streaks(spec, thresholds = STREAK_THRESHOLDS) {
    const guard = this._requireSingleBrowser(spec); if (guard) return guard;
    const rows = this._load(spec);
    const seq = this._maxOdds(rows); // eligible sequence: finite maxOdd, sequence order
    return { summary: this.summary(spec, rows), thresholds: thresholds.map((t) => S.streaks(seq, t)) };
  }

  // ---- gaps (single browser) ----
  gaps(spec, thresholds = GAP_THRESHOLDS) {
    const guard = this._requireSingleBrowser(spec); if (guard) return guard;
    const rows = this._load(spec);
    const seq = this._maxOdds(rows);
    return { summary: this.summary(spec, rows), thresholds: thresholds.map((t) => S.gaps(seq, t)) };
  }

  _lastNSnapshot(maxOdds) {
    return LAST_N_SNAPSHOT.map((n) => ({ n, thresholds: [2, 3, 5, 10, 50, 100].map((t) => ({ threshold: t, ...S.lastNRate(maxOdds, t, n) })) }));
  }
  lastNSnapshot(spec) { const rows = this._load(spec); return { summary: this.summary(spec, rows), snapshots: this._lastNSnapshot(this._maxOdds(rows)) }; }

  // Sequence analytics must not interleave browsers (§19). Require an explicit browserId.
  _requireSingleBrowser(spec) {
    if (spec.browserId != null) return null;
    return { disabled: true, reason: 'SEQUENCE_REQUIRES_SINGLE_BROWSER', message: 'Select a single browser to compute streak/gap/rolling sequence analytics.' };
  }
}

module.exports = { AnalyticsQueryEngine, normalizeFilter, DIST_BUCKETS, DEFAULT_JACKPOT_BUCKETS, STREAK_THRESHOLDS, GAP_THRESHOLDS, TIMING_THRESHOLDS, ROLLING_WINDOWS };
