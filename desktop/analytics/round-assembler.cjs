'use strict';

const EventEmitter = require('node:events');
const { CMD } = require('../protocol/frame-classify.cjs');
const { THRESHOLDS, thresholdKey } = require('./thresholds.cjs');

// ---------------------------------------------------------------------------
// RoundAssembler — Analytics-only, PURE, PASSIVE round reconstruction.
//
// It consumes NORMALIZED protocol observations (produced upstream from the
// classifier) and maintains normalized rounds entirely IN MEMORY. It performs
// NO database writes and NO protocol sends; a persistence coordinator subscribes
// to its events and writes the results. One assembler instance per owning
// browser/capture stream (isolation is structural).
//
// Authority rules:
//   - only RECV frames mutate normalized round state (§10)
//   - SID is used only when the server provides it; never invented (§12)
//   - missing lifecycle timestamps are never fabricated (§18/§19)
//   - jackpot lifecycle fields are EXACT-event only; NULL otherwise (policy A, §17)
//
// Events: 'round-started'(round), 'odd-sample'({localId,sample}),
//         'jackpot-sample'({localId,sample}), 'round-updated'(round),
//         'round-finalized'(round).
// ---------------------------------------------------------------------------

const COMPLETENESS = Object.freeze({ COMPLETE: 'COMPLETE', PARTIAL_START: 'PARTIAL_START', PARTIAL_END: 'PARTIAL_END', INTERRUPTED: 'INTERRUPTED', UNKNOWN: 'UNKNOWN' });
const CAUSE = Object.freeze({ END: 'END', SUPERSEDED: 'SUPERSEDED', DISCONNECT: 'DISCONNECT', INTERRUPT: 'INTERRUPT' });

class RoundAssembler extends EventEmitter {
  constructor({ browserId, captureSessionId, allocateSequence } = {}) {
    super();
    this.browserId = browserId != null ? String(browserId) : null;
    this.captureSessionId = captureSessionId != null ? captureSessionId : null;
    this._localSeq = 0;
    this._seqCounter = 0;
    this._allocate = typeof allocateSequence === 'function' ? allocateSequence : () => ++this._seqCounter;
    this._current = null;
    this._finalized = [];
  }

  current() { return this._current ? this._view(this._current) : null; }
  finalizedRounds() { return this._finalized.map((r) => this._view(r)); }
  allRounds() { const a = this._finalized.map((r) => this._view(r)); if (this._current) a.push(this._view(this._current)); return a; }

  // Feed ONE normalized observation. Only RECV mutates normalized state.
  observe(ev = {}) {
    if (ev.direction !== 'RECV') return; // SEND is raw evidence only (§10)
    const at = Number(ev.timestampMs);
    switch (ev.cmd) {
      case CMD.ROUND_OPEN: this._handleOpen(ev, at); break;
      case CMD.ROUND_SNAPSHOT: this._handleSnapshot(ev, at); break;
      case CMD.ROUND_LOCK: this._handleLock(ev, at); break;
      case CMD.ODD: this._handleOdd(ev, at); break;
      case CMD.ROUND_END: this._handleEnd(ev, at); break;
      default: this._ingestJackpot(ev, at, null); break; // unknown recv: jackpot evidence only if a round is active
    }
  }

  // Finalize the current round without an authoritative END (disconnect/stop/app).
  finalizeCurrent(cause = CAUSE.DISCONNECT) {
    if (this._current && !this._current.ended) this._finalize(this._current, cause, null);
  }

  // ---- lifecycle handlers ----
  _handleOpen(ev, at) {
    const sid = ev.sid != null ? ev.sid : null;
    if (this._current && !this._current.ended && sameSid(this._current.sid, sid) && sid != null) {
      // Duplicate OPEN for the same SID: same normalized round (raw already kept). Ignore.
      this._ingestJackpot(ev, at, 'OPEN');
      return;
    }
    if (this._current && !this._current.ended) this._finalize(this._current, CAUSE.SUPERSEDED, null);
    this._start({ sid, at, capturedFromStart: true });
    this._ingestJackpot(ev, at, 'OPEN');
  }

  _handleSnapshot(ev, at) {
    const sid = ev.sid != null ? ev.sid : null;
    if (this._current && !this._current.ended && sameSid(this._current.sid, sid)) {
      this._ingestJackpot(ev, at, null); // same round snapshot: no structural change
      return;
    }
    if (this._current && !this._current.ended) this._finalize(this._current, CAUSE.SUPERSEDED, null);
    this._start({ sid, at, capturedFromStart: false }); // joined mid-round
    this._ingestJackpot(ev, at, null);
  }

  _handleLock(ev, at) {
    if (!this._appliesToCurrent(ev.sid)) return; // stale / no round
    if (this._current.lockedAtMs == null) this._current.lockedAtMs = at;
    this._ingestJackpot(ev, at, 'LOCK');
    this.emit('round-updated', this._view(this._current));
  }

  _handleOdd(ev, at) {
    if (!validOdd(ev.odd)) { // no usable odd; still jackpot evidence if applicable
      if (this._appliesToCurrent(ev.sid)) this._ingestJackpot(ev, at, null);
      return;
    }
    if (this._appliesToCurrent(ev.sid)) {
      const isFirst = this._current.firstOddAtMs == null;
      this._ingestJackpot(ev, at, isFirst ? 'FIRST_ODD' : null);
      this._addOdd(this._current, ev, at);
    } else if (!this._current || this._current.ended) {
      this._start({ sid: ev.sid != null ? ev.sid : null, at, capturedFromStart: false }); // ODD before any OPEN (§12E)
      this._ingestJackpot(ev, at, 'FIRST_ODD');
      this._addOdd(this._current, ev, at);
    }
    // else: stale SID for a different current round -> ignore (raw preserved upstream)
  }

  _handleEnd(ev, at) {
    if (!this._appliesToCurrent(ev.sid)) return; // stale END for an old/absent round
    if (validOdd(ev.odd)) this._addOdd(this._current, ev, at); // END odd is a distinct authoritative observation (§15)
    this._ingestJackpot(ev, at, 'END');
    this._finalize(this._current, CAUSE.END, at);
  }

  // ---- helpers ----
  _appliesToCurrent(sid) {
    if (!this._current || this._current.ended) return false;
    return sid == null || sameSid(this._current.sid, sid);
  }

  _start({ sid, at, capturedFromStart }) {
    const r = {
      localId: ++this._localSeq,
      sid: sid != null ? sid : null,
      captureSessionId: this.captureSessionId,
      browserId: this.browserId,
      sequenceNumber: this._allocate(),
      openedAtMs: capturedFromStart ? at : null,
      baseMs: at,                 // earliest time we observed this round (for elapsed calc)
      lockedAtMs: null, firstOddAtMs: null, endedAtMs: null, durationMs: null,
      firstOdd: null, lastOdd: null, maxOdd: null,
      oddSamples: [], jackpotSamples: [],
      jackpotAtOpen: null, jackpotAtLock: null, jackpotAtFirstOdd: null, jackpotAtEnd: null,
      jackpotMin: null, jackpotMax: null, jackpotAvg: null, jackpotDelta: null,
      capturedFromStart: !!capturedFromStart,
      completeness: COMPLETENESS.UNKNOWN,
      ended: false,
    };
    this._current = r;
    this.emit('round-started', this._view(r));
  }

  _addOdd(round, ev, at) {
    const isFirst = round.firstOddAtMs == null;
    if (isFirst) { round.firstOddAtMs = at; round.firstOdd = ev.odd; }
    const sample = {
      sequence: round.oddSamples.length,
      timestampMs: at,
      elapsedFromFirstOddMs: round.firstOddAtMs != null ? at - round.firstOddAtMs : null,
      odd: ev.odd,
      sourceEventId: ev.rawEventId != null ? ev.rawEventId : null,
    };
    round.oddSamples.push(sample);
    round.lastOdd = ev.odd;
    round.maxOdd = round.maxOdd == null ? ev.odd : Math.max(round.maxOdd, ev.odd);
    this.emit('odd-sample', { localId: round.localId, sample });
    this.emit('round-updated', this._view(round));
  }

  _ingestJackpot(ev, at, phase) {
    if (!Number.isFinite(ev.jackpot)) return;
    if (!this._current || this._current.ended) return; // outside any round -> not forced (§42)
    const round = this._current;
    const sample = {
      sequence: round.jackpotSamples.length,
      timestampMs: at,
      elapsedMs: round.baseMs != null ? at - round.baseMs : null,
      jackpot: ev.jackpot,
      sourceEventId: ev.rawEventId != null ? ev.rawEventId : null,
    };
    round.jackpotSamples.push(sample);
    if (phase === 'OPEN' && round.jackpotAtOpen == null) round.jackpotAtOpen = ev.jackpot;
    if (phase === 'LOCK' && round.jackpotAtLock == null) round.jackpotAtLock = ev.jackpot;
    if (phase === 'FIRST_ODD' && round.jackpotAtFirstOdd == null) round.jackpotAtFirstOdd = ev.jackpot;
    if (phase === 'END') round.jackpotAtEnd = ev.jackpot;
    this._recomputeJackpotAggregates(round);
    this.emit('jackpot-sample', { localId: round.localId, sample });
  }

  _recomputeJackpotAggregates(round) {
    const vals = round.jackpotSamples.map((s) => s.jackpot);
    if (!vals.length) { round.jackpotMin = round.jackpotMax = round.jackpotAvg = round.jackpotDelta = null; return; }
    round.jackpotMin = Math.min(...vals);
    round.jackpotMax = Math.max(...vals);
    round.jackpotAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    round.jackpotDelta = vals[vals.length - 1] - vals[0];
  }

  _finalize(round, cause, endedAtMs) {
    round.ended = true;
    round.endedAtMs = cause === CAUSE.END && endedAtMs != null ? endedAtMs : null; // never fabricate end time
    round.durationMs = (round.endedAtMs != null && round.openedAtMs != null) ? round.endedAtMs - round.openedAtMs : null;
    round.completeness = this._completeness(round, cause);
    round.metrics = this._metrics(round);
    this._finalized.push(round);
    if (this._current === round) this._current = null;
    this.emit('round-finalized', this._view(round));
  }

  _completeness(round, cause) {
    switch (cause) {
      case CAUSE.END: return round.capturedFromStart ? COMPLETENESS.COMPLETE : COMPLETENESS.PARTIAL_START;
      case CAUSE.SUPERSEDED: return round.capturedFromStart ? COMPLETENESS.PARTIAL_END : COMPLETENESS.PARTIAL_START;
      case CAUSE.DISCONNECT: return round.capturedFromStart ? COMPLETENESS.PARTIAL_END : COMPLETENESS.INTERRUPTED;
      case CAUSE.INTERRUPT: return COMPLETENESS.INTERRUPTED;
      default: return COMPLETENESS.UNKNOWN;
    }
  }

  _metrics(round) {
    const reached = {}; const timings = {};
    for (const t of THRESHOLDS) {
      const k = thresholdKey(t);
      const hit = round.oddSamples.find((s) => s.odd >= t); // first authoritative sample >= T (no interpolation)
      reached[k] = !!hit;
      timings[k] = hit && round.firstOddAtMs != null ? hit.timestampMs - round.firstOddAtMs : null;
    }
    return { reached, timings, censored: !round.capturedFromStart };
  }

  // Serialisable view (drops internal flags like baseMs/ended; keeps samples).
  _view(r) {
    return {
      localId: r.localId, sid: r.sid, captureSessionId: r.captureSessionId, browserId: r.browserId,
      sequenceNumber: r.sequenceNumber,
      openedAtMs: r.openedAtMs, lockedAtMs: r.lockedAtMs, firstOddAtMs: r.firstOddAtMs, endedAtMs: r.endedAtMs, durationMs: r.durationMs,
      firstOdd: r.firstOdd, lastOdd: r.lastOdd, maxOdd: r.maxOdd,
      jackpotAtOpen: r.jackpotAtOpen, jackpotAtLock: r.jackpotAtLock, jackpotAtFirstOdd: r.jackpotAtFirstOdd, jackpotAtEnd: r.jackpotAtEnd,
      jackpotMin: r.jackpotMin, jackpotMax: r.jackpotMax, jackpotAvg: r.jackpotAvg, jackpotDelta: r.jackpotDelta,
      oddSampleCount: r.oddSamples.length, jackpotSampleCount: r.jackpotSamples.length,
      completeness: r.completeness, capturedFromStart: r.capturedFromStart,
      oddSamples: r.oddSamples.map((s) => ({ ...s })), jackpotSamples: r.jackpotSamples.map((s) => ({ ...s })),
      metrics: r.metrics || null,
    };
  }
}

function sameSid(a, b) { return a != null && b != null && String(a) === String(b); }
function validOdd(v) { return Number.isFinite(v) && v > 0; }

module.exports = { RoundAssembler, COMPLETENESS, CAUSE };
