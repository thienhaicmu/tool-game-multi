import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { THRESHOLDS, thresholdKey } = require('../../desktop/analytics/thresholds.cjs');

function tmp(tag) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anperf-' + tag + '-')); return { dir, file: path.join(dir, 'a.db') }; }
function metricsFor(maxOdd, firstAt) {
  const reached = {}, timings = {};
  for (const t of THRESHOLDS) { const k = thresholdKey(t); const hit = maxOdd >= t; reached[k] = hit; timings[k] = hit ? 50 : null; }
  return { reached, timings, censored: false };
}

// §25 — persistence PERFORMANCE fixtures (NOT protocol-semantics claims).
test('10,000 rounds with ODD samples: insert throughput + query latency', () => {
  const { dir, file } = tmp('10k');
  const store = new AnalyticsStore({ file });
  const N = 10000, SAMPLES = 8;
  const sessionId = store.sessions.start({ browserId: 'B-1', startedAtMs: 0 });
  const t0 = performance.now();
  const tx = store.db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const base = i * 10000;
      const id = store.rounds.insertRound({ captureSessionId: sessionId, browserId: 'B-1', sid: 1000 + i, sequenceNumber: i + 1, openedAtMs: base });
      const maxOdd = 1 + (i % 50) / 10;
      for (let s = 0; s < SAMPLES; s++) store.rounds.insertOddSample({ roundId: id, sequence: s, timestampMs: base + s * 100, elapsedFromFirstOddMs: s * 100, odd: 1 + s * 0.3, sourceEventId: null });
      store.rounds.updateRound(id, { sid: 1000 + i, openedAtMs: base, firstOddAtMs: base, endedAtMs: base + 900, durationMs: 900, firstOdd: 1, lastOdd: maxOdd, maxOdd, oddSampleCount: SAMPLES, jackpotSampleCount: 0, completeness: 'COMPLETE' });
      store.rounds.upsertMetrics(id, metricsFor(maxOdd, base));
    }
  });
  tx();
  const insertMs = performance.now() - t0;

  assert.equal(store.rounds.count(), N);
  const l0 = performance.now();
  const list = store.listRounds({ browserId: 'B-1', limit: 50, offset: 5000 });
  const listMs = performance.now() - l0;
  assert.equal(list.total, N); assert.equal(list.rounds.length, 50);

  const midId = list.rounds[0].id;
  const d0 = performance.now();
  const detail = store.getRoundDetail(midId);
  const detailMs = performance.now() - d0;
  assert.equal(detail.oddSamples.length, SAMPLES);

  const sizeBytes = fs.statSync(file).size;
  console.log(`[perf 10k] insert=${insertMs.toFixed(0)}ms (${(N / (insertMs / 1000)).toFixed(0)} rounds/s) listRounds=${listMs.toFixed(2)}ms detail=${detailMs.toFixed(2)}ms dbSize=${(sizeBytes / 1e6).toFixed(1)}MB`);
  assert.ok(listMs < 200, 'listRounds should be fast with indexes');
  assert.ok(detailMs < 200, 'getRoundDetail should be fast');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('100,000 rounds (rounds-only) query/index smoke', () => {
  const { dir, file } = tmp('100k');
  const store = new AnalyticsStore({ file });
  const N = 100000;
  const sessionId = store.sessions.start({ browserId: 'B-1', startedAtMs: 0 });
  const t0 = performance.now();
  const tx = store.db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const id = store.rounds.insertRound({ captureSessionId: sessionId, browserId: 'B-1', sid: i, sequenceNumber: i + 1, openedAtMs: i * 1000, completeness: 'COMPLETE' });
      store.rounds.updateRound(id, { sid: i, openedAtMs: i * 1000, endedAtMs: i * 1000 + 500, durationMs: 500, maxOdd: 1 + (i % 100) / 10, oddSampleCount: 0, jackpotSampleCount: 0, completeness: 'COMPLETE' });
    }
  });
  tx();
  const insertMs = performance.now() - t0;
  assert.equal(store.rounds.count(), N);
  const l0 = performance.now();
  const list = store.listRounds({ browserId: 'B-1', limit: 50, offset: 0 });
  const listMs = performance.now() - l0;
  assert.equal(list.total, N); assert.equal(list.rounds.length, 50);
  console.log(`[perf 100k] insert=${insertMs.toFixed(0)}ms (${(N / (insertMs / 1000)).toFixed(0)} rounds/s) listRounds=${listMs.toFixed(2)}ms dbSize=${(fs.statSync(file).size / 1e6).toFixed(1)}MB`);
  assert.ok(listMs < 300, 'listRounds over 100k should still be fast (indexed)');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
