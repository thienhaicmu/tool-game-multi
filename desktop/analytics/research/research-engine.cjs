'use strict';

const { evaluateFeatureSet, GUARD } = require('../forward-research/experiment.cjs');
const { buildDataset } = require('../forward-research/dataset-builder.cjs');
const { chronoSplit } = require('../forward-research/split.cjs');
const registry = require('./algorithm-registry.cjs');
const targets = require('./target-registry.cjs');
const fp = require('./fingerprint.cjs');

// ---------------------------------------------------------------------------
// Research engine — the product-level wrapper around the shared forward-research
// engine. Resolves a registered algorithm config, runs the SAME leakage-safe
// out-of-sample evaluation every algorithm goes through, and stamps the result
// with deterministic algorithm + dataset fingerprints (§7/§9) plus a leakage
// policy version. Pure compute: no persistence here (that is the service's job).
// ---------------------------------------------------------------------------

const LEAKAGE_POLICY_VERSION = 1;

// Cheap readiness assessment (§28) — counts only, no model fit. Honest statuses,
// never fabricated zeros. Used by the UI before (or instead of) evaluating.
function assessReadiness({ rounds, algorithmId, modelStage, targetId }) {
  const t = targets.engineTarget(targetId);
  if (!t) return { status: 'INVALID', reasons: ['UNKNOWN_TARGET'] };
  const featureNames = registry.featureNamesFor(algorithmId, modelStage);
  const ds = buildDataset({ rounds, modelStage, featureNames, target: t });
  const split = chronoSplit(ds.rows);
  const pos = (rows) => rows.reduce((a, r) => a + r.target, 0);
  const trainPos = pos(split.train), valPos = pos(split.validation), testPos = pos(split.test);
  const reasons = [];
  if (split.train.length < GUARD.MIN_TRAIN || split.test.length < GUARD.MIN_TEST) reasons.push('INSUFFICIENT_DATA');
  if (trainPos < GUARD.MIN_POS_PER_SET || (split.train.length - trainPos) < GUARD.MIN_POS_PER_SET || testPos < GUARD.MIN_POS_PER_SET) reasons.push('INSUFFICIENT_POSITIVES');
  const missing = ds.meta.missing || {};
  const anyFullyMissing = Object.values(missing).some((m) => m && m.missingRate === 1);
  if (anyFullyMissing) reasons.push('FEATURE_UNAVAILABLE');
  const status = reasons.length === 0 ? 'READY' : reasons[0];
  return {
    status, reasons,
    usableN: ds.rows.length, browsers: ds.meta.browsers, missingOutcome: ds.meta.missingOutcome,
    train: { n: split.train.length, positives: trainPos }, validation: { n: split.validation.length, positives: valPos }, test: { n: split.test.length, positives: testPos },
    trainDeficit: Math.max(0, GUARD.MIN_TRAIN - split.train.length), testDeficit: Math.max(0, GUARD.MIN_TEST - split.test.length),
    positiveDeficit: Math.max(0, GUARD.MIN_POS_PER_SET - Math.min(trainPos, testPos)),
    missing, guards: { ...GUARD },
  };
}

// Full evaluation of ONE registered algorithm at (stage, target) over `rounds`.
// Returns a normalized result carrying identity, fingerprints, and the complete
// out-of-sample evidence. Pure — safe to call from read-only contexts.
function evaluateAlgorithm({ rounds, algorithmId, modelStage, targetId, schemaVersion = null, browserScope = null }) {
  const cfg = registry.resolveConfig(algorithmId, modelStage, targetId);
  const t = targets.engineTarget(targetId);
  if (!t) return { status: 'INVALID', algorithmId, reasons: ['UNKNOWN_TARGET'] };

  const algoFp = fp.algorithmFingerprint(cfg);
  const result = evaluateFeatureSet({ rounds, modelStage, target: t, featureNames: cfg.featureNames, l2Grid: cfg.hyperparameters.l2Grid && cfg.hyperparameters.l2Grid.length ? cfg.hyperparameters.l2Grid : registry.L2_GRID });

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
  // Experiment key: algorithm config + research scope. Re-running on more data is a
  // new RUN of the SAME experiment (different dataset fingerprint), never a silent overwrite.
  const experimentKey = 'exp_' + fp.sha({ algorithmFingerprint: algoFp, browserScope: browserScope == null ? 'ALL' : String(browserScope) }).slice(0, 24);

  return {
    algorithmId, algorithmName: cfg.name, family: cfg.family, version: cfg.version,
    modelStage, target: targetId, browserScope,
    algorithmFingerprint: algoFp, datasetFingerprint: datasetFp, experimentKey,
    leakageStatus, leakagePolicyVersion: LEAKAGE_POLICY_VERSION, leakageChecks: result.leakageAudit ? result.leakageAudit.checks : null,
    featureNames: cfg.featureNames, hyperparameters: cfg.hyperparameters, preprocessing: cfg.preprocessing, splitPolicy: cfg.splitPolicy, codeVersion: cfg.codeVersion,
    ...result,
  };
}

module.exports = { evaluateAlgorithm, assessReadiness, LEAKAGE_POLICY_VERSION };
