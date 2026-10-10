'use strict';

// ---------------------------------------------------------------------------
// FEATURE loop — VÒNG TỰ ĐÁNH: ONE switch for the whole group (user 2026-10-10: "tự đánh bật 1 lần cho 3 acc … vòng
// tròn khép kín, không tự dừng"). It stands ABOVE the two existing machines and only switches them / asks them:
//   TỰ ĐỘNG   (protocol/phom/table-group*: Dò Key → Tạo → Vào, ReJoin, the T8 full-table rules, next round)
//   Tự đánh   (features/auto-play.cjs, every playing account, unlimited resume while the loop is on)
//
//   find a table → wait for a stranger → play → round over: the stranger stays → next round · leaves → wait again
//
// Never stops by itself — what used to switch something off is retried:
//   TỰ ĐỘNG went off (a search failed, the regroup ceiling, the KEY replaced)  → on again after 3 s → 10 s → 30 s → 1 min
//   no stranger ready at the table for strangerWaitMs (3 min)                 → the group leaves and searches again
//   regroupLimit (3) searches in a row without a round, or failLimit (6) failed restarts → REST: everyone leaves, the
//     bell rings, restMs (5 min) later it starts again
//   no progress (not seated at a table, not waiting for a stranger, not playing) for stuckMs (5 min) → everyone leaves,
//     the search starts again
//   a playing browser CRASHED / exited unexpectedly → an open reserve (D/E) takes the slot, else the slot's own profile
//     reopens (per slot 30 s → 1 min → 2 min → 5 min); closed BY THE USER / the tool → an open reserve only, never
//     reopened (the rest play on); a playing account without money for the stake → an open reserve that has money
//   Tự đánh off on a playing account → on again
// It stops ONLY when the user switches it off, the key loses the Tự đánh right (expired / revoked), or the app closes.
//
// deps: licensed(), group: { autoActive, setAuto(on, {stake}), selectedStake, loopFacts, regroupNow(reason), leaveAll },
//   autoPlay: { start(rid), stop(rid, msg, code), status() }, slots() → [{ slot, runId, state, money }] (state = the
//   cluster's browserState: OPEN · CRASHED · EXITED_UNEXPECTEDLY · CLOSED_BY_USER · CLOSED_BY_APP · …),
//   reserves() → [{ reserve, runId, state, money }], swapSlot(slot, reserve), reopenSlot(slot), bell(message), log, refresh
//  IPC: phom:loop { on } → { ok, status }
// ---------------------------------------------------------------------------

const GROUP_BACKOFF_MS = Object.freeze([3000, 10000, 30000, 60000]);
const SLOT_BACKOFF_MS = Object.freeze([30000, 60000, 120000, 300000]);
const CRASH_STATES = new Set(['CRASHED', 'EXITED_UNEXPECTEDLY']);
const DOWN_GRACE_MS = 10000; // a browser closed from its window is swapped for a reserve by main at once — let that finish
const NOT_LICENSED = { code: 'PHOM_AUTO_PLAY_NOT_LICENSED', message: 'Key này chưa được cấp quyền Tự đánh — liên hệ admin để cấp key có tích "Cho dùng Tự đánh"' };

function createLoopFeature({ licensed = () => true, group, autoPlay, slots = () => [], reserves = () => [], swapSlot = async () => ({ ok: false }), reopenSlot = async () => ({ ok: false }),
  bell = () => {}, log = () => {}, refresh = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  tickMs = 2000, strangerWaitMs = 3 * 60000, stuckMs = 5 * 60000, restMs = 5 * 60000, regroupLimit = 3, failLimit = 6 }) {
  let on = false;
  let timer = null;
  let busy = false;
  let st = null;
  const fresh = () => ({ message: null, restUntil: 0, groupFails: 0, groupNextAt: 0, strangerSince: null, stuckSince: null, regroupsNoRound: 0,
    slotNext: new Map(), slotFails: new Map(), slotDownAt: new Map(), inRound: false, stats: { rounds: 0, regroups: 0, rests: 0, recoveries: 0 } });

  const setMessage = (m) => { if (st && st.message !== m) { st.message = m; refresh(); } };
  function schedule() { if (on && !timer) timer = setTimer(() => { timer = null; void tick().finally(schedule); }, tickMs); }

  function start() {
    if (!licensed()) return { ok: false, error: { ...NOT_LICENSED } };
    if (on) return { ok: true, status: status() };
    const facts = group.loopFacts && group.loopFacts();
    if (!(facts && facts.formed) && !(Number(group.selectedStake && group.selectedStake()) > 0)) {
      return { ok: false, error: { code: 'PHOM_INVALID_STAKE', message: 'Chọn Mức cược trước khi bật Tự đánh' } };
    }
    on = true; st = fresh();
    log('loop', { on: true });
    setMessage('Đang bắt đầu');
    void tick().finally(schedule);
    return { ok: true, status: status() };
  }
  // the user's switch (or the key losing its right): Tự đánh and TỰ ĐỘNG off, the accounts stay where they sit
  function stop(message = null, code = 'USER') {
    if (!on) return { ok: true };
    on = false;
    if (timer) { clearTimer(timer); timer = null; }
    for (const s of safe(slots)) if (s.runId) { try { autoPlay.stop(String(s.runId), null, code === 'USER' ? 'USER' : 'STOP_ALL'); } catch { /* gone */ } }
    try { group.setAuto(false); } catch { /* no session */ }
    log('loop', { on: false, code });
    if (st) st.message = message;
    refresh();
    return { ok: true };
  }
  function safe(fn) { try { return fn() || []; } catch { return []; } }

  function rest(reason) {
    const t = now();
    st.stats.rests++;
    st.restUntil = t + restMs; st.regroupsNoRound = 0; st.groupFails = 0; st.groupNextAt = st.restUntil; st.strangerSince = null; st.stuckSince = null;
    try { group.leaveAll(); } catch { /* nothing to leave */ }
    log('loop-rest', { reason, restMs });
    bell('Tự đánh nghỉ ' + Math.round(restMs / 60000) + ' phút: ' + reason + ' — sau đó tự chạy tiếp');
  }

  // a playing slot that cannot play: an open reserve takes it, else (a crash only) the slot's own profile reopens
  async function recoverSlots(facts) {
    const t = now();
    const stake = Number(group.selectedStake && group.selectedStake()) || 0;
    const free = safe(reserves).filter((r) => r.state === 'OPEN' && !(stake > 0 && r.money != null && Number(r.money) < stake));
    for (const s of safe(slots)) {
      const open = s.state === 'OPEN';
      const broke = open && stake > 0 && s.money != null && Number(s.money) < stake;
      if (open && !broke) { st.slotFails.delete(s.slot); st.slotDownAt.delete(s.slot); continue; }
      if (broke && (facts && facts.roundRunning)) continue; // never pull an account out of a round
      const crashed = CRASH_STATES.has(s.state);
      if (!open && !crashed && !free.length) continue;   // closed on purpose and no reserve: the others play on
      if (broke && !free.length) continue;               // no money but no one to replace it: it keeps its place
      if (!open) { if (!st.slotDownAt.has(s.slot)) st.slotDownAt.set(s.slot, t); if (t - st.slotDownAt.get(s.slot) < DOWN_GRACE_MS) continue; }
      if ((st.slotNext.get(s.slot) || 0) > t) continue;
      const fails = st.slotFails.get(s.slot) || 0;
      st.slotFails.set(s.slot, fails + 1);
      st.slotNext.set(s.slot, t + SLOT_BACKOFF_MS[Math.min(fails, SLOT_BACKOFF_MS.length - 1)]);
      const reserve = free.shift();
      let res;
      try { res = reserve ? await swapSlot(s.slot, reserve.reserve) : await reopenSlot(s.slot); } catch (e) { res = { ok: false, error: { message: String((e && e.message) || e) } }; }
      st.stats.recoveries++;
      log('loop-slot', { slot: s.slot, how: reserve ? 'RESERVE_' + reserve.reserve : 'REOPEN', why: broke ? 'NO_MONEY' : s.state, ok: !!(res && res.ok) });
      if (res && res.ok) { st.slotFails.delete(s.slot); st.slotDownAt.delete(s.slot); }
      return; // one recovery per tick — the cluster needs a moment
    }
  }

  async function tick() {
    if (!on || busy) return;
    busy = true;
    try {
      if (!licensed()) { stop('Tự đánh dừng: ' + NOT_LICENSED.message, NOT_LICENSED.code); return; }
      const t = now();
      if (st.restUntil > t) { setMessage('Đang nghỉ — chạy lại sau ' + Math.ceil((st.restUntil - t) / 1000) + ' giây'); return; }
      const facts = (group.loopFacts && group.loopFacts()) || { formed: false };
      await recoverSlots(facts);
      if (!on) return;
      // Tự đánh on for every playing account (a swapped-in reserve, a reopened browser, a stop that was final)
      const ap = autoPlay.status() || {};
      for (const s of safe(slots)) if (s.state === 'OPEN' && s.runId && !(ap[String(s.runId)] && ap[String(s.runId)].on)) { try { autoPlay.start(String(s.runId)); } catch { /* next tick */ } }

      if (facts.roundRunning) {
        if (!st.inRound) { st.inRound = true; st.stats.rounds++; }
        st.groupFails = 0; st.regroupsNoRound = 0; st.strangerSince = null; st.stuckSince = null;
        return setMessage('Đang đánh');
      }
      st.inRound = false;

      // TỰ ĐỘNG is off (a failed search, its regroup ceiling, the KEY replaced, a rest's leave-all): on again, slower each time
      if (!group.autoActive()) {
        st.strangerSince = null;
        if (st.groupFails >= failLimit) return rest('tìm bàn lỗi ' + failLimit + ' lần liền');
        if (t < st.groupNextAt) return setMessage('Tìm bàn lại sau ' + Math.ceil((st.groupNextAt - t) / 1000) + ' giây');
        const stake = Number(group.selectedStake && group.selectedStake()) || null;
        if (!stake && !facts.formed) return setMessage('Chưa chọn Mức cược');
        st.groupNextAt = t + GROUP_BACKOFF_MS[Math.min(st.groupFails, GROUP_BACKOFF_MS.length - 1)];
        st.groupFails++;
        setMessage('Đang tìm bàn');
        Promise.resolve(group.setAuto(true, stake ? { stake } : {})).then((res) => log('loop-auto', { ok: !!(res && res.ok !== false), code: res && res.error && res.error.code })).catch(() => {});
        return;
      }

      // seated at our table, nothing in the way: waiting for a stranger to sit down and get ready
      const waiting = facts.formed && facts.keySeated && !facts.busy && !facts.recreating;
      const strangerOk = facts.players >= 4 && facts.strangerReady;
      if (waiting && !strangerOk) {
        st.stuckSince = null;
        if (st.strangerSince == null) st.strangerSince = t;
        const left = st.strangerSince + strangerWaitMs - t;
        if (left > 0) return setMessage((facts.strangerSeated ? 'Người lạ chưa sẵn sàng' : 'Chờ người lạ vào bàn') + ' — đổi bàn sau ' + Math.ceil(left / 1000) + ' giây');
        st.strangerSince = null;
        if (st.regroupsNoRound >= regroupLimit) return rest('đổi ' + regroupLimit + ' bàn không có người lạ');
        st.regroupsNoRound++; st.stats.regroups++;
        log('loop-regroup', { reason: 'NO_STRANGER', n: st.regroupsNoRound });
        group.regroupNow('NO_STRANGER');
        return setMessage('Không có người lạ — đổi bàn');
      }
      st.strangerSince = null;
      // anything else (searching, a stranger ready but no start, recreating …) must turn into a round or a wait in time
      if (st.stuckSince == null) st.stuckSince = t;
      if (t - st.stuckSince >= stuckMs) {
        st.stuckSince = null; st.groupFails++;
        log('loop-stuck', { facts });
        try { group.leaveAll(); } catch { /* nothing */ }
        return setMessage('Kẹt quá ' + Math.round(stuckMs / 60000) + ' phút — rời bàn, tìm lại');
      }
      return setMessage(strangerOk ? 'Người lạ đã sẵn sàng — chờ bắt đầu ván' : (facts.busy ? 'Đang ' + String(facts.busy).toLowerCase() : 'Đang tìm bàn'));
    } finally { busy = false; }
  }

  function status() {
    return { on, message: st ? st.message : null, resting: !!(st && st.restUntil > now()), stats: st ? { ...st.stats } : null };
  }

  return {
    id: 'loop',
    start, stop, status, tick,
    active: () => on,
    registerIpc(handle) {
      handle('phom:loop', (_e, cfg) => (cfg && cfg.on ? start() : stop(null, 'USER')), { guarded: true });
    },
  };
}

module.exports = { createLoopFeature, GROUP_BACKOFF_MS, SLOT_BACKOFF_MS };
