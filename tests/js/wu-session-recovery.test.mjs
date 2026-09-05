// Session recovery watchdog — deterministic state-machine tests (Part C). Electron-free.
// Encodes the safety rules: no false recovery in a normal between-round gap, verify-cancels,
// exactly-once recovery with bounded retries, in-flight ACK stays UNKNOWN, live-vs-local resume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionRecoveryWatchdog, STATE, ACTION, REASON } = require('../../desktop/browser-run/session-recovery.cjs');

const cfg = { suspectNoAviatorMs: 20000, verifyWindowMs: 6000, waitPageMs: 20000, waitAviatorMs: 20000, maxAttempts: 3, retryDelayMs: 3000 };
function mk(over = {}) { return new SessionRecoveryWatchdog({ isLocalEndpoint: over.local ? () => true : () => false, config: cfg }); }
const healthy = (mono, over = {}) => ({ monoNow: mono, autoIntent: true, observerStatus: 'RUNNING', lastAviatorMono: mono - 1000, wsConnected: true, rendererAlive: true, onConfiguredHost: true, loginDetected: false, instrumentationReady: true, ...over });

test('normal between-round gap does NOT recover (short ODD silence stays healthy)', () => {
  const w = mk();
  // no aviator frame for 10s while running — below suspect threshold (20s) → stays HEALTHY
  const r = w.tick(healthy(100000, { lastAviatorMono: 100000 - 10000 }));
  assert.equal(r.state, STATE.HEALTHY);
  assert.deepEqual(r.actions, []);
});

test('temporary ODD silence enters VERIFY (not immediate reload), then fresh traffic CANCELS', () => {
  const w = mk();
  // silence beyond threshold → VERIFYING (no reload yet)
  let r = w.tick(healthy(100000, { lastAviatorMono: 100000 - 25000 }));
  assert.equal(r.state, STATE.VERIFYING);
  assert.ok(!r.actions.includes(ACTION.RELOAD), 'no reload on first suspicion');
  // fresh aviator frame arrives during verify window → back to HEALTHY
  r = w.tick(healthy(101000, { lastAviatorMono: 101000 - 100 }));
  assert.equal(r.state, STATE.HEALTHY);
  assert.equal(r.reason, REASON.FRESH_TRAFFIC_CONFIRMED);
});

test('confirmed stale (silence persists past verify window) triggers exactly-once recovery', () => {
  const w = mk();
  const stale = (mono) => healthy(mono, { lastAviatorMono: 60000 }); // frozen last-frame
  w.tick(stale(100000));                       // -> VERIFYING
  const r = w.tick(stale(100000 + 6000));       // verify window elapsed -> RECOVERING
  assert.equal(r.state, STATE.RECOVERING);
  assert.ok(r.actions.includes(ACTION.PAUSE_AUTOMATION), 'pauses automation before navigating');
  assert.ok(r.actions.includes(ACTION.INVALIDATE_STATE), 'invalidates stale protocol state');
  assert.equal(w.attempts(), 1);
});

test('WS close is strong evidence → verify then recover; reload used when still on host', () => {
  const w = mk();
  w.tick(healthy(100000, { wsConnected: false }));            // -> VERIFYING (WS_CLOSED)
  let r = w.tick(healthy(106000, { wsConnected: false }));    // -> RECOVERING
  assert.equal(r.state, STATE.RECOVERING);
  r = w.tick(healthy(106500, { wsConnected: false, onConfiguredHost: true })); // -> WAITING_PAGE via RELOAD
  assert.ok(r.actions.includes(ACTION.RELOAD));
  assert.equal(r.state, STATE.WAITING_PAGE);
});

test('redirect away navigates to the configured URL (not a reload)', () => {
  const w = mk();
  w.tick(healthy(100000, { onConfiguredHost: false }));       // VERIFYING (PAGE_REDIRECTED)
  w.tick(healthy(106000, { onConfiguredHost: false }));       // RECOVERING
  const r = w.tick(healthy(106500, { onConfiguredHost: false }));
  assert.ok(r.actions.includes(ACTION.NAVIGATE_CONFIGURED));
  assert.ok(!r.actions.includes(ACTION.RELOAD));
});

test('full recovery to READY requires FRESH protocol (not just page load), then re-enter', () => {
  const w = mk();
  w.tick(healthy(0, { wsConnected: false }));
  w.tick(healthy(6000, { wsConnected: false }));               // RECOVERING
  w.tick(healthy(6500, { wsConnected: false }));               // WAITING_PAGE (RELOAD)
  // page loaded + instrumentation ready → REENTER
  let r = w.tick(healthy(9000, { instrumentationReady: true, wsConnected: true, freshAviatorSinceRecovery: false }));
  assert.equal(r.state, STATE.WAITING_AVIATOR);
  assert.ok(r.actions.includes(ACTION.REENTER));
  // no fresh aviator yet → NOT ready
  r = w.tick(healthy(10000, { freshAviatorSinceRecovery: false }));
  assert.equal(r.state, STATE.WAITING_AVIATOR);
  // fresh aviator frame → READY
  r = w.tick(healthy(11000, { freshAviatorSinceRecovery: true, wsConnected: true }));
  assert.equal(r.state, STATE.READY);
  assert.ok(r.actions.includes(ACTION.MARK_READY));
});

test('resume policy: LOCAL endpoint auto-resumes, PUBLIC endpoint requires user action', () => {
  for (const local of [true, false]) {
    const w = mk({ local });
    w.tick(healthy(0, { wsConnected: false }));
    w.tick(healthy(6000, { wsConnected: false }));
    w.tick(healthy(6500, { wsConnected: false }));
    w.tick(healthy(9000, { instrumentationReady: true }));
    const r = w.tick(healthy(11000, { freshAviatorSinceRecovery: true }));
    assert.equal(r.state, STATE.READY);
    if (local) assert.ok(r.actions.includes(ACTION.RESUME_AUTOMATION), 'local resumes');
    else { assert.ok(r.actions.includes(ACTION.REQUIRE_USER_ACTION), 'public requires user'); assert.ok(!r.actions.includes(ACTION.RESUME_AUTOMATION)); }
  }
});

test('in-flight BET/CASHOUT with unresolved ACK stays UNKNOWN — never auto-resent', () => {
  const w = mk({ local: true });
  w.tick(healthy(0, { wsConnected: false, inflightAckPending: true }));
  const r = w.tick(healthy(6000, { wsConnected: false, inflightAckPending: true }));
  assert.equal(r.state, STATE.RECOVERING);
  assert.equal(w.actionResultUnknown(), true, 'result marked unknown, not failed/won');
});

test('login wall → LOGIN_REQUIRED and does NOT loop reloads', () => {
  const w = mk();
  w.tick(healthy(0, { wsConnected: false }));
  let r = w.tick(healthy(6000, { wsConnected: false, loginDetected: true }));
  assert.equal(r.state, STATE.LOGIN_REQUIRED);
  // subsequent ticks issue no reload/navigate actions
  r = w.tick(healthy(9000, { loginDetected: true, onConfiguredHost: false }));
  assert.deepEqual(r.actions, []);
  assert.equal(r.state, STATE.LOGIN_REQUIRED);
});

test('bounded retries → RECOVERY_FAILED (no infinite reload)', () => {
  const w = mk();
  w.tick(healthy(0, { wsConnected: false }));
  let mono = 6000;
  let r = w.tick(healthy(mono, { wsConnected: false }));       // attempt 1 -> RECOVERING
  for (let i = 0; i < 12; i++) {
    mono += 500; r = w.tick(healthy(mono, { wsConnected: false, instrumentationReady: false }));
    mono += 21000; r = w.tick(healthy(mono, { wsConnected: false, instrumentationReady: false })); // waitPage elapses -> retry/fail
    if (r.state === STATE.RECOVERY_FAILED) break;
  }
  assert.equal(r.state, STATE.RECOVERY_FAILED);
  assert.ok(w.attempts() >= cfg.maxAttempts);
});

test('recovery is per-run isolated instances (no shared/global state)', () => {
  const a = mk(); const b = mk();
  a.tick(healthy(0, { wsConnected: false }));
  a.tick(healthy(6000, { wsConnected: false }));               // A recovering
  const rb = b.tick(healthy(6000));                            // B healthy
  assert.equal(b.state(), STATE.HEALTHY, 'B unaffected by A recovery');
  assert.notEqual(a.state(), STATE.HEALTHY);
});
