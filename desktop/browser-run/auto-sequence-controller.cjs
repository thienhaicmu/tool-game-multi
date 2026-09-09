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
    // stopExecution(reason) => cleanly terminates the CURRENTLY running AutoRunner execution
    // with a semantic terminal reason (used only by the WIN reset, before launching row 0). It
    // must NOT fabricate a losing round result — the winning ROUND is already COMPLETED in history.
    this._stopExecution = typeof deps.stopExecution === 'function' ? deps.stopExecution : () => {};
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
    // WIN-RESET (§WIN) — an authoritative round WIN (RESULT.COMPLETED) in the CURRENT LƯỢT
    // resets the sequence to row 0. These track the identity/idempotency the reset needs:
    this._currentExecId = null;  // autoExecutionId of the row currently executing (set on each start)
    this._winHandledIds = new Set();  // winning execution ids already turned into a reset (dedup, §5)
    this._winConsumedIds = new Set(); // executions terminated BY a win reset — their terminal
                                      // executionFinalized must never advance/stop the sequence (§6/§7)
  }

  isRunning() { return this._running; }
  index() { return this._index; }
  total() { return this._rows.length; }
  ownerRunId() { return this._ownerRunId; }

  // Serialisable view merged into the Auto snapshot for the renderer status
  // ("Đang chạy lượt index+1 / total"). Display-only; never an authority.
  snapshot() {
    // roundCount = the CURRENT Level's (current row's) configured Số vòng, so the renderer's
    // "Vòng: x/roundCount - Level N" denominator always tracks the active Level and never shows
    // a stale previous-Level total across a transition. Display-only; never an authority.
    const cur = this._rows[this._index];
    return {
      active: this._running,
      index: this._index,
      total: this._rows.length,
      roundCount: cur && cur.roundCount != null ? cur.roundCount : null,
      ownerRunId: this._ownerRunId,
    };
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
    this._winHandledIds = new Set();
    this._winConsumedIds = new Set();
    this._currentExecId = null;
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
    } else if (res && res.autoExecutionId != null) {
      this._currentExecId = String(res.autoExecutionId);
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
    // §6/§7 — a terminal record for an execution ALREADY consumed by a WIN reset must never
    // advance NOR stop the sequence. This covers both the SEQUENCE_WIN_RESET finalize we trigger
    // ourselves and any late/stale finalize (even a ROUND_TARGET_COMPLETED) from that old
    // execution arriving after the reset already moved us to row 0.
    if (id != null && this._winConsumedIds.has(id)) {
      this._log('INFO', 'AUTO_SEQUENCE_WIN_STALE_FINALIZE_IGNORED', { reason: reason == null ? null : String(reason), execId: id });
      return;
    }
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
    } else if (res && res.autoExecutionId != null) {
      this._currentExecId = String(res.autoExecutionId);
    }
  }

  // React to an authoritative round WIN inside the CURRENT LƯỢT. The host wires this to the
  // AutoRunner `roundFinalized` seam, filtered to result === RESULT.COMPLETED (the existing cashout-
  // ACK evidence path) — the controller NEVER parses protocol frames. A WIN resets the sequence to
  // LƯỢT 1 / index 0 and launches it as a NEW execution. `rec.autoExecutionId` is the WINNING row's
  // execution id (captured by the host at emit time) and is the identity used for §5/§6/§7 safety.
  onRoundWin(rec) {
    if (!this._running) return;                        // §8 — STOP already ended the sequence
    const id = rec && rec.autoExecutionId != null ? String(rec.autoExecutionId) : null;
    // §6 — the win must belong to the row CURRENTLY executing. A late win from an already-superseded
    // execution (e.g. after we already reset to a new LƯỢT 1) is ignored — it cannot reset again.
    if (id != null && this._currentExecId != null && id !== this._currentExecId) {
      this._log('INFO', 'AUTO_SEQUENCE_WIN_STALE_IGNORED', { winExecId: id, currentExecId: this._currentExecId });
      return;
    }
    // §5 — exactly ONE reset per winning execution. Duplicate WIN emits for the same execution
    // (duplicate qualifying frames / re-entrant emits) collapse to a single LƯỢT 1 start.
    if (id != null) {
      if (this._winHandledIds.has(id)) return;
      this._winHandledIds.add(id);
      // §6/§7 — the winning execution's own terminal finalize (and any late/stale finalize from it)
      // must NOT advance or stop the sequence once the win has been consumed here.
      this._winConsumedIds.add(id);
    }
    // §7/§8 — bump the generation so any queued normal advance (or a concurrent STOP's guard) is
    // superseded by this reset, and cancel the pending next-row timer.
    this._generation += 1;
    this._clearPending();
    this._index = 0;                                   // reset LƯỢT → row 0 (the reset target)
    const gen = this._generation;
    this._log('INFO', 'AUTO_SEQUENCE_WIN_RESET', { winExecId: id, index: 0, total: this._rows.length });
    // §4 — defer the stop+restart to the next tick. `roundFinalized` fires while AutoRunner is still
    // unwinding its own _finalize/_afterRound stack; re-entering stop/start now would corrupt it. The
    // same scheduler seam the normal advance uses guarantees the win finalization completes first.
    this._pending = this._scheduler.setTimeout(() => this._fireWinReset(gen), 0);
  }

  async _fireWinReset(gen) {
    this._pending = null;
    if (gen !== this._generation) return;              // superseded by stop()/start()/another win
    if (!this._running) return;                        // §8 — STOP won the race
    if (!this._isRunValid()) { this.stop('RUN_INVALID'); return; }
    // Cleanly END the winning execution with a semantic terminal reason (never a fabricated loss).
    // Its executionFinalized is ignored via _winConsumedIds, so it neither advances nor stops us.
    try { this._stopExecution('SEQUENCE_WIN_RESET'); }
    catch (e) { this._log('WARN', 'AUTO_SEQUENCE_WIN_STOP_FAILED', { message: String(e && e.message || e) }); }
    if (gen !== this._generation) return;              // a STOP could land during the synchronous stop
    if (!this._running) return;
    const cfg = this._rows[0];
    this._log('INFO', 'AUTO_SEQUENCE_WIN_NEXT', { index: 0, total: this._rows.length });
    let res;
    // A genuinely NEW execution for LƯỢT 1 (first: false → never resumes the winning id; a fresh
    // autoExecutionId is minted). old winning id A != new LƯỢT 1 id B.
    try { res = await this._startExecution(cfg, { first: false }); }
    catch (e) { res = { error: { code: 'AUTO_SEQUENCE_WIN_START_EXCEPTION', message: String(e && e.message || e) } }; }
    if (gen !== this._generation) return;              // stopped while awaiting the async start
    if (res && res.error) {
      this._log('WARN', 'AUTO_SEQUENCE_WIN_START_FAILED', { errorCode: res.error.code });
      this.stop('WIN_START_FAILED');
    } else if (res && res.autoExecutionId != null) {
      this._currentExecId = String(res.autoExecutionId);
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
