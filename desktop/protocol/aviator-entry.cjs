'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// AviatorEntryGate — WU-C.1.1. A per-BrowserRun prerequisite that ensures the
// run's OWN live socket is inside the Aviator game before Auto Run places any bet.
//
// Source reality (see aviator.cjs / protocol-context.cjs):
//   - cmd 100000 is the CLIENT enter request; there is no source-proven server
//     entry-ACK cmd, so we do NOT invent one.
//   - The authoritative, source-proven evidence that a socket is inside the live
//     Aviator game is a SERVER (recv) round-lifecycle frame: ROUND_OPEN (100005),
//     ROUND_SNAPSHOT (100008), ROUND_LOCK (100006), ODD (100009) or ROUND_END
//     (100007). Those only flow once the game is entered. That is our readiness rule.
//   - ProtocolContext.ready means aid/eid (login/session) — NOT game entry.
//
// Isolation (WU-B): the enter request is sent ONLY through this run's own socket
// context; there is no "any socket" fallback and no global entry state.
// ---------------------------------------------------------------------------

const ENTER_CMD = 100000; // client Aviator enter (exact observed request)
// Server round-lifecycle cmds — see CMD in aviator.cjs. Kept as literals here so the
// gate does not couple to the sealed protocol module's load timing.
const ENTRY_EVIDENCE_CMDS = new Set([100005, 100008, 100006, 100009, 100007]);
// Exact outbound enter payload envelope. DO NOT modify (no aid/eid/sid/b/odd added).
const ENTER_ENVELOPE = ['6', 'MiniGame', 'aviatorPlugin', { cmd: ENTER_CMD }];

const STATE = Object.freeze({ NOT_ENTERED: 'NOT_ENTERED', ENTERING: 'ENTERING', ENTERED: 'ENTERED' });

class AviatorEntryGate extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._aviator = deps.roundTracker || null;
    this._send = deps.send || (async () => ({ ok: false, error: { code: 'AVIATOR_ENTRY_NO_SEND', message: 'No send seam configured' } }));
    // getContext must resolve THIS run's own socket context (or null). No fallback.
    this._getContext = deps.getContext || (() => null);
    this._timeoutMs = Number(deps.timeoutMs || 10000);
    this._entered = false;
    this._pending = null;      // in-flight ensure attempt (dedup guard)
    this._sentCount = 0;       // total enter requests sent by this gate
    if (this._aviator && this._aviator.on) this._aviator.on('frame', (ev) => this._onFrame(ev));
  }

  isEntered() { return this._entered; }
  state() { return this._entered ? STATE.ENTERED : (this._pending ? STATE.ENTERING : STATE.NOT_ENTERED); }
  enterSends() { return this._sentCount; }

  // Passive discovery: an authoritative SERVER round frame proves entry.
  _onFrame(ev) {
    if (!ev || ev.direction !== 'recv' || ev.cmd == null) return;
    if (!ENTRY_EVIDENCE_CMDS.has(ev.cmd)) return;
    this._markEntered();
  }

  _markEntered() {
    const was = this._entered;
    this._entered = true;
    if (this._pending) this._pending.resolveReady();
    if (!was) { this.emit('entered'); this.emit('state', this.state()); }
  }

  /**
   * ensureEntered() — READY if already entered (idempotent, 0 sends). Otherwise send
   * exactly one enter request through the run's OWN socket and wait (bounded) for
   * authoritative server round evidence. Never sends through another run's socket.
   * Concurrent calls for the same run reuse the single in-flight attempt (no spam).
   */
  ensureEntered() {
    if (this._entered) return Promise.resolve({ ready: true, sent: 0, alreadyEntered: true });
    if (this._pending) return this._pending.promise; // one attempt per run/session

    const ctx = this._getContext();
    if (!ctx || !ctx.targetId) {
      return Promise.resolve({ error: { code: 'AVIATOR_ENTRY_NO_SOCKET', message: 'No owning WebSocket for this run yet — interact with the game so its socket sends a frame, then retry.' } });
    }

    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const pending = { promise, resolve: resolveFn, timer: null, done: false, sent: 0 };
    pending.settle = (result) => {
      if (pending.done) return; pending.done = true;
      if (pending.timer) clearTimeout(pending.timer);
      if (this._pending === pending) this._pending = null;
      this.emit('state', this.state());
      pending.resolve(result);
    };
    pending.resolveReady = () => pending.settle({ ready: true, sent: pending.sent });
    this._pending = pending;
    this.emit('state', this.state()); // ENTERING

    const wire = this._buildEnterWire(ctx);
    Promise.resolve(this._send(ctx, wire)).then((res) => {
      if (pending.done) return;
      if (!res || !res.ok) { pending.settle({ error: (res && res.error) || { code: 'AVIATOR_ENTRY_SEND_FAILED', message: 'Enter request failed' } }); return; }
      this._sentCount++; pending.sent = 1;
      if (this._entered) { pending.resolveReady(); return; } // evidence beat the timer
      pending.timer = setTimeout(() => pending.settle({ error: { code: 'AVIATOR_ENTRY_TIMEOUT', message: 'No authoritative Aviator round evidence after the enter request' } }), this._timeoutMs);
      if (pending.timer.unref) pending.timer.unref();
    }).catch((e) => pending.settle({ error: { code: 'AVIATOR_ENTRY_SEND_FAILED', message: String(e && e.message || e) } }));

    return promise;
  }

  // Owning socket/session lost: entry readiness is runtime state, so invalidate it and
  // fail any in-flight attempt. A stale entered flag is never trusted across reconnect.
  onDisconnect() {
    this._entered = false;
    if (this._pending) this._pending.settle({ error: { code: 'AVIATOR_ENTRY_DISCONNECTED', message: 'Owning socket disconnected during entry' } });
    this.emit('state', this.state());
  }

  _buildEnterWire(ctx) {
    return String((ctx && ctx.wirePrefix) || '') + JSON.stringify(ENTER_ENVELOPE);
  }
}

module.exports = { AviatorEntryGate, ENTER_CMD, ENTRY_EVIDENCE_CMDS, ENTER_ENVELOPE, STATE };
