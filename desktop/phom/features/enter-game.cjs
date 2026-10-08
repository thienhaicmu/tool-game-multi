'use strict';

// ---------------------------------------------------------------------------
// FEATURE enter-game — VÀO GAME on one browser (the bar's button and the AUTO entry both come through start()).
//  start:  starts the click→ENTERED clock, shows ĐANG VÀO GAME, fires the game's own vgcg_8 tile (INVOKED != ENTERED)
//          and arms a BOUNDED entering window: no authoritative evidence within timeoutMs → back to VÀO GAME.
//  push:   evidence (view.inGame = socketReady + connected + channel list) clears the entering state and logs the
//          latency once. AUTO: as soon as a browser has LOGGED IN and is not in Phỏm yet the tool presses VÀO GAME
//          — once per page load; a click that did not get in is retried a few times (the lobby may still be building).
//  documentReplaced: a new page = a new login → the auto entry runs again (a VÀO GAME in flight is kept: that
//          navigation is the one it waits for).
//
// state: session.enter = { entering, startedAt, timer, auto: { tries, nextAt, done, timer } | null }
//        session.header.busy is the bar's single-flight flag (the auto entry respects and takes it).
// deps:  { sessions, enter(rid) → Promise<{ok}>, timeoutMs, autoEnabled(), log, refresh(), now }
// ---------------------------------------------------------------------------

const AUTO_SETTLE_MS = 1500;    // after login, let the lobby scene finish building
const AUTO_NOT_READY_MS = 3000; // the tile did not resolve yet → look again soon
const AUTO_MAX_TRIES = 5;

function createEnterGameFeature({ sessions, enter, timeoutMs, autoEnabled = () => true, log = () => {}, refresh = () => {}, now = () => Date.now() }) {
  function clearTimer(s) { if (s.enter.timer) { try { clearTimeout(s.enter.timer); } catch { /* ignore */ } s.enter.timer = null; } }
  function stopEntering(s) { s.enter.entering = false; s.enter.startedAt = null; clearTimer(s); }
  function clearAuto(s) { const a = s.enter.auto; if (a && a.timer) clearTimeout(a.timer); s.enter.auto = null; }

  async function start(rid, meta = {}) {
    const s = sessions.get(rid);
    s.enter.startedAt = now(); // T6 — the click→ENTERED latency clock
    s.enter.entering = true;
    clearTimer(s);
    // §10 — bounded ENTERING: reverts to VÀO GAME when no evidence arrives (never a permanent "ĐANG VÀO GAME…")
    s.enter.timer = setTimeout(() => {
      s.enter.timer = null;
      if (s.enter.entering) { s.enter.entering = false; s.enter.startedAt = null; log('ENTER_GAME_TIMEOUT', { runId: rid, elapsedMs: timeoutMs }); refresh(); }
    }, timeoutMs);
    refresh();
    log('ENTER_GAME_START', { runId: rid, ...meta, elapsedMs: 0 });
    let res;
    try { res = await enter(rid); } catch (e) { res = { ok: false, error: { code: 'PHOM_ENTRY_FAILED', message: String((e && e.message) || e).slice(0, 200) } }; }
    const startedAt = s.enter.startedAt;
    if (!res || res.ok === false) stopEntering(s);
    log(res && res.ok ? 'ENTER_GAME_ACTION_SENT' : 'ENTER_GAME_FAIL', { runId: rid, ...meta, ok: !!(res && res.ok), elapsedMs: Math.round(now() - (startedAt != null ? startedAt : now())) });
    return res;
  }

  function auto(rid, s, view, b) {
    if (!autoEnabled()) return;
    if (!b || !b.loggedIn || !view.opened || view.dataStale) return;
    const st = s.enter.auto || (s.enter.auto = { tries: 0, nextAt: now() + AUTO_SETTLE_MS, done: false, timer: null });
    if (view.inGame) { if (!st.done) { st.done = true; log('AUTO_ENTER_DONE', { runId: rid, tries: st.tries }); } return; }
    if (st.done || st.tries >= AUTO_MAX_TRIES || s.enter.entering || s.header.busy) return;
    const wait = st.nextAt - now();
    if (wait > 0) { if (!st.timer) st.timer = setTimeout(() => { st.timer = null; refresh(); }, wait + 20); return; }
    st.tries += 1;
    st.nextAt = Infinity; // nothing else fires until this attempt settles
    s.header.busy = true;
    start(rid, { source: 'auto', attempt: st.tries })
      .then((res) => { st.nextAt = now() + (res && res.ok ? timeoutMs : AUTO_NOT_READY_MS); })
      .catch(() => { st.nextAt = now() + AUTO_NOT_READY_MS; })
      .finally(() => { s.header.busy = false; if (st.tries >= AUTO_MAX_TRIES) log('AUTO_ENTER_GAVE_UP', { runId: rid, tries: st.tries }); refresh(); });
  }

  return {
    id: 'enter-game',
    start,
    // the bar's ĐANG VÀO GAME — pending + not in game + inside the bounded window (game-header.enteringActive decides)
    pending: (rid) => { const s = sessions.peek(rid); return { pending: !!(s && s.enter.entering), startedAt: s ? s.enter.startedAt : null }; },
    push({ run, session, view, browser }) {
      const rid = String(run.id);
      auto(rid, session, view, browser);
      if (view && view.inGame) {
        // authoritative evidence — clear ENTERING, log the click→ENTERED latency once
        const startedAt = session.enter.startedAt;
        session.enter.entering = false; clearTimer(session);
        if (startedAt != null) { log('ENTER_GAME_EVIDENCE', { runId: rid, slotId: run.slot, elapsedMs: Math.round(now() - startedAt) }); session.enter.startedAt = null; }
      }
    },
    documentReplaced({ session }) { clearAuto(session); },
    // the tool's own reload (⟳ / TẢI LẠI): ENTERING is over too
    reset(rid) { const s = sessions.peek(rid); if (s) stopEntering(s); },
    // the page's CDP session went away: the latency clock stops
    detached(rid) { const s = sessions.peek(rid); if (s) s.enter.startedAt = null; },
    closed({ session }) { stopEntering(session); clearAuto(session); },
  };
}

module.exports = { createEnterGameFeature, AUTO_SETTLE_MS, AUTO_NOT_READY_MS, AUTO_MAX_TRIES };
