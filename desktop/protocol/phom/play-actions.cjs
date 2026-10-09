'use strict';

// ---------------------------------------------------------------------------
// PLAY ACTIONS (3.2 phase 5) — Bốc / Ăn / Đánh / Hạ / Gửi pressed from the tool window, one click = one action.
//
// The tool presses the GAME'S OWN button handler (PhomController.onBtn…, read from the game's project bundle
// 2026-10-09) — the exact code a tap on that button runs, with the game's own checks and messages. It never sends a
// play frame itself, never decides a move, and acts ONLY when the game is offering that button right now (the button
// node is shown): a click while it is not this account's turn is refused here with a plain message.
//
//   BOC  btnRutBai  → onBtnRutBai   (requestDrawCard)
//   AN   btnAnBai   → onBtnAnBai    (requestTakeCard of the card on offer)
//   DANH btnDanhBai → onBtnDanhBai  (requestPlayCard of the ONE selected card) — the tool may name that card: it is
//                     selected first with the hand's own setListCardSelected([serverCode]) (serverCode = the wire code)
//   HA   btnHaPhom  → onBtnHaPhom   (requestHaPhom of the selected cards — the game's own selection / suggestion)
//   GUI  btnGuiBai  → onBtnGuiBai   (requestGuiBai of the selected cards)
// ---------------------------------------------------------------------------

const ACTIONS = Object.freeze({
  BOC: Object.freeze({ btn: 'btnRutBai', handler: 'onBtnRutBai', label: 'Bốc' }),
  AN: Object.freeze({ btn: 'btnAnBai', handler: 'onBtnAnBai', label: 'Ăn' }),
  DANH: Object.freeze({ btn: 'btnDanhBai', handler: 'onBtnDanhBai', label: 'Đánh', card: true }),
  HA: Object.freeze({ btn: 'btnHaPhom', handler: 'onBtnHaPhom', label: 'Hạ' }),
  GUI: Object.freeze({ btn: 'btnGuiBai', handler: 'onBtnGuiBai', label: 'Gửi' }),
});

// → { ok, action, card } or { ok:false, error }
function validatePlayAction({ action, card } = {}) {
  const a = String(action || '').toUpperCase();
  const spec = ACTIONS[a];
  if (!spec) return { ok: false, error: { code: 'PHOM_PLAY_UNKNOWN', message: `Không có thao tác ${action}` } };
  if (card != null && !spec.card) return { ok: false, error: { code: 'PHOM_PLAY_NO_CARD', message: `${spec.label} không chọn lá từ tool` } };
  if (card != null && !(Number.isInteger(Number(card)) && Number(card) >= 0 && Number(card) < 52)) return { ok: false, error: { code: 'PHOM_PLAY_BAD_CARD', message: 'Lá bài không hợp lệ' } };
  return { ok: true, action: a, card: card != null ? Number(card) : null };
}

// The page expression (runs in that browser's top document) → { ok, code, message }. Never throws.
function buildPlayActionScript({ action, card = null }) {
  const spec = ACTIONS[action];
  if (!spec) throw new Error('unknown play action ' + action);
  const A = JSON.stringify({ action, btn: spec.btn, handler: spec.handler, label: spec.label, card });
  return `(() => {
  try {
    const A = ${A};
    const cc = window.cc;
    const scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
    const c = scene && scene.getComponentInChildren ? scene.getComponentInChildren('PhomController') : null;
    if (!c) return { ok: false, code: 'PHOM_PLAY_NOT_AT_TABLE', message: 'Acc này chưa ở bàn Phỏm' };
    const node = c[A.btn];
    const button = node && node.getComponent && cc.Button ? node.getComponent(cc.Button) : null;
    if (!node || !node.activeInHierarchy || (button && button.interactable === false)) return { ok: false, code: 'PHOM_PLAY_NOT_OFFERED', message: 'Game chưa cho ' + A.label + ' lúc này' };
    if (typeof c[A.handler] !== 'function') return { ok: false, code: 'PHOM_PLAY_NO_HANDLER', message: 'Game đổi bản — không tìm thấy nút ' + A.label };
    if (A.card != null) {
      const hand = c.myCardSet;
      const ids = hand && hand.getListCardID ? hand.getListCardID() : [];
      if (!ids.some((x) => Number(x) === A.card)) return { ok: false, code: 'PHOM_PLAY_CARD_NOT_IN_HAND', message: 'Lá này không còn trên tay' };
      hand.setListCardSelected([ids.find((x) => Number(x) === A.card)]);
    }
    c[A.handler]();
    return { ok: true, code: 'PHOM_PLAY_PRESSED', action: A.action };
  } catch (e) { return { ok: false, code: 'PHOM_PLAY_PAGE_ERROR', message: String((e && e.message) || e).slice(0, 200) }; }
})()`;
}

module.exports = { ACTIONS, validatePlayAction, buildPlayActionScript };
