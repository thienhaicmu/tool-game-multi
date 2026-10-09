'use strict';

// ---------------------------------------------------------------------------
// FEATURE auto-play — TỰ ĐÁNH, switched on per account by the user (docs/phom-danh-bai.md §7). Off by default; once it
// turns itself off (a player outside the tool in the round, a press the game did not take, the page reloaded, the
// browser closed) it stays off until the user switches it on again.
//
// Every tick, for each account switched on: read which buttons the game offers (read-only page script), choose the
// step (protocol/phom/phom-auto-play.cjs nextStep — the doc's scenario, own hand + public facts only) and press it
// through the play-actions feature — the same path as a click on the tool's button (precheck, one action at a time).
// A step is pressed only after it stayed the same for settleMs (the card snapshot catches up with the buttons), and the
// same step is not pressed twice until the table changed.
//
//  IPC: phom:auto-play { runId, on } → { ok, status }
// deps: { act(rid, {action, cards}), clientFor(rid), snapshot(), uidOf(rid), toolUids() (slots + reserves), log, refresh() }
// ---------------------------------------------------------------------------

const { buildOfferedScript } = require('../../protocol/phom/play-actions.cjs');
const autoPlay = require('../../protocol/phom/phom-auto-play.cjs');

const STOP_CODES = new Set(['PHOM_PLAY_PRECHECK', 'PHOM_PLAY_NOT_AT_TABLE', 'PHOM_PLAY_NO_CLIENT', 'PHOM_PLAY_NO_HANDLER', 'PHOM_PLAY_CARD_NOT_IN_HAND', 'PHOM_PLAY_PAGE_ERROR', 'PHOM_PLAY_FAILED', 'PHOM_PLAY_UNKNOWN', 'PHOM_PLAY_BAD_CARD', 'PHOM_PLAY_TOO_MANY', 'PHOM_PLAY_NO_CARD', 'PHOM_FEATURE_OFF']);

function createAutoPlayFeature({ act, clientFor, snapshot, uidOf, toolUids = () => [], log = () => {}, refresh = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, tickMs = 600, settleMs = 900, stallMs = 6000, waitStallMs = 12000 }) {
  const runs = new Map(); // rid → { on, message, pending, lastPress, waitSince, avoid, busy }
  let version = 0;        // bumps on every card-snapshot change
  let timer = null;

  const st = (rid) => { let s = runs.get(rid); if (!s) { s = { on: false, message: null, pending: null, lastPress: null, waitSince: null, avoid: new Set(), avoidAt: -1, busy: false }; runs.set(rid, s); } return s; };
  const anyOn = () => [...runs.values()].some((s) => s.on);
  function schedule() { if (!timer && anyOn()) timer = setTimer(() => { timer = null; tick().finally(schedule); }, tickMs); }
  function setMessage(s, m) { if (s.message !== m) { s.message = m; refresh(); } }

  function start(rid) {
    const s = st(rid);
    const guard = autoPlay.tableGuard(snapshot(), toolUids());
    if (guard.stop) return { ok: false, error: { code: guard.code, message: 'Có người chơi ngoài tool trong ván — Tự đánh chỉ chạy khi cả bàn là acc của tool' } };
    Object.assign(s, { on: true, pending: null, lastPress: null, waitSince: null, avoid: new Set(), avoidAt: -1, message: 'Đang chờ lượt' });
    log('auto-play', { runId: rid, on: true });
    refresh(); schedule();
    return { ok: true, status: status()[rid] };
  }
  function stop(rid, message = null, code = null) {
    const s = runs.get(rid);
    if (!s || !s.on) return { ok: true };
    Object.assign(s, { on: false, pending: null, lastPress: null, waitSince: null, message });
    log('auto-play', { runId: rid, on: false, code });
    refresh();
    if (!anyOn() && timer) { clearTimer(timer); timer = null; }
    return { ok: true };
  }

  async function tickOne(rid, s) {
    const uid = uidOf(rid);
    if (!uid) return setMessage(s, 'Chưa biết acc của trình duyệt này');
    const client = clientFor(rid);
    if (!client || !client.Runtime) return stop(rid, 'Trình duyệt không còn kết nối — đã tắt Tự đánh', 'NO_CLIENT');
    let probe;
    try { const r = await client.Runtime.evaluate({ expression: buildOfferedScript(), returnByValue: true }); probe = r && r.result && r.result.value; } catch { probe = null; }
    if (!s.on) return;
    if (!probe || !probe.ok) return setMessage(s, 'Không đọc được nút của game');
    if (!probe.atTable) { s.pending = null; s.waitSince = null; return setMessage(s, 'Chưa ở bàn Phỏm'); }
    if (s.avoidAt !== version) { s.avoid = new Set(); s.avoidAt = version; }
    const step = autoPlay.nextStep(snapshot(), uid, probe.offered, s.avoid, toolUids());
    const t = now();
    if (step.stop) return stop(rid, step.message, step.code);
    if (step.wait) {
      s.pending = null;
      if (!probe.offered.length) { s.waitSince = null; return setMessage(s, 'Đang chờ lượt'); }
      if (s.waitSince == null) s.waitSince = t;
      else if (t - s.waitSince >= waitStallMs) return stop(rid, 'Tự đánh dừng: ' + step.why + ' — bấm tay để tiếp', 'WAIT_STALL');
      return setMessage(s, step.why);
    }
    s.waitSince = null;
    const key = autoPlay.stepKey(step);
    // the same press already went out and the table has not changed since: wait for it — or give it up
    if (s.lastPress && s.lastPress.key === key && s.lastPress.version === version) {
      if (t - s.lastPress.at < stallMs) return;
      if (step.action === 'AN') { s.avoid.add('AN'); s.lastPress = null; return setMessage(s, 'Game không cho Ăn — chuyển sang Bốc'); }
      return stop(rid, 'Game không nhận ' + step.why + ' — đã tắt Tự đánh', 'NOT_TAKEN');
    }
    if (!s.pending || s.pending.key !== key) { s.pending = { key, at: t }; return setMessage(s, 'Sắp: ' + step.why); }
    if (t - s.pending.at < settleMs) return;
    s.pending = null;
    const res = await act(rid, { action: step.action, cards: step.cards });
    if (!s.on) return;
    log('auto-play-step', { runId: rid, action: step.action, cards: step.cards.length, ok: !!(res && res.ok), code: res && res.error && res.error.code });
    if (res && res.ok) { s.lastPress = { key, version, at: now() }; return setMessage(s, 'Vừa: ' + step.why); }
    const code = res && res.error && res.error.code;
    if (code && STOP_CODES.has(code)) return stop(rid, 'Tự đánh dừng: ' + ((res.error && res.error.message) || code), code);
    return setMessage(s, (res && res.error && res.error.message) || 'Thử lại'); // busy / not offered yet — the next tick tries again
  }

  async function tick() {
    for (const [rid, s] of runs) {
      if (!s.on || s.busy) continue;
      s.busy = true;
      try { await tickOne(rid, s); } catch (e) { stop(rid, 'Tự đánh lỗi: ' + String((e && e.message) || e).slice(0, 120), 'ERROR'); } finally { s.busy = false; }
    }
  }

  function status() {
    const out = {};
    for (const [rid, s] of runs) if (s.on || s.message) out[rid] = { on: s.on, message: s.message };
    return out;
  }

  return {
    id: 'auto-play',
    start, stop, status, tick,
    cardsChanged() { version += 1; },
    documentReplaced({ run } = {}) { if (run) stop(String(run.id), 'Trang đã tải lại — đã tắt Tự đánh', 'DOCUMENT'); },
    closed({ run } = {}) { if (run) { stop(String(run.id), null, 'CLOSED'); runs.delete(String(run.id)); } },
    stopAll(message) { for (const rid of [...runs.keys()]) stop(rid, message, 'STOP_ALL'); },
    registerIpc(handle, { enabled = true } = {}) {
      handle('phom:auto-play', (_e, cfg) => {
        const rid = String((cfg && cfg.runId) == null ? '' : cfg.runId);
        if (!rid) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'Chưa có trình duyệt' } };
        if (!(cfg && cfg.on)) return stop(rid, null, 'USER');
        if (!enabled) return { ok: false, error: { code: 'PHOM_FEATURE_OFF', message: 'Tính năng đang tắt (PHOM_FEATURES_OFF)' } };
        return start(rid);
      }, { guarded: true });
    },
  };
}

module.exports = { createAutoPlayFeature };
