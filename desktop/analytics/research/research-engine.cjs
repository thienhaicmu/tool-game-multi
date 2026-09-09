'use strict';

const { evaluateFeatureSet } = require('../forward-research/experiment.cjs');
const { buildDataset } = require('../forward-research/dataset-builder.cjs');
const { chronoSplit } = require('../forward-research/split.cjs');
const { evaluateModel } = require('./model-engine.cjs');
const registry = require('./algorithm-registry.cjs');
const targets = require('./target-registry.cjs');
const fp = require('./fingerprint.cjs');

// ---------------------------------------------------------------------------
// Research engine — the product-level wrapper around the shared evaluation engines.
// Resolves a registered algorithm config, runs the SAME leakage-safe out-of-sample
// evaluation every algorithm goes through, and stamps the result with deterministic
// algorithm + dataset fingerprints plus policy versions. Pure compute: no persistence.
//
// DISPATCH (§18): linear/baseline families go through the V1 `evaluateFeatureSet`
// path (byte-for-byte unchanged, so V1 fingerprints/results never regress, §58);
// non-linear families (spline/tree) go through the multi-family `evaluateModel`,
// which reuses the SAME split / leakage / metrics / walk-forward / stability /
// conclusion scaffolding. Both yield the same normalized result shape.
// ---------------------------------------------------------------------------

const LEAKAGE_POLICY_VERSION = 1;
const QUALITY_POLICY_VERSION = 2;        // V2: adds incremental-value research decision atop V1 quality
const COMPARABILITY_POLICY_VERSION = 1;  // unchanged from V1 (same comparability keying)
const FINGERPRINT_POLICY_VERSION = fp.POLICY_VERSION;

const LINEAR_FAMILIES = new Set(['BASELINE', 'LOGISTIC_REGRESSION']);

// Cheap readiness assessment (§41) — counts only, no model fit. Uses the algorithm's
// FAMILY-specific guard, so a spline/tree cell can read INSUFFICIENT_DATA while a
// linear cell on the same rounds is READY. Honest statuses, never fabricated zeros.
function assessReadiness({ rounds, algorithmId, modelStage, targetId }) {
  const t = targets.engineTarget(targetId);
  if (!t) return { status: 'INVALID', reasons: ['UNKNOWN_TARGET'] };
  const a = registry.byId.get(algorithmId);
  if (!a) return { status: 'INVALID', reasons: ['UNKNOWN_ALGORITHM'] };
  const G = registry.familyGuard(a.family);
  const featureNames = registry.featureNamesFor(algorithmId, modelStage);
  const ds = buildDataset({ rounds, modelStage, featureNames, target: t });
  const split = chronoSplit(ds.rows);
  const pos = (rows) => rows.reduce((acc, r) => acc + r.target, 0);
  const trainPos = pos(split.train), valPos = pos(split.validation), testPos = pos(split.test);
  const reasons = [];
  if (split.train.length < G.MIN_TRAIN || split.test.length < G.MIN_TEST) reasons.push('INSUFFICIENT_DATA');
  if (trainPos < G.MIN_POS_PER_SET || (split.train.length - trainPos) < G.MIN_POS_PER_SET || testPos < G.MIN_POS_PER_SET) reasons.push('INSUFFICIENT_POSITIVES');
  const missing = ds.meta.missing || {};
  const anyFullyMissing = Object.values(missing).some((m) => m && m.missingRate === 1);
  if (anyFullyMissing) reasons.push('FEATURE_UNAVAILABLE');
  const status = reasons.length === 0 ? 'READY' : reasons[0];
  return {
    status, reasons, family: a.family,
    usableN: ds.rows.length, browsers: ds.meta.browsers, missingOutcome: ds.meta.missingOutcome,
    train: { n: split.train.length, positives: trainPos }, validation: { n: split.validation.length, positives: valPos }, test: { n: split.test.length, positives: testPos },
    trainDeficit: Math.max(0, G.MIN_TRAIN - split.train.length), testDeficit: Math.max(0, G.MIN_TEST - split.test.length),
    positiveDeficit: Math.max(0, G.MIN_POS_PER_SET - Math.min(trainPos, testPos)),
    missing, guards: { ...G },
  };
}

// Full evaluation of ONE registered algorithm at (stage, target) over `rounds`.
function evaluateAlgorithm({ rounds, algorithmId, modelStage, targetId, schemaVersion = null, browserScope = null }) {
  const cfg = registry.resolveConfig(algorithmId, modelStage, targetId);
  const t = targets.engineTarget(targetId);
  if (!t) return { status: 'INVALID', algorithmId, reasons: ['UNKNOWN_TARGET'] };

  const algoFp = fp.algorithmFingerprint(cfg);
  const spec = registry.resolveModelSpec(algorithmId, modelStage, targetId);

  let result;
  if (LINEAR_FAMILIES.has(cfg.family)) {
    // V1 path — unchanged numerics. Linear/baseline carry no incremental-value vs linear.
    result = evaluateFeatureSet({ rounds, modelStage, target: t, featureNames: cfg.featureNames, l2Grid: cfg.hyperparameters.l2Grid && cfg.hyperparameters.l2Grid.length ? cfg.hyperparameters.l2Grid : registry.L2_GRID });
    result.complexity = { params: cfg.featureNames.length + 1, features: cfg.featureNames.length, transforms: 0 };
    result.deltaBrierVsLinear = null;
    result.incrementalValue = 'N_A';
    result.searchSpaceVersion = 1;
    result.explanation = registry.byId.get(algorithmId).explanation;
  } else {
    // V2 multi-family path (spline / tree) — shared scaffolding + incremental value.
    result = evaluateModel({ rounds, modelStage, target: t, featureNames: spec.featureNames, kind: spec.kind, hyperparameters: spec.hyperparameters, guard: spec.guard });
  }

  // Dataset fingerprint from the eligible, leakage-safe rows actually used.
  const ds = buildDataset({ rounds, modelStage, featureNames: cfg.featureNames, target: t });
  const times = ds.rows.map((r) => r.eventTime).filter((x) => x != null);
  const datasetFp = fp.datasetFingerprint({
    schemaVersion, modelStage, target: targetId, browserScope,
    rowCount: ds.rows.length, browsers: ds.meta.browsers,
    earliest: times.length ? Math.min(...times) : null, latest: times.length ? Math.max(...times) : null,
    rowDigest: fp.rowIdentityDigest(ds.rows),
  });

  const leakageStatus = result.leakageAudit && result.leakageAudit.pass ? 'PASS' : 'FAIL';
  const experimentKey = 'exp_' + fp.sha({ algorithmFingerprint: algoFp, browserScope: browserScope == null ? 'ALL' : String(browserScope) }).slice(0, 24);

  return {
    algorithmId, algorithmName: cfg.name, family: cfg.family, kind: spec.kind, version: cfg.version,
    complexityClass: registry.COMPLEXITY_CLASS[cfg.family] || 'UNKNOWN',
    modelStage, target: targetId, browserScope,
    algorithmFingerprint: algoFp, datasetFingerprint: datasetFp, experimentKey,
    leakageStatus, leakagePolicyVersion: LEAKAGE_POLICY_VERSION, leakageChecks: result.leakageAudit ? result.leakageAudit.checks : null,
    qualityPolicyVersion: QUALITY_POLICY_VERSION, comparabilityPolicyVersion: COMPARABILITY_POLICY_VERSION, fingerprintPolicyVersion: FINGERPRINT_POLICY_VERSION,
    featureNames: cfg.featureNames, hyperparameters: cfg.hyperparameters, preprocessing: cfg.preprocessing, splitPolicy: cfg.splitPolicy, codeVersion: cfg.codeVersion,
    ...result,
  };
}

module.exports = { evaluateAlgorithm, assessReadiness, LEAKAGE_POLICY_VERSION, QUALITY_POLICY_VERSION, COMPARABILITY_POLICY_VERSION, FINGERPRINT_POLICY_VERSION };
