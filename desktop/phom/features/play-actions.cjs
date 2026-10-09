'use strict';

// ---------------------------------------------------------------------------
// FEATURE play-actions — Bốc / Ăn / Đánh / Hạ / Gửi from the tool window (protocol/phom/play-actions.cjs presses the
// game's own button handler, only while the game offers that button). One click = one action; a second click on the
// same browser while one is still running is refused (no double send). Every press is logged.
//  IPC: phom:play-action { runId, action, cards? } → { ok, code, message }
//
// deps: { clientFor(rid), log, precheck?(rid, action, cards) → { ok, message } } — refuses picked cards the game would refuse
//       manualBlocked?(rid) → message | null — a click from the tool refused while TỰ ĐÁNH plays that account
// ---------------------------------------------------------------------------

const { validatePlayAction, buildPlayActionScript } = require('../../protocol/phom/play-actions.cjs');

// a press the page never answers (a hung renderer) gives up after timeoutMs — it must not keep the browser "busy" forever
function bounded(promise, ms, setTimer, clearTimer) {
  let t = null;
  return Promise.race([promise, new Promise((resolve) => { t = setTimer(() => resolve(null), ms); })]).finally(() => clearTimer(t));
}

function createPlayActionsFeature({ clientFor, log = () => {}, precheck = () => ({ ok: true }), manualBlocked = () => null,
  timeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const inFlight = new Set();

  async function act(runId, input = {}) {
    const rid = String(runId == null ? '' : runId);
    const v = validatePlayAction(input);
    if (!v.ok) return v;
    let pre; try { pre = precheck(rid, v.action, v.cards) || { ok: true }; } catch { pre = { ok: true }; }
    if (!pre.ok) return { ok: false, error: { code: 'PHOM_PLAY_PRECHECK', message: pre.message || 'Không hợp lệ' } };
    if (inFlight.has(rid)) return { ok: false, error: { code: 'PHOM_PLAY_BUSY', message: 'Đang thực hiện thao tác trước' } };
    const client = clientFor(rid);
    if (!client || !client.Runtime) return { ok: false, error: { code: 'PHOM_PLAY_NO_CLIENT', message: 'Trình duyệt này không còn kết nối' } };
    inFlight.add(rid);
    try {
      const r = await bounded(client.Runtime.evaluate({ expression: buildPlayActionScript({ action: v.action, cards: v.cards }), returnByValue: true }), timeoutMs, setTimer, clearTimer);
      if (r === null) {
        log('play-action', { runId: rid, action: v.action, ok: false, code: 'PHOM_PLAY_TIMEOUT' });
        return { ok: false, error: { code: 'PHOM_PLAY_FAILED', message: 'Trình duyệt không trả lời khi bấm ' + v.action } };
      }
      const res = (r && r.result && r.result.value) || { ok: false, code: 'PHOM_PLAY_PAGE_ERROR', message: 'no result' };
      log('play-action', { runId: rid, action: v.action, cards: v.cards.length, ok: !!res.ok, code: res.code });
      return res.ok ? { ok: true, action: v.action } : { ok: false, error: { code: res.code, message: res.message } };
    } catch (e) {
      log('play-action', { runId: rid, action: v.action, ok: false, code: 'PHOM_PLAY_FAILED' });
      return { ok: false, error: { code: 'PHOM_PLAY_FAILED', message: String((e && e.message) || e).slice(0, 200) } };
    } finally { inFlight.delete(rid); }
  }

  return {
    id: 'play-actions',
    act,
    registerIpc(handle, { enabled = true } = {}) {
      handle('phom:play-action', (_e, cfg) => {
        if (!enabled) return { ok: false, error: { code: 'PHOM_FEATURE_OFF', message: 'Tính năng đang tắt (PHOM_FEATURES_OFF)' } };
        // a click on the tool's button while TỰ ĐÁNH plays this account would race it (two presses in one turn)
        const blocked = manualBlocked(String((cfg && cfg.runId) == null ? '' : cfg.runId));
        if (blocked) return { ok: false, error: { code: 'PHOM_PLAY_AUTO_ON', message: blocked } };
        return act(cfg && cfg.runId, { action: cfg && cfg.action, cards: cfg && Array.isArray(cfg.cards) ? cfg.cards : [] });
      }, { guarded: true });
    },
  };
}

module.exports = { createPlayActionsFeature, bounded };
