'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// Stop1000Guard — WU-D. Per-BrowserRun Auto SESSION kill switch.
//
// This is NOT stopOdd (the per-round cashout threshold owned by AutoRunner).
// stopOdd cashes out ONE qualifying round and the Auto session continues; this
// guard terminates the ENTIRE Auto session for its owning BrowserRun the moment
// the authoritative server round reaches 1000x.
//
// AUTHORITATIVE SOURCE (§7.1): the guard reads the run's OWN RoundObserver
// (currentRound().currentOdd — derived only from recv cmd:100009). It does NOT
// depend on AutoRunner's per-round odd listener, which may already have cashed
// out at stopOdd and stopped watching that round's odd. The kill switch must
// stay able to observe 1000x regardless of AutoRunner's per-round state.
//
// Raw decimal semantics (§7.2): trigger when currentOdd >= 1000. No /100, no
// *scale, no oddScale — the value is used exactly as the observer reports it.
//
// Isolation (§7.4): the guard reads only its own run's observer and stops only
// its own run's AutoRunner. Browser A reaching 1000x never touches browser B.
// ---------------------------------------------------------------------------

const STOP_1000X_THRESHOLD = 1000;
const REASON = 'STOPPED_1000X_REACHED';

const STATE = Object.freeze({ IDLE: 'IDLE', ARMED: 'ARMED', STOPPED_1000X: 'STOPPED_1000X' });

class Stop1000Guard extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._observer = deps.observer || null;         // RoundObserver — authoritative ODD
    this._autoRunner = deps.autoRunner || null;     // owning run's AutoRunner
    this._now = deps.now || (() => Date.now());
    this._browserId = deps.browserId != null ? String(deps.browserId) : null;
    this._browserRunId = deps.browserRunId != null ? String(deps.browserRunId) : null;

    this._armed = false;      // guard is watching this Auto session
    this._enabled = false;    // config.stopAutoAt1000x for the armed session
    this._fired = false;      // exactly-once latch (only reset by a fresh arm())
    this._evidence = null;

    // Observe the run's OWN authoritative odd stream. RoundObserver emits 'update'
    // on every ingested frame; we re-evaluate the current authoritative odd.
    if (this._observer && this._observer.on) this._observer.on('update', () => this._check());
  }

  // Arm for a NEW Auto session using its snapshot config. This is the ONLY place the
  // exactly-once latch is reset — so no delayed/superseded frame from a prior session
  // can ever fire a stop against a fresh session it does not belong to.
  arm(config = {}) {
    this._enabled = (config && config.stopAutoAt1000x) === true;
    this._armed = true;
    this._fired = false;
    this._evidence = null;
    this.emit('state', this.state());
    // Evaluate immediately: the round may already be >= 1000 at arm time (state-based).
    this._check();
    return { armed: this._armed, enabled: this._enabled, threshold: STOP_1000X_THRESHOLD };
  }

  // Stop watching (manual STOP / normal completion / disconnect). The fired latch is
  // intentionally NOT cleared here: a terminated session stays terminated until a new
  // arm(). Re-arming (a fresh Auto start) is the only way to watch again.
  disarm() { this._armed = false; this.emit('state', this.state()); }
  onDisconnect() { this.disarm(); }

  state() { return this._fired ? STATE.STOPPED_1000X : (this._armed && this._enabled ? STATE.ARMED : STATE.IDLE); }
  enabled() { return this._enabled; }
  armed() { return this._armed; }
  fired() { return this._fired; }
  threshold() { return STOP_1000X_THRESHOLD; }
  evidence() { return this._evidence ? { ...this._evidence } : null; }

  _check() {
    if (!this._armed || !this._enabled || this._fired) return;
    // Only fire while the Auto session is actually running (a completed/stopped
    // session must not be resurrected or re-terminated by a late odd frame §7.3).
    if (!this._autoRunner || !this._autoRunner.isRunning || !this._autoRunner.isRunning()) return;
    const cur = this._observer && this._observer.currentRound ? this._observer.currentRound() : null;
    const odd = cur ? cur.currentOdd : null;
    if (odd == null || !Number.isFinite(Number(odd))) return;
    if (Number(odd) >= STOP_1000X_THRESHOLD) this._fire(cur, Number(odd));
  }

  _fire(cur, odd) {
    if (this._fired) return;              // exactly-once
    this._fired = true;
    this._evidence = {
      browserId: this._browserId,
      browserRunId: this._browserRunId,
      sid: cur ? cur.sid : null,
      threshold: STOP_1000X_THRESHOLD,
      observedOdd: odd,                   // exact authoritative odd that crossed 1000x
      observedAt: this._now(),
      reason: REASON,
    };
    // Terminate the ENTIRE Auto session for THIS run, exactly once, with a distinct
    // terminal reason. AutoRunner latches off (needs a fresh start() to run again),
    // so next ROUND_OPEN / ROUND_END / delayed ACK cannot restart it.
    try { if (this._autoRunner && this._autoRunner.stop) this._autoRunner.stop({ reason: REASON, stop1000: true }); }
    catch { /* stop is best-effort; the latch + event still record the terminal fact */ }
    this.emit('stop1000', this.evidence());
    this.emit('state', this.state());
  }
}

module.exports = { Stop1000Guard, STOP_1000X_THRESHOLD, REASON, STATE };
