'use strict';

const EventEmitter = require('node:events');
const { performance } = require('node:perf_hooks');
const { CMD } = require('./aviator.cjs');

// ---------------------------------------------------------------------------
// AutoRunner — automated round runner.
//
// It reuses everything: RoundTracker/RoundObserver own SID + ODD + round lifecycle
// (this runner only READS them), and ProtocolHarness + wsReplay own the send seam
// and ACK correlation. The runner is a pure event-driven state machine over the
// frame stream; no polling, no local SID/odd prediction, exactly-once cashout.
// ---------------------------------------------------------------------------

const STATE = Object.freeze({
  IDLE: 'IDLE', WAITING_ROUND: 'WAITING_ROUND', BET_SENDING: 'BET_SENDING',
  WAITING_BET_ACK: 'WAITING_BET_ACK', WATCHING_ODD: 'WATCHING_ODD',
  CASHOUT_SENDING: 'CASHOUT_SENDING', WAITING_CASHOUT_ACK: 'WAITING_CASHOUT_ACK',
  COMPLETED: 'COMPLETED', STOPPED: 'STOPPED', ERROR: 'ERROR',
});

const RESULT = Object.freeze({
  COMPLETED: 'COMPLETED', ROUND_ENDED_BEFORE_THRESHOLD: 'ROUND_ENDED_BEFORE_THRESHOLD',
  BET_ACK_TIMEOUT: 'BET_ACK_TIMEOUT', BET_REJECTED: 'BET_REJECTED',
  CASHOUT_ACK_TIMEOUT: 'CASHOUT_ACK_TIMEOUT', CASHOUT_REJECTED: 'CASHOUT_REJECTED',
  STOPPED: 'STOPPED', ERROR: 'ERROR', INCONCLUSIVE: 'INCONCLUSIVE',
});

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'];
const LOCAL_SUFFIXES = ['.test.local', '.localhost', '.local', '.test'];

function autoHostAllowed(host, extra = []) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (LOCAL_HOSTS.includes(h)) return true;
  if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return extra.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p));
}

function validateConfig(cfg = {}) {
  const rc = Number(cfg.roundCount);
  if (!Number.isInteger(rc) || rc < 1) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'roundCount must be an integer >= 1' } };
  const amt = Number(cfg.amount);
  if (!Number.isFinite(amt) || amt <= 0) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'amount must be > 0' } };
  const so = Number(cfg.stopOdd);
  if (!Number.isFinite(so) || so <= 0) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'stopOdd must be > 0' } };
  const aid = cfg.aid == null ? 1 : Number(cfg.aid);
  const eid = cfg.eid == null ? 1 : Number(cfg.eid);
  if (!Number.isInteger(aid) || aid < 0 || !Number.isInteger(eid) || eid < 0) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'aid/eid must be non-negative integers' } };
  return { config: { roundCount: rc, amount: amt, stopOdd: so, aid, eid, betAckTimeoutMs: Number(cfg.betAckTimeoutMs) || 8000, cashoutAckTimeoutMs: Number(cfg.cashoutAckTimeoutMs) || 8000 } };
}

class AutoRunner extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._tracker = deps.roundTracker;
    this._observer = deps.observer;                 // RoundObserver — source of truth for sid/odd
    this._harness = deps.harness;                   // ProtocolHarness — send + ack correlation
    this._getTargetUrl = deps.getTargetUrl || (() => '');
    this._extraHosts = [];
    this._now = deps.now || (() => performance.now());
    this._wallNow = deps.wallNow || (() => Date.now());

    this._state = STATE.IDLE;
    this._running = false;
    this._config = null;
    this._targetId = null;
    this._attempted = 0;
    this._usedSids = new Set();
    this._history = [];
    this._active = null;   // active RoundTestExecution
    if (this._tracker && this._tracker.on) this._tracker.on('frame', (ev) => this._onFrame(ev));
  }

  state() { return this._state; }
  isRunning() { return this._running; }
  history() { return this._history.map((r) => ({ ...r })); }

  environmentFor(targetId) {
    const url = String(this._getTargetUrl(targetId) || '');
    let host = '';
    try { host = url ? new URL(url).hostname.toLowerCase() : ''; } catch { host = ''; }
    const matched = autoHostAllowed(host, this._extraHosts);
    return { host, url, allowed: true, matched, guardEnabled: false, requiresConfirmation: false };
  }

  snapshot() {
    const cur = this._observer && this._observer.currentRound ? this._observer.currentRound() : null;
    const env = this.environmentFor(this._targetId);
    return {
      running: this._running, state: this._state, config: this._config,
      environment: { host: env.host, allowed: env.allowed },
      progress: { attempted: this._attempted, finished: this._attempted, target: this._config ? this._config.roundCount : null },
      active: this._active ? publicRound(this._active) : null,
      liveOdd: cur ? cur.currentOdd : null,
      liveSid: cur ? cur.sid : null,
      liveState: cur ? cur.phase : null,
      history: this.history(),
      metrics: this.metrics(),
      dayGroups: this.dayGroups(),
      currentDay: this.currentDay(),
    };
  }

  // ---- lifecycle ----
  start(targetId, cfg) {
    if (this._running) return { error: { code: 'AUTO_TEST_ALREADY_RUNNING', message: 'A test run is already active' } };
    const v = validateConfig(cfg || {});
    if (v.error) return { error: v.error };
    const env = this.environmentFor(targetId);

    this._config = v.config;
    this._targetId = targetId != null ? String(targetId) : null;
    this._attempted = 0;
    this._usedSids = new Set();
    this._history = [];
    this._active = null;
    this._running = true;
    this._state = STATE.WAITING_ROUND;
    this._emit();
    return { ok: true, state: this._state, config: this._config, environment: { host: env.host, allowed: true } };
  }

  stop() {
    if (!this._running) return { error: { code: 'AUTO_TEST_NOT_RUNNING', message: 'No test run is active' } };
    this._running = false;
    // Do NOT send a cashout just because the user stopped (§21). Finalize an
    // in-flight watched round as STOPPED only if it had not already committed.
    if (this._active && !this._active._cashoutSent && this._active.result == null) {
      this._finalize(this._active, RESULT.STOPPED);
    }
    this._state = STATE.STOPPED;
    this._emit();
    return { ok: true, state: this._state };
  }

  metrics() { return metricsForRounds(this._history, this._attempted); }

  dayGroups() {
    const groups = new Map();
    for (const r of this._history) {
      const day = r.finishedDay || 'unknown';
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(r);
    }
    return [...groups.entries()]
      .map(([day, rows]) => ({ day, ...metricsForRounds(rows) }))
      .sort((a, b) => String(b.day).localeCompare(String(a.day)));
  }

  metricsForDay(day) {
    const key = String(day || '').trim();
    return metricsForRounds(key ? this._history.filter((r) => r.finishedDay === key) : this._history);
  }

  currentDay() { return localDayKey(this._wallNow()); }

  // ---- event-driven state machine (reads observer for authoritative sid/odd) ----
  _onFrame(ev) {
    if (!this._running || !ev || ev.direction !== 'recv') return;
    const cur = this._observer && this._observer.currentRound ? this._observer.currentRound() : null;
    if (ev.cmd === CMD.ROUND_OPEN || ev.cmd === CMD.ROUND_SNAPSHOT) this._onRoundOpen(cur ? cur.sid : ev.sid);
    else if (ev.cmd === CMD.ODD) {
      // Track the round's highest authoritative server odd (reuses the observer's
      // maxOdd, which is derived only from recv cmd:100009). WU-C.2 history telemetry.
      if (this._active && cur && String(cur.sid) === String(this._active.sid) && cur.maxOdd != null) this._active.maxOdd = cur.maxOdd;
      this._onOdd(cur);
    } else if (ev.cmd === CMD.ROUND_END) this._onRoundEnd(ev.sid);
  }

  _onRoundOpen(sid) {
    if (this._state !== STATE.WAITING_ROUND || sid == null) return;
    if (this._attempted >= this._config.roundCount) return;
    if (this._usedSids.has(String(sid))) return;      // duplicate 100005 for same sid -> no duplicate bet (§10)
    this._usedSids.add(String(sid));
    this._attempted++;
    const now = this._now();
    this._active = {
      index: this._attempted - 1, sid, amount: this._config.amount, stopOdd: this._config.stopOdd,
      openedAtMono: now, openedAtMs: this._wallNow(), betResult: null, betLatencyMs: null, betAckAmount: null,
      triggerOdd: null, triggerAtMono: null, ackOdd: null, wm: null, maxOdd: null,
      cashoutLatencyMs: null, triggerToSendMs: null, result: null,
      _cashoutSent: false, _betSentMono: null, _cashoutSentMono: null,
    };
    this._state = STATE.BET_SENDING;
    this._emit();
    this._sendBet(this._active);
  }

  async _sendBet(round) {
    round._betSentMono = this._now();
    this._state = STATE.WAITING_BET_ACK; this._emit();
    let res;
    try { res = await this._harness.execute({ targetId: this._targetId, command: 'bet', overrides: { b: this._config.amount, aid: this._config.aid, eid: this._config.eid }, source: 'AUTO_TEST' }); }
    catch (e) { res = { result: 'ERROR', error: { code: 'ERROR', message: String(e && e.message || e) } }; }
    // Guard against stop/replacement while awaiting.
    if (!this._running || this._active !== round) { if (this._active === round) this._finalize(round, RESULT.STOPPED); return; }
    round.betResult = res.result;
    round.betLatencyMs = round1(this._now() - round._betSentMono);
    // Server-echoed accepted bet amount (may differ from the requested amount if the
    // server normalizes). Authoritative only when the bet was ACKed. (WU-C.2 §15)
    round.betAckAmount = (res.result === 'ACK' && res.responsePayload && res.responsePayload.b != null) ? res.responsePayload.b : null;
    if (res.result === 'ACK') {
      // Bet ACK gate satisfied — only NOW may we evaluate the stop condition (§11).
      this._state = STATE.WATCHING_ODD; this._emit();
      // If the odd already crossed the threshold while we waited for the ack,
      // react immediately using the observer's authoritative current odd.
      this._onOdd(this._observer && this._observer.currentRound ? this._observer.currentRound() : null);
    } else {
      this._finalize(round, res.result === 'TIMEOUT' ? RESULT.BET_ACK_TIMEOUT : res.result === 'REJECTED' ? RESULT.BET_REJECTED : RESULT.ERROR, res.error);
    }
  }

  _onOdd(cur) {
    if (this._state !== STATE.WATCHING_ODD || !this._active || !cur) return;
    if (String(cur.sid) !== String(this._active.sid)) return;      // odd for a different sid -> ignore (§4/§12)
    const odd = cur.currentOdd;
    if (odd == null) return;
    // Exactly-once (§14): flip the guard and transition BEFORE the async send, so a
    // burst of qualifying frames can never produce a second cashout.
    if (!this._active._cashoutSent && odd >= this._config.stopOdd) {
      this._active._cashoutSent = true;
      this._active.triggerOdd = odd;                                // server odd that satisfied the condition (§16)
      this._active.triggerAtMono = this._now();
      this._state = STATE.CASHOUT_SENDING; this._emit();
      this._sendCashout(this._active);
    }
  }

  async _sendCashout(round) {
    round._cashoutSentMono = this._now();
    round.triggerToSendMs = round1(round._cashoutSentMono - round.triggerAtMono);
    this._state = STATE.WAITING_CASHOUT_ACK; this._emit();
    let res;
    try { res = await this._harness.execute({ targetId: this._targetId, command: 'cashout', overrides: { aid: this._config.aid, eid: this._config.eid }, source: 'AUTO_TEST' }); }
    catch (e) { res = { result: 'ERROR', error: { code: 'ERROR', message: String(e && e.message || e) } }; }
    if (this._active !== round) return;
    round.cashoutLatencyMs = round1(this._now() - round._cashoutSentMono);
    if (res.result === 'ACK') {
      // Server owns the returned odd/wm — recorded separately from triggerOdd (§16).
      round.ackOdd = res.responsePayload ? res.responsePayload.odd : null;
      round.wm = res.responsePayload ? res.responsePayload.wm : null;
      this._finalize(round, RESULT.COMPLETED);
    } else if (res.result === 'REJECTED') {
      this._finalize(round, RESULT.CASHOUT_REJECTED, res.error);
    } else {
      // No unique correlation -> record INCONCLUSIVE rather than false success (§17).
      this._finalize(round, res.result === 'TIMEOUT' ? RESULT.CASHOUT_ACK_TIMEOUT : RESULT.ERROR, res.error);
    }
  }

  _onRoundEnd(sid) {
    if (!this._active || String(sid) !== String(this._active.sid)) return;
    // Only act if we were still watching and never cashed out (§18). If a cashout
    // is in flight, its result finalizes the round instead.
    if (this._state === STATE.WATCHING_ODD && !this._active._cashoutSent) {
      this._finalize(this._active, RESULT.ROUND_ENDED_BEFORE_THRESHOLD);
    }
  }

  _finalize(round, result, error) {
    if (round.result != null) return;           // already finalized
    round.result = result;
    round.error = error || null;
    round.finishedAtMono = this._now();
    round.finishedAtMs = this._wallNow();
    round.finishedDay = localDayKey(round.finishedAtMs);
    const pub = publicRound(round);
    this._history.push(pub);
    if (this._active === round) this._active = null;
    // WU-C.2 additive seam: a single authoritative "round finalized" event carrying the
    // full public round, consumed by the RoundHistoryCollector for persistence.
    this.emit('roundFinalized', pub);
    this._afterRound(result);
    this._emit();
  }

  _afterRound(result) {
    if (!this._running) { this._state = STATE.STOPPED; return; }
    if (result === RESULT.COMPLETED) {
      this._attempted = 0;
      this._state = STATE.WAITING_ROUND;
      return;
    }
    if (this._attempted >= this._config.roundCount) { this._running = false; this._state = STATE.COMPLETED; return; }
    this._state = STATE.WAITING_ROUND;          // wait for the next server 100005 (§19)
  }

  _emit() { this.emit('update'); }
}

function publicRound(r) {
  return {
    index: r.index, sid: r.sid, amount: r.amount, stopOdd: r.stopOdd,
    betResult: r.betResult, betLatencyMs: r.betLatencyMs, betAckAmount: r.betAckAmount ?? null,
    triggerOdd: r.triggerOdd, ackOdd: r.ackOdd, wm: r.wm, maxOdd: r.maxOdd ?? null,
    triggerToSendMs: r.triggerToSendMs, cashoutLatencyMs: r.cashoutLatencyMs,
    result: r.result, error: r.error || null,
    openedAtMs: r.openedAtMs || null, finishedAtMs: r.finishedAtMs || null, finishedDay: r.finishedDay || null,
  };
}

function round1(n) { return (n == null || !Number.isFinite(n)) ? null : Math.round(n * 10) / 10; }
function avg(list) { const xs = list.filter((x) => typeof x === 'number' && Number.isFinite(x)); if (!xs.length) return null; return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100; }
function localDayKey(ms) {
  const d = new Date(Number(ms) || Date.now());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function metricsForRounds(done, attempted = done.length) {
  const completed = done.filter((r) => r.result === RESULT.COMPLETED);
  const lastCompleted = completed.length ? completed[completed.length - 1] : null;
  return {
    attempted, finished: done.length, completed: completed.length,
    successfulStops: completed.length,
    lastSuccessfulStopOdd: lastCompleted ? (lastCompleted.ackOdd ?? lastCompleted.triggerOdd ?? null) : null,
    endedBeforeThreshold: done.filter((r) => r.result === RESULT.ROUND_ENDED_BEFORE_THRESHOLD).length,
    betTimeouts: done.filter((r) => r.result === RESULT.BET_ACK_TIMEOUT).length,
    avgBetAckLatencyMs: avg(done.map((r) => r.betLatencyMs)),
    avgTriggerToSendMs: avg(done.map((r) => r.triggerToSendMs)),
    avgCashoutAckLatencyMs: avg(done.map((r) => r.cashoutLatencyMs)),
    avgTriggerOdd: avg(done.map((r) => r.triggerOdd)),
    avgAckOdd: avg(completed.map((r) => r.ackOdd)),
  };
}

module.exports = { AutoRunner, validateConfig, autoHostAllowed, STATE, RESULT, LOCAL_HOSTS, LOCAL_SUFFIXES, localDayKey };
