'use strict';

// SessionRecoveryWatchdog — ONE evidence-based recovery state machine per BrowserRun.
//
// A long-running game/session can go stale: the site session times out, the page redirects
// away from Aviator, the WebSocket disappears, the worker/iframe instrumentation is destroyed,
// or the renderer crashes. A missing ODD is NOT proof of failure (there are legitimate quiet
// between-round pauses), so this watchdog never reloads on "no ODD for N seconds" alone. It
// combines evidence, VERIFIES before acting, recovers EXACTLY ONCE per confirmed staleness with
// bounded retries, and refuses to fabricate protocol state or auto-resend uncertain wagers.
//
// This is a PURE state machine: tick(evidence) returns { state, actions, reason }. The wiring
// layer maps actions to real actuators (pause automation, focus, reload, navigate, re-enter) and
// supplies evidence (RoundObserver status, last-aviator-frame time, WS/renderer/URL health). It
// is Electron-free so the full transition model is deterministically unit-testable.

const EventEmitter = require('node:events');

const STATE = Object.freeze({
  HEALTHY: 'HEALTHY',
  SUSPECT: 'SUSPECT',
  VERIFYING: 'VERIFYING',
  RECOVERING: 'RECOVERING',
  WAITING_PAGE: 'WAITING_PAGE',
  WAITING_AVIATOR: 'WAITING_AVIATOR',
  READY: 'READY',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
});

// Evidence/reason codes surfaced for diagnostics (§43).
const REASON = Object.freeze({
  AVIATOR_TRAFFIC_STALE: 'AVIATOR_TRAFFIC_STALE',
  WS_CLOSED: 'WS_CLOSED',
  PAGE_REDIRECTED: 'PAGE_REDIRECTED',
  WORKER_LOST: 'WORKER_LOST',
  RENDERER_STALE: 'RENDERER_STALE',
  FRESH_TRAFFIC_CONFIRMED: 'FRESH_TRAFFIC_CONFIRMED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  RELOAD_STARTED: 'RELOAD_STARTED',
  NAVIGATE_CONFIGURED: 'NAVIGATE_CONFIGURED',
  REENTRY_STARTED: 'REENTRY_STARTED',
  RECOVERY_READY: 'RECOVERY_READY',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  FOCUS_RESTORED: 'FOCUS_RESTORED',
});

const ACTION = Object.freeze({
  PAUSE_AUTOMATION: 'PAUSE_AUTOMATION',
  INVALIDATE_STATE: 'INVALIDATE_STATE',
  FOCUS_VIEW: 'FOCUS_VIEW',
  RELOAD: 'RELOAD',
  NAVIGATE_CONFIGURED: 'NAVIGATE_CONFIGURED',
  REENTER: 'REENTER',
  MARK_READY: 'MARK_READY',
  RESUME_AUTOMATION: 'RESUME_AUTOMATION',
  REQUIRE_USER_ACTION: 'REQUIRE_USER_ACTION',
});

// Defaults are conservative and centralised (§24/§38). The wiring layer may override from measured
// timing; nothing here is scattered as a magic number elsewhere.
const DEFAULTS = Object.freeze({
  // Only start suspecting protocol staleness once automation expects rounds and no Aviator frame
  // has arrived for materially longer than a normal between-round gap.
  suspectNoAviatorMs: 20000,
  // How long to keep verifying (waiting for legitimate traffic to resume) before confirming stale.
  verifyWindowMs: 6000,
  // How long to wait for the page/instrumentation to come back after a reload/navigate.
  waitPageMs: 20000,
  // How long to wait for fresh Aviator protocol after re-entry before retrying/failing.
  waitAviatorMs: 20000,
  maxAttempts: 3,
  retryDelayMs: 3000,
});

class SessionRecoveryWatchdog extends EventEmitter {
  // isLocalEndpoint(): boolean — true only for local/test/dev-owned authorized endpoints, where
  // automation MAY auto-resume after READY. For public/wagering endpoints it must require explicit
  // user action before any wager (§37).
  constructor({ now, config = {}, isLocalEndpoint = () => false } = {}) {
    super();
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._cfg = { ...DEFAULTS, ...config };
    this._isLocal = isLocalEndpoint;
    this._state = STATE.HEALTHY;
    this._reason = null;
    this._attempts = 0;
    this._enteredAt = this._now();     // when we entered the current state
    this._recoveryStartMono = null;    // monotonic ref captured at recovery start (for fresh-traffic checks)
    this._actionResultUnknown = false; // an in-flight BET/CASHOUT ACK was pending when we went stale
    this._autoIntent = false;          // automation was running before staleness (for resume policy)
  }

  state() { return this._state; }
  reason() { return this._reason; }
  attempts() { return this._attempts; }
  actionResultUnknown() { return this._actionResultUnknown; }

  snapshot() {
    return {
      state: this._state,
      reason: this._reason,
      attempts: this._attempts,
      maxAttempts: this._cfg.maxAttempts,
      actionResultUnknown: this._actionResultUnknown,
      autoIntent: this._autoIntent,
      // Recovery reached READY on a public endpoint but did NOT auto-resume wagering — the user
      // must continue manually. Surfaced for the UI ("Cần tiếp tục thủ công"); not a state.
      userActionRequired: this._userActionRequired === true,
    };
  }

  // Manual reset (e.g. user reloaded/logged in themselves, or config changed) — converge back to
  // a single owning evaluation rather than starting a competing loop (§39).
  reset(reason = null) { this._transition(STATE.HEALTHY, reason); this._attempts = 0; this._recoveryStartMono = null; this._actionResultUnknown = false; this._userActionRequired = false; }

  _transition(next, reason) {
    if (next === this._state && reason === this._reason) return;
    const prev = this._state;
    this._state = next; this._reason = reason || null; this._enteredAt = this._now();
    this.emit('state', { from: prev, to: next, reason: this._reason, attempts: this._attempts });
  }

  // ev (evidence snapshot):
  //   monoNow                number  monotonic clock (ms)
  //   autoIntent            bool     automation is/was running (expects rounds)
  //   inflightAckPending    bool     a BET/CASHOUT ACK is currently unresolved
  //   observerStatus        string   RoundObserver status (RUNNING/OPEN/... or IDLE)
  //   lastAviatorMono       number|null  monotonic time of the last Aviator WS frame
  //   wsConnected           bool     the owning Aviator WebSocket is open
  //   rendererAlive         bool     webContents alive + responsive
  //   onConfiguredHost      bool     current page host matches the configured launch URL host
  //   loginDetected         bool     the page is a login/lobby wall (auth required)
  //   instrumentationReady  bool     page loaded + debugger child sessions attached
  //   freshAviatorSinceRecovery bool an Aviator frame arrived AFTER recovery navigation started
  // returns { state, actions:[...], reason }
  tick(ev = {}) {
    const now = ev.monoNow != null ? ev.monoNow : this._now();
    const actions = [];
    if (ev.autoIntent) this._autoIntent = true;

    switch (this._state) {
      case STATE.HEALTHY: {
        const r = this._detectStale(ev, now);
        if (r) this._transition(STATE.VERIFYING, r), this._verifyStart = now, this._verifyBaselineMono = ev.lastAviatorMono || null;
        break;
      }
      case STATE.SUSPECT: // (unused external entry) treat like verifying
      case STATE.VERIFYING: {
        // Legitimate traffic returned during verification → cancel, no reload (§28).
        const advanced = ev.lastAviatorMono != null && this._verifyBaselineMono != null && ev.lastAviatorMono > this._verifyBaselineMono;
        const looksHealthy = ev.wsConnected && ev.rendererAlive && ev.onConfiguredHost && !ev.loginDetected;
        if ((advanced && looksHealthy) || (looksHealthy && this._reason === REASON.AVIATOR_TRAFFIC_STALE && advanced)) {
          this._transition(STATE.HEALTHY, REASON.FRESH_TRAFFIC_CONFIRMED);
          break;
        }
        if (ev.loginDetected) { this._transition(STATE.LOGIN_REQUIRED, REASON.LOGIN_REQUIRED); break; }
        if (now - this._verifyStart >= this._cfg.verifyWindowMs) {
          // Confirmed stale → begin exactly-one recovery attempt.
          this._beginRecovery(ev, now, actions);
        }
        break;
      }
      case STATE.RECOVERING: {
        // Emitted PAUSE/INVALIDATE on entry; now issue the navigation choice ONCE.
        if (ev.loginDetected) { this._transition(STATE.LOGIN_REQUIRED, REASON.LOGIN_REQUIRED); break; }
        if (!ev.onConfiguredHost) { actions.push(ACTION.NAVIGATE_CONFIGURED); this._transition(STATE.WAITING_PAGE, REASON.NAVIGATE_CONFIGURED); }
        else { actions.push(ACTION.RELOAD); this._transition(STATE.WAITING_PAGE, REASON.RELOAD_STARTED); }
        this._waitStart = now;
        break;
      }
      case STATE.WAITING_PAGE: {
        if (ev.loginDetected) { this._transition(STATE.LOGIN_REQUIRED, REASON.LOGIN_REQUIRED); break; }
        if (ev.instrumentationReady) { actions.push(ACTION.REENTER); this._transition(STATE.WAITING_AVIATOR, REASON.REENTRY_STARTED); this._waitStart = now; break; }
        if (now - this._waitStart >= this._cfg.waitPageMs) this._retryOrFail(now);
        break;
      }
      case STATE.WAITING_AVIATOR: {
        if (ev.loginDetected) { this._transition(STATE.LOGIN_REQUIRED, REASON.LOGIN_REQUIRED); break; }
        if (ev.freshAviatorSinceRecovery && ev.wsConnected) {
          this._transition(STATE.READY, REASON.RECOVERY_READY);
          actions.push(ACTION.MARK_READY);
          // Resume policy: only local/test endpoints may auto-resume automation (§37).
          if (this._autoIntent) {
            if (this._isLocal()) { actions.push(ACTION.RESUME_AUTOMATION); this._userActionRequired = false; }
            else { actions.push(ACTION.REQUIRE_USER_ACTION); this._userActionRequired = true; }
          }
          this._attempts = 0; this._actionResultUnknown = false;
          break;
        }
        if (now - this._waitStart >= this._cfg.waitAviatorMs) this._retryOrFail(now);
        break;
      }
      case STATE.READY: {
        // Settle back to steady-state monitoring once traffic is flowing healthily.
        if (ev.wsConnected && ev.rendererAlive && ev.onConfiguredHost) this._transition(STATE.HEALTHY, null);
        break;
      }
      case STATE.LOGIN_REQUIRED: {
        // Do NOT loop reloads. If the user logs in and protocol returns, re-evaluate.
        if (!ev.loginDetected && ev.onConfiguredHost && ev.freshAviatorSinceRecovery && ev.wsConnected) this._transition(STATE.HEALTHY, REASON.FRESH_TRAFFIC_CONFIRMED);
        break;
      }
      case STATE.RECOVERY_FAILED:
      default:
        break;
    }
    return { state: this._state, actions, reason: this._reason };
  }

  _detectStale(ev, now) {
    if (ev.rendererAlive === false) return REASON.RENDERER_STALE;
    if (ev.wsConnected === false) return REASON.WS_CLOSED;
    // NOTE: a host change alone is NOT staleness. Gambling sites legitimately redirect across
    // sibling domains (e.g. .chat -> .bike) while the game/WS stays healthy — treating that as a
    // "lost page" caused a false recovery in live testing. Redirects that actually lose the game
    // are caught by WS_CLOSED / login below; onConfiguredHost is used only to choose the recovery
    // ACTION (reload vs navigate-to-configured), never as a trigger.
    if (ev.workerLost === true) return REASON.WORKER_LOST;
    // Protocol silence ONLY counts when automation is actively expecting rounds and enough time
    // has passed that it exceeds a normal between-round pause — never on a healthy quiet gap.
    if (ev.autoIntent && ev.observerStatus === 'RUNNING' && ev.lastAviatorMono != null &&
        (now - ev.lastAviatorMono) > this._cfg.suspectNoAviatorMs) {
      return REASON.AVIATOR_TRAFFIC_STALE;
    }
    return null;
  }

  _beginRecovery(ev, now, actions) {
    this._attempts += 1;
    this._recoveryStartMono = now;
    // If a wager ACK was unresolved when we went stale, the result is UNKNOWN — never resend, never
    // infer win/loss (§30). Surface it; the wiring layer marks the AutoRunner action UNKNOWN.
    if (ev.inflightAckPending) this._actionResultUnknown = true;
    actions.push(ACTION.PAUSE_AUTOMATION);   // stop automation before navigation (§29)
    actions.push(ACTION.INVALIDATE_STATE);   // drop stale SID/ODD/socket/session ids (§31)
    this._transition(STATE.RECOVERING, this._reason);
  }

  _retryOrFail(now) {
    if (this._attempts >= this._cfg.maxAttempts) { this._transition(STATE.RECOVERY_FAILED, REASON.RECOVERY_FAILED); return; }
    // bounded retry with backoff: go back through RECOVERING (which re-issues one navigation).
    this._attempts += 1;
    this._transition(STATE.RECOVERING, this._reason);
  }

  // Edge events from the runtime (set flags the next tick reads). These are hints; tick() decides.
  onWsClosed() { this._wsClosedEdge = true; }
  onRendererGone() { this._rendererGoneEdge = true; }
}

module.exports = { SessionRecoveryWatchdog, STATE, REASON, ACTION, DEFAULTS };
