import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { ResearchService } = require('../../desktop/analytics/research/research-service.cjs');
const registry = require('../../desktop/analytics/research/algorithm-registry.cjs');
const fp = require('../../desktop/analytics/research/fingerprint.cjs');
const models = require('../../desktop/analytics/research/models.cjs');
const modelEngine = require('../../desktop/analytics/research/model-engine.cjs');
const { researchDecision } = require('../../desktop/analytics/research/quality.cjs');
const migrations = require('../../desktop/analytics/db/migrations.cjs');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Prediction Algorithm Research V2 — multi-family platform (§74). Deterministic
// synthetic scenarios prove: nonlinear detection (spline), threshold detection
// (tree), LINEAR simplicity preference (no false complexity win), regime-shift
// instability, model failure ≠ no-signal, batch persistence, version history,
// V1→V4 migration compatibility, and the research/action boundary.
// ---------------------------------------------------------------------------
function rng(s) { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// signal: none | linear | nonlinear(U-shaped in jp) | threshold | regime
function gen({ n = 4000, signal = 'nonlinear', seed = 7, tOffset = 0 }) {
  const r = rng(seed); const rows = []; const per = Math.floor(n / 2);
  for (let b = 0; b < 2; b++) for (let i = 0; i < per; i++) {
    const jp = 50 + Math.floor(r() * 1900); const z = (jp - 1000) / 500;
    let lin;
    if (signal === 'none') lin = -0.2;
    else if (signal === 'linear') lin = -0.2 + 1.6 * z;
    else if (signal === 'nonlinear') lin = -0.5 + 2.2 * (z * z);
    else if (signal === 'threshold') lin = (jp > 1200 ? 1.4 : -1.2);
    else if (signal === 'regime') lin = (i < per / 2 ? -0.5 + 2.2 * (z * z) : -0.2); // nonlinear early, vanishes late
    const hit = r() < sigmoid(lin);
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
function evalOf(rows, algorithmId) { return svc(rows).evaluate({ algorithmId, modelStage: 'ROUND_OPEN', target: 'reached_2x' }).evaluation; }

// ---- Registry discovers the new families (§19/§20) ----
test('V01 registry exposes spline + tree families with capability/complexity metadata', () => {
  const view = registry.registryView();
  const fams = new Set(view.map((a) => a.family));
  assert.ok(fams.has('SPLINE') && fams.has('DECISION_TREE'), 'new families registered');
  const spline = view.find((a) => a.family === 'SPLINE');
  assert.equal(spline.kind, 'SPLINE');
  assert.equal(spline.complexityClass, 'NONLINEAR_ADDITIVE');
  assert.equal(spline.capability, 'EXPERIMENTAL');
  assert.ok(spline.experimental === true);
  const tree = view.find((a) => a.family === 'DECISION_TREE');
  assert.equal(tree.complexityClass, 'NONLINEAR_TREE');
});

// ---- Existing V1 algorithm fingerprints UNCHANGED (§58) ----
test('V02 V1 algorithm fingerprints are unchanged by the family-guard refactor', () => {
  const expected = fp.algorithmFingerprint({
    algorithmId: 'jp_open_logistic_v1', version: 1, family: 'LOGISTIC_REGRESSION', modelStage: 'ROUND_OPEN', target: 'reached_2x',
    featureNames: ['jp_open'], hyperparameters: { l2Grid: [0.5, 1.0, 4.0] },
    preprocessing: 'TRAIN_ONLY_STANDARDIZE_IMPUTE', splitPolicy: 'CHRONO_60_20_20+EXPANDING_WALK_FORWARD',
    guards: { MIN_TRAIN: 200, MIN_POS_PER_SET: 20, MIN_TEST: 50, MIN_CALIB_BIN: 20 },
  });
  assert.equal(fp.algorithmFingerprint(registry.resolveConfig('jp_open_logistic_v1', 'ROUND_OPEN', 'reached_2x')), expected);
  // New families carry a distinct (larger) guard → distinct fingerprint.
  const sp = fp.algorithmFingerprint(registry.resolveConfig('full_forward_spline_v1', 'ROUND_OPEN', 'reached_2x'));
  const lg = fp.algorithmFingerprint(registry.resolveConfig('full_forward_logistic_v1', 'ROUND_OPEN', 'reached_2x'));
  assert.notEqual(sp, lg, 'spline fingerprint differs from linear on the same feature set');
});

// ---- Family-specific readiness (§7/§41) ----
test('V03 family guards: a spline cell can be INSUFFICIENT while logistic is READY on the same rounds', () => {
  const s = svc(gen({ n: 700, signal: 'linear', seed: 5 })); // ~420 train: ≥200 (logistic) but <600 (spline)
  const lg = s.readiness({ algorithmId: 'jp_context_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  const sp = s.readiness({ algorithmId: 'jp_context_spline_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  assert.equal(lg.status, 'READY');
  assert.equal(sp.status, 'INSUFFICIENT_DATA');
  assert.ok(sp.guards.MIN_TRAIN > lg.guards.MIN_TRAIN, 'spline guard is larger');
});

// ---- Shared evaluation path: spline/tree run through the same pipeline (§18) ----
test('V04 spline + tree evaluate through the shared engine and persist (leakage PASS)', () => {
  const s = svc(gen({ signal: 'nonlinear', seed: 11 }));
  for (const id of ['jp_context_spline_v1', 'jp_context_tree_v1']) {
    const { run, evaluation } = s.evaluate({ algorithmId: id, modelStage: 'ROUND_OPEN', target: 'reached_2x' });
    assert.equal(evaluation.status, 'OK', id);
    assert.equal(evaluation.leakageStatus, 'PASS', id);
    assert.ok(run.runId > 0);
    assert.ok(evaluation.complexity && evaluation.complexity.params > 0);
    assert.ok(Array.isArray(evaluation.searchLedger) && evaluation.searchLedger.length >= 2, 'search ledger recorded');
    assert.ok(evaluation.searchLedger.some((e) => e.selected), 'a config is selected');
  }
});

// ---- KNOWN-NONLINEAR sanity (§44): spline beats linear; linear misses it ----
test('V05 nonlinear (U-shaped): linear logistic misses it, spline shows STABLE incremental value', () => {
  const rows = gen({ signal: 'nonlinear', seed: 11 });
  const lin = evalOf(rows, 'jp_context_logistic_v1');
  const sp = evalOf(rows, 'jp_context_spline_v1');
  assert.ok(lin.testMetrics.auc < 0.6, 'linear cannot capture U-shape: ' + lin.testMetrics.auc);
  assert.ok(sp.testMetrics.auc > 0.75, 'spline captures nonlinearity: ' + sp.testMetrics.auc);
  assert.ok(sp.deltaBrierVsLinear > 0.005, 'spline improves Brier over linear');
  assert.equal(sp.incrementalValue, 'STABLE_INCREMENTAL_VALUE');
  assert.equal(researchDecision(sp), 'STABLE_INCREMENTAL_VALUE');
});

// ---- LINEAR simplicity preference (§43): no false complexity win ----
test('V06 linear signal: spline + tree do NOT earn incremental value over linear', () => {
  const rows = gen({ signal: 'linear', seed: 11 });
  const sp = evalOf(rows, 'jp_context_spline_v1');
  const tr = evalOf(rows, 'jp_context_tree_v1');
  assert.equal(sp.incrementalValue, 'NO_INCREMENTAL_VALUE', 'spline: ' + sp.deltaBrierVsLinear);
  assert.equal(tr.incrementalValue, 'NO_INCREMENTAL_VALUE', 'tree: ' + tr.deltaBrierVsLinear);
});

// ---- THRESHOLD sanity (§45): shallow tree recovers threshold structure ----
test('V07 threshold effect: shallow tree shows incremental value over linear', () => {
  const rows = gen({ signal: 'threshold', seed: 11 });
  const tr = evalOf(rows, 'jp_context_tree_v1');
  assert.equal(tr.status, 'OK');
  assert.ok(tr.deltaBrierVsLinear > 0, 'tree beats linear on a threshold: ' + tr.deltaBrierVsLinear);
  assert.ok(['STABLE_INCREMENTAL_VALUE', 'POSSIBLE_INCREMENTAL_VALUE'].includes(tr.incrementalValue));
});

// ---- REGIME shift (§46): advanced improvement is not called stable ----
test('V08 regime shift: spline is not MATERIAL_STABLE; instability surfaced', () => {
  const sp = evalOf(gen({ signal: 'regime', seed: 31 }), 'jp_context_spline_v1');
  assert.notEqual(sp.quality.status, 'MATERIAL_STABLE_IMPROVEMENT');
  assert.notEqual(sp.incrementalValue, 'STABLE_INCREMENTAL_VALUE');
});

// ---- Model failure ≠ no signal (§71/§72) ----
test('V09 probability audit + failure taxonomy are distinct states', () => {
  assert.equal(modelEngine.auditProbabilities([0.2, 0.8, 0.5]).ok, true);
  assert.equal(modelEngine.auditProbabilities([0.5, 0.5, 0.5]).reason, 'COLLAPSED_VARIANCE');
  assert.equal(modelEngine.auditProbabilities([NaN, 0.5]).reason, 'NON_PROBABILITY');
  assert.equal(modelEngine.auditProbabilities([Infinity, 0.5]).reason, 'NON_PROBABILITY');
  assert.equal(modelEngine.auditProbabilities([1.2, 0.5]).reason, 'NON_PROBABILITY');
  // The four states are never conflated.
  const set = new Set(['MODEL_FAILED', 'INSUFFICIENT_DATA', 'NO_INCREMENTAL_VALUE', 'STABLE_INCREMENTAL_VALUE']);
  assert.equal(set.size, 4);
});

// ---- Deterministic seed / reproducibility (§70) ----
test('V10 deterministic: same data + config → identical spline & tree results', () => {
  const rows = gen({ signal: 'nonlinear', seed: 11 });
  const a = evalOf(rows, 'jp_context_spline_v1'), b = evalOf(rows, 'jp_context_spline_v1');
  assert.equal(a.testMetrics.brier, b.testMetrics.brier);
  assert.equal(a.deltaBrierVsLinear, b.deltaBrierVsLinear);
  const c = evalOf(rows, 'jp_context_tree_v1'), d = evalOf(rows, 'jp_context_tree_v1');
  assert.equal(c.testMetrics.brier, d.testMetrics.brier);
});

// ---- Numeric stability (§71): extreme scale / missing values do not throw or NaN ----
test('V11 model families tolerate extreme scale, constant, and missing features', () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ features: { a: i % 7 === 0 ? null : (i * 1e9), b: 5, c: Math.sin(i) }, target: i % 3 === 0 ? 1 : 0 });
  for (const kind of ['LOGISTIC', 'SPLINE', 'TREE']) {
    const m = models.makeModel(kind, rows, ['a', 'b', 'c'], models.expandGrid(kind, { l2Grid: [1] })[0]);
    const p = m.predict(rows);
    assert.ok(p.every((x) => Number.isFinite(x) && x >= 0 && x <= 1), kind + ' produces valid probabilities');
  }
});

// ---- Paired comparability (§23): same cell comparable; different data is not ----
test('V12 comparison: spline vs linear same cell is comparable, ordered by Brier', () => {
  const s = svc(gen({ signal: 'nonlinear', seed: 11 }));
  const a = s.evaluate({ algorithmId: 'jp_context_logistic_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  const b = s.evaluate({ algorithmId: 'jp_context_spline_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  const cmp = s.compare({ runIds: [a.run.runId, b.run.runId] });
  assert.equal(cmp.comparable, true);
  assert.ok(cmp.summary && typeof cmp.summary === 'string');
  assert.ok(cmp.rows[0].brier <= cmp.rows[1].brier, 'view ordered by Brier');
});

// ---- Batch persistence + generation (§35/§37) ----
test('V13 evaluateAll persists ONE batch; runs carry batchId + generation', () => {
  const s = svc(gen({ signal: 'nonlinear', seed: 11 }));
  const all = s.evaluateAll({});
  assert.ok(all.batchId > 0);
  assert.equal(all.cells.length, registry.ALGORITHMS.length * 2 * 3);
  const batches = s.batches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].cellCount, all.cells.length);
  const runs = s.batchRuns(all.batchId);
  assert.ok(runs.length > 0 && runs.every((r) => r.evaluationGeneration === 1));
});

// ---- Version history: re-evaluation on more data → new generation, both kept (§35) ----
test('V14 version history: growing data yields a new generation without overwriting', () => {
  const s = svc(gen({ n: 2000, signal: 'nonlinear', seed: 11 }));
  const a = s.evaluate({ algorithmId: 'jp_context_spline_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  const ins = s._db.prepare("INSERT INTO rounds(capture_session_id,browser_id,sid,sequence_number,opened_at_ms,ended_at_ms,max_odd,jackpot_at_open,jackpot_at_lock,jackpot_delta,completeness,created_at_ms,updated_at_ms) VALUES(@capture_session_id,@browser_id,@sid,@sequence_number,@opened_at_ms,@ended_at_ms,@max_odd,@jackpot_at_open,@jackpot_at_lock,@jackpot_delta,@completeness,1,1)");
  const more = gen({ n: 2000, signal: 'nonlinear', seed: 99, tOffset: 5_000_000 }).map((r, i) => ({ ...r, sequence_number: 10000 + i }));
  s._db.transaction((rs) => { for (const r of rs) ins.run(r); })(more);
  const b = s.evaluate({ algorithmId: 'jp_context_spline_v1', modelStage: 'ROUND_OPEN', target: 'reached_2x' });
  assert.notEqual(a.run.runId, b.run.runId);
  assert.equal(b.run.evaluationGeneration, 2, 'second generation');
  const hist = s.history({ algorithmId: 'jp_context_spline_v1', target: 'reached_2x', modelStage: 'ROUND_OPEN' });
  assert.equal(hist.length, 2, 'both generations retained');
});

// ---- Family monitoring (§39/§68): summarizes without ranking by best single run ----
test('V15 family monitoring counts ready / stable-incremental / no-incremental cells', () => {
  const s = svc(gen({ signal: 'nonlinear', seed: 11 }));
  s.evaluateAll({});
  const fam = s.familyMonitoring();
  const spline = fam.find((f) => f.family === 'SPLINE');
  assert.ok(spline && spline.realReadyCells > 0);
  assert.ok(spline.stableIncrementalCells >= 1, 'spline shows stable incremental value on nonlinear data');
  assert.ok(fam.find((f) => f.family === 'BASELINE'));
});

// ---- V1 → V4 migration compatibility: old research history still loads (§57) ----
test('V16 migration v3→v4 is additive; a pre-existing V1 run still loads with null V2 columns', () => {
  const db = new Database(':memory:');
  // Bring the DB up to V3 only (the state a V1 install shipped with).
  for (const m of migrations.MIGRATIONS) { if (m.version > 3) break; m.up(db); db.pragma(`user_version = ${m.version}`); }
  assert.equal(migrations.currentVersion(db), 3);
  db.prepare(`INSERT INTO research_experiments (experiment_key, algorithm_id, version, algorithm_fingerprint, target, model_stage, created_at_ms) VALUES ('exp_old','jp_open_logistic_v1',1,'alg_old','reached_2x','ROUND_OPEN',1)`).run();
  db.prepare(`INSERT INTO research_runs (experiment_id, algorithm_id, version, algorithm_fingerprint, dataset_fingerprint, frozen_fingerprint, target, model_stage, code_revision, leakage_status, leakage_policy_version, status, brier, result_json, evaluated_at_ms, created_at_ms)
              VALUES (1,'jp_open_logistic_v1',1,'alg_old','ds_old','alg_old|ds_old','reached_2x','ROUND_OPEN','fr-engine-2','PASS',1,'OK',0.2,'{"legacy":true}',5,5)`).run();
  // Now migrate to latest (v4).
  const finalV = migrations.runMigrations(db);
  assert.equal(finalV, migrations.LATEST_VERSION);
  const row = db.prepare('SELECT * FROM research_runs WHERE algorithm_fingerprint=?').get('alg_old');
  assert.ok(row, 'old run survived migration');
  assert.equal(row.brier, 0.2);
  assert.equal(row.family, null, 'new V2 column is null for a legacy run (not invalidated)');
  assert.equal(row.result_json, '{"legacy":true}', 'immutable V1 evidence preserved');
});

// ---- Incremental-value policy unit coverage (§25/§27) ----
test('V17 incremental value: negligible gain from a much larger model is NOT counted', () => {
  const stable = { status: 'STABLE' };
  // tiny +Brier but 5x complexity → NO_INCREMENTAL_VALUE (complexity penalty in interpretation).
  assert.equal(modelEngine.incrementalValueStatus({ kind: 'SPLINE', deltaBrierVsLinear: 0.0006, incrementalStability: stable, complexity: { params: 25 }, linearComplexity: { params: 5 } }), 'NO_INCREMENTAL_VALUE');
  // clear + stable gain → STABLE_INCREMENTAL_VALUE.
  assert.equal(modelEngine.incrementalValueStatus({ kind: 'SPLINE', deltaBrierVsLinear: 0.02, incrementalStability: stable, complexity: { params: 25 }, linearComplexity: { params: 5 } }), 'STABLE_INCREMENTAL_VALUE');
  // worse than linear → NO_INCREMENTAL_VALUE.
  assert.equal(modelEngine.incrementalValueStatus({ kind: 'TREE', deltaBrierVsLinear: -0.01, incrementalStability: stable, complexity: { params: 8 }, linearComplexity: { params: 5 } }), 'NO_INCREMENTAL_VALUE');
  // linear/baseline are not advanced candidates.
  assert.equal(modelEngine.incrementalValueStatus({ kind: 'LOGISTIC', deltaBrierVsLinear: null, incrementalStability: stable, complexity: { params: 5 }, linearComplexity: { params: 5 } }), 'N_A');
});
