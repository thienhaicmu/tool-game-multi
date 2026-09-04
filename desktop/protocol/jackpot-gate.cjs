'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// JackpotGate — WU-C.3. Per-BrowserRun Auto Run prerequisite that releases the
// AutoRunner only once the run's OWN authoritative jackpot reaches a threshold.
//
// State-based (not crossing): READY the instant currentJackpot >= threshold, even
// if it was already above at START. Exactly-once release. Cancellable (manual STOP
// / disconnect / close) — a cancelled wait is never later released. Never global:
// it reads only its own run's JackpotObserver.
// ---------------------------------------------------------------------------

const STATE = Object.freeze({ IDLE: 'IDLE', WAITING: 'WAITING', READY: 'READY' });

class JackpotGate extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._observer = deps.observer || null;
    this._state = STATE.IDLE;
    this._pending = null; // { threshold, resolve, promise, done }
    if (this._observer && this._observer.on) this._observer.on('update', () => this._onJackpot());
  }

  state() { return this._state; }
  threshold() { return this._pending ? this._pending.threshold : null; }
  isWaiting() { return this._state === STATE.WAITING; }

  // Resolve READY immediately if the current authoritative jackpot already satisfies
  // the threshold; otherwise wait for an authoritative update that reaches it. A single
  // in-flight wait is reused (idempotent), so repeated START never stacks waiters.
  ensureThreshold(threshold) {
    const t = Number(threshold);
    if (!Number.isFinite(t) || t < 0) return Promise.resolve({ error: { code: 'INVALID_JACKPOT_THRESHOLD', message: 'Minimum jackpot must be a finite number >= 0' } });
    if (this._pending) return this._pending.promise;
    const cur = this._observer ? this._observer.current() : null;
    if (cur != null && cur >= t) { this._setState(STATE.READY); return Promise.resolve({ ready: true, jackpot: cur, threshold: t }); }
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    this._pending = { threshold: t, resolve: resolveFn, promise, done: false };
    this._setState(STATE.WAITING);
    return promise;
  }

  _onJackpot() {
    if (!this._pending || this._pending.done) return;
    const cur = this._observer ? this._observer.current() : null;
    if (cur != null && cur >= this._pending.threshold) this._release(cur);
  }

  _release(jp) {
    const p = this._pending; if (!p || p.done) return;
    p.done = true; this._pending = null;
    this._setState(STATE.READY);
    p.resolve({ ready: true, jackpot: jp, threshold: p.threshold });
  }

  // Cancel a pending wait. Later jackpot updates must NOT release it (§38/§39/§40).
  cancel(reason = 'CANCELLED') {
    const p = this._pending;
    if (p && !p.done) { p.done = true; this._pending = null; this._setState(STATE.IDLE); p.resolve({ error: { code: 'JACKPOT_GATE_CANCELLED', message: String(reason) } }); return; }
    this._setState(STATE.IDLE);
  }
  onDisconnect() { this.cancel('DISCONNECTED'); }

  _setState(s) { if (this._state === s) return; this._state = s; this.emit('state', s); }
}

module.exports = { JackpotGate, STATE };
