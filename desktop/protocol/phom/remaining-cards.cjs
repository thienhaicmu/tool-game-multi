'use strict';

// ---------------------------------------------------------------------------
// PHASE-6 — REMAINING CARDS (pure). Screen 2 shows the cards left AFTER removing
// every card currently held by Browser 1 + Browser 2 + Browser 3. It is NOT
// "player 4's hand" and assumes NOTHING about a 4th player or table size.
//
//   remaining = knownCards(default: full 52-card deck) − ⋃(browser hands)
//
// Reuses the single card-codec source of truth for identity/decoding. Deterministic,
// dedup-safe, and recomputed from CURRENT browser hands on every call — so a new deal /
// new round never carries stale cards (the caller passes the fresh hands).
// ---------------------------------------------------------------------------

const { isValidCardCode, MIN_CODE, MAX_CODE, decodeCard, sortCardCodes } = require('./card-codec.cjs');

function fullDeck() { const d = []; for (let c = MIN_CODE; c <= MAX_CODE; c++) d.push(c); return d; }

// remainingCardCodes(browserCardLists, opts) — the codes left after excluding every valid card in
// any browser list from the known set (default full deck). Invalid codes are ignored (never decoded
// as garbage). Result is de-duplicated and sorted by rank then suit.
function remainingCardCodes(browserCardLists = [], opts = {}) {
  const knownRaw = Array.isArray(opts.knownCards) && opts.knownCards.length ? opts.knownCards : fullDeck();
  const known = [];
  const seenKnown = new Set();
  for (const c of knownRaw) { if (isValidCardCode(c) && !seenKnown.has(c)) { seenKnown.add(c); known.push(c); } }
  const excluded = new Set();
  for (const list of (Array.isArray(browserCardLists) ? browserCardLists : [])) {
    for (const c of (Array.isArray(list) ? list : [])) if (isValidCardCode(c)) excluded.add(c);
  }
  return sortCardCodes(known.filter((c) => !excluded.has(c)));
}

// remainingCardsView — the codes plus a decoded, UI-ready view (label/rank/suit/color) + count.
function remainingCardsView(browserCardLists = [], opts = {}) {
  const codes = remainingCardCodes(browserCardLists, opts);
  return {
    count: codes.length,
    codes,
    cards: codes.map((c) => { const d = decodeCard(c); return { code: c, label: d.label, rank: d.rank, suit: d.suit, color: d.color }; }),
    excludedCount: (opts.knownCards && opts.knownCards.length ? opts.knownCards.length : (MAX_CODE - MIN_CODE + 1)) - codes.length,
  };
}

module.exports = { fullDeck, remainingCardCodes, remainingCardsView };
