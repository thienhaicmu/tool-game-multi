'use strict';

// ---------------------------------------------------------------------------
// Feature-time registry — the HARD leakage gate for Forward Research V1.
//
// Every candidate feature declares the lifecycle STAGE at which its value first
// becomes genuinely known. A model evaluated at a given stage may consume ONLY
// features whose stage is <= the model stage. Everything realized during/after the
// multiplier climb (IN_ROUND / POST_ROUND) is forbidden as a predictor — it is the
// future relative to the decision timestamp. This registry is the single source of
// truth consumed by the dataset builder AND the machine-checkable leakage audit.
// ---------------------------------------------------------------------------

const STAGE = Object.freeze({ PRE_ROUND: 'PRE_ROUND', ROUND_OPEN: 'ROUND_OPEN', ROUND_LOCK: 'ROUND_LOCK', IN_ROUND: 'IN_ROUND', POST_ROUND: 'POST_ROUND' });
const STAGE_ORDER = Object.freeze({ PRE_ROUND: 0, ROUND_OPEN: 1, ROUND_LOCK: 2, IN_ROUND: 3, POST_ROUND: 4 });

// kind: 'current' (this round, early state) | 'prior' (shift(1) or rolling over PRIOR rounds) | 'time'
// A registry entry never references a CURRENT-round field realized after ROUND_LOCK.
const FEATURES = Object.freeze([
  // Current-round EARLY state (the only current-round values known pre-outcome).
  { name: 'jp_open', sourceField: 'jackpot_at_open', stage: STAGE.ROUND_OPEN, kind: 'current', missingPolicy: 'COMPLETE_CASE', reason: 'Jackpot value on the ROUND_OPEN frame; known at open.' },
  { name: 'jp_lock', sourceField: 'jackpot_at_lock', stage: STAGE.ROUND_LOCK, kind: 'current', missingPolicy: 'COMPLETE_CASE', reason: 'Jackpot value on the ROUND_LOCK frame; known only by lock.' },
  // PRIOR-round context (strictly completed rounds before the current one; shift(1)).
  { name: 'prev_max_odd', sourceField: 'max_odd', stage: STAGE.PRE_ROUND, kind: 'prior', shift: 1, missingPolicy: 'COMPLETE_CASE', reason: 'Previous completed round outcome; fully known before current open.' },
  { name: 'prev_reached_2x', sourceField: 'max_odd>=2', stage: STAGE.PRE_ROUND, kind: 'prior', shift: 1, missingPolicy: 'COMPLETE_CASE', reason: 'Previous round threshold; completed.' },
  { name: 'prev_jp_open', sourceField: 'jackpot_at_open', stage: STAGE.PRE_ROUND, kind: 'prior', shift: 1, missingPolicy: 'COMPLETE_CASE', reason: 'Previous round jackpot-at-open; completed.' },
  { name: 'prev_jp_delta', sourceField: 'jackpot_delta', stage: STAGE.PRE_ROUND, kind: 'prior', shift: 1, missingPolicy: 'COMPLETE_CASE', reason: 'Previous round jackpot delta; completed.' },
  { name: 'roll_mean_maxodd_5', sourceField: 'max_odd', stage: STAGE.PRE_ROUND, kind: 'prior', window: 5, agg: 'mean', missingPolicy: 'COMPLETE_CASE', reason: 'Mean maxOdd over the 5 rounds strictly before current (shift 1).' },
  { name: 'roll_rate2_10', sourceField: 'max_odd>=2', stage: STAGE.PRE_ROUND, kind: 'prior', window: 10, agg: 'rate', missingPolicy: 'COMPLETE_CASE', reason: 'reached-2x rate over the 10 prior rounds.' },
  { name: 'roll_jp_mean_10', sourceField: 'jackpot_at_open', stage: STAGE.PRE_ROUND, kind: 'prior', window: 10, agg: 'mean', missingPolicy: 'COMPLETE_CASE', reason: 'Mean prior jackpot-at-open over 10 prior rounds.' },
  { name: 'low_odd_streak', sourceField: 'max_odd<2', stage: STAGE.PRE_ROUND, kind: 'prior', agg: 'streak', missingPolicy: 'COMPLETE_CASE', reason: 'Trailing run of prior rounds with maxOdd<2 (excludes current).' },
  // TIME context (known at the round-open timestamp).
  { name: 'hour_sin', sourceField: 'opened_at_ms', stage: STAGE.ROUND_OPEN, kind: 'time', encoding: 'CYCLICAL', missingPolicy: 'COMPLETE_CASE', reason: 'Cyclical hour-of-day; known at open.' },
  { name: 'hour_cos', sourceField: 'opened_at_ms', stage: STAGE.ROUND_OPEN, kind: 'time', encoding: 'CYCLICAL', missingPolicy: 'COMPLETE_CASE', reason: 'Cyclical hour-of-day; known at open.' },
]);

// Current-round fields that are ONLY known after the outcome process — forbidden as predictors.
const FORBIDDEN_CURRENT_FIELDS = Object.freeze([
  'max_odd', 'last_odd', 'first_odd', 'jackpot_at_first_odd', 'jackpot_at_end', 'jackpot_min', 'jackpot_max',
  'jackpot_avg', 'jackpot_delta', 'duration_ms', 'ended_at_ms', 'odd_sample_count', 'jackpot_sample_count',
  'reached_', 'time_to_',
]);

const byName = new Map(FEATURES.map((f) => [f.name, f]));

// Features whose stage <= the model stage (forward-eligible for that stage).
function eligibleFeatures(modelStage) {
  const max = STAGE_ORDER[modelStage];
  if (max == null) throw new Error('unknown modelStage: ' + modelStage);
  return FEATURES.filter((f) => STAGE_ORDER[f.stage] <= max).map((f) => f.name);
}

// A feature is forward-eligible at a stage iff its declared stage is at/earlier than it.
function isForwardEligible(featureName, modelStage) {
  const f = byName.get(featureName); if (!f) return false;
  return STAGE_ORDER[f.stage] <= STAGE_ORDER[modelStage];
}

// Registry view (§3): featureName, sourceField, stageAvailable, forwardEligible@stage, reason.
function registryView(modelStage) {
  return FEATURES.map((f) => ({
    featureName: f.name, sourceField: f.sourceField, stageAvailable: f.stage,
    timestampSemantics: f.kind === 'prior' ? 'PRIOR_ROUND(shift1/rolling)' : (f.kind === 'time' ? 'ROUND_OPEN_TIMESTAMP' : 'CURRENT_EARLY_STATE'),
    missingPolicy: f.missingPolicy, forwardEligible: modelStage ? isForwardEligible(f.name, modelStage) : null, reason: f.reason,
  }));
}

module.exports = { STAGE, STAGE_ORDER, FEATURES, FORBIDDEN_CURRENT_FIELDS, byName, eligibleFeatures, isForwardEligible, registryView };
