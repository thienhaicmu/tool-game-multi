'use strict';

// ---------------------------------------------------------------------------
// FEATURE auto-play — TỰ ĐÁNH, switched on per account by the user (docs/phom-danh-bai.md §7). Off by default.
//
// Every tick, for each account switched on: read which buttons the game offers (read-only page script), choose the
// step (protocol/phom/phom-auto-play.cjs nextStep) and press it
// through the play-actions feature — the same path as a click on the tool's button (precheck, one action at a time).
// A step is pressed only after it stayed the same for a human pause (settleMs + a random 0…jitterMs: 0.8–2.5 s, the
// table rhythm of docs/phom-kich-ban.md §0 — the card snapshot also catches up with the buttons meanwhile), and the
// same step is not pressed twice until what THIS account's step depends on changed (phom-auto-play stateKey — another
// account's own frames do not count). The chosen step is kept per state, so an unchanged table is not re-computed every
// tick. The accounts switched on are ticked side by side, every page call is bounded (evalTimeoutMs), so one hung
// browser never holds the other two. Needs the signed license right autoRun ("Cho dùng Tự đánh" in the Generator):
// without it the switch is refused, and a run that loses it stops.
//
// SELF-RESUME (user 2026-10-10): a stop the account can recover from (the page reloaded, the browser stopped answering,
// a press the game did not take, a step that never came) leaves the switch ARMED: once the account is back at its Phỏm
// table Tự đánh turns itself on again — at most resumeLimit times per resumeWindowMs; not back at the table within
// resumeWaitMs, or the limit reached, and it is off for good. Never resumed: the user switched it off, the key lost the
// right, the browser closed, the feature is off.
//
//  IPC: phom:auto-play { runId, on } → { ok, status }
// deps: { act(rid, {action, cards}), clientFor(rid), snapshot(), uidOf(rid), toolUids() (slots + reserves), autoOptions(), licensed(), log, refresh() }
// ---------------------------------------------------------------------------

const { buildOfferedScript } = require('../../protocol/phom/play-actions.cjs');
const autoPlay = require('../../protocol/phom/phom-auto-play.cjs');
const { bounded } = require('./play-actions.cjs'); // a hung page answers null after the timeout

const STOP_CODES = new Set(['PHOM_PLAY_PRECHECK', 'PHOM_PLAY_NOT_AT_TABLE', 'PHOM_PLAY_NO_CLIENT', 'PHOM_PLAY_NO_HANDLER', 'PHOM_PLAY_CARD_NOT_IN_HAND', 'PHOM_PLAY_PAGE_ERROR', 'PHOM_PLAY_FAILED', 'PHOM_PLAY_UNKNOWN', 'PHOM_PLAY_BAD_CARD', 'PHOM_PLAY_TOO_MANY', 'PHOM_PLAY_NO_CARD', 'PHOM_FEATURE_OFF']);
// stops that are final: everything else may self-resume
const FINAL_CODES = new Set(['USER', 'CLOSED', 'STOP_ALL', 'PHOM_AUTO_PLAY_NOT_LICENSED', 'PHOM_FEATURE_OFF']);

const NOT_LICENSED = { code: 'PHOM_AUTO_PLAY_NOT_LICENSED', message: 'Key này chưa được cấp quyền Tự đánh — liên hệ admin để cấp key có tích "Cho dùng Tự đánh"' };

function createAutoPlayFeature({ act, clientFor, snapshot, uidOf, toolUids = () => [], autoOptions = () => ({}), licensed = () => true, log = () => {}, refresh = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, tickMs = 600, settleMs = 800, jitterMs = 1700, random = Math.random, stallMs = 6000, waitStallMs = 12000, evalTimeoutMs = 5000,
  resumeLimit = 3, resumeWindowMs = 10 * 60 * 1000, resumeWaitMs = 2 * 60 * 1000, resumeDelayMs = 3000 }) {
  // rid → { on, armed, message, pending, lastPress, waitSince, avoid, avoidAt, busy, step, resumes[], stats }
  const runs = new Map();
  let timer = null;

  const st = (rid) => {
    let s = runs.get(rid);
    if (!s) { s = { on: false, armed: null, message: null, pending: null, lastPress: null, waitSince: null, avoid: new Set(), avoidAt: null, busy: false, step: null, resumes: [], stats: { rounds: 0, presses: 0, stops: 0, resumed: 0 }, lastRound: null }; runs.set(rid, s); }
    return s;
  };
  const anyLive = () => [...runs.values()].some((s) => s.on || s.armed);
  function schedule() { if (!timer && anyLive()) timer = setTimer(() => { timer = null; void tick(); schedule(); }, tickMs); }
  function setMessage(s, m) { if (s.message !== m) { s.message = m; refresh(); } }
  const pause = () => settleMs + Math.floor(random() * Math.max(0, jitterMs));

  function begin(s, message) {
    Object.assign(s, { on: true, armed: null, generation: (s.generation || 0) + 1, pending: null, lastPress: null, waitSince: null, probeSince: null, avoid: new Set(), avoidAt: null, step: null, message });
  }
  function start(rid) {
    if (!licensed()) return { ok: false, error: { ...NOT_LICENSED } };
    const s = st(rid);
    begin(s, 'Đang chờ lượt');
    s.resumes = []; // the user's own switch-on starts a fresh resume budget
    log('auto-play', { runId: rid, on: true });
    refresh(); schedule();
    return { ok: true, status: status()[rid] };
  }
  function stop(rid, message = null, code = null) {
    const s = runs.get(rid);
    if (!s || !(s.on || s.armed)) return { ok: true };
    const wasOn = s.on;
    Object.assign(s, { on: false, generation: (s.generation || 0) + 1, pending: null, lastPress: null, waitSince: null, step: null, message });
    if (wasOn && code !== 'USER') s.stats.stops++;
    const t = now();
    s.resumes = s.resumes.filter((at) => t - at < resumeWindowMs);
    if (wasOn && !FINAL_CODES.has(code) && s.resumes.length < resumeLimit) {
      s.armed = { code, since: t };
      s.message = (message || 'Tự đánh tạm dừng') + ' — sẽ tự bật lại khi về bàn (' + (s.resumes.length + 1) + '/' + resumeLimit + ')';
    } else {
      if (wasOn && !FINAL_CODES.has(code)) s.message = (message || 'Tự đánh dừng') + ' — đã tự bật lại ' + resumeLimit + ' lần trong ' + Math.round(resumeWindowMs / 60000) + ' phút, tắt hẳn';
      s.armed = null;
    }
    log('auto-play', { runId: rid, on: false, code, armed: !!s.armed });
    refresh();
    if (!anyLive() && timer) { clearTimer(timer); timer = null; }
    return { ok: true };
  }

  // an ARMED account: back at the Phỏm table → on again; gone too long → off for good
  async function tryResume(rid, s) {
    const t = now();
    if (!licensed()) { s.armed = null; return setMessage(s, 'Tự đánh dừng: ' + NOT_LICENSED.message); }
    if (t - s.armed.since < resumeDelayMs) return;
    if (t - s.armed.since >= resumeWaitMs) { s.armed = null; log('auto-play', { runId: rid, on: false, code: 'RESUME_TIMEOUT' }); return setMessage(s, 'Tự đánh tắt: không về bàn trong ' + Math.round(resumeWaitMs / 60000) + ' phút'); }
    const client = clientFor(rid);
    if (!client || !client.Runtime) return;
    let probe;
    try { const r = await bounded(client.Runtime.evaluate({ expression: buildOfferedScript(), returnByValue: true }), evalTimeoutMs, setTimer, clearTimer); probe = r && r.result && r.result.value; } catch { probe = null; }
    if (!s.armed || s.on || !probe || !probe.ok || !probe.atTable || !uidOf(rid)) return;
    s.resumes.push(now());
    s.stats.resumed++;
    begin(s, 'Đã tự bật lại (' + s.resumes.length + '/' + resumeLimit + ') — đang chờ lượt');
    log('auto-play', { runId: rid, on: true, resumed: s.resumes.length });
    refresh();
  }

  async function tickOne(rid, s) {
    const generation = s.generation;
    if (!licensed()) return stop(rid, 'Tự đánh dừng: ' + NOT_LICENSED.message, NOT_LICENSED.code);
    const uid = uidOf(rid);
    if (!uid) return setMessage(s, 'Chưa biết acc của trình duyệt này');
    const client = clientFor(rid);
    if (!client || !client.Runtime) return stop(rid, 'Trình duyệt không còn kết nối', 'NO_CLIENT');
    let probe;
    try { const r = await bounded(client.Runtime.evaluate({ expression: buildOfferedScript(), returnByValue: true }), evalTimeoutMs, setTimer, clearTimer); probe = r && r.result && r.result.value; } catch { probe = null; }
    if (!s.on || s.generation !== generation) return;
    if (!probe || !probe.ok) {
      s.pending = null;
      if (s.probeSince == null) s.probeSince = now();
      if (now() - s.probeSince >= waitStallMs) return stop(rid, 'Không đọc được nút game quá thời hạn', 'PROBE_STALL');
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
      } else return stop(rid, 'Chưa xác nhận ' + prev.action, 'NOT_TAKEN');
    }
    if (s.avoidAt !== state) { s.avoid = new Set(); s.avoidAt = state; }
    // the step for this exact table (state + buttons + refused steps) is computed once
    const stepKeyOfTable = state + '|' + (probe.offered || []).join(',') + '|' + [...s.avoid].join(',');
    let step;
    if (s.step && s.step.key === stepKeyOfTable) step = s.step.value;
    else { step = autoPlay.nextStep(snap, uid, probe.offered, s.avoid, members, options); s.step = { key: stepKeyOfTable, value: step }; }
    const t = now();
    if (step.stop) return stop(rid, step.message, step.code);
    if (step.wait) {
      s.pending = null;
      if (!probe.offered.length) { s.waitSince = null; return setMessage(s, 'Đang chờ lượt'); }
      if (s.waitSince == null) s.waitSince = t;
      else if (t - s.waitSince >= waitStallMs) return stop(rid, 'Tự đánh dừng: ' + step.why, 'WAIT_STALL');
      return setMessage(s, step.why);
    }
    s.waitSince = null;
    const key = autoPlay.stepKey(step);
    // the same press already went out and the table has not changed since: wait for it — or give it up
    if (s.lastPress && s.lastPress.key === key && s.lastPress.state === state) {
      if (t - s.lastPress.at < stallMs) return;
      if (step.action === 'AN') { s.avoid.add('AN'); s.lastPress = null; return setMessage(s, 'Game không cho Ăn — chuyển sang Bốc'); }
      return stop(rid, 'Game không nhận ' + step.why, 'NOT_TAKEN');
    }
    if (!s.pending || s.pending.key !== key || s.pending.state !== state) { s.pending = { key, state, at: t, wait: pause() }; return setMessage(s, 'Sắp: ' + step.why); }
    if (t - s.pending.at < s.pending.wait) return;
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
      s.stats.presses++;
      if (s.lastRound !== snap.roundSeq) { s.lastRound = snap.roundSeq; s.stats.rounds++; }
      return setMessage(s, 'Vừa: ' + step.why);
    }
    const code = res && res.error && res.error.code;
    if (code && STOP_CODES.has(code)) return stop(rid, 'Tự đánh dừng: ' + ((res.error && res.error.message) || code), code);
    return setMessage(s, (res && res.error && res.error.message) || 'Thử lại'); // busy / not offered yet — the next tick tries again
  }

  // the accounts side by side: each is its own browser, and a slow one must not delay another's turn
  async function tick() {
    await Promise.all([...runs].filter(([, s]) => (s.on || s.armed) && !s.busy).map(async ([rid, s]) => {
      s.busy = true;
      try { if (s.on) await tickOne(rid, s); else await tryResume(rid, s); }
      catch (e) { stop(rid, 'Tự đánh lỗi: ' + String((e && e.message) || e).slice(0, 120), 'ERROR'); }
      finally { s.busy = false; }
    }));
  }

  // on = running OR armed to resume (the switch stays on, the user can still switch it off); stats = this session
  function status() {
    const out = {};
    for (const [rid, s] of runs) if (s.on || s.armed || s.message) out[rid] = { on: s.on || !!s.armed, resuming: !!s.armed, message: s.message, stats: { ...s.stats } };
    return out;
  }

  return {
    id: 'auto-play',
    start, stop, status, tick,
    documentReplaced({ run } = {}) { if (run) stop(String(run.id), 'Trang đã tải lại', 'DOCUMENT'); },
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
