// WU-RELOAD-REENTER-RESUME — end-to-end acceptance for the recovery fallback:
//
//   ACTIVE_AUTO → AVIATOR_CONTEXT_LOST → SUSPEND → TRY DIRECT RE-ENTRY (bounded)
//     → (fail) ESCALATE → RELOAD PAGE → WAIT PAGE/COCOS READY → RE-ENTER AVIATOR
//     → WAIT FRESH SERVER ACTIVE → RESUME THE SAME AUTO (exactly once)
//
// The individual legs are proven in wu-aviator-context / wu-session-recovery /
// wu-context-control-wiring. What was missing is a test that STITCHES the two owners
// together the way main.cjs wires them, and asserts the cross-tier invariants
// (RELOAD_COUNT / COCOS_ENTRY_COUNT / AUTO_RESUME_COUNT, same executionId, same Level,
// STOP-wins, multi-browser isolation, long-run stability).
//
// This harness drives the REAL pure state machines (no Electron). It mirrors the
// main.cjs wiring exactly:
//   - recoveryTick(): latch intent when paused-for-recovery, gather evidence, tick the
//     SessionRecoveryWatchdog, actuate its actions.
//   - aviatorContextTick(): ONLY while the watchdog is HEALTHY (§3 no competition).
//   - CTX ESCALATE_FULL_RECOVERY hands off by marking the socket lost (wsConnected=false)
//     and resetting the context tracker — exactly as applyAviatorContextAction does.
//   - resumePausedAuto() refuses anything that is not a genuine SESSION_RECOVERY pause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AviatorContextTracker, ACTION: CTX_ACTION } = require('../../desktop/protocol/aviator-context.cjs');
const { SessionRecoveryWatchdog, ACTION: WD_ACTION } = require('../../desktop/browser-run/session-recovery.cjs');

// Deterministic small windows (mirrors the OBSERVATORY_RECOVERY_FAST profile in spirit).
const CTX_CFG = { freshMs: 1000, verifyWindowMs: 300, maxReentryAttempts: 3 };
const WD_CFG = { suspectNoAviatorMs: 1000, verifyWindowMs: 300, waitPageMs: 800, waitAviatorMs: 800, maxAttempts: 3, retryDelayMs: 200 };
const STEP = 50;               // pump increment (ms)
const PAGE_LOAD_DELAY = 150;   // after RELOAD/NAVIGATE the page finishes loading + WS reconnects
const ENTRY_EVIDENCE_DELAY = 150; // after a Cocos entry, fresh authoritative Aviator evidence arrives
const ENTRY_TIMEOUT = 100;     // a light re-entry that will NOT recover settles (no fresh evidence)

// Mock AutoRunner: preserves the SAME executionId + Level across a recovery pause/resume.
function makeRunner(execId, level) {
  return {
    _execId: execId, _level: level, _running: true, _paused: false, _resumeCount: 0, _startCount: 0,
    isRunning() { return this._running; },
    pausedForRecovery() { return this._paused; },
    autoExecutionId() { return this._execId; },
    level() { return this._level; },
    // Only a SESSION_RECOVERY stop is a resumable pause; a manual stop is terminal (§3/§23).
    stop({ reason } = {}) { this._running = false; this._paused = reason === 'SESSION_RECOVERY'; },
    // Resume reuses the SAME executionId (resumeExecutionId seam). A changed id is a defect.
    resume(execId) {
      if (execId !== this._execId) throw new Error(`executionId changed on resume: ${execId} != ${this._execId}`);
      this._running = true; this._paused = false; this._resumeCount += 1; this._startCount += 1;
    },
  };
}

class RecoveryRun {
  constructor(opts = {}) {
    this.id = opts.id || 'B1';
    this.now = 0;
    // Browser/session evidence.
    this.wsConnected = true;
    this.rendererAlive = true;
    this.onConfiguredHost = true;
    this.loginDetected = false;
    this.lastAviatorMono = 0;        // last CLASSIFIED authoritative Aviator server frame
    this.pageLoadedMono = null;
    this.recoveryStartMono = null;
    this.autoIntentLatch = false;
    this.everConfirmedAviator = true;
    this.ctxReentryInFlight = false;
    this.ctxResumeAfterReentry = false;
    this.effects = [];               // simulated async browser/server responses: { at, fn }
    // Scenario knobs.
    this.directReentrySucceeds = opts.directReentrySucceeds === true; // light path recovers?
    this.reloadEntrySucceeds = opts.reloadEntrySucceeds !== false;    // reload path recovers?
    this.pageReloadable = opts.pageReloadable !== false;              // reload brings the page back?
    this.keepAlive = false;          // when true, every tick delivers a fresh Aviator frame (steady game)
    // Cross-tier invariant counters.
    this.counts = { directReentry: 0, reload: 0, cocosEntryAfterReload: 0, resume: 0 };
    this.runner = makeRunner(opts.execId || 'E1', opts.level != null ? opts.level : 2);
    this.ctx = new AviatorContextTracker({ config: CTX_CFG });
    this.wd = new SessionRecoveryWatchdog({ config: WD_CFG, isLocalEndpoint: () => true });
  }

  schedule(delay, fn) { this.effects.push({ at: this.now + delay, fn }); }
  _fireEffects() {
    if (!this.effects.length) return;
    const due = this.effects.filter((e) => e.at <= this.now);
    this.effects = this.effects.filter((e) => e.at > this.now);
    for (const e of due) e.fn();
  }

  // ONE simulated wiring pass (mirrors recoveryTick → aviatorContextTick order).
  tick() {
    this._fireEffects();
    if (this.keepAlive) this.lastAviatorMono = this.now; // steady live game (multi-browser B2)
    // §4 — a paused-for-recovery execution is still an active Auto INTENT.
    if (this.runner.isRunning() || this.runner.pausedForRecovery()) this.autoIntentLatch = true;
    const ev = this._evidence();
    const { actions } = this.wd.tick(ev);
    for (const a of actions) this._applyRecoveryAction(a, ev);
    // The context tracker runs ONLY while the watchdog is otherwise HEALTHY (§3).
    if (this.wd.state() === 'HEALTHY') this._ctxTick();
  }

  _evidence() {
    const started = this.recoveryStartMono;
    return {
      monoNow: this.now,
      autoIntent: this.runner.isRunning() || this.autoIntentLatch,
      inflightAckPending: false,
      // A silent lobby-kick leaves the RoundObserver NOT 'RUNNING' (Aviator rounds stopped), which is
      // exactly why the watchdog's AVIATOR_TRAFFIC_STALE detector "misses" it and the context tracker
      // owns direct re-entry FIRST (main.cjs §3). WS/renderer/login failures still drive the watchdog.
      observerStatus: 'IDLE',
      lastAviatorMono: this.lastAviatorMono,
      wsConnected: this.wsConnected !== false,
      rendererAlive: this.rendererAlive,
      onConfiguredHost: this.onConfiguredHost,
      loginDetected: this.loginDetected,
      instrumentationReady: started != null && this.pageLoadedMono != null && this.pageLoadedMono > started && this.wsConnected === true,
      freshAviatorSinceRecovery: started != null && this.lastAviatorMono != null && this.lastAviatorMono > started,
      workerLost: false,
    };
  }

  _applyRecoveryAction(action, ev) {
    switch (action) {
      case WD_ACTION.PAUSE_AUTOMATION:
        if (this.runner.isRunning()) this.runner.stop({ reason: 'SESSION_RECOVERY' });
        break;
      case WD_ACTION.INVALIDATE_STATE:
        this.wsConnected = false; this.lastAviatorMono = null;
        this.recoveryStartMono = ev.monoNow; this.pageLoadedMono = null;
        break;
      case WD_ACTION.RELOAD:
        this.counts.reload += 1;
        this.recoveryStartMono = ev.monoNow; this.pageLoadedMono = null;
        if (this.pageReloadable) this.schedule(PAGE_LOAD_DELAY, () => { this.pageLoadedMono = this.now; this.wsConnected = true; });
        break;
      case WD_ACTION.NAVIGATE_CONFIGURED:
        this.counts.reload += 1; // a navigate is the SAME single page-recovery cycle
        this.recoveryStartMono = ev.monoNow; this.pageLoadedMono = null;
        if (this.pageReloadable) this.schedule(PAGE_LOAD_DELAY, () => { this.pageLoadedMono = this.now; this.wsConnected = true; });
        break;
      case WD_ACTION.REENTER:
        // The existing sealed Cocos entry seam (ensureEntered) — one invocation per generation.
        this.counts.cocosEntryAfterReload += 1;
        if (this.reloadEntrySucceeds) this.schedule(ENTRY_EVIDENCE_DELAY, () => { this.lastAviatorMono = this.now; });
        break;
      case WD_ACTION.MARK_READY:
        break;
      case WD_ACTION.RESUME_AUTOMATION:
        this._resumePausedAuto();
        break;
      case WD_ACTION.REQUIRE_USER_ACTION:
        this.autoIntentLatch = false;
        break;
      default:
        break;
    }
  }

  _ctxTick() {
    const pageHealthy = this.rendererAlive && this.wsConnected !== false && !this.loginDetected;
    const hasIntent = this.everConfirmedAviator || this.runner.isRunning() || this.runner.pausedForRecovery() || this.ctxReentryInFlight;
    const ev = { now: this.now, lastAviatorMono: this.lastAviatorMono, pageHealthy, hasIntent, reentryInFlight: this.ctxReentryInFlight };
    const { actions } = this.ctx.tick(ev);
    for (const a of actions) this._applyCtxAction(a);
  }

  _applyCtxAction(action) {
    switch (action) {
      case CTX_ACTION.REENTER: {
        // Light re-entry: NO reload, NO protocol wipe. Suspend Auto, re-enter via the seam.
        this.counts.directReentry += 1;
        const wasRunning = this.runner.isRunning();
        if (wasRunning) this.runner.stop({ reason: 'SESSION_RECOVERY' });
        this.ctxReentryInFlight = true;
        this.ctxResumeAfterReentry = this.ctxResumeAfterReentry || wasRunning;
        if (this.directReentrySucceeds) {
          this.schedule(ENTRY_EVIDENCE_DELAY, () => {
            this.lastAviatorMono = this.now;         // fresh authoritative evidence → ACTIVE
            this.ctxReentryInFlight = false; this.ctx.reentryFinished();
            this._onAviatorReentered();
          });
        } else {
          this.schedule(ENTRY_TIMEOUT, () => { this.ctxReentryInFlight = false; this.ctx.reentryFinished(); });
        }
        break;
      }
      case CTX_ACTION.ESCALATE_FULL_RECOVERY:
        // Bounded light re-entry exhausted → hand off to the watchdog by marking the socket lost.
        this.wsConnected = false;
        this.ctxReentryInFlight = false;
        this.ctx.reset();
        break;
      default:
        break;
    }
  }

  // Light-path resume once fresh ACTIVE is confirmed after a direct re-entry.
  _onAviatorReentered() {
    if (!this.ctxResumeAfterReentry) return;
    this.ctxResumeAfterReentry = false;
    this._resumePausedAuto();
  }

  // The ONE resume seam. Refuses a non-recovery (manual) stop and a double-start (§10/§23).
  _resumePausedAuto() {
    this.autoIntentLatch = false;
    const ar = this.runner;
    if (!ar || ar.isRunning()) return;
    if (!ar.pausedForRecovery()) return; // manual STOP cleared the pause → never resurrect Auto
    this.counts.resume += 1;
    ar.resume(ar.autoExecutionId());
  }

  // A user STOP during recovery (mirrors autotest-stop): drop the pending resume intent and
  // make the pause terminal. Passive page recovery may still finish, but Auto stays stopped.
  userStop() {
    this.ctxResumeAfterReentry = false;
    this.autoIntentLatch = false;
    this.runner.stop();          // manual/terminal — pausedForRecovery() becomes false
    this.ctx.reset();
  }

  pump(ms) { const end = this.now + ms; while (this.now < end) { this.now += STEP; this.tick(); } }
  pumpUntil(pred, maxMs = 20000) {
    const end = this.now + maxMs;
    while (this.now < end) { this.now += STEP; this.tick(); if (pred()) return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------
// §20 — DIRECT RE-ENTRY SUCCESS: no reload, same execution resumes exactly once.
// ---------------------------------------------------------------------------

test('§20 direct re-entry succeeds → RELOAD_COUNT=0, AUTO_RESUME_COUNT=1, same execution', () => {
  const run = new RecoveryRun({ directReentrySucceeds: true, execId: 'E1', level: 2 });
  run.tick();                       // establish ACTIVE
  run.lastAviatorMono = run.now;    // fresh
  // Freeze the game (no more fresh frames) → context loss builds.
  const recovered = run.pumpUntil(() => run.counts.resume >= 1 && run.runner.isRunning(), 6000);
  assert.ok(recovered, 'the run recovered and resumed');
  assert.equal(run.counts.reload, 0, 'RELOAD_COUNT=0 — direct re-entry did NOT reload the page');
  assert.equal(run.counts.resume, 1, 'AUTO_RESUME_COUNT=1');
  assert.ok(run.counts.directReentry >= 1, 'the light re-entry path was used');
  assert.equal(run.runner.autoExecutionId(), 'E1', 'same executionId');
  assert.equal(run.runner.level(), 2, 'same Level');
  assert.equal(run.runner._resumeCount, 1, 'resumed exactly once');
});

// ---------------------------------------------------------------------------
// §21 — MAIN ACCEPTANCE: re-entry FAIL → RELOAD → re-enter → resume SAME execution.
// ---------------------------------------------------------------------------

test('§21 direct re-entry fails → escalate → RELOAD=1, COCOS_ENTRY=1, RESUME=1, execution E1 + Level preserved', () => {
  const run = new RecoveryRun({ directReentrySucceeds: false, reloadEntrySucceeds: true, execId: 'E1', level: 2 });
  run.tick();
  run.lastAviatorMono = run.now;
  const recovered = run.pumpUntil(() => run.counts.resume >= 1 && run.runner.isRunning(), 10000);
  assert.ok(recovered, 'recovered via the reload fallback');
  // Direct re-entry was tried FIRST and bounded before any reload.
  assert.equal(run.counts.directReentry, CTX_CFG.maxReentryAttempts, 'bounded direct re-entry attempts happened first');
  // Exactly one page-recovery cycle and one Cocos entry for the single failure generation.
  assert.equal(run.counts.reload, 1, 'RELOAD_COUNT=1');
  assert.equal(run.counts.cocosEntryAfterReload, 1, 'COCOS_ENTRY_COUNT=1 (one entry per generation)');
  assert.equal(run.counts.resume, 1, 'AUTO_RESUME_COUNT=1');
  // Same preserved execution — no new id, no Level reset, resumed exactly once (no duplicate START).
  assert.equal(run.runner.autoExecutionId(), 'E1', 'executionId after = E1');
  assert.equal(run.runner.level(), 2, 'Level after = Level before');
  assert.equal(run.runner._resumeCount, 1, 'no duplicate resume/START');
  run.pump(STEP * 3); // READY → HEALTHY settle once WS/renderer/host are steady again
  assert.equal(run.wd.state(), 'HEALTHY', 'watchdog settled back to steady-state monitoring');
});

// ---------------------------------------------------------------------------
// §22 — RELOAD ENTRY FAILS: bounded → RECOVERY_FAILED, Auto does not resume.
// ---------------------------------------------------------------------------

test('§22 reload succeeds but Cocos entry never yields fresh evidence → RECOVERY_FAILED, no resume, bounded', () => {
  const run = new RecoveryRun({ directReentrySucceeds: false, reloadEntrySucceeds: false, execId: 'E1', level: 2 });
  run.tick();
  run.lastAviatorMono = run.now;
  const failed = run.pumpUntil(() => run.wd.state() === 'RECOVERY_FAILED', 15000);
  assert.ok(failed, 'terminal RECOVERY_FAILED reached');
  assert.equal(run.counts.resume, 0, 'Auto never resumed');
  assert.equal(run.runner.isRunning(), false, 'Auto stays stopped');
  // Bounded: never more page-recovery cycles than maxAttempts (no infinite reload loop).
  assert.ok(run.counts.reload <= WD_CFG.maxAttempts, `reload cycles bounded by maxAttempts (${run.counts.reload})`);
  // Idempotent terminal: pumping further neither resumes nor reloads again.
  const reloadAtFail = run.counts.reload;
  run.pump(4000);
  assert.equal(run.counts.resume, 0, 'still no resume after terminal failure');
  assert.equal(run.counts.reload, reloadAtFail, 'no further reloads after RECOVERY_FAILED');
});

// ---------------------------------------------------------------------------
// §23 — STOP DURING RELOAD: page later recovers, but Auto must NOT restart.
// ---------------------------------------------------------------------------

test('§23 user STOP while reload is in flight → page recovers but AUTO_RESUME_COUNT=0', () => {
  const run = new RecoveryRun({ directReentrySucceeds: false, reloadEntrySucceeds: true, execId: 'E1', level: 2 });
  run.tick();
  run.lastAviatorMono = run.now;
  // Pump until the watchdog has issued the reload and is waiting for the page.
  const reloading = run.pumpUntil(() => run.counts.reload >= 1, 8000);
  assert.ok(reloading, 'reached the reload/WAITING_PAGE phase');
  // User presses STOP mid-recovery.
  run.userStop();
  // Let the page fully recover + re-enter + fresh Aviator evidence arrive.
  run.pump(4000);
  assert.equal(run.counts.resume, 0, 'AUTO_RESUME_COUNT=0 — STOP wins over a pending recovery resume');
  assert.equal(run.runner.isRunning(), false, 'Auto remains stopped');
  assert.equal(run.runner._resumeCount, 0, 'no resurrected execution');
});

// ---------------------------------------------------------------------------
// §24 — MULTI-BROWSER ISOLATION: B1 recovers via reload; B2 stays untouched.
// ---------------------------------------------------------------------------

test('§24 B1 escalates+reloads+resumes while B2 (live) is never reloaded/re-entered/resumed', () => {
  const b1 = new RecoveryRun({ id: 'B1', directReentrySucceeds: false, reloadEntrySucceeds: true, execId: 'E1', level: 2 });
  const b2 = new RecoveryRun({ id: 'B2', execId: 'E2', level: 5 });
  b1.tick(); b1.lastAviatorMono = b1.now;
  b2.tick(); b2.keepAlive = true;   // B2's game keeps producing fresh Aviator frames
  // Drive both on the same wall-clock until B1 resumes.
  const end = 12000; let t = 0;
  while (t < end) {
    t += STEP; b1.now += STEP; b2.now += STEP; b1.tick(); b2.tick();
    if (b1.counts.resume >= 1 && b1.runner.isRunning()) break;
  }
  assert.equal(b1.counts.resume, 1, 'B1 resumed its own execution');
  assert.ok(b1.counts.reload >= 1, 'B1 used the reload fallback');
  // B2 completely untouched by B1's recovery.
  assert.equal(b2.counts.reload, 0, 'WRONG_RUN_RELOAD_COUNT=0');
  assert.equal(b2.counts.cocosEntryAfterReload, 0, 'WRONG_RUN_ENTRY_COUNT=0');
  assert.equal(b2.counts.resume, 0, 'WRONG_RUN_RESUME_COUNT=0');
  assert.equal(b2.runner.autoExecutionId(), 'E2', 'B2 execution unchanged');
  assert.equal(b2.runner.level(), 5, 'B2 Level unchanged');
  assert.equal(b2.runner.isRunning(), true, 'B2 keeps running normally');
});

// ---------------------------------------------------------------------------
// §25 — LONG-RUN: 60 generations mixing direct-re-entry success and reload fallback.
//   Invariants per generation: exactly one resume, same execution id + Level, and no
//   cross-generation leak (no stale pending resume, no duplicate resume).
// ---------------------------------------------------------------------------

test('§25 long-run 60 generations (mixed direct + reload) resume exactly once each, no degradation', () => {
  const run = new RecoveryRun({ directReentrySucceeds: true, reloadEntrySucceeds: true, execId: 'E1', level: 2 });
  run.tick(); run.lastAviatorMono = run.now;

  const GENERATIONS = 60;
  let expectedResumes = 0;
  let reloadGenerations = 0;
  for (let g = 0; g < GENERATIONS; g++) {
    // Alternate: even generations recover via direct re-entry, odd via the reload fallback.
    const useReload = (g % 2 === 1);
    run.directReentrySucceeds = !useReload;
    run.reloadEntrySucceeds = true;
    if (useReload) reloadGenerations += 1;

    const resumeBefore = run.counts.resume;
    const reloadBefore = run.counts.reload;
    // Ensure a clean ACTIVE baseline, then freeze the game to induce loss.
    run.lastAviatorMono = run.now;
    run.pump(STEP);
    const recovered = run.pumpUntil(() => run.counts.resume === resumeBefore + 1 && run.runner.isRunning(), 12000);
    assert.ok(recovered, `generation ${g} (${useReload ? 'reload' : 'direct'}) resumed`);
    // Exactly one resume for this generation — no duplicate.
    assert.equal(run.counts.resume, resumeBefore + 1, `generation ${g}: exactly one resume`);
    // Same preserved execution + Level, every generation.
    assert.equal(run.runner.autoExecutionId(), 'E1', `generation ${g}: same executionId`);
    assert.equal(run.runner.level(), 2, `generation ${g}: same Level`);
    // Reload generations used the page fallback; direct generations did not reload.
    if (useReload) assert.ok(run.counts.reload > reloadBefore, `generation ${g}: reload fallback engaged`);
    else assert.equal(run.counts.reload, reloadBefore, `generation ${g}: direct path did NOT reload`);
    expectedResumes += 1;
  }
  assert.equal(run.counts.resume, expectedResumes, 'one resume per generation, cumulatively');
  assert.equal(run.runner._resumeCount, expectedResumes, 'runner resumed exactly once per generation');
  assert.ok(run.counts.reload >= reloadGenerations, 'reload fallback engaged on the fallback generations');
  // No leaked simulated effects (no dangling async browser/server responses).
  assert.ok(run.effects.length <= 2, `no significant effect leak (${run.effects.length} pending)`);
});
