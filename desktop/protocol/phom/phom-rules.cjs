'use strict';

// ---------------------------------------------------------------------------
// PHỎM RULES — the ONE implementation of the meld rules, shared by the offline
// analyzer/simulator and the live safe-card analyzer. Before this module the rules
// were written twice (classifyMeld/findMelds offline, rankPartners/runWindows live),
// so the two screens could disagree about what a phỏm is.
//
// PURE: card codes in, plain data out. No I/O, no protocol, no network — which is
// why it can be shared with the live screen while offline-analyzer keeps its own
// offline-only gate on its ENTRY POINTS.
//
// Card model (card-codec.cjs): rankIndex = floor(code/4) in 0..12 (A low … K),
// suitIndex = code % 4. A phỏm is 3+ cards of ONE rank (a SET) or 3+ consecutive
// ranks of ONE suit (a RUN). A is low only (A-2-3 is a run; Q-K-A is not).
// ---------------------------------------------------------------------------

const { isValidCardCode, rankIndexOf, suitIndexOf, encodeCard, sortCardCodes } = require('./card-codec.cjs');

// 'SET' | 'RUN' | null for an exact group of cards.
function classifyMeld(cards) {
  if (!Array.isArray(cards) || cards.length < 3 || !cards.every(isValidCardCode)) return null;
  const ranks = cards.map(rankIndexOf), suits = cards.map(suitIndexOf);
  if (ranks.every((r) => r === ranks[0])) return 'SET';
  if (suits.every((s) => s === suits[0])) {
    const sorted = [...ranks].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length) return null;
    for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return null;
    return 'RUN';
  }
  return null;
}

// Every MAXIMAL set / run present in a hand (they may overlap — a card can sit in both a
// set and a run candidate; callers that need a partition must choose).
function findMelds(hand) {
  const cards = (hand || []).filter(isValidCardCode);
  const out = [];
  const byRank = new Map();
  for (const c of cards) { const r = rankIndexOf(c); (byRank.get(r) || byRank.set(r, []).get(r)).push(c); }
  for (const [, group] of byRank) if (group.length >= 3) out.push({ type: 'SET', cards: sortCardCodes(group) });
  const bySuit = new Map();
  for (const c of cards) { const s = suitIndexOf(c); (bySuit.get(s) || bySuit.set(s, []).get(s)).push(c); }
  for (const [, group] of bySuit) {
    const uniq = [...new Set(group)].sort((a, b) => rankIndexOf(a) - rankIndexOf(b));
    let run = [uniq[0]];
    for (let i = 1; i < uniq.length; i++) {
      if (rankIndexOf(uniq[i]) === rankIndexOf(uniq[i - 1]) + 1) run.push(uniq[i]);
      else { if (run.length >= 3) out.push({ type: 'RUN', cards: [...run] }); run = [uniq[i]]; }
    }
    if (run.length >= 3) out.push({ type: 'RUN', cards: [...run] });
  }
  return out;
}

// The set of codes that take part in ANY phỏm of the hand (conservative: overlaps included).
function cardsInMelds(hand) {
  const out = new Set();
  for (const m of findMelds(hand)) for (const c of m.cards) out.add(c);
  return out;
}

// The 3 same-rank partner codes (other suits) of X — two of them complete a SET with X.
function rankPartners(code) {
  const r = rankIndexOf(code); const s = suitIndexOf(code);
  const out = [];
  for (let suit = 0; suit < 4; suit++) if (suit !== s) out.push(encodeCard(r, suit));
  return out;
}

// The same-suit PAIRS that complete a RUN with X: [X-2,X-1], [X-1,X+1], [X+1,X+2].
function runWindows(code) {
  const r = rankIndexOf(code); const s = suitIndexOf(code);
  const wins = [];
  const mk = (a, b) => (a >= 0 && b <= 12 ? [encodeCard(a, s), encodeCard(b, s)] : null);
  for (const w of [mk(r - 2, r - 1), mk(r - 1, r + 1), mk(r + 1, r + 2)]) if (w) wins.push(w);
  return wins;
}

// Point value of a card when it is left OUT of every phỏm at scoring time (Phỏm counts the
// face value of loose cards: A = 1 … K = 13). Higher = costlier to keep.
function cardPoints(code) { return rankIndexOf(code) + 1; }

module.exports = { classifyMeld, findMelds, cardsInMelds, rankPartners, runWindows, cardPoints };
