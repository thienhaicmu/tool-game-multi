'use strict';

// ---------------------------------------------------------------------------
// AutoSequenceController — WU-AUTO-SEQUENCE.
//
// Per-BrowserRun owner of a user-defined MULTI-ROW Auto Run sequence. The user adds
// N config rows in the Auto panel; pressing START runs each row as its OWN AutoRunner
// execution (a NEW autoExecutionId), in display order, EXACTLY ONCE each, then stops.
// It NEVER loops back to row 1 and NEVER repeats a row — N is the user's row count,
// nothing is hardcoded.
//
// AutoRunner still owns exactly ONE execution (one start() == one autoExecutionId ==
// one lifecycle). This controller is a thin OUTER owner that decides ONLY whether to
// launch the NEXT row when the current execution finalizes NORMALLY (COMPLETED). It
// changes no round/BET/CASHOUT/roundCount semantics.
//
// Ownership is structural: the controller is bound at construction to ONE run's start
// orchestration (`startExecution`) and its `ownerRunId`. A renderer browser-selection
// change can therefore NEVER retarget an in-flight sequence to a different BrowserRun.
//
// Advancement is:
//   - gated on the NORMAL terminal reason only (ROUND_TARGET_COMPLETED); every other
//     terminal reason (USER_STOP / STOP_1000X / LOGIN_REQUIRED / RECOVERY_FAILED /
//     AUTO_ERROR / RUN_CLOSED / APP_CLOSED / LICENSE_BLOCKED / UNKNOWN) STOPS the
//     sequence. A SESSION_RECOVERY pause is NOT a finalize, so recovery never advances.
//   - idempotent per finalized autoExecutionId (a duplicate COMPLETED advances once).
//   - race-safe via a monotonically bumped generation token, so a user STOP after a
//     completion but before the queued next-row fire can never start the next row.
// ---------------------------------------------------------------------------

// The ONLY terminal reason that advances to the next row. Mirrors AutoRunner's
// normalizeStopReason('COMPLETED') === STOP_REASON.ROUND_TARGET_COMPLETED.
const CONTINUABLE_STOP_REASON = 'ROUND_TARGET_COMPLETED';

class AutoSequenceController {
  constructor(deps = {}) {
    // startExecution(config) => Promise<{ ok, autoExecutionId } | { error }>. Runs the
    // owning run's legitimate start orchestration (entry/login/jackpot gates + AutoRunner
    // .start) — the SAME path the first row uses. Never resumes (a NEW execution per row).
    this._startExecution = typeof deps.startExecution === 'function' ? deps.startExecution : async () => ({ error: { code: 'AUTO_SEQUENCE_NO_START', message: 'no start orchestration bound' } });
    this._isRunValid = typeof deps.isRunValid === 'function' ? deps.isRunValid : () => true;
    this._scheduler = deps.scheduler || { setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (h) => clearTimeout(h) };
    this._diag = deps.diag || null;
    this._ownerRunId = deps.ownerRunId != null ? String(deps.ownerRunId) : null;

    this._rows = [];              // immutable snapshot of the row configs at START
    this._index = 0;             // 0-based index of the row currently executing
    this._running = false;
    this._generation = 0;        // race guard: bumped on every start()/stop()
    this._advancedIds = new Set(); // idempotency: finalized ids already advanced/handled
    this._pending = null;        // scheduled next-row timer handle
    this._lastReason = null;
  }

  isRunning() { return this._running; }
  index() { return this._index; }
  total() { return this._rows.length; }
  ownerRunId() { return this._ownerRunId; }

  // Serialisable view merged into the Auto snapshot for the renderer status
  // ("Đang chạy lượt index+1 / total"). Display-only; never an authority.
  snapshot() {
    return { active: this._running, index: this._index, total: this._rows.length, ownerRunId: this._ownerRunId };
  }

  // Begin a sequence over an IMMUTABLE snapshot of `rows` (a defensive copy — later UI
  // edits/add/remove never mutate an in-flight sequence). Starts row 0 through the owning
  // run's start orchestration and returns its result verbatim, so the IPC caller surfaces
  // the SAME start errors a single-row start would (validation/login/entry/jackpot).
  async start(rows) {
    const snapshot = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
    if (snapshot.length === 0) return { error: { code: 'AUTO_SEQUENCE_EMPTY', message: 'No Auto Run rows configured' } };
    this._generation += 1;               // invalidate any prior pending advance
    this._clearPending();
    this._rows = snapshot;
    this._index = 0;
    this._running = true;
    this._advancedIds = new Set();
    this._lastReason = null;
    this._log('INFO', 'AUTO_SEQUENCE_START', { total: this._rows.length, ownerRunId: this._ownerRunId });
    // `first: true` lets the host keep the existing recovery-resume continuity for the FIRST
    // row only (a re-START while paused resumes the SAME execution id, §11). Every subsequent
    // row is unconditionally a NEW execution.
    const res = await this._startExecution(this._rows[0], { first: true });
    if (res && res.error) {
      // Row 0 never started → the sequence never began. Surface the error to the caller.
      this._running = false;
      this._rows = [];
      this._log('WARN', 'AUTO_SEQUENCE_START_FAILED', { errorCode: res.error.code });
    }
    return res;
  }

  // Terminate the WHOLE sequence (user STOP, dispose, hard stop). Idempotent. Bumps the
  // generation so any queued next-row advance becomes a no-op — race-safe against a STOP
  // pressed after a completion but before the next row actually starts.
  stop(reason) {
    this._running = false;
    this._generation += 1;
    this._clearPending();
    this._lastReason = reason || 'STOP';
    this._log('INFO', 'AUTO_SEQUENCE_STOP', { reason: this._lastReason, index: this._index, total: this._rows.length });
    return { ok: true };
  }

  // React to an AutoRunner terminal EXECUTION (the host wires this to `executionFinalized`).
  // Only a NORMAL completion advances to the next row; any other terminal reason stops the
  // sequence. Advances EXACTLY once per unique finalized autoExecutionId.
  onExecutionFinalized(rec) {
    if (!this._running) return;
    const id = rec && rec.autoExecutionId != null ? String(rec.autoExecutionId) : null;
    const reason = rec && rec.stopReason;
    if (reason !== CONTINUABLE_STOP_REASON) {
      // Hard stop / user stop / recovery-failed / login / error → do NOT advance.
      this._log('INFO', 'AUTO_SEQUENCE_HALT', { reason: reason == null ? null : String(reason), index: this._index });
      this.stop(reason == null ? 'NON_CONTINUABLE' : String(reason));
      return;
    }
    if (id != null) {
      if (this._advancedIds.has(id)) return;   // duplicate COMPLETED — advance once only
      this._advancedIds.add(id);
    }
    const nextIndex = this._index + 1;
    if (nextIndex >= this._rows.length) {
      // Final row completed — sequence done. Never loops back to row 0.
      this._running = false;
      this._log('INFO', 'AUTO_SEQUENCE_COMPLETE', { total: this._rows.length });
      return;
    }
    if (!this._isRunValid()) { this.stop('RUN_INVALID'); return; }
    this._index = nextIndex;
    const gen = this._generation;
    // Defer to the next tick — never a synchronous start() re-entry from inside the
    // finalize emit (no tight restart loop). The next row still waits for a real
    // authoritative ROUND_OPEN inside AutoRunner; no SID is fabricated here.
    this._pending = this._scheduler.setTimeout(() => this._fireNext(gen), 0);
  }

  async _fireNext(gen) {
    this._pending = null;
    if (gen !== this._generation) return;      // superseded by stop()/start()
    if (!this._running) return;
    if (!this._isRunValid()) { this.stop('RUN_INVALID'); return; }
    const cfg = this._rows[this._index];
    this._log('INFO', 'AUTO_SEQUENCE_NEXT', { index: this._index, total: this._rows.length });
    let res;
    try { res = await this._startExecution(cfg, { first: false }); }
    catch (e) { res = { error: { code: 'AUTO_SEQUENCE_START_EXCEPTION', message: String(e && e.message || e) } }; }
    if (gen !== this._generation) return;       // stopped while awaiting the async start
    if (res && res.error) {
      this._log('WARN', 'AUTO_SEQUENCE_NEXT_FAILED', { index: this._index, errorCode: res.error.code });
      this.stop('NEXT_START_FAILED');
    }
  }

  _clearPending() {
    if (!this._pending) return;
    try { this._scheduler.clearTimeout(this._pending); } catch { /* best effort */ }
    this._pending = null;
  }

  _log(level, event, fields) {
    if (!this._diag || !this._diag.log) return;
    try { this._diag.log({ level, category: 'AUTO_SEQUENCE', event, ...fields }); } catch { /* diagnostics are best-effort */ }
  }
}

module.exports = { AutoSequenceController, CONTINUABLE_STOP_REASON };
