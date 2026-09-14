'use strict';

// ---------------------------------------------------------------------------
// PHỎM OFFLINE REALTIME SIMULATOR (QA/OFFLINE ONLY — §7-§11).
//
// A deterministic, event-by-event REPLAY engine. "Realtime" here means the
// derived state (hand, melds, eat candidates, counters) is recomputed and a new
// immutable snapshot is published AFTER EVERY event — NOT a live connection.
//
// HARD BOUNDARY (§7/§17): this module imports ONLY the pure Phỏm primitives —
// the card codec, the frame classifier, the hand reducer and the offline rule
// analyzer. It has NO browser launcher, NO CDP connector, NO WebSocket sender,
// NO proxy transport, NO live coordinator and NO credentials. It NEVER opens a
// socket. The offline guard (assertOffline) is re-checked on construction and on
// every mutating step, so a live browser / session / endpoint refuses the engine
// with PHOM_ANALYZER_OFFLINE_ONLY even if a caller tries to reuse it.
//
// It reuses the SINGLE existing codec + reducer (no second stack, §9).
// ---------------------------------------------------------------------------

const { isValidCardCode, decodeCards, sortCardCodes } = require('./card-codec.cjs');
const { classifyPhomFrame, CMD, CMD_TYPE } = require('./phom-frame-classify.cjs');
const { reduceHand, emptyHand, SYNC } = require('./hand-reducer.cjs');
const {
  ALLOWED_SOURCE_KINDS,
  assertOffline,
  findMelds,
  validateServerMelds,
  discardFormsPhom,
  analyzeConsistency,
} = require('./offline-analyzer.cjs');

const DECK_SIZE = 52;

// Eat-candidate classification enums (§10). Exact spec strings.
const EAT = Object.freeze({
  EATABLE: 'EATABLE_BY_SIMULATED_PLAYER',
  NOT_EATABLE: 'NOT_EATABLE_BY_SIMULATED_OTHERS',
  UNKNOWN: 'UNKNOWN',
});

// Command -> canonical number, for the 850-854 timeline. Derived from the shared
// classifier so it can never drift from the reducer.
const TYPE_TO_CMD = Object.freeze({ DEAL: CMD.DEAL, PLAY: CMD.PLAY, DRAW: CMD.DRAW, ROUND_END: CMD.END, MELD: CMD.MELD });

function offlineOnly() {
  return { ok: false, error: { code: 'PHOM_ANALYZER_OFFLINE_ONLY', message: 'The offline simulator only runs in an offline QA context (no live browser, no network).' } };
}

// Normalize one dataset entry into { seq, descriptor }. Accepts a raw wire string,
// { raw }, { frame } (array) or { descriptor } (pre-classified, for fixtures/tests).
// Never throws — a malformed entry becomes an UNKNOWN descriptor that mutates nothing.
function normalizeEnvelope(entry, index) {
  let seq = index;
  let descriptor = null;
  let rawText = null;
  if (typeof entry === 'string') {
    rawText = entry;
  } else if (entry && typeof entry === 'object') {
    if (Number.isFinite(entry.seq)) seq = Number(entry.seq);
    if (entry.descriptor && typeof entry.descriptor === 'object') descriptor = entry.descriptor;
    else if (typeof entry.raw === 'string') rawText = entry.raw;
    else if (Array.isArray(entry.frame)) rawText = JSON.stringify(entry.frame);
  }
  if (!descriptor) descriptor = classifyPhomFrame(rawText == null ? '' : rawText);
  return { seq, descriptor, rawText };
}

// A frozen, defensive-copied snapshot. Immutable so the UI/tests can hold prior
// snapshots without them mutating under a subsequent step (§8.11).
function freezeSnapshot(s) {
  return Object.freeze({
    ...s,
    hand: Object.freeze({ ...s.hand, cards: Object.freeze([...s.hand.cards]), sorted: Object.freeze([...s.hand.sorted]) }),
    serverMelds: Object.freeze(s.serverMelds.map((m) => Object.freeze({ ...m, cards: Object.freeze([...m.cards]) }))),
    derivedMelds: Object.freeze(s.derivedMelds.map((m) => Object.freeze({ ...m, cards: Object.freeze([...m.cards]) }))),
    cardsNotInMeld: Object.freeze([...(s.cardsNotInMeld || [])]),
    publicDiscards: Object.freeze(s.publicDiscards.map((d) => Object.freeze({ ...d }))),
    publicMelds: Object.freeze(s.publicMelds.map((m) => Object.freeze({ ...m, cards: Object.freeze([...m.cards]) }))),
    eatCandidates: Object.freeze(s.eatCandidates.map((c) => Object.freeze({ ...c }))),
    timeline: Object.freeze(s.timeline.map((t) => Object.freeze({ ...t }))),
    counters: Object.freeze({ ...s.counters }),
    labels: Object.freeze({ ...(s.labels || {}) }),
    consistency: Object.freeze({ ...s.consistency, warnings: Object.freeze([...(s.consistency.warnings || [])]) }),
  });
}

class PhomOfflineSimulator {
  /**
   * @param {object} opts
   *   events: dataset (array of envelopes / raw strings / descriptors)
   *   simulatedOwnerUid: uid of the SIMULATED player whose hand is authoritative
   *   sourceKind: one of ALLOWED_SOURCE_KINDS (TEST_FIXTURE|REDACTED_REPLAY|LOCAL_SIMULATOR)
   *   context: extra offline-guard context (networkEnabled/liveRunCount/liveSessionId/endpoint/clusterActive)
   */
  constructor({ events = [], simulatedOwnerUid = null, sourceKind = 'TEST_FIXTURE', context = {} } = {}) {
    this._ctx = { ...context, sourceKind, networkEnabled: context.networkEnabled === true };
    const blocked = this._guard();
    if (blocked) { this._blocked = blocked; return; }
    this._blocked = null;
    this._ownerUid = simulatedOwnerUid != null ? String(simulatedOwnerUid) : null;
    this._sourceKind = sourceKind;
    this._events = (Array.isArray(events) ? events : []).map((e, i) => normalizeEnvelope(e, i));
    this._cursor = 0; // number of events applied
    this._snapshot = this._recomputeTo(0);
  }

  // Re-check the offline boundary (§7). Returns a blocked result or null.
  _guard() {
    // clusterActive is an extra Phỏm axis (§7); map it onto liveRunCount so the
    // shared analyzer guard treats an active cluster as a live context too.
    const ctx = { ...this._ctx };
    if (ctx.clusterActive === true && !(Number(ctx.liveRunCount) > 0)) ctx.liveRunCount = 1;
    const blocked = assertOffline(ctx);
    return blocked ? offlineOnly() : null;
  }

  ok() { return !this._blocked; }
  blockedResult() { return this._blocked; }
  total() { return this._events ? this._events.length : 0; }
  cursor() { return this._cursor; }
  allowedSources() { return [...ALLOWED_SOURCE_KINDS]; }

  // --- deterministic transport controls (§8) ---
  reset() { return this._seek(0); }
  next() { return this._seek(this._cursor + 1); }
  previous() { return this._seek(this._cursor - 1); }
  stepTo(index) { return this._seek(Number(index)); }
  end() { return this._seek(this.total()); }

  snapshot() { return this._snapshot; }

  _seek(target) {
    const blocked = this._guard();
    if (blocked) return blocked;
    const clamped = Math.max(0, Math.min(this.total(), Number.isFinite(target) ? Math.trunc(target) : 0));
    this._cursor = clamped;
    this._snapshot = this._recomputeTo(clamped);
    return this._snapshot;
  }

  // Deterministic: replay events[0..count-1] from a fresh state every time. This
  // guarantees previous()/stepTo() land on EXACTLY the same state as forward play.
  _recomputeTo(count) {
    let hand = emptyHand(null, this._ownerUid);
    const publicDiscards = []; // { uid, card, seq } discarded by ANY player this round
    let publicMelds = [];
    const timeline = [];

    for (let i = 0; i < count; i++) {
      const env = this._events[i];
      const d = env.descriptor || {};
      const cmd = TYPE_TO_CMD[d.type] || (d.cmd != null ? d.cmd : null);
      const prevSeq = hand.lastAppliedSeq;
      // §8.3 sequence validation + §8.4 dedup (reducer enforces seq monotonicity).
      const duplicateOrLate = Number.isFinite(env.seq) && env.seq <= prevSeq;

      // Round reset (§9): a DEAL clears the per-round public pile before applying.
      if (d.type === 'DEAL' && !duplicateOrLate) { publicDiscards.length = 0; publicMelds = []; }

      // §8.5 apply the SINGLE shared reducer (per-profile, own uid authoritative).
      const before = hand;
      hand = reduceHand(hand, d, { profileUid: this._ownerUid, seq: env.seq });
      const applied = hand !== before || (d.type === 'DRAW' && before !== hand);
      const changed = hand.revision !== before.revision;

      // Accumulate public evidence for eat analysis (§8.8) from what we just applied.
      if (changed && d.type === 'PLAY' && d.fP && d.fP.dCs != null && isValidCardCode(d.fP.dCs)) {
        publicDiscards.push({ uid: d.fP.uid != null ? String(d.fP.uid) : null, card: d.fP.dCs, seq: env.seq });
      }
      if (changed && d.type === 'MELD' && Array.isArray(hand.publicMelds)) publicMelds = hand.publicMelds;

      timeline.push({
        index: i,
        seq: env.seq,
        cmd,
        command: cmd, // alias
        type: d.type || 'UNKNOWN',
        label: (cmd != null && CMD_TYPE[cmd]) ? CMD_TYPE[cmd] : (d.type || 'UNKNOWN'),
        applied: changed && !duplicateOrLate,
        duplicateOrLate,
        reason: duplicateOrLate ? 'DUPLICATE_OR_OUT_OF_ORDER' : (changed ? 'APPLIED' : 'NO_EFFECT'),
      });
    }

    return this._buildSnapshot(hand, publicDiscards, publicMelds, timeline, count);
  }

  _buildSnapshot(hand, publicDiscards, publicMelds, timeline, count) {
    const authoritative = hand.authoritative === true && hand.syncState !== SYNC.EMPTY;
    const handCards = Array.isArray(hand.cardsRaw) ? hand.cardsRaw.filter(isValidCardCode) : [];

    // §8.6 server meld validation (from the authoritative sMs the reducer stored).
    const serverEval = validateServerMelds(hand.serverMelds || [], this._ctx);
    const serverMelds = (serverEval && serverEval.ok) ? serverEval.melds : [];

    // §8.7 derived melds recomputed from the authoritative hand.
    const derivedMelds = authoritative ? findMelds(handCards) : [];
    // §19 ROW 1 — the cards that do NOT form any phỏm: the complement of the UNION of all
    // derived meld cards. Computed HERE (engine, tested) so the renderer never recomputes
    // or hard-codes it. Empty when the hand is not authoritative (UNKNOWN in the UI).
    const derivedMeldCardSet = new Set(derivedMelds.flatMap((m) => m.cards));
    const cardsNotInMeld = authoritative ? sortCardCodes(handCards.filter((c) => !derivedMeldCardSet.has(c))) : [];

    // §8.8/§8.9 eat candidates over the public discard pile (non-owner discards).
    const eatCandidates = this._eatCandidates(handCards, authoritative, publicDiscards);
    let eatable = 0, notEatable = 0, eatUnknown = 0;
    for (const c of eatCandidates) {
      if (c.status === EAT.EATABLE) eatable++;
      else if (c.status === EAT.NOT_EATABLE) notEatable++;
      else eatUnknown++;
    }

    // Unique meld-card count across server ∪ derived — never double counted (§10).
    const meldCardSet = new Set();
    for (const m of serverMelds) for (const c of m.cards) meldCardSet.add(c);
    for (const m of derivedMelds) for (const c of m.cards) meldCardSet.add(c);

    // §8.10 consistency: only the authoritative known hand + cards that PHYSICALLY
    // left a hand (public discards) feed this, so no hidden-hand inference (§17).
    // The owner's own public melds (854) are a VISIBILITY overlay of cards still held
    // in the authoritative hand — including them would double-count as duplicates, so
    // they are deliberately excluded. DESYNCED is surfaced as a consistency error.
    const publicCards = publicDiscards.map((d) => d.card);
    const consistency = analyzeConsistency({ knownHands: authoritative ? [handCards] : [], publicCards, deckSize: DECK_SIZE }, this._ctx) || {};
    const warnings = [];
    if (consistency.DUPLICATE_CARD_ERROR) warnings.push(`DUPLICATE_CARD (${consistency.DUPLICATE_CARD_ERROR.count})`);
    if (consistency.CARD_CONSERVATION_ERROR) warnings.push('CARD_CONSERVATION');
    if (consistency.INVALID_CARD_ERROR) warnings.push(`INVALID_CARD (${consistency.INVALID_CARD_ERROR.count})`);
    if (hand.syncState === SYNC.DESYNCED) warnings.push('HAND_DESYNCED');
    const consistencyErrorCount = warnings.length;

    const decoded = handCards.length ? safeDecode(handCards) : [];

    // Display label map for EVERY referenced code, so the renderer never needs its
    // own codec (single source of truth stays in card-codec.cjs, §9).
    const labels = {};
    const addLabels = (codes) => { for (const code of (codes || [])) { if (isValidCardCode(code) && labels[code] == null) { const d = safeDecode([code])[0]; if (d) labels[code] = d; } } };
    addLabels(handCards);
    for (const m of serverMelds) addLabels(m.cards);
    for (const m of derivedMelds) addLabels(m.cards);
    addLabels(publicDiscards.map((d) => d.card));
    for (const m of publicMelds) addLabels(m.cards);
    addLabels(eatCandidates.map((c) => c.card));

    const counters = {
      currentEvent: count,
      totalEvents: this.total(),
      roundIdentity: hand.roundIdentity,
      authoritativeHandCount: authoritative ? handCards.length : 0,
      serverMeldCount: serverMelds.length,
      derivedMeldCount: derivedMelds.length,
      uniqueMeldCardCount: meldCardSet.size,
      meldCombinationCount: serverMelds.length + derivedMelds.length,
      eatableCount: eatable,
      notEatableCount: notEatable,
      unknownCount: eatUnknown,
      unknownCardCount: consistency.UNKNOWN_CARD_COUNT != null ? consistency.UNKNOWN_CARD_COUNT : DECK_SIZE,
      consistencyErrorCount,
    };

    return freezeSnapshot({
      ok: true,
      sourceKind: this._sourceKind,
      simulatedOwnerUid: this._ownerUid,
      networkLocked: true,
      browserConnected: false,
      cursor: count,
      roundIdentity: hand.roundIdentity,
      roundSeq: hand.roundSeq,
      syncState: hand.syncState,
      authoritative,
      lastCommand: hand.sourceCommand,
      currentTurnUid: hand.currentTurnUid,
      hand: { cards: handCards, sorted: sortCardCodes(handCards), decoded, count: handCards.length },
      serverMelds,
      derivedMelds,
      cardsNotInMeld,
      publicDiscards,
      publicMelds,
      eatCandidates,
      timeline,
      counters,
      labels,
      consistency: { ...consistency, warnings },
    });
  }

  // Classify each distinct public discard by a NON-owner player from the simulated
  // owner's perspective. NEVER concludes NOT_EATABLE unless the owner hand is
  // authoritative (§10) — otherwise the candidate is UNKNOWN.
  _eatCandidates(handCards, authoritative, publicDiscards) {
    const seen = new Set();
    const out = [];
    for (const d of publicDiscards) {
      if (d.uid != null && this._ownerUid != null && d.uid === this._ownerUid) continue; // own discard is not a candidate to eat
      if (!isValidCardCode(d.card) || seen.has(d.card)) continue;
      seen.add(d.card);
      let status = EAT.UNKNOWN;
      if (authoritative) {
        const r = discardFormsPhom(handCards, d.card, this._ctx);
        status = (r && r.ok && r.forms) ? EAT.EATABLE : EAT.NOT_EATABLE;
      }
      out.push({ card: d.card, uid: d.uid, status });
    }
    return out;
  }
}

function safeDecode(codes) {
  try { return decodeCards(codes).map((c) => ({ code: c.code, label: c.label, rank: c.rank, suit: c.suit, color: c.color })); }
  catch { return []; }
}

module.exports = { PhomOfflineSimulator, EAT, DECK_SIZE, normalizeEnvelope };
