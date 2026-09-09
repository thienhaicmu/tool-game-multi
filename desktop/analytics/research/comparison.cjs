'use strict';

// ---------------------------------------------------------------------------
// Algorithm comparison engine (§38/§39/§41/§67). Fair side-by-side ONLY when
// results are comparable: same target, same model stage, same evaluation policy
// version, and the SAME data population (dataset fingerprint). Otherwise we refuse
// to rank and return NOT_DIRECTLY_COMPARABLE rather than mislead. No single-metric
// "winner" badge — the product surfaces plain deltas + multi-criteria quality.
// ---------------------------------------------------------------------------

// runs: normalized run records (from the repo) to compare. Returns groups that ARE
// directly comparable plus an explicit incompatibility verdict for the rest.
function compare(runs) {
  const valid = runs.filter((r) => r && r.leakageStatus === 'PASS' && r.status === 'OK');
  if (valid.length < 2) return { comparable: false, verdict: valid.length < 2 ? 'NEED_TWO_VALID_RUNS' : 'OK', rows: valid.map(row) };

  const key = (r) => `${r.target}|${r.modelStage}|${r.datasetFingerprint}|${r.leakagePolicyVersion}`;
  const first = key(valid[0]);
  const sameCell = valid.every((r) => key(r) === first);
  if (!sameCell) {
    const reasons = [];
    if (new Set(valid.map((r) => r.target)).size > 1) reasons.push('DIFFERENT_TARGET');
    if (new Set(valid.map((r) => r.modelStage)).size > 1) reasons.push('DIFFERENT_STAGE');
    if (new Set(valid.map((r) => r.datasetFingerprint)).size > 1) reasons.push('DIFFERENT_DATASET');
    if (new Set(valid.map((r) => r.leakagePolicyVersion)).size > 1) reasons.push('DIFFERENT_POLICY');
    return { comparable: false, verdict: 'NOT_DIRECTLY_COMPARABLE', reasons, rows: valid.map(row) };
  }
  // Directly comparable: plain deltas, sorted by Brier ascending as a VIEW ordering
  // only (not a quality ranking — quality is multi-criteria per run).
  const rows = valid.map(row).sort((a, b) => (a.brier == null ? 1 : b.brier == null ? -1 : a.brier - b.brier));
  return { comparable: true, verdict: 'OK', target: valid[0].target, modelStage: valid[0].modelStage, datasetFingerprint: valid[0].datasetFingerprint, rows };
}

function row(r) {
  return {
    runId: r.runId, algorithmId: r.algorithmId, algorithmName: r.algorithmName, family: r.family, version: r.version,
    target: r.target, modelStage: r.modelStage,
    testN: r.testN, testPositives: r.testPositives, auc: r.auc, prAuc: r.prAuc, brier: r.brier, deltaBrierTest: r.deltaBrierTest, logLoss: r.logLoss,
    calibrationMaxDiff: r.calibrationMaxDiff, stabilityStatus: r.stabilityStatus, leakageStatus: r.leakageStatus, quality: r.quality,
    evaluatedAtMs: r.evaluatedAtMs,
  };
}

module.exports = { compare };
