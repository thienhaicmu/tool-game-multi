'use strict';

const { buildDataset } = require('../forward-research/dataset-builder.cjs');
const { chronoSplit, walkForward } = require('../forward-research/split.cjs');
const { auditLeakage, stabilityVerdict, concludeStatus } = require('../forward-research/experiment.cjs');
const Mx = require('../forward-research/metrics.cjs');
const models = require('./models.cjs');

// ---------------------------------------------------------------------------
// SHARED MULTI-FAMILY EVALUATION ENGINE (§18/§22/§24/§25). Evaluates ANY
// registered algorithm family (prevalence / logistic / spline / tree) through the
// SAME leakage-safe, chronological, out-of-sample pipeline used by the V1 logistic
// engine: FIT(train) → SELECT(validation only, small predeclared grid) → FREEZE →
// TEST(once) → WALK-FORWARD → CALIBRATION → STABILITY → CONCLUSION. The model family
// is the ONLY pluggable part; split / leakage audit / metrics / stability / guards
// are imported from the one shared implementation, so comparison is apples-to-apples.
//
// On top of the baseline (prevalence) comparison, this engine ALSO fits the REFERENCE
// LINEAR LOGISTIC on the SAME feature set + split and reports Δ Brier vs linear — the
// incremental value of the extra complexity (§24/§25/§27). Pure & deterministic; NO
// persistence, NO identity/fingerprint (those live in the product layer). Model
// failure returns MODEL_FAILED with diagnostics — never NaN-filled fake metrics (§71).
// ---------------------------------------------------------------------------

const SMALL_BRIER = 5e-4;        // below this a Δ Brier difference is negligible (matches quality.SMALL_BRIER)
const SEARCH_SPACE_VERSION = 1;  // bump when a family's predeclared grid changes

function evalWith(model, rows) {
  const p = model.predict(rows);
  const y = rows.map((r) => r.target);
  return { ...Mx.evaluate(p, y), calibration: Mx.calibration(p, y), _p: p, _y: y };
}
function brief(m) { return { n: m.n, positives: m.positives, prevalence: m.prevalence, auc: m.auc, prAuc: m.prAuc, brier: m.brier, logLoss: m.logLoss }; }
function splitInfo(s) {
  const pos = (rows) => rows.reduce((a, r) => a + r.target, 0);
  return { train: { n: s.train.length, positives: pos(s.train) }, validation: { n: s.validation.length, positives: pos(s.validation) }, test: { n: s.test.length, positives: pos(s.test) } };
}

// Probability-range audit (§29): reject NaN / Infinity / out-of-range / degenerate variance.
function auditProbabilities(p) {
  if (!p.length) return { ok: false, reason: 'EMPTY' };
  let min = Infinity, max = -Infinity, bad = 0;
  for (const v of p) { if (!Number.isFinite(v) || v < 0 || v > 1) bad++; if (v < min) min = v; if (v > max) max = v; }
  if (bad > 0) return { ok: false, reason: 'NON_PROBABILITY', bad, min, max };
  if (max - min < 1e-9) return { ok: false, reason: 'COLLAPSED_VARIANCE', min, max, note: 'DEGENERATE' };
  return { ok: true, min, max };
}

// Incremental stability (§26): sign consistency of per-fold Δ Brier vs LINEAR.
function incrementalStabilityVerdict(wf) {
  const deltas = wf.map((f) => f.deltaBrierVsLinear).filter((d) => d != null);
  if (deltas.length < 3) return { status: 'INSUFFICIENT_DATA', foldDeltas: deltas };
  const signs = deltas.map((d) => (Math.abs(d) < SMALL_BRIER ? 0 : Math.sign(d)));
  const hasPos = signs.some((s) => s > 0), hasNeg = signs.some((s) => s < 0);
  let status;
  if (hasPos && hasNeg) status = 'UNSTABLE';
  else if (!hasPos && !hasNeg) status = 'NEGLIGIBLE';
  else if (hasPos) status = 'STABLE';
  else status = 'WORSE';
  return { status, foldDeltas: deltas };
}

// Incremental-value decision vs the simple LINEAR model (§25/§27/§51). A tiny gain
// bought with much higher complexity is NOT treated as better (simplicity preference).
function incrementalValueStatus({ kind, deltaBrierVsLinear, incrementalStability, complexity, linearComplexity }) {
  if (kind === 'PREVALENCE' || kind === 'LOGISTIC') return 'N_A';
  if (deltaBrierVsLinear == null) return 'NOT_READY';
  if (deltaBrierVsLinear <= SMALL_BRIER) return 'NO_INCREMENTAL_VALUE';   // ≈ linear or worse
  // Positive test-set gain: require temporal consistency to call it more than possible.
  const st = incrementalStability.status;
  if (st === 'UNSTABLE' || st === 'WORSE') return 'UNSTABLE';
  if (st === 'STABLE') {
    // Complexity penalty in interpretation (§27): a negligible per-fold gain from a
    // much larger model is downgraded even when the single TEST number is positive.
    const ratio = linearComplexity && linearComplexity.params ? complexity.params / linearComplexity.params : 1;
    if (deltaBrierVsLinear < 0.001 && ratio >= 3) return 'NO_INCREMENTAL_VALUE';
    return 'STABLE_INCREMENTAL_VALUE';
  }
  return 'POSSIBLE_INCREMENTAL_VALUE';
}

// Full multi-family evaluation of one (modelStage, target, feature set, family+grid).
function evaluateModel({ rounds, modelStage, target, featureNames, kind, hyperparameters = {}, guard, fractions = [0.6, 0.2, 0.2], folds = 4 }) {
  const feats = Array.isArray(featureNames) ? featureNames : [];
  const leakageAudit = auditLeakage(modelStage, feats);
  const ds = buildDataset({ rounds, modelStage, featureNames: feats, target });
  const rows = ds.rows;
  const split = chronoSplit(rows, fractions);
  const population = { mode: 'FORWARD_RESEARCH', modelStage, target: target.name, n: rows.length, browsers: ds.meta.browsers, missingOutcome: ds.meta.missingOutcome, missing: ds.meta.missing };
  const G = guard;

  const trainPos = split.train.reduce((a, r) => a + r.target, 0);
  const testPos = split.test.reduce((a, r) => a + r.target, 0);
  if (split.train.length < G.MIN_TRAIN || split.test.length < G.MIN_TEST) return { ...population, leakageAudit, split: splitInfo(split), modelType: kind, status: 'INSUFFICIENT_DATA', guards: { ...G } };
  if (trainPos < G.MIN_POS_PER_SET || split.train.length - trainPos < G.MIN_POS_PER_SET || testPos < G.MIN_POS_PER_SET) return { ...population, leakageAudit, split: splitInfo(split), modelType: kind, status: 'INSUFFICIENT_POSITIVES', guards: { ...G } };

  // Prevalence baseline (the bar every model must clear out of sample).
  const m0 = models.fitPrevalence(split.train);
  const baseline = { validation: evalWith(m0, split.validation), test: evalWith(m0, split.test) };

  // Reference LINEAR logistic on the SAME feature set (selected by validation Brier).
  const l2Grid = hyperparameters.l2Grid && hyperparameters.l2Grid.length ? hyperparameters.l2Grid : [1.0];
  let refLin = null;
  for (const l2 of l2Grid) { const m = models.fitLogistic(split.train, feats, { l2 }); const v = evalWith(m, split.validation); if (refLin == null || (v.brier != null && v.brier < refLin.v.brier)) refLin = { model: m, v, l2 }; }
  const refLinTest = evalWith(refLin.model, split.test);

  // SELECT candidate family config by VALIDATION Brier only (predeclared grid, §32).
  const grid = models.expandGrid(kind, hyperparameters);
  const searchLedger = [];
  let best = null;
  for (const params of grid) {
    let model;
    try { model = models.makeModel(kind, split.train, feats, params); }
    catch (err) { searchLedger.push({ params, status: 'MODEL_FAILED', reason: String(err && err.message || err), selected: false }); continue; }
    const v = evalWith(model, split.validation);
    const ok = v.brier != null && Number.isFinite(v.brier) && model.converged !== false;
    searchLedger.push({ params, validationBrier: v.brier != null ? Number(v.brier) : null, converged: model.converged !== false, status: ok ? 'OK' : 'DEGENERATE', selected: false, reason: ok ? null : 'NON_FINITE_OR_DIVERGED' });
    if (ok && (best == null || v.brier < best.v.brier)) best = { model, v, params, ledgerIndex: searchLedger.length - 1 };
  }
  if (best == null) return { ...population, leakageAudit, split: splitInfo(split), modelType: kind, status: 'MODEL_FAILED', reasons: ['ALL_CONFIGS_FAILED'], searchLedger, searchSpaceVersion: SEARCH_SPACE_VERSION, guards: { ...G } };
  searchLedger[best.ledgerIndex].selected = true;

  // FREEZE → TEST once. Audit probabilities before trusting any metric (§29/§71).
  const testEval = evalWith(best.model, split.test);
  const probAudit = auditProbabilities(testEval._p);
  if (!probAudit.ok) return { ...population, leakageAudit, split: splitInfo(split), modelType: kind, status: 'MODEL_FAILED', reasons: ['DEGENERATE_PROBABILITIES', probAudit.reason], probAudit, searchLedger, searchSpaceVersion: SEARCH_SPACE_VERSION, guards: { ...G } };

  const deltaBrierTest = baseline.test.brier != null && testEval.brier != null ? baseline.test.brier - testEval.brier : null;
  const deltaBrierVsLinear = refLinTest.brier != null && testEval.brier != null ? refLinTest.brier - testEval.brier : null;
  const aucCI = Mx.bootstrapAucCI(testEval._p, testEval._y);

  // Walk-forward: per fold refit candidate + prevalence + linear on fold TRAIN only.
  const wf = walkForward(rows, folds).map((fd) => {
    const fm = models.makeModel(kind, fd.train, feats, best.params);
    const b0 = models.fitPrevalence(fd.train);
    const lin = models.fitLogistic(fd.train, feats, { l2: refLin.l2 });
    const em = evalWith(fm, fd.test), eb = evalWith(b0, fd.test), el = evalWith(lin, fd.test);
    return {
      fold: fd.fold, trainN: fd.train.length, testN: fd.test.length, prevalence: em.prevalence,
      auc: em.auc, prAuc: em.prAuc, brier: em.brier, baselineBrier: eb.brier,
      deltaBrier: eb.brier != null && em.brier != null ? eb.brier - em.brier : null,
      linearBrier: el.brier, deltaBrierVsLinear: el.brier != null && em.brier != null ? el.brier - em.brier : null,
    };
  });
  const stability = stabilityVerdict(wf);
  const incrementalStability = incrementalStabilityVerdict(wf);
  const conclusion = concludeStatus({ deltaBrierTest, testAuc: testEval.auc, stability, calibration: testEval.calibration, testMetrics: testEval });
  const complexity = best.model.complexity();
  const linearComplexity = refLin.model.complexity();
  const incrementalValue = incrementalValueStatus({ kind, deltaBrierVsLinear, incrementalStability, complexity, linearComplexity });

  return {
    ...population, leakageAudit, split: splitInfo(split),
    baseline: { validation: brief(baseline.validation), test: brief(baseline.test) },
    referenceLinear: { test: brief(refLinTest), l2: refLin.l2, complexity: linearComplexity },
    featureNames: feats, modelType: kind, params: best.params, selectedParams: best.params,
    validation: brief(best.v), testMetrics: brief(testEval), calibration: testEval.calibration,
    deltaBrierTest, deltaBrierVsLinear, aucCI,
    searchLedger, searchSpaceVersion: SEARCH_SPACE_VERSION,
    walkForward: wf, stability, incrementalStability,
    complexity, incrementalValue, modelDiagnostics: best.model.diagnostics(), explanation: best.model.describe(),
    coefficientStability: [], probAudit,
    timeRange: { start: rows.length ? rows[0].eventTime : null, end: rows.length ? rows[rows.length - 1].eventTime : null },
    guards: { ...G }, status: 'OK',
  };
}

module.exports = { evaluateModel, incrementalValueStatus, incrementalStabilityVerdict, auditProbabilities, SEARCH_SPACE_VERSION, SMALL_BRIER };
