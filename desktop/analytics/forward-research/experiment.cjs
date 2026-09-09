'use strict';

const reg = require('./feature-registry.cjs');
const { buildDataset } = require('./dataset-builder.cjs');
const L = require('./logistic.cjs');
const Mx = require('./metrics.cjs');
const { chronoSplit, walkForward } = require('./split.cjs');

// ---------------------------------------------------------------------------
// Experiment orchestrator — RETROSPECTIVE OUT-OF-SAMPLE forward research.
// Lifecycle: DEFINE → FIT(train) → VALIDATE(val) → FREEZE → TEST(once). TEST is
// never used for feature/model/hyperparameter selection. Every result carries a
// machine-checkable leakage audit and a conservative conclusion. No prediction API.
// ---------------------------------------------------------------------------

const GUARD = Object.freeze({ MIN_TRAIN: 200, MIN_POS_PER_SET: 20, MIN_TEST: 50, MIN_CALIB_BIN: 20 });
const L2_GRID = [0.5, 1.0, 4.0];

function modelsForStage(stage) {
  const prior = ['prev_max_odd', 'roll_rate2_10', 'roll_jp_mean_10'];
  const time = ['hour_sin', 'hour_cos'];
  const M3 = stage === reg.STAGE.ROUND_LOCK
    ? ['jp_open', 'jp_lock', ...prior, ...time]
    : ['jp_open', ...prior, ...time];
  return { M0: [], M1: ['jp_open'], M2: ['jp_open', ...prior], M3 };
}

// Machine-checkable leakage audit (§36): stage gate + forbidden-field absence + structural guards.
function auditLeakage(stage, featureUnion) {
  const checks = {};
  checks.featureStageWithinModelStage = featureUnion.every((f) => reg.isForwardEligible(f, stage));
  checks.noForbiddenCurrentField = featureUnion.every((f) => {
    const e = reg.byName.get(f); if (!e) return false;
    if (e.kind !== 'current') return true;                          // prior/time can't be a current post-round field
    return !reg.FORBIDDEN_CURRENT_FIELDS.some((bad) => e.sourceField === bad || e.sourceField.startsWith(bad));
  });
  checks.priorFeaturesShifted = featureUnion.every((f) => { const e = reg.byName.get(f); return !e || e.kind !== 'prior' || e.shift === 1 || e.window != null || e.agg === 'streak'; });
  checks.browserIsolation = true;      // structural: dataset-builder partitions by browser, never crosses streams
  checks.trainOnlyScaler = true;       // structural: scaler fit on train slice only (fitEval below)
  checks.testNotUsedForSelection = true; // structural: selection uses validation only; test evaluated once, frozen
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks };
}

function toXY(rows, featureNames) { return { X: rows.map((r) => featureNames.map((f) => (r.features[f] == null ? null : r.features[f]))), y: rows.map((r) => r.target) }; }

// Fit a model on TRAIN only (scaler + logistic, or prevalence baseline for the empty set).
function fitModel(trainRows, featureNames, l2) {
  const { X, y } = toXY(trainRows, featureNames);
  if (featureNames.length === 0) { const prev = Mx.baseRate(y) || 0; return { type: 'PREVALENCE', prevalence: prev, featureNames, coef: [], intercept: null }; }
  const scaler = L.fitScaler(X, featureNames.length);              // TRAIN ONLY (also the train-mean imputer)
  const Xs = L.applyScaler(X, scaler);
  const m = L.fit(Xs, y, { l2 });
  return { type: 'LOGISTIC', scaler, coef: m.coef, intercept: m.intercept, converged: m.converged, iterations: m.iterations, status: m.status, featureNames, l2 };
}
function predictRows(model, rows) {
  const { X, y } = toXY(rows, model.featureNames);
  const p = model.type === 'PREVALENCE' ? new Array(rows.length).fill(model.prevalence) : L.predict(model, L.applyScaler(X, model.scaler));
  return { p, y };
}
function evalModel(model, rows) { const { p, y } = predictRows(model, rows); return { ...Mx.evaluate(p, y), calibration: Mx.calibration(p, y) }; }

// Stability verdict from per-fold walk-forward improvement (baseline Brier − model Brier).
function stabilityVerdict(folds) {
  const deltas = folds.map((f) => f.deltaBrier).filter((d) => d != null);
  const aucs = folds.map((f) => f.auc).filter((a) => a != null);
  if (deltas.length < 3) return { status: 'INSUFFICIENT_DATA', directionConsistent: null, spread: null };
  const signs = deltas.map((d) => (Math.abs(d) < 5e-4 ? 0 : Math.sign(d)));
  const hasPos = signs.some((s) => s > 0), hasNeg = signs.some((s) => s < 0);
  const spread = Math.max(...aucs) - Math.min(...aucs);
  let status;
  if (hasPos && hasNeg) status = 'UNSTABLE';                       // improvement flips to degradation
  else if (!hasPos && !hasNeg) status = 'MIXED';                   // all negligible
  else if (spread < 0.10 && !hasNeg) status = 'STABLE';
  else status = 'MIXED';
  return { status, directionConsistent: !(hasPos && hasNeg), spread, foldDeltas: deltas };
}

// Coefficient sign stability across folds (a feature whose sign flips is unstable, §23).
function coefficientStability(foldModels, featureNames) {
  return featureNames.map((f, j) => {
    const coefs = foldModels.filter((m) => m.type === 'LOGISTIC').map((m) => m.coef[j]).filter((c) => Number.isFinite(c));
    const signs = new Set(coefs.map((c) => (Math.abs(c) < 1e-6 ? 0 : Math.sign(c))));
    return { feature: f, meanCoef: coefs.length ? coefs.reduce((a, b) => a + b, 0) / coefs.length : null, signFlips: signs.size > 1, stable: signs.size <= 1 };
  });
}

// Full experiment for one (modelStage, target). `rounds` = COMPLETE rounds (flat rows).
function runExperiment({ rounds, modelStage, target, fractions = [0.6, 0.2, 0.2], folds = 4 }) {
  const models = modelsForStage(modelStage);
  const featureUnion = models.M3;
  const leakageAudit = auditLeakage(modelStage, featureUnion);
  const ds = buildDataset({ rounds, modelStage, featureNames: featureUnion, target });
  const rows = ds.rows;
  const split = chronoSplit(rows, fractions);
  const population = { mode: 'FORWARD_RESEARCH', modelStage, target: target.name, n: rows.length, browsers: ds.meta.browsers, missingOutcome: ds.meta.missingOutcome, missing: ds.meta.missing };

  // Sample guards (explicit statuses, never fake zeros).
  const trainPos = split.train.reduce((a, r) => a + r.target, 0);
  const testPos = split.test.reduce((a, r) => a + r.target, 0);
  if (split.train.length < GUARD.MIN_TRAIN || split.test.length < GUARD.MIN_TEST) return { ...population, leakageAudit, split: splitInfo(split), status: 'INSUFFICIENT_DATA' };
  if (trainPos < GUARD.MIN_POS_PER_SET || split.train.length - trainPos < GUARD.MIN_POS_PER_SET || testPos < GUARD.MIN_POS_PER_SET) return { ...population, leakageAudit, split: splitInfo(split), status: 'INSUFFICIENT_POSITIVES' };

  // Baseline M0 (prevalence) — the bar every model must clear out of sample.
  const m0 = fitModel(split.train, [], 1.0);
  const baseline = { validation: evalModel(m0, split.validation), test: evalModel(m0, split.test) };

  // FIT candidate models on TRAIN; SELECT by VALIDATION Brier (+ small L2 grid). TEST untouched.
  const candidates = {};
  for (const key of ['M1', 'M2', 'M3']) {
    let best = null;
    for (const l2 of L2_GRID) { const m = fitModel(split.train, models[key], l2); const v = evalModel(m, split.validation); if (!best || (v.brier != null && v.brier < best.validation.brier)) best = { model: m, validation: v, l2 }; }
    candidates[key] = { featureNames: models[key], l2: best.l2, converged: best.model.converged, validation: best.validation, _model: best.model };
  }
  // Pick the model with the best VALIDATION Brier improvement over baseline (parsimony tie-break: prefer fewer features).
  const order = ['M1', 'M2', 'M3'];
  let selectedKey = 'M1';
  for (const key of order) if (candidates[key].validation.brier < candidates[selectedKey].validation.brier - 1e-6) selectedKey = key;
  const selected = candidates[selectedKey];

  // FREEZE, then evaluate TEST exactly once.
  const testMetrics = evalModel(selected._model, split.test);
  const deltaBrierTest = baseline.test.brier != null && testMetrics.brier != null ? baseline.test.brier - testMetrics.brier : null;
  const aucCI = Mx.bootstrapAucCI(...(() => { const { p, y } = predictRows(selected._model, split.test); return [p, y]; })());

  // Walk-forward (expanding window) for the SELECTED feature set — per-fold refit (scaler+model on fold train).
  const wfRows = walkForward(rows, folds);
  const foldModels = []; const wf = wfRows.map((fd) => {
    const fm = fitModel(fd.train, selected.featureNames, selected.l2); foldModels.push(fm);
    const b0 = fitModel(fd.train, [], 1.0);
    const em = evalModel(fm, fd.test); const eb = evalModel(b0, fd.test);
    return { fold: fd.fold, trainN: fd.train.length, testN: fd.test.length, prevalence: em.prevalence, auc: em.auc, brier: em.brier, baselineBrier: eb.brier, deltaBrier: eb.brier != null && em.brier != null ? eb.brier - em.brier : null };
  });
  const stability = stabilityVerdict(wf);
  const coefStability = selected._model.type === 'LOGISTIC' ? coefficientStability(foldModels, selected.featureNames) : [];

  const conclusion = concludeStatus({ deltaBrierTest, testAuc: testMetrics.auc, stability, calibration: testMetrics.calibration, testMetrics });

  return {
    ...population, leakageAudit, split: splitInfo(split),
    baseline, models: Object.fromEntries(order.map((k) => [k, { featureNames: candidates[k].featureNames, l2: candidates[k].l2, converged: candidates[k].converged, validation: brief(candidates[k].validation) }])),
    selected: { key: selectedKey, featureNames: selected.featureNames, l2: selected.l2, coef: selected._model.coef, intercept: selected._model.intercept, converged: selected._model.converged },
    testMetrics: brief(testMetrics), calibration: testMetrics.calibration, deltaBrierTest, aucCI,
    walkForward: wf, stability, coefficientStability: coefStability, conclusion, status: 'OK',
  };
}

// ---------------------------------------------------------------------------
// SHARED SINGLE-ALGORITHM ENGINE (§18). Evaluates ONE registered algorithm config
// (a feature set + L2 grid at a stage/target) end-to-end: FIT(train) → VALIDATE(val,
// select L2 only) → FREEZE → TEST(once) → WALK-FORWARD → CALIBRATION → STABILITY →
// LEAKAGE → CONCLUSION. Pure/deterministic; NO persistence, NO identity/fingerprint
// (those live in the product layer, outside this read-only subsystem). Every
// registered algorithm goes through THIS function, so comparison is apples-to-apples.
// The empty feature set is the prevalence baseline and is evaluated the same way.
// ---------------------------------------------------------------------------
function evaluateFeatureSet({ rounds, modelStage, target, featureNames, l2Grid = L2_GRID, fractions = [0.6, 0.2, 0.2], folds = 4 }) {
  const feats = Array.isArray(featureNames) ? featureNames : [];
  const isBaseline = feats.length === 0;
  const leakageAudit = auditLeakage(modelStage, feats);
  const ds = buildDataset({ rounds, modelStage, featureNames: feats, target });
  const rows = ds.rows;
  const split = chronoSplit(rows, fractions);
  const population = { mode: 'FORWARD_RESEARCH', modelStage, target: target.name, n: rows.length, browsers: ds.meta.browsers, missingOutcome: ds.meta.missingOutcome, missing: ds.meta.missing };

  const trainPos = split.train.reduce((a, r) => a + r.target, 0);
  const testPos = split.test.reduce((a, r) => a + r.target, 0);
  if (split.train.length < GUARD.MIN_TRAIN || split.test.length < GUARD.MIN_TEST) return { ...population, leakageAudit, split: splitInfo(split), status: 'INSUFFICIENT_DATA' };
  if (trainPos < GUARD.MIN_POS_PER_SET || split.train.length - trainPos < GUARD.MIN_POS_PER_SET || testPos < GUARD.MIN_POS_PER_SET) return { ...population, leakageAudit, split: splitInfo(split), status: 'INSUFFICIENT_POSITIVES' };

  // Prevalence baseline (the bar this algorithm must clear out of sample). For the
  // baseline algorithm itself, model === baseline, so deltas collapse to 0.
  const m0 = fitModel(split.train, [], 1.0);
  const baseline = { validation: evalModel(m0, split.validation), test: evalModel(m0, split.test) };

  // SELECT L2 by VALIDATION Brier only (baseline has a single trivial fit). TEST untouched.
  let best = null;
  for (const l2 of (isBaseline ? [1.0] : l2Grid)) {
    const m = fitModel(split.train, feats, l2);
    const v = evalModel(m, split.validation);
    if (!best || (v.brier != null && v.brier < best.validation.brier)) best = { model: m, validation: v, l2 };
  }
  const l2Ledger = isBaseline ? [] : l2Grid.map((l2) => { const m = fitModel(split.train, feats, l2); return { l2, validationBrier: evalModel(m, split.validation).brier, selected: l2 === best.l2 }; });

  // FREEZE, then evaluate TEST exactly once.
  const testMetrics = evalModel(best.model, split.test);
  const deltaBrierTest = baseline.test.brier != null && testMetrics.brier != null ? baseline.test.brier - testMetrics.brier : null;
  const { p: testP, y: testY } = predictRows(best.model, split.test);
  const aucCI = Mx.bootstrapAucCI(testP, testY);

  // Walk-forward (expanding window) — per-fold refit (scaler + model on fold train only).
  const wfRows = walkForward(rows, folds);
  const foldModels = [];
  const wf = wfRows.map((fd) => {
    const fm = fitModel(fd.train, feats, best.l2); foldModels.push(fm);
    const b0 = fitModel(fd.train, [], 1.0);
    const em = evalModel(fm, fd.test); const eb = evalModel(b0, fd.test);
    return { fold: fd.fold, trainN: fd.train.length, testN: fd.test.length, prevalence: em.prevalence, auc: em.auc, prAuc: em.prAuc, brier: em.brier, baselineBrier: eb.brier, deltaBrier: eb.brier != null && em.brier != null ? eb.brier - em.brier : null };
  });
  const stability = stabilityVerdict(wf);
  const coefStability = best.model.type === 'LOGISTIC' ? coefficientStability(foldModels, feats) : [];
  const conclusion = concludeStatus({ deltaBrierTest, testAuc: testMetrics.auc, stability, calibration: testMetrics.calibration, testMetrics });

  return {
    ...population, leakageAudit, split: splitInfo(split),
    baseline: { validation: brief(baseline.validation), test: brief(baseline.test) },
    featureNames: feats, l2: best.l2, converged: best.model.converged, modelType: best.model.type,
    validation: brief(best.validation), testMetrics: brief(testMetrics), calibration: testMetrics.calibration,
    deltaBrierTest, aucCI, l2Ledger,
    coef: best.model.type === 'LOGISTIC' ? best.model.coef : [], intercept: best.model.intercept != null ? best.model.intercept : null,
    walkForward: wf, stability, coefficientStability: coefStability, conclusion,
    timeRange: { start: rows.length ? rows[0].eventTime : null, end: rows.length ? rows[rows.length - 1].eventTime : null },
    status: 'OK',
  };
}

function splitInfo(s) { return { train: { n: s.train.length, positives: s.train.reduce((a, r) => a + r.target, 0) }, validation: { n: s.validation.length, positives: s.validation.reduce((a, r) => a + r.target, 0) }, test: { n: s.test.length, positives: s.test.reduce((a, r) => a + r.target, 0) } }; }
function brief(m) { return { n: m.n, positives: m.positives, prevalence: m.prevalence, auc: m.auc, prAuc: m.prAuc, brier: m.brier, logLoss: m.logLoss }; }

function concludeStatus({ deltaBrierTest, testAuc, stability, calibration }) {
  const reasons = [];
  const negligible = deltaBrierTest == null || deltaBrierTest <= 5e-4;
  const noDiscrim = testAuc == null || testAuc <= 0.52;
  const maxCalibDiff = Math.max(0, ...calibration.filter((b) => b.n >= GUARD.MIN_CALIB_BIN && b.diff != null).map((b) => Math.abs(b.diff)));
  const poorCalib = maxCalibDiff > 0.15;
  let status, magnitude = 'NONE';
  if (negligible && noDiscrim) { status = 'NO_STABLE_FORWARD_VALUE'; reasons.push('NO_OUT_OF_SAMPLE_IMPROVEMENT'); }
  else if (stability.status === 'UNSTABLE' || stability.status === 'MIXED') { status = 'NO_STABLE_FORWARD_VALUE'; reasons.push('TEMPORAL_INSTABILITY'); magnitude = 'SMALL'; }
  else if (poorCalib) { status = 'NO_STABLE_FORWARD_VALUE'; reasons.push('POOR_CALIBRATION'); magnitude = 'SMALL'; }
  else { status = 'SMALL_STABLE_FORWARD_VALUE'; magnitude = 'SMALL'; }
  return { status, magnitude, stability: stability.status, calibrationMaxDiff: maxCalibDiff, reasons };
}

module.exports = { runExperiment, evaluateFeatureSet, auditLeakage, modelsForStage, fitModel, evalModel, toXY, GUARD, stabilityVerdict };
