'use strict';

const EventEmitter = require('node:events');
const { performance } = require('node:perf_hooks');
const { CMD } = require('./aviator.cjs');

// ---------------------------------------------------------------------------
// RoundObserver — WU8. READ-ONLY protocol observability.
//
// HARD BOUNDARY (§1/§33): this module imports NO send seam and exposes NO way to
// send. It has no reference to wsReplay, ProtocolHarness, ReplayEngine or Fetch.
// It consumes the classified server-frame stream that RoundTracker already emits
// (cmd 100005/100008/100006/100009/100007) and derives:
//   - round lifecycle (OPEN / LOCKED / RUNNING / ENDED)
//   - bounded recent-odd samples + frame-interval timing
//   - completed-round history (terminalReason ROUND_END / SUPERSEDED / DISCONNECTED)
//   - observational metrics
// It never evaluates a target odd, strategy, or action condition (§11/§35).
//
// RoundTracker stays authoritative for SID/odd/state; SID comes only from server
// cmd:100005/100008, never previousSid+1 (§3). ODD comes only from server cmd:100009 (§4).
// ---------------------------------------------------------------------------

const STATUS = Object.freeze({ IDLE: 'IDLE', WAITING_ROUND: 'WAITING_ROUND', OPEN: 'OPEN', LOCKED: 'LOCKED', RUNNING: 'RUNNING', ENDED: 'ENDED' });
const PHASE = Object.freeze({ OPEN: 'OPEN', LOCKED: 'LOCKED', RUNNING: 'RUNNING', ENDED: 'ENDED' });
const TERMINAL = Object.freeze({ ROUND_END: 'ROUND_END', SUPERSEDED: 'SUPERSEDED', DISCONNECTED: 'DISCONNECTED' });

function validateConfig(cfg = {}) {
  const out = { oddBufferLimit: 100, historyLimit: 200 };
  if (cfg.oddBufferLimit !== undefined && cfg.oddBufferLimit !== null && cfg.oddBufferLimit !== '') {
    const n = Number(cfg.oddBufferLimit);
    if (!Number.isInteger(n) || n <= 0 || n > 1000) return { error: { code: 'INVALID_OBSERVER_CONFIG', message: 'oddBufferLimit must be an integer 1..1000' } };
    out.oddBufferLimit = n;
  }
  if (cfg.historyLimit !== undefined && cfg.historyLimit !== null && cfg.historyLimit !== '') {
    const n = Number(cfg.historyLimit);
    if (!Number.isInteger(n) || n <= 0 || n > 5000) return { error: { code: 'INVALID_OBSERVER_CONFIG', message: 'historyLimit must be an integer 1..5000' } };
    out.historyLimit = n;
  }
  return { config: out };
}

class RoundObserver extends EventEmitter {
  constructor(deps = {}) {
    super();
    const v = validateConfig(deps.config || {});
    this._config = v.config || { oddBufferLimit: 100, historyLimit: 200 };
    this._now = deps.now || (() => performance.now()); // monotonic ms (injectable)
    this._tracker = deps.roundTracker || null;
    this._current = null;    // active ObservedRound (non-terminal)
    this._history = [];       // finalized ObservedRoundSummary[] (append-only)
    this._status = STATUS.IDLE;
    this._index = 0;
    // Subscribe to the frame stream RoundTracker already emits. We do NOT parse WS
    // or attach to CDP ourselves (§2/§23).
    if (this._tracker && this._tracker.on) this._tracker.on('frame', (ev) => this.ingest(ev));
  }

  config() { return { ...this._config }; }
  setConfig(patch = {}) {
    const v = validateConfig({ ...this._config, ...patch });
    if (v.error) return v;
    this._config = v.config;
    this._emit();
    return { config: this.config() };
  }

  status() { return this._status; }
  currentRound() { return this._current ? this._publicRound(this._current, true) : null; }
  history() { return this._history.map((r) => ({ ...r })); }

  // Full read-only snapshot for the UI. Live metrics are computed against `now`.
  snapshot() {
    return {
      readOnly: true,
      status: this._status,
      config: this.config(),
      currentSid: this._current ? this._current.sid : null,
      current: this.currentRound(),
      history: this.history(),
      metrics: this.globalMetrics(),
    };
  }

  /**
   * ingest(ev) — consume ONE classified frame event from RoundTracker.
   * Only server (recv) round frames drive state. Client/send frames are ignored
   * here (RoundTracker owns ActionTrace); this keeps the observer read-only.
   */
  ingest(ev) {
    if (!ev || ev.cmd == null || ev.direction !== 'recv') return;
    const mono = this._now();
    const wall = ev.at || Date.now();
    switch (ev.cmd) {
      case CMD.ROUND_OPEN:
      case CMD.ROUND_SNAPSHOT:
        if (ev.sid != null) this._open(ev.sid, ev.targetId, wall, mono);
        break;
      case CMD.ROUND_LOCK: this._lock(ev.sid, wall, mono); break;
      case CMD.ODD: if (ev.odd != null) this._odd(ev.sid, ev.odd, wall, mono); break;
      case CMD.ROUND_END: this._end(ev.sid, ev.odd, wall, mono); break;
      default: return; // unknown/other server frames stay in normal capture; ignore here
    }
    this._emit();
  }

  _belongsToCurrent(sid) { return this._current && (sid == null || String(sid) === String(this._current.sid)); }

  _open(sid, targetId, wall, mono) {
    // A new authoritative round arrived. If a previous round is still active with a
    // different sid, finalize it as SUPERSEDED — never fabricate a 100007 (§8/§31).
    if (this._current && String(this._current.sid) !== String(sid)) this._finalize(this._current, TERMINAL.SUPERSEDED, wall, mono);
    if (this._current && String(this._current.sid) === String(sid)) return; // duplicate open
    this._current = {
      index: this._index++, sid, targetId: targetId != null ? String(targetId) : null,
      phase: PHASE.OPEN, terminalReason: null,
      openedAt: iso(wall), lockedAt: null, runningAt: null, endedAt: null,
      openedMono: mono, endedMono: null, durationMs: null,
      currentOdd: null, maxOdd: null, endOdd: null,
      oddFrameCount: 0, recentOdds: [],
      firstOddAt: null, lastOddAt: null, lastOddMono: null,
      intervalSum: 0, intervalMin: null, intervalMax: null, intervalCount: 0,
    };
    this._status = STATUS.OPEN;
  }

  _lock(sid, wall) {
    if (!this._belongsToCurrent(sid)) return;
    this._current.phase = PHASE.LOCKED;
    this._current.lockedAt = this._current.lockedAt || iso(wall);
    this._status = STATUS.LOCKED;
  }

  _odd(sid, odd, wall, mono) {
    if (!this._belongsToCurrent(sid)) return; // odd for a different sid: ignored for control, still in capture (§8)
    const r = this._current;
    r.oddFrameCount++;
    r.currentOdd = odd;
    r.maxOdd = r.maxOdd == null ? odd : Math.max(r.maxOdd, odd);
    if (r.firstOddAt == null) { r.firstOddAt = iso(wall); r.phase = PHASE.RUNNING; this._status = STATUS.RUNNING; }
    // Frame-interval timing from monotonic clock.
    let delta = null;
    if (r.lastOddMono != null) {
      delta = mono - r.lastOddMono;
      r.intervalSum += delta; r.intervalCount++;
      r.intervalMin = r.intervalMin == null ? delta : Math.min(r.intervalMin, delta);
      r.intervalMax = r.intervalMax == null ? delta : Math.max(r.intervalMax, delta);
    }
    r.lastOddAt = iso(wall); r.lastOddMono = mono;
    r.recentOdds.push({ odd, sid: r.sid, receivedAt: iso(wall), monotonicAt: round1(mono), deltaMsFromPrevious: round1(delta) });
    if (r.recentOdds.length > this._config.oddBufferLimit) r.recentOdds.shift();
    if (r.phase === PHASE.OPEN || r.phase === PHASE.LOCKED) { r.phase = PHASE.RUNNING; this._status = STATUS.RUNNING; }
  }

  _end(sid, endOdd, wall, mono) {
    if (!this._belongsToCurrent(sid)) return;
    if (endOdd != null) this._current.endOdd = endOdd;
    this._finalize(this._current, TERMINAL.ROUND_END, wall, mono);
    this._status = STATUS.ENDED;
  }

  // Called by the host when the observed target's WS/context disconnects (§20/§32).
  // Read-only: it invokes no send seam.
  onDisconnect(targetId) {
    if (!this._current) { this._status = STATUS.IDLE; this._emit(); return; }
    if (targetId != null && this._current.targetId != null && String(targetId) !== String(this._current.targetId)) return; // unrelated target
    this._finalize(this._current, TERMINAL.DISCONNECTED, Date.now(), this._now());
    this._status = STATUS.IDLE;
    this._emit();
  }

  _finalize(r, reason, wall, mono) {
    r.terminalReason = reason;
    if (reason === TERMINAL.ROUND_END) { r.phase = PHASE.ENDED; r.endedAt = iso(wall); }
    if (r.endOdd == null) r.endOdd = r.currentOdd;
    r.endedMono = mono;
    r.durationMs = r.openedMono != null ? round1(mono - r.openedMono) : null;
    this._history.push(this._summary(r));
    if (this._history.length > this._config.historyLimit) this._history.shift();
    if (this._current === r) this._current = null;
    // After a non-terminal-supersede we immediately open the new round elsewhere;
    // otherwise we are between rounds.
    if (reason !== TERMINAL.SUPERSEDED) this._status = reason === TERMINAL.DISCONNECTED ? STATUS.IDLE : STATUS.WAITING_ROUND;
  }

  _summary(r) {
    return {
      index: r.index, sid: r.sid, phase: r.phase, terminalReason: r.terminalReason,
      openedAt: r.openedAt, lockedAt: r.lockedAt, runningAt: r.firstOddAt, endedAt: r.endedAt,
      durationMs: r.durationMs,
      firstOdd: r.recentOdds.length ? r.recentOdds[0].odd : null,
      maxOdd: r.maxOdd, endOdd: r.endOdd,
      oddFrameCount: r.oddFrameCount,
      avgOddIntervalMs: r.intervalCount ? round1(r.intervalSum / r.intervalCount) : null,
      minOddIntervalMs: round1(r.intervalMin), maxOddIntervalMs: round1(r.intervalMax),
    };
  }

  // Live view of a round; when `live`, add now-relative timing (§11).
  _publicRound(r, live) {
    const out = {
      index: r.index, sid: r.sid, targetId: r.targetId, phase: r.phase, terminalReason: r.terminalReason,
      openedAt: r.openedAt, lockedAt: r.lockedAt, runningAt: r.firstOddAt, endedAt: r.endedAt,
      currentOdd: r.currentOdd, maxOdd: r.maxOdd, endOdd: r.endOdd,
      oddFrameCount: r.oddFrameCount,
      recentOdds: r.recentOdds.slice(),
      firstOddAt: r.firstOddAt, lastOddAt: r.lastOddAt,
      durationMs: r.durationMs,
      avgOddIntervalMs: r.intervalCount ? round1(r.intervalSum / r.intervalCount) : null,
      minOddIntervalMs: round1(r.intervalMin), maxOddIntervalMs: round1(r.intervalMax),
      // ActionTrace evidence (§14/§15) is READ from RoundTracker — never generated.
      actionTraces: this._tracesFor(r.sid),
    };
    if (live && r.terminalReason == null) {
      const now = this._now();
      out.roundAgeMs = r.openedMono != null ? round1(now - r.openedMono) : null;
      out.timeSinceLastOddMs = r.lastOddMono != null ? round1(now - r.lastOddMono) : null;
    }
    return out;
  }

  // Read-only ActionTrace lookup: whatever the game client / manual WU7 test did,
  // as already correlated by RoundTracker. Display evidence only.
  _tracesFor(sid) {
    if (!this._tracker || !this._tracker.actionTraces) return [];
    return this._tracker.actionTraces().filter((t) => t.sid != null && String(t.sid) === String(sid));
  }

  globalMetrics() {
    const h = this._history;
    const durations = h.map((r) => r.durationMs).filter((x) => typeof x === 'number');
    const completed = h.filter((r) => r.terminalReason === TERMINAL.ROUND_END);
    return {
      observedRounds: h.length + (this._current ? 1 : 0),
      completedRounds: completed.length,
      superseded: h.filter((r) => r.terminalReason === TERMINAL.SUPERSEDED).length,
      disconnected: h.filter((r) => r.terminalReason === TERMINAL.DISCONNECTED).length,
      avgRoundDurationMs: avg(durations),
      minRoundDurationMs: durations.length ? round1(Math.min(...durations)) : null,
      maxRoundDurationMs: durations.length ? round1(Math.max(...durations)) : null,
      avgOddFrames: avg(h.map((r) => r.oddFrameCount)),
      avgOddIntervalMs: avg(h.map((r) => r.avgOddIntervalMs)),
    };
  }

  _emit() { this.emit('update'); }
}

function iso(wall) { try { return new Date(wall).toISOString(); } catch { return new Date().toISOString(); } }
function round1(n) { return (n == null || !Number.isFinite(n)) ? null : Math.round(n * 10) / 10; }
function avg(list) { const xs = list.filter((x) => typeof x === 'number' && Number.isFinite(x)); if (!xs.length) return null; return round1(xs.reduce((a, b) => a + b, 0) / xs.length); }

module.exports = { RoundObserver, validateConfig, STATUS, PHASE, TERMINAL };
