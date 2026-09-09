'use strict';

// ---------------------------------------------------------------------------
// Performance / base-rate drift monitoring (§35/§36/§74). Compares the latest
// evaluation run of an experiment with a prior run. Descriptive classification
// only — NEVER a wagering signal. Random small variation must NOT be called
// drift; thresholds are deliberately conservative. Base-rate (prevalence) change
// is always reported alongside metric change, because a model can look worse
// purely because the target prevalence shifted.
// ---------------------------------------------------------------------------

const THRESH = Object.freeze({
  BRIER: 0.01,      // out-of-sample Brier change considered material
  AUC: 0.03,        // discrimination change considered material
  PREVALENCE: 0.03, // base-rate change considered material
});

function delta(cur, prev) { return cur == null || prev == null ? null : cur - prev; }

// latest, previous: normalized run records (same experiment). previous may be null.
function assess(latest, previous) {
  if (!latest) return { status: 'INSUFFICIENT_DATA', previousEvaluation: 'NONE' };
  if (!previous) {
    return {
      status: 'INSUFFICIENT_DATA', previousEvaluation: 'NONE',
      latest: snap(latest), note: 'Chưa có lần đánh giá trước để so sánh biến động.',
    };
  }
  const dBrier = delta(latest.brier, previous.brier);       // lower Brier is better
  const dAuc = delta(latest.auc, previous.auc);
  const dPrev = delta(latest.prevalence, previous.prevalence);
  const dN = delta(latest.testN, previous.testN);

  const brierWorse = dBrier != null && dBrier > THRESH.BRIER;   // Brier increased materially
  const brierBetter = dBrier != null && dBrier < -THRESH.BRIER;
  const aucWorse = dAuc != null && dAuc < -THRESH.AUC;
  const aucBetter = dAuc != null && dAuc > THRESH.AUC;
  const stabilityDegraded = previous.stabilityStatus === 'STABLE' && (latest.stabilityStatus === 'UNSTABLE' || latest.stabilityStatus === 'MIXED');

  let status;
  if ((brierWorse && aucWorse) || (brierWorse && stabilityDegraded)) status = 'MATERIAL_DEGRADATION';
  else if (brierBetter && aucBetter) status = 'IMPROVEMENT';
  else if (brierWorse || aucWorse || stabilityDegraded) status = 'POSSIBLE_DRIFT';
  else status = 'NO_MATERIAL_CHANGE';

  return {
    status, previousEvaluation: 'PRESENT',
    deltas: { brier: dBrier, auc: dAuc, prevalence: dPrev, testN: dN },
    baseRate: { previous: previous.prevalence, current: latest.prevalence, delta: dPrev, materialShift: dPrev != null && Math.abs(dPrev) > THRESH.PREVALENCE },
    stability: { previous: previous.stabilityStatus, current: latest.stabilityStatus, degraded: stabilityDegraded },
    latest: snap(latest), previous: snap(previous),
    thresholds: THRESH,
  };
}

function snap(r) { return { runId: r.runId, evaluatedAtMs: r.evaluatedAtMs, datasetFingerprint: r.datasetFingerprint, testN: r.testN, brier: r.brier, auc: r.auc, prAuc: r.prAuc, prevalence: r.prevalence, deltaBrierTest: r.deltaBrierTest, stabilityStatus: r.stabilityStatus, quality: r.quality }; }

module.exports = { assess, THRESH };
