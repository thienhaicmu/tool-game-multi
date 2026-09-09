import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AutoStartIntent } = require('../../desktop/browser-run/auto-start-intent.cjs');
const { AviatorEntryGate } = require('../../desktop/protocol/aviator-entry.cjs');

const rd = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
function fnSegment(src, name) {
  const start = src.indexOf('function ' + name);
  assert.notEqual(start, -1, `expected function ${name} in source`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 4; i++) await tick(); };

// ---------------------------------------------------------------------------
// UNIT — AutoStartIntent: the canonical AUTO_START_PENDING_ENTRY owner.
// ---------------------------------------------------------------------------

test('AutoStartIntent: begin marks pending; finish clears; token valid until cancel', () => {
  const it = new AutoStartIntent();
  assert.equal(it.pending(), false);
  const t = it.begin();
  assert.equal(it.pending(), true);
  assert.equal(it.cancelled(t), false);   // no cancel yet
  it.finish();
  assert.equal(it.pending(), false);
  assert.equal(it.cancelled(t), false);   // finish is not a cancel
});

test('AutoStartIntent: cancel invalidates an outstanding token and clears pending (STOP semantics)', () => {
  const it = new AutoStartIntent();
  const t = it.begin();
  it.cancel();
  assert.equal(it.pending(), false);
  assert.equal(it.cancelled(t), true);    // the pending start is cancelled → must NOT start Auto
  // A brand-new begin after cancel gets a fresh, valid token (next START is independent).
  const t2 = it.begin();
  assert.equal(it.cancelled(t2), false);
  assert.equal(it.cancelled(t), true);    // the OLD token stays cancelled (stale generation)
});

test('AutoStartIntent: inFlight duplicate guard is independent of pending/cancel', () => {
  const it = new AutoStartIntent();
  assert.equal(it.inFlight(), false);
  it.markInFlight(true);
  assert.equal(it.inFlight(), true);
  it.markInFlight(false);
  assert.equal(it.inFlight(), false);
});

// ---------------------------------------------------------------------------
// BEHAVIORAL — a faithful miniature of startAutoExecution wiring the REAL
// AviatorEntryGate + REAL AutoStartIntent, with a recording AutoRunner. This
// exercises the actual cancellation checkpoints (not a regex).
// ---------------------------------------------------------------------------
function harness() {
  const bus = new EventEmitter();                 // roundTracker frame stream (server evidence)
  const runner = {
    started: [], running: false, _paused: false,
    start() { if (this.running) return { error: { code: 'AUTO_TEST_ALREADY_RUNNING' } }; this.running = true; this.started.push(1); return { ok: true, autoExecutionId: `AX-${this.started.length}` }; },
    stop() { if (!this.running) return { error: { code: 'AUTO_TEST_NOT_RUNNING' } }; this.running = false; return { ok: true }; },
    isRunning() { return this.running; }, pausedForRecovery() { return this._paused; }, autoExecutionId() { return null; },
  };
  const gate = new AviatorEntryGate({ roundTracker: bus, send: async () => ({ ok: true }), getContext: () => ({ targetId: 'T1', wirePrefix: '42' }), timeoutMs: 200 });
  const intent = new AutoStartIntent();
  const run = { status: 'ACTIVE', autoStartIntent: intent, entryGate: gate, autoRunner: runner };

  // Mirrors production startAutoExecution's pending-entry + cancellation checkpoints.
  async function startAuto() {
    const token = intent.begin();
    const cancelled = () => intent.cancelled(token) || run.status === 'CLOSED';
    const cancelledError = () => ({ error: { code: 'AUTO_START_CANCELLED' } });
    try {
      const g = await gate.ensureEntered();
      if (g && g.error) return { error: g.error };
      if (cancelled()) return cancelledError();     // §8/CASE-5: STOP during pending entry
      if (cancelled()) return cancelledError();     // final checkpoint before the ONLY wagering side-effect
      const res = runner.start('T1', {});
      if (res.error) return res;
      return { ok: true, autoExecutionId: res.autoExecutionId };
    } finally { intent.finish(); }
  }
  // Mirrors the autotest-start handler's duplicate guard.
  async function startAutoViaHandler() {
    if (intent.inFlight()) return { duplicate: true };
    intent.markInFlight(true);
    try { return await startAuto(); } finally { intent.markInFlight(false); }
  }
  function stop() { intent.cancel(); runner.stop(); }
  const activeEvidence = () => bus.emit('frame', { direction: 'recv', cmd: 100005, sid: 1 });
  return { run, bus, gate, intent, runner, startAuto, startAutoViaHandler, stop, activeEvidence };
}

test('1. START while ACTIVE → AutoRunner starts normally (exactly once)', async () => {
  const h = harness();
  h.activeEvidence();                     // already inside Aviator (fresh server frame)
  assert.equal(h.gate.isEntered(), true);
  const res = await h.startAuto();
  assert.equal(res.ok, true);
  assert.equal(h.runner.started.length, 1);
});

test('2. START while Lobby → entry pending, NO start before ACTIVE, then starts exactly once', async () => {
  const h = harness();
  assert.equal(h.gate.isEntered(), false);          // sitting in Lobby
  const p = h.startAuto();
  await tick();
  // Pending: entry invoked (one send), but the runner has NOT started (BET_BEFORE_ACTIVE = 0).
  assert.equal(h.intent.pending(), true);
  assert.equal(h.gate.enterSends(), 1);
  assert.equal(h.runner.started.length, 0);
  // Fresh authoritative SERVER evidence confirms ACTIVE.
  h.activeEvidence();
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(h.runner.started.length, 1);         // AUTORUN_STARTED_EXACTLY_ONCE
  assert.equal(h.intent.pending(), false);
});

test('3. Fresh Lobby, NO user action → no entry invoked, no start', async () => {
  const h = harness();
  await flush();
  assert.equal(h.gate.enterSends(), 0);             // PASSIVE_FRESH_LOBBY_AUTO_ENTER_WITHOUT_INTENT = 0
  assert.equal(h.runner.started.length, 0);
  assert.equal(h.intent.pending(), false);
});

test('4. STOP while pending entry → later ACTIVE must NOT start the AutoRunner', async () => {
  const h = harness();
  const p = h.startAuto();
  await tick();
  assert.equal(h.intent.pending(), true);
  h.stop();                                          // user presses STOP while entry pending
  assert.equal(h.intent.pending(), false);
  h.activeEvidence();                                // ACTIVE finally arrives — but the intent is cancelled
  const res = await p;
  assert.equal(res.error.code, 'AUTO_START_CANCELLED');
  assert.equal(h.runner.started.length, 0);          // DUPLICATE/UNWANTED start prevented
});

test('5. duplicate START during pending entry → one entry invocation, one start', async () => {
  const h = harness();
  const p1 = h.startAutoViaHandler();
  await tick();
  const p2 = h.startAutoViaHandler();                // second click while first is in flight
  const r2 = await p2;
  assert.deepEqual(r2, { duplicate: true });         // handler no-ops the duplicate
  h.activeEvidence();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(h.gate.enterSends(), 1);              // exactly ONE sealed entry invocation
  assert.equal(h.runner.started.length, 1);          // exactly ONE AutoRunner execution
});

test('6. entry attempt failure (timeout) → surfaced as error, no start', async () => {
  const h = harness();
  const res = await h.startAuto();                   // no evidence ever arrives → gate times out (200ms)
  assert.equal(res.error.code, 'AVIATOR_ENTRY_TIMEOUT');
  assert.equal(h.runner.started.length, 0);
});

test('8. multi-browser: START on B1 (Lobby) never enters B2', async () => {
  const b1 = harness();
  const b2 = harness();
  const p = b1.startAuto();
  await tick();
  assert.equal(b1.gate.enterSends(), 1);
  assert.equal(b2.gate.enterSends(), 0);             // CROSS_BROWSER isolation — B2 untouched
  assert.equal(b2.intent.pending(), false);
  b1.activeEvidence();
  await p;
  assert.equal(b2.runner.started.length, 0);
});

test('9. pending start stays bound to its own run intent (selection change is irrelevant)', async () => {
  const b1 = harness();
  const b2 = harness();                              // a "newly selected" run
  const p = b1.startAuto();
  await tick();
  // Cancelling B2's intent (simulating STOP on a different, selected run) must not cancel B1's pending.
  b2.intent.cancel();
  b1.activeEvidence();
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(b1.runner.started.length, 1);
});

// ---------------------------------------------------------------------------
// SOURCE-INTEGRATION — the main.cjs wiring (Electron-bound; asserted structurally,
// matching the existing wu-context-control-wiring / login-expiry convention).
// ---------------------------------------------------------------------------

test('wiring: startAutoExecution captures a cancel token and re-checks it before AutoRunner.start', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'startAutoExecution');
  assert.match(seg, /const intent = run\.autoStartIntent/);
  assert.match(seg, /const token = intent \? intent\.begin\(\) : 0/);
  assert.match(seg, /intent\.cancelled\(token\)/);
  // A cancellation checkpoint exists AFTER the entry await and BEFORE autoRunner.start.
  const entryIdx = seg.indexOf('entryGate.ensureEntered()');
  const startIdx = seg.indexOf('run.autoRunner.start(');
  const cancelBeforeStart = seg.lastIndexOf('if (cancelled()) return cancelledError();', startIdx);
  assert.ok(entryIdx !== -1 && startIdx !== -1, 'entry + start present');
  assert.ok(cancelBeforeStart !== -1 && cancelBeforeStart > entryIdx && cancelBeforeStart < startIdx, 'cancel checkpoint sits between entry and start');
});

test('wiring: START-from-Lobby invalidates a stale entered flag so ensureEntered proves FRESH evidence', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'startAutoExecution');
  assert.match(seg, /run\.entryGate\.isEntered\(\) && !run\._ctxReentryInFlight/);
  assert.match(seg, /const aviatorFresh = run\._lastAviatorFrameMono != null/);
  assert.match(seg, /if \(!aviatorFresh\) \{ try \{ run\.entryGate\.onDisconnect\(\)/);
});

test('wiring: START-from-Lobby does NOT gate on _everConfirmedAviator (case B differs from passive)', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'startAutoExecution');
  assert.ok(!/_everConfirmedAviator/.test(seg), 'explicit START must not require a prior confirmed Aviator');
});

test('wiring: autotest-start no-ops a duplicate START while an entry is already in flight', () => {
  const main = rd('desktop/main.cjs');
  const i = main.indexOf("handle('autotest-start'");
  const seg = main.slice(i, i + 1900);
  assert.match(seg, /run\.autoStartIntent\.inFlight\(\)\) return autoSnapshot\(run\)/);
  assert.match(seg, /run\.autoStartIntent\.markInFlight\(true\)/);
  assert.match(seg, /markInFlight\(false\)/);
});

test('wiring: autotest-stop cancels the pending start intent and drops ctx resume', () => {
  const main = rd('desktop/main.cjs');
  const i = main.indexOf("handle('autotest-stop'");
  const seg = main.slice(i, i + 1600);
  assert.match(seg, /run\.autoStartIntent\.cancel\(\)/);
  assert.match(seg, /run\._ctxResumeAfterReentry = false/);
  // A STOP that only cancelled a pending entry must not surface AUTO_TEST_NOT_RUNNING as a failure.
  assert.match(seg, /wasWaiting \|\| pendingStart/);
});

test('wiring: run close cancels the pending start intent (no late start after dispose)', () => {
  const main = rd('desktop/main.cjs');
  assert.match(main, /run\.autoStartIntent\) run\.autoStartIntent\.cancel\(\)/);
});

test('wiring: autoSnapshot exposes non-secret autoStartPendingEntry + aviatorContextState', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'autoSnapshot');
  assert.match(seg, /autoStartPendingEntry = !!\(run && run\.autoStartIntent && run\.autoStartIntent\.pending\(\)\)/);
  assert.match(seg, /aviatorContextState/);
});

test('7. LOGIN_REQUIRED: a login wall short-circuits BEFORE entry (no in-engine click spam)', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'startAutoExecution');
  const loginIdx = seg.indexOf("code: 'LOGIN_REQUIRED'");
  const entryIdx = seg.indexOf('entryGate.ensureEntered()');
  assert.ok(loginIdx !== -1 && entryIdx !== -1 && loginIdx < entryIdx, 'LOGIN_REQUIRED returns before ensureEntered');
  assert.match(seg, /looksLikeLoginUrl\(currentRunUrl\(run\)\)/);
});

test('19. passive recovery and explicit START share ONE sealed entry seam (ensureEntered)', () => {
  const main = rd('desktop/main.cjs');
  // Passive context recovery re-enters via ensureEntered...
  assert.match(fnSegment(main, 'applyAviatorContextAction'), /run\.entryGate\.ensureEntered\(\)/);
  // ...and the explicit START orchestration uses the SAME gate seam (no duplicate implementation).
  assert.match(fnSegment(main, 'startAutoExecution'), /run\.entryGate\.ensureEntered\(\)/);
});
