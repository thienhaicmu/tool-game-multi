import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// WU-MULTI-BROWSER-FEATURE-INDEPENDENCE — end-to-end acceptance matrix.
//
// This drives the WU's release-critical invariants (§9 Auto Run simultaneity,
// §14 Jackpot gate independence, §15 mixed config, §16 stop-while-waiting,
// §18 switch while running, §25 close ownership, §32 test matrix) through the
// REAL BrowserRunManager + REAL per-run subsystems, wired exactly as
// main.buildProtocolSubsystem wires them and sequenced exactly as the
// main.cjs `autotest-start` / `autotest-stop` IPC handlers sequence them.
//
// The point is ownership, not round mechanics: switching the active-run VIEW,
// starting/stopping one run, and one run's jackpot event must NEVER retarget,
// stop, or release another run.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { ProtocolHarness } = require('../../desktop/protocol/harness.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');
const { JackpotObserver } = require('../../desktop/protocol/jackpot-observer.cjs');
const { JackpotGate } = require('../../desktop/protocol/jackpot-gate.cjs');
const { AviatorEntryGate } = require('../../desktop/protocol/aviator-entry.cjs');
const { Stop1000Guard } = require('../../desktop/protocol/stop1000-guard.cjs');
const { BrowserRunManager, STATUS } = require('../../desktop/browser-run/browser-run-manager.cjs');

const tick = () => new Promise((r) => setTimeout(r, 5));

// Build ONE run's full per-run subsystem with the SAME modules main uses. `send`
// is injectable so no real socket is needed; entry is proven passively by a server
// round frame (exactly like production).
function makeSubsystem(id, sends) {
  const aviator = new RoundTracker({ ackWindowMs: 5000 });
  const getTargetUrl = () => `https://game.test/${id}`;
  const harness = new ProtocolHarness({
    roundTracker: aviator,
    ackTimeoutMs: 200,
    getTargetUrl,
    send: async (ctx, payload) => { sends.push({ id, ctx, payload }); return { ok: true }; },
  });
  const observer = new RoundObserver({ roundTracker: aviator });
  const autoRunner = new AutoRunner({ roundTracker: aviator, observer, harness, getTargetUrl });
  const jackpotObserver = new JackpotObserver({ roundTracker: aviator });
  const jackpotGate = new JackpotGate({ observer: jackpotObserver });
  const entryGate = new AviatorEntryGate({
    roundTracker: aviator,
    send: async () => ({ ok: true }),
    getContext: () => ({ targetId: id + '-T', wirePrefix: '' }),
  });
  const stop1000 = new Stop1000Guard({ observer, autoRunner, browserId: id, browserRunId: id });
  return { id, aviator, harness, observer, autoRunner, jackpotObserver, jackpotGate, entryGate, stop1000 };
}

// A two-run world routed through the real manager (createRun -> buildSubsystem).
function makeWorld() {
  const sends = { A: [], B: [] };
  const subs = {};
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ close() {}, async closeGraceful() { return { ok: true }; }, snapshot() { return {}; } }),
    createTargetManager: () => ({ async stop() {}, listTargets() { return []; }, getSession() {} }),
    buildSubsystem: (run) => {
      const key = run.ordinal === 0 ? 'A' : 'B';
      const s = makeSubsystem(key, sends[key]);
      subs[run.id] = { key, ...s };
      return s;
    },
  });
  const a = mgr.createRun({ browserId: 'B-0001' });
  const b = mgr.createRun({ browserId: 'B-0002' });
  a.selectedTargetId = 'TA'; b.selectedTargetId = 'TB';
  mgr.registerTarget('TA', a); mgr.registerTarget('TB', b);
  return { mgr, a, b, sends };
}

// Server round-lifecycle frame on a run's own socket. cmd 100005 (ROUND_OPEN) both
// registers the socket and proves Aviator entry; an eI.jp payload feeds the jackpot.
function feed(run, { sid = 1, cmd = 100005, jp = null } = {}) {
  const eI = jp != null ? `,"eI":{"jp":${jp}}` : '';
  const raw = `["6","MiniGame","aviatorPlugin",{"cmd":${cmd},"sid":${sid}${eI}}]`;
  run.aviator.observe({ targetId: run.selectedTargetId, cdpSessionId: 'S', url: 'wss://game.host/ws', direction: 'recv', raw });
}

// EXACT mirror of main.cjs `autotest-start` sequencing (entry -> optional jackpot
// gate -> autoRunner.start -> stop1000.arm). Bound to an EXPLICIT run, never a
// selection pointer. Returns the start promise so a gate-wait can be observed.
async function startAuto(run, cfg = {}) {
  if (run.entryGate) { const g = await run.entryGate.ensureEntered(); if (g && g.error) return { error: g.error }; }
  if (cfg.waitForJackpot) {
    const t = Number(cfg.jackpotThreshold);
    if (!Number.isFinite(t) || t < 0) return { error: { code: 'INVALID_JACKPOT_THRESHOLD' } };
    if (run.jackpotGate) { const jg = await run.jackpotGate.ensureThreshold(t); if (jg && jg.error) return { error: jg.error }; }
  }
  run._runConfig = { ...cfg };
  const res = run.autoRunner.start(String(run.selectedTargetId || ''), cfg);
  if (res.error) return res;
  if (run.stop1000) run.stop1000.arm(run._runConfig);
  return run.autoRunner.snapshot();
}

// EXACT mirror of main.cjs `autotest-stop` (cancel gate -> disarm stop1000 -> stop).
function stopAuto(run) {
  const wasWaiting = !!(run.jackpotGate && run.jackpotGate.isWaiting());
  if (run.jackpotGate) run.jackpotGate.cancel('STOPPED');
  if (run.stop1000) run.stop1000.disarm();
  const res = run.autoRunner.stop();
  if (res.error && wasWaiting) return run.autoRunner.snapshot();
  return res.error ? res : run.autoRunner.snapshot();
}

// ---------------------------------------------------------------------------
// §9 / §32 A–F — Auto Run simultaneity + selection is view-only.
// ---------------------------------------------------------------------------
test('§9 two runs Auto simultaneously; switching the active view never stops either', async () => {
  const { mgr, a, b } = makeWorld();
  feed(a, { sid: 10 }); feed(b, { sid: 20 });

  // B1 START, then B2 START (the exact user reproduction order).
  mgr.setActive(a.id); await startAuto(a, { roundCount: 5, amount: 5000, stopOdd: 2 });
  assert.equal(mgr.summary(a).autoRunning, true, 'B1 AUTO_RUNNING');

  mgr.setActive(b.id); await startAuto(b, { roundCount: 5, amount: 5000, stopOdd: 2 });
  assert.equal(mgr.summary(a).autoRunning, true, 'B1 still running after B2 start');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 AUTO_RUNNING');

  // Switch selection repeatedly: view-only, no execution change (§5/§18/§23).
  for (const id of [a.id, b.id, a.id, b.id, a.id]) mgr.setActive(id);
  assert.equal(mgr.summary(a).autoRunning, true, 'B1 unchanged across switches');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 unchanged across switches');

  // Stop B1 only -> B2 continues.
  stopAuto(a);
  assert.equal(mgr.summary(a).autoRunning, false, 'B1 stopped');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 still running');

  // Restart B1 -> both running.
  feed(a, { sid: 11 });
  await startAuto(a, { roundCount: 5, amount: 5000, stopOdd: 2 });
  assert.equal(mgr.summary(a).autoRunning, true, 'B1 running again');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 still running');

  // Stop B2 only -> B1 continues.
  stopAuto(b);
  assert.equal(mgr.summary(b).autoRunning, false, 'B2 stopped');
  assert.equal(mgr.summary(a).autoRunning, true, 'B1 still running');
});

// ---------------------------------------------------------------------------
// §14 / §32 G–J — Jackpot gate independence: different thresholds, no cross-release.
// ---------------------------------------------------------------------------
test('§14 two runs both WAITING_JACKPOT release independently at their own thresholds', async () => {
  const { mgr, a, b } = makeWorld();
  // Entry proven + initial jackpot below both thresholds.
  feed(a, { sid: 1, cmd: 100008, jp: 50 });
  feed(b, { sid: 1, cmd: 100008, jp: 50 });

  const pA = startAuto(a, { roundCount: 3, amount: 5000, stopOdd: 2, waitForJackpot: true, jackpotThreshold: 100 });
  const pB = startAuto(b, { roundCount: 3, amount: 5000, stopOdd: 2, waitForJackpot: true, jackpotThreshold: 200 });
  await tick();

  assert.equal(mgr.summary(a).jackpotGateState, 'WAITING', 'B1 WAITING_JACKPOT');
  assert.equal(mgr.summary(b).jackpotGateState, 'WAITING', 'B2 WAITING_JACKPOT');
  assert.equal(mgr.summary(a).autoRunning, false, 'B1 not betting while waiting');
  assert.equal(mgr.summary(b).autoRunning, false, 'B2 not betting while waiting');

  // Only B1 reaches its threshold -> only B1 releases; B2 keeps waiting (no cross-release).
  feed(a, { sid: 2, cmd: 100008, jp: 110 });
  await pA; await tick();
  assert.equal(mgr.summary(a).autoRunning, true, 'B1 released -> AUTO_RUNNING');
  assert.equal(mgr.summary(b).jackpotGateState, 'WAITING', 'B2 still WAITING after B1 release');
  assert.equal(mgr.summary(b).autoRunning, false, 'B2 not started by B1 jackpot');

  // Now B2 reaches its own (higher) threshold.
  feed(b, { sid: 2, cmd: 100008, jp: 210 });
  await pB; await tick();
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 released at its own threshold');

  // Per-run jackpot values never collapse into a shared value.
  assert.equal(mgr.summary(a).currentJackpot, 110);
  assert.equal(mgr.summary(b).currentJackpot, 210);
});

// ---------------------------------------------------------------------------
// §15 / §32 — Mixed configuration: gate ON vs gate OFF are independent.
// ---------------------------------------------------------------------------
test('§15 B1 gate ON waits while B2 gate OFF starts immediately', async () => {
  const { mgr, a, b } = makeWorld();
  feed(a, { sid: 1, cmd: 100008, jp: 10 });
  feed(b, { sid: 1 });

  const pA = startAuto(a, { roundCount: 3, amount: 5000, stopOdd: 2, waitForJackpot: true, jackpotThreshold: 100 });
  await startAuto(b, { roundCount: 3, amount: 5000, stopOdd: 2 }); // gate OFF
  await tick();

  assert.equal(mgr.summary(a).jackpotGateState, 'WAITING', 'B1 waits');
  assert.equal(mgr.summary(a).autoRunning, false, 'B1 not running yet');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 runs immediately, unaffected by B1 gate');

  feed(a, { sid: 2, cmd: 100008, jp: 150 });
  await pA;
  assert.equal(mgr.summary(a).autoRunning, true, 'B1 releases on its own jackpot');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 still running');
});

// ---------------------------------------------------------------------------
// §16 / §32 K — Stop while waiting cancels only that run's gate; a later jackpot
// event must NOT resurrect the stopped run.
// ---------------------------------------------------------------------------
test('§16 stopping a WAITING run cancels only its gate; B2 auto untouched', async () => {
  const { mgr, a, b } = makeWorld();
  feed(a, { sid: 1, cmd: 100008, jp: 10 });
  feed(b, { sid: 1 });
  await startAuto(b, { roundCount: 3, amount: 5000, stopOdd: 2 });   // B2 AUTO_RUNNING
  const pA = startAuto(a, { roundCount: 3, amount: 5000, stopOdd: 2, waitForJackpot: true, jackpotThreshold: 100 });
  await tick();
  assert.equal(mgr.summary(a).jackpotGateState, 'WAITING');

  // Stop B1 while it waits.
  stopAuto(a);
  const rA = await pA;
  assert.equal(rA.error.code, 'JACKPOT_GATE_CANCELLED', 'B1 wait cancelled');
  assert.equal(mgr.summary(a).jackpotGateState, 'IDLE', 'B1 gate idle after stop');
  assert.equal(mgr.summary(a).autoRunning, false, 'B1 not running');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 untouched by B1 stop');

  // A later qualifying jackpot on B1 must NOT start the stopped run.
  feed(a, { sid: 2, cmd: 100008, jp: 999 });
  await tick();
  assert.equal(mgr.summary(a).autoRunning, false, 'stopped B1 never resurrected by a later jackpot');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 still running');
});

// ---------------------------------------------------------------------------
// §19 / §32 M — Per-run Auto config is snapshotted independently at Start.
// ---------------------------------------------------------------------------
test('§19 starting B2 does not mutate B1 running config', async () => {
  const { mgr, a, b } = makeWorld();
  feed(a, { sid: 1 }); feed(b, { sid: 1 });
  await startAuto(a, { roundCount: 10, amount: 5000, stopOdd: 2 });
  await startAuto(b, { roundCount: 50, amount: 10000, stopOdd: 3 });
  const ca = a.autoRunner.snapshot().config;
  const cb = b.autoRunner.snapshot().config;
  assert.equal(ca.roundCount, 10); assert.equal(ca.amount, 5000); assert.equal(ca.stopOdd, 2);
  assert.equal(cb.roundCount, 50); assert.equal(cb.amount, 10000); assert.equal(cb.stopOdd, 3);
  // B1's snapshot config is unchanged by B2's start.
  assert.deepEqual(a.autoRunner.snapshot().config, ca);
});

// ---------------------------------------------------------------------------
// §25 / §32 N — Closing B1 tears down only B1; B2 keeps running.
// ---------------------------------------------------------------------------
test('§25 closeRun(B1) stops only B1; B2 auto survives', async () => {
  const { mgr, a, b } = makeWorld();
  feed(a, { sid: 1 }); feed(b, { sid: 1 });
  await startAuto(a, { roundCount: 3, amount: 5000, stopOdd: 2 });
  await startAuto(b, { roundCount: 3, amount: 5000, stopOdd: 2 });

  await mgr.closeRun(a.id);
  assert.equal(a.status, STATUS.CLOSED);
  assert.equal(a.autoRunner.isRunning(), false, 'B1 auto stopped by close');
  assert.equal(mgr.summary(b).autoRunning, true, 'B2 still running after B1 close');
  assert.equal(mgr.runForTarget('TB').id, b.id, 'B2 target routing intact');
});
