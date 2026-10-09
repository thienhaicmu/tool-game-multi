'use strict';

// ---------------------------------------------------------------------------
// TỰ ĐÁNH (pure) — the next press for ONE account, following docs/phom-danh-bai.md turn by turn. User 2026-10-09:
// switched on per account (P1/P2/P3) by the user, and ONLY at a table where every player of the round is one of the
// tool's accounts — a player outside the tool in the round stops it (a table with real players stays manual).
//
//   tableGuard(snap, toolUids)             every uid of the round (DEAL lpi) is one of the tool's accounts (P1–P3 or a reserve)?
//   nextStep(snap, uid, offered, avoid, toolUids) → { action, cards, why } | { wait, why } | { stop, code, message }
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

// toolUids: the uids of every browser of the session (playing slots AND reserves) — a reserve is ours, never a stranger
function tableGuard(snap, toolUids = []) {
  const ours = new Set(Object.values((snap && snap.slotBinding) || {}).filter((u) => u != null).map(String).concat((toolUids || []).map(String)));
  const players = ((snap && snap.roundPlayers) || []).map(String);
  if (!players.length) return { ok: false, code: 'AUTO_NO_ROUND', message: 'Chưa chia bài' };
  const strangers = players.filter((u) => !ours.has(u));
  if (strangers.length) return { ok: false, stop: true, code: 'AUTO_STRANGER', message: 'Có người chơi ngoài tool trong ván — đã tắt Tự đánh' };
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

module.exports = { tableGuard, nextStep, stepKey };
