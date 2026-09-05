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

test('renderer failure (render-process-gone / unresponsive) is strong evidence → recovery', () => {
  const w = mk();
  w.tick(healthy(100000, { rendererAlive: false }));           // VERIFYING (RENDERER_STALE)
  const r = w.tick(healthy(106000, { rendererAlive: false }));
  assert.equal(r.state, STATE.RECOVERING);
  assert.ok(r.actions.includes(ACTION.PAUSE_AUTOMATION));
});

test('traffic stale while genuinely RUNNING (auto) is evidence; not while idle', () => {
  // idle (no autoIntent) with old lastAviator → NOT stale
  const idle = mk();
  let r = idle.tick(healthy(200000, { autoIntent: false, lastAviatorMono: 100000 }));
  assert.equal(r.state, STATE.HEALTHY);
  // running + no aviator beyond threshold → stale
  const run = mk();
  r = run.tick(healthy(200000, { autoIntent: true, observerStatus: 'RUNNING', lastAviatorMono: 100000 }));
  assert.equal(run.reason(), 'AVIATOR_TRAFFIC_STALE');
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

test('a host change ALONE (legitimate redirect, game still healthy) does NOT recover', () => {
  const w = mk();
  // site rotated to a sibling domain but WS/game is fine → must stay HEALTHY (no false recovery)
  let r = w.tick(healthy(100000, { onConfiguredHost: false, wsConnected: true }));
  assert.equal(r.state, STATE.HEALTHY);
  r = w.tick(healthy(120000, { onConfiguredHost: false, wsConnected: true }));
  assert.equal(r.state, STATE.HEALTHY);
  assert.deepEqual(r.actions, []);
});

test('a redirect that LOSES the game (off-host + WS down) recovers via NAVIGATE_CONFIGURED', () => {
  const w = mk();
  w.tick(healthy(100000, { onConfiguredHost: false, wsConnected: false }));   // VERIFYING (WS_CLOSED)
  w.tick(healthy(106000, { onConfiguredHost: false, wsConnected: false }));   // RECOVERING
  const r = w.tick(healthy(106500, { onConfiguredHost: false, wsConnected: false }));
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

// --- wiring guards (source-level): the watchdog is owned per-run, ticked on the run lifecycle,
// fed real evidence, and mapped to actuators — never a global timer / global execution state. ---
import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _f } from 'node:url';
import path2 from 'node:path';
const ROOT2 = path2.resolve(path2.dirname(_f(import.meta.url)), '..', '..');
const rd2 = (p) => _rf(path2.join(ROOT2, p), 'utf8');

test('wiring: watchdog is per-run, started/stopped with the run lifecycle (no orphan timers)', () => {
  const main = rd2('desktop/main.cjs');
  assert.match(main, /recovery = new SessionRecoveryWatchdog/, 'one watchdog per run subsystem');
  assert.match(main, /startRecoveryWatch\(run\)/, 'health tick starts when the run connects');
  assert.match(main, /stopRecoveryWatch\(summary && summary\.id\)/, 'tick torn down on run-closed');
  assert.match(main, /setInterval\(\(\) => \{ try \{ recoveryTick\(run\)/, 'per-run interval (not a global loop)');
  assert.match(main, /for \(const id of \[\.\.\._recoveryWatch\.keys\(\)\]\) stopRecoveryWatch/, 'all ticks torn down on quit');
  const mgr = rd2('desktop/browser-run/browser-run-manager.cjs');
  assert.match(mgr, /run\.recovery = subsystem\.recovery/, 'watchdog assigned onto the run');
  assert.match(mgr, /recoveryState: run\.recovery/, 'recovery state exposed per-run (view-only)');
});

test('wiring: evidence + actuators mapped to the current runtime (reuse, no second engine)', () => {
  const main = rd2('desktop/main.cjs');
  // evidence
  assert.match(main, /run\._lastAviatorMono = perfNow\(\)/, 'records last aviator frame time per run');
  assert.match(main, /run\._wsConnected = false/, 'records WS close as evidence');
  assert.match(main, /render-process-gone|unresponsive/, 'renderer health feeds the same model');
  // actuators reuse existing mechanisms
  assert.match(main, /run\.autoRunner\.stop\(\{ reason: 'SESSION_RECOVERY' \}\)/, 'pauses existing AutoRunner');
  assert.match(main, /invalidateRunProtocolState\(run\)/, 'invalidates stale protocol state');
  assert.match(main, /run\.entryGate\.ensureEntered\(\)/, 'reuses AviatorEntryGate for re-entry');
  assert.match(main, /wc\.loadURL\(run\.launchUrl\)/, 'navigates to the configured URL when the page is lost');
});
