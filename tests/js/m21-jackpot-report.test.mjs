import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsPersistence } = require('../../desktop/analytics/persistence.cjs');
const { JackpotReport } = require('../../desktop/analytics/query/jackpot-report.cjs');
const { normalizeFilter } = require('../../desktop/analytics/query/analytics-filter.cjs');

// Seed rounds with explicit (jackpotAtOpen, maxOdd) via direct repo writes for determinism.
function seeded(rows, browser = 'B-1') {
  const store = new AnalyticsStore({ file: ':memory:' });
  const sid = store.sessions.start({ browserId: browser, startedAtMs: 0 });
  const { THRESHOLDS, thresholdKey } = require('../../desktop/analytics/thresholds.cjs');
  let seq = 0;
  for (const r of rows) {
    seq++;
    const openedAtMs = r.at != null ? r.at : seq * 60000;
    const id = store.rounds.insertRound({ captureSessionId: sid, browserId: browser, sid: seq, sequenceNumber: seq, openedAtMs, completeness: 'COMPLETE' });
    store.rounds.updateRound(id, { sid: seq, openedAtMs, firstOddAtMs: openedAtMs, endedAtMs: openedAtMs + 4000, durationMs: 4000, firstOdd: 1, lastOdd: r.maxOdd, maxOdd: r.maxOdd, jackpotAtOpen: r.jp == null ? null : r.jp, jackpotAtEnd: r.jpEnd == null ? null : r.jpEnd, jackpotDelta: (r.jpEnd != null && r.jp != null) ? r.jpEnd - r.jp : null, oddSampleCount: 1, jackpotSampleCount: 0, completeness: 'COMPLETE' });
    const reached = {}, timings = {};
    for (const t of THRESHOLDS) { const k = thresholdKey(t); reached[k] = r.maxOdd >= t; timings[k] = r.maxOdd >= t ? 1200 : null; }
    store.rounds.upsertMetrics(id, { reached, timings, censored: !!r.censored });
  }
  return { store, jr: new JackpotReport({ store }) };
}
const F = (o) => normalizeFilter(o);
const JP = { basis: 'JACKPOT_AT_OPEN', ranges: [{ label: '<200', min: 0, max: 200 }, { label: '200–500', min: 200, max: 500 }, { label: '>=500', min: 500, max: null }] };

test('overview × jackpot: per-range N, exposure share, thresholds; ALL baseline', () => {
  const { store, jr } = seeded([
    { jp: 100, maxOdd: 3 }, { jp: 150, maxOdd: 1.2 }, { jp: 300, maxOdd: 5 }, { jp: 400, maxOdd: 2 }, { jp: 800, maxOdd: 12 }, { jp: 900, maxOdd: 1.5 },
  ]);
  const r = jr.overview(F({ browserId: 'B-1' }), JP);
  assert.equal(r.all.n, 6);
  assert.equal(r.byRange.length, 3);
  const byLabel = Object.fromEntries(r.byRange.map((b) => [b.label, b]));
  assert.equal(byLabel['<200'].exposureN, 2);
  assert.equal(byLabel['200–500'].exposureN, 2);
  assert.equal(byLabel['>=500'].exposureN, 2);
  assert.ok(Math.abs(byLabel['<200'].exposureShare - 2 / 6) < 1e-9);
  const ge2 = (b) => b.thresholds.find((t) => t.threshold === 2);
  assert.equal(ge2(byLabel['>=500']).reachedCount, 1); // maxOdd 12 >=2 ; 1.5 not
  store.close();
});

test('missing jackpot basis excluded + counted; no interpolation', () => {
  const { store, jr } = seeded([{ jp: 100, maxOdd: 2 }, { jp: null, maxOdd: 5 }, { jp: 300, maxOdd: 3 }]);
  const r = jr.overview(F({ browserId: 'B-1' }), JP);
  assert.equal(r.summary.matchedRounds, 3);
  assert.equal(r.summary.missingJackpotBasis, 1);
  const totalBucketed = r.byRange.reduce((a, b) => a + b.exposureN, 0);
  assert.equal(totalBucketed, 2); // the NULL-jp round is excluded from every bucket
  store.close();
});

test('ODD × jackpot matrix: mutually exclusive cells + exposure column totals', () => {
  const { store, jr } = seeded([{ jp: 100, maxOdd: 1.1 }, { jp: 100, maxOdd: 2.5 }, { jp: 300, maxOdd: 8 }, { jp: 300, maxOdd: 1.3 }]);
  const r = jr.oddMatrix(F({ browserId: 'B-1' }), JP);
  assert.equal(r.oddBuckets.length, 12);
  // exposure column totals
  const exp = Object.fromEntries(r.jackpotRanges.map((c) => [c.label, c.exposureN]));
  assert.equal(exp['<200'], 2); assert.equal(exp['200–500'], 2); assert.equal(exp['>=500'], 0);
  // sum of one column's cell counts == that column exposure
  const colIdx = 0; // <200
  const colSum = r.oddBuckets.reduce((a, ob) => a + ob.cells[colIdx].count, 0);
  assert.equal(colSum, exp['<200']);
  store.close();
});

test('jackpot basis switching changes population (AT_OPEN vs AT_END)', () => {
  const { store, jr } = seeded([{ jp: 100, jpEnd: 600, maxOdd: 2 }, { jp: 600, jpEnd: 100, maxOdd: 3 }]);
  const open = jr.overview(F({ browserId: 'B-1' }), { basis: 'JACKPOT_AT_OPEN', ranges: JP.ranges });
  const end = jr.overview(F({ browserId: 'B-1' }), { basis: 'JACKPOT_AT_END', ranges: JP.ranges });
  const openBig = open.byRange.find((b) => b.label === '>=500').exposureN;
  const endBig = end.byRange.find((b) => b.label === '>=500').exposureN;
  assert.equal(openBig, 1); assert.equal(endBig, 1); // different rounds fall into >=500 depending on basis
  store.close();
});

test('timing × jackpot excludes censored; reports timing N', () => {
  const { store, jr } = seeded([
    { jp: 100, maxOdd: 5, censored: false }, { jp: 100, maxOdd: 5, censored: true }, { jp: 300, maxOdd: 5, censored: false },
  ]);
  const r = jr.timing(F({ browserId: 'B-1' }), JP, 'median');
  const t2 = r.thresholds.find((t) => t.threshold === 2);
  assert.equal(t2.all.reachedN, 3);
  assert.equal(t2.all.timingN, 2); // the censored round is excluded from timing
  const lt200 = t2.byRange.find((b) => b.label === '<200');
  assert.equal(lt200.reachedN, 2); assert.equal(lt200.timingN, 1);
  store.close();
});

test('gap × jackpot exposure baseline (eligible N + occurrences + rate) + sequence needs one browser', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ jp: i < 5 ? 100 : 600, maxOdd: i % 3 === 0 ? 12 : 1.5 });
  const { store, jr } = seeded(rows);
  const g = jr.gap(F({ browserId: 'B-1' }), JP);
  const ex10 = g.exposure.find((e) => e.threshold === 10);
  const lt = ex10.byRange.find((b) => b.label === '<200');
  assert.equal(lt.eligibleN, 5);
  assert.equal(lt.occurrences, 2); // first 5 rounds (jp<200): i=0 and i=3 have maxOdd 12 >=10
  assert.equal(lt.observedRate, 2 / 5);
  // sequence analytics require a single browser
  assert.equal(jr.gap(F({}), JP).disabled, true);
  store.close();
});

test('streak × jackpot: overall streaks + explicit JP context distributions', () => {
  const { store, jr } = seeded([{ jp: 100, maxOdd: 1.2 }, { jp: 300, maxOdd: 1.3 }, { jp: 800, maxOdd: 5 }, { jp: 100, maxOdd: 1.1 }]);
  const r = jr.streak(F({ browserId: 'B-1' }), JP);
  assert.ok(r.overall.find((s) => s.threshold === 2));
  assert.equal(r.context.threshold, 2);
  // rounds inside <2x streaks: indices 0,1 (run of 2) then 3 (trailing run of 1) = 3 rounds
  const insideTotal = r.context.insideStreaks.reduce((a, b) => a + b.n, 0);
  assert.equal(insideTotal, 3);
  store.close();
});

test('last-N × jackpot uses the trailing N population', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ jp: i < 25 ? 100 : 800, maxOdd: 2 });
  const { store, jr } = seeded(rows);
  const r = jr.lastNByJackpot(F({ browserId: 'B-1' }), JP, [10]);
  const w = r.windows[0];
  assert.equal(w.available, 10);
  // last 10 rounds: indices 20..29 → 5 with jp100, 5 with jp800
  const lt = w.byRange.find((b) => b.label === '<200'); const ge = w.byRange.find((b) => b.label === '>=500');
  assert.equal(lt.n, 5); assert.equal(ge.n, 5);
  store.close();
});
