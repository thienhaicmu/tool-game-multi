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
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const normalizeStrategy = (x = {}) => ({
  lowMoney: x.lowMoney === true,
  twoPhomCaU: x.twoPhomCaU === true,
  blockThirdEat: x.blockThirdEat !== false,
});

function eatCount(snap, uid) {
  return ((snap && snap.eats) || []).filter((e) => String(e.eaterUid != null ? e.eaterUid : e.eater) === String(uid)).length;
}

function meldsWith(code, hand) {
  return help.allMelds((hand || []).concat(code)).filter((m) => m.includes(code));
}

function canEatCard(snap, eaterUid, code) {
  const hand = help.handOf(snap, eaterUid) || [];
  return meldsWith(code, hand).length > 0;
}

function bestMeldCount(hand) {
  return help.bestArrangement((hand || []).filter(isValidCardCode)).melds.length;
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
      if (bestMeldCount(hand.concat(x)) > arranged.melds.length) need.push(x);
    }
  }
  return { ok: need.length > 0, need: [...new Set(need)] };
}

function moneyOf(snap, uid, ctx = {}) {
  const p = player(snap, uid);
  const fromCtx = ctx.moneyByUid && Object.prototype.hasOwnProperty.call(ctx.moneyByUid, String(uid)) ? ctx.moneyByUid[String(uid)] : null;
  return numOrNull(fromCtx != null ? fromCtx : p && p.money);
}

function lowMoneyInfo(snap, uid, ctx = {}) {
  const targetMoney = moneyOf(snap, uid, ctx);
  if (targetMoney == null) return { ok: false, money: null };
  const values = new Map();
  for (const u of ((snap && snap.roundPlayers) || [])) {
    const m = moneyOf(snap, u, ctx);
    if (m != null) values.set(String(u), m);
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
  const byCode = new Map(ranking.ranking.map((x, i) => [x.code, { ...x, rankIndex: i }]));
  const target = targetPriority(snap, toUid, strategy, ctx);
  if (!target || !(target.lowMoney.ok || target.caU.ok)) return [];
  if (strategy.blockThirdEat && eatCount(snap, toUid) >= 2 && !target.caU.ok) return [];
  return fromHand
    .filter((code) => byCode.has(code) && !byCode.get(code).breaksPhom && canEatCard(snap, toUid, code))
    .map((code) => {
      const info = byCode.get(code);
      const targetHand = help.handOf(snap, toUid) || [];
      const helpsCaU = target.caU.need.includes(code) || bestMeldCount(targetHand.concat(code)) > bestMeldCount(targetHand);
      return { ...info, helpsCaU, target };
    })
    .filter((x) => !strategy.twoPhomCaU || !target.caU.ok || x.helpsCaU)
    .sort((a, b) => (b.helpsCaU - a.helpsCaU) || (b.target.score - a.target.score) || (a.rankIndex - b.rankIndex) || (cardPoints(a.code) - cardPoints(b.code)));
}

function strategyDiscard(snap, uid, strategyInput, ctx = {}) {
  const strategy = normalizeStrategy(strategyInput);
  if (!(strategy.lowMoney || strategy.twoPhomCaU)) return null;
  const next = nextUidOf(snap, uid);
  if (!next) return null;
  const options = feedableDiscards(snap, uid, next, strategy, ctx);
  const best = options[0] || null;
  if (!best) return null;
  const reason = best.target.caU.ok ? 'ưu tiên acc 2 phỏm + cạ ù' : 'ưu tiên acc ít tiền';
  return { code: best.code, label: cardLabel(best.code), why: 'Đánh ' + cardLabel(best.code) + ' (' + reason + ')', targetUid: next };
}

function nextStep(snap, uid, offered, avoid = new Set(), toolUids = [], options = {}) {
  const on = new Set(offered || []);
  if (!on.size) return { wait: true, why: 'Chưa tới lượt' };
  if (on.has('BAO_U')) return { action: 'BAO_U', cards: [], why: 'Ù' };
  const g = tableGuard(snap, toolUids, uid);
  if (!g.ok) return g.stop ? { stop: true, code: g.code, message: g.message } : { wait: true, why: g.message };
  const hand = help.handOf(snap, uid);
  if (!hand || !hand.length) return { wait: true, why: 'Chưa thấy bài trên tay' };

  // step 1 — Ăn or Bốc
  if (on.has('BOC') || on.has('AN')) {
    const t = help.takeInfo(snap, uid);
    if (t.ok && t.canTake && on.has('AN') && !avoid.has('AN')) return { action: 'AN', cards: [], why: 'Ăn ' + t.card.label + ' (phỏm ' + labels(t.meld) + ')' };
    if (on.has('BOC')) return { action: 'BOC', cards: [], why: 'Bốc' };
    return { wait: true, why: 'Chờ game hiện nút Bốc' };
  }

  // step 2 — the discard (+ hạ / gửi on the last turn)
  if (!(on.has('DANH') || on.has('HA') || on.has('GUI'))) return { wait: true, why: 'Chưa tới lượt đánh' };
  const turn = help.turnInfo(snap, uid);
  if (!turn.last) {
    const strategic = strategyDiscard(snap, uid, options.strategy || DEFAULT_STRATEGY, options);
    if (strategic) {
      if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
      return { action: 'DANH', cards: [strategic.code], why: strategic.why };
    }
    const d = help.discardRanking(snap, uid);
    if (!d.recommended) return { wait: true, why: 'Không có lá để đánh' };
    if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
    return { action: 'DANH', cards: [d.recommended.code], why: 'Đánh ' + d.recommended.label + ' (' + d.recommended.tierLabel.toLowerCase() + ')' };
  }
  const me = snap.players[String(uid)] || {};
  const laid = (me.melds || []).length > 0;
  if (!laid) {
    const ha = help.haPlan(snap, uid);
    if (ha.ok) {
      if (!on.has('HA') || avoid.has('HA')) return { wait: true, why: 'Chờ game hiện nút Hạ' };
      return { action: 'HA', cards: ha.cards.slice(), why: '① Hạ ' + ha.melds.map(labels).join(' · ') };
    }
    // no phỏm to lay (móm): nothing can be sent either — the safest discard
  }
  const fin = help.finishPlan(snap, uid);
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
  return { action: 'DANH', cards: [fin.discard.code], why: '③ Đánh ' + fin.discard.label + ' (' + fin.discard.tierLabel.toLowerCase() + ')' };
}

const stepKey = (s) => (s && s.action ? s.action + ':' + (s.cards || []).join(',') : '');

// What THIS account's next step depends on for press de-duplication.
function stateKey(snap, uid) {
  const p = (snap && snap.players && snap.players[String(uid)]) || {};
  return [
    snap && snap.roundSeq, ((snap && snap.roundPlayers) || []).join('.'),
    (p.currentCards || []).slice().sort((a, b) => a - b).join('.'),
    (p.melds || []).map((m) => (m.cards || []).length).join('.'), (p.discardedHistory || []).length, (p.sentCards || []).length,
    ((snap && snap.observedDiscardEvents) || []).length, ((snap && snap.eats) || []).length,
  ].join('|');
}

module.exports = { tableGuard, nextStep, stepKey, stateKey, normalizeStrategy, strategyDiscard, caUInfo };
