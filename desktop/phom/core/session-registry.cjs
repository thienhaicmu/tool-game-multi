'use strict';

// ---------------------------------------------------------------------------
// BROWSER SESSIONS (3.2 core). Everything the tool keeps about ONE open browser lives on ONE object, created on first
// use and DROPPED when that browser closes. Before 3.2 the same facts sat in ~15 separate `Object.create(null)` maps
// in phom-main keyed by runId (headerReady, headerEntering, autoEnterState, _lastRehookAt, …): any feature could read
// or write any of them, and none was ever cleaned when a browser closed.
//
// A session is a plain object with a fixed set of NAMESPACES — one per feature — so a feature only touches its own
// part and the reader can see at a glance which feature owns a value:
//   session.header      — the in-page bar (ready / DOM present / last pushed state / error / keys)
//   session.enter       — VÀO GAME (entering, started at, timeout handle, auto-enter tries)
//   session.capture     — the WS capture hook (last re-hook time)
//   session.memory      — the memory watch (warned / killed)
//   session.origin      — the login origin / account name followed into the profile
//   session.window      — the frame lock (the bounds Chromium really took for its rect)
//   session.recent      — the tool's last steps for this browser (event@time), for diagnostics
// ---------------------------------------------------------------------------

const RECENT_MAX = 20;

function newSession(runId) {
  return {
    runId: String(runId),
    header: { ready: false, domPresent: false, lastPushed: null, error: null, errorState: null, keys: new Set(), busy: false, lastActionId: null, findConfirmUntil: 0 },
    enter: { entering: false, startedAt: null, timer: null, auto: null },
    capture: { lastRehookAt: 0 },
    memory: { warned: false, killed: false },
    origin: { lastTopUrl: null, asked: false, saved: null },
    window: { accepted: null },
    recent: [],
  };
}

function createSessionRegistry({ now = () => Date.now() } = {}) {
  const sessions = new Map();
  const closers = [];   // (session) => void — features release what they hold (timers…) when a browser goes
  return {
    // the session of a browser — created on first use
    get(runId) {
      const k = String(runId);
      let s = sessions.get(k);
      if (!s) { s = newSession(k); sessions.set(k, s); }
      return s;
    },
    peek(runId) { return sessions.get(String(runId)) || null; },
    has(runId) { return sessions.has(String(runId)); },
    ids() { return [...sessions.keys()]; },
    // a feature registers what to release when a browser closes
    onDrop(fn) { if (typeof fn === 'function') closers.push(fn); },
    // the browser closed: every feature releases its part, then the whole session goes
    drop(runId) {
      const k = String(runId);
      const s = sessions.get(k);
      if (!s) return false;
      for (const fn of closers) { try { fn(s); } catch { /* one feature never blocks the others */ } }
      sessions.delete(k);
      return true;
    },
    // the tool's last steps for this browser (bounded) — attached to diagnostics such as a memory alarm
    note(runId, event) {
      const s = this.get(runId);
      s.recent.push(event + '@' + new Date(now()).toISOString().slice(11, 19));
      if (s.recent.length > RECENT_MAX) s.recent.shift();
    },
    size() { return sessions.size; },
  };
}

module.exports = { createSessionRegistry, RECENT_MAX };
