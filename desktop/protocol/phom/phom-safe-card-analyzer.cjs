'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.3.3 — MONITOR / SAFE CARD ANALYZER (pure, deterministic, READ-ONLY).
//
// Consumes ONLY a CardObserver snapshot (never a WebSocket, never a frame, never
// its own ledger — §4). It analyses ONE selected target player's OWN observed hand
// against the PUBLIC observation (discards, melds, remaining) and classifies each
// of the target's cards for how safe it is to DISCARD (Phỏm "an toàn"). It NEVER
// plays, sends, clicks or returns an action (§2/§18) — the user decides.
//
// Certainty boundary (§8/§9/§13): opponents' HIDDEN hands and their DRAWN cards are
// UNKNOWN. A card is only KNOWN_SAFE when the observed public data PROVES no player
// can eat it. Otherwise it is LIKELY_SAFE (public signals reduce risk) or UNKNOWN.
// An unseen card is treated as POSSIBLY in a hidden hand — never assumed safe (§27).
//
// Card model is REUSED from card-codec.cjs (no new rank/suit mapping, §11):
//   rankIndex = floor(code/4) in 0..12 (A..K, A low) · suitIndex = code%4 in 0..3.
// A Phỏm meld is 3+ SAME-RANK (distinct suits) or 3+ SAME-SUIT CONSECUTIVE ranks.
// An opponent "eats" a discard X by holding 2 cards that complete a meld with X.
// ---------------------------------------------------------------------------

const { decodeCard, encodeCard, isValidCardCode, MIN_CODE, MAX_CODE } = require('./card-codec.cjs');

// Classifications (§8/§13). SAFE is the ONLY "proven" label; nothing is ever labelled
// SAFE merely because it has not been seen (§27).
const CLASS = Object.freeze({ SAFE: 'SAFE', LIKELY_SAFE: 'LIKELY_SAFE', UNKNOWN: 'UNKNOWN', RISKY: 'RISKY' });

// Result statuses so the UI can render an honest empty/limited state (§24).
const STATUS = Object.freeze({
  OK: 'OK',
  NO_TARGET: 'NO_TARGET',             // no player selected yet
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND', // selected uid absent from the snapshot
  NO_HAND: 'NO_HAND',                 // target present but no own cards observed yet
});

const rankOf = (code) => decodeCard(code).rankIndex;
const suitOf = (code) => decodeCard(code).suitIndex;
const view = (code) => { const d = decodeCard(code); return { code, label: d.label, rank: d.rank, suit: d.suit, color: d.color }; };

// Meld partner geometry comes from the shared rules module (one implementation of the Phỏm rules).
const { rankPartners, runWindows, cardsInMelds, cardPoints } = require('./phom-rules.cjs');

class SafeCardAnalyzer {
  constructor() { this._last = null; this._key = null; }

  reset() { this._last = null; this._key = null; }
  getAnalysis() { return this._last; }
  getSafeCards() { return this._last ? this._last.safeCards.slice() : []; }

  // analyze({ snapshot, targetPlayerUid }) -> a fresh, read-only result. Pure: the same snapshot + target
  // always yields the same output (§15). Never mutates the snapshot. Memoised by a content fingerprint so
  // repeated identical calls (live re-render) are cheap (§29) — no polling, no timers.
  analyze({ snapshot, targetPlayerUid } = {}) {
    const snap = snapshot || null;
    const targetUid = targetPlayerUid != null ? String(targetPlayerUid) : null;
    const key = fingerprint(snap, targetUid);
    if (this._last && this._key === key) return this._last;
    const result = compute(snap, targetUid);
    this._last = result; this._key = key;
    return result;
  }
}

// ---- pure computation ----
function compute(snap, targetUid) {
  const caps = { otherPlayerHand: false, otherPlayerDrawnCard: false }; // §9 — the certainty boundary
  const base = {
    targetPlayerUid: targetUid, targetPlayerLabel: null, targetSlot: null,
    status: STATUS.NO_TARGET,
    targetCards: [], safeCards: [], likelySafeCards: [], unknownCards: [], riskyCards: [],
    ownMeldCards: [], laidCards: [], recommendedCode: null, ownMeldSource: null,
    nextPlayerUid: null, nextPlayerLabel: null,
    reasons: [], roundSeq: snap ? snap.roundSeq : 0, observedAt: snap ? snap.startedAt : null,
    capabilities: caps,
    transparency: 'Phân tích từ dữ liệu công khai đã quan sát',
  };
  if (!snap || targetUid == null) return freeze(base);

  const players = snap.players || {};
  const target = players[targetUid] || null;
  const label = slotLabel(snap, targetUid);
  base.targetPlayerLabel = label.label; base.targetSlot = label.slot;
  if (!target) return freeze({ ...base, status: STATUS.TARGET_NOT_FOUND });

  const held = Array.isArray(target.currentCards) ? target.currentCards.filter(isValidCardCode) : [];
  if (!held.length) return freeze({ ...base, status: STATUS.NO_HAND });

  // Location index from the observer's LEDGER (single source, §4). A code is "possibly hidden" only when it
  // has NO known location — i.e. it could be in an unobserved opponent's hand OR still in the deck (§13).
  const ledgerByCode = new Map();
  for (const e of (Array.isArray(snap.ledger) ? snap.ledger : [])) ledgerByCode.set(e.code, e);
  const possiblyHidden = (code) => !ledgerByCode.has(code);
  const statusOf = (code) => { const e = ledgerByCode.get(code); return e ? e.status : null; };

  // §41 — cards the target ALREADY laid down in a public phỏm stay in its server hand (sAC keeps them), but they
  // are on the table: they cannot be discarded, so they are never candidates (they used to be classified —
  // and could be shown as a card to discard).
  const laid = held.filter((c) => { const e = ledgerByCode.get(c); return e && e.status === 'MELDED' && String(e.ownerUid) === targetUid; });
  const laidSet = new Set(laid);
  const hand = held.filter((c) => !laidSet.has(c));

  // §41 — the target's OWN phỏm still in hand: discarding one breaks it. Prefer the server's own arrangement
  // (sMs, sent with this player's DRAW / ROUND_END hand); fall back to the shared rules for a dealt hand
  // (DEAL carries no sMs). Only the target's OWN cards are used.
  const serverKnown = target.currentCardsSource === 'DRAW' || target.currentCardsSource === 'ROUND_END';
  const ownMeld = serverKnown
    ? new Set((target.serverMeldCards || []).filter((c) => hand.includes(c)))
    : cardsInMelds(hand);
  const ownMeldSource = serverKnown ? 'SERVER' : 'RULES';

  // The OTHER controlled players (P1/P2/P3 minus the target) whose exact hands we KNOW. They are opponents
  // too, so a known partner pair in their hand proves a real (not hypothetical) eat.
  const controlledOpps = Object.values(players).filter((p) => p && p.controlled && p.uid !== targetUid)
    .map((p) => ({ uid: p.uid, slot: p.slot, hand: new Set((p.currentCards || []).filter(isValidCardCode)) }));

  const cards = hand.map((code) => {
    const c = classifyCard(code, { possiblyHidden, statusOf, controlledOpps });
    const inOwnMeld = ownMeld.has(code);
    return { ...c, inOwnMeld, points: cardPoints(code), reasonCodes: inOwnMeld ? [...c.reasonCodes, 'IN_OWN_MELD'] : c.reasonCodes };
  });
  // Deterministic ordering by code.
  cards.sort((a, b) => a.code - b.code);

  // Candidates to discard exclude the player's own phỏm. §42 — within a class, the HIGHEST point card comes first:
  // a loose card counts its face value against the player at scoring time, so shedding the costliest SAFE card
  // first is the standard play. Ties break by code, keeping the output deterministic.
  const view = (c) => ({ code: c.code, label: c.label, rank: c.rank, suit: c.suit, color: c.color, points: c.points, reasonCodes: c.reasonCodes });
  const byValue = (a, b) => (b.points - a.points) || (a.code - b.code);
  const pick = (cls) => cards.filter((c) => c.classification === cls && !c.inOwnMeld).sort(byValue).map(view);
  const safe = pick(CLASS.SAFE);
  const next = snap.nextOf && snap.nextOf[targetUid] != null ? String(snap.nextOf[targetUid]) : null;
  const reasons = [...new Set(cards.flatMap((c) => c.reasonCodes))].sort();

  return freeze({
    ...base,
    status: STATUS.OK,
    targetCards: cards,
    safeCards: safe,
    // Only a PROVEN-safe card is ever suggested — never a LIKELY one (§13: nothing is presented as safe on a guess).
    recommendedCode: safe.length ? safe[0].code : null,
    ownMeldCards: cards.filter((c) => c.inOwnMeld).map(view),
    ownMeldSource,
    laidCards: laid.slice().sort((a, b) => a - b).map((code) => ({ code, label: decodeCard(code).label })),
    // §40 — who plays right after the target (learned from public play). Context for the user only.
    nextPlayerUid: next,
    nextPlayerLabel: next ? playerLabel(snap, next) : null,
    likelySafeCards: pick(CLASS.LIKELY_SAFE),
    unknownCards: pick(CLASS.UNKNOWN),
    riskyCards: pick(CLASS.RISKY),
    reasons,
  });
}

// Classify ONE candidate discard from the target's hand.
function classifyCard(code, ctx) {
  const { possiblyHidden, statusOf, controlledOpps } = ctx;
  const rank = rankPartners(code);          // 3 same-rank codes
  const runs = runWindows(code);            // run windows (each a pair of same-suit codes)
  const reasonCodes = [];

  // (a) KNOWN eat by a CONTROLLED opponent (their exact hand is observed) → RISKY, never recommended.
  for (const opp of controlledOpps) {
    const rankHits = rank.filter((c) => opp.hand.has(c)).length;
    const runHit = runs.some(([a, b]) => opp.hand.has(a) && opp.hand.has(b));
    if (rankHits >= 2 || runHit) {
      reasonCodes.push('KNOWN_EATABLE_BY_CONTROLLED');
      return decorate(code, CLASS.RISKY, reasonCodes);
    }
  }

  // (b) Can a HIDDEN opponent eat X? Only with partners that are POSSIBLY hidden (unseen). A partner in any
  // known location (discarded/melded/a known hand) provably cannot be in a hidden opponent's hand.
  const rankHiddenAvail = rank.filter(possiblyHidden).length;          // need >= 2 to form the rank meld
  const rankOpen = rankHiddenAvail >= 2;
  const runsOpen = runs.filter(([a, b]) => possiblyHidden(a) && possiblyHidden(b)).length;
  const hiddenEatable = rankOpen || runsOpen > 0;

  // Public signals (explainable reasons — NEVER fake confidence numbers, §14).
  const anyPartner = [...rank, ...runs.flat()];
  if (anyPartner.some((c) => statusOf(c) === 'DISCARDED')) reasonCodes.push('PUBLIC_DISCARD_SIGNAL');
  if (anyPartner.some((c) => statusOf(c) === 'MELDED')) reasonCodes.push('PUBLIC_MELD_SIGNAL');
  if (!rankOpen) reasonCodes.push('RANK_FAMILY_BLOCKED');
  if (runsOpen === 0 && runs.length) reasonCodes.push('RUNS_BLOCKED');

  if (!hiddenEatable) {
    // Proven: no controlled opponent and no possible hidden opponent can complete a meld with X.
    reasonCodes.unshift('ALL_MELDS_BLOCKED');
    return decorate(code, CLASS.SAFE, reasonCodes);
  }

  // Not proven safe. LIKELY_SAFE only when the danger is substantially narrowed by public evidence: the rank
  // meld is fully blocked AND at most ONE run window remains open via unseen cards. Otherwise UNKNOWN (§13).
  if (!rankOpen && runsOpen <= 1) {
    reasonCodes.push('RUN_MOSTLY_BLOCKED');
    return decorate(code, CLASS.LIKELY_SAFE, reasonCodes);
  }
  reasonCodes.push('HIDDEN_PARTNERS_OPEN');
  return decorate(code, CLASS.UNKNOWN, reasonCodes);
}

function decorate(code, classification, reasonCodes) {
  const d = decodeCard(code);
  return { code, label: d.label, rank: d.rank, suit: d.suit, color: d.color, classification, reasonCodes: [...new Set(reasonCodes)] };
}

// The user-facing "Player N" label + internal slot for a uid (presentation only, §6).
// A display name for any seated player: 'Player N' for a controlled browser, else the table name.
function playerLabel(snap, uid) {
  const l = slotLabel(snap, uid);
  if (l.label) return l.label;
  const p = (snap.players || {})[uid];
  return p && p.name ? String(p.name) : 'Người chơi khác';
}

function slotLabel(snap, uid) {
  const binding = snap.slotBinding || {};
  for (const slot of ['B1', 'B2', 'B3']) if (binding[slot] === uid) return { slot, label: 'Player ' + slot.slice(1) };
  const p = (snap.players || {})[uid];
  return { slot: p ? p.slot : null, label: p && p.slot ? 'Player ' + String(p.slot).slice(1) : null };
}

// Content fingerprint for memoisation: target + round + the exact observation that affects the result.
function fingerprint(snap, targetUid) {
  if (!snap) return `${targetUid}|nil`;
  const led = (snap.ledger || []).map((e) => `${e.code}:${e.status}`).sort().join(',');
  const tp = snap.players && snap.players[targetUid];
  const t = tp ? (tp.currentCards || []).slice().sort((a, b) => a - b).join(',') : '';
  const sm = tp ? `${tp.currentCardsSource || ''}:${(tp.serverMeldCards || []).slice().sort((a, b) => a - b).join(',')}` : '';
  const nx = snap.nextOf && snap.nextOf[targetUid] != null ? String(snap.nextOf[targetUid]) : '';
  return `${targetUid}|r${snap.roundSeq}|H[${t}]|M[${sm}]|N[${nx}]|L[${led}]`;
}

function freeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { for (const k of Object.keys(o)) freeze(o[k]); Object.freeze(o); } return o; }

function createSafeCardAnalyzer() { return new SafeCardAnalyzer(); }

module.exports = { createSafeCardAnalyzer, SafeCardAnalyzer, CLASS, STATUS, rankPartners, runWindows };
