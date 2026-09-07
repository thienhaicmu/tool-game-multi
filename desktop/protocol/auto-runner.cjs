'use strict';

const EventEmitter = require('node:events');
const { performance } = require('node:perf_hooks');
const { CMD } = require('./aviator.cjs');
const { parseStrict } = require('./numeric.cjs');

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
  // Part D/E — between-round states owning the next-round random BET delay.
  WAITING_NEXT_ROUND: 'WAITING_NEXT_ROUND', WAITING_NEXT_BET_DELAY: 'WAITING_NEXT_BET_DELAY',
  COMPLETED: 'COMPLETED', STOPPED: 'STOPPED', ERROR: 'ERROR',
});

// States in which an active Auto intent is legitimately explainable (§4/§5/§61).
// If the runner is running but NOT in one of these, liveness is broken.
const ACTIVE_STATES = new Set([
  STATE.WAITING_ROUND, STATE.BET_SENDING, STATE.WAITING_BET_ACK, STATE.WATCHING_ODD,
  STATE.CASHOUT_SENDING, STATE.WAITING_CASHOUT_ACK, STATE.WAITING_NEXT_ROUND, STATE.WAITING_NEXT_BET_DELAY,
]);

// Machine-readable terminal reasons for the Auto EXECUTION record (§6/§14). This
// is derived from the internal terminationReason but normalized to a stable set the
// History UI can translate; internal terminationReason values are preserved as-is.
const STOP_REASON = Object.freeze({
  USER_STOP: 'USER_STOP', ROUND_TARGET_COMPLETED: 'ROUND_TARGET_COMPLETED',
  STOP_1000X_REACHED: 'STOP_1000X_REACHED', SESSION_RECOVERY: 'SESSION_RECOVERY',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED', RECOVERY_FAILED: 'RECOVERY_FAILED',
  AUTO_ERROR: 'AUTO_ERROR', RUN_CLOSED: 'RUN_CLOSED', APP_CLOSED: 'APP_CLOSED',
  LICENSE_BLOCKED: 'LICENSE_BLOCKED', UNKNOWN: 'UNKNOWN',
});

function normalizeStopReason(internal) {
  switch (String(internal || '')) {
    case 'MANUAL': return STOP_REASON.USER_STOP;
    case 'COMPLETED': return STOP_REASON.ROUND_TARGET_COMPLETED;
    case 'STOPPED_1000X_REACHED': return STOP_REASON.STOP_1000X_REACHED;
    case 'SESSION_RECOVERY': return STOP_REASON.SESSION_RECOVERY;
    case 'LOGIN_REQUIRED': return STOP_REASON.LOGIN_REQUIRED;
    case 'RECOVERY_FAILED': return STOP_REASON.RECOVERY_FAILED;
    case 'AUTO_ERROR': return STOP_REASON.AUTO_ERROR;
    case 'RUN_CLOSED': return STOP_REASON.RUN_CLOSED;
    case 'APP_CLOSED': return STOP_REASON.APP_CLOSED;
    case 'LICENSE_BLOCKED': return STOP_REASON.LICENSE_BLOCKED;
    case '': return null;
    default: return STOP_REASON[internal] || STOP_REASON.UNKNOWN;
  }
}

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
  // STRICT parsing (no silent coercion): rejects ''/whitespace→0, scientific/hex strings,
  // trailing garbage, NaN/Infinity, and (for counts) precision-losing huge integers. This is
  // the main-process authority — it never trusts an already-coerced renderer payload (§layers).
  const rc = parseStrict(cfg.roundCount, { integer: true, min: 1 });
  if (rc.error) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'roundCount must be a whole number >= 1' } };
  const amt = parseStrict(cfg.amount, { gt: 0 });
  if (amt.error) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'amount must be a number > 0' } };
  const so = parseStrict(cfg.stopOdd, { gt: 0 });
  if (so.error) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'stopOdd must be a number > 0' } };
  // aid/eid are session context (default 1); they are NOT user-editable in the product.
  const aid = cfg.aid == null ? { value: 1 } : parseStrict(cfg.aid, { integer: true, min: 0 });
  const eid = cfg.eid == null ? { value: 1 } : parseStrict(cfg.eid, { integer: true, min: 0 });
  if (aid.error || eid.error) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'aid/eid must be non-negative integers' } };
  // Part E — next-round random BET delay window. Both default 0 (feature OFF → the
  // original immediate-bet behaviour is preserved). When max>0 the runner waits for
  // the NEXT authoritative ROUND_OPEN, then a fresh random delay in [min,max] ms.
  const dMin = cfg.betDelayMinMs == null ? { value: 0 } : parseStrict(cfg.betDelayMinMs, { integer: true, min: 0 });
  const dMax = cfg.betDelayMaxMs == null ? { value: 0 } : parseStrict(cfg.betDelayMaxMs, { integer: true, min: 0 });
  if (dMin.error || dMax.error) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'betDelayMinMs/betDelayMaxMs must be non-negative integers' } };
  if (dMax.value > 0 && dMax.value < dMin.value) return { error: { code: 'INVALID_AUTO_TEST_CONFIG', message: 'betDelayMaxMs must be >= betDelayMinMs' } };
  // The delay feature is ON when explicitly requested OR when a positive max is given
  // (so the product can enable it simply by configuring betDelayMaxMs). With the flag
  // on and max=0 the runner still waits for the next ROUND_OPEN, then a 0ms delay (§55).
  const nextRoundBetDelay = cfg.nextRoundBetDelay === true || dMax.value > 0;
  return { config: { roundCount: rc.value, amount: amt.value, stopOdd: so.value, aid: aid.value, eid: eid.value, betAckTimeoutMs: Number(cfg.betAckTimeoutMs) || 8000, cashoutAckTimeoutMs: Number(cfg.cashoutAckTimeoutMs) || 8000, betDelayMinMs: dMin.value, betDelayMaxMs: dMax.value, nextRoundBetDelay } };
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
    // Part E — injectable randomness + scheduler so the next-round delay is
    // deterministically testable (no real random sleeps in tests, §54).
    this._random = typeof deps.random === 'function' ? deps.random : Math.random;
    this._scheduler = deps.scheduler || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
    // Part C — optional background diagnostic logger (bound with browserId/runId by
    // the host). Best-effort; a diagnostics failure must never affect execution.
    this._diag = deps.diag || null;
    // Part A — Auto EXECUTION identity source (§2). One user Auto start == one id;
    // a recovery pause/resume preserves it (never a new id on reload/reconnect/re-entry).
    let execSeq = 0;
    this._newExecId = typeof deps.newExecutionId === 'function'
      ? deps.newExecutionId
      : () => `AX-${this._wallNow()}-${++execSeq}`;

    this._state = STATE.IDLE;
    this._running = false;
    this._config = null;
    // Part A — execution identity + terminal evidence.
    this._autoExecutionId = null;
    this._startedAtMs = null;
    this._executionFinalized = false;
    this._recoveryCount = 0;
    this._lastRecoveryReason = null;
    this._pausedForRecovery = false;
    this._stopReason = null;
    this._stopOdd = null;
    this._stopOddObservedAt = null;
    this._stopOddSid = null;
    this._stopOddSource = null;
    this._errorCode = null;
    // Part E — pending delayed-bet handle (one per BrowserRun; never global).
    this._pendingBet = null;
    this._betScheduleSeq = 0;
    // Stop-1000x take-profit: when set, the session terminates (with this reason) as soon
    // as the in-flight 1000x cashout resolves — instead of continuing to the next round.
    this._pendingStopMeta = null;
    // WU-D: how the LAST session terminated — kept distinct so a Stop-1000x kill
    // switch, a manual Stop and a normal N-round completion are never confused.
    this._terminationReason = null;
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
  autoExecutionId() { return this._autoExecutionId; }
  recoveryCount() { return this._recoveryCount; }
  pausedForRecovery() { return this._pausedForRecovery; }

  // Part B — per-run liveness cross-check (§9). Never uses UI selection/active run as
  // identity; purely a function of THIS runner's own intent + state. If an Auto intent
  // exists it must map to a legitimate active state, else AUTO_LIVENESS_BROKEN.
  liveness() {
    const autoIntentActive = this._running === true;
    if (!autoIntentActive) return { autoIntentActive: false, state: this._state, ok: true, reason: null };
    const ok = ACTIVE_STATES.has(this._state);
    return { autoIntentActive: true, state: this._state, ok, reason: ok ? null : 'AUTO_LIVENESS_BROKEN' };
  }

  _diagLog(level, category, event, fields = {}) {
    if (!this._diag || !this._diag.log) return;
    try { this._diag.log({ level, category, event, autoExecutionId: this._autoExecutionId, ...fields }); } catch { /* diagnostics are best-effort */ }
  }

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
      terminationReason: this._terminationReason,
      autoExecutionId: this._autoExecutionId,
      stopReason: this._stopReason,
      stopOdd: this._stopOdd,
      recoveryCount: this._recoveryCount,
      pausedForRecovery: this._pausedForRecovery,
      liveness: this.liveness(),
      pendingBet: this._pendingBet ? { sid: this._pendingBet.sid, delayMs: this._pendingBet.delayMs } : null,
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
  // opts.resumeExecutionId + opts.recoveryCount let a recovery continuation preserve the
  // SAME Auto execution identity (§2/§7) instead of minting a new one on reload/reconnect.
  start(targetId, cfg, opts = {}) {
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
    this._terminationReason = null;
    const resuming = opts && opts.resumeExecutionId;
    this._autoExecutionId = resuming ? String(opts.resumeExecutionId) : this._newExecId();
    this._recoveryCount = resuming && Number.isFinite(Number(opts.recoveryCount)) ? Number(opts.recoveryCount) : 0;
    this._startedAtMs = this._wallNow();
    this._executionFinalized = false;
    this._pausedForRecovery = false;
    this._stopReason = null;
    this._stopOdd = null; this._stopOddObservedAt = null; this._stopOddSid = null; this._stopOddSource = null;
    this._errorCode = null;
    this._cancelPendingBet('AUTO_TERMINATED');
    this._state = STATE.WAITING_ROUND;
    this._diagLog('INFO', 'AUTO_RUNNER', resuming ? 'AUTO_RESUME' : 'AUTO_START', { targetId: this._targetId, roundCount: this._config.roundCount, betDelayMaxMs: this._config.betDelayMaxMs, resumed: !!resuming });
    this._emit();
    return { ok: true, state: this._state, config: this._config, autoExecutionId: this._autoExecutionId, environment: { host: env.host, allowed: true } };
  }

  // stop(meta) — meta.reason lets a session kill switch (e.g. Stop-1000x) record a
  // distinct terminal reason. Absent meta, this is a normal manual Stop. Behavior is
  // otherwise unchanged: no cashout is sent just because the session stopped (§21).
  stop(meta = {}) {
    if (!this._running) return { error: { code: 'AUTO_TEST_NOT_RUNNING', message: 'No test run is active' } };
    const internalReason = (meta && meta.reason) || 'MANUAL';
    const isRecoveryPause = internalReason === 'SESSION_RECOVERY';
    // Capture the authoritative ODD at the stop DECISION point BEFORE we tear down
    // (§15/§16). A non-manual stop must not lose this evidence.
    this._captureStopOdd();
    // Cancel any pending next-round delayed bet before invalidating state (§44/§47).
    this._cancelPendingBet(isRecoveryPause ? 'SESSION_RECOVERY' : (internalReason === 'MANUAL' ? 'USER_STOP' : internalReason));
    this._running = false;
    this._terminationReason = internalReason;
    // Do NOT send a cashout just because the user stopped (§21). Finalize an
    // in-flight watched round as STOPPED only if it had not already committed.
    if (this._active && !this._active._cashoutSent && this._active.result == null) {
      this._finalize(this._active, RESULT.STOPPED);
    }
    this._state = STATE.STOPPED;
    if (isRecoveryPause) {
      // A recovery PAUSE is NOT a terminal execution (§7/§20). Keep the execution id,
      // count the interruption, and DO NOT emit a terminal History row.
      this._recoveryCount += 1;
      this._lastRecoveryReason = 'SESSION_RECOVERY';
      this._pausedForRecovery = true;
      this._diagLog('WARN', 'AUTO_RUNNER', 'AUTO_PAUSED', { reason: 'SESSION_RECOVERY', recoveryCount: this._recoveryCount });
    } else {
      this._finalizeExecution(internalReason, { errorCode: meta && meta.errorCode });
    }
    this._emit();
    return { ok: true, state: this._state };
  }

  // Stop-1000x TAKE-PROFIT stop. Unlike a plain stop(), if the current round still has an
  // OPEN server-accepted bet (not yet cashed out), this CASHES IT OUT at the 1000x odd to
  // secure the win, and terminates the session only once that cashout resolves — recording
  // its authoritative result (ACK -> WIN, timeout/failure -> UNKNOWN; never fabricated).
  // If the round was already cashed out at stopOdd (or we are between rounds), there is
  // nothing to close, so this is a plain terminal stop (no wager sent). Exactly-once: the
  // guard's fired-latch + the _cashoutSent flag prevent any duplicate cashout.
  stopAt1000x(meta = {}) {
    if (!this._running) return { error: { code: 'AUTO_TEST_NOT_RUNNING', message: 'No test run is active' } };
    const reason = 'STOPPED_1000X_REACHED';
    const r = this._active;
    const cur = this._observer && this._observer.currentRound ? this._observer.currentRound() : null;
    const openBet = r && r.betResult === 'ACK' && !r._cashoutSent && r.result == null
      && cur && String(cur.sid) === String(r.sid) && cur.currentOdd != null;
    if (openBet) {
      // Arm the terminal-after-cashout latch, then send the cashout at the authoritative odd.
      this._pendingStopMeta = { reason, errorCode: (meta && meta.errorCode) || null };
      r._cashoutSent = true;
      r.triggerOdd = cur.currentOdd;                 // authoritative 1000x odd that triggered (§16)
      r.triggerAtMono = this._now();
      this._diagLog('WARN', 'CASHOUT', 'STOP_1000X_CASHOUT', { sid: r.sid, odd: r.triggerOdd });
      this._state = STATE.CASHOUT_SENDING; this._emit();
      this._sendCashout(r);
      return { ok: true, cashout: true };
    }
    // No open bet to secure → plain terminal stop (also cancels any pending next-round bet).
    return this.stop({ reason, errorCode: meta && meta.errorCode });
  }

  // Public terminal finalize for host-driven terminal conditions the runner can't
  // observe itself (RECOVERY_FAILED, RUN_CLOSED, APP_CLOSED, terminal LOGIN_REQUIRED,
  // LICENSE_BLOCKED). Idempotent; captures the authoritative stopOdd if still valid.
  finalizeExecution(reason, meta = {}) {
    if (this._executionFinalized) return { ok: true, alreadyFinalized: true };
    if (this._autoExecutionId == null) return { error: { code: 'AUTO_NO_EXECUTION', message: 'No Auto execution to finalize' } };
    this._captureStopOdd();
    this._cancelPendingBet(reason);
    this._running = false;
    this._terminationReason = reason;
    this._pausedForRecovery = false;
    if (this._state !== STATE.COMPLETED) this._state = STATE.STOPPED;
    this._finalizeExecution(reason, meta);
    this._emit();
    return { ok: true };
  }

  // Read the authoritative current ODD from the owning RoundObserver ONLY (§16). Never
  // renderer/DOM/cached/invented. Freshness (§17): the observed round must be non-terminal
  // and — when a round is actively being played — must match the active SID.
  _captureStopOdd() {
    if (this._stopOdd != null) return; // already captured for this terminal decision
    const cur = this._observer && this._observer.currentRound ? this._observer.currentRound() : null;
    if (!cur || cur.currentOdd == null || !Number.isFinite(Number(cur.currentOdd))) return;
    if (cur.terminalReason != null) return;                         // stale: round already ended
    if (this._active && String(cur.sid) !== String(this._active.sid)) return; // odd for a different round
    this._stopOdd = Number(cur.currentOdd);
    this._stopOddObservedAt = this._wallNow();
    this._stopOddSid = cur.sid;
    this._stopOddSource = 'ROUND_OBSERVER';
  }

  _finalizeExecution(internalReason, meta = {}) {
    if (this._executionFinalized) return;
    this._executionFinalized = true;
    this._stopReason = normalizeStopReason(internalReason);
    if (meta && meta.errorCode) this._errorCode = String(meta.errorCode);
    const rec = this.executionRecord();
    this._diagLog('INFO', 'AUTO_RUNNER', 'EXECUTION_FINALIZED', { stopReason: rec.stopReason, stopOdd: rec.stopOdd, roundsCompleted: rec.roundsCompleted, recoveryCount: rec.recoveryCount });
    // Additive seam consumed by the host to persist Auto EXECUTION History (§13/§21).
    this.emit('executionFinalized', rec);
  }

  // The terminal Auto EXECUTION record (§21). browserId/runId are attributed by the
  // host collector (structural ownership, never UI selection).
  executionRecord() {
    const roundsCompleted = this._history.filter((r) => r.result === RESULT.COMPLETED).length;
    const lastRound = this._history.length ? this._history[this._history.length - 1] : null;
    const lastSid = this._active ? this._active.sid : (this._stopOddSid != null ? this._stopOddSid : (lastRound ? lastRound.sid : null));
    return {
      autoExecutionId: this._autoExecutionId,
      startedAt: this._startedAtMs != null ? new Date(this._startedAtMs).toISOString() : null,
      endedAt: new Date(this._wallNow()).toISOString(),
      stopReason: this._stopReason,
      terminationReason: this._terminationReason,
      roundsRequested: this._config ? this._config.roundCount : null,
      roundsCompleted,
      betAmount: this._config ? this._config.amount : null,
      configuredStopOdd: this._config ? this._config.stopOdd : null,
      lastSid,
      stopOdd: this._stopOdd,
      stopOddObservedAt: this._stopOddObservedAt != null ? new Date(this._stopOddObservedAt).toISOString() : null,
      stopOddSid: this._stopOddSid,
      stopOddSource: this._stopOddSource,
      recoveryCount: this._recoveryCount,
      lastRecoveryReason: this._lastRecoveryReason,
      errorCode: this._errorCode,
    };
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
    // Exception boundary (§8): a runner exception must NEVER be swallowed to console
    // and silently kill the execution. It is logged, surfaced, and turned into an
    // explainable terminal AUTO_ERROR carrying the authoritative stopOdd (§56).
    try { this._onFrameInner(ev); }
    catch (e) { this._onUnhandled(e, 'onFrame'); }
  }

  _onUnhandled(e, where) {
    this._diagLog('ERROR', 'AUTO_RUNNER', 'UNHANDLED_AUTO_EXCEPTION', {
      where, errorName: e && e.name, message: String(e && e.message || e), stack: safeStack(e),
    });
    this.emit('autoException', { where, name: e && e.name, message: String(e && e.message || e) });
    if (this._running) {
      try { this.stop({ reason: 'AUTO_ERROR', errorCode: 'UNHANDLED_AUTO_EXCEPTION' }); } catch { /* terminal best-effort */ }
    }
  }

  _onFrameInner(ev) {
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
    if (sid == null) return;
    // Part E — delayed-bet routing. In the between-rounds delay states the next
    // authoritative ROUND_OPEN starts the random-delay timer instead of an immediate bet.
    if (this._state === STATE.WAITING_NEXT_ROUND) { this._scheduleDelayedBet(sid); return; }
    if (this._state === STATE.WAITING_NEXT_BET_DELAY) {
      // A ROUND_OPEN arrived while a delay is pending. Same sid = duplicate (ignore, §51).
      // Different sid = the scheduled round changed → cancel and reschedule for the new
      // round; never let the old timer fire a stale bet into the new sid (§45).
      if (this._pendingBet && String(sid) === String(this._pendingBet.sid)) return;
      this._cancelPendingBet('ROUND_CHANGED');
      this._scheduleDelayedBet(sid);
      return;
    }
    if (this._state !== STATE.WAITING_ROUND) return;
    this._beginBetForSid(sid);
  }

  // Create the active round for `sid` and send its bet. Shared by the immediate path
  // (first round) and the delayed fire path. Enforces the target cap + per-sid dedup
  // (§10/§51): at most one automatic BET per eligible round.
  _beginBetForSid(sid) {
    if (this._attempted >= this._config.roundCount) return false;
    if (this._usedSids.has(String(sid))) return false; // duplicate 100005 for same sid -> no duplicate bet
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
    this._diagLog('INFO', 'BET', 'BET_INTENT', { sid });
    this._state = STATE.BET_SENDING;
    this._emit();
    this._sendBet(this._active);
    return true;
  }

  // ---- Part D/E: next-round random BET delay ----
  _computeDelayMs() {
    const min = this._config.betDelayMinMs || 0;
    const max = this._config.betDelayMaxMs || 0;
    if (max <= 0) return 0;
    const span = max - min;
    const d = min + Math.floor(this._random() * (span + 1));
    return Math.max(min, Math.min(max, d));
  }

  // Schedule a delayed BET pinned to EXACTLY this authoritative round (§42). The old
  // round already finished; this is the NEXT ROUND_OPEN, so the timer starts here —
  // never from the CASHOUT send (§40).
  _scheduleDelayedBet(sid) {
    if (!this._running) return;
    if (this._attempted >= this._config.roundCount) return;
    if (this._usedSids.has(String(sid))) return;    // already played this sid (§51)
    const token = ++this._betScheduleSeq;
    const delayMs = this._computeDelayMs();
    const scheduledAtMono = this._now();
    const handle = this._scheduler.setTimeout(() => this._fireDelayedBet(token), delayMs);
    this._pendingBet = { token, sid, delayMs, scheduledAtMono, handle };
    this._state = STATE.WAITING_NEXT_BET_DELAY;
    this._diagLog('INFO', 'BET', 'NEXT_BET_DELAY_SCHEDULED', { sid, delayMs });
    this._emit();
  }

  _cancelPendingBet(reason) {
    if (!this._pendingBet) return;
    const p = this._pendingBet;
    this._pendingBet = null;
    try { this._scheduler.clearTimeout(p.handle); } catch { /* best effort */ }
    this._diagLog('INFO', 'BET', 'NEXT_BET_DELAY_CANCELLED', { sid: p.sid, delayMs: p.delayMs, reason: reason || 'CANCELLED' });
  }

  _fireDelayedBet(token) {
    try {
      const p = this._pendingBet;
      if (!p || p.token !== token) return;            // superseded/cancelled timer
      if (!this._running || this._state !== STATE.WAITING_NEXT_BET_DELAY) { this._cancelPendingBet('AUTO_TERMINATED'); return; }
      // Revalidate against authoritative runtime BEFORE sending (§43). The scheduled
      // round must still be the current, bet-eligible (OPEN) round on this run.
      const cur = this._observer && this._observer.currentRound ? this._observer.currentRound() : null;
      if (!cur || cur.terminalReason != null) { this._cancelPendingBet('ROUND_LOCKED'); this._state = STATE.WAITING_NEXT_ROUND; return; }
      if (String(cur.sid) !== String(p.sid)) { this._cancelPendingBet('ROUND_CHANGED'); this._state = STATE.WAITING_NEXT_ROUND; return; }
      if (cur.phase !== 'OPEN') { this._cancelPendingBet('ROUND_LOCKED'); this._state = STATE.WAITING_NEXT_ROUND; return; }
      const sid = p.sid;
      this._pendingBet = null;
      this._diagLog('INFO', 'BET', 'NEXT_BET_DELAY_FIRED', { sid, delayMs: p.delayMs });
      this._beginBetForSid(sid);
    } catch (e) { this._onUnhandled(e, 'fireDelayedBet'); }
  }

  async _sendBet(round) {
    round._betSentMono = this._now();
    this._state = STATE.WAITING_BET_ACK; this._emit();
    this._diagLog('INFO', 'BET', 'BET_SEND_ATTEMPT', { sid: round.sid, amount: this._config.amount });
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
    // BET send/ACK diagnostics (§32). An unresolved ACK (TIMEOUT) is UNKNOWN in-flight,
    // never fabricated as a failure/loss (§33).
    if (res.result === 'ACK') this._diagLog('INFO', 'BET', 'BET_ACK', { sid: round.sid, acceptedBet: round.betAckAmount, latencyMs: round.betLatencyMs });
    else if (res.result === 'TIMEOUT') this._diagLog('WARN', 'BET', 'BET_ACK_TIMEOUT', { sid: round.sid, actionResult: 'UNKNOWN' });
    else this._diagLog('WARN', 'BET', 'BET_SEND_FAILED', { sid: round.sid, result: res.result });
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
    this._diagLog('INFO', 'CASHOUT', 'CASHOUT_SEND_ATTEMPT', { sid: round.sid, triggerOdd: round.triggerOdd });
    let res;
    try { res = await this._harness.execute({ targetId: this._targetId, command: 'cashout', overrides: { aid: this._config.aid, eid: this._config.eid }, source: 'AUTO_TEST' }); }
    catch (e) { res = { result: 'ERROR', error: { code: 'ERROR', message: String(e && e.message || e) } }; }
    if (this._active !== round) return;
    round.cashoutLatencyMs = round1(this._now() - round._cashoutSentMono);
    if (res.result === 'ACK') this._diagLog('INFO', 'CASHOUT', 'CASHOUT_ACK', { sid: round.sid, odd: res.responsePayload ? res.responsePayload.odd : null });
    else if (res.result === 'TIMEOUT') this._diagLog('WARN', 'CASHOUT', 'CASHOUT_ACK_TIMEOUT', { sid: round.sid, actionResult: 'UNKNOWN' });
    else this._diagLog('WARN', 'CASHOUT', 'CASHOUT_SEND_FAILED', { sid: round.sid, result: res.result });
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
    // Stop-1000x take-profit: the 1000x cashout just resolved (with `result`). Terminate the
    // session now instead of continuing — the round's own authoritative result is already
    // recorded by _finalize; the session closes with the STOP_1000X reason + stopOdd.
    if (this._pendingStopMeta) {
      const meta = this._pendingStopMeta; this._pendingStopMeta = null;
      this._running = false;
      this._terminationReason = meta.reason;
      this._state = STATE.STOPPED;
      this._captureStopOdd();
      this._finalizeExecution(meta.reason, { errorCode: meta.errorCode });
      return;
    }
    if (!this._running) { this._state = STATE.STOPPED; return; }
    // Part E — when the next-round delay is enabled, the NEXT bet must wait for the
    // authoritative next ROUND_OPEN (not fire immediately). WAITING_NEXT_ROUND owns that.
    const nextState = this._config.nextRoundBetDelay ? STATE.WAITING_NEXT_ROUND : STATE.WAITING_ROUND;
    if (result === RESULT.COMPLETED) {
      this._attempted = 0;
      this._state = nextState;
      return;
    }
    if (this._attempted >= this._config.roundCount) {
      this._running = false; this._terminationReason = 'COMPLETED'; this._state = STATE.COMPLETED;
      this._finalizeExecution('COMPLETED');
      return;
    }
    this._state = nextState;          // wait for the next server 100005 (§19)
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

function safeStack(e) {
  const s = e && e.stack ? String(e.stack) : '';
  return s.split('\n').slice(0, 6).join('\n');
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

module.exports = { AutoRunner, validateConfig, autoHostAllowed, STATE, RESULT, STOP_REASON, normalizeStopReason, ACTIVE_STATES, LOCAL_HOSTS, LOCAL_SUFFIXES, localDayKey };
