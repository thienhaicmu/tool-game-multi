// WU-FULL-AUTO-RECOVERY — a recoverable interruption resumes the preserved Auto intent
// WITHOUT any user "continue" step, while STOP still wins and no unknown action is replayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { SessionRecoveryWatchdog, ACTION } = require('../../desktop/browser-run/session-recovery.cjs');
const { JackpotGate } = require('../../desktop/protocol/jackpot-gate.cjs');
const { AutoRunner, STATE } = require('../../desktop/protocol/auto-runner.cjs');

const rd = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
function fnSegment(src, name) {
  const start = src.indexOf('function ' + name);
  assert.notEqual(start, -1, `expected function ${name}`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------
// ENVIRONMENT POLICY — full auto resume (no REQUIRE_USER_ACTION merely because recovery occurred).
// ---------------------------------------------------------------------------

test('policy: full-auto resume is the default and gates BOTH recovery paths', () => {
  const main = rd('desktop/main.cjs');
  const seg = fnSegment(main, 'autoResumeAllowed');
  // Default true; only an explicit opt-out restores the endpoint-based manual gate.
  assert.match(seg, /OBSERVATORY_REQUIRE_USER_RESUME === '1'/);
  assert.match(seg, /return true;/);
  // Both the session watchdog and the context light-path resolve resume via this ONE policy.
  assert.match(main, /isLocalEndpoint: \(\) => autoResumeAllowed\(run\)/);
  assert.match(fnSegment(main, 'onAviatorReentered'), /if \(autoResumeAllowed\(run\)\) \{ resumePausedAuto\(run\); return; \}/);
});

test('watchdog (auto-resume allowed) resumes automatically at READY — no user-action step', () => {
  const cfg = { suspectNoAviatorMs: 4000, verifyWindowMs: 2000, waitPageMs: 12000, waitAviatorMs: 12000, maxAttempts: 3, retryDelayMs: 1500 };
  const w = new SessionRecoveryWatchdog({ isLocalEndpoint: () => true, config: cfg });
  // Drive to READY through the normal pipeline with an active Auto intent.
  const base = { autoIntent: true, observerStatus: 'RUNNING', wsConnected: true, rendererAlive: true, onConfiguredHost: true, loginDetected: false };
  w.tick({ monoNow: 100000, lastAviatorMono: 100000 - 25000, ...base });                 // VERIFYING
  w.tick({ monoNow: 106500, lastAviatorMono: 100000 - 25000, ...base });                 // RECOVERING
  w.tick({ monoNow: 106600, lastAviatorMono: 100000 - 25000, ...base, onConfiguredHost: false }); // NAVIGATE -> WAITING_PAGE
  w.tick({ monoNow: 106700, ...base, instrumentationReady: true });                      // REENTER -> WAITING_AVIATOR
  const r = w.tick({ monoNow: 106800, ...base, freshAviatorSinceRecovery: true });       // READY
  assert.equal(r.state, 'READY');
  assert.ok(r.actions.includes(ACTION.RESUME_AUTOMATION), 'auto-resumes the paused execution');
  assert.ok(!r.actions.includes(ACTION.REQUIRE_USER_ACTION), 'no manual continue step');
  assert.equal(w.snapshot().userActionRequired, false);
});

// ---------------------------------------------------------------------------
// STOP STILL WINS — a manual STOP must prevent any recovery resurrection.
// ---------------------------------------------------------------------------

function makeRunner() {
  const tracker = new EventEmitter();
  tracker.actionTraces = () => [];
  const observer = { currentRound: () => null, status: () => 'IDLE' };
  const harness = { execute: async () => ({ result: 'ACK' }) };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'http://localhost/game', now: () => 0 });
  return { runner };
}

test('C21: a manual STOP clears the recovery-pause flag → resume guard cannot resurrect Auto', () => {
  const { runner } = makeRunner();
  runner.start('T', { roundCount: 5, amount: 10, stopOdd: 2 });
  runner.stop(); // manual USER_STOP (terminal), NOT a recovery pause
  assert.equal(runner.pausedForRecovery(), false, 'manual stop is terminal, never a resumable pause');
  assert.equal(runner.isRunning(), false);
  // The resume helper's guard (source) refuses anything that is not a genuine recovery pause.
  const seg = fnSegment(rd('desktop/main.cjs'), 'resumePausedAuto');
  assert.match(seg, /if \(!\(ar\.pausedForRecovery && ar\.pausedForRecovery\(\)\)\) return;/);
});

test('a SESSION_RECOVERY pause IS resumable (distinct from a manual stop)', () => {
  const { runner } = makeRunner();
  runner.start('T', { roundCount: 5, amount: 10, stopOdd: 2 });
  runner.stop({ reason: 'SESSION_RECOVERY' });
  assert.equal(runner.pausedForRecovery(), true);
});

test('C20: STOP cancels a pending Jackpot wait with reason STOPPED (re-arm loop aborts, no start)', async () => {
  const obs = { current: () => 10 };
  const gate = new JackpotGate({ observer: obs });
  const p = gate.ensureThreshold(500);
  gate.cancel('STOPPED');                       // exactly what autotest-stop does
  const r = await p;
  assert.equal(r.error.reason, 'STOPPED');      // NOT 'DISCONNECTED' -> startAutoExecution returns the error
  // The re-arm loop only continues on a recovery (DISCONNECTED) cancel.
  const seg = fnSegment(rd('desktop/main.cjs'), 'startAutoExecution');
  assert.match(seg, /jg\.error\.reason === 'DISCONNECTED'/);
  // autotest-stop cancels with STOPPED (source), so a user STOP can never be mistaken for recovery.
  assert.match(rd('desktop/main.cjs'), /run\.jackpotGate\.cancel\('STOPPED'\)/);
});

test('C18/C19: STOP disarms the whole sequence + recovery continuation via generation bump', () => {
  const main = rd('desktop/main.cjs');
  // autotest-stop disarms the sequence FIRST (bumps generation) then cancels gate + stops runner.
  assert.match(main, /run\.autoSequence\.stop\('USER_STOP'\)/);
  const seqSrc = rd('desktop/browser-run/auto-sequence-controller.cjs');
  assert.match(seqSrc, /this\._generation \+= 1;/);              // race-safe: queued next-row becomes a no-op
});

// ---------------------------------------------------------------------------
// IDEMPOTENCY.
// ---------------------------------------------------------------------------

test('C26: a duplicate READY-driven resume is a no-op (resume guard: already running)', () => {
  // The resume helper refuses to double-start a live runner.
  const seg = fnSegment(rd('desktop/main.cjs'), 'resumePausedAuto');
  assert.match(seg, /if \(!ar \|\| \(ar\.isRunning && ar\.isRunning\(\)\)\) return;/);
});

test('C28: a Jackpot threshold releases the gate EXACTLY once (duplicate updates do not re-fire)', async () => {
  let jp = 100;
  const obs = new EventEmitter();
  obs.current = () => jp;
  const gate = new JackpotGate({ observer: obs });
  let resolved = 0;
  const p = gate.ensureThreshold(500).then((r) => { resolved++; return r; });
  jp = 600; obs.emit('update');           // crosses threshold -> release
  jp = 700; obs.emit('update');           // further updates must NOT re-release
  jp = 800; obs.emit('update');
  const r = await p; await flush();
  assert.equal(r.ready, true);
  assert.equal(resolved, 1, 'exactly one release');
  assert.equal(gate.state(), 'READY');
});

// ---------------------------------------------------------------------------
// IN-FLIGHT SAFETY under full-auto — resume never replays an unknown action.
// (Deep continuity is proven in wu-auto-recovery-progress-continuity; this pins the guarantee
//  that full-auto did NOT loosen it.)
// ---------------------------------------------------------------------------

test('full-auto resume still begins a clean round loop (no blind BET/CASHOUT on resume)', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'resumePausedAuto');
  // Resume reuses AutoRunner.start with resumeExecutionId — which starts WAITING_ROUND and bets only
  // on the next authoritative ROUND_OPEN via normal eligibility (dedup protects the interrupted SID).
  assert.match(seg, /resumeExecutionId: execId/);
  assert.match(seg, /recoveryCount/);
  // It must NOT directly send bet/cashout.
  assert.ok(!/command: 'bet'|command: 'cashout'|sendProtocol|sendRaw/.test(seg));
});
