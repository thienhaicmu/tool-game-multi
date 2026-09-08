'use strict';

const EventEmitter = require('node:events');
const { AviatorContextTracker, ACTION: CTX_ACTION, STATE: CTX_STATE } = require('../protocol/aviator-context.cjs');

// ---------------------------------------------------------------------------
// AnalyticsContextRecovery — per-browser coordinator that turns passive context
// detection into bounded ENTRY-ONLY auto-recovery.
//
// It reuses the SAME proven pure primitive Control uses (AviatorContextTracker):
// two distinct freshness signals, VERIFY-before-ACT, bounded light re-entry, then
// escalate. Here "re-enter" means: ask the AnalyticsAviatorEntryGate to emit the
// fixed cmd100000 and wait for FRESH authoritative server evidence. There is no
// reload, no protocol replay, no wager path.
//
// It exposes ONE authoritative per-browser context summary as a composite state,
// overlaying recovery-only runtime states on the tracker's core states:
//   UNKNOWN | ACTIVE | VERIFYING | CONTEXT_LOST | REENTERING | LOGIN_REQUIRED | RECOVERY_FAILED
// ---------------------------------------------------------------------------

const STATE = Object.freeze({
  UNKNOWN: 'AVIATOR_UNKNOWN',
  ACTIVE: 'AVIATOR_ACTIVE',
  VERIFYING: 'AVIATOR_VERIFYING',
  CONTEXT_LOST: 'AVIATOR_CONTEXT_LOST',
  REENTERING: 'AVIATOR_REENTERING',
  LOGIN_REQUIRED: 'AVIATOR_LOGIN_REQUIRED',
  RECOVERY_FAILED: 'AVIATOR_RECOVERY_FAILED',
});

const DEFAULTS = Object.freeze({ freshMs: 20000, verifyWindowMs: 6000, maxReentryAttempts: 3 });

class AnalyticsContextRecovery extends EventEmitter {
  // deps: { entryGate, config?, now?, onDiag?(evt) }
  constructor({ entryGate, config = {}, now, onDiag } = {}) {
    super();
    this._gate = entryGate || null;
    this._cfg = { ...DEFAULTS, ...config };
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._onDiag = typeof onDiag === 'function' ? onDiag : () => {};
    this._tracker = new AviatorContextTracker({ now: this._now, config: this._cfg });
    this._failed = false;
    this._composite = STATE.UNKNOWN;
    this._everSeen = false;
  }

  state() { return this._composite; }
  snapshot() { return { state: this._composite, failed: this._failed, tracker: this._tracker.snapshot() }; }

  // ev (evidence snapshot supplied by the runtime each tick):
  //   now                monotonic ms
  //   lastAviatorMono    monotonic time of last authoritative SERVER Aviator evidence (null=never)
  //   lastWsRecvMono     monotonic time of ANY recv WS traffic (lobby chatter included)
  //   wcAlive            in-app webContents alive
  //   wsConnected        an owning WS is up
  //   lastWsRecvFresh    non-Aviator traffic still flowing (lobby alive)
  //   loginRequired      a login/auth wall is up (best-effort)
  //   hasSocket          an eligible game socket context exists to carry an enter frame
  tick(ev = {}) {
    const now = ev.now != null ? ev.now : this._now();
    if (ev.lastAviatorMono != null) this._everSeen = true;
    const loginRequired = ev.loginRequired === true;

    // Page health for the tracker. When a login wall is up, or there is no eligible game
    // socket to carry an enter request, the page is NOT healthy for re-entry: the tracker
    // stays UNKNOWN and issues NO REENTER, so we never burn the bounded budget while merely
    // waiting for login / socket. (This also gives free LOGIN auto-retry: once login clears
    // and a socket is back, the very next silent tick advances to CONTEXT_LOST → REENTER.)
    const pageHealthy = !!(ev.wcAlive && ev.wsConnected && ev.lastWsRecvFresh && !loginRequired && ev.hasSocket);

    // Pre-tick pending state suppresses a DUPLICATE REENTER while an attempt is already in flight.
    const gatePendingBefore = !!(this._gate && this._gate.isPending && this._gate.isPending());
    const result = this._tracker.tick({
      now,
      lastAviatorMono: ev.lastAviatorMono != null ? ev.lastAviatorMono : null,
      lastWsRecvMono: ev.lastWsRecvMono != null ? ev.lastWsRecvMono : null,
      pageHealthy,
      hasIntent: this._everSeen, // Analytics expects Aviator once it has ever seen it
      reentryInFlight: gatePendingBefore,
    });
    const base = result.state;

    // Fresh authoritative evidence ends any failure/recovery episode.
    if (base === CTX_STATE.ACTIVE) this._failed = false;

    for (const a of result.actions) {
      if (a === CTX_ACTION.REENTER) this._startEntry(now);
      else if (a === CTX_ACTION.ESCALATE_FULL_RECOVERY) {
        this._failed = true;
        this._diag('AVIATOR_REENTRY_FAILED', { reason: 'REENTRY_EXHAUSTED' });
      }
    }

    // Compose from the pending state AFTER any attempt just started this tick.
    const gatePending = !!(this._gate && this._gate.isPending && this._gate.isPending());
    const next = this._composeState(base, { loginRequired, gatePending });
    if (next !== this._composite) {
      const from = this._composite; this._composite = next;
      this.emit('state', { from, to: next });
      this._diag('AVIATOR_CONTEXT_STATE', { from, to: next });
    }
    return { state: next };
  }

  _startEntry(now) {
    if (!this._gate || !this._gate.requestEntry) return;
    this._diag('AVIATOR_REENTRY_REQUESTED', { attempt: this._tracker.reentryAttempts() });
    this._diag('AVIATOR_REENTRY_STARTED', { attempt: this._tracker.reentryAttempts() });
    Promise.resolve(this._gate.requestEntry()).then((res) => {
      // Report the attempt settled so the NEXT confirmed CONTEXT_LOST tick may issue the next
      // bounded attempt. Success is proven by fresh evidence (tick → ACTIVE), not by this resolve.
      try { this._tracker.reentryFinished(); } catch { /* noop */ }
      if (res && res.ready) this._diag('AVIATOR_REENTRY_CONFIRMED', {});
      else this._diag('AVIATOR_REENTRY_ATTEMPT_FAILED', { error: res && res.error && res.error.code });
    }).catch(() => { try { this._tracker.reentryFinished(); } catch { /* noop */ } });
  }

  _composeState(base, { loginRequired, gatePending }) {
    if (this._failed) return STATE.RECOVERY_FAILED;
    if (gatePending) return STATE.REENTERING;
    if (loginRequired && this._everSeen) return STATE.LOGIN_REQUIRED;
    switch (base) {
      case CTX_STATE.ACTIVE: return STATE.ACTIVE;
      case CTX_STATE.VERIFYING: return STATE.VERIFYING;
      case CTX_STATE.CONTEXT_LOST: return STATE.CONTEXT_LOST;
      case CTX_STATE.UNKNOWN:
      default:
        // Aviator seen before but currently silent + not re-entrable (no socket / disconnected):
        // surface as context-lost (waiting), never a false ACTIVE.
        return this._everSeen ? STATE.CONTEXT_LOST : STATE.UNKNOWN;
    }
  }

  _diag(event, extra) { try { this._onDiag({ event, ...extra, at: this._now() }); } catch { /* diag best-effort */ } }

  // Browser/profile/session closed — invalidate everything so late frames/callbacks cannot
  // resurrect a closed recovery.
  dispose() {
    try { if (this._gate && this._gate.cancel) this._gate.cancel('ANALYTICS_ENTRY_CANCELLED'); } catch { /* noop */ }
    try { this._tracker.reset(); } catch { /* noop */ }
    this._failed = false;
    this._composite = STATE.UNKNOWN;
    this.removeAllListeners();
  }
}

module.exports = { AnalyticsContextRecovery, STATE, DEFAULTS };
