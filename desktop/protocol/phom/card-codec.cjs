'use strict';

// ---------------------------------------------------------------------------
// Phỏm (Tá Lả) CARD CODEC — the single, pure source of truth for turning the
// game's integer card codes (0..51) into rank/suit/label, and back.
//
// Confirmed encoding (PHOM protocol §13):
//   rankIndex = Math.floor(code / 4)
//   suitIndex = code % 4
//   code      = rankIndex * 4 + suitIndex
//
// This module is PURE and PASSIVE: no I/O, no state, no protocol send. The UI,
// the hand reducer and the consistency analyzer ALL import from here so the
// rank/suit mapping can never drift between layers.
// ---------------------------------------------------------------------------

// rankIndex -> human rank label. Index 0 is Ace, 9 is Ten, 10..12 are J/Q/K.
const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);

// suitIndex -> { symbol, name, color }. 0=♠ 1=♣ 2=♦ 3=♥ (confirmed §13).
const SUITS = Object.freeze([
  Object.freeze({ symbol: '♠', name: 'spades', color: 'black' }),
  Object.freeze({ symbol: '♣', name: 'clubs', color: 'black' }),
  Object.freeze({ symbol: '♦', name: 'diamonds', color: 'red' }),
  Object.freeze({ symbol: '♥', name: 'hearts', color: 'red' }),
]);

const MIN_CODE = 0;
const MAX_CODE = 51;

// A card code is valid iff it is an integer in [0, 51]. No silent coercion:
// negatives, >51, NaN, Infinity, floats, non-numeric strings, null/undefined
// all return false so callers can raise a typed PHOM_INVALID_CARD_CODE instead
// of decoding garbage.
function isValidCardCode(code) {
  return typeof code === 'number' && Number.isInteger(code) && code >= MIN_CODE && code <= MAX_CODE;
}

function rankIndexOf(code) { return Math.floor(code / 4); }
function suitIndexOf(code) { return code % 4; }

// decodeCard(code) -> canonical descriptor. Throws on invalid input (never coerces).
function decodeCard(code) {
  if (!isValidCardCode(code)) {
    const err = new Error(`PHOM_INVALID_CARD_CODE: ${describe(code)}`);
    err.code = 'PHOM_INVALID_CARD_CODE';
    err.value = code;
    throw err;
  }
  const rankIndex = rankIndexOf(code);
  const suitIndex = suitIndexOf(code);
  const suit = SUITS[suitIndex];
  return Object.freeze({
    code,
    rankIndex,
    suitIndex,
    rank: RANKS[rankIndex],
    suit: suit.symbol,
    suitName: suit.name,
    color: suit.color,
    label: RANKS[rankIndex] + suit.symbol,
  });
}

// encodeCard(rank, suit) -> code. Accepts rank as index (0..12) or label ('A','10','K',…)
// and suit as index (0..3), symbol ('♠') or name ('spades'). Throws on invalid input.
function encodeCard(rank, suit) {
  const rankIndex = normalizeRank(rank);
  const suitIndex = normalizeSuit(suit);
  if (rankIndex == null || suitIndex == null) {
    const err = new Error(`PHOM_INVALID_CARD_CODE: rank=${describe(rank)} suit=${describe(suit)}`);
    err.code = 'PHOM_INVALID_CARD_CODE';
    throw err;
  }
  return rankIndex * 4 + suitIndex;
}

// formatCard(code) -> short label like "J♠". Throws on invalid input (no silent "??").
function formatCard(code) { return decodeCard(code).label; }

// Convenience: decode a list, preserving order. Throws if ANY code is invalid so a
// corrupt frame is never partially applied.
function decodeCards(codes) {
  if (!Array.isArray(codes)) {
    const err = new Error(`PHOM_INVALID_CARD_CODE: expected array, got ${describe(codes)}`);
    err.code = 'PHOM_INVALID_CARD_CODE';
    throw err;
  }
  return codes.map(decodeCard);
}

// Sort helper — by rank then suit — WITHOUT deciding melds (that stays server-authoritative
// via sMs). Returns a new array; the input is never mutated.
function sortCardCodes(codes) {
  return [...codes].sort((a, b) => {
    const ra = rankIndexOf(a), rb = rankIndexOf(b);
    if (ra !== rb) return ra - rb;
    return suitIndexOf(a) - suitIndexOf(b);
  });
}

// ---- internal helpers ----
function normalizeRank(rank) {
  if (typeof rank === 'number' && Number.isInteger(rank) && rank >= 0 && rank <= 12) return rank;
  if (typeof rank === 'string') {
    const i = RANKS.indexOf(rank.trim().toUpperCase());
    if (i >= 0) return i;
  }
  return null;
}
function normalizeSuit(suit) {
  if (typeof suit === 'number' && Number.isInteger(suit) && suit >= 0 && suit <= 3) return suit;
  if (typeof suit === 'string') {
    const s = suit.trim();
    const bySymbol = SUITS.findIndex((x) => x.symbol === s);
    if (bySymbol >= 0) return bySymbol;
    const byName = SUITS.findIndex((x) => x.name === s.toLowerCase());
    if (byName >= 0) return byName;
  }
  return null;
}
function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return `${typeof v}:${JSON.stringify(v)}`;
}

module.exports = {
  RANKS,
  SUITS,
  MIN_CODE,
  MAX_CODE,
  isValidCardCode,
  decodeCard,
  encodeCard,
  formatCard,
  decodeCards,
  sortCardCodes,
};
