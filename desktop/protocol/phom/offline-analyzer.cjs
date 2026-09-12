'use strict';

// ---------------------------------------------------------------------------
// PHỎM OFFLINE RULE ANALYZER (QA/OFFLINE ONLY — §16). PURE: it imports ONLY the
// card codec (and nothing that can touch a live game). It has NO browser launcher,
// NO CDP, NO WebSocket sender, NO live coordinator, NO credentials.
//
// HARD BOUNDARY: analyze() refuses unless the caller proves an offline context
// (networkEnabled === false, no live BrowserRun, and an allowed source kind).
// Otherwise it returns PHOM_ANALYZER_OFFLINE_ONLY — the guard is in the domain,
// not just the UI. This module must NEVER be wired into the live screen.
// ---------------------------------------------------------------------------

const { isValidCardCode, decodeCard, sortCardCodes } = require('./card-codec.cjs');

const ALLOWED_SOURCE_KINDS = Object.freeze(['TEST_FIXTURE', 'REDACTED_REPLAY', 'LOCAL_SIMULATOR']);

function offlineOnly() { return { ok: false, error: { code: 'PHOM_ANALYZER_OFFLINE_ONLY', message: 'The rule analyzer only runs in an offline QA context (no live browser, no network).' } }; }

// The single gate every entry point calls first.
function assertOffline(ctx = {}) {
  if (ctx.networkEnabled === true) return offlineOnly();
  if (Number(ctx.liveRunCount) > 0) return offlineOnly();
  if (ctx.liveSessionId != null) return offlineOnly();
  if (ctx.endpoint != null) return offlineOnly();
  if (!ALLOWED_SOURCE_KINDS.includes(ctx.sourceKind)) return offlineOnly();
  return null;
}

const rankOf = (c) => Math.floor(c / 4);
const suitOf = (c) => c % 4;

// classifyMeld(cards) -> 'SET' | 'RUN' | null. A SET is >=3 of one rank; a RUN is
// >=3 same-suit consecutive ranks. Pure — used ONLY for the offline simulator.
function classifyMeld(cards) {
  if (!Array.isArray(cards) || cards.length < 3 || !cards.every(isValidCardCode)) return null;
  const ranks = cards.map(rankOf), suits = cards.map(suitOf);
  if (ranks.every((r) => r === ranks[0])) return 'SET';
  if (suits.every((s) => s === suits[0])) {
    const sorted = [...ranks].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length) return null;
    for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return null;
    return 'RUN';
  }
  return null;
}

// findMelds(hand) -> list of maximal candidate melds present in a simulated hand.
// SIMULATOR/QA ONLY. Never called on a live table.
function findMelds(hand) {
  const cards = (hand || []).filter(isValidCardCode);
  const out = [];
  // sets by rank
  const byRank = new Map();
  for (const c of cards) { const r = rankOf(c); (byRank.get(r) || byRank.set(r, []).get(r)).push(c); }
  for (const [, group] of byRank) if (group.length >= 3) out.push({ type: 'SET', cards: sortCardCodes(group) });
  // runs by suit
  const bySuit = new Map();
  for (const c of cards) { const s = suitOf(c); (bySuit.get(s) || bySuit.set(s, []).get(s)).push(c); }
  for (const [, group] of bySuit) {
    const uniq = [...new Set(group)].sort((a, b) => rankOf(a) - rankOf(b));
    let run = [uniq[0]];
    for (let i = 1; i < uniq.length; i++) {
      if (rankOf(uniq[i]) === rankOf(uniq[i - 1]) + 1) run.push(uniq[i]);
      else { if (run.length >= 3) out.push({ type: 'RUN', cards: [...run] }); run = [uniq[i]]; }
    }
    if (run.length >= 3) out.push({ type: 'RUN', cards: [...run] });
  }
  return out;
}

// Does adding `card` to a known SIMULATED hand create a new meld it wasn't part of?
// SIMULATOR/QA ONLY. Returns { forms, melds } — supporting cards for the meld.
function discardFormsPhom(hand, card, ctx = {}) {
  const blocked = assertOffline(ctx); if (blocked) return blocked;
  if (!isValidCardCode(card)) return { ok: false, error: { code: 'PHOM_INVALID_CARD_CODE', message: String(card) } };
  const before = findMelds(hand).filter((m) => m.cards.includes(card));
  const withCard = findMelds([...(hand || []), card]).filter((m) => m.cards.includes(card));
  const newMelds = withCard.filter((m) => !before.some((b) => b.type === m.type && b.cards.join() === m.cards.join()));
  return { ok: true, forms: newMelds.length > 0, melds: newMelds };
}

// Validate a server sMs (flat meld-card list) partitions into valid melds. sMs has
// no authoritative grouping (§15) so we only report whether SOME partition of the
// cards into found melds covers them — never assert a specific server grouping.
function validateServerMelds(sMs, ctx = {}) {
  const blocked = assertOffline(ctx); if (blocked) return blocked;
  const cards = (sMs || []).filter(isValidCardCode);
  if (cards.length !== (sMs || []).length) return { ok: false, error: { code: 'PHOM_INVALID_CARD_CODE', message: 'sMs contains invalid codes' } };
  const melds = findMelds(cards);
  const covered = new Set();
  for (const m of melds) for (const c of m.cards) covered.add(c);
  const allInMelds = cards.every((c) => covered.has(c));
  return { ok: true, cardsInMelds: sortCardCodes([...covered]), allCardsFormMelds: allInMelds, melds };
}

// Consistency analyzer (§16). Reports allowed outputs only; no opponent inference.
function analyzeConsistency({ knownHands = [], publicCards = [], deckSize = 52 } = {}, ctx = {}) {
  const blocked = assertOffline(ctx); if (blocked) return blocked;
  const all = [];
  for (const hand of knownHands) for (const c of (hand || [])) all.push(c);
  for (const c of publicCards) all.push(c);

  const invalid = all.filter((c) => !isValidCardCode(c));
  const seen = new Map();
  for (const c of all) seen.set(c, (seen.get(c) || 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);

  const knownCount = knownHands.reduce((n, h) => n + (h ? h.length : 0), 0);
  const publicCount = publicCards.length;
  const usedDistinct = seen.size;

  return {
    ok: true,
    KNOWN_PROFILE_CARDS: knownCount,
    PUBLIC_CARDS: publicCount,
    UNKNOWN_CARD_COUNT: Math.max(0, deckSize - usedDistinct),
    DUPLICATE_CARD_ERROR: duplicates.length ? { count: duplicates.length, codes: sortCardCodes(duplicates) } : null,
    CARD_CONSERVATION_ERROR: usedDistinct > deckSize ? { used: usedDistinct, deckSize } : null,
    INVALID_CARD_ERROR: invalid.length ? { count: invalid.length } : null,
  };
}

module.exports = { ALLOWED_SOURCE_KINDS, assertOffline, classifyMeld, findMelds, discardFormsPhom, validateServerMelds, analyzeConsistency };
