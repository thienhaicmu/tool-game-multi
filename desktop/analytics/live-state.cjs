'use strict';

const EventEmitter = require('node:events');
const { classifyFrame, CMD } = require('../protocol/frame-classify.cjs');
const { JackpotObserver } = require('../protocol/jackpot-observer.cjs');
const { deriveState, STATE: CTX_STATE, DEFAULTS: CTX_DEFAULTS, AVIATOR_EVIDENCE_CMDS } = require('../protocol/aviator-context.cjs');

// ---------------------------------------------------------------------------
// AnalyticsLiveState — M2 passive live view for ONE Analytics browser profile.
//
// It consumes observed WebSocket frames (already captured by CaptureCorrelator)
// and turns them into a bounded, display-only live snapshot. It is strictly
// PASSIVE:
//   - it only READS frames; it never sends, replays or reproduces any frame
//   - round truth (sid/odd) is RECV-authoritative only (WU7 §4): a website SEND
//     frame is recorded as evidence (direction=SEND) but never mutates sid/odd
//   - jackpot is delegated to the shared recv-only JackpotObserver (eI.jp)
//   - missing sid/odd/jackpot stay null; nothing is synthesised
//
// M2 keeps only a bounded in-memory list of recent events (default 200). There
// is no persistence yet (SQLite arrives in M5) and no RoundAssembler.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EVENTS = 200;
const WS_STATUS = Object.freeze({ IDLE: 'IDLE', CONNECTED: 'CONNECTED', DISCONNECTED: 'DISCONNECTED' });

class AnalyticsLiveState extends EventEmitter {
  constructor({ browserId, maxEvents = DEFAULT_MAX_EVENTS, now, contextConfig } = {}) {
    super();
    this.browserId = browserId != null ? String(browserId) : null;
    this._maxEvents = Math.max(1, Number(maxEvents) || DEFAULT_MAX_EVENTS);
    this._now = now || (() => Date.now());
    this._events = [];          // bounded, newest-last
    this._seq = 0;
    this._currentSid = null;    // from recv ROUND_OPEN / ROUND_SNAPSHOT
    this._currentOdd = null;    // from recv ODD / ROUND_END
    this._wsStatus = WS_STATUS.IDLE;
    // §1/§9 — two DISTINCT passive freshness signals. lastWsRecvMono = ANY recv WS traffic
    // (incl. lobby/website chatter → the page is still alive). lastAviatorFrameMono = ONLY
    // classified authoritative Aviator server evidence (round lifecycle / ODD / Jackpot). Lobby
    // chatter must never refresh Aviator freshness. Both feed the passive context state.
    this._lastWsRecvMono = null;
    this._lastAviatorFrameMono = null;
    this._contextCfg = { ...CTX_DEFAULTS, ...(contextConfig || {}) };
    // Reuse the approved recv-only, unsealed JackpotObserver. It listens to a
    // 'frame' event; we feed it a minimal adapter emitter (no RoundTracker, so no
    // sealed/action graph is pulled in).
    this._frameBus = new EventEmitter();
    this._jackpot = new JackpotObserver({ roundTracker: this._frameBus, now: this._now });
  }

  // observeFrame — feed ONE captured WS frame.
  // frame: { direction:'send'|'recv', raw:string, at?:ms, targetId?, wsConnectionId? }
  // Returns the recorded event descriptor (also emitted via 'update').
  observeFrame(frame = {}) {
    const direction = frame.direction === 'send' ? 'SEND' : 'RECV';
    const at = frame.at != null ? frame.at : this._now();
    const cls = classifyFrame(frame.raw);

    // A live frame proves the owning socket is up.
    this._wsStatus = WS_STATUS.CONNECTED;

    // Round truth transitions are RECV-authoritative only. A website SEND frame is
    // stored as evidence but NEVER mutates sid/odd (and never triggers any action).
    if (direction === 'RECV') {
      this._applyRecv(cls);
      // §1 — freshness signals (recv only). ANY recv traffic keeps lastWsRecvMono fresh; only
      // classified Aviator server evidence (round/ODD/jackpot) refreshes lastAviatorFrameMono.
      this._lastWsRecvMono = at;
      if (AVIATOR_EVIDENCE_CMDS.has(cls.cmd) || cls.jp != null) this._lastAviatorFrameMono = at;
    }

    // Jackpot authority (recv-only) is enforced inside JackpotObserver itself.
    this._frameBus.emit('frame', { direction: direction === 'SEND' ? 'send' : 'recv', jp: cls.jp, cmd: cls.cmd, sid: cls.sid });

    const ev = {
      seq: this._seq++,
      browserId: this.browserId,
      direction,                                   // 'SEND' (website-originated) | 'RECV'
      // Provenance (§22): a SEND is normally WEBSITE-originated, but Analytics' own sealed
      // entry-recovery frame is tagged ANALYTICS_ENTRY_RECOVERY by the runtime so it is never
      // mislabelled as a website action. RECV is always SERVER.
      origin: direction === 'SEND' ? (frame.origin === 'ANALYTICS_ENTRY_RECOVERY' ? 'ANALYTICS_ENTRY_RECOVERY' : 'WEBSITE') : 'SERVER',
      at,
      timestamp: isoOrNull(at),
      cmd: cls.cmd != null ? cls.cmd : null,
      type: cls.type || 'UNKNOWN',
      known: !!cls.known,
      sid: cls.sid != null ? cls.sid : null,       // null, never synthesised
      odd: cls.odd != null ? cls.odd : null,
      jackpot: cls.jp != null ? cls.jp : null,
      targetId: frame.targetId != null ? String(frame.targetId) : null,
      raw: cls.raw,
    };
    this._events.push(ev);
    if (this._events.length > this._maxEvents) this._events.shift();
    this.emit('update', ev);
    return ev;
  }

  _applyRecv(cls) {
    switch (cls.cmd) {
      case CMD.ROUND_OPEN:
      case CMD.ROUND_SNAPSHOT:
        if (cls.sid != null) { this._currentSid = cls.sid; this._currentOdd = null; }
        break;
      case CMD.ODD:
        if (cls.odd != null) this._currentOdd = cls.odd;
        break;
      case CMD.ROUND_END:
        if (cls.odd != null) this._currentOdd = cls.odd;
        break;
      default:
        break;
    }
  }

  // Owning socket/target lost: current runtime truth is no longer authoritative.
  onDisconnect() {
    this._currentSid = null;
    this._currentOdd = null;
    this._wsStatus = WS_STATUS.DISCONNECTED;
    this._lastWsRecvMono = null;
    this._lastAviatorFrameMono = null;
    try { this._jackpot.onDisconnect(); } catch { /* best effort */ }
    this.emit('update', null);
  }

  currentSid() { return this._currentSid; }
  currentOdd() { return this._currentOdd; }
  currentJackpot() { return this._jackpot.current(); }
  wsStatus() { return this._wsStatus; }
  // §1 freshness signals exposed for the recovery coordinator (read-only). Kept DISTINCT:
  // lastWsRecvMono = ANY recv traffic (lobby chatter incl.); lastAviatorFrameMono = classified
  // authoritative Aviator server evidence only.
  lastWsRecvMono() { return this._lastWsRecvMono; }
  lastAviatorFrameMono() { return this._lastAviatorFrameMono; }
  hasEverSeenAviator() { return this._lastAviatorFrameMono != null; }

  // §9 — passive Aviator-context health, derived from the two freshness signals. Strictly
  // observational: the collector stays attached; this never sends or re-enters anything.
  // pageHealthy = the socket is connected AND non-Aviator traffic is still flowing (lobby is
  // alive) — that is exactly the "browser healthy but Aviator context lost" corroboration.
  aviatorContext() {
    const now = this._now();
    const lastWsRecvFresh = this._lastWsRecvMono != null && (now - this._lastWsRecvMono) <= this._contextCfg.freshMs;
    const pageHealthy = this._wsStatus === WS_STATUS.CONNECTED && lastWsRecvFresh;
    return deriveState({ now, lastAviatorMono: this._lastAviatorFrameMono, lastWsRecvMono: this._lastWsRecvMono, pageHealthy, hasIntent: true }, this._contextCfg);
  }
  recentEvents(limit) {
    if (limit == null) return this._events.map((e) => ({ ...e }));
    return this._events.slice(-Math.max(0, Number(limit) || 0)).map((e) => ({ ...e }));
  }

  snapshot({ events = true, eventsLimit } = {}) {
    const aviatorContext = this.aviatorContext();
    // §9 — after CONFIRMED context loss, do NOT present frozen SID/ODD/Jackpot as current live
    // values. They become unavailable (null → "—" in the UI) until fresh Aviator evidence returns.
    // Historical (DB) rounds are a separate path and are never touched here.
    const lost = aviatorContext === CTX_STATE.CONTEXT_LOST;
    return {
      browserId: this.browserId,
      wsStatus: this._wsStatus,
      aviatorContext,
      currentSid: lost ? null : this._currentSid,
      currentOdd: lost ? null : this._currentOdd,
      currentJackpot: lost ? null : this._jackpot.current(),
      jackpotObservedAt: this._jackpot.snapshot().jackpotObservedAt,
      eventCount: this._events.length,
      events: events ? this.recentEvents(eventsLimit) : undefined,
    };
  }
}

function isoOrNull(at) { try { return new Date(at).toISOString(); } catch { return null; } }

module.exports = { AnalyticsLiveState, WS_STATUS, DEFAULT_MAX_EVENTS };
