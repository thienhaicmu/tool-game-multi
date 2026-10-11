'use strict';

// ---------------------------------------------------------------------------
// FEATURE auto-play — TỰ ĐÁNH, switched on per account by the user (docs/phom-danh-bai.md §7). Off by default.
//
// Every tick, for each account switched on: read which buttons the game offers (read-only page script), choose the
// step (protocol/phom/phom-auto-play.cjs nextStep) and press it
// through the play-actions feature — the same path as a click on the tool's button (precheck, one action at a time).
// A step is pressed only after it stayed the same for a human pause (settleMs + a random 0…jitterMs: 0.8–2.5 s, the
// table rhythm of docs/phom-kich-ban.md §0 — the card snapshot also catches up with the buttons meanwhile). The chosen
// step is kept per state, so an unchanged table is not re-computed every tick. A press stays in flight until THIS
// account's own history shows it (drawn / ate / discarded / laid / sent, or the round moved on). Every account ticks
// on its OWN clock and every page call is bounded (evalTimeoutMs), so one slow browser never holds another's turn.
// Needs the signed license right autoRun ("Cho dùng Tự đánh" in the Generator): without it the switch is refused, and a
// run that loses it stops.
//
// NEVER RUN OUT THE GAME'S CLOCK (Meta Game ede6239, live 2026-10-10: the game plays a turn itself after ~20 s, unfiltered):
//   · the pressed button still shown after refuseMs → refused: Ăn → Bốc, Hạ / Gửi → the discard, Đánh → another card,
//     else pressed again; pressRetries refusals without a confirmed press → it stops
//   · the button gone but the history silent for stallMs → the frames missed it: the game's own hand (read with the
//     buttons) counts for the rest of the round — also after the game said a picked card is not in the hand, and when
//     the frames never showed the hand at all (a missed deal); Bốc never needs the hand
//   · a page call that timed out may have pressed: it waits for confirmation like a press
//   · a wait while the game shows a button becomes the best step those buttons allow after fallbackMs of waiting or
//     once the turn is turnForceMs old; from hurryMs on the human pause is cut to hurryPauseMs
//
// SELF-RESUME (user 2026-10-10): a stop the account can recover from (the page reloaded, the browser stopped answering,
// a press the game did not take, a step that never came) leaves the switch ARMED: once the account is back at its Phỏm
// table Tự đánh turns itself on again — at most resumeLimit times per resumeWindowMs; not back at the table within
// resumeWaitMs, or the limit reached, and it is off for good. Never resumed: the user switched it off, the key lost the
// right, the browser closed, the feature is off.
// VÒNG TỰ ĐÁNH (loop.cjs, user 2026-10-10 "vòng tròn khép kín, không tự dừng"): while unlimited() is true there is no
// limit and no deadline — every recoverable stop resumes, after 3 s → 10 s → 30 s → 1 min (the streak resets once a
// press is confirmed).
//
//  IPC: phom:auto-play { runId, on } → { ok, status }
// deps: { act(rid, {action, cards}, view?), clientFor(rid), snapshot(), uidOf(rid), toolUids() (slots + reserves), autoOptions(), licensed(), log, refresh() }
// ---------------------------------------------------------------------------

const { buildOfferedScript } = require('../../protocol/phom/play-actions.cjs');
const autoPlay = require('../../protocol/phom/phom-auto-play.cjs');
const help = require('../../protocol/phom/phom-play-help.cjs');
const { isValidCardCode } = require('../../protocol/phom/card-codec.cjs');
const { bounded } = require('./play-actions.cjs'); // a hung page answers null after the timeout

// a press error that stops Tự đánh at once: not at the table, the game changed, a step of ours that is malformed
const STOP_CODES = new Set(['PHOM_PLAY_NOT_AT_TABLE', 'PHOM_PLAY_NO_CLIENT', 'PHOM_PLAY_NO_HANDLER', 'PHOM_PLAY_UNKNOWN', 'PHOM_PLAY_BAD_CARD', 'PHOM_PLAY_TOO_MANY', 'PHOM_PLAY_NO_CARD', 'PHOM_FEATURE_OFF']);
// the tool's picture of the hand is off: the game's own hand counts for the rest of the round, the step is chosen again
const HAND_CODES = new Set(['PHOM_PLAY_CARD_NOT_IN_HAND', 'PHOM_PLAY_PRECHECK']);
// the page did not answer in time / threw mid-press: the press may have gone through — confirmed or refused like one
const UNCERTAIN_CODES = new Set(['PHOM_PLAY_TIMEOUT', 'PHOM_PLAY_PAGE_ERROR', 'PHOM_PLAY_FAILED']);
// stops that are final: everything else may self-resume
const FINAL_CODES = new Set(['USER', 'CLOSED', 'STOP_ALL', 'PHOM_AUTO_PLAY_NOT_LICENSED', 'PHOM_FEATURE_OFF']);

const NOT_LICENSED = { code: 'PHOM_AUTO_PLAY_NOT_LICENSED', message: 'Key này chưa được cấp quyền Tự đánh — liên hệ admin để cấp key có tích "Cho dùng Tự đánh"' };

const LOOP_BACKOFF_MS = Object.freeze([3000, 10000, 30000, 60000]);

function createAutoPlayFeature({ act, clientFor, snapshot, uidOf, toolUids = () => [], autoOptions = () => ({}), licensed = () => true, unlimited = () => false, log = () => {}, refresh = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, tickMs = 600, settleMs = 800, jitterMs = 1700, random = Math.random, stallMs = 6000, refuseMs = 2500, waitStallMs = 12000, fallbackMs = 4000,
  turnForceMs = 12000, hurryMs = 10000, hurryPauseMs = 300, turnGapMs = 3000, pressRetries = 3, evalTimeoutMs = 5000,
  resumeLimit = 3, resumeWindowMs = 10 * 60 * 1000, resumeWaitMs = 2 * 60 * 1000, resumeDelayMs = 3000 }) {
  // rid → { on, armed, message, pending, lastPress, waitSince, avoid, avoidAt, busy, timer, step, fails, distrust, turnSince, … }
  const runs = new Map();

  const st = (rid) => {
    let s = runs.get(rid);
    if (!s) {
      s = { on: false, armed: null, message: null, pending: null, lastPress: null, waitSince: null, avoid: new Set(), avoidAt: null, busy: false, timer: null, step: null,
        fails: 0, distrust: null, turnSince: null, lastOfferedAt: null, resumes: [], streak: 0, stats: { rounds: 0, presses: 0, stops: 0, resumed: 0 }, lastRound: null };
      runs.set(rid, s);
    }
    return s;
  };
  const live = (s) => s.on || !!s.armed;
  // every account on its own clock: a page call may take up to evalTimeoutMs, and that must never hold another's turn
  function scheduleOne(rid, s) {
    if (s.timer || !live(s) || runs.get(rid) !== s) return;
    s.timer = setTimer(() => { s.timer = null; void run(rid, s).finally(() => scheduleOne(rid, s)); }, tickMs);
  }
  const schedule = () => { for (const [rid, s] of runs) scheduleOne(rid, s); };
  function setMessage(s, m) { if (s.message !== m) { s.message = m; refresh(); } }
  const pause = () => settleMs + Math.floor(random() * Math.max(0, jitterMs));

  // a new run: earlier probes, refused steps, the press in flight and the turn's clock are forgotten
  function begin(s, message) {
    Object.assign(s, { on: true, armed: null, generation: (s.generation || 0) + 1, pending: null, lastPress: null, waitSince: null, probeSince: null, avoid: new Set(), avoidAt: null, step: null,
      fails: 0, distrust: null, turnSince: null, lastOfferedAt: null, message });
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
    const loop = unlimited();
    if (wasOn && !FINAL_CODES.has(code) && (loop || s.resumes.length < resumeLimit)) {
      s.armed = { code, since: t, delay: loop ? LOOP_BACKOFF_MS[Math.min(s.streak, LOOP_BACKOFF_MS.length - 1)] : resumeDelayMs };
      s.message = (message || 'Tự đánh tạm dừng') + (loop ? ' — tự bật lại sau ' + Math.round(s.armed.delay / 1000) + ' giây khi về bàn' : ' — sẽ tự bật lại khi về bàn (' + (s.resumes.length + 1) + '/' + resumeLimit + ')');
    } else {
      if (wasOn && !FINAL_CODES.has(code)) s.message = (message || 'Tự đánh dừng') + ' — đã tự bật lại ' + resumeLimit + ' lần trong ' + Math.round(resumeWindowMs / 60000) + ' phút, tắt hẳn';
      s.armed = null;
    }
    log('auto-play', { runId: rid, on: false, code, armed: !!s.armed, message: message || null });
    refresh();
    if (!live(s) && s.timer) { clearTimer(s.timer); s.timer = null; }
    return { ok: true };
  }

  async function probeOf(rid) {
    const client = clientFor(rid);
    if (!client || !client.Runtime) return null;
    try { const r = await bounded(client.Runtime.evaluate({ expression: buildOfferedScript(), returnByValue: true }), evalTimeoutMs, setTimer, clearTimer); return (r && r.result && r.result.value) || null; } catch { return null; }
  }

  // an ARMED account: back at the Phỏm table → on again; gone too long → off for good
  async function tryResume(rid, s) {
    const t = now();
    if (!licensed()) { s.armed = null; return setMessage(s, 'Tự đánh dừng: ' + NOT_LICENSED.message); }
    if (t - s.armed.since < (s.armed.delay != null ? s.armed.delay : resumeDelayMs)) return;
    if (!unlimited() && t - s.armed.since >= resumeWaitMs) { s.armed = null; log('auto-play', { runId: rid, on: false, code: 'RESUME_TIMEOUT' }); return setMessage(s, 'Tự đánh tắt: không về bàn trong ' + Math.round(resumeWaitMs / 60000) + ' phút'); }
    const probe = await probeOf(rid);
    if (!s.armed || s.on || !probe || !probe.ok || !probe.atTable || !uidOf(rid)) return;
    s.resumes.push(now());
    s.stats.resumed++; s.streak++;
    begin(s, unlimited() ? 'Đã tự bật lại — đang chờ lượt' : 'Đã tự bật lại (' + s.resumes.length + '/' + resumeLimit + ') — đang chờ lượt');
    log('auto-play', { runId: rid, on: true, resumed: s.resumes.length });
    refresh();
  }

  // the press in flight is confirmed only by THIS account's own history (or the round moving on)
  function counts(snap, uid) {
    const p = (snap.players && snap.players[String(uid)]) || {};
    const n = (k) => (p[k] || []).length;
    return { roundSeq: snap.roundSeq, drawn: n('drawnHistory'), discarded: n('discardedHistory'), melds: n('melds'), sent: n('sentCards'),
      eaten: (snap.eats || []).filter((e) => String(e.eaterUid) === String(uid)).length };
  }
  function confirmed(prev, snap, uid) {
    const c = counts(snap, uid);
    if (c.roundSeq !== prev.roundSeq || snap.roundActive === false) return true;
    return ({ BOC: c.drawn > prev.drawn, AN: c.eaten > prev.eaten, DANH: c.discarded > prev.discarded, HA: c.melds > prev.melds, GUI: c.sent > prev.sent, BAO_U: false })[prev.action] || false;
  }

  // the frames' picture of this account's hand is not trusted for the rest of the round; `cards` are left out of it
  function distrust(s, round, cards = []) {
    if (!s.distrust || s.distrust.round !== round) s.distrust = { round, cards: new Set() };
    for (const c of cards) s.distrust.cards.add(c);
  }
  // the hand Tự đánh decides from: the frames' — or the game's own when the frames never showed one (a missed deal) or
  // are not trusted this round; the cards the game refused are left out
  function viewOf(raw, uid, probe, s) {
    const d = s.distrust && s.distrust.round === raw.roundSeq ? s.distrust : null;
    const game = Array.isArray(probe.hand) ? probe.hand.filter(isValidCardCode) : null;
    const tool = help.handOf(raw, uid) || [];
    const base = game && game.length && (!tool.length || d) ? game : d ? tool : null;
    if (!base) return { snap: raw, source: 'TOOL' };
    return { snap: help.withHand(raw, uid, d ? base.filter((c) => !d.cards.has(c)) : base), source: base === game ? 'GAME' : 'TOOL' };
  }

  async function tickOne(rid, s) {
    const generation = s.generation;
    if (!licensed()) return stop(rid, 'Tự đánh dừng: ' + NOT_LICENSED.message, NOT_LICENSED.code);
    const uid = uidOf(rid);
    if (!uid) return setMessage(s, 'Chưa biết acc của trình duyệt này');
    const client = clientFor(rid);
    if (!client || !client.Runtime) return stop(rid, 'Trình duyệt không còn kết nối', 'NO_CLIENT');
    const probe = await probeOf(rid);
    if (!s.on || s.generation !== generation) return;
    if (!probe || !probe.ok) {
      s.pending = null;
      if (s.probeSince == null) s.probeSince = now();
      if (now() - s.probeSince >= waitStallMs) return stop(rid, 'Không đọc được nút game quá thời hạn', 'PROBE_STALL');
      return setMessage(s, 'Không đọc được nút của game — đang thử lại');
    }
    s.probeSince = null;
    if (!probe.atTable) { s.pending = null; s.waitSince = null; s.turnSince = null; return setMessage(s, 'Chưa ở bàn Phỏm'); }
    const t = now();
    const offered = probe.offered || [];
    // the turn's clock: from the first button shown until the buttons are gone for turnGapMs or the discard is confirmed
    if (offered.length) { s.lastOfferedAt = t; if (s.turnSince == null) s.turnSince = t; }
    else if (s.turnSince != null && t - s.lastOfferedAt >= turnGapMs) s.turnSince = null;
    const raw = snapshot();
    const members = toolUids();
    const options = autoOptions();
    // this account's OWN picture (a teammate's hand or a balance does not reopen an Ăn the game refused)
    const refusalState = autoPlay.stateKey(help.publicView(raw, uid), uid);
    if (s.lastPress) {
      const prev = s.lastPress;
      if (confirmed(prev, raw, uid)) {
        log('auto-play-confirmed', { runId: rid, action: prev.action });
        s.lastPress = null; s.streak = 0; s.fails = 0;
        if (prev.action === 'DANH' || prev.action === 'BAO_U') s.turnSince = null;
      } else {
        const still = offered.includes(prev.action);
        if (t - prev.at < (still ? refuseMs : stallMs)) return;
        s.lastPress = null;
        if (!still) {
          // the game moved on, this account's history never showed it: the frames lag or missed it
          distrust(s, raw.roundSeq);
          log('auto-play-unconfirmed', { runId: rid, action: prev.action });
        } else {
          s.fails++;
          log('auto-play-refused', { runId: rid, action: prev.action, cards: prev.cards, fails: s.fails });
          if (s.fails >= pressRetries) return stop(rid, 'Game chưa nhận ' + prev.why, 'NOT_TAKEN');
          if (prev.action === 'AN' && offered.includes('BOC')) { s.avoid.add('AN'); s.avoidAt = refusalState; setMessage(s, 'Game không cho Ăn — chuyển sang Bốc'); }
          else if (prev.action === 'HA' || prev.action === 'GUI') { s.avoid.add(prev.action); s.avoidAt = refusalState; setMessage(s, 'Game không nhận ' + prev.why + ' — đánh tiếp'); }
          else if (prev.action === 'DANH') { distrust(s, raw.roundSeq, prev.cards); setMessage(s, 'Game không nhận ' + prev.why + ' — chọn lá khác'); }
          else setMessage(s, 'Game chưa nhận ' + prev.why + ' — bấm lại');
        }
      }
    }
    if (s.avoidAt !== refusalState) { s.avoid = new Set(); s.avoidAt = refusalState; }
    const view = viewOf(raw, uid, probe, s);
    const snap = view.snap;
    const state = autoPlay.stateKey(snap, uid, members) + '|' + JSON.stringify(options);
    // the step for this exact table (state + buttons + refused steps) is computed once
    const stepKeyOfTable = state + '|' + offered.join(',') + '|' + [...s.avoid].join(',');
    if (!s.step || s.step.key !== stepKeyOfTable) s.step = { key: stepKeyOfTable, value: autoPlay.nextStep(snap, uid, offered, s.avoid, members, options) };
    let step = s.step.value;
    if (step.stop) return stop(rid, step.message, step.code);
    const elapsed = s.turnSince == null ? 0 : t - s.turnSince;
    // HẠN LƯỢT (live 2026-10-10: ~50 turns in 17 rounds played by the game's own timer, unfiltered): a wait while the game
    // shows a button becomes the best step those buttons allow — after fallbackMs of waiting, or once the turn is old
    if (step.wait && offered.length && ((s.waitSince != null && t - s.waitSince >= fallbackMs) || elapsed >= turnForceMs)) {
      const fb = autoPlay.forcedStep(snap, uid, offered, s.avoid, members);
      if (fb) step = { ...fb, fallback: true, waited: step.why };
    }
    if (step.wait) {
      s.pending = null;
      if (!offered.length) { s.waitSince = null; return setMessage(s, 'Đang chờ lượt'); }
      if (s.waitSince == null) s.waitSince = t;
      else if (t - s.waitSince >= waitStallMs) return stop(rid, 'Tự đánh dừng: ' + step.why, 'WAIT_STALL');
      return setMessage(s, step.why);
    }
    if (!step.fallback) s.waitSince = null; // a fallback keeps its clock through the human pause
    const key = autoPlay.stepKey(step);
    // the pause starts again when the step or this account's own picture changed — a teammate's hand or a balance does not
    if (!s.pending || s.pending.key !== key || s.pending.state !== refusalState) {
      s.pending = { key, state: refusalState, at: t, wait: elapsed >= hurryMs ? Math.min(pause(), hurryPauseMs) : pause() };
      return setMessage(s, 'Sắp: ' + step.why);
    }
    if (t - s.pending.at < s.pending.wait) return;
    s.pending = null;
    // who sits next (one of ours or a GUEST) and what the guard blocked: every eat can be traced back to its discard
    const next = snap.nextOf && snap.nextOf[String(uid)] != null ? String(snap.nextOf[String(uid)]) : null;
    const guard = step.action === 'DANH' ? autoPlay.guardDiscards(snap, uid, members) : null;
    log('auto-play-decision', { runId: rid, uid: String(uid), snapshot: snap, offered, avoid: [...s.avoid], toolUids: members, options, step,
      next, nextOurs: next != null ? members.map(String).includes(next) : null, turnMs: elapsed,
      guard: guard && guard.kind ? { kind: guard.kind, blocked: guard.blocked.size } : null, ...(snap !== raw ? { hand: view.source } : {}),
      ...(step.fallback ? { fallback: true, waited: step.waited } : {}) });
    const press = { key, action: step.action, cards: step.cards, why: step.why, ...counts(raw, uid) };
    const res = await act(rid, { action: step.action, cards: step.cards }, snap); // bounded by the play-actions feature
    if (!s.on || s.generation !== generation) return;
    log('auto-play-step', { runId: rid, action: step.action, cards: step.cards, why: step.why, state, ok: !!(res && res.ok), code: res && res.error && res.error.code });
    if (res && res.ok) {
      s.lastPress = { ...press, at: now() };
      s.stats.presses++;
      if (s.lastRound !== raw.roundSeq) { s.lastRound = raw.roundSeq; s.stats.rounds++; }
      return setMessage(s, 'Vừa: ' + step.why);
    }
    const code = res && res.error && res.error.code;
    const message = (res && res.error && res.error.message) || code;
    if (code && STOP_CODES.has(code)) return stop(rid, 'Tự đánh dừng: ' + message, code);
    if (code && UNCERTAIN_CODES.has(code)) { s.lastPress = { ...press, at: now(), uncertain: true }; return setMessage(s, 'Trình duyệt trả lời chậm — chờ game nhận ' + step.why); }
    if (code && HAND_CODES.has(code)) {
      distrust(s, raw.roundSeq, code === 'PHOM_PLAY_CARD_NOT_IN_HAND' ? step.cards : []);
      s.fails++;
      if (s.fails >= pressRetries) return stop(rid, 'Tự đánh dừng: ' + message, code);
      return setMessage(s, message + ' — xem lại bài trên tay theo game');
    }
    return setMessage(s, message || 'Thử lại'); // busy / not offered yet — the next tick tries again
  }

  async function run(rid, s) {
    if (s.busy || !live(s)) return;
    s.busy = true;
    try { if (s.on) await tickOne(rid, s); else if (s.armed) await tryResume(rid, s); }
    catch (e) { stop(rid, 'Tự đánh lỗi: ' + String((e && e.message) || e).slice(0, 120), 'ERROR'); }
    finally { s.busy = false; }
  }
  // every live account once, side by side (the clocks above call run() per account; tests drive tick)
  async function tick() { await Promise.all([...runs].map(([rid, s]) => run(rid, s))); }

  // on = running OR armed to resume (the switch stays on, the user can still switch it off); stats = this session
  function status() {
    const out = {};
    for (const [rid, s] of runs) if (s.on || s.armed || s.message) out[rid] = { on: s.on || !!s.armed, resuming: !!s.armed, message: s.message, stats: { ...s.stats } };
    return out;
  }

  return {
    id: 'auto-play',
    start, stop, status, tick,
    documentReplaced({ run: r } = {}) { if (r) stop(String(r.id), 'Trang đã tải lại', 'DOCUMENT'); },
    closed({ run: r } = {}) {
      if (!r) return;
      const rid = String(r.id);
      stop(rid, null, 'CLOSED');
      const s = runs.get(rid);
      if (s && s.timer) clearTimer(s.timer);
      runs.delete(rid);
    },
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
