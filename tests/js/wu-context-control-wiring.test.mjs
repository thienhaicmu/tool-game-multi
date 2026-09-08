import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { JackpotGate } = require('../../desktop/protocol/jackpot-gate.cjs');
const { AviatorEntryGate } = require('../../desktop/protocol/aviator-entry.cjs');

const rd = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
// Extract a function body by name up to the next top-level `function ` — good enough for wiring asserts.
function fnSegment(src, name) {
  const start = src.indexOf('function ' + name);
  assert.notEqual(start, -1, `expected function ${name} in source`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

// ---------------------------------------------------------------------------
// Behavioral — JackpotGate cancel reason (foundation for §6 re-arm vs user STOP).
// ---------------------------------------------------------------------------

test('C8/C9 foundation: a recovery cancel is distinguishable from a user STOP by reason', async () => {
  const obs = { current: () => 100 };
  const g1 = new JackpotGate({ observer: obs });
  const p1 = g1.ensureThreshold(500);      // 100 < 500 -> WAITING
  assert.equal(g1.isWaiting(), true);
  g1.cancel('DISCONNECTED');
  const r1 = await p1;
  assert.equal(r1.error.code, 'JACKPOT_GATE_CANCELLED');
  assert.equal(r1.error.reason, 'DISCONNECTED');   // recovery -> re-armable

  const g2 = new JackpotGate({ observer: obs });
  const p2 = g2.ensureThreshold(500);
  g2.cancel('STOPPED');
  const r2 = await p2;
  assert.equal(r2.error.reason, 'STOPPED');         // user stop -> abort
});

test('C9: re-arming ensureThreshold after a cancel still requires the SAME threshold (no bypass)', async () => {
  let jp = 100;
  const obs = new EventEmitter();
  obs.current = () => jp;
  const gate = new JackpotGate({ observer: obs });
  // First wait cancelled by recovery.
  const p1 = gate.ensureThreshold(500);
  gate.cancel('DISCONNECTED');
  await p1;
  // Re-arm with the SAME threshold — must NOT auto-release at the stale 100.
  const p2 = gate.ensureThreshold(500);
  assert.equal(gate.isWaiting(), true);
  // Only a genuine authoritative update that satisfies the rule releases it.
  jp = 300; obs.emit('update');
  assert.equal(gate.isWaiting(), true);             // 300 < 500 -> still waiting (comparator unchanged)
  jp = 500; obs.emit('update');
  const r = await p2;
  assert.equal(r.ready, true);
  assert.equal(r.jackpot, 500);
});

// ---------------------------------------------------------------------------
// Behavioral — C7: cmd100000 SENT != AVIATOR_ENTERED (invariant preserved).
// ---------------------------------------------------------------------------

test('C7: an enter SEND alone does not mark entered — only fresh server round evidence does', async () => {
  const bus = new EventEmitter();
  const gate = new AviatorEntryGate({
    roundTracker: bus,
    send: async () => ({ ok: true }),
    getContext: () => ({ targetId: 'T1', wirePrefix: '42' }),
    timeoutMs: 50,
  });
  const p = gate.ensureEntered();
  assert.equal(gate.isEntered(), false);            // send succeeded, but no server evidence yet
  const r = await p;
  assert.equal(r.error.code, 'AVIATOR_ENTRY_TIMEOUT');
  assert.equal(gate.isEntered(), false);
});

test('C6: a fresh authoritative server round frame after the enter marks entered (READY)', async () => {
  const bus = new EventEmitter();
  const gate = new AviatorEntryGate({
    roundTracker: bus,
    send: async () => ({ ok: true }),
    getContext: () => ({ targetId: 'T1', wirePrefix: '42' }),
    timeoutMs: 1000,
  });
  const p = gate.ensureEntered();
  bus.emit('frame', { direction: 'recv', cmd: 100005, sid: 9 });  // authoritative ROUND_OPEN
  const r = await p;
  assert.equal(r.ready, true);
  assert.equal(gate.isEntered(), true);
});

// ---------------------------------------------------------------------------
// Source-integration — the main.cjs wiring (Electron-bound; asserted structurally,
// matching the existing wu-session-recovery / login-expiry wiring-test convention).
// ---------------------------------------------------------------------------

test('§4: Auto INTENT covers WAITING_JACKPOT (not derived solely from autoRunner.isRunning)', () => {
  const main = rd('desktop/main.cjs');
  assert.match(main, /jackpotWaiting = !!\(run\.jackpotGate && run\.jackpotGate\.isWaiting && run\.jackpotGate\.isWaiting\(\)\)/);
  assert.match(main, /if \(autoRunning \|\| jackpotWaiting \|\| pausedForRecovery\) \{\s*\n\s*run\._autoIntentLatch = true;/);
});

test('C5: CONTEXT_LOST re-enters via ensureEntered WITHOUT a full reload or protocol wipe', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'applyAviatorContextAction');
  // Light re-entry: invalidate ONLY entry readiness + reuse the existing gate.
  assert.match(seg, /run\.entryGate\.onDisconnect\(\)/);
  assert.match(seg, /run\.entryGate\.ensureEntered\(\)/);
  // MUST NOT reload the page or nuke jackpot/protocol state on the light path.
  assert.ok(!/wc\.reload\(\)/.test(seg), 'light re-entry must not reload the page');
  assert.ok(!/invalidateRunProtocolState/.test(seg), 'light re-entry must not wipe protocol/jackpot state');
  assert.ok(!/wc\.loadURL/.test(seg), 'light re-entry must not navigate the whole website');
});

test('C12/C13/C14: context re-entry pauses via SESSION_RECOVERY (never a finalize -> no sequence advance)', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'applyAviatorContextAction');
  assert.match(seg, /run\.autoRunner\.stop\(\{ reason: 'SESSION_RECOVERY' \}\)/);
  // The sequence controller only advances on a NORMAL completion, and a SESSION_RECOVERY pause
  // emits no executionFinalized — so recovery can never advance the row.
  const seqSrc = rd('desktop/browser-run/auto-sequence-controller.cjs');
  assert.match(seqSrc, /CONTINUABLE_STOP_REASON = 'ROUND_TARGET_COMPLETED'/);
  assert.match(seqSrc, /A SESSION_RECOVERY pause is NOT a finalize/);
});

test('C11: WAITING_ROUND resume after context re-entry preserves the SAME autoExecutionId', () => {
  const main = rd('desktop/main.cjs');
  // onAviatorReentered resumes a paused execution automatically (full-auto policy).
  const seg = fnSegment(main, 'onAviatorReentered');
  assert.match(seg, /resumePausedAuto\(run\)/);
  assert.match(seg, /autoResumeAllowed\(run\)/);
  // resumePausedAuto continues the SAME execution id (resumeExecutionId), never a new one.
  const resumeSeg = fnSegment(main, 'resumePausedAuto');
  assert.match(resumeSeg, /resumeExecutionId: execId/);
});

test('C8: WAITING_JACKPOT survives full recovery — the wait is re-armed with the SAME threshold', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'startAutoExecution');
  // Re-arm loop: a DISCONNECTED cancel waits for re-entry, then re-arms the SAME threshold.
  assert.match(seg, /run\.jackpotGate\.ensureThreshold\(jackpotThreshold\)/);
  assert.match(seg, /jg\.error\.reason === 'DISCONNECTED'/);
  assert.match(seg, /waitForAviatorReentry\(run\)/);
  assert.match(seg, /continue;\s*\/\/ re-arm/);
  // A user STOP / other error still aborts (only the ready result breaks out successfully).
  assert.match(seg, /if \(jg && jg\.ready\) break;/);
});

test('C9: recovery never bypasses the Jackpot gate (AutoRunner.start stays after a satisfied gate)', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'startAutoExecution');
  const gateIdx = seg.indexOf('ensureThreshold(jackpotThreshold)');
  const startIdx = seg.indexOf('run.autoRunner.start(');
  assert.ok(gateIdx !== -1 && startIdx !== -1 && gateIdx < startIdx, 'gate is awaited before AutoRunner.start');
});

test('C16: context loss uses login-aware page health (login wall is NOT context loss)', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'aviatorContextTick');
  assert.match(seg, /const pageHealthy = alive && wsConnected && !looksLikeLoginUrl\(url\)/);
});

test('C15/C17: the existing session-recovery watchdog (WS-close / renderer) is unchanged and still primary', () => {
  const main = rd('desktop/main.cjs');
  // Context tracker DEFERS whenever the watchdog is doing anything (non-HEALTHY) — no competition.
  const seg = fnSegment(main, 'aviatorContextTick');
  assert.match(seg, /if \(recState !== 'HEALTHY'\)/);
  // Existing WS-close + renderer evidence + full recovery actuators remain wired.
  assert.match(main, /run\._wsConnected = false/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /case RECOVERY_ACTION\.RELOAD:/);
});

test('C18 (wiring): a re-entry in flight is reported back so the tracker suppresses duplicates', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'aviatorContextTick');
  assert.match(seg, /reentryInFlight: run\._ctxReentryInFlight === true/);
});
