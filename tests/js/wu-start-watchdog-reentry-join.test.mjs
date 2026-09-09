import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AviatorEntryGate } = require('../../desktop/protocol/aviator-entry.cjs');
const { AutoStartIntent } = require('../../desktop/browser-run/auto-start-intent.cjs');

const rd = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
function fnSegment(src, name) {
  const start = src.indexOf('function ' + name);
  assert.notEqual(start, -1, `expected function ${name} in source`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}
const tick = () => new Promise((r) => setImmediate(r));
const DESCRIPTOR = { gameActUrl: 'https://host.example/gwms/v1/game-act', gameId: 'vgmn_221' };

// ---------------------------------------------------------------------------
// GATE-LEVEL — isEntering() lets a second ensureEntered JOIN the ONE canonical
// in-flight attempt instead of tearing it down. This is the core of the fix.
// ---------------------------------------------------------------------------
function countingGate({ timeoutMs = 200 } = {}) {
  const bus = new EventEmitter();
  let enterCalls = 0;
  const gate = new AviatorEntryGate({
    roundTracker: bus,
    enterAviator: () => { enterCalls += 1; return Promise.resolve({ ok: true }); },
    getDescriptor: () => DESCRIPTOR,
    getContext: () => ({ targetId: 'T1', cdpSessionId: 'S', host: 'h' }),
    timeoutMs,
  });
  return { gate, bus, enterCount: () => enterCalls, evidence: () => bus.emit('frame', { direction: 'recv', cmd: 100005, sid: 1 }) };
}

test('isEntering() is true while an attempt is in flight; the guarded watchdog onDisconnect is SKIPPED and a 2nd ensureEntered JOINS (one entry)', async () => {
  const h = countingGate({ timeoutMs: 1000 });
  const p1 = h.gate.ensureEntered();               // explicit START starts the canonical attempt
  assert.equal(h.gate.isEntering(), true);
  assert.equal(h.enterCount(), 1);
  // Watchdog REENTER (the fixed guard): only onDisconnect when NOT already entering.
  if (!h.gate.isEntering()) h.gate.onDisconnect();  // <- skipped, so the attempt survives
  const p2 = h.gate.ensureEntered();               // JOINS the same _pending
  assert.equal(h.enterCount(), 1, 'no second Cocos invocation');
  h.evidence();                                     // fresh authoritative server evidence
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ready, true);
  assert.equal(r2.ready, true);
  assert.equal(h.gate.isEntered(), true);
});

test('guarded onDisconnect STILL clears a stale entered flag when NOT entering (protection preserved)', async () => {
  const h = countingGate({ timeoutMs: 1000 });
  const p = h.gate.ensureEntered();
  h.evidence();
  await p;
  assert.equal(h.gate.isEntered(), true);
  assert.equal(h.gate.isEntering(), false);         // entered, no attempt in flight
  if (!h.gate.isEntering()) h.gate.onDisconnect();   // stale-flag path runs
  assert.equal(h.gate.isEntered(), false, 'stale entered flag invalidated (INVOKED != ACTIVE preserved)');
});

test('duplicate ensureEntered while pending never invokes a second entry (dedup)', async () => {
  const h = countingGate({ timeoutMs: 1000 });
  const a = h.gate.ensureEntered();
  const b = h.gate.ensureEntered();
  const c = h.gate.ensureEntered();
  assert.equal(h.enterCount(), 1);
  h.evidence();
  await Promise.all([a, b, c]);
  assert.equal(h.enterCount(), 1);
});

// ---------------------------------------------------------------------------
// FULL-RACE HARNESS — real AviatorEntryGate + real AutoStartIntent + a recording
// runner, plus faithful miniatures of startAutoExecution's cancellation checkpoints
// and the watchdog REENTER guard. Proves ONE entry + ONE start across orderings.
// ---------------------------------------------------------------------------
function harness() {
  const bus = new EventEmitter();
  let enterCalls = 0;
  const runner = {
    started: [], running: false, _paused: false,
    start() { if (this.running) return { error: { code: 'AUTO_TEST_ALREADY_RUNNING' } }; this.running = true; this.started.push(1); return { ok: true, autoExecutionId: `AX-${this.started.length}` }; },
    stop() { if (!this.running) return { error: { code: 'AUTO_TEST_NOT_RUNNING' } }; this.running = false; return { ok: true }; },
    isRunning() { return this.running; }, pausedForRecovery() { return this._paused; }, autoExecutionId() { return null; },
  };
  const gate = new AviatorEntryGate({
    roundTracker: bus,
    enterAviator: () => { enterCalls += 1; return Promise.resolve({ ok: true }); },
    getDescriptor: () => DESCRIPTOR,
    getContext: () => ({ targetId: 'T1', cdpSessionId: 'S', host: 'h' }),
    timeoutMs: 200,
  });
  const intent = new AutoStartIntent();
  const run = { status: 'ACTIVE', autoStartIntent: intent, entryGate: gate, autoRunner: runner, _ctxReentryInFlight: false, _ctxResumeAfterReentry: false };

  // Mirrors startAutoExecution: stale-flag guard (skipped when a ctx re-entry is in flight),
  // ensureEntered, then cancellation checkpoints before the ONE runner.start.
  async function startAuto() {
    const token = intent.begin();
    const cancelled = () => intent.cancelled(token) || run.status === 'CLOSED';
    intent.markInFlight(true);
    try {
      if (gate.isEntered() && !run._ctxReentryInFlight) gate.onDisconnect(); // START-side stale-flag guard
      const g = await gate.ensureEntered();
      if (g && g.error) return { error: g.error };
      if (cancelled()) return { error: { code: 'AUTO_START_CANCELLED' } };
      const res = runner.start();
      if (res.error) return res;
      return { ok: true };
    } finally { intent.finish(); intent.markInFlight(false); }
  }
  async function startAutoViaHandler() {              // mirrors the autotest-start duplicate guard
    if (intent.inFlight()) return { duplicate: true };
    return startAuto();
  }
  // Mirrors applyAviatorContextAction REENTER with the FIX (guarded onDisconnect).
  function watchdogReenter() {
    const wasRunning = runner.isRunning();
    if (wasRunning) runner.stop();
    run._ctxReentryInFlight = true;
    run._ctxResumeAfterReentry = wasRunning;
    if (!gate.isEntering()) gate.onDisconnect();        // <- the fix: JOIN, don't tear down
    return gate.ensureEntered().then((res) => {
      run._ctxReentryInFlight = false;
      if (res && res.ready && run._ctxResumeAfterReentry && runner.pausedForRecovery()) runner.start(); // resume path
    }).catch(() => { run._ctxReentryInFlight = false; });
  }
  function stop() { intent.cancel(); run._ctxResumeAfterReentry = false; runner.stop(); }
  const evidence = () => bus.emit('frame', { direction: 'recv', cmd: 100005, sid: 1 });
  const nonEvidence = () => bus.emit('frame', { direction: 'recv', cmd: 99999 }); // not a round-lifecycle cmd
  return { run, gate, intent, runner, startAuto, startAutoViaHandler, watchdogReenter, stop, evidence, nonEvidence, enterCount: () => enterCalls };
}

test('1. START then watchdog REENTER (same window) → one entry, one Cocos, AutoRunner starts once', async () => {
  const h = harness();
  const p = h.startAuto();
  await tick();
  assert.equal(h.enterCount(), 1);
  assert.equal(h.gate.isEntering(), true);
  const w = h.watchdogReenter();                 // joins the START's attempt
  await tick();
  assert.equal(h.enterCount(), 1, 'no parallel second Cocos entry');
  h.evidence();
  const r = await p; await w;
  assert.equal(r.ok, true);
  assert.equal(h.runner.started.length, 1);      // AUTORUN_STARTED exactly once
});

test('2. watchdog REENTER then START (same window) → one entry, one Cocos, AutoRunner starts once', async () => {
  const h = harness();
  const w = h.watchdogReenter();
  await tick();
  assert.equal(h.enterCount(), 1);
  const p = h.startAuto();                        // _ctxReentryInFlight true → joins
  await tick();
  assert.equal(h.enterCount(), 1, 'no parallel second Cocos entry');
  h.evidence();
  await w; const r = await p;
  assert.equal(r.ok, true);
  assert.equal(h.runner.started.length, 1);
});

test('3. START during recovery + STOP before ACTIVE → later ACTIVE does NOT start AutoRunner', async () => {
  const h = harness();
  const p = h.startAuto();
  const w = h.watchdogReenter();
  await tick();
  h.stop();                                       // STOP wins
  h.evidence();
  const r = await p; await w;
  assert.equal(r.error.code, 'AUTO_START_CANCELLED');
  assert.equal(h.runner.started.length, 0);
});

test('4. duplicate START during recovery → one entry, one AutoRunner execution', async () => {
  const h = harness();
  const w = h.watchdogReenter();
  await tick();
  const p1 = h.startAutoViaHandler();
  await tick();
  const p2 = h.startAutoViaHandler();             // duplicate while pending → no-op
  const r2 = await p2;
  assert.deepEqual(r2, { duplicate: true });
  h.evidence();
  await w; const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(h.enterCount(), 1);
  assert.equal(h.runner.started.length, 1);
});

test('5. recovery timeout (no evidence) → START fails, AutoRunner stays OFF (no fabricated ACTIVE)', async () => {
  const h = harness();
  const p = h.startAuto();
  const w = h.watchdogReenter();
  const r = await p; await w;                     // 200ms timeout, no evidence emitted
  assert.equal(r.error.code, 'AVIATOR_ENTRY_TIMEOUT');
  assert.equal(h.runner.started.length, 0);
  assert.equal(h.gate.isEntered(), false);
});

test('6. stale/non-authoritative evidence never confirms ACTIVE; only a real server round frame does', async () => {
  const h = harness();
  const p = h.startAuto();
  await tick();
  // A non-round-lifecycle recv frame must NOT mark entered.
  h.nonEvidence();
  assert.equal(h.gate.isEntered(), false);
  h.evidence();                                   // authoritative ROUND_OPEN
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(h.gate.isEntered(), true);
});

test('7. B1 recovery + B2 START remain isolated (no cross-entry, no cross-start)', async () => {
  const b1 = harness();
  const b2 = harness();
  const w1 = b1.watchdogReenter();
  const p2 = b2.startAuto();
  await tick();
  assert.equal(b1.enterCount(), 1);
  assert.equal(b2.enterCount(), 1);
  b1.evidence();                                  // only B1 gets evidence
  await w1;
  await tick();
  assert.equal(b2.runner.started.length, 0, 'B2 not started by B1 evidence');
  b2.evidence();
  await p2;
  assert.equal(b2.runner.started.length, 1);
  assert.equal(b1.runner.started.length, 0, 'B1 was Auto-OFF passive recovery — stays OFF');
});

test('8. passive: Auto OFF + prior ACTIVE + kick → re-enter → ACTIVE → Auto stays OFF', async () => {
  const h = harness();
  const w = h.watchdogReenter();                  // wasRunning=false, no START intent
  await tick();
  h.evidence();
  await w;
  assert.equal(h.runner.started.length, 0);       // no unsolicited Auto start
  assert.equal(h.gate.isEntered(), true);
});

// ---------------------------------------------------------------------------
// SOURCE-INTEGRATION — the main.cjs / gate wiring for the fix.
// ---------------------------------------------------------------------------
test('wiring: watchdog REENTER guards onDisconnect with !isEntering() (joins an in-flight START)', () => {
  const seg = fnSegment(rd('desktop/main.cjs'), 'applyAviatorContextAction');
  assert.match(seg, /if \(run\.entryGate && !run\.entryGate\.isEntering\(\)\) run\.entryGate\.onDisconnect\(\)/);
  // ensureEntered is still called right after — so a skipped teardown means we JOIN the attempt.
  const disc = seg.indexOf('!run.entryGate.isEntering()');
  const ens = seg.indexOf('run.entryGate.ensureEntered()');
  assert.ok(disc !== -1 && ens !== -1 && disc < ens, 'guarded onDisconnect precedes the joining ensureEntered');
});

test('wiring: AviatorEntryGate exposes isEntering() reflecting the single _pending attempt', () => {
  const src = rd('desktop/protocol/aviator-entry.cjs');
  assert.match(src, /isEntering\(\)\s*\{\s*return !!this\._pending;\s*\}/);
});
