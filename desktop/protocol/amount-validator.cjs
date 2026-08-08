'use strict';

const EventEmitter = require('node:events');
const { performance } = require('node:perf_hooks');
const { CMD } = require('./aviator.cjs');
const { autoHostAllowed } = require('./auto-runner.cjs');

// ---------------------------------------------------------------------------
// AmountValidator — WU10.2. Sends an EXACT, tester-supplied bet amount `b` on each
// new server round and records what the server actually does: ACCEPTED_EXACT /
// ACCEPTED_NORMALIZED / REJECTED / INCONCLUSIVE. It tests whether the SERVER
// enforces amount rules — the observed client-UI range (~5000..50000) is NOT
// treated as a server rule; any numeric b (-1, 0, 4999, 50001, 2147483647, …) may
// be tested. It never clamps/snaps/rounds the value.
//
// Bet-only: no odd watching, no cashout, no 100003 (§34). One case per distinct
// server SID (§10). Hard-bound to local/offline endpoints (reuses the WU10 gate).
// The WU10 round flow (AutoRunner) is untouched — this is a separate mode (§35).
// ---------------------------------------------------------------------------

const STATE = Object.freeze({ IDLE: 'IDLE', WAITING_ROUND: 'WAITING_ROUND', BET_SENDING: 'BET_SENDING', WAITING_BET_ACK: 'WAITING_BET_ACK', COMPLETED: 'COMPLETED', STOPPED: 'STOPPED' });
const OBSERVED = Object.freeze({ ACCEPTED_EXACT: 'ACCEPTED_EXACT', ACCEPTED_NORMALIZED: 'ACCEPTED_NORMALIZED', REJECTED: 'REJECTED', INCONCLUSIVE: 'INCONCLUSIVE' });

// Display-only intent classification (§8). Never affects what is sent.
function classifyCategory(b, opts = {}) {
  const uiMin = opts.uiMin != null ? Number(opts.uiMin) : 5000;
  const uiMax = opts.uiMax != null ? Number(opts.uiMax) : 50000;
  const presets = (opts.presets || []).map(Number);
  const n = Number(b);
  if (!Number.isFinite(n)) return 'INVALID';
  if (n < 0) return 'NEGATIVE';
  if (n === 0) return 'ZERO';
  if (n >= uiMax * 2) return 'EXTREME';
  if (n === uiMin) return 'UI_MIN';
  if (n === uiMax) return 'UI_MAX';
  if (presets.includes(n)) return 'UI_PRESET';
  if (n < uiMin) return 'BELOW_UI_MIN';
  if (n > uiMax) return 'ABOVE_UI_MAX';
  return 'WITHIN_UI_RANGE_NON_PRESET';
}

// Basic TYPE validation only (§4). Business rules belong to the server, so any
// finite number is allowed — including negatives, zero and extremes.
function isTestableAmount(n) { return typeof n === 'number' && Number.isFinite(n); }

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function validateAmountConfig(cfg = {}) {
  const mode = cfg.mode === 'list' ? 'list' : 'single';
  const aid = cfg.aid == null ? 1 : Number(cfg.aid);
  const eid = cfg.eid == null ? 1 : Number(cfg.eid);
  if (!Number.isInteger(aid) || aid < 0 || !Number.isInteger(eid) || eid < 0) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'aid/eid must be non-negative integers' } };
  const expected = ['accept', 'reject'].includes(cfg.expected) ? cfg.expected : 'any';
  const common = { mode, aid, eid, expected, uiMin: num(cfg.uiMin, 5000), uiMax: num(cfg.uiMax, 50000), presets: Array.isArray(cfg.presets) ? cfg.presets.map(Number) : [], betAckTimeoutMs: Number(cfg.betAckTimeoutMs) || 8000 };
  if (mode === 'single') {
    const amount = Number(cfg.amount);
    if (!isTestableAmount(amount)) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'Bet Amount must be a finite number (any value, incl. negative/zero)' } };
    const rc = Number(cfg.roundCount);
    if (!Number.isInteger(rc) || rc < 1) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'roundCount must be an integer >= 1' } };
    return { config: { ...common, amount, roundCount: rc } };
  }
  const values = Array.isArray(cfg.values) ? cfg.values.map(Number) : [];
  if (!values.length || !values.every(isTestableAmount)) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'values must be a non-empty list of finite numbers' } };
  return { config: { ...common, values, roundCount: values.length } };
}

function classifyOutcome(res, sentB) {
  if (!res) return { observed: OBSERVED.INCONCLUSIVE, ackB: null };
  if (res.result === 'ACK') {
    const ackB = res.responsePayload ? res.responsePayload.b : undefined;
    if (ackB === undefined || ackB === null) return { observed: OBSERVED.ACCEPTED_EXACT, ackB: null }; // accepted, protocol echoes b
    return { observed: Number(ackB) === Number(sentB) ? OBSERVED.ACCEPTED_EXACT : OBSERVED.ACCEPTED_NORMALIZED, ackB: Number(ackB) };
  }
  if (res.result === 'REJECTED') return { observed: OBSERVED.REJECTED, ackB: null };
  return { observed: OBSERVED.INCONCLUSIVE, ackB: null }; // TIMEOUT / ERROR / silent drop (§15)
}

// Only produce PASS/FAIL when the tester set an expectation (§16/§17).
function verdictFor(expected, observed) {
  const accepted = observed === OBSERVED.ACCEPTED_EXACT || observed === OBSERVED.ACCEPTED_NORMALIZED;
  if (expected === 'accept') return accepted ? 'PASS' : observed === OBSERVED.REJECTED ? 'FAIL' : 'INCONCLUSIVE';
  if (expected === 'reject') return observed === OBSERVED.REJECTED ? 'PASS' : accepted ? 'FAIL' : 'INCONCLUSIVE';
  return null; // 'any' -> observation only
}

class AmountValidator extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._tracker = deps.roundTracker;
    this._harness = deps.harness;
    this._getTargetUrl = deps.getTargetUrl || (() => '');
    this._extraHosts = (deps.autoHosts && deps.autoHosts.length ? deps.autoHosts : String(process.env.OBSERVATORY_AUTOTEST_HOSTS || '').split(','))
      .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
    this._now = deps.now || (() => performance.now());
    this._state = STATE.IDLE;
    this._running = false;
    this._config = null;
    this._targetId = null;
    this._caseIndex = 0;
    this._usedSids = new Set();
    this._history = [];
    this._active = null;
    if (this._tracker && this._tracker.on) this._tracker.on('frame', (ev) => this._onFrame(ev));
  }

  state() { return this._state; }
  isRunning() { return this._running; }
  history() { return this._history.map((c) => ({ ...c })); }

  environmentFor(targetId) {
    const url = String(this._getTargetUrl(targetId) || '');
    let host = ''; try { host = url ? new URL(url).hostname.toLowerCase() : ''; } catch { host = ''; }
    return { host, url, allowed: autoHostAllowed(host, this._extraHosts) };
  }

  _totalCases() { return this._config ? this._config.roundCount : 0; }
  _valueForCase(i) { return this._config.mode === 'list' ? this._config.values[i] : this._config.amount; }

  snapshot() {
    const env = this.environmentFor(this._targetId);
    return {
      running: this._running, state: this._state, config: this._config,
      environment: { host: env.host, allowed: env.allowed },
      progress: { done: this._history.length, total: this._totalCases() },
      active: this._active ? { ...this._active } : null,
      history: this.history(),
      summary: this.summary(),
    };
  }

  start(targetId, cfg) {
    if (this._running) return { error: { code: 'AUTO_TEST_ALREADY_RUNNING', message: 'A validation run is already active' } };
    const v = validateAmountConfig(cfg || {});
    if (v.error) return { error: v.error };
    const env = this.environmentFor(targetId);
    if (!env.allowed) return { error: { code: 'AUTO_TEST_TARGET_NOT_ALLOWED', message: `Amount validation is bound to local/offline test endpoints. Host "${env.host || '(unknown)'}" is not permitted.` } };
    this._config = v.config;
    this._targetId = targetId != null ? String(targetId) : null;
    this._caseIndex = 0;
    this._usedSids = new Set();
    this._history = [];
    this._active = null;
    this._running = true;
    this._state = STATE.WAITING_ROUND;
    this._emit();
    return { ok: true, state: this._state, config: this._config };
  }

  stop() {
    if (!this._running) return { error: { code: 'AUTO_TEST_NOT_RUNNING', message: 'No validation run is active' } };
    this._running = false;
    this._state = STATE.STOPPED;
    this._emit();
    return { ok: true, state: this._state };
  }

  _onFrame(ev) {
    if (!this._running || !ev || ev.direction !== 'recv') return;
    if (ev.cmd !== CMD.ROUND_OPEN) return;               // amount test ignores odd/lock/end (§34)
    const cur = this._tracker && this._tracker.currentRound ? this._tracker.currentRound() : null;
    this._onRoundOpen(cur ? cur.sid : ev.sid);
  }

  _onRoundOpen(sid) {
    if (this._state !== STATE.WAITING_ROUND || sid == null) return;
    if (this._caseIndex >= this._totalCases()) return;
    if (this._usedSids.has(String(sid))) return;          // one case per SID (§10)
    this._usedSids.add(String(sid));
    const requestedB = this._valueForCase(this._caseIndex);
    this._active = {
      index: this._caseIndex, sid, requestedB, sentB: null, ackB: null, diff: null,
      category: classifyCategory(requestedB, this._config),
      observed: null, verdict: null, latencyMs: null, error: null,
    };
    this._state = STATE.BET_SENDING;
    this._emit();
    this._sendBet(this._active);
  }

  async _sendBet(kase) {
    const t0 = this._now();
    this._state = STATE.WAITING_BET_ACK; this._emit();
    let res;
    try {
      // The EXACT tester value goes on the wire — harness.buildTemplate sets b to
      // our override verbatim (no clamp/snap/round). SID comes from the server.
      res = await this._harness.execute({ targetId: this._targetId, command: 'bet', overrides: { b: kase.requestedB, aid: this._config.aid, eid: this._config.eid }, source: 'AMOUNT_VALIDATION' });
    } catch (e) { res = { result: 'ERROR', error: { code: 'ERROR', message: String(e && e.message || e) } }; }
    if (!this._running || this._active !== kase) return;
    // Record the ACTUAL outbound b from the built request (invariant: == input).
    kase.sentB = res && res.requestPayload && res.requestPayload.b !== undefined ? res.requestPayload.b : kase.requestedB;
    kase.latencyMs = round1(this._now() - t0);
    const outcome = classifyOutcome(res, kase.sentB);
    kase.observed = outcome.observed;
    kase.ackB = outcome.ackB;
    kase.diff = (outcome.ackB != null) ? outcome.ackB - Number(kase.sentB) : null;
    kase.verdict = verdictFor(this._config.expected, kase.observed);
    if (res && res.error) kase.error = res.error;
    this._finalize(kase);
  }

  _finalize(kase) {
    this._history.push({ ...kase });
    this._active = null;
    this._caseIndex++;
    if (this._caseIndex >= this._totalCases()) { this._running = false; this._state = STATE.COMPLETED; }
    else this._state = STATE.WAITING_ROUND;
    this._emit();
  }

  summary() {
    const h = this._history;
    const acc = h.filter((c) => c.observed === OBSERVED.ACCEPTED_EXACT || c.observed === OBSERVED.ACCEPTED_NORMALIZED);
    return {
      tested: h.length,
      acceptedExact: h.filter((c) => c.observed === OBSERVED.ACCEPTED_EXACT).length,
      acceptedNormalized: h.filter((c) => c.observed === OBSERVED.ACCEPTED_NORMALIZED).length,
      rejected: h.filter((c) => c.observed === OBSERVED.REJECTED).length,
      inconclusive: h.filter((c) => c.observed === OBSERVED.INCONCLUSIVE).length,
      // Server-behavior OBSERVATIONS (not auto-labeled vulnerabilities §22).
      acceptedBelowMin: acc.filter((c) => c.category === 'BELOW_UI_MIN').map((c) => c.sentB),
      acceptedAboveMax: acc.filter((c) => c.category === 'ABOVE_UI_MAX' || c.category === 'EXTREME').map((c) => c.sentB),
      acceptedNonPreset: acc.filter((c) => c.category === 'WITHIN_UI_RANGE_NON_PRESET').map((c) => c.sentB),
      passes: h.filter((c) => c.verdict === 'PASS').length,
      fails: h.filter((c) => c.verdict === 'FAIL').length,
    };
  }

  _emit() { this.emit('update'); }
}

function round1(n) { return (n == null || !Number.isFinite(n)) ? null : Math.round(n * 10) / 10; }

module.exports = { AmountValidator, validateAmountConfig, classifyCategory, classifyOutcome, verdictFor, isTestableAmount, STATE, OBSERVED };
