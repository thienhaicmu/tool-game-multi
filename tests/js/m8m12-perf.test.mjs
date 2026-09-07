import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsQueryEngine, normalizeFilter } = require('../../desktop/analytics/query/analytics-query-engine.cjs');
const { THRESHOLDS, thresholdKey } = require('../../desktop/analytics/thresholds.cjs');

test('100k rounds: analytics section latency benchmark + query plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-stats-'));
  const file = path.join(dir, 'a.db');
  const store = new AnalyticsStore({ file });
  const engine = new AnalyticsQueryEngine({ store });
  const N = 100000;
  const sid = store.sessions.start({ browserId: 'B-1', startedAtMs: 0 });
  const t0 = performance.now();
  const tx = store.db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const maxOdd = 1 + ((i * 37) % 2000) / 100; // 1.00 .. ~20.99 deterministic
      const openedAtMs = i * 30000;
      const id = store.rounds.insertRound({ captureSessionId: sid, browserId: 'B-1', sid: i, sequenceNumber: i + 1, openedAtMs, completeness: 'COMPLETE' });
      store.rounds.updateRound(id, { sid: i, openedAtMs, firstOddAtMs: openedAtMs, endedAtMs: openedAtMs + 5000, durationMs: 5000, firstOdd: 1, lastOdd: maxOdd, maxOdd, jackpotAtOpen: 100 + (i % 20) * 100, oddSampleCount: 1, jackpotSampleCount: 0, completeness: 'COMPLETE' });
      const reached = {}, timings = {};
      for (const t of THRESHOLDS) { const k = thresholdKey(t); reached[k] = maxOdd >= t; timings[k] = maxOdd >= t ? 1500 : null; }
      store.rounds.upsertMetrics(id, { reached, timings, censored: false });
    }
  });
  tx();
  const seedMs = performance.now() - t0;
  assert.equal(store.rounds.count(), N);

  const F = normalizeFilter({ browserId: 'B-1' });
  const time = (label, fn) => { const s = performance.now(); const r = fn(); const ms = performance.now() - s; return { label, ms, r }; };
  const results = [
    time('OVERVIEW', () => engine.overview(F)),
    time('THRESHOLDS', () => engine.thresholds(F)),
    time('DISTRIBUTION', () => engine.distribution(F)),
    time('JACKPOT_FILTER', () => engine.overview(normalizeFilter({ browserId: 'B-1', jackpotBasis: 'JACKPOT_AT_OPEN', jackpotMin: 300, jackpotMax: 500 }))),
    time('HOURLY', () => engine.hourly(F)),
    time('TIMING', () => engine.timing(F)),
    time('STREAK', () => engine.streaks(F)),
    time('GAP', () => engine.gaps(F)),
    time('ROLLING_100', () => engine.rolling(F, 2, 100)),
  ];
  console.log(`[stats-perf 100k] seed=${seedMs.toFixed(0)}ms ` + results.map((x) => `${x.label}=${x.ms.toFixed(1)}ms`).join(' '));

  // Query plan for the representative load query (browser + completeness, ORDER BY sequence DESC).
  const plan = store.db.prepare(
    "EXPLAIN QUERY PLAN SELECT r.id FROM rounds r LEFT JOIN round_metrics m ON m.round_id=r.id WHERE r.browser_id=? AND r.completeness IN ('COMPLETE') ORDER BY r.sequence_number DESC LIMIT 1000"
  ).all('B-1');
  console.log('[stats-perf plan] ' + plan.map((p) => p.detail).join(' | '));
  assert.ok(plan.some((p) => /idx_rounds_browser_seq|USING INDEX/i.test(p.detail)), 'browser+sequence index should be used');

  // Correctness sanity + generous latency ceilings (not hard SLAs).
  assert.equal(results[0].r.summary.matchedRounds, N);
  for (const x of results) assert.ok(x.ms < 2000, `${x.label} unexpectedly slow: ${x.ms}ms`);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
