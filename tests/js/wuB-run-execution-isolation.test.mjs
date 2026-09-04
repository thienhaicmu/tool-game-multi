import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { ProtocolHarness } = require('../../desktop/protocol/harness.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');
const { AmountValidator } = require('../../desktop/protocol/amount-validator.cjs');
const { BrowserRunManager, STATUS } = require('../../desktop/browser-run/browser-run-manager.cjs');

// Build ONE run's real subsystem, exactly as main.buildProtocolSubsystem wires it
// (per-run RoundTracker/harness/observer/autoRunner) but with an injectable send.
function makeSubsystem(id, sends, ackTimeoutMs = 150) {
  const tracker = new RoundTracker({ ackWindowMs: 5000 });
  const harness = new ProtocolHarness({
    roundTracker: tracker,
    ackTimeoutMs,
    getTargetUrl: () => `https://game.test/${id}`,
    send: async (ctx, payload) => { sends.push({ id, ctx, payload }); return { ok: true }; },
  });
  const observer = new RoundObserver({ roundTracker: tracker });
  const getTargetUrl = () => `https://game.test/${id}`;
  const autoRunner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl });
  const amountValidator = new AmountValidator({ roundTracker: tracker, harness, getTargetUrl });
  return { id, aviator: tracker, harness, observer, autoRunner, amountValidator };
}

// Feed a server frame to a run's tracker on a given target (registers the socket).
function feed(run, raw, targetId) {
  run.aviator.observe({ targetId, cdpSessionId: 'S', url: 'wss://game.host/ws', direction: 'recv', raw });
}
const openRound = (sid) => `{"cmd":100005,"sid":${sid}}`;
const oddFrame = (sid, odd) => `{"cmd":100009,"sid":${sid},"odd":${odd}}`;
const betAck = '{"cmd":100002,"eid":1,"b":5000}';

// ---------------------------------------------------------------------------
// SID / ODD isolation: run A's server stream never touches run B.
// ---------------------------------------------------------------------------
test('server SID/ODD for run A do not affect run B', () => {
  const A = makeSubsystem('A', []);
  const B = makeSubsystem('B', []);
  feed(A, openRound(111), 'TA');
  feed(A, oddFrame(111, 3.5), 'TA');
  assert.equal(A.observer.currentRound().sid, 111);
  assert.equal(A.observer.currentRound().currentOdd, 3.5);
  assert.equal(B.observer.currentRound(), null, 'B observed nothing');

  feed(B, openRound(222), 'TB');
  assert.equal(B.observer.currentRound().sid, 222);
  assert.equal(A.observer.currentRound().sid, 111, 'A unchanged by B');
});

// ---------------------------------------------------------------------------
// Send seam: a send resolves only the OWNING target's socket (no fallback).
// ---------------------------------------------------------------------------
test('run A cannot send through run B socket', async () => {
  const sendsA = [];
  const A = makeSubsystem('A', sendsA);
  const B = makeSubsystem('B', []);
  feed(B, openRound(222), 'TB');          // socket exists only on B / target TB
  feed(A, openRound(222), 'TA');          // A has its own round + socket TA

  // A sends for a target that has no socket in A's tracker -> fails, no fallback.
  const ex = await A.harness.execute({ targetId: 'TB', payload: { cmd: 100002, b: 5000, sid: 222, aid: 1, eid: 1 } });
  assert.equal(ex.result, 'ERROR');
  assert.equal(ex.error.code, 'TEST_SESSION_UNAVAILABLE');
  assert.equal(sendsA.length, 0);
});

// ---------------------------------------------------------------------------
// ACK isolation: a frame on run B's stream cannot resolve run A's waiter.
// ---------------------------------------------------------------------------
test('run B ACK frame does not resolve run A waiter', async () => {
  const sendsA = [];
  const A = makeSubsystem('A', sendsA, 120);
  const B = makeSubsystem('B', []);
  feed(A, openRound(300), 'TA');

  const pa = A.harness.execute({ targetId: 'TA', command: 'bet' }); // A waiter now pending
  // The ack arrives on B's stream only — must NOT complete A.
  B.aviator.observe({ direction: 'recv', raw: betAck });
  const ex = await pa;
  assert.equal(ex.result, 'TIMEOUT', 'A never saw an ack on its own stream');
  assert.equal(sendsA.length, 1);
});

test('run A ACK on its own stream resolves its own waiter', async () => {
  const A = makeSubsystem('A', [], 300);
  feed(A, openRound(301), 'TA');
  const pa = A.harness.execute({ targetId: 'TA', command: 'bet' });
  setTimeout(() => A.aviator.observe({ direction: 'recv', raw: betAck }), 15);
  const ex = await pa;
  assert.equal(ex.result, 'ACK');
});

// ---------------------------------------------------------------------------
// Concurrency: two AutoRunners run at the same time, fully independent.
// ---------------------------------------------------------------------------
test('two AutoRunners run concurrently and stay independent', () => {
  const sendsA = [];
  const sendsB = [];
  const A = makeSubsystem('A', sendsA);
  const B = makeSubsystem('B', sendsB);
  feed(A, openRound(10), 'TA'); // register socket TA
  feed(B, openRound(20), 'TB'); // register socket TB

  assert.equal(A.autoRunner.start('TA', { roundCount: 5, amount: 5000, stopOdd: 2 }).ok, true);
  assert.equal(B.autoRunner.start('TB', { roundCount: 5, amount: 5000, stopOdd: 2 }).ok, true);
  assert.equal(A.autoRunner.isRunning(), true);
  assert.equal(B.autoRunner.isRunning(), true);

  // A new round opens on A only -> only A places a bet.
  feed(A, openRound(11), 'TA');
  assert.equal(sendsA.length, 1, 'A placed its bet');
  assert.equal(sendsB.length, 0, 'B untouched by A\'s round');

  // Now a round opens on B only.
  feed(B, openRound(21), 'TB');
  assert.equal(sendsB.length, 1, 'B placed its own bet');
  assert.equal(sendsA.length, 1, 'A unaffected by B\'s round');
});

// ---------------------------------------------------------------------------
// Switching the active-run VIEW pointer does not retarget a running execution.
// ---------------------------------------------------------------------------
test('changing activeRunId never retargets or stops a running AutoRunner', () => {
  const subs = { A: makeSubsystem('A', []), B: makeSubsystem('B', []) };
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ close() {}, snapshot() { return {}; } }),
    createTargetManager: () => ({ async stop() {}, listTargets() { return []; }, getSession() {} }),
    buildSubsystem: (run) => subs[run.id === 'BR-0001' ? 'A' : 'B'],
  });
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  feed(subs.A, openRound(10), 'TA');
  a.selectedTargetId = 'TA';
  a.autoRunner.start('TA', { roundCount: 3, amount: 5000, stopOdd: 2 });

  // View switches to B; A must keep running and stay bound to TA.
  mgr.setActive(b.id);
  assert.equal(mgr.activeRun().id, b.id);
  assert.equal(a.autoRunner.isRunning(), true, 'A still running after view switch');

  // Stopping B does nothing to A (explicit-run binding).
  b.autoRunner.stop();
  assert.equal(a.autoRunner.isRunning(), true);
});

// ---------------------------------------------------------------------------
// Close isolation: closing run A stops only A and resolves only A's waiters.
// ---------------------------------------------------------------------------
test('closeRun(A) stops A and cancels A waiters; B keeps running with its waiter', async () => {
  const subs = { A: makeSubsystem('A', [], 5000), B: makeSubsystem('B', [], 5000) };
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ close() {}, snapshot() { return {}; } }),
    createTargetManager: () => ({ async stop() {}, listTargets() { return []; }, getSession() {} }),
    buildSubsystem: (run) => subs[run.id === 'BR-0001' ? 'A' : 'B'],
  });
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  mgr.registerTarget('TA', a);
  mgr.registerTarget('TB', b);
  feed(subs.A, openRound(10), 'TA');
  feed(subs.B, openRound(20), 'TB');
  a.autoRunner.start('TA', { roundCount: 3, amount: 5000, stopOdd: 2 });
  b.autoRunner.start('TB', { roundCount: 3, amount: 5000, stopOdd: 2 });

  // Each run places a bet -> each harness has one pending ACK waiter. The waiter is
  // created after the async send resolves, so let microtasks/timers flush first.
  feed(subs.A, openRound(11), 'TA');
  feed(subs.B, openRound(21), 'TB');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(subs.A.harness._waiters.length, 1);
  assert.equal(subs.B.harness._waiters.length, 1);

  await mgr.closeRun(a.id);

  assert.equal(a.status, STATUS.CLOSED);
  assert.equal(subs.A.autoRunner.isRunning(), false, 'A auto stopped');
  assert.equal(subs.A.harness._waiters.length, 0, 'A waiters cancelled');
  // B is completely untouched.
  assert.equal(subs.B.autoRunner.isRunning(), true, 'B still running');
  assert.equal(subs.B.harness._waiters.length, 1, 'B waiter intact');
  assert.equal(mgr.runForTarget('TB').id, b.id);
});
