'use strict';

// ---------------------------------------------------------------------------
// PHỎM SIMULATOR CONTROLLER (OFFLINE / MÔ PHỎNG). A thin state store that takes the
// NORMALISED controlled hands (A/B/C card codes) + public cards/melds — produced by the
// EXISTING pipeline (card-codec + hand-reducer + offline-analyzer), no second parser — and
// publishes an immutable snapshot for the simulator UI:
//   CONTROLLED CARDS · UNKNOWN POOL · SAFE DISCARDS · THREAT ANALYSIS
//
// It runs the analysis ONLY on simulated / replay / fixture data (offline source kind). It
// never subscribes to a live socket, never sends a gameplay action, and never derives hidden
// opponent cards to act — it is a MONITOR/ANALYSIS store only. Round change clears prior state;
// a missing/partial/stale hand yields INCOMPLETE (no analysis on incomplete data).
// ---------------------------------------------------------------------------

const { isValidCardCode, decodeCard, sortCardCodes } = require('./card-codec.cjs');
const { analyzeSafeDiscards } = require('./offline-analyzer.cjs');

const STATUS = Object.freeze({ WAITING: 'WAITING_FOR_COMPLETE_HAND', INCOMPLETE: 'INCOMPLETE', INVALID: 'SIMULATOR_DATA_INVALID', READY: 'READY' });
const MODE = Object.freeze({ OFFLINE: 'OFFLINE', LIVE_MONITOR: 'LIVE_MONITOR' });
const SLOTS = Object.freeze(['A', 'B', 'C']);

function labelsFor(cards) { return cards.filter(isValidCardCode).map((c) => decodeCard(c).label); }
function freeze(o) { return Object.freeze(JSON.parse(JSON.stringify(o))); }

class PhomSimulatorController {
  constructor({ mode = MODE.OFFLINE, expectedHandSize = 9, now = () => Date.now() } = {}) {
    this._mode = mode; this._expected = expectedHandSize; this._now = now;
    this._round = null; this._version = 0;
    this._p = { A: null, B: null, C: null }; // { uid, cards, stale, at }
    this._public = []; this._publicMelds = [];
    this._snapshot = this._compute();
  }
  mode() { return this._mode; }
  version() { return this._version; }

  // §14 — a new round clears ALL prior state so cards from different rounds are never mixed.
  setRound(round) {
    if (round === this._round) return this._snapshot;
    this._round = round; this._p = { A: null, B: null, C: null }; this._public = []; this._publicMelds = [];
    return this._bump();
  }
  // ingest ONE controlled profile's authoritative hand (already decoded to card codes upstream).
  setHand(slot, { uid = null, cards = [] } = {}) {
    if (!SLOTS.includes(slot)) return this._snapshot;
    this._p[slot] = { uid: uid != null ? String(uid) : null, cards: Array.isArray(cards) ? cards.slice() : [], stale: false, at: this._now() };
    return this._bump();
  }
  setPublic({ cards = [], melds = [] } = {}) { this._public = Array.isArray(cards) ? cards.slice() : []; this._publicMelds = Array.isArray(melds) ? melds.slice() : []; return this._bump(); }
  // §15 — a stale / disconnected controlled account is flagged; analysis becomes INCOMPLETE.
  markStale(slot, stale = true) { if (this._p[slot]) { this._p[slot].stale = !!stale; return this._bump(); } return this._snapshot; }
  clear(slot) { if (SLOTS.includes(slot)) { this._p[slot] = null; return this._bump(); } return this._snapshot; }

  snapshot() { return this._snapshot; }
  _bump() { this._version++; this._snapshot = this._compute(); return this._snapshot; }

  _compute() {
    const at = this._now();
    const controlled = {};
    let present = 0, complete = 0, anyStale = false, invalid = false;
    for (const s of SLOTS) {
      const p = this._p[s];
      if (!p) { controlled[s] = { uid: null, count: 0, cards: [], labels: [], stale: false, present: false }; continue; }
      present++;
      const valid = p.cards.filter(isValidCardCode);
      if (valid.length !== p.cards.length) invalid = true;
      if (p.stale) anyStale = true;
      controlled[s] = { uid: p.uid, count: p.cards.length, cards: sortCardCodes(valid), labels: labelsFor(valid), stale: p.stale, present: true };
      if (!p.stale && valid.length === p.cards.length && p.cards.length >= this._expected) complete++;
    }
    // conservation: no card appears twice across hands + public
    const all = []; for (const s of SLOTS) { const p = this._p[s]; if (p) for (const c of p.cards) all.push(c); } for (const c of this._public) all.push(c);
    const counts = new Map(); for (const c of all) counts.set(c, (counts.get(c) || 0) + 1);
    const dup = [...counts.entries()].filter(([, n]) => n > 1).map(([c]) => c);

    let status, analysis = null;
    if (invalid || dup.length) status = STATUS.INVALID;
    else if (present === 0) status = STATUS.WAITING;
    else if (anyStale || complete < present) status = STATUS.INCOMPLETE;
    else {
      const hands = SLOTS.map((s) => this._p[s]).filter((p) => p && !p.stale && p.cards.length).map((p) => p.cards);
      const r = analyzeSafeDiscards({ controlledHands: hands, publicCards: this._public, publicMelds: this._publicMelds }, { sourceKind: 'LOCAL_SIMULATOR', networkEnabled: false, liveRunCount: 0 });
      if (!r.ok) { status = STATUS.INVALID; } else { status = STATUS.READY; analysis = r; }
    }
    return freeze({
      mode: this._mode, round: this._round, version: this._version, at,
      controlled, publicCount: this._public.length, publicMeldCount: this._publicMelds.length,
      status, duplicateCards: dup.length ? sortCardCodes(dup) : null,
      analysis: analysis ? { UNKNOWN_COUNT: analysis.UNKNOWN_COUNT, UNKNOWN_POOL: analysis.UNKNOWN_POOL, SAFE_DISCARDS: analysis.SAFE_DISCARDS, DANGEROUS_DISCARDS: analysis.DANGEROUS_DISCARDS, OPPONENT_PHOM_CARDS: analysis.OPPONENT_PHOM_CARDS, candidates: analysis.candidates } : null,
    });
  }
}

module.exports = { PhomSimulatorController, STATUS, MODE };
