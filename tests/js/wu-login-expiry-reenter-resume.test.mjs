// WU-LOGIN-EXPIRY-RECOVERY-REENTER-AUTO-RESUME — deterministic state-machine + source-wiring tests.
//
// Proves the login-expiry recovery flow converges into the EXISTING re-entry pipeline:
//   AUTO_RUNNING → login expiry → PAUSE + INVALIDATE → LOGIN_REQUIRED → (user logs in) →
//   POST_LOGIN_RECOVERY → WAITING_PAGE → REENTER (entryGate.ensureEntered) → WAITING_AVIATOR →
//   fresh authoritative SERVER evidence → READY → resume policy (local RESUME / public REQUIRE_USER).
// No second watchdog, no duplicate cmd100000 sender, no blind resend, no fabricated evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { SessionRecoveryWatchdog, STATE, ACTION, REASON } = require('../../desktop/browser-run/session-recovery.cjs');

const cfg = { suspectNoAviatorMs: 20000, verifyWindowMs: 6000, waitPageMs: 20000, waitAviatorMs: 20000, maxAttempts: 3, retryDelayMs: 3000 };
function mk(over = {}) { return new SessionRecoveryWatchdog({ isLocalEndpoint: over.local ? () => true : () => false, config: cfg }); }
const ev = (mono, over = {}) => ({ monoNow: mono, autoIntent: true, observerStatus: 'RUNNING', lastAviatorMono: mono - 1000, wsConnected: true, rendererAlive: true, onConfiguredHost: true, loginDetected: false, instrumentationReady: true, freshAviatorSinceRecovery: false, ...over });

// Drive HEALTHY → VERIFYING(WS_CLOSED) → LOGIN_REQUIRED (login wall confirmed during verify).
function toLoginRequired(w, over = {}) {
  w.tick(ev(0, { wsConnected: false, ...over }));                              // VERIFYING
  const r = w.tick(ev(3000, { wsConnected: false, loginDetected: true, ...over })); // LOGIN_REQUIRED
  assert.equal(r.state, STATE.LOGIN_REQUIRED);
  return r;
}

test('login expiry pauses Auto + invalidates state BEFORE LOGIN_REQUIRED (no wasted reload)', () => {
  const w = mk();
  const r = toLoginRequired(w);
  assert.ok(r.actions.includes(ACTION.PAUSE_AUTOMATION), 'AutoRunner paused first');
  assert.ok(r.actions.includes(ACTION.INVALIDATE_STATE), 'stale SID/ODD/socket invalidated');
});

test('LOGIN_REQUIRED does NOT reload-loop while the wall is up', () => {
  const w = mk();
  toLoginRequired(w);
  for (const t of [6000, 9000, 12000]) {
    const r = w.tick(ev(t, { loginDetected: true, wsConnected: false, onConfiguredHost: false }));
    assert.equal(r.state, STATE.LOGIN_REQUIRED);
    assert.deepEqual(r.actions, [], 'no reload/navigate/reenter while login wall shown');
  }
});

test('user logs in → login wall gone → converges to WAITING_PAGE via POST_LOGIN_RECOVERY (no early READY)', () => {
  const w = mk();
  toLoginRequired(w);
  // Wall gone but instrumentation not yet ready (page still settling). Must NOT jump to READY/HEALTHY.
  const r = w.tick(ev(8000, { loginDetected: false, onConfiguredHost: true, wsConnected: true, instrumentationReady: false }));
  assert.equal(r.state, STATE.WAITING_PAGE);
  assert.equal(r.reason, REASON.POST_LOGIN_RECOVERY);
  assert.deepEqual(r.actions, [], 'no enter is fabricated inside the state machine');
});

test('post-login: WAITING_PAGE issues exactly one REENTER (entryGate.ensureEntered) when instrumented', () => {
  const w = mk();
  toLoginRequired(w);
  w.tick(ev(8000, { loginDetected: false, instrumentationReady: false })); // WAITING_PAGE
  const r = w.tick(ev(9000, { loginDetected: false, instrumentationReady: true, wsConnected: true }));
  assert.equal(r.state, STATE.WAITING_AVIATOR);
  assert.deepEqual(r.actions, [ACTION.REENTER], 'exactly one REENTER intent');
  // Duplicate ticks while waiting for evidence must NOT re-issue REENTER (idempotent per generation).
  const r2 = w.tick(ev(10000, { freshAviatorSinceRecovery: false }));
  assert.equal(r2.state, STATE.WAITING_AVIATOR);
  assert.ok(!r2.actions.includes(ACTION.REENTER), 'no duplicate cmd100000 from repeated ticks');
});

test('cmd100000/page-load alone is NOT entered: READY requires FRESH server Aviator evidence', () => {
  const w = mk();
  toLoginRequired(w);
  w.tick(ev(8000, { loginDetected: false, instrumentationReady: false }));      // WAITING_PAGE
  w.tick(ev(9000, { loginDetected: false, instrumentationReady: true }));       // WAITING_AVIATOR (REENTER)
  // Page loaded, WS up, enter sent — but no server round frame yet → still NOT ready.
  let r = w.tick(ev(12000, { freshAviatorSinceRecovery: false, wsConnected: true }));
  assert.equal(r.state, STATE.WAITING_AVIATOR, 'not ready without authoritative server frame');
  // Fresh authoritative server frame arrives → READY.
  r = w.tick(ev(13000, { freshAviatorSinceRecovery: true, wsConnected: true }));
  assert.equal(r.state, STATE.READY);
  assert.ok(r.actions.includes(ACTION.MARK_READY));
});

test('login wall REAPPEARS during post-login recovery → back to LOGIN_REQUIRED (no reenter spam)', () => {
  const w = mk();
  toLoginRequired(w);
  w.tick(ev(8000, { loginDetected: false, instrumentationReady: false }));   // WAITING_PAGE
  const r = w.tick(ev(9000, { loginDetected: true }));                       // wall back up
  assert.equal(r.state, STATE.LOGIN_REQUIRED);
  assert.ok(!r.actions.includes(ACTION.REENTER));
});

test('end-to-end LOCAL endpoint: login expiry → reenter → fresh protocol → auto RESUME (same execution)', () => {
  const w = mk({ local: true });
  toLoginRequired(w);
  w.tick(ev(8000, { loginDetected: false, instrumentationReady: false })); // WAITING_PAGE
  w.tick(ev(9000, { loginDetected: false, instrumentationReady: true }));  // WAITING_AVIATOR (REENTER)
  const r = w.tick(ev(11000, { freshAviatorSinceRecovery: true }));        // READY
  assert.equal(r.state, STATE.READY);
  assert.ok(r.actions.includes(ACTION.RESUME_AUTOMATION), 'local/test resumes the paused execution');
  assert.equal(w.snapshot().userActionRequired, false);
});

test('end-to-end PUBLIC endpoint: recovers to READY but REQUIRE_USER_ACTION before any wager', () => {
  const w = mk({ local: false });
  toLoginRequired(w);
  w.tick(ev(8000, { loginDetected: false, instrumentationReady: false }));
  w.tick(ev(9000, { loginDetected: false, instrumentationReady: true }));
  const r = w.tick(ev(11000, { freshAviatorSinceRecovery: true }));
  assert.equal(r.state, STATE.READY);
  assert.ok(r.actions.includes(ACTION.REQUIRE_USER_ACTION), 'public: user must resume explicitly');
  assert.ok(!r.actions.includes(ACTION.RESUME_AUTOMATION), 'public: no auto-wager');
  assert.equal(w.snapshot().userActionRequired, true);
});

test('unresolved in-flight ACK stays UNKNOWN across the entire login-expiry → resume flow', () => {
  const w = mk({ local: true });
  w.tick(ev(0, { wsConnected: false, inflightAckPending: true }));                       // VERIFYING
  const r1 = w.tick(ev(3000, { wsConnected: false, loginDetected: true, inflightAckPending: true }));
  assert.equal(r1.state, STATE.LOGIN_REQUIRED);
  assert.equal(w.actionResultUnknown(), true, 'in-flight result is UNKNOWN, never inferred/resent');
});

// --- Source-wiring guards: the resume actuator reuses the EXISTING AutoRunner resume seam and
// entry gate; there is no second watchdog / duplicate enter sender / renderer-owned state. ---
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('wiring: RESUME_AUTOMATION resumes the SAME execution via AutoRunner.start(resumeExecutionId)', () => {
  const main = rd('desktop/main.cjs');
  assert.match(main, /case RECOVERY_ACTION\.RESUME_AUTOMATION:\s*\n[\s\S]*?resumePausedAuto\(run\);/, 'RESUME_AUTOMATION delegates to resumePausedAuto');
  assert.match(main, /function resumePausedAuto\(run\)/, 'resume helper exists');
  assert.match(main, /pausedForRecovery\(\)\)\) return;/, 'only a genuine recovery pause is resumable');
  assert.match(main, /ar\.start\(String\(run\.selectedTargetId \|\| ''\), cfg, \{ resumeExecutionId: execId, recoveryCount \}\)/, 'reuses resumeExecutionId seam (same id)');
  assert.match(main, /event: 'AUTO_RESUMED'/, 'emits AUTO_RESUMED diagnostic');
});

test('wiring: manual restart after a recovery pause keeps the SAME autoExecutionId (public continuity)', () => {
  const main = rd('desktop/main.cjs');
  assert.match(main, /run\.autoRunner\.pausedForRecovery\(\)[\s\S]*?resumeExecutionId: run\.autoRunner\.autoExecutionId\(\)/, 'autotest-start threads resumeExecutionId when paused for recovery');
  assert.match(main, /run\.autoRunner\.start\(String\(run\.selectedTargetId \|\| ''\), effectiveConfig, resumeOpts\)/, 'start receives resume opts');
});

test('wiring: REQUIRE_USER_ACTION preserves the pause (no resume) and logs it', () => {
  const main = rd('desktop/main.cjs');
  assert.match(main, /case RECOVERY_ACTION\.REQUIRE_USER_ACTION:[\s\S]*?event: 'AUTO_REQUIRE_USER_ACTION'/, 'require-user path is diagnosed');
  // The require-user branch must NOT call resumePausedAuto.
  const seg = main.slice(main.indexOf('case RECOVERY_ACTION.REQUIRE_USER_ACTION:'), main.indexOf('default:', main.indexOf('case RECOVERY_ACTION.REQUIRE_USER_ACTION:')));
  assert.ok(!/resumePausedAuto/.test(seg), 'public endpoint never auto-resumes');
});

test('wiring: freshness is generation-scoped (fresh Aviator frame strictly after recovery start)', () => {
  const main = rd('desktop/main.cjs');
  assert.match(main, /freshAviatorSinceRecovery: started != null && run\._lastAviatorFrameMono != null && run\._lastAviatorFrameMono > started/, 'old ODD/SID cannot satisfy a new generation (classified aviator freshness)');
  assert.match(main, /run\.entryGate\.ensureEntered\(\)/, 'REENTER reuses the existing AviatorEntryGate (no duplicate cmd100000 sender)');
});
