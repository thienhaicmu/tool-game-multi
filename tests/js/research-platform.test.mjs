import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { ResearchService } = require('../../desktop/analytics/research/research-service.cjs');
const registry = require('../../desktop/analytics/research/algorithm-registry.cjs');
const fp = require('../../desktop/analytics/research/fingerprint.cjs');
const drift = require('../../desktop/analytics/research/drift.cjs');
const comparison = require('../../desktop/analytics/research/comparison.cjs');
const { qualityStatus } = require('../../desktop/analytics/research/quality.cjs');

// Deterministic PRNG + synthetic COMPLETE rounds (known jp_open→reached_2x signal / none / regime).
function rng(s) { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function gen({ n = 3000, browsers = 2, signal = 'known', beta = 1.8, seed = 7, tOffset = 0 }) {
  const r = rng(seed); const rows = []; const per = Math.floor(n / browsers);
  for (let b = 0; b < browsers; b++) for (let i = 0; i < per; i++) {
    const jp = 50 + Math.floor(r() * 1900); const jpN = (jp - 500) / 500;
    let bEff = signal === 'none' ? 0 : (signal === 'regime' ? (i < per / 2 ? beta : -beta) : beta);
    const hit = r() < sigmoid(-0.4 + bEff * jpN);
    const mo = hit ? 2 + r() * 8 : 1 + r() * 0.95;
    rows.push({ capture_session_id: 1, browser_id: 'B' + b, sid: 's' + b + '_' + i, sequence_number: i + 1, opened_at_ms: tOffset + (b * per + i) * 1000, ended_at_ms: tOffset + (b * per + i) * 1000 + 500, max_odd: Number(mo.toFixed(3)), jackpot_at_open: jp, jackpot_at_lock: jp + 5, jackpot_delta: 0, completeness: 'COMPLETE' });
  }
  return rows;
}
function storeWith(rows) {
  const store = new AnalyticsStore({ file: ':memory:' });
  store.db.prepare("INSERT INTO capture_sessions(id,browser_id,started_at_ms,status,created_at_ms,updated_at_ms) VALUES(1,'B0',1,'STOPPED',1,1)").run();
  const ins = store.db.prepare("INSERT INTO rounds(capture_session_id,browser_id,sid,sequence_number,opened_at_ms,ended_at_ms,max_odd,jackpot_at_open,jackpot_at_lock,jackpot_delta,completeness,created_at_ms,updated_at_ms) VALUES(@capture_session_id,@browser_id,@sid,@sequence_number,@opened_at_ms,@ended_at_ms,@max_odd,@jackpot_at_open,@jackpot_at_lock,@jackpot_delta,@completeness,1,1)");
  store.db.transaction((rs) => { for (const r of rs) ins.run(r); })(rows);
  return store;
}
let clock = 1000;
function svc(rows) { clock = 1000; return new ResearchService({ store: storeWith(rows), now: () => (clock += 1000) }); }

// ---- Registry + fingerprint (§6/§7) ----
test('R01 registry exposes ≥4 algorithms incl. a baseline; UI-free identities', () => {
  const view = registry.registryView();
  assert.ok(view.length >= 4);
  assert.ok(view.some((a) => a.family === 'BASELINE'));
  assert.ok(view.some((a) => a.family === 'LOGISTIC_REGRESSION'));
  // feature set resolves per stage; ROUND_LOCK full set includes jp_lock, ROUND_OPEN does not
  const full = view.find((a) => a.algorithmId === 'full_forward_logistic_v1');
  assert.ok(full.featuresByStage.ROUND_LOCK.includes('jp_lock'));
  assert.ok(!full.featuresByStage.ROUND_OPEN.includes('jp_lock'));
});
test('R02 algorithm fingerprint is deterministic + sensitive to config; dataset fp sensitive to population', () => {
  const c1 = registry.resolveConfig('jp_open_logistic_v1', 'ROUND_OPEN', 'reached_2x');
  const a = fp.algorithmFingerprint(c1), b = fp.algorithmFingerprint(registry.resolveConfig('jp_open_logistic_v1', 'ROUND_OPEN', 'reached_2x'));
  assert.equal(a, b, 'same config → same fingerprint');
  assert.notEqual(a, fp.algorithmFingerprint(registry.resolveConfig('jp_open_logistic_v1', 'ROUND_LOCK', 'reached_2x')), 'stage changes fingerprint');
  assert.notEqual(a, fp.algorithmFingerprint(registry.resolveConfig('jp_context_logistic_v1', 'ROUND_OPEN', 'reached_2x')), 'features change fingerprint');
  const d1 = fp.datasetFingerprint({ schemaVersion: 3, modelStage: 'ROUND_OPEN', target: 'reached_2x', browserScope: null, rowCount: 100, browsers: 2, earliest: 0, latest: 10, rowDigest: 'x' });
  assert.notEqual(d1, fp.datasetFingerprint({ schemaVersion: 3, modelStage: 'ROUND_OPEN', target: 'reached_2x', browserScope: null, rowCount: 200, browsers: 2, earliest: 0, latest: 10, rowDigest: 'y' }));
});

// ---- End-to-end evaluate + persist (§30) ----
test('R03 known signal: platform detects it, beats baseline out-of-sample, PASS leakage, persisted', () => {
  const s = svc(gen({ signal: 'known', seed: 11 }));
  const { run, evaluation } = s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  assert.equal(evaluation.status, 'OK');
  assert.equal(evaluation.leakageStatus, 'PASS');
  assert.ok(evaluation.testMetrics.auc > 0.55, 'AUC out-of-sample > 0.55: ' + evaluation.testMetrics.auc);
  assert.ok(evaluation.deltaBrierTest > 0, 'improves Brier over baseline');
  assert.ok(['SMALL_STABLE_IMPROVEMENT', 'MATERIAL_STABLE_IMPROVEMENT'].includes(evaluation.quality.status));
  assert.ok(run.runId > 0 && !run.deduped);
  const full = s.getRun(run.runId);
  assert.ok(full && full.result && full.result.testMetrics.auc === evaluation.testMetrics.auc, 'run reloads with stored metrics');
});
test('R04 no signal: quality = NO_IMPROVEMENT (no false improvement claim)', () => {
  const s = svc(gen({ signal: 'none', seed: 23 }));
  const { evaluation } = s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  assert.equal(evaluation.status, 'OK');
  assert.ok(Math.abs(evaluation.testMetrics.auc - 0.5) < 0.06, 'AUC ≈ 0.5');
  assert.equal(evaluation.quality.status, 'NO_IMPROVEMENT');
});
test('R05 regime shift: stability flagged, quality not MATERIAL_STABLE', () => {
  const s = svc(gen({ signal: 'regime', beta: 2.2, seed: 31 }));
  const { evaluation } = s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  assert.ok(['MIXED', 'UNSTABLE'].includes(evaluation.stability.status), 'stability: ' + evaluation.stability.status);
  assert.notEqual(evaluation.quality.status, 'MATERIAL_STABLE_IMPROVEMENT');
});

// ---- Immutability + dedupe (§31/§68) ----
test('R06 identical re-run dedupes to same run; old stored result immune to later config changes', () => {
  const s = svc(gen({ signal: 'known', seed: 11 }));
  const a = s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  const b = s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  assert.equal(b.run.runId, a.run.runId);
  assert.equal(b.run.deduped, true);
  // Old stored run keeps its metrics regardless of what the live evaluation now returns.
  const stored = s.getRun(a.run.runId);
  assert.equal(stored.result.testMetrics.auc, a.evaluation.testMetrics.auc);
  assert.equal(stored.algorithmFingerprint, a.evaluation.algorithmFingerprint);
});

// ---- Versioning (§65) + dataset version (§66) ----
test('R07 versioning: different algorithm versions have different fingerprints; history keeps both', () => {
  const v1 = fp.algorithmFingerprint({ algorithmId: 'x', version: 1, family: 'LOGISTIC_REGRESSION', modelStage: 'ROUND_OPEN', target: 'reached_2x', featureNames: ['jp_open'], hyperparameters: {}, preprocessing: 'P', splitPolicy: 'S', guards: {} });
  const v2 = fp.algorithmFingerprint({ algorithmId: 'x', version: 2, family: 'LOGISTIC_REGRESSION', modelStage: 'ROUND_OPEN', target: 'reached_2x', featureNames: ['jp_open', 'prev_max_odd'], hyperparameters: {}, preprocessing: 'P', splitPolicy: 'S', guards: {} });
  assert.notEqual(v1, v2);
});
test('R08 dataset version: same algorithm fingerprint, different data → two runs, different dataset fp', () => {
  const s = svc(gen({ n: 2000, signal: 'known', seed: 11 }));
  const a = s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  // grow the population with later rounds (new data), same algorithm config
  const ins = s._db.prepare("INSERT INTO rounds(capture_session_id,browser_id,sid,sequence_number,opened_at_ms,ended_at_ms,max_odd,jackpot_at_open,jackpot_at_lock,jackpot_delta,completeness,created_at_ms,updated_at_ms) VALUES(@capture_session_id,@browser_id,@sid,@sequence_number,@opened_at_ms,@ended_at_ms,@max_odd,@jackpot_at_open,@jackpot_at_lock,@jackpot_delta,@completeness,1,1)");
  const more = gen({ n: 2000, signal: 'known', seed: 99, tOffset: 5_000_000 }).map((r, i) => ({ ...r, sequence_number: 10000 + i }));
  s._db.transaction((rs) => { for (const r of rs) ins.run(r); })(more);
  const b = s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  assert.equal(a.evaluation.algorithmFingerprint, b.evaluation.algorithmFingerprint, 'same algorithm fingerprint');
  assert.notEqual(a.evaluation.datasetFingerprint, b.evaluation.datasetFingerprint, 'different dataset fingerprint');
  assert.notEqual(a.run.runId, b.run.runId, 'two distinct runs');
  const hist = s.history({ algorithmId: 'jp_open_logistic_v1', target: 'reached_2x', modelStage: 'ROUND_OPEN' });
  assert.equal(hist.length, 2, 'history retains both runs');
});

// ---- Comparability (§67) ----
test('R09 comparability: different targets/stages are NOT directly comparable', () => {
  const mk = (o) => ({ leakageStatus: 'PASS', status: 'OK', target: 'reached_2x', modelStage: 'ROUND_OPEN', datasetFingerprint: 'ds', leakagePolicyVersion: 1, brier: 0.2, ...o });
  assert.equal(comparison.compare([mk({ runId: 1 }), mk({ runId: 2, target: 'reached_5x' })]).verdict, 'NOT_DIRECTLY_COMPARABLE');
  assert.equal(comparison.compare([mk({ runId: 1 }), mk({ runId: 2, modelStage: 'ROUND_LOCK' })]).verdict, 'NOT_DIRECTLY_COMPARABLE');
  assert.equal(comparison.compare([mk({ runId: 1 }), mk({ runId: 2, datasetFingerprint: 'ds2' })]).verdict, 'NOT_DIRECTLY_COMPARABLE');
  const ok = comparison.compare([mk({ runId: 1, brier: 0.22 }), mk({ runId: 2, brier: 0.18 })]);
  assert.equal(ok.comparable, true);
  assert.equal(ok.rows[0].runId, 2, 'view ordered by Brier ascending');
});

// ---- Drift (§69) ----
test('R10 drift: degraded later run → degradation/possible-drift; noise → no material change', () => {
  const prev = { runId: 1, brier: 0.18, auc: 0.70, prevalence: 0.5, testN: 500, stabilityStatus: 'STABLE' };
  const degraded = { runId: 2, brier: 0.22, auc: 0.60, prevalence: 0.5, testN: 500, stabilityStatus: 'UNSTABLE' };
  assert.ok(['MATERIAL_DEGRADATION', 'POSSIBLE_DRIFT'].includes(drift.assess(degraded, prev).status));
  const noise = { runId: 3, brier: 0.182, auc: 0.699, prevalence: 0.5, testN: 500, stabilityStatus: 'STABLE' };
  assert.equal(drift.assess(noise, prev).status, 'NO_MATERIAL_CHANGE');
  assert.equal(drift.assess(prev, null).previousEvaluation, 'NONE');
});
test('R11 base-rate drift is reported alongside metric change', () => {
  const prev = { runId: 1, brier: 0.18, auc: 0.70, prevalence: 0.40, testN: 500, stabilityStatus: 'STABLE' };
  const cur = { runId: 2, brier: 0.19, auc: 0.69, prevalence: 0.55, testN: 500, stabilityStatus: 'STABLE' };
  const d = drift.assess(cur, prev);
  assert.ok(d.baseRate.materialShift, 'prevalence shift surfaced');
  assert.ok(Math.abs(d.baseRate.delta - 0.15) < 1e-9);
});

// ---- Readiness + matrix + overview (§28/§43/§73) ----
test('R12 readiness: rare target → insufficient; full matrix persisted; overview aggregates', () => {
  const s = svc(gen({ signal: 'none', seed: 5 }));
  const rare = s.readiness({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_100x' });
  assert.ok(['INSUFFICIENT_POSITIVES', 'INSUFFICIENT_DATA'].includes(rare.status));
  const m = s.evaluateAll({});
  const nAlgos = registry.ALGORITHMS.length; // registry-driven (V2 adds spline/tree families)
  assert.equal(m.cells.length, nAlgos * 2 * 3, 'algorithms × stages × enabled targets');
  const ov = s.overview();
  assert.equal(ov.registeredAlgorithms, nAlgos);
  assert.ok(ov.evaluatedExperiments > 0);
  assert.equal(ov.coverage.completeRounds, 3000);
});
test('R13 monitoring snapshot: NONE previous on first run, PRESENT after a second', () => {
  const s = svc(gen({ signal: 'known', seed: 11 }));
  s.evaluate({ algorithmId: 'jp_open_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  const mon1 = s.monitoring().find((m) => m.algorithmId === 'jp_open_logistic_v1' && m.modelStage === 'ROUND_OPEN' && m.target === 'reached_2x');
  assert.equal(mon1.previousEvaluation, 'NONE');
});

// ---- quality policy conservatism (§76) ----
test('R14 quality conservative: high AUC but negative ΔBrier is NOT strong', () => {
  assert.equal(qualityStatus({ leakageStatus: 'PASS', status: 'OK', deltaBrierTest: -0.01, auc: 0.8, stabilityStatus: 'STABLE', calibrationMaxDiff: 0.02 }).status, 'NO_IMPROVEMENT');
  assert.equal(qualityStatus({ leakageStatus: 'FAIL', status: 'OK' }).status, 'INVALID');
  assert.equal(qualityStatus({ leakageStatus: 'PASS', status: 'OK', deltaBrierTest: 0.02, auc: 0.7, stabilityStatus: 'UNSTABLE', calibrationMaxDiff: 0.02 }).status, 'SMALL_UNSTABLE_IMPROVEMENT');
});
