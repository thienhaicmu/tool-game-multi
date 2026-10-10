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
//   Đánh shown, the last turn (Đ4)         → ① Hạ the plan's phỏm → ② Gửi what fits now → ③ Đánh the plan's discard
// avoid = steps the game did not take (an Ăn the game refused falls back to Bốc).
// ---------------------------------------------------------------------------

const help = require('./phom-play-help.cjs');
const { isValidCardCode, decodeCard } = require('./card-codec.cjs');
const { rankPartners, runWindows, cardPoints } = require('./phom-rules.cjs');

const labels = (cards) => (cards || []).map((x) => x.label).join(' ');
const cardLabel = (code) => decodeCard(code).label;
const DEFAULT_STRATEGY = Object.freeze({ lowMoney: false, twoPhomCaU: false, blockThirdEat: true });

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
  twoPhomCaU: x.twoPhomCaU === true,
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

// Chặn ăn lần 3 — ALWAYS on, whoever plays next (user 2026-10-10): a 3rd eat almost always means an ù and a đền.
// A tool account's hand is known: exactly the cards it can eat. An outsider's is hidden: every card not PROVEN safe
// from the public view (its two eaten cards are public, so they never count as partners).
function blockedDiscards(snap, uid, toolUids) {
  const next = nextUidOf(snap, uid);
  if (!next || eatCount(snap, next) < 2 || help.nextDone(snap, uid)) return new Set();
  const hand = help.handOf(snap, uid) || [];
  const nextHand = help.handOf(snap, next);
  if (toolUids.map(String).includes(next) && nextHand && nextHand.length) return new Set(hand.filter((c) => canEatCard(snap, next, c)));
  const r = help.discardRanking(snap, uid);
  const safe = new Set((r.ranking || []).filter((x) => x.tier === help.TIER.SAFE).map((x) => x.code));
  return new Set(hand.filter((c) => !safe.has(c)));
}

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

function regularDiscard(snap, uid, blocked, enrich) {
  const result = help.discardRanking(snap, uid);
  if (!result.recommended) return null;
  const legalCodes = legalDiscards(snap, uid);
  const legal = result.ranking.filter((c) => legalCodes.has(c.code));
  const candidates = legal.filter((c) => !blocked.has(c.code));
  const choices = candidates.length ? candidates : legal;
  if (!choices.length) return null;
  if (!enrich || help.turnInfo(snap, uid).last) return choices[0];
  const hand = help.handOf(snap, uid);
  const out = new Set((help.publicView(snap, uid).ledger || []).filter((e) => ['DISCARDED', 'MELDED', 'EATEN'].includes(e.status)).map((e) => e.code));
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
  for (const e of help.publicView(snap, uid).ledger || []) known.add(e.code);
  const drawScores = Array.from({ length: 52 }, (_, c) => c).filter((c) => !known.has(c)).map((c) => outcome(c, false)).filter(Number.isFinite);
  const drawn = drawScores.length ? drawScores.reduce((a, b) => a + b, 0) / drawScores.length : Infinity;
  return { take: Number.isFinite(taken) && taken <= drawn, taken, drawn };
}

function nextStep(snap, uid, offered, avoid = new Set(), toolUids = [], options = {}) {
  const on = new Set(offered || []);
  if (!on.size) return { wait: true, why: 'Chưa tới lượt' };
  if (on.has('BAO_U')) return { action: 'BAO_U', cards: [], why: 'Ù' };
  const g = tableGuard(snap, toolUids, uid);
  if (!g.ok) return g.stop ? { stop: true, code: g.code, message: g.message } : { wait: true, why: g.message };
  const hand = help.handOf(snap, uid);
  if (!hand || !hand.length) return { wait: true, why: 'Chưa thấy bài trên tay' };
  options = { ...options, toolUids };
  const blocked = blockedDiscards(snap, uid, toolUids);
  const protection = blocked.size ? ' · chặn ăn lần 3' : '';

  // step 1 — Ăn or Bốc
  if (on.has('BOC') || on.has('AN')) {
    const t = help.takeInfo(snap, uid);
    if (t.ok && t.canTake && canEatCard(snap, uid, t.card.code) && on.has('AN') && !avoid.has('AN')) {
      const comparison = takeEvaluation(snap, uid, t.card.code);
      if (comparison.take || !on.has('BOC')) return { action: 'AN', cards: [], why: 'Ăn ' + t.card.label + ' (phỏm ' + labels(t.meld) + ' · điểm dự kiến ' + comparison.taken + ')' };
      return { action: 'BOC', cards: [], why: 'Bốc (điểm dự kiến ' + comparison.drawn.toFixed(1) + ' tốt hơn ăn ' + comparison.taken + ')' };
    }
    if (on.has('BOC')) return { action: 'BOC', cards: [], why: 'Bốc' };
    return { wait: true, why: 'Chờ game hiện nút Bốc' };
  }

  // step 2 — the discard (+ hạ / gửi on the last turn)
  if (!(on.has('DANH') || on.has('HA') || on.has('GUI'))) return { wait: true, why: 'Chưa tới lượt đánh' };
  const turn = help.turnInfo(snap, uid);
  if (!turn.last && !on.has('HA') && !on.has('GUI')) {
    const strategic = strategyDiscard(snap, uid, options.strategy || DEFAULT_STRATEGY, options);
    if (strategic) {
      if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
      return { action: 'DANH', cards: [strategic.code], why: strategic.why };
    }
    const d = help.discardRanking(snap, uid);
    if (!d.recommended) return { wait: true, why: 'Không có lá để đánh' };
    if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
    const chosen = regularDiscard(snap, uid, blocked, toolUids.map(String).includes(nextUidOf(snap, uid)));
    if (!chosen) return { wait: true, why: 'Chưa có lá đánh giữ được phỏm chứa lá ăn' };
    return { action: 'DANH', cards: [chosen.code], why: 'Đánh ' + chosen.label + ' (' + chosen.tierLabel.toLowerCase() + ')' + protection + (blocked.has(chosen.code) ? ' · không có lá tránh ăn hợp lệ' : '') };
  }
  const me = snap.players[String(uid)] || {};
  const laid = (me.melds || []).length > 0;
  if (!laid) {
    const ha = help.haPlan(snap, uid, { blocked });
    if (ha.ok) {
      if (!on.has('HA') || avoid.has('HA')) return { wait: true, why: 'Chờ game hiện nút Hạ' };
      return { action: 'HA', cards: ha.cards.slice(), why: '① Hạ ' + ha.melds.map(labels).join(' · ') };
    }
    // no phỏm to lay (móm): nothing can be sent either — the safest discard
  }
  const fin = help.finishPlan(snap, uid, { blocked });
  if (!fin.ok) return { wait: true, why: 'Hết bài rác' };
  if (laid && fin.sendCards.length && !avoid.has('GUI')) {
    // only what fits the table NOW; a card that fits only after another one is sent goes on the next press
    const fitsNow = new Set(help.sendTargets(snap, uid).map((x) => x.code));
    const now = fin.sendCards.filter((c) => fitsNow.has(c));
    if (now.length) {
      if (!on.has('GUI')) return { wait: true, why: 'Chờ game hiện nút Gửi' };
      return { action: 'GUI', cards: now, why: '② Gửi ' + fin.send.filter((x) => fitsNow.has(x.code)).map((x) => x.label).join(' ') };
    }
  }
  if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
  const strategic = strategyDiscard(snap, uid, options.strategy || DEFAULT_STRATEGY, options);
  return { action: 'DANH', cards: [strategic ? strategic.code : fin.discard.code], why: strategic ? strategic.why : '③ Đánh ' + fin.discard.label + ' (' + fin.discard.tierLabel.toLowerCase() + ')' + protection + (blocked.has(fin.discard.code) ? ' · không có lá tránh ăn hợp lệ' : '') };
}

const stepKey = (s) => (s && s.action ? s.action + ':' + (s.cards || []).join(',') : '');

// What THIS account's next step depends on for press de-duplication.
function stateKey(snap, uid, toolUids = []) {
  const p = (snap && snap.players && snap.players[String(uid)]) || {};
  const next = nextUidOf(snap, uid);
  const target = toolUids.map(String).includes(next) ? (help.handOf(snap, next) || []).slice().sort((a, b) => a - b).join('.') : '';
  return [
    snap && snap.roundSeq, ((snap && snap.roundPlayers) || []).join('.'),
    (p.currentCards || []).slice().sort((a, b) => a - b).join('.'),
    JSON.stringify(help.laidOnTable(snap)), (p.discardedHistory || []).length, (p.sentCards || []).length,
    ((snap && snap.observedDiscardEvents) || []).length, ((snap && snap.eats) || []).length,
    JSON.stringify(snap && snap.nextOf || {}), target,
  ].join('|');
}

module.exports = { tableGuard, nextStep, stepKey, stateKey, normalizeStrategy, strategyDiscard, caUInfo, takeEvaluation };
