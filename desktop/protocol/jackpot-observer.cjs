'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// JackpotObserver — WU-C.3. Read-only per-BrowserRun Jackpot telemetry.
//
// It consumes the RoundTracker recv-frame stream (it does NOT parse WebSocket
// itself and NEVER sends). Jackpot is authoritative ONLY from server (recv)
// evidence: the `eI.jp` field surfaced by classifyFrame as `ev.jp`. The value is
// kept verbatim (no scaling). Current jackpot is runtime truth: it is invalidated
// to null on socket/target loss and is never persisted.
// ---------------------------------------------------------------------------

class JackpotObserver extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._now = deps.now || (() => Date.now());
    this._current = null;      // number | null (verbatim eI.jp)
    this._observedAt = null;   // ms
    this._sourceCmd = null;    // cmd that carried the jp (diagnostics)
    this._sid = null;          // server sid seen alongside, if any
    if (deps.roundTracker && deps.roundTracker.on) deps.roundTracker.on('frame', (ev) => this._onFrame(ev));
  }

  _onFrame(ev) {
    if (!ev || ev.direction !== 'recv') return;              // recv-only authority (§4/§54)
    if (ev.jp == null || !Number.isFinite(Number(ev.jp))) return;
    this._current = Number(ev.jp);
    this._observedAt = this._now();
    this._sourceCmd = ev.cmd != null ? ev.cmd : null;
    if (ev.sid != null) this._sid = ev.sid;
    this.emit('update', this.snapshot());
  }

  current() { return this._current; }
  snapshot() { return { currentJackpot: this._current, jackpotObservedAt: this._observedAt, jackpotSourceCmd: this._sourceCmd, sid: this._sid }; }

  // Owning socket/target lost: current jackpot is no longer authoritative (§9/§39).
  onDisconnect() {
    if (this._current == null && this._observedAt == null) return;
    this._current = null; this._observedAt = null; this._sourceCmd = null; this._sid = null;
    this.emit('update', this.snapshot());
  }
}

module.exports = { JackpotObserver };
