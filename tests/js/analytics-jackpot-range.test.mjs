import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeFilter, buildWhere } = require('../../desktop/analytics/query/analytics-filter.cjs');
const { JackpotReport, DEFAULT_JP_RANGES } = require('../../desktop/analytics/query/jackpot-report.cjs');
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');

// ---------------------------------------------------------------------------
// Deterministic Analytics fixture (§8) — synthetic passive rounds, no live traffic.
// Covers every JP bucket boundary, NULL bases, low/med/high maxOdd, and multiple hours.
// jackpot_at_open / jackpot_at_lock are set independently to exercise basis switching.
// ---------------------------------------------------------------------------
function makeFixture() {
  const store = new AnalyticsStore({ file: ':memory:' });
  const db = store.db;
  db.prepare(`INSERT INTO capture_sessions (id, browser_id, started_at_ms, status, created_at_ms, updated_at_ms)
              VALUES (1, 'B1', 0, 'CLOSED', 0, 0)`).run();
  const ins = db.prepare(`INSERT INTO rounds
    (capture_session_id, browser_id, sid, sequence_number, opened_at_ms, max_odd,
     jackpot_at_open, jackpot_at_lock, jackpot_delta, completeness, created_at_ms, updated_at_ms)
    VALUES (1,'B1',@sid,@seq,@opened,@maxOdd,@jpOpen,@jpLock,@jpDelta,@cmpl,0,0)`);
  const H = 3600000;
  // seq → { jpOpen, jpLock, maxOdd } (bucket by AT_OPEN in comments)
  const rounds = [
    { seq: 1, jpOpen: 100, jpLock: 100, maxOdd: 2.5, opened: 8 * H },   // [100,200)
    { seq: 2, jpOpen: 199.99, jpLock: 199, maxOdd: 1.1, opened: 9 * H },   // [100,200)
    { seq: 3, jpOpen: 200, jpLock: 200, maxOdd: 5.0, opened: 9 * H },   // [200,300)  ← boundary owner
    { seq: 4, jpOpen: 300, jpLock: 300, maxOdd: 10.0, opened: 10 * H },  // [300,500)
    { seq: 5, jpOpen: 499.99, jpLock: 499, maxOdd: 1.5, opened: 10 * H },  // [300,500)
    { seq: 6, jpOpen: 500, jpLock: 500, maxOdd: 3.0, opened: 11 * H },  // [500,750)
    { seq: 7, jpOpen: 2000, jpLock: 2000, maxOdd: 50.0, opened: 12 * H },  // [2000,∞)  ← open-ended lower bound
    { seq: 8, jpOpen: 2500, jpLock: 2500, maxOdd: 1.2, opened: 12 * H },  // [2000,∞)
    { seq: 9, jpOpen: null, jpLock: 350, maxOdd: 7.0, opened: 13 * H },  // AT_OPEN null; AT_LOCK [300,500)
    { seq: 10, jpOpen: 99.99, jpLock: 99, maxOdd: 2.0, opened: 8 * H },   // [0,100)
  ];
  for (const r of rounds) ins.run({ sid: 's' + r.seq, seq: r.seq, opened: r.opened, maxOdd: r.maxOdd, jpOpen: r.jpOpen, jpLock: r.jpLock, jpDelta: 0, cmpl: 'COMPLETE' });
  return { store, report: new JackpotReport({ store }) };
}
const spec = (raw) => normalizeFilter(raw);
const OPEN = 'JACKPOT_AT_OPEN', LOCK = 'JACKPOT_AT_LOCK';

// ---- R16 / R1–R4 / R6 : half-open [min,max) SQL predicate on the selected basis ----
test('R1/R2/R3 half-open boundaries: lower inclusive, upper exclusive, next bucket owns the edge', () => {
  const w = buildWhere(spec({ jackpotBasis: OPEN, jackpotRangeMin: 100, jackpotRangeMax: 200 }));
  assert.match(w.clause, /jackpot_at_open IS NOT NULL/);
  assert.match(w.clause, /jackpot_at_open >= \?/);        // R1 lower inclusive
  assert.match(w.clause, /jackpot_at_open < \?/);         // R2 upper EXCLUSIVE (not <=)
  assert.ok(!/jackpot_at_open <= \?/.test(w.clause), 'range upper bound must not be inclusive');
  assert.deepEqual(w.params.slice(-2), [100, 200]);
});
test('R4 open-ended final bucket: only a lower bound, no upper', () => {
  const w = buildWhere(spec({ jackpotBasis: OPEN, jackpotRangeMin: 2000 }));  // max omitted
  assert.match(w.clause, /jackpot_at_open >= \?/);
  assert.ok(!/jackpot_at_open < \?/.test(w.clause), 'open-ended bucket has no upper bound');
});
test('R6 basis switch changes the range source column', () => {
  const wOpen = buildWhere(spec({ jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }));
  const wLock = buildWhere(spec({ jackpotBasis: LOCK, jackpotRangeMin: 300, jackpotRangeMax: 500 }));
  assert.match(wOpen.clause, /jackpot_at_open >= \?/);
  assert.match(wLock.clause, /jackpot_at_lock >= \?/);
  assert.ok(!/jackpot_at_open/.test(wLock.clause), 'LOCK basis must not reference the OPEN column');
});
test('normalizeFilter rejects min>max range', () => {
  assert.throws(() => spec({ jackpotRangeMin: 500, jackpotRangeMax: 100 }), /jackpotRangeMin must be <= jackpotRangeMax/);
});

// ---- Data-populated propagation: every report perspective honors the range ----
test('R8 Overview honors the range (all + byRange restricted to [300,500) on AT_OPEN)', () => {
  const { report } = makeFixture();
  const r = report.overview(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: OPEN });
  assert.equal(r.all.n, 2, 'only seq4(300) + seq5(499.99)');
  // Only the 300–500 bucket carries exposure; all others are 0 (population is globally restricted).
  const nonzero = r.byRange.filter((b) => b.exposureN > 0);
  assert.equal(nonzero.length, 1);
  assert.equal(nonzero[0].label, '300–500');
  assert.equal(nonzero[0].exposureN, 2);
});
test('R9 Jackpot view (delta path) honors the range', () => {
  const { report } = makeFixture();
  const d = report.delta(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: OPEN });
  assert.equal(d.summary.matchedRounds, 2, 'delta computed only over in-range rounds');
});
test('R10 ODD × Jackpot matrix honors the range', () => {
  const { report } = makeFixture();
  const m = report.oddMatrix(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: OPEN });
  const exposure = m.jackpotRanges.reduce((a, b) => a + b.exposureN, 0);
  assert.equal(exposure, 2, 'column exposure totals restricted to the range');
});
test('R11 Time (hour × Jackpot) honors the range', () => {
  const { report } = makeFixture();
  const t = report.timeByHour(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: OPEN });
  let total = 0; for (const h of t.hours) for (const b of h.byRange) total += b.n;
  assert.equal(total, 2, 'only seq4+seq5 (both hour 10) survive the range');
});
test('R12 Streak/Trend honors the range', () => {
  const { report } = makeFixture();
  const s = report.streak(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: OPEN });
  assert.equal(s.summary.matchedRounds, 2);
  const g = report.gap(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: OPEN });
  assert.equal(g.summary.matchedRounds, 2);
});

// ---- R5 / R6 (data) : NULL basis excluded; basis switch re-sources the value ----
test('R5 NULL selected-basis rounds are excluded from the range (never coerced to 0)', () => {
  const { report } = makeFixture();
  // seq9 has jackpot_at_open = NULL but jackpot_at_lock = 350. Under AT_OPEN it must be excluded.
  const open = report.overview(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: OPEN });
  assert.equal(open.all.n, 2, 'seq9 excluded under AT_OPEN (basis is NULL)');
});
test('R6 basis switch (AT_LOCK) re-includes a round whose AT_OPEN was NULL', () => {
  const { report } = makeFixture();
  const lock = report.overview(spec({ browserId: 'B1', jackpotBasis: LOCK, jackpotRangeMin: 300, jackpotRangeMax: 500 }), { basis: LOCK });
  assert.equal(lock.all.n, 3, 'seq4(300)+seq5(499)+seq9(lock 350) under AT_LOCK');
});

// ---- R7 : Last-N is applied AFTER the range (latest N QUALIFYING) ----
test('R7 Last-N applies after the JP range (latest N of the qualifying population)', () => {
  const { report } = makeFixture();
  // In-range [100,200) on AT_OPEN = seq1(100) + seq2(199.99). lastN=1 → latest qualifying = seq2.
  const r = report.overview(spec({ browserId: 'B1', jackpotBasis: OPEN, jackpotRangeMin: 100, jackpotRangeMax: 200, lastNRounds: 1 }), { basis: OPEN });
  assert.equal(r.all.n, 1, 'exactly one round after Last-N');
  assert.equal(r.all.medianMaxOdd, 1.1, 'it is seq2 (the latest IN-RANGE), not the global latest seq10');
});

// ---- R14 : missing-basis accounting is surfaced, not hidden ----
test('R14 missing-basis count reflects the selected basis (no range)', () => {
  const { report } = makeFixture();
  const open = report.overview(spec({ browserId: 'B1', jackpotBasis: OPEN }), { basis: OPEN });
  assert.equal(open.summary.missingJackpotBasis, 1, 'seq9 has NULL jackpot_at_open');
  const lock = report.overview(spec({ browserId: 'B1', jackpotBasis: LOCK }), { basis: LOCK });
  assert.equal(lock.summary.missingJackpotBasis, 0, 'all rounds have jackpot_at_lock');
});

// ---- R15 : deterministic order + R16 : no overlapping bucket membership ----
test('R15 deterministic ordering: identical results across calls', () => {
  const { report } = makeFixture();
  const f = spec({ browserId: 'B1', jackpotBasis: OPEN });
  const a = report.overview(f, { basis: OPEN });
  const b = report.overview(f, { basis: OPEN });
  assert.deepEqual(a.byRange.map((x) => x.exposureN), b.byRange.map((x) => x.exposureN));
});
test('R16 no overlapping bucket membership: each non-null round counted exactly once', () => {
  const { report } = makeFixture();
  const r = report.overview(spec({ browserId: 'B1', jackpotBasis: OPEN }), { basis: OPEN });
  const sumExposure = r.byRange.reduce((a, b) => a + b.exposureN, 0);
  // 10 rounds, seq9 has NULL AT_OPEN → 9 counted across mutually exclusive half-open buckets.
  assert.equal(sumExposure, 9, 'sum of bucket exposure == eligible non-null rounds (no double counting)');
});

// ---- Drift guard: UI ranges must equal the backend authoritative buckets ----
test('backend DEFAULT_JP_RANGES are the authoritative half-open buckets (UI mirrors them)', () => {
  const bounds = DEFAULT_JP_RANGES.map((r) => [r.min, r.max]);
  assert.deepEqual(bounds, [[0, 100], [100, 200], [200, 300], [300, 500], [500, 750], [750, 1000], [1000, 2000], [2000, null]]);
  // No overlaps: each max equals the next min; final is open-ended.
  for (let i = 0; i < DEFAULT_JP_RANGES.length - 1; i++) assert.equal(DEFAULT_JP_RANGES[i].max, DEFAULT_JP_RANGES[i + 1].min);
  assert.equal(DEFAULT_JP_RANGES[DEFAULT_JP_RANGES.length - 1].max, null);
});
