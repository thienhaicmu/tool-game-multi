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

// The meld rules live in ONE place (phom-rules.cjs), shared with the live safe-card analyzer so both
// screens agree on what a phỏm is. They are pure (no network), so sharing them does not weaken the
// offline-only gate, which stays on this module's ENTRY POINTS below.
const { classifyMeld, findMelds } = require('./phom-rules.cjs');
const rankOf = (c) => Math.floor(c / 4);
const suitOf = (c) => c % 4;

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

// The other three codes of the same rank as `card` (the same-rank cards in the other 3 suits).
function sameRankOthers(card) { const r = rankOf(card); const out = []; for (let su = 0; su < 4; su++) { const c = r * 4 + su; if (c !== card) out.push(c); } return out; }

// Can an OPPONENT complete a fresh 3-card phỏm using `card` (a card we might discard) plus TWO cards
// drawn from `pool` (the unknown/possible-opponent codes)? Returns the concrete meld completions.
//   SET  : two more of the same rank (from the 3 other suits) that are in the pool
//   RUN  : a same-suit consecutive pair around `card` — [r-2,r-1] | [r-1,r+1] | [r+1,r+2]
function opponentEatThreats(card, poolSet) {
  const r = rankOf(card), s = suitOf(card), out = [];
  const setAvail = sameRankOthers(card).filter((c) => poolSet.has(c));
  if (setAvail.length >= 2) out.push({ type: 'SET', with: sortCardCodes(setAvail.slice(0, 3)) });
  const windows = [[-2, -1], [-1, 1], [1, 2]];
  for (const [o1, o2] of windows) {
    const r1 = r + o1, r2 = r + o2; if (r1 < 0 || r1 > 12 || r2 < 0 || r2 > 12) continue;
    const c1 = r1 * 4 + s, c2 = r2 * 4 + s;
    if (poolSet.has(c1) && poolSet.has(c2)) out.push({ type: 'RUN', with: sortCardCodes([c1, c2]) });
  }
  return out;
}

// Does `card` extend an already-laid PUBLIC meld (a 4th of a laid SET, or either end of a laid RUN)?
function extendsPublicMeld(card, publicMelds) {
  for (const m of (publicMelds || [])) {
    const meld = (m || []).filter(isValidCardCode); const type = classifyMeld(meld); if (!type) continue;
    if (type === 'SET' && rankOf(meld[0]) === rankOf(card)) return { type: 'SET', meld: sortCardCodes(meld) };
    if (type === 'RUN' && suitOf(meld[0]) === suitOf(card)) {
      const ranks = meld.map(rankOf).sort((a, b) => a - b);
      if (rankOf(card) === ranks[0] - 1 || rankOf(card) === ranks[ranks.length - 1] + 1) return { type: 'RUN', meld: sortCardCodes(meld) };
    }
  }
  return null;
}

// §16 OFFLINE QA — SAFE-DISCARD / OPPONENT-THREAT analysis. Given the cards WE control (1..3 hands)
// plus public cards/melds, exclude them from the 52-card deck to get the UNKNOWN pool (⊆ opponent
// hands + draw pile), then classify each of our cards as SAFE or DANGEROUS to discard, and list every
// deck card an opponent could kết-phỏm with. Pure + offline-gated; NEVER infers a specific opponent
// hand — only what is POSSIBLE from unknown cards (the more we control, the tighter the safety).
function analyzeSafeDiscards({ controlledHands = [], publicCards = [], publicMelds = [], deckSize = 52 } = {}, ctx = {}) {
  const blocked = assertOffline(ctx); if (blocked) return blocked;
  const known = [];
  for (const h of controlledHands) for (const c of (h || [])) known.push(c);
  for (const c of publicCards) known.push(c);
  for (const m of (publicMelds || [])) for (const c of (m || [])) known.push(c);
  const invalid = known.filter((c) => !isValidCardCode(c));
  if (invalid.length) return { ok: false, error: { code: 'PHOM_INVALID_CARD_CODE', message: `${invalid.length} invalid card code(s)` } };
  const knownSet = new Set(known);
  const unknown = []; for (let c = 0; c < deckSize; c++) if (!knownSet.has(c)) unknown.push(c);
  const poolSet = new Set(unknown);

  const seen = new Set();
  const candidates = [];
  for (const h of controlledHands) for (const card of (h || [])) {
    if (seen.has(card)) continue; seen.add(card);
    const eat = opponentEatThreats(card, poolSet);
    const ext = extendsPublicMeld(card, publicMelds);
    const threats = eat.concat(ext ? [{ type: 'EXTEND_' + ext.type, meld: ext.meld }] : []);
    candidates.push({ card, label: decodeCard(card).label, safe: threats.length === 0, threats });
  }
  const opponentPhomCards = [];
  for (let c = 0; c < deckSize; c++) { if (opponentEatThreats(c, poolSet).length || extendsPublicMeld(c, publicMelds)) opponentPhomCards.push(c); }

  return {
    ok: true,
    controlledCount: controlledHands.filter((h) => h && h.length).length,
    KNOWN_CARDS: knownSet.size,
    UNKNOWN_COUNT: unknown.length,
    UNKNOWN_POOL: sortCardCodes(unknown),
    candidates: candidates.sort((a, b) => a.card - b.card),
    SAFE_DISCARDS: sortCardCodes(candidates.filter((c) => c.safe).map((c) => c.card)),
    DANGEROUS_DISCARDS: sortCardCodes(candidates.filter((c) => !c.safe).map((c) => c.card)),
    OPPONENT_PHOM_CARDS: sortCardCodes(opponentPhomCards),
  };
}

module.exports = { ALLOWED_SOURCE_KINDS, assertOffline, classifyMeld, findMelds, discardFormsPhom, validateServerMelds, analyzeConsistency, opponentEatThreats, extendsPublicMeld, analyzeSafeDiscards };
