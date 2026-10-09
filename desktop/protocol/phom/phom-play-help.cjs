'use strict';

// ---------------------------------------------------------------------------
// ĐÁNH BÀI help (pure) — what the tool shows next to the play buttons for ONE account.
//
// Knowledge boundary (user 2026-10-09, kept on purpose): ONLY that account's own hand + what everyone at the table
// sees (discards, eats, laid phỏm, sent cards, public turn order). The hands of the tool's other accounts are NOT used
// here — publicView() strips them before anything is computed — so a teammate is treated exactly like a stranger.
//
//   publicView(snap, uid)      the card snapshot as that account alone could know it
//   bestArrangement(hand)      the phỏm split that leaves the fewest loose points (A = 1 … K = 13)
//   discardRanking(snap, uid)  every card it may discard, ranked as the user asked (every turn, the last one too):
//                                1. CHẮC CHẮN không bị ăn  2. CÓ THỂ không bị ăn  3. the rest
//                              and only then the fewest points left — a safe card goes first even when it costs more
//   haPlan(snap, uid)          what to lay + the discard after it, by the same order
//   takeInfo(snap, uid)        the card the player before it just discarded: can it be eaten (a phỏm with the hand)?
//   sendTargets(snap, uid)     which hand cards fit which laid phỏm on the table (GỬI)
// It never sends, clicks or decides — the user presses the game's own buttons.
// ---------------------------------------------------------------------------

const { isValidCardCode, decodeCard } = require('./card-codec.cjs');
const { classifyMeld, cardPoints } = require('./phom-rules.cjs');
const { SafeCardAnalyzer, CLASS } = require('./phom-safe-card-analyzer.cjs');

const TIER = Object.freeze({ SAFE: 0, LIKELY: 1, OTHER: 2 });
const TIER_LABEL = Object.freeze(['Chắc chắn không bị ăn', 'Có thể không bị ăn', 'Có thể bị ăn']);
const PRIVATE_STATUSES = new Set(['CURRENT', 'DRAWN']); // where a card sits in someone's hand — only its owner knows

const view = (code) => { const d = decodeCard(code); return { code, label: d.label, rank: d.rank, suit: d.suit, color: d.color }; };
const sumPoints = (cards) => cards.reduce((s, c) => s + cardPoints(c), 0);

// ---- the knowledge boundary ----
function publicView(snap, uid) {
  if (!snap || !snap.players) return snap;
  const me = String(uid);
  const players = {};
  for (const [k, p] of Object.entries(snap.players)) {
    players[k] = k === me ? p : { ...p, currentCards: [], currentCardsView: [], currentCardsCount: 0, currentCardsSource: null, drawnHistory: [], drawnHistoryView: [], serverMeldCards: [], controlled: false };
  }
  const ledger = (Array.isArray(snap.ledger) ? snap.ledger : []).filter((e) => !(PRIVATE_STATUSES.has(e.status) && String(e.ownerUid) !== me));
  return { ...snap, players, ledger };
}

// ---- melds + points ----
// every phỏm (all sub-groups of 3+, a card may be in several) of a small hand
function allMelds(hand) {
  const cards = [...new Set(hand)].filter(isValidCardCode);
  const out = [];
  const n = cards.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let bits = 0; for (let m = mask; m; m &= m - 1) bits++;
    if (bits < 3 || bits > 4 && !isRunCandidate(cards, mask)) continue;
    const g = cards.filter((_, i) => mask & (1 << i));
    if (classifyMeld(g)) out.push(g.sort((a, b) => a - b));
  }
  return out;
}
const isRunCandidate = (cards, mask) => { let s = null; for (let i = 0; i < cards.length; i++) if (mask & (1 << i)) { const su = cards[i] % 4; if (s == null) s = su; else if (s !== su) return false; } return true; };

// every way to lay disjoint phỏm (including none) → [{ melds, loose, points }]
function arrangements(hand) {
  const melds = allMelds(hand);
  const out = [];
  const walk = (i, used, chosen) => {
    if (i === melds.length) {
      const loose = hand.filter((c) => !used.has(c));
      out.push({ melds: chosen.map((m) => m.slice()), loose, points: sumPoints(loose) });
      return;
    }
    walk(i + 1, used, chosen);
    const m = melds[i];
    if (m.every((c) => !used.has(c))) { const u = new Set(used); m.forEach((c) => u.add(c)); walk(i + 1, u, chosen.concat([m])); }
  };
  if (hand.length <= 12) walk(0, new Set(), []);
  return out;
}
function bestArrangement(hand) {
  const all = arrangements(hand.filter(isValidCardCode));
  if (!all.length) return { melds: [], loose: hand.slice(), points: sumPoints(hand) };
  return all.sort((a, b) => (a.points - b.points) || (b.melds.length - a.melds.length))[0];
}

// ---- safety, from the public view only ----
function safetyOf(snap, uid) {
  const a = new SafeCardAnalyzer().analyze({ snapshot: publicView(snap, uid), targetPlayerUid: uid });
  const tier = new Map();
  for (const c of (a.targetCards || [])) tier.set(c.code, c.classification === CLASS.SAFE ? TIER.SAFE : c.classification === CLASS.LIKELY_SAFE ? TIER.LIKELY : TIER.OTHER);
  return { tier, nextPlayerLabel: a.nextPlayerLabel || null, status: a.status };
}

// the account's own cards still in hand (not laid on the table, not sent)
function handOf(snap, uid) {
  const p = snap && snap.players ? snap.players[String(uid)] : null;
  if (!p) return null;
  const laid = new Set((p.melds || []).flatMap((m) => m.cards || []));
  return (p.currentCards || []).filter((c) => isValidCardCode(c) && !laid.has(c));
}

// a card that was EATEN by this account must stay in a phỏm — never a discard
function eatenBy(snap, uid) { return new Set((snap.eats || []).filter((e) => String(e.eaterUid) === String(uid)).map((e) => e.card)); }

// Loose cards first (in the user's order: tier, then points left); a card of the best phỏm split comes last —
// discarding it breaks a phỏm ("phá phỏm"), as LỌC BÀI never offers it either.
function rankDiscards(hand, tier, locked) {
  const inMeld = new Set(bestArrangement(hand).melds.flat());
  return hand.filter((c) => !locked.has(c)).map((code) => {
    const rest = hand.filter((c) => c !== code);
    const left = bestArrangement(rest).points;
    const t = tier.has(code) ? tier.get(code) : TIER.OTHER;
    return { ...view(code), tier: t, tierLabel: TIER_LABEL[t], pointsLeft: left, cardPoints: cardPoints(code), breaksPhom: inMeld.has(code) };
  }).sort((a, b) => (a.breaksPhom - b.breaksPhom) || (a.tier - b.tier) || (a.pointsLeft - b.pointsLeft) || (b.cardPoints - a.cardPoints) || (a.code - b.code));
}

function discardRanking(snap, uid) {
  const hand = handOf(snap, uid);
  if (!hand || !hand.length) return { ok: false, ranking: [], points: null };
  const { tier, nextPlayerLabel } = safetyOf(snap, uid);
  const ranking = rankDiscards(hand, tier, eatenBy(snap, uid));
  return { ok: true, ranking, recommended: ranking[0] || null, points: bestArrangement(hand).points, nextPlayerLabel };
}

// HẠ: which phỏm to lay + the discard after it, by the same order (tier first, then the fewest points left)
function haPlan(snap, uid) {
  const hand = handOf(snap, uid);
  if (!hand || hand.length < 3) return { ok: false };
  const { tier } = safetyOf(snap, uid);
  const eaten = eatenBy(snap, uid);
  let best = null;
  for (const a of arrangements(hand)) {
    if (!a.melds.length) continue;
    if ([...eaten].some((c) => hand.includes(c) && !a.melds.some((m) => m.includes(c)))) continue; // an eaten card must be laid
    for (const d of a.loose.length ? a.loose : [null]) {
      const t = d == null ? TIER.SAFE : (tier.has(d) ? tier.get(d) : TIER.OTHER);
      const left = a.points - (d == null ? 0 : cardPoints(d));
      const cand = { melds: a.melds, discard: d, tier: t, pointsLeft: left };
      if (!best || t < best.tier || (t === best.tier && (left < best.pointsLeft || (left === best.pointsLeft && a.melds.length > best.melds.length)))) best = cand;
    }
  }
  if (!best) return { ok: false };
  return { ok: true, melds: best.melds.map((m) => m.map(view)), cards: best.melds.flat(), discard: best.discard == null ? null : { ...view(best.discard), tier: best.tier, tierLabel: TIER_LABEL[best.tier] }, pointsLeft: best.pointsLeft };
}

// the player who plays right BEFORE uid (the one whose discard uid may eat), from the public turn order
function prevOf(snap, uid) {
  for (const [a, b] of Object.entries(snap.nextOf || {})) if (String(b) === String(uid)) return String(a);
  return null;
}
// ĂN: the card the previous player just discarded — and whether it makes a phỏm with the hand
function takeInfo(snap, uid) {
  const prev = prevOf(snap, uid);
  const ev = (snap.observedDiscardEvents || []).slice(-1)[0];
  if (!ev || !prev || String(ev.uid) !== prev) return { ok: false, prevUid: prev };
  const code = (ev.cards || [])[0];
  if (!isValidCardCode(code)) return { ok: false, prevUid: prev };
  if ((snap.eats || []).some((e) => e.card === code)) return { ok: false, prevUid: prev, eaten: true };
  const hand = handOf(snap, uid) || [];
  const melds = allMelds(hand.concat(code)).filter((m) => m.includes(code));
  const with_ = melds.length ? bestArrangement(hand.concat(code)) : null;
  return { ok: true, prevUid: prev, card: view(code), canTake: melds.length > 0, meld: melds.length ? melds.sort((a, b) => a.length - b.length)[0].map(view) : null, pointsIfTaken: with_ ? with_.points : null };
}

// GỬI: hand cards that fit a laid phỏm on the table (the server picks the phỏm; this only says which fit)
function sendTargets(snap, uid) {
  const hand = handOf(snap, uid) || [];
  const laid = [];
  for (const p of Object.values((snap && snap.players) || {})) for (const m of (p.melds || [])) laid.push({ owner: p.uid, meid: m.meid, cards: m.cards || [] });
  const out = [];
  for (const code of hand) {
    const fits = laid.filter((m) => m.cards.length && !m.cards.includes(code) && classifyMeld(m.cards.concat(code)) && !(classifyMeld(m.cards) === 'SET' && m.cards.length >= 4));
    if (fits.length) out.push({ ...view(code), into: fits.map((m) => ({ owner: m.owner, meid: m.meid, cards: m.cards.map(view) })) });
  }
  return out;
}

// Before a press with cards picked in the tool: refuse what the game would refuse anyway, with a plain reason.
//   HẠ — the picked cards split exactly into phỏm · GỬI — every picked card fits a laid phỏm · ĐÁNH — not a card it ate
function checkPlay(snap, uid, action, cards) {
  const picked = (cards || []).filter(isValidCardCode);
  if (!picked.length) return { ok: true };
  const hand = handOf(snap, uid);
  if (!hand) return { ok: true }; // nothing observed yet — the game decides
  const missing = picked.filter((c) => !hand.includes(c));
  if (missing.length) return { ok: false, message: 'Lá ' + missing.map((c) => view(c).label).join(' ') + ' không còn trên tay' };
  if (action === 'HA' && !arrangements(picked).some((a) => !a.loose.length && a.melds.length)) return { ok: false, message: 'Các lá đã chọn chưa thành phỏm (mỗi phỏm 3–4 lá cùng số, hoặc 3+ lá liền nhau cùng chất)' };
  if (action === 'GUI') {
    const fits = new Set(sendTargets(snap, uid).map((x) => x.code));
    const no = picked.filter((c) => !fits.has(c));
    if (no.length) return { ok: false, message: 'Lá ' + no.map((c) => view(c).label).join(' ') + ' không gửi được vào phỏm nào trên bàn' };
  }
  if (action === 'DANH' && eatenBy(snap, uid).has(picked[0])) return { ok: false, message: 'Lá đã ăn phải nằm trong phỏm — không đánh được' };
  return { ok: true };
}

// Everything the ĐÁNH BÀI tab shows for one account (null before its hand is seen).
function playHelp(snap, uid) {
  if (!snap || uid == null || !handOf(snap, uid)) return null;
  const d = discardRanking(snap, uid);
  return { ranking: d.ranking, recommended: d.recommended || null, points: d.points, nextPlayerLabel: d.nextPlayerLabel || null, ha: haPlan(snap, uid), take: takeInfo(snap, uid), send: sendTargets(snap, uid) };
}

module.exports = {
  checkPlay, playHelp, TIER, TIER_LABEL, publicView, allMelds, arrangements, bestArrangement, discardRanking, haPlan, takeInfo, sendTargets, prevOf };
