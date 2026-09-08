'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// AviatorContextTracker — the ONE evidence-based model for the distinction:
//
//     BROWSER / LOGIN HEALTHY   but   AVIATOR GAME CONTEXT LOST
//
// This is NOT generic session expiry (that stays owned by SessionRecoveryWatchdog:
// renderer crash / WS close / login wall / redirect). This models the case the audit
// proved was missed: the website silently returns the user from Aviator to the
// lobby/home while the browser stays open, the login stays valid, and non-Aviator
// WebSocket traffic keeps flowing — so Aviator-classified server frames simply STOP
// while everything else looks healthy.
//
// Design rules (mirrors the existing recovery philosophy):
//   - Two DISTINCT freshness signals: authoritative Aviator server evidence
//     (classified round-lifecycle / ODD / Jackpot) vs any received WS traffic.
//     Lobby/website chatter must never read as Aviator freshness.
//   - VERIFY-before-ACT: "no Aviator frame for X" is NEVER, by itself, context loss.
//     It only VERIFIES while the product still has an active reason to expect Aviator
//     AND the browser/login remain usable; a fresh Aviator frame during verification
//     cancels immediately and restores ACTIVE.
//   - Pure + Electron-free: tick(ev) -> { state, actions, reason }. The wiring layer
//     supplies evidence and maps actions to real actuators (light re-entry via the
//     existing AviatorEntryGate; escalation to the full session-recovery watchdog).
// ---------------------------------------------------------------------------

// Authoritative Aviator SERVER (recv) round-lifecycle command set — the classified
// evidence that a socket is genuinely inside the live Aviator game. Kept as literals
// (mirrors aviator-entry.cjs ENTRY_EVIDENCE_CMDS) so this pure module needs no
// protocol import. Jackpot evidence (eI.jp) is corroborated separately by the caller.
const AVIATOR_EVIDENCE_CMDS = new Set([100005, 100008, 100006, 100009, 100007]);

const STATE = Object.freeze({
  UNKNOWN: 'AVIATOR_UNKNOWN',        // never seen Aviator, or no active reason to expect it
  ACTIVE: 'AVIATOR_ACTIVE',          // fresh authoritative Aviator evidence observed
  VERIFYING: 'AVIATOR_VERIFYING',    // Aviator evidence went stale while still expected + page healthy
  CONTEXT_LOST: 'AVIATOR_CONTEXT_LOST', // verification confirmed the game context is gone
});

const ACTION = Object.freeze({
  REENTER: 'AVIATOR_REENTER',                       // healthy page: re-enter via ensureEntered (no reload)
  ESCALATE_FULL_RECOVERY: 'AVIATOR_ESCALATE_FULL_RECOVERY', // bounded re-entry exhausted: hand off to watchdog
});

const REASON = Object.freeze({
  FRESH_AVIATOR: 'FRESH_AVIATOR',
  AVIATOR_SILENT: 'AVIATOR_SILENT',
  CONTEXT_LOST_CONFIRMED: 'CONTEXT_LOST_CONFIRMED',
  REENTRY_STARTED: 'REENTRY_STARTED',
  REENTRY_EXHAUSTED: 'REENTRY_EXHAUSTED',
  NO_INTENT: 'NO_INTENT',
  PAGE_UNHEALTHY: 'PAGE_UNHEALTHY',
});

const DEFAULTS = Object.freeze({
  // Aviator counts as ACTIVE if a classified server frame arrived within this window.
  // MUST exceed a normal ROUND_END -> next ROUND_OPEN gap so quiet between-round pauses
  // (and short network jitter) never read as context loss.
  freshMs: 20000,
  // How long to VERIFY (page healthy, Aviator silent, still expected) before confirming
  // CONTEXT_LOST — a fresh Aviator frame in this window cancels back to ACTIVE.
  verifyWindowMs: 6000,
  // Bounded light re-entry attempts before escalating to the full session-recovery path.
  maxReentryAttempts: 3,
});

// Pure classifier: given evidence timestamps + health, return the context STATE.
//   ev: { now, lastAviatorMono, lastWsRecvMono?, pageHealthy, hasIntent? }
// - lastAviatorMono: monotonic time of the last CLASSIFIED Aviator server frame (null=never).
// - pageHealthy: browser/login usable (renderer alive + WS up + no login wall for Control;
//   WS traffic still flowing for passive Analytics). Distinguishes context-loss from a real
//   disconnect / session expiry (those are NOT this module's concern -> UNKNOWN).
// - hasIntent (default true): the product still expects Aviator (auto running / jackpot
//   waiting for Control; always true for Analytics once it has ever seen Aviator).
function deriveState(ev = {}, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const now = ev.now;
  const last = ev.lastAviatorMono;
  if (last == null) return STATE.UNKNOWN;                 // never seen Aviator yet
  const sinceAviator = now - last;
  if (sinceAviator <= c.freshMs) return STATE.ACTIVE;     // fresh (or normal between-round quiet)
  if (ev.hasIntent === false) return STATE.UNKNOWN;       // no active reason to expect Aviator
  if (ev.pageHealthy === false) return STATE.UNKNOWN;     // disconnect/expiry -> session recovery owns it
  if (sinceAviator <= c.freshMs + c.verifyWindowMs) return STATE.VERIFYING;
  return STATE.CONTEXT_LOST;
}

class AviatorContextTracker extends EventEmitter {
  constructor({ now, config = {} } = {}) {
    super();
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._cfg = { ...DEFAULTS, ...config };
    this._state = STATE.UNKNOWN;
    this._reentryAttempts = 0;   // bounded light-re-entry counter (reset on ACTIVE)
    this._reentryInFlight = false;
    this._escalated = false;
  }

  state() { return this._state; }
  reentryAttempts() { return this._reentryAttempts; }
  snapshot() { return { state: this._state, reentryAttempts: this._reentryAttempts, reentryInFlight: this._reentryInFlight, escalated: this._escalated }; }

  // tick(ev) -> { state, actions:[...], reason }
  //   ev: { now?, lastAviatorMono, lastWsRecvMono?, pageHealthy, hasIntent?, reentryInFlight? }
  tick(ev = {}) {
    const now = ev.now != null ? ev.now : this._now();
    const derived = deriveState({ ...ev, now }, this._cfg);
    const actions = [];
    let reason = null;
    const prev = this._state;

    if (derived === STATE.ACTIVE) {
      // Fresh authoritative Aviator evidence at ANY point ends the episode.
      this._reentryAttempts = 0;
      this._reentryInFlight = false;
      this._escalated = false;
      reason = REASON.FRESH_AVIATOR;
    } else if (derived === STATE.UNKNOWN) {
      this._reentryInFlight = false;
      this._escalated = false;
      reason = ev.hasIntent === false ? REASON.NO_INTENT : (ev.pageHealthy === false ? REASON.PAGE_UNHEALTHY : null);
    } else if (derived === STATE.VERIFYING) {
      reason = REASON.AVIATOR_SILENT;
    } else { // CONTEXT_LOST
      const inFlight = ev.reentryInFlight === true || this._reentryInFlight;
      if (inFlight || this._escalated) {
        // Duplicate context-loss evidence while a re-entry is in flight (or after we already
        // escalated) must NOT issue another action (no duplicate re-entry / reload).
        reason = REASON.CONTEXT_LOST_CONFIRMED;
      } else if (this._reentryAttempts < this._cfg.maxReentryAttempts) {
        this._reentryAttempts += 1;
        this._reentryInFlight = true;
        actions.push(ACTION.REENTER);
        reason = REASON.REENTRY_STARTED;
      } else {
        this._escalated = true;
        actions.push(ACTION.ESCALATE_FULL_RECOVERY);
        reason = REASON.REENTRY_EXHAUSTED;
      }
    }

    this._state = derived;
    if (prev !== derived) this.emit('state', { from: prev, to: derived, reason });
    return { state: derived, actions, reason };
  }

  // The caller reports a light re-entry attempt has settled (fresh evidence still pending).
  // This lets the NEXT confirmed CONTEXT_LOST tick issue the next bounded attempt.
  reentryFinished() { this._reentryInFlight = false; }

  reset() { this._state = STATE.UNKNOWN; this._reentryAttempts = 0; this._reentryInFlight = false; this._escalated = false; }
}

module.exports = { AviatorContextTracker, deriveState, STATE, ACTION, REASON, DEFAULTS, AVIATOR_EVIDENCE_CMDS };
