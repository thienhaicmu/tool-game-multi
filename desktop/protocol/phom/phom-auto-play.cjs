'use strict';

// ---------------------------------------------------------------------------
// TỰ ĐÁNH (pure) — the next press for ONE account, following docs/phom-danh-bai.md turn by turn. User 2026-10-09:
// switched on per account (P1/P2/P3) by the user. A round may include players outside the tool.
//
//   tableGuard(snap, toolUids, uid)        the current round or this account's hand is known
//   nextStep(snap, uid, offered, avoid, toolUids) → { action, cards, why } | { wait, why } | { stop, code, message }
//   stateKey(snap, uid)                    changes when something THIS account's step depends on changed
//
// offered = the game's buttons shown right now (play-actions buildOfferedScript); the step is one of them:
//   Ù shown                                → BAO_U
//   Bốc / Ăn shown (Đ1–Đ4, step 1)          → Ăn when the card just discarded makes a phỏm, else Bốc
//   Đánh shown, a turn before the last     → Đánh the card "Nên đánh" (không bị ăn → giữ cạ → điểm)
//   the hạ turn (Hạ / Gửi shown, or laid) → ① Hạ the plan's phỏm → ② Gửi what fits now → ③ Đánh the plan's discard
// avoid = steps the game did not take: a refused Ăn falls back to Bốc, a refused Hạ / Gửi to the discard.
// Bốc is pressed even before the hand is known (a missed deal); forcedStep() is the step for a wait that ran out.
//
// ORDER (Meta Game 2026-10-10/11, ported 2026-10-11): legal → KHÁCH NGỒI SAU (user "acc đánh với khách phải 100% không
// được ăn"): the next player is NOT one of ours → always a card proven safe from all known hands + public cards when
// there is one (even out of a phỏm / cạ); none → the least risky → CHẶN ĂN LẦN 3 (one of ours who ate 2 → exactly the
// cards it can eat are blocked) → cạ ù → nuôi ít tiền → default. The cạ ù / nuôi ít tiền branches only feed an account
// of the tool sitting right after; "Ưu tiên 2 phỏm + cạ ù" is ON by default.
// THE HẠ TURN is the GAME's (live 2026-10-10): after an eat it is not "3 cards discarded" — the tool waited for a Hạ
// button the game never showed and the game's timer played the turn. Hạ / Gửi shown (or already laid) → the hạ turn;
// only Đánh shown → a discard now, never a wait.
// ---------------------------------------------------------------------------

const help = require('./phom-play-help.cjs');
const { isValidCardCode, decodeCard } = require('./card-codec.cjs');
const { rankPartners, runWindows, cardPoints } = require('./phom-rules.cjs');

const labels = (cards) => (cards || []).map((x) => x.label).join(' ');
const cardLabel = (code) => decodeCard(code).label;
// "Ưu tiên 2 phỏm + cạ ù" is ON by default (user 2026-10-10; simulator: +0.38 bets/round for the tool group)
const DEFAULT_STRATEGY = Object.freeze({ lowMoney: false, twoPhomCaU: true, blockThirdEat: true });

// toolUids is kept for API compatibility; auto-play no longer stops just because a round includes outside players.
function tableGuard(snap, toolUids = [], uid = null) {
  void toolUids;
  const players = ((snap && snap.roundPlayers) || []).map(String);
  const hand = uid != null ? help.handOf(snap, uid) : null;
  if (hand && hand.length) return { ok: true };
  if (!players.length) return { ok: false, code: 'AUTO_NO_ROUND', message: 'Chưa chia bài' };
  return { ok: true };
}

const uidStr = (v) => (v == null ? null : String(v));
const player = (snap, uid) => (snap && snap.players && snap.players[String(uid)]) || null;
const nextUidOf = (snap, uid) => uidStr(snap && snap.nextOf && snap.nextOf[String(uid)]);
const numOrNull = (v) => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const normalizeStrategy = (x = {}) => ({
  lowMoney: x.lowMoney === true,
  twoPhomCaU: x.twoPhomCaU !== false,
  blockThirdEat: true,
});

function eatCount(snap, uid) {
  return ((snap && snap.eats) || []).filter((e) => String(e.eaterUid != null ? e.eaterUid : e.eater) === String(uid)).length;
}

function meldsWith(code, hand) {
  return help.allMelds((hand || []).concat(code)).filter((m) => m.includes(code));
}

function canEatCard(snap, eaterUid, code) {
  const hand = help.handOf(snap, eaterUid) || [];
  const locked = help.eatenBy(snap, eaterUid);
  return help.arrangements(hand.concat(code)).some((a) =>
    a.melds.some((m) => m.includes(code)) &&
    [...locked].filter((c) => hand.includes(c)).every((c) => a.melds.some((m) => m.includes(c))) &&
    a.melds.every((m) => m.filter((c) => locked.has(c) || c === code).length <= 1));
}

function caUInfo(snap, uid) {
  const hand = help.handOf(snap, uid) || [];
  const arranged = help.bestArrangement(hand);
  if (arranged.melds.length < 2 || !arranged.loose.length) return { ok: false, need: [] };
  const out = new Set(((snap && snap.ledger) || []).filter((e) => ['DISCARDED', 'MELDED', 'EATEN'].includes(e.status)).map((e) => e.code));
  const need = [];
  for (const c of arranged.loose) {
    const candidates = rankPartners(c).concat(runWindows(c).flat());
    for (const x of candidates) {
      if (!isValidCardCode(x) || out.has(x) || hand.includes(x)) continue;
      if (!canEatCard(snap, uid, x)) continue;
      const locked = help.eatenBy(snap, uid);
      if (help.arrangements(hand.concat(x)).some((a) => a.melds.flat().length >= 9 && a.loose.length <= 1 &&
        a.melds.some((m) => m.includes(x)) && a.melds.every((m) => m.filter((c) => locked.has(c) || c === x).length <= 1) &&
        [...locked].filter((c) => hand.includes(c)).every((c) => a.melds.some((m) => m.includes(c))))) need.push(x);
    }
  }
  return { ok: need.length > 0, need: [...new Set(need)] };
}

function moneyOf(snap, uid, ctx = {}) {
  const p = player(snap, uid);
  if (ctx.moneyByUid && Object.prototype.hasOwnProperty.call(ctx.moneyByUid, String(uid))) return numOrNull(ctx.moneyByUid[String(uid)]);
  return numOrNull(p && p.money);
}

function lowMoneyInfo(snap, uid, ctx = {}) {
  const targetMoney = moneyOf(snap, uid, ctx);
  if (targetMoney == null) return { ok: false, money: null };
  const values = new Map();
  const members = ((snap && snap.roundPlayers) || []).map(String).filter((u) => (ctx.toolUids || []).map(String).includes(u));
  if (!members.includes(String(uid))) return { ok: false, money: targetMoney };
  for (const u of members) {
    const m = moneyOf(snap, u, ctx);
    if (m == null) return { ok: false, money: targetMoney };
    values.set(String(u), m);
  }
  if (!values.size) return { ok: false, money: targetMoney };
  const min = Math.min(...values.values());
  return { ok: targetMoney <= min, money: targetMoney };
}

function targetPriority(snap, uid, strategy, ctx = {}) {
  if (!player(snap, uid)) return null;
  const caU = strategy.twoPhomCaU ? caUInfo(snap, uid) : { ok: false, need: [] };
  const lowMoney = strategy.lowMoney ? lowMoneyInfo(snap, uid, ctx) : { ok: false, money: null };
  const money = lowMoney.money;
  return {
    uid: String(uid),
    money,
    caU,
    lowMoney,
    score: (caU.ok ? 1000000000 : 0) + (lowMoney.ok ? Math.max(0, 100000000 - money) : 0),
  };
}

function feedableDiscards(snap, fromUid, toUid, strategy, ctx = {}) {
  const fromHand = help.handOf(snap, fromUid) || [];
  const ranking = help.discardRanking(snap, fromUid);
  if (!ranking.ok) return [];
  const legal = legalDiscards(snap, fromUid);
  const byCode = new Map(ranking.ranking.filter((x) => legal.has(x.code)).map((x, i) => [x.code, { ...x, rankIndex: i }]));
  const target = targetPriority(snap, toUid, strategy, ctx);
  if (!target || !(target.lowMoney.ok || target.caU.ok)) return [];
  if (eatCount(snap, toUid) >= 2) return [];
  return fromHand
    .filter((code) => byCode.has(code) && !byCode.get(code).breaksPhom && canEatCard(snap, toUid, code))
    .map((code) => {
      const info = byCode.get(code);
      const helpsCaU = target.caU.need.includes(code);
      return { ...info, helpsCaU, target };
    })
    .filter((x) => x.helpsCaU || target.lowMoney.ok)
    .sort((a, b) => (b.helpsCaU - a.helpsCaU) || (b.target.score - a.target.score) || (a.rankIndex - b.rankIndex) || (cardPoints(a.code) - cardPoints(b.code)));
}

function strategyDiscard(snap, uid, strategyInput, ctx = {}) {
  const strategy = normalizeStrategy(strategyInput);
  if (!(strategy.lowMoney || strategy.twoPhomCaU)) return null;
  const next = nextUidOf(snap, uid);
  if (!next || !(ctx.toolUids || []).map(String).includes(next)) return null;
  const options = feedableDiscards(snap, uid, next, strategy, ctx);
  const best = options[0] || null;
  if (!best) return null;
  const reason = best.helpsCaU ? 'ưu tiên acc 2 phỏm + cạ ù' : 'ưu tiên acc ít tiền · tiền ' + best.target.money;
  return { code: best.code, label: cardLabel(best.code), why: 'Đánh ' + cardLabel(best.code) + ' (' + reason + ')', targetUid: next };
}

// The cards this account must not give the next player. GUEST — the next player is not one of ours (and still plays):
// every card not PROVEN safe from all known hands + public cards, from the first turn. THIRD_EAT — one of ours that
// already ate 2 (a 3rd eat almost always means an ù and a đền): exactly the cards it can eat (its hand is known). The
// pickers take a blocked card only when nothing else is legal — then the least risky one.
function guardDiscards(snap, uid, toolUids = []) {
  const none = { blocked: new Set(), kind: null };
  const next = nextUidOf(snap, uid);
  if (!next || help.nextDone(snap, uid)) return none;
  const ours = (toolUids || []).map(String).includes(next);
  const hand = help.handOf(snap, uid) || [];
  const nextHand = help.handOf(snap, next);
  if (ours) {
    if (eatCount(snap, next) < 2) return none; // one of ours may eat (cạ ù / nuôi ít tiền feed it on purpose)
    if (nextHand && nextHand.length) return { blocked: new Set(hand.filter((c) => canEatCard(snap, next, c))), kind: 'THIRD_EAT' };
  }
  const safe = new Set((help.discardRanking(snap, uid).ranking || []).filter((x) => x.tier === help.TIER.SAFE).map((x) => x.code));
  return { blocked: new Set(hand.filter((c) => !safe.has(c))), kind: ours ? 'THIRD_EAT' : 'GUEST' };
}
const blockedDiscards = (snap, uid, toolUids) => guardDiscards(snap, uid, toolUids).blocked;

function legalDiscards(snap, uid) {
  const hand = help.handOf(snap, uid) || [];
  const locked = help.eatenBy(snap, uid);
  const required = [...locked].filter((c) => hand.includes(c));
  return new Set(hand.filter((code) => !locked.has(code) && (!required.length ||
    help.arrangements(hand.filter((c) => c !== code)).some((a) =>
      required.every((c) => a.melds.some((m) => m.includes(c))) &&
      a.melds.every((m) => m.filter((c) => locked.has(c)).length <= 1)))));
}

// Count public completion cards, rather than valuing all live pairs equally.
function liveOuts(hand, out) {
  const result = new Set();
  for (const code of hand) for (const x of rankPartners(code).concat(runWindows(code).flat())) {
    if (isValidCardCode(x) && !out.has(x) && !hand.includes(x) && meldsWith(x, hand).length) result.add(x);
  }
  return result.size;
}

// the discard before the hạ turn: legal, not blocked (unless every card is), and — when one of ours plays next — the
// cạ chances weighed by the turns left (keeping phỏm and safety still come first). A GUEST next: a proven-safe card in
// the ranking's order — loose, then out of a cạ, then out of a phỏm (móm accepted); none proven safe → the fewest ways
// to be eaten (likely safe first), a phỏm broken for it too.
function regularDiscard(snap, uid, guard, enrich) {
  const blocked = guard.blocked;
  const result = help.discardRanking(snap, uid);
  if (!result.recommended) return null;
  const legalCodes = legalDiscards(snap, uid);
  const legal = result.ranking.filter((c) => legalCodes.has(c.code));
  const candidates = legal.filter((c) => !blocked.has(c.code));
  if (!candidates.length && guard.kind === 'GUEST') {
    return legal.slice().sort((a, b) => (a.tier - b.tier) || (a.openWays - b.openWays) || (a.breaksPhom - b.breaksPhom) || (a.pointsLeft - b.pointsLeft) || (a.code - b.code))[0] || null;
  }
  const choices = candidates.length ? candidates : legal;
  if (!choices.length) return null;
  if (!enrich || help.turnInfo(snap, uid).last) return choices[0];
  const hand = help.handOf(snap, uid);
  const out = help.outFor(snap, uid);
  const remaining = 4 - help.turnInfo(snap, uid).turn;
  return choices.map((c) => {
    const rest = help.bestArrangement(hand.filter((x) => x !== c.code));
    return { ...c, score: c.pointsLeft - liveOuts(rest.loose, out) * remaining * 2 };
  }).sort((a, b) => (a.breaksPhom - b.breaksPhom) || (a.tier - b.tier) || (a.score - b.score) || (b.cardPoints - a.cardPoints) || (a.code - b.code))[0];
}

function takeEvaluation(snap, uid, code) {
  const hand = help.handOf(snap, uid) || [];
  const locked = help.eatenBy(snap, uid);
  const outcome = (incoming, taken) => {
    let best = Infinity;
    for (const a of help.arrangements(hand.concat(incoming))) {
      if (taken && !a.melds.some((m) => m.includes(incoming))) continue;
      if ([...locked].filter((c) => hand.includes(c)).some((c) => !a.melds.some((m) => m.includes(c)))) continue;
      if (a.melds.some((m) => m.filter((c) => locked.has(c) || taken && c === incoming).length > 1)) continue;
      // One loose card is discarded; all other loose cards remain as points.
      const score = a.points - Math.max(0, ...a.loose.map(cardPoints));
      best = Math.min(best, score);
    }
    return best;
  };
  const taken = outcome(code, true);
  const known = new Set(hand.concat(code));
  for (const e of snap.ledger || []) known.add(e.code); // every known card (all known hands + public)
  const drawScores = Array.from({ length: 52 }, (_, c) => c).filter((c) => !known.has(c)).map((c) => outcome(c, false)).filter(Number.isFinite);
  const drawn = drawScores.length ? drawScores.reduce((a, b) => a + b, 0) / drawScores.length : Infinity;
  return { take: Number.isFinite(taken) && taken <= drawn, taken, drawn };
}

// ĂN or BỐC — Ăn only when the card makes a phỏm AND the expected points after it are not worse than a draw's
function takeStep(snap, uid, on, avoid) {
  const t = help.takeInfo(snap, uid);
  if (t.ok && t.canTake && on.has('AN') && !avoid.has('AN') && canEatCard(snap, uid, t.card.code)) {
    const e = takeEvaluation(snap, uid, t.card.code);
    if (e.take || !on.has('BOC')) return { action: 'AN', cards: [], why: 'Ăn ' + t.card.label + ' (phỏm ' + labels(t.meld) + ' · điểm dự kiến ' + e.taken + ')' };
    return { action: 'BOC', cards: [], why: 'Bốc (điểm dự kiến ' + e.drawn.toFixed(1) + ' tốt hơn ăn ' + e.taken + ')' };
  }
  if (on.has('BOC')) return { action: 'BOC', cards: [], why: 'Bốc' };
  return { wait: true, why: 'Chờ game hiện nút Bốc' };
}

const blockedNote = (guard, code) => (!guard.blocked.size ? '' : guard.kind === 'GUEST' ? ' · khách ngồi sau' : ' · chặn ăn lần 3')
  + (guard.blocked.has(code) ? (guard.kind === 'GUEST' ? ' · không có lá chắc chắn an toàn' : ' · không có lá tránh ăn hợp lệ') : '');

// the hạ turn: ① Hạ the plan → ② Gửi what fits now → ③ Đánh the plan's discard
function lastTurnStep(snap, uid, on, avoid, guard, options) {
  const blocked = guard.blocked;
  const me = snap.players[String(uid)] || {};
  const laid = (me.melds || []).length > 0;
  if (!laid && !avoid.has('HA')) {
    const ha = help.haPlan(snap, uid, { blocked });
    if (ha.ok) {
      if (!on.has('HA')) return { wait: true, why: 'Chờ game hiện nút Hạ' };
      return { action: 'HA', cards: ha.cards.slice(), why: '① Hạ ' + ha.melds.map(labels).join(' · ') };
    }
    // móm: nothing to lay, nothing to send — the safest discard
  }
  // a Hạ the game refused: the turn goes on with the discard (móm beats the game's timer playing a card of its choosing)
  const fin = help.finishPlan(snap, uid, { blocked });
  if (!fin.ok) return { wait: true, why: 'Hết bài rác' };
  if (laid && fin.sendCards.length && !avoid.has('GUI')) {
    // only what fits the table NOW; a card that fits only after another one is sent goes on the next press
    const fitsNow = new Set(help.sendTargets(snap, uid).map((x) => x.code));
    const now = fin.send.filter((x) => fitsNow.has(x.code));
    if (now.length) {
      if (!on.has('GUI')) return { wait: true, why: 'Chờ game hiện nút Gửi' };
      return { action: 'GUI', cards: now.map((x) => x.code), why: '② Gửi ' + now.map((x) => x.label).join(' ') };
    }
  }
  if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
  const strategic = strategyDiscard(snap, uid, options.strategy || DEFAULT_STRATEGY, options);
  if (strategic) return { action: 'DANH', cards: [strategic.code], why: strategic.why };
  return { action: 'DANH', cards: [fin.discard.code], why: '③ Đánh ' + fin.discard.label + ' (' + fin.discard.tierLabel.toLowerCase() + ')' + blockedNote(guard, fin.discard.code) };
}

function nextStep(snap, uid, offered, avoid = new Set(), toolUids = [], options = {}) {
  const on = new Set(offered || []);
  if (!on.size) return { wait: true, why: 'Chưa tới lượt' };
  if (on.has('BAO_U')) return { action: 'BAO_U', cards: [], why: 'Ù' };
  // Bốc / Ăn first: a draw needs no hand (a missed deal must not cost the turn); an eat is weighed from what is known
  if (on.has('BOC') || on.has('AN')) return takeStep(snap, uid, on, avoid);
  const g = tableGuard(snap, toolUids, uid);
  if (!g.ok) return g.stop ? { stop: true, code: g.code, message: g.message } : { wait: true, why: g.message };
  if (!(help.handOf(snap, uid) || []).length) return { wait: true, why: 'Chưa thấy bài trên tay' };
  options = { ...options, toolUids };
  if (!(on.has('DANH') || on.has('HA') || on.has('GUI'))) return { wait: true, why: 'Chưa tới lượt đánh' };
  const guard = guardDiscards(snap, uid, toolUids);
  // the hạ turn is the game's: Hạ / Gửi shown, or this account already laid this round. Only Đánh shown while the tool's
  // count says "last" → the game says not yet (an eaten card gives its discarder one more turn) — a discard now.
  const laid = (((snap.players || {})[String(uid)] || {}).melds || []).length > 0;
  if (on.has('HA') || on.has('GUI') || laid) return lastTurnStep(snap, uid, on, avoid, guard, options);
  const strategic = strategyDiscard(snap, uid, options.strategy || DEFAULT_STRATEGY, options);
  if (strategic) {
    if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
    return { action: 'DANH', cards: [strategic.code], why: strategic.why };
  }
  if (!help.discardRanking(snap, uid).recommended) return { wait: true, why: 'Không có lá để đánh' };
  if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
  const chosen = regularDiscard(snap, uid, guard, toolUids.map(String).includes(nextUidOf(snap, uid)));
  if (!chosen) return { wait: true, why: 'Chưa có lá đánh giữ được phỏm chứa lá ăn' };
  return { action: 'DANH', cards: [chosen.code], why: 'Đánh ' + chosen.label + ' (' + chosen.tierLabel.toLowerCase() + ')' + blockedNote(guard, chosen.code) };
}

// LƯỚI AN TOÀN — a wait while the game offers Đánh must never run into the game's own timer (it discards a card of its
// own choosing for the account, unfiltered — live 2026-10-10): the safest legal discard for this table, guard included.
function fallbackStep(snap, uid, toolUids = []) {
  const guard = guardDiscards(snap, uid, toolUids);
  const chosen = regularDiscard(snap, uid, guard, false);
  if (chosen) return { action: 'DANH', cards: [chosen.code], why: 'Đánh ' + chosen.label + ' (' + chosen.tierLabel.toLowerCase() + ' · game chờ lâu)' + blockedNote(guard, chosen.code) };
  // the tool's eat rules found no legal card (its picture is off): any card not eaten, else any card — the game decides
  const hand = help.handOf(snap, uid) || [];
  const eaten = help.eatenBy(snap, uid);
  const legal = [...legalDiscards(snap, uid)];
  const notEaten = hand.find((c) => !eaten.has(c));
  const any = legal.length ? legal[0] : (notEaten != null ? notEaten : hand[0]);
  return any != null ? { action: 'DANH', cards: [any], why: 'Đánh ' + cardLabel(any) + ' (game chờ lâu)' } : null;
}

// HẠN LƯỢT — a wait ran out while the game offers a button: the best step the shown buttons allow, never a wait.
// Đánh → the safest discard; only Hạ shown → the hạ plan (unless the game refused it); else null (nothing to press).
function forcedStep(snap, uid, offered, avoid = new Set(), toolUids = []) {
  const on = new Set(offered || []);
  if (on.has('BAO_U')) return { action: 'BAO_U', cards: [], why: 'Ù' };
  if (on.has('BOC')) return { action: 'BOC', cards: [], why: 'Bốc (game chờ lâu)' };
  if (on.has('DANH')) return fallbackStep(snap, uid, toolUids);
  if (on.has('HA') && !avoid.has('HA')) {
    const ha = help.haPlan(snap, uid);
    if (ha.ok) return { action: 'HA', cards: ha.cards.slice(), why: 'Hạ ' + ha.melds.map(labels).join(' · ') + ' (game chờ lâu)' };
  }
  return null;
}

const stepKey = (s) => (s && s.action ? s.action + ':' + (s.cards || []).join(',') : '');

// Recompute decisions when any known hand or card location changes (every known hand counts — 2026-10-11).
function stateKey(snap, uid, toolUids = []) {
  const p = (snap && snap.players && snap.players[String(uid)]) || {};
  const sorted = (xs) => (xs || []).slice().sort((a, b) => a - b);
  const knownHands = Object.entries((snap && snap.players) || {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([u, x]) => [u, !!x.controlled, sorted(x.currentCards), (x.melds || []).map((m) => sorted(m.cards)), sorted(x.sentCards), (x.discardedHistory || []).length, (x.drawnHistory || []).length]);
  const ledger = ((snap && snap.ledger) || []).map((e) => [e.code, e.status, e.ownerUid]);
  return JSON.stringify([snap && snap.roundSeq, snap && snap.roundPlayers, sorted(p.currentCards), knownHands, ledger,
    ((snap && snap.observedDiscardEvents) || []).length, ((snap && snap.eats) || []).map((e) => [e.card, e.eaterUid]),
    (snap && snap.nextOf) || {}, (toolUids || []).map(String).sort()]);
}

module.exports = { DEFAULT_STRATEGY, tableGuard, nextStep, stepKey, stateKey, normalizeStrategy, strategyDiscard, caUInfo, takeEvaluation,
  legalDiscards, blockedDiscards, guardDiscards, fallbackStep, forcedStep };
