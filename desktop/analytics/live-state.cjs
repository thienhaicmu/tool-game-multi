'use strict';

const EventEmitter = require('node:events');
const { classifyFrame, CMD } = require('../protocol/frame-classify.cjs');
const { JackpotObserver } = require('../protocol/jackpot-observer.cjs');

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
  constructor({ browserId, maxEvents = DEFAULT_MAX_EVENTS, now } = {}) {
    super();
    this.browserId = browserId != null ? String(browserId) : null;
    this._maxEvents = Math.max(1, Number(maxEvents) || DEFAULT_MAX_EVENTS);
    this._now = now || (() => Date.now());
    this._events = [];          // bounded, newest-last
    this._seq = 0;
    this._currentSid = null;    // from recv ROUND_OPEN / ROUND_SNAPSHOT
    this._currentOdd = null;    // from recv ODD / ROUND_END
    this._wsStatus = WS_STATUS.IDLE;
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
    if (direction === 'RECV') this._applyRecv(cls);

    // Jackpot authority (recv-only) is enforced inside JackpotObserver itself.
    this._frameBus.emit('frame', { direction: direction === 'SEND' ? 'send' : 'recv', jp: cls.jp, cmd: cls.cmd, sid: cls.sid });

    const ev = {
      seq: this._seq++,
      browserId: this.browserId,
      direction,                                   // 'SEND' (website-originated) | 'RECV'
      origin: direction === 'SEND' ? 'WEBSITE' : 'SERVER',
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
    try { this._jackpot.onDisconnect(); } catch { /* best effort */ }
    this.emit('update', null);
  }

  currentSid() { return this._currentSid; }
  currentOdd() { return this._currentOdd; }
  currentJackpot() { return this._jackpot.current(); }
  wsStatus() { return this._wsStatus; }
  recentEvents(limit) {
    if (limit == null) return this._events.map((e) => ({ ...e }));
    return this._events.slice(-Math.max(0, Number(limit) || 0)).map((e) => ({ ...e }));
  }

  snapshot({ events = true, eventsLimit } = {}) {
    return {
      browserId: this.browserId,
      wsStatus: this._wsStatus,
      currentSid: this._currentSid,
      currentOdd: this._currentOdd,
      currentJackpot: this._jackpot.current(),
      jackpotObservedAt: this._jackpot.snapshot().jackpotObservedAt,
      eventCount: this._events.length,
      events: events ? this.recentEvents(eventsLimit) : undefined,
    };
  }
}

function isoOrNull(at) { try { return new Date(at).toISOString(); } catch { return null; } }

module.exports = { AnalyticsLiveState, WS_STATUS, DEFAULT_MAX_EVENTS };
