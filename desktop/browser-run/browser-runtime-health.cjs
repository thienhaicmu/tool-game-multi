'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// BrowserRuntimeHealth — the ONE evidence-based model for BROWSER RUNTIME liveness,
// answering a single question per BrowserRun:
//
//     Is this BrowserRun still alive and behaving like an open, running browser?
//
// This is DELIBERATELY separate from AviatorContextTracker (game context) and from
// SessionRecoveryWatchdog (session/recovery orchestration). A browser can be LIVE
// while the game is CONTEXT_LOST or sitting in the lobby — those are game-level
// concerns and must never mark the browser runtime unhealthy.
//
//   browserRuntimeState = LIVE      may coexist with   aviatorContextState = ACTIVE
//   browserRuntimeState = LIVE      may coexist with   aviatorContextState = CONTEXT_LOST
//   browserRuntimeState = LIVE      may coexist with   current page = Lobby
//
// Liveness is derived from the OWNING run's real WebContents operational signals
// (render-process-gone / unresponsive / did-finish-load / isDestroyed) — NOT from the
// mere existence of the webContents object (§9), and NEVER from the UI selection. A
// non-selected (hidden) view is fully LIVE: on this Electron runtime a background
// WebContentsView keeps its renderer, timers (backgroundThrottling:false) and
// WebSocket/network alive; only document.visibilityState becomes 'hidden' + rAF
// pauses, which is normal real-browser background behaviour and a GAME-level signal.
//
// Pure + Electron-free: tick(ev) -> { state, changed }. The wiring layer supplies the
// evidence snapshot from the run's WebContents. Fully unit-testable.
// ---------------------------------------------------------------------------

const STATE = Object.freeze({
  LAUNCHING: 'LAUNCHING',           // view/webContents created, first page load not yet finished
  LIVE: 'LIVE',                     // renderer alive + responsive + a page has loaded
  DEGRADED: 'DEGRADED',             // renderer alive but temporarily unresponsive
  LOGIN_REQUIRED: 'LOGIN_REQUIRED', // browser alive, but the page is a login/auth wall
  CRASHED: 'CRASHED',               // renderer process gone (crash / killed)
  CLOSED: 'CLOSED',                 // webContents destroyed / run torn down
});

// Pure classifier. ev:
//   wcExists       bool   the run still owns a WebContents object
//   wcDestroyed    bool   webContents.isDestroyed()
//   rendererGone   bool   a 'render-process-gone' fired and not recovered
//   unresponsive   bool   'unresponsive' fired without a following 'responsive'
//   pageLoaded     bool   at least one 'did-finish-load' has completed
//   loginDetected  bool   the current page is a login/auth wall (browser is fine, user must act)
//
// Ordering is by severity so the most authoritative failure wins. Note: liveness is
// proven by operational signals, never by wcExists alone (§9).
function deriveBrowserRuntimeState(ev = {}) {
  if (!ev.wcExists || ev.wcDestroyed === true) return STATE.CLOSED;
  if (ev.rendererGone === true) return STATE.CRASHED;
  if (ev.unresponsive === true) return STATE.DEGRADED;
  if (ev.pageLoaded !== true) return STATE.LAUNCHING;
  if (ev.loginDetected === true) return STATE.LOGIN_REQUIRED;
  return STATE.LIVE;
}

class BrowserRuntimeHealth extends EventEmitter {
  constructor({ now } = {}) {
    super();
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._state = STATE.LAUNCHING;
    this._since = this._now();
    this._lastEv = null;
  }

  state() { return this._state; }
  isLive() { return this._state === STATE.LIVE; }
  snapshot() { return { state: this._state, since: this._since, lastEvidence: this._lastEv }; }

  // tick(ev) -> { state, changed }. Selection is never an input; two runs tick independently.
  tick(ev = {}) {
    const next = deriveBrowserRuntimeState(ev);
    this._lastEv = ev;
    const prev = this._state;
    const changed = next !== prev;
    if (changed) { this._state = next; this._since = this._now(); this.emit('state', { from: prev, to: next }); }
    return { state: next, changed };
  }

  reset() { this._state = STATE.LAUNCHING; this._since = this._now(); this._lastEv = null; }
}

module.exports = { BrowserRuntimeHealth, deriveBrowserRuntimeState, STATE };
