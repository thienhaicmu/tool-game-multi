'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// AnalyticsAviatorEntryGate — the semantic owner of Analytics' ONE permitted
// protocol action: request Aviator ENTRY / RE-ENTRY (a fixed cmd100000).
//
// It knows NOTHING about BET / CASHOUT / stopOdd / Jackpot threshold / LƯỢT /
// AutoRunner / round strategy. Its whole job is:
//   - fire EXACTLY ONE bounded entry request per attempt (dedup concurrent),
//   - own a recovery generation + attempt baseline,
//   - enforce SEND != ENTERED: sending the request never confirms entry; only
//     FRESH authoritative SERVER Aviator evidence that arrived AFTER the attempt
//     boundary (and for the current generation) confirms,
//   - time out, and cancel cleanly on browser/session close.
//
// It carries NO payload: the fixed enter frame lives entirely inside the sealed
// EntryOnlyTransport. requestEntry() takes no cmd/payload/JSON argument.
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({ timeoutMs: 10000 });

class AnalyticsAviatorEntryGate extends EventEmitter {
  // deps:
  //   sendEntry(ctx) -> Promise<{ok:true} | {error}>   (the sealed transport; NO payload arg)
  //   getContext()   -> { targetId, cdpSessionId?, host? } | null   (THIS browser's game socket)
  //   now()          -> monotonic ms
  constructor(deps = {}) {
    super();
    this._sendEntry = typeof deps.sendEntry === 'function' ? deps.sendEntry : async () => ({ error: { code: 'ANALYTICS_ENTRY_NO_TRANSPORT', message: 'No entry transport configured' } });
    this._getContext = typeof deps.getContext === 'function' ? deps.getContext : () => null;
    this._now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this._timeoutMs = Number(deps.timeoutMs || DEFAULTS.timeoutMs);
    this._generation = 0;
    this._pending = null;       // in-flight attempt (dedup guard)
    this._sentCount = 0;        // total entry requests actually put on the wire
    this._lastSendMono = null;  // monotonic time of the last successful wire send (provenance window)
    this._lastEvidenceMono = null; // most recent authoritative SERVER Aviator evidence seen
  }

  isPending() { return !!this._pending; }
  generation() { return this._generation; }
  sentCount() { return this._sentCount; }
  // Provenance helper: did THIS gate put an enter frame on the wire within `windowMs`?
  wasSelfSentRecently(nowMono, windowMs = 2000) { return this._lastSendMono != null && (nowMono - this._lastSendMono) <= windowMs; }

  // Fed by the runtime for EVERY authoritative SERVER Aviator frame (recv lifecycle/ODD/jackpot).
  // Confirms an in-flight attempt only if the evidence is strictly newer than the attempt boundary.
  onAviatorEvidence(atMono) {
    if (atMono == null) return;
    this._lastEvidenceMono = atMono;
    const p = this._pending;
    if (p && !p.done && p.sent && atMono > p.attemptStartMono) p.settle({ ready: true });
  }

  // requestEntry() — the ONE semantic operation. No payload. Idempotent while pending.
  requestEntry() {
    if (this._pending) return this._pending.promise; // one attempt per gate at a time
    const gen = ++this._generation;
    const attemptStartMono = this._now();
    const ctx = this._getContext();

    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const pending = { promise, resolve: resolveFn, gen, attemptStartMono, timer: null, done: false, sent: false };
    pending.settle = (result) => {
      if (pending.done) return; pending.done = true;
      if (pending.timer) { try { clearTimeout(pending.timer); } catch { /* noop */ } }
      if (this._pending === pending) this._pending = null;
      this.emit('state', this.stateName());
      pending.resolve(result);
    };
    this._pending = pending;
    this.emit('state', this.stateName()); // ENTERING

    if (!ctx || !ctx.targetId) {
      // No eligible game socket yet — cannot send. This is NOT a consumed attempt failure
      // the caller treats specially; it simply reports no-socket so the coordinator waits.
      pending.settle({ error: { code: 'ANALYTICS_ENTRY_NO_SOCKET', message: 'No owning game WebSocket for this browser yet.' } });
      return promise;
    }

    Promise.resolve(this._sendEntry(ctx)).then((res) => {
      if (pending.done) return;
      if (!res || !res.ok) { pending.settle({ error: (res && res.error) || { code: 'ANALYTICS_ENTRY_SEND_FAILED', message: 'Enter request failed' } }); return; }
      this._sentCount++; pending.sent = true; this._lastSendMono = this._now();
      // SEND != ENTERED. If fresh evidence already arrived after the attempt boundary, confirm;
      // otherwise wait (bounded) for authoritative SERVER Aviator evidence.
      if (this._lastEvidenceMono != null && this._lastEvidenceMono > pending.attemptStartMono) { pending.settle({ ready: true }); return; }
      pending.timer = setTimeout(() => pending.settle({ error: { code: 'ANALYTICS_ENTRY_TIMEOUT', message: 'No authoritative Aviator evidence after the enter request' } }), this._timeoutMs);
      if (pending.timer.unref) pending.timer.unref();
    }).catch((e) => pending.settle({ error: { code: 'ANALYTICS_ENTRY_SEND_FAILED', message: String(e && e.message || e) } }));

    return promise;
  }

  stateName() { return this._pending ? 'ENTERING' : 'IDLE'; }

  // Owning socket/session lost, or browser/profile closed: invalidate the generation and fail
  // any in-flight attempt so a late server frame can never resurrect a closed recovery.
  cancel(code = 'ANALYTICS_ENTRY_CANCELLED') {
    this._generation++;
    if (this._pending) this._pending.settle({ error: { code, message: 'Entry attempt cancelled' } });
  }
}

module.exports = { AnalyticsAviatorEntryGate, DEFAULTS };
