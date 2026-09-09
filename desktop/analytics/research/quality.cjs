'use strict';

// ---------------------------------------------------------------------------
// Conservative algorithm QUALITY status (§40/§76). NEVER derived from one metric.
// Considers: leakage validity, sample sufficiency, out-of-sample improvement over
// baseline (Δ Brier), temporal stability, and calibration. When evidence conflicts
// (e.g. high AUC but negative Δ Brier, or unstable folds) we prefer the CONSERVATIVE
// status. This is a research descriptor, not a recommendation to act.
// ---------------------------------------------------------------------------

const MATERIAL_BRIER = 0.01;   // Δ Brier ≥ this, out of sample, is a "material" improvement
const SMALL_BRIER = 5e-4;      // below this Δ Brier is negligible
const POOR_CALIB = 0.15;       // max calibration bin diff above this is poor calibration

// result: a normalized run record OR an evaluateAlgorithm() result.
function qualityStatus(result) {
  if (!result) return { status: 'NOT_EVALUATED', reasons: [] };
  if (result.leakageStatus && result.leakageStatus !== 'PASS') return { status: 'INVALID', reasons: ['LEAKAGE_FAILED'] };
  if (result.status && result.status !== 'OK') return { status: 'INSUFFICIENT_DATA', reasons: [result.status] };

  const dBrier = result.deltaBrierTest;
  const stability = result.stabilityStatus || (result.stability && result.stability.status) || null;
  const calibMax = result.calibrationMaxDiff != null ? result.calibrationMaxDiff
    : (result.conclusion && result.conclusion.calibrationMaxDiff != null ? result.conclusion.calibrationMaxDiff : null);

  const reasons = [];
  // Improvement is gated on Δ Brier (a PROPER scoring rule) out of sample. Ranking
  // ability (AUC) alone — or worse, a NEGATIVE Δ Brier — can never earn an
  // "improvement" label, no matter how high AUC looks (§24/§76 conservatism).
  const negligible = dBrier == null || dBrier <= SMALL_BRIER;
  if (negligible) { reasons.push('NO_OUT_OF_SAMPLE_IMPROVEMENT'); return { status: 'NO_IMPROVEMENT', reasons }; }

  // From here Δ Brier is a positive improvement; stability + calibration decide quality.
  const unstable = stability === 'UNSTABLE' || stability === 'MIXED';
  const poorCalib = calibMax != null && calibMax > POOR_CALIB;
  if (unstable) { reasons.push('TEMPORAL_INSTABILITY'); return { status: 'SMALL_UNSTABLE_IMPROVEMENT', reasons }; }
  if (poorCalib) { reasons.push('POOR_CALIBRATION'); return { status: 'SMALL_UNSTABLE_IMPROVEMENT', reasons }; }

  const material = dBrier >= MATERIAL_BRIER;
  if (material && stability === 'STABLE') return { status: 'MATERIAL_STABLE_IMPROVEMENT', reasons };
  return { status: 'SMALL_STABLE_IMPROVEMENT', reasons };
}

// Conservative RESEARCH DECISION for an advanced (non-linear) candidate (§25/§51).
// Layered on top of quality: it answers "does this complex family add stable value
// BEYOND the simple linear model?" — never a wagering instruction. Linear/baseline
// algorithms are not advanced candidates and return N_A. The incremental-value status
// itself is computed by the engine (vs the reference linear model on the same split);
// here we only gate it on validity/readiness.
const QUALITY_POLICY_VERSION = 2;

function researchDecision(result) {
  if (!result) return 'NOT_READY';
  if (result.leakageStatus && result.leakageStatus !== 'PASS') return 'INVALID';
  if (result.status && result.status !== 'OK') return 'NOT_READY';
  const fam = result.family;
  if (fam === 'BASELINE' || fam === 'LOGISTIC_REGRESSION') return 'N_A';
  const iv = result.incrementalValue;
  if (!iv || iv === 'N_A' || iv === 'NOT_READY') return 'NOT_READY';
  return iv; // NO_INCREMENTAL_VALUE | POSSIBLE_INCREMENTAL_VALUE | STABLE_INCREMENTAL_VALUE | UNSTABLE
}

module.exports = { qualityStatus, researchDecision, MATERIAL_BRIER, SMALL_BRIER, POOR_CALIB, QUALITY_POLICY_VERSION };
