'use strict';

// ---------------------------------------------------------------------------
// FEATURE auto-play — TỰ ĐÁNH, switched on per account by the user (docs/phom-danh-bai.md §7). Off by default; once it
// turns itself off (a press the game did not take, the page reloaded, the browser closed) it stays off until the user
// switches it on again.
//
// Every tick, for each account switched on: read which buttons the game offers (read-only page script), choose the
// step (protocol/phom/phom-auto-play.cjs nextStep) and press it
// through the play-actions feature — the same path as a click on the tool's button (precheck, one action at a time).
// A step is pressed only after it stayed the same for settleMs (the card snapshot catches up with the buttons), and the
// same step is not pressed twice until what THIS account's step depends on changed (phom-auto-play stateKey — another
// account's own frames do not count). The accounts switched on are ticked side by side, every page call is bounded
// (evalTimeoutMs), so one hung browser never holds the other two. Needs the signed license right autoRun ("Cho dùng
// Tự đánh" in the Generator): without it the switch is refused, and a run that loses it stops.
//
//  IPC: phom:auto-play { runId, on } → { ok, status }
// deps: { act(rid, {action, cards}), clientFor(rid), snapshot(), uidOf(rid), toolUids() (slots + reserves), autoOptions(), licensed(), log, refresh() }
// ---------------------------------------------------------------------------

const { buildOfferedScript } = require('../../protocol/phom/play-actions.cjs');
const autoPlay = require('../../protocol/phom/phom-auto-play.cjs');
const { bounded } = require('./play-actions.cjs'); // a hung page answers null after the timeout

const STOP_CODES = new Set(['PHOM_PLAY_PRECHECK', 'PHOM_PLAY_NOT_AT_TABLE', 'PHOM_PLAY_NO_CLIENT', 'PHOM_PLAY_NO_HANDLER', 'PHOM_PLAY_CARD_NOT_IN_HAND', 'PHOM_PLAY_PAGE_ERROR', 'PHOM_PLAY_FAILED', 'PHOM_PLAY_UNKNOWN', 'PHOM_PLAY_BAD_CARD', 'PHOM_PLAY_TOO_MANY', 'PHOM_PLAY_NO_CARD', 'PHOM_FEATURE_OFF']);

const NOT_LICENSED = { code: 'PHOM_AUTO_PLAY_NOT_LICENSED', message: 'Key này chưa được cấp quyền Tự đánh — liên hệ admin để cấp key có tích "Cho dùng Tự đánh"' };

function createAutoPlayFeature({ act, clientFor, snapshot, uidOf, toolUids = () => [], autoOptions = () => ({}), licensed = () => true, log = () => {}, refresh = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, tickMs = 600, settleMs = 900, stallMs = 6000, waitStallMs = 12000, evalTimeoutMs = 5000 }) {
  const runs = new Map(); // rid → { on, message, pending, lastPress, waitSince, avoid, avoidAt, busy }
  let timer = null;

  const st = (rid) => { let s = runs.get(rid); if (!s) { s = { on: false, message: null, pending: null, lastPress: null, waitSince: null, avoid: new Set(), avoidAt: null, busy: false }; runs.set(rid, s); } return s; };
  const anyOn = () => [...runs.values()].some((s) => s.on);
  function schedule() { if (!timer && anyOn()) timer = setTimer(() => { timer = null; void tick(); schedule(); }, tickMs); }
  function setMessage(s, m) { if (s.message !== m) { s.message = m; refresh(); } }

  function start(rid) {
    if (!licensed()) return { ok: false, error: { ...NOT_LICENSED } };
    const s = st(rid);
    Object.assign(s, { on: true, generation: (s.generation || 0) + 1, pending: null, lastPress: null, waitSince: null, probeSince: null, avoid: new Set(), avoidAt: null, message: 'Đang chờ lượt' });
    log('auto-play', { runId: rid, on: true });
    refresh(); schedule();
    return { ok: true, status: status()[rid] };
  }
  function stop(rid, message = null, code = null) {
    const s = runs.get(rid);
    if (!s || !s.on) return { ok: true };
    Object.assign(s, { on: false, generation: (s.generation || 0) + 1, pending: null, lastPress: null, waitSince: null, message });
    log('auto-play', { runId: rid, on: false, code });
    refresh();
    if (!anyOn() && timer) { clearTimer(timer); timer = null; }
    return { ok: true };
  }

  async function tickOne(rid, s) {
    const generation = s.generation;
    if (!licensed()) return stop(rid, 'Tự đánh dừng: ' + NOT_LICENSED.message, NOT_LICENSED.code);
    const uid = uidOf(rid);
    if (!uid) return setMessage(s, 'Chưa biết acc của trình duyệt này');
    const client = clientFor(rid);
    if (!client || !client.Runtime) return stop(rid, 'Trình duyệt không còn kết nối — đã tắt Tự đánh', 'NO_CLIENT');
    let probe;
    try { const r = await bounded(client.Runtime.evaluate({ expression: buildOfferedScript(), returnByValue: true }), evalTimeoutMs, setTimer, clearTimer); probe = r && r.result && r.result.value; } catch { probe = null; }
    if (!s.on || s.generation !== generation) return;
    if (!probe || !probe.ok) {
      s.pending = null;
      if (s.probeSince == null) s.probeSince = now();
      if (now() - s.probeSince >= waitStallMs) return stop(rid, 'Không đọc được nút game quá thời hạn — đã tắt Tự đánh', 'PROBE_STALL');
      return setMessage(s, 'Không đọc được nút của game — đang thử lại');
    }
    s.probeSince = null;
    if (!probe.atTable) { s.pending = null; s.waitSince = null; return setMessage(s, 'Chưa ở bàn Phỏm'); }
    const snap = snapshot();
    const members = toolUids();
    const options = autoOptions();
    const state = autoPlay.stateKey(snap, uid, members) + '|' + JSON.stringify(options);
    // A sent action remains in flight until this account's corresponding event is observed.
    if (s.lastPress) {
      const prev = s.lastPress;
      const p = snap.players && snap.players[String(uid)] || {};
      const count = (name) => (p[name] || []).length;
      const acknowledged = snap.roundSeq !== prev.roundSeq || snap.roundActive === false ||
        (prev.action === 'BOC' && count('drawnHistory') > prev.drawn) ||
        (prev.action === 'AN' && (snap.eats || []).filter((e) => String(e.eaterUid) === String(uid)).length > prev.eaten) ||
        (prev.action === 'DANH' && count('discardedHistory') > prev.discarded) ||
        (prev.action === 'HA' && count('melds') > prev.melds) ||
        (prev.action === 'GUI' && count('sentCards') > prev.sent) ||
        (prev.action === 'BAO_U' && snap.roundActive === false);
      if (acknowledged) { log('auto-play-confirmed', { runId: rid, action: prev.action }); s.lastPress = null; }
      else if (now() - prev.at < stallMs) return;
      else if (prev.action === 'AN' && probe.offered.includes('BOC')) {
        s.avoid.add('AN'); s.avoidAt = state; s.lastPress = null;
      } else return stop(rid, 'Chưa xác nhận ' + prev.action + ' — đã tắt Tự đánh', 'NOT_TAKEN');
    }
    if (s.avoidAt !== state) { s.avoid = new Set(); s.avoidAt = state; }
    const step = autoPlay.nextStep(snap, uid, probe.offered, s.avoid, members, options);
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
    if (s.lastPress && s.lastPress.key === key && s.lastPress.state === state) {
      if (t - s.lastPress.at < stallMs) return;
      if (step.action === 'AN') { s.avoid.add('AN'); s.lastPress = null; return setMessage(s, 'Game không cho Ăn — chuyển sang Bốc'); }
      return stop(rid, 'Game không nhận ' + step.why + ' — đã tắt Tự đánh', 'NOT_TAKEN');
    }
    if (!s.pending || s.pending.key !== key || s.pending.state !== state) { s.pending = { key, state, at: t }; return setMessage(s, 'Sắp: ' + step.why); }
    if (t - s.pending.at < settleMs) return;
    s.pending = null;
    log('auto-play-decision', { runId: rid, uid: String(uid), snapshot: snap, offered: probe.offered,
      avoid: [...s.avoid], toolUids: members, options, step });
    const res = await act(rid, { action: step.action, cards: step.cards }); // bounded by the play-actions feature
    if (!s.on || s.generation !== generation) return;
    log('auto-play-step', { runId: rid, action: step.action, cards: step.cards, why: step.why, state, ok: !!(res && res.ok), code: res && res.error && res.error.code });
    if (res && res.ok) {
      const p = snap.players && snap.players[String(uid)] || {};
      s.lastPress = { key, state, action: step.action, roundSeq: snap.roundSeq, drawn: (p.drawnHistory || []).length,
        eaten: (snap.eats || []).filter((e) => String(e.eaterUid) === String(uid)).length,
        discarded: (p.discardedHistory || []).length, melds: (p.melds || []).length, sent: (p.sentCards || []).length, at: now() };
      return setMessage(s, 'Vừa: ' + step.why);
    }
    const code = res && res.error && res.error.code;
    if (code && STOP_CODES.has(code)) return stop(rid, 'Tự đánh dừng: ' + ((res.error && res.error.message) || code), code);
    return setMessage(s, (res && res.error && res.error.message) || 'Thử lại'); // busy / not offered yet — the next tick tries again
  }

  // the accounts side by side: each is its own browser, and a slow one must not delay another's turn
  async function tick() {
    await Promise.all([...runs].filter(([, s]) => s.on && !s.busy).map(async ([rid, s]) => {
      s.busy = true;
      try { await tickOne(rid, s); } catch (e) { stop(rid, 'Tự đánh lỗi: ' + String((e && e.message) || e).slice(0, 120), 'ERROR'); } finally { s.busy = false; }
    }));
  }

  function status() {
    const out = {};
    for (const [rid, s] of runs) if (s.on || s.message) out[rid] = { on: s.on, message: s.message };
    return out;
  }

  return {
    id: 'auto-play',
    start, stop, status, tick,
    documentReplaced({ run } = {}) { if (run) stop(String(run.id), 'Trang đã tải lại — đã tắt Tự đánh', 'DOCUMENT'); },
    closed({ run } = {}) { if (run) { stop(String(run.id), null, 'CLOSED'); runs.delete(String(run.id)); } },
    stopAll(message) { for (const rid of [...runs.keys()]) stop(rid, message, 'STOP_ALL'); },
    registerIpc(handle, { enabled = true } = {}) {
      handle('phom:auto-play', (_e, cfg) => {
        const rid = String((cfg && cfg.runId) == null ? '' : cfg.runId);
        if (!rid) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'Chưa có trình duyệt' } };
        if (!(cfg && cfg.on)) return stop(rid, null, 'USER');
        if (!enabled) return { ok: false, error: { code: 'PHOM_FEATURE_OFF', message: 'Tính năng đang tắt (PHOM_FEATURES_OFF)' } };
        return start(rid); // start() also refuses a key without the Tự đánh right
      }, { guarded: true });
    },
  };
}

module.exports = { createAutoPlayFeature };
