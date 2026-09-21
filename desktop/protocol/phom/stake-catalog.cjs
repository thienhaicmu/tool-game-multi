'use strict';

const STAKE_LABELS = Object.freeze(['100', '500', '1K', '2K', '5K', '10K', '20K', '50K', '100K']);
// No captured bet-ID mapping exists yet. An empty catalog is intentional:
// channel IDs and monetary amounts must not be substituted for bet IDs.
const PHOM_STAKES = Object.freeze([]);
class StakeCatalog {
  constructor(entries = PHOM_STAKES) {
    this.entries = entries.map((e) => {
      if (!e || typeof e.id !== 'string' || !e.id.trim() || /[<>]/.test(e.id) || !STAKE_LABELS.includes(e.label) || !e.evidence) {
        throw new TypeError('STAKE_MAPPING_UNVERIFIED');
      }
      return Object.freeze({ id: e.id, label: e.label, evidence: String(e.evidence) });
    });
    if (new Set(this.entries.map((e) => e.id)).size !== this.entries.length || new Set(this.entries.map((e) => e.label)).size !== this.entries.length) throw new TypeError('DUPLICATE_STAKE');
    Object.freeze(this.entries);
  }
  list() { return this.entries.map(({ id, label }) => ({ id, label })); }
  get(betId) { return this.entries.find((e) => e.id === betId) || null; }
}
module.exports = { StakeCatalog, PHOM_STAKES, STAKE_LABELS };
