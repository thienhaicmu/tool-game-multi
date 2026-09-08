'use strict';

const { runExperiment } = require('./experiment.cjs');
const reg = require('./feature-registry.cjs');

// Store-backed forward-research runner. READ-ONLY over the analytics rounds table.
// Loads COMPLETE rounds only (partial rounds have unreliable outcome/lifecycle) and
// exposes a stage×target result matrix + a data-snooping ledger. No prediction API.

const STAGES = [reg.STAGE.ROUND_OPEN, reg.STAGE.ROUND_LOCK];
const TARGETS = [
  { name: 'reached_2x', threshold: 2 },
  { name: 'reached_5x', threshold: 5 },
  { name: 'reached_10x', threshold: 10 },
];

class ForwardResearch {
  constructor({ store } = {}) { if (!store) throw new Error('ForwardResearch requires a store'); this._db = store.db; }

  _loadRounds(browserId) {
    const cols = 'browser_id, sid, sequence_number, opened_at_ms, ended_at_ms, max_odd, jackpot_at_open, jackpot_at_lock, jackpot_delta';
    if (browserId != null) return this._db.prepare(`SELECT ${cols} FROM rounds WHERE completeness='COMPLETE' AND browser_id=? ORDER BY browser_id, sequence_number`).all(String(browserId));
    return this._db.prepare(`SELECT ${cols} FROM rounds WHERE completeness='COMPLETE' ORDER BY browser_id, sequence_number`).all();
  }

  // One experiment (stage, target) over the loaded population.
  run({ modelStage, target, browserId = null }) {
    const rounds = this._loadRounds(browserId);
    return runExperiment({ rounds, modelStage, target });
  }

  // Full stage×target matrix + a data-snooping ledger (every model config tried + validation metric).
  matrix({ browserId = null } = {}) {
    const rounds = this._loadRounds(browserId);
    const cells = []; const ledger = [];
    for (const modelStage of STAGES) for (const target of TARGETS) {
      const r = runExperiment({ rounds, modelStage, target });
      cells.push({ modelStage, target: target.name, result: r });
      if (r.models) for (const [key, m] of Object.entries(r.models)) ledger.push({ modelStage, target: target.name, model: key, features: m.featureNames, l2: m.l2, validationBrier: m.validation ? m.validation.brier : null, selected: r.selected && r.selected.key === key });
    }
    return { mode: 'FORWARD_RESEARCH', population: { totalCompleteRounds: rounds.length, browserId }, stages: STAGES, targets: TARGETS.map((t) => t.name), cells, ledger, registry: reg.registryView(reg.STAGE.ROUND_LOCK) };
  }
}

module.exports = { ForwardResearch, STAGES, TARGETS };
