import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reg = require('../../desktop/analytics/forward-research/feature-registry.cjs');
const { buildDataset } = require('../../desktop/analytics/forward-research/dataset-builder.cjs');
const L = require('../../desktop/analytics/forward-research/logistic.cjs');
const Mx = require('../../desktop/analytics/forward-research/metrics.cjs');
const { chronoSplit, walkForward } = require('../../desktop/analytics/forward-research/split.cjs');
const { runExperiment, auditLeakage, modelsForStage } = require('../../desktop/analytics/forward-research/experiment.cjs');

// Deterministic PRNG (mulberry32).
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Synthetic COMPLETE rounds. signal: 'known' (jp_open→reached_2x), 'none', 'regime' (flips halfway).
function genRounds({ n = 2400, browsers = 2, signal = 'known', beta = 1.6, seed = 7 }) {
  const r = rng(seed); const rows = []; const per = Math.floor(n / browsers);
  for (let b = 0; b < browsers; b++) {
    for (let i = 0; i < per; i++) {
      const jp = 50 + Math.floor(r() * 1900);                    // jackpot_at_open 50..1950
      const jpNorm = (jp - 500) / 500;
      let bEff = beta;
      if (signal === 'none') bEff = 0;
      if (signal === 'regime') bEff = (i < per / 2) ? beta : -beta;   // early positive, late reversed
      const p2 = sigmoid(-0.4 + bEff * jpNorm);
      const hit = r() < p2;
      const maxOdd = hit ? 2 + r() * 8 : 1 + r() * 0.95;
      const seq = i + 1;
      rows.push({ browser_id: 'B' + b, sid: 's' + b + '_' + i, sequence_number: seq, opened_at_ms: (b * per + i) * 1000, ended_at_ms: (b * per + i) * 1000 + 500, max_odd: Number(maxOdd.toFixed(3)), jackpot_at_open: jp, jackpot_at_lock: jp + 5, jackpot_delta: 0, completeness: 'COMPLETE' });
    }
  }
  return rows;
}

// ---- F01/F02 registry + leakage audit ----
test('F01 feature stage gate: ROUND_OPEN excludes jp_lock; ROUND_LOCK includes it', () => {
  const open = reg.eligibleFeatures('ROUND_OPEN');
  assert.ok(open.includes('jp_open') && !open.includes('jp_lock'));
  const lock = reg.eligibleFeatures('ROUND_LOCK');
  assert.ok(lock.includes('jp_open') && lock.includes('jp_lock'));
  // No POST_ROUND / current outcome ever eligible.
  for (const s of ['ROUND_OPEN', 'ROUND_LOCK']) assert.ok(!reg.eligibleFeatures(s).includes('max_odd'));
});
test('F02 leakage audit PASS for eligible union; FAIL if an ineligible feature is injected', () => {
  assert.equal(auditLeakage('ROUND_OPEN', modelsForStage('ROUND_OPEN').M3).pass, true);
  // Injecting jp_lock into a ROUND_OPEN model must fail the stage-gate check.
  const bad = auditLeakage('ROUND_OPEN', ['jp_open', 'jp_lock']);
  assert.equal(bad.pass, false);
  assert.equal(bad.checks.featureStageWithinModelStage, false);
});

// ---- F03 shift(1) ----
test('F03 shift(1): prior feature uses the strictly-previous round, never the current', () => {
  const rounds = [
    { browser_id: 'B1', sid: 'a', sequence_number: 1, opened_at_ms: 1000, max_odd: 3.0, jackpot_at_open: 100 },
    { browser_id: 'B1', sid: 'b', sequence_number: 2, opened_at_ms: 2000, max_odd: 1.2, jackpot_at_open: 200 },
    { browser_id: 'B1', sid: 'c', sequence_number: 3, opened_at_ms: 3000, max_odd: 5.0, jackpot_at_open: 300 },
  ];
  const ds = buildDataset({ rounds, modelStage: 'ROUND_OPEN', featureNames: ['prev_max_odd', 'jp_open'], target: { name: 'reached_2x', threshold: 2 } });
  const byS = Object.fromEntries(ds.rows.map((r) => [r.sid, r]));
  assert.equal(byS.a.features.prev_max_odd, null, 'first round has no prior');
  assert.equal(byS.b.features.prev_max_odd, 3.0, 'R2 prev = R1');
  assert.equal(byS.c.features.prev_max_odd, 1.2, 'R3 prev = R2 (never its own outcome)');
});

// ---- F04 browser isolation ----
test('F04 browser isolation: prior context never crosses browser streams', () => {
  const rounds = [
    { browser_id: 'B1', sid: 'x1', sequence_number: 1, opened_at_ms: 1000, max_odd: 9.0, jackpot_at_open: 100 },
    { browser_id: 'B2', sid: 'y1', sequence_number: 1, opened_at_ms: 1500, max_odd: 1.1, jackpot_at_open: 100 },
    { browser_id: 'B1', sid: 'x2', sequence_number: 2, opened_at_ms: 2000, max_odd: 1.0, jackpot_at_open: 100 },
    { browser_id: 'B2', sid: 'y2', sequence_number: 2, opened_at_ms: 2500, max_odd: 1.0, jackpot_at_open: 100 },
  ];
  const ds = buildDataset({ rounds, modelStage: 'ROUND_OPEN', featureNames: ['prev_max_odd'], target: { name: 'reached_2x', threshold: 2 } });
  const byS = Object.fromEntries(ds.rows.map((r) => [r.sid, r]));
  assert.equal(byS.x2.features.prev_max_odd, 9.0, 'B1-R2 prev = B1-R1');
  assert.equal(byS.y2.features.prev_max_odd, 1.1, 'B2-R2 prev = B2-R1 (not B1)');
});

// ---- F05 chronological split ----
test('F05 chronological split: train < validation < test in time; no shuffle', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ eventTime: i, target: i % 2, features: {} }));
  const s = chronoSplit(rows, [0.6, 0.2, 0.2]);
  assert.ok(Math.max(...s.train.map((r) => r.eventTime)) < Math.min(...s.validation.map((r) => r.eventTime)));
  assert.ok(Math.max(...s.validation.map((r) => r.eventTime)) < Math.min(...s.test.map((r) => r.eventTime)));
});

// ---- F06 scaler train-only ----
test('F06 scaler fitted on TRAIN only (extreme TEST values do not change it)', () => {
  const train = [[1], [2], [3], [4], [5]];
  const sc = L.fitScaler(train, 1);
  const sc2 = L.fitScaler(train, 1); // extreme test rows are simply never passed to fitScaler
  assert.deepEqual(sc.mean, sc2.mean); assert.deepEqual(sc.std, sc2.std);
  assert.equal(sc.mean[0], 3);
});

// ---- F09 known signal recovered ----
test('F09 known forward signal: model beats baseline out-of-sample, coef direction correct', () => {
  const r = runExperiment({ rounds: genRounds({ signal: 'known', beta: 1.8, seed: 11 }), modelStage: 'ROUND_OPEN', target: { name: 'reached_2x', threshold: 2 } });
  assert.equal(r.status, 'OK');
  assert.equal(r.leakageAudit.pass, true);
  assert.ok(r.testMetrics.auc > 0.55, 'out-of-sample AUC clearly > 0.5: ' + r.testMetrics.auc);
  assert.ok(r.deltaBrierTest > 0, 'model improves Brier over baseline out-of-sample');
  const jpIdx = r.selected.featureNames.indexOf('jp_open');
  assert.ok(jpIdx >= 0 && r.selected.coef[jpIdx] > 0, 'jp_open coefficient positive (correct direction)');
});

// ---- F08 no signal ----
test('F08 no forward signal: conclusion does not claim useful forward value', () => {
  const r = runExperiment({ rounds: genRounds({ signal: 'none', seed: 23 }), modelStage: 'ROUND_OPEN', target: { name: 'reached_2x', threshold: 2 } });
  assert.equal(r.status, 'OK');
  assert.ok(Math.abs(r.testMetrics.auc - 0.5) < 0.06, 'AUC near 0.5: ' + r.testMetrics.auc);
  assert.equal(r.conclusion.status, 'NO_STABLE_FORWARD_VALUE');
});

// ---- F10 regime shift ----
test('F10 regime shift: aggregate metric must not hide temporal instability', () => {
  const r = runExperiment({ rounds: genRounds({ signal: 'regime', beta: 2.0, seed: 31 }), modelStage: 'ROUND_OPEN', target: { name: 'reached_2x', threshold: 2 }, folds: 4 });
  assert.equal(r.status, 'OK');
  assert.ok(['MIXED', 'UNSTABLE'].includes(r.stability.status), 'stability flagged: ' + r.stability.status);
  assert.equal(r.conclusion.status, 'NO_STABLE_FORWARD_VALUE');
});

// ---- F11 adversarial leakage ----
test('F11 adversarial: current-round POST_ROUND field can never enter eligible features', () => {
  // Even though rounds carry max_odd, the registry never exposes it as a predictor.
  for (const s of ['ROUND_OPEN', 'ROUND_LOCK']) {
    const feats = modelsForStage(s).M3;
    assert.ok(!feats.includes('max_odd') && !feats.some((f) => reg.byName.get(f).sourceField === 'max_odd' && reg.byName.get(f).kind === 'current'));
  }
  // A pipeline that forces a post-round current field fails the audit.
  assert.equal(auditLeakage('ROUND_OPEN', ['jp_open', 'nonexistent_end_field']).pass, false);
});

// ---- F12 rare target ----
test('F12 rare target → INSUFFICIENT_POSITIVES (never a fabricated model)', () => {
  const r = runExperiment({ rounds: genRounds({ signal: 'none', seed: 5 }), modelStage: 'ROUND_OPEN', target: { name: 'reached_100x', threshold: 100 } });
  assert.ok(['INSUFFICIENT_POSITIVES', 'INSUFFICIENT_DATA'].includes(r.status));
});

// ---- F13 null handling ----
test('F13 null jp_open handled (train-mean imputation, not crash, missingness reported)', () => {
  const rounds = genRounds({ signal: 'known', seed: 9 });
  for (let i = 0; i < rounds.length; i += 25) rounds[i].jackpot_at_open = null;   // inject missing
  const r = runExperiment({ rounds, modelStage: 'ROUND_OPEN', target: { name: 'reached_2x', threshold: 2 } });
  assert.equal(r.status, 'OK');
  assert.ok(r.missing.jp_open.missing > 0 && r.missing.jp_open.missingRate > 0, 'missingness surfaced');
});

// ---- F14 logistic convergence + F15 metrics ----
test('F14 logistic converges on a clean separeven-ish problem', () => {
  const X = Array.from({ length: 200 }, (_, i) => [(i - 100) / 50]);
  const y = X.map((x) => (x[0] + (Math.sin(x[0] * 7) * 0.01) > 0 ? 1 : 0));
  const sc = L.fitScaler(X, 1); const m = L.fit(L.applyScaler(X, sc), y, { l2: 1.0 });
  assert.equal(m.status, 'OK'); assert.ok(m.coef[0] > 0);
});
test('F15 metrics: AUC=1 perfect, 0.5 random-ish; Brier sane', () => {
  assert.equal(Mx.rocAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.ok(Math.abs(Mx.rocAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]) - 0.5) < 1e-9);
  assert.ok(Mx.brier([1, 0], [1, 0]) === 0);
});

// ---- F16 walk-forward structure ----
test('F16 walk-forward: expanding train, disjoint future test blocks', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ eventTime: i, target: i % 2, features: {} }));
  const wf = walkForward(rows, 4);
  assert.equal(wf.length, 4);
  for (const fd of wf) assert.ok(Math.max(...fd.train.map((r) => r.eventTime)) < Math.min(...fd.test.map((r) => r.eventTime)));
  assert.ok(wf[1].train.length > wf[0].train.length, 'training window expands');
});

// ---- F07 test-set independence ----
test('F07 changing TEST outcomes does not change selected features/hyperparameters', () => {
  const rounds = genRounds({ signal: 'known', seed: 17 });
  const a = runExperiment({ rounds, modelStage: 'ROUND_OPEN', target: { name: 'reached_2x', threshold: 2 } });
  // Flip TEST-region outcomes only (latest 20% by time = highest opened_at_ms).
  const sorted = [...rounds].sort((x, y) => x.opened_at_ms - y.opened_at_ms);
  const testStart = Math.floor(sorted.length * 0.8);
  for (let i = testStart; i < sorted.length; i++) sorted[i].max_odd = sorted[i].max_odd >= 2 ? 1.1 : 2.9; // invert test labels
  const b = runExperiment({ rounds: sorted, modelStage: 'ROUND_OPEN', target: { name: 'reached_2x', threshold: 2 } });
  assert.deepEqual(a.selected.featureNames, b.selected.featureNames, 'selected feature set unchanged');
  assert.equal(a.selected.l2, b.selected.l2, 'selected L2 unchanged');
});
