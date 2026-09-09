'use strict';

// ---------------------------------------------------------------------------
// Canonical prediction TARGET registry (§14). Targets are descriptive round
// outcomes derived ONLY from the completed round's max_odd — never from any
// user/bet/payout notion (hard non-goal, §1/§14). Each target declares its
// derivation and a minimum-sample policy. Rare thresholds (20x+) are defined
// but disabled by default so the platform never forces an underpowered cell.
// ---------------------------------------------------------------------------

const TARGETS = Object.freeze([
  { targetId: 'reached_2x', type: 'BINARY', threshold: 2, derivation: 'max_odd >= 2', positiveSemantics: 'round reached ≥2× multiplier', enabled: true, minPositives: 20 },
  { targetId: 'reached_5x', type: 'BINARY', threshold: 5, derivation: 'max_odd >= 5', positiveSemantics: 'round reached ≥5× multiplier', enabled: true, minPositives: 20 },
  { targetId: 'reached_10x', type: 'BINARY', threshold: 10, derivation: 'max_odd >= 10', positiveSemantics: 'round reached ≥10× multiplier', enabled: true, minPositives: 20 },
  { targetId: 'reached_20x', type: 'BINARY', threshold: 20, derivation: 'max_odd >= 20', positiveSemantics: 'round reached ≥20× multiplier', enabled: false, minPositives: 20 },
  { targetId: 'reached_50x', type: 'BINARY', threshold: 50, derivation: 'max_odd >= 50', positiveSemantics: 'round reached ≥50× multiplier', enabled: false, minPositives: 20 },
  { targetId: 'reached_100x', type: 'BINARY', threshold: 100, derivation: 'max_odd >= 100', positiveSemantics: 'round reached ≥100× multiplier', enabled: false, minPositives: 20 },
]);

const byId = new Map(TARGETS.map((t) => [t.targetId, t]));

function enabledTargets() { return TARGETS.filter((t) => t.enabled); }
function getTarget(id) { return byId.get(id) || null; }
// Shape expected by the forward-research engine/dataset-builder.
function engineTarget(id) { const t = byId.get(id); return t ? { name: t.targetId, threshold: t.threshold } : null; }

module.exports = { TARGETS, byId, enabledTargets, getTarget, engineTarget };
