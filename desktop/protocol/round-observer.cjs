'use strict';

const EventEmitter = require('node:events');
const { performance } = require('node:perf_hooks');
const { CMD } = require('./aviator.cjs');

// ---------------------------------------------------------------------------
// RoundObserver — READ-ONLY multi-round evidence recorder.
//
// It consumes the classified frame stream that RoundTracker already emits and
// builds per-round observation records: SID, the live odd stream, when a bet /
// cashout was SENT and ACKed (by whoever is actually playing — the game client
// or a manual WU7 test), server-returned odd/wm, and monotonic latencies.
//
// It NEVER sends anything. RoundTracker stays the sole owner of SID / odd / round
// state; this observer only reads. The configurable `targetOdd` is a DISPLAY
// marker only: the observer flags the first server odd frame that reaches it so a
// QA engineer can *see* where a cashout would have been relevant — it does not,
// and cannot, trigger a request.
// ---------------------------------------------------------------------------

// Per-round observed phase (mirrors the observed game state; not driven by us).
const PHASE = Object.freeze({
  OPEN: 'OPEN', BET_PENDING: 'BET_PENDING', BET_CONFIRMED: 'BET_CONFIRMED',
  LOCKED: 'LOCKED', WATCHING_ODD: 'WATCHING_ODD', STOP_PENDING: 'STOP_PENDING',
  STOP_CONFIRMED: 'STOP_CONFIRMED', ROUND_FINISHED: 'ROUND_FINISHED',
});
// Top-level observer status.
const STATUS = Object.freeze({ IDLE: 'IDLE', WAITING_ROUND: 'WAITING_ROUND', OBSERVING: 'OBSERVING', COMPLETED: 'COMPLETED' });

const RESULT = Object.freeze({
  OBSERVING: 'OBSERVING', COMPLETED: 'COMPLETED',
  ROUND_ENDED_BEFORE_TRIGGER: 'ROUND_ENDED_BEFORE_TRIGGER', ENDED: 'ENDED',
});

function validateConfig(cfg = {}) {
  const out = { targetOdd: null, observeRounds: null, oddBufferLimit: 100, historyLimit: 200 };
  if (cfg.targetOdd !== undefined && cfg.targetOdd !== null && cfg.targetOdd !== '') {
    const t = Number(cfg.targetOdd);
    if (!Number.isFinite(t) || t <= 0) return { error: { code: 'INVALID_OBSERVER_CONFIG', message: 'targetOdd must be > 0' } };
    out.targetOdd = t;
  }
  if (cfg.observeRounds !== undefined && cfg.observeRounds !== null && cfg.observeRounds !== '') {
    const n = Number(cfg.observeRounds);
    if (!Number.isInteger(n) || n <= 0) return { error: { code: 'INVALID_OBSERVER_CONFIG', message: 'observeRounds must be a positive integer' } };
    out.observeRounds = n;
  }
  if (cfg.oddBufferLimit !== undefined) {
    const n = Number(cfg.oddBufferLimit);
    if (!Number.isInteger(n) || n <= 0 || n > 1000) return { error: { code: 'INVALID_OBSERVER_CONFIG', message: 'oddBufferLimit must be 1..1000' } };
    out.oddBufferLimit = n;
  }
  return { config: out };
}

class RoundObserver extends EventEmitter {
  constructor(deps = {}) {
    super();
    const v = validateConfig(deps.config || {});
    this._config = v.config || { targetOdd: null, observeRounds: null, oddBufferLimit: 100, historyLimit: 200 };
    this._now = deps.now || (() => performance.now()); // monotonic ms (injectable for tests)
    this._rounds = new Map();   // sid -> RoundExecution
    this._order = [];           // sids in observation order
    this._activeSid = null;
    this._status = STATUS.IDLE;
    this._index = 0;
    this._tracker = deps.roundTracker || null;
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
  rounds() { return this._order.map((sid) => publicRound(this._rounds.get(sid))); }
  activeRound() { return this._activeSid != null ? publicRound(this._rounds.get(this._activeSid)) : null; }

  // Full read-only snapshot for the UI.
  snapshot() {
    const cur = this._tracker && this._tracker.currentRound ? this._tracker.currentRound() : null;
    return {
      readOnly: true,
      status: this._status,
      config: this.config(),
      current: cur,                 // authoritative sid/odd/state from RoundTracker
      active: this.activeRound(),
      rounds: this.rounds(),
      metrics: this.metrics(),
    };
  }

  /**
   * ingest(frameEvent) — consume ONE classified frame event from RoundTracker.
   * frameEvent: { cmd, type, sid, odd, b, aid, eid, wm, direction:'send'|'recv', at }
   * Pure w.r.t. the network: it records evidence, it never emits a frame.
   */
  ingest(ev) {
    if (!ev || ev.cmd == null) return;
    const mono = this._now();
    const wall = ev.at || Date.now();
    switch (ev.cmd) {
      case CMD.ROUND_OPEN: if (ev.direction === 'recv' && ev.sid != null) this._openRound(ev.sid, wall, mono); break;
      case CMD.ROUND_LOCK: if (ev.direction === 'recv') this._setPhase(ev.sid, PHASE.LOCKED); break;
      case CMD.ODD: if (ev.direction === 'recv' && ev.odd != null) this._onOdd(ev.sid, ev.odd, wall, mono); break;
      case CMD.ROUND_END: if (ev.direction === 'recv') this._endRound(ev.sid, wall, mono); break;
      case CMD.BET: ev.direction === 'send' ? this._onBetSent(ev, wall, mono) : this._onBetAck(ev, wall, mono); break;
      case CMD.CASHOUT: ev.direction === 'send' ? this._onCashoutSent(ev, wall, mono) : this._onCashoutAck(ev, wall, mono); break;
      default: break;
    }
    this._emit();
  }

  _openRound(sid, wall, mono) {
    if (!this._rounds.has(sid)) {
      const rec = {
        index: this._index++, sid, phase: PHASE.OPEN,
        startedAt: iso(wall), startedMono: mono, openedAt: iso(wall),
        oddBuffer: [], currentOdd: null, maxOdd: null,
        triggerOdd: null, triggerAt: null,
        bet: null, cashout: null, serverOdd: null, wm: null,
        betLatencyMs: null, cashoutLatencyMs: null,
        finishedAt: null, result: RESULT.OBSERVING,
      };
      this._rounds.set(sid, rec);
      this._order.push(sid);
      if (this._order.length > this._config.historyLimit) { const old = this._order.shift(); this._rounds.delete(old); }
    }
    this._activeSid = sid;
    this._status = STATUS.OBSERVING;
    // A previously "COMPLETED" watch resumes observing if the server opens more rounds.
    if (this._config.observeRounds != null && this._completedCount() >= this._config.observeRounds) this._status = STATUS.COMPLETED;
  }

  _round(sid) {
    // ACKs carry no sid — attribute them to the active round.
    if (sid != null && this._rounds.has(sid)) return this._rounds.get(sid);
    if (this._activeSid != null) return this._rounds.get(this._activeSid);
    return null;
  }

  _setPhase(sid, phase) { const r = this._round(sid); if (r && r.result === RESULT.OBSERVING) r.phase = phase; }

  _onOdd(sid, odd, wall, mono) {
    const r = this._round(sid);
    if (!r) return;
    r.currentOdd = odd;
    r.maxOdd = r.maxOdd == null ? odd : Math.max(r.maxOdd, odd);
    r.oddBuffer.push({ odd, at: iso(wall) });
    if (r.oddBuffer.length > this._config.oddBufferLimit) r.oddBuffer.shift();
    if (r.phase === PHASE.OPEN || r.phase === PHASE.LOCKED || r.phase === PHASE.BET_CONFIRMED) r.phase = PHASE.WATCHING_ODD;
    // Display marker ONLY: flag where the odd first reaches the configured target.
    // This records an observation; it never issues a request.
    if (this._config.targetOdd != null && r.triggerOdd == null && odd >= this._config.targetOdd) {
      r.triggerOdd = odd; r.triggerAt = iso(wall);
    }
  }

  _onBetSent(ev, wall, mono) {
    const r = this._round(ev.sid); if (!r) return;
    if (!r.bet) { r.bet = { b: ev.b, eid: ev.eid, aid: ev.aid, sentAt: iso(wall), sentMono: mono, ackAt: null }; r.phase = PHASE.BET_PENDING; }
  }
  _onBetAck(ev, wall, mono) {
    const r = this._round(ev.sid); if (!r || !r.bet || r.bet.ackAt) return;
    if (r.bet.eid != null && ev.eid != null && String(r.bet.eid) !== String(ev.eid)) return;
    r.bet.ackAt = iso(wall); r.betLatencyMs = round1(mono - r.bet.sentMono); r.phase = PHASE.BET_CONFIRMED;
  }
  _onCashoutSent(ev, wall, mono) {
    const r = this._round(ev.sid); if (!r) return;
    if (!r.cashout) { r.cashout = { eid: ev.eid, aid: ev.aid, sentAt: iso(wall), sentMono: mono, ackAt: null }; r.phase = PHASE.STOP_PENDING; }
  }
  _onCashoutAck(ev, wall, mono) {
    const r = this._round(ev.sid); if (!r || !r.cashout || r.cashout.ackAt) return;
    if (r.cashout.eid != null && ev.eid != null && String(r.cashout.eid) !== String(ev.eid)) return;
    r.cashout.ackAt = iso(wall); r.cashoutLatencyMs = round1(mono - r.cashout.sentMono);
    r.serverOdd = ev.odd != null ? ev.odd : null; r.wm = ev.wm != null ? ev.wm : null;
    r.phase = PHASE.STOP_CONFIRMED; r.result = RESULT.COMPLETED;
  }

  _endRound(sid, wall, mono) {
    const r = this._round(sid); if (!r) return;
    r.phase = PHASE.ROUND_FINISHED; r.finishedAt = iso(wall);
    if (r.result === RESULT.OBSERVING) {
      if (r.cashout && r.cashout.ackAt) r.result = RESULT.COMPLETED;
      else if (this._config.targetOdd != null && (r.maxOdd == null || r.maxOdd < this._config.targetOdd)) r.result = RESULT.ROUND_ENDED_BEFORE_TRIGGER;
      else r.result = RESULT.ENDED;
    }
    if (this._activeSid === sid) { this._activeSid = null; this._status = STATUS.WAITING_ROUND; }
    if (this._config.observeRounds != null && this._completedCount() >= this._config.observeRounds) this._status = STATUS.COMPLETED;
  }

  _completedCount() { let n = 0; for (const sid of this._order) if (this._rounds.get(sid).result !== RESULT.OBSERVING) n++; return n; }

  metrics() {
    const rounds = this._order.map((sid) => this._rounds.get(sid));
    const done = rounds.filter((r) => r.result !== RESULT.OBSERVING);
    const completed = rounds.filter((r) => r.result === RESULT.COMPLETED);
    const endedEarly = rounds.filter((r) => r.result === RESULT.ROUND_ENDED_BEFORE_TRIGGER);
    return {
      observed: rounds.length,
      finished: done.length,
      completed: completed.length,
      endedBeforeTrigger: endedEarly.length,
      target: this._config.observeRounds,
      avgBetLatencyMs: avg(rounds.map((r) => r.betLatencyMs)),
      avgCashoutLatencyMs: avg(rounds.map((r) => r.cashoutLatencyMs)),
      avgTriggerOdd: avg(rounds.map((r) => r.triggerOdd)),
      avgServerOdd: avg(completed.map((r) => r.serverOdd)),
      avgWm: avg(completed.map((r) => r.wm)),
    };
  }

  _emit() { this.emit('update'); }
}

function publicRound(r) {
  if (!r) return null;
  return {
    index: r.index, sid: r.sid, phase: r.phase, result: r.result,
    startedAt: r.startedAt, openedAt: r.openedAt, finishedAt: r.finishedAt,
    currentOdd: r.currentOdd, maxOdd: r.maxOdd,
    triggerOdd: r.triggerOdd, triggerAt: r.triggerAt,
    oddBuffer: r.oddBuffer.slice(),
    bet: r.bet ? { ...r.bet } : null, cashout: r.cashout ? { ...r.cashout } : null,
    serverOdd: r.serverOdd, wm: r.wm,
    betLatencyMs: r.betLatencyMs, cashoutLatencyMs: r.cashoutLatencyMs,
  };
}

function iso(wall) { try { return new Date(wall).toISOString(); } catch { return new Date().toISOString(); } }
function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }        // latency ms
function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }      // odds
function avg(list) { const xs = list.filter((x) => typeof x === 'number' && Number.isFinite(x)); if (!xs.length) return null; return round2(xs.reduce((a, b) => a + b, 0) / xs.length); }

module.exports = { RoundObserver, validateConfig, PHASE, STATUS, RESULT };
