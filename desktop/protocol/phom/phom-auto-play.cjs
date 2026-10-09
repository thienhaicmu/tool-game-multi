'use strict';

// ---------------------------------------------------------------------------
// TỰ ĐÁNH (pure) — the next press for ONE account, following docs/phom-danh-bai.md turn by turn. User 2026-10-09:
// switched on per account (P1/P2/P3) by the user. A round may include players outside the tool; choices still use
// only this account's own hand plus public facts.
//
//   tableGuard(snap, toolUids)             the current round is known (DEAL lpi observed)
//   nextStep(snap, uid, offered, avoid, toolUids) → { action, cards, why } | { wait, why } | { stop, code, message }
//   stateKey(snap, uid)                    changes when something THIS account's step depends on changed
//
// offered = the game's buttons shown right now (play-actions buildOfferedScript); the step is one of them:
//   Ù shown                                → BAO_U
//   Bốc / Ăn shown (Đ1–Đ4, step 1)          → Ăn when the card just discarded makes a phỏm, else Bốc
//   Đánh shown, a turn before the last     → Đánh the card "Nên đánh" (không bị ăn → giữ cạ → điểm)
//   Đánh shown, the last turn (Đ4)         → ① Hạ the plan's phỏm → ② Gửi what fits now → ③ Đánh the plan's discard
// The help it reads is the ĐÁNH BÀI help (own hand + public facts only). avoid = steps the game did not take (an Ăn
// the game refused falls back to Bốc).
// ---------------------------------------------------------------------------

const help = require('./phom-play-help.cjs');

const labels = (cards) => (cards || []).map((x) => x.label).join(' ');

// toolUids is kept for API compatibility; auto-play no longer stops just because a round includes outside players.
function tableGuard(snap, toolUids = []) {
  void toolUids;
  const players = ((snap && snap.roundPlayers) || []).map(String);
  if (!players.length) return { ok: false, code: 'AUTO_NO_ROUND', message: 'Chưa chia bài' };
  return { ok: true };
}

function nextStep(snap, uid, offered, avoid = new Set(), toolUids = []) {
  const g = tableGuard(snap, toolUids);
  if (!g.ok) return g.stop ? { stop: true, code: g.code, message: g.message } : { wait: true, why: g.message };
  const on = new Set(offered || []);
  if (!on.size) return { wait: true, why: 'Chưa tới lượt' };
  if (on.has('BAO_U')) return { action: 'BAO_U', cards: [], why: 'Ù' };
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
  if (laid && fin.sendCards.length && on.has('GUI') && !avoid.has('GUI')) {
    // only what fits the table NOW; a card that fits only after another one is sent goes on the next press
    const fitsNow = new Set(help.sendTargets(snap, uid).map((x) => x.code));
    const now = fin.sendCards.filter((c) => fitsNow.has(c));
    if (now.length) return { action: 'GUI', cards: now, why: '② Gửi ' + fin.send.filter((x) => fitsNow.has(x.code)).map((x) => x.label).join(' ') };
  }
  if (!on.has('DANH')) return { wait: true, why: 'Chờ game hiện nút Đánh' };
  return { action: 'DANH', cards: [fin.discard.code], why: '③ Đánh ' + fin.discard.label + ' (' + fin.discard.tierLabel.toLowerCase() + ')' };
}

const stepKey = (s) => (s && s.action ? s.action + ':' + (s.cards || []).join(',') : '');

// What THIS account's next step depends on: its own hand / phỏm / discards / sends + the public pile and eats. A frame
// that changes only another account's own hand leaves it alone — so it neither re-opens a press that already went out
// nor forgets an Ăn the game refused (with three accounts on, their frames arrive all the time).
function stateKey(snap, uid) {
  const p = (snap && snap.players && snap.players[String(uid)]) || {};
  return [
    snap && snap.roundSeq, ((snap && snap.roundPlayers) || []).join('.'),
    (p.currentCards || []).slice().sort((a, b) => a - b).join('.'),
    (p.melds || []).map((m) => (m.cards || []).length).join('.'), (p.discardedHistory || []).length, (p.sentCards || []).length,
    ((snap && snap.observedDiscardEvents) || []).length, ((snap && snap.eats) || []).length,
  ].join('|');
}

module.exports = { tableGuard, nextStep, stepKey, stateKey };
