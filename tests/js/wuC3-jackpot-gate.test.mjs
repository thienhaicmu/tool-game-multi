import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { JackpotGate, STATE } = require('../../desktop/protocol/jackpot-gate.cjs');

// Controllable per-run jackpot observer stand-in.
function makeObs(initial = null) {
  const e = new EventEmitter();
  let v = initial;
  e.current = () => v;
  e.set = (n) => { v = n; e.emit('update'); };
  return e;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// §59 — exact threshold is READY immediately (>=, not >).
test('exact threshold releases immediately', async () => {
  const obs = makeObs(50000000);
  const gate = new JackpotGate({ observer: obs });
  const res = await gate.ensureThreshold(50000000);
  assert.equal(res.ready, true);
  assert.equal(gate.state(), STATE.READY);
});

// §60 — already above threshold releases immediately, no waiting for a new update.
test('already-above threshold releases immediately', async () => {
  const obs = makeObs(67214618);
  const gate = new JackpotGate({ observer: obs });
  const res = await gate.ensureThreshold(50000000);
  assert.equal(res.ready, true);
  assert.equal(res.jackpot, 67214618);
});

// §58 — below threshold waits.
test('below threshold waits (WAITING, no release)', async () => {
  const obs = makeObs(49999999);
  const gate = new JackpotGate({ observer: obs });
  let resolved = false;
  gate.ensureThreshold(50000000).then(() => { resolved = true; });
  await tick();
  assert.equal(gate.isWaiting(), true);
  assert.equal(resolved, false);
});

// §61 — unknown then reaching the threshold releases exactly at the crossing value.
test('unknown -> updates -> release only when >= threshold', async () => {
  const obs = makeObs(null);
  const gate = new JackpotGate({ observer: obs });
  const p = gate.ensureThreshold(50000000);
  await tick(); assert.equal(gate.isWaiting(), true);
  obs.set(40000000); await tick(); assert.equal(gate.isWaiting(), true);
  obs.set(49999999); await tick(); assert.equal(gate.isWaiting(), true);
  obs.set(50000000);
  const res = await p;
  assert.equal(res.ready, true);
  assert.equal(res.jackpot, 50000000);
});

// §62 — exactly-once release across repeated qualifying frames.
test('release fires exactly once across repeated qualifying updates', async () => {
  const obs = makeObs(null);
  const gate = new JackpotGate({ observer: obs });
  let releases = 0;
  gate.ensureThreshold(50000000).then((r) => { if (r.ready) releases += 1; });
  obs.set(50000000); await tick();
  obs.set(60000000); await tick();
  obs.set(70000000); await tick();
  assert.equal(releases, 1);
  // A subsequent ensureThreshold is idempotent-ready (still one logical release event).
  const again = await gate.ensureThreshold(50000000);
  assert.equal(again.ready, true);
  assert.equal(releases, 1);
});

// §63 — manual STOP while waiting cancels; later updates never release.
test('cancel while waiting: later updates never release', async () => {
  const obs = makeObs(40000000);
  const gate = new JackpotGate({ observer: obs });
  let started = 0;
  gate.ensureThreshold(50000000).then((r) => { if (r.ready) started += 1; });
  await tick();
  gate.cancel('STOPPED');
  assert.equal(gate.state(), STATE.IDLE);
  obs.set(100000000); await tick();
  assert.equal(started, 0, 'no release after cancel');
});

// §66 — disconnect while waiting cancels the pending gate.
test('disconnect while waiting cancels the pending gate', async () => {
  const obs = makeObs(40000000);
  const gate = new JackpotGate({ observer: obs });
  const p = gate.ensureThreshold(50000000);
  await tick();
  gate.onDisconnect();
  const res = await p;
  assert.equal(res.error.code, 'JACKPOT_GATE_CANCELLED');
  obs.set(100000000); await tick();
  assert.equal(gate.state(), STATE.IDLE);
});

// §64 — cross-run isolation: another run's jackpot never releases this gate.
test('cross-run isolation: only the OWN observer releases the gate', async () => {
  const obsA = makeObs(40000000);
  const obsB = makeObs(100000000);
  const gateA = new JackpotGate({ observer: obsA });
  let aReleased = false;
  gateA.ensureThreshold(50000000).then((r) => { if (r.ready) aReleased = true; });
  await tick();
  // B's high jackpot changes nothing for A.
  obsB.set(120000000); await tick();
  assert.equal(gateA.isWaiting(), true);
  assert.equal(aReleased, false);
  // Only A's own update releases A.
  obsA.set(50000000); await tick();
  assert.equal(aReleased, true);
});

// §65 — concurrent gates, independent thresholds.
test('concurrent gates release independently', async () => {
  const obsA = makeObs(null); const obsB = makeObs(null);
  const gateA = new JackpotGate({ observer: obsA });
  const gateB = new JackpotGate({ observer: obsB });
  let a = false, b = false;
  gateA.ensureThreshold(50000000).then((r) => { if (r.ready) a = true; });
  gateB.ensureThreshold(70000000).then((r) => { if (r.ready) b = true; });
  obsA.set(50000000); await tick();
  assert.equal(a, true);
  assert.equal(gateB.isWaiting(), true, 'B still waiting');
  assert.equal(b, false);
  obsB.set(70000000); await tick();
  assert.equal(b, true);
});

// §26 — invalid thresholds are rejected (never silently 0).
test('invalid thresholds are rejected', async () => {
  const gate = new JackpotGate({ observer: makeObs(100) });
  assert.equal((await gate.ensureThreshold(NaN)).error.code, 'INVALID_JACKPOT_THRESHOLD');
  assert.equal((await gate.ensureThreshold(-1)).error.code, 'INVALID_JACKPOT_THRESHOLD');
  assert.equal((await gate.ensureThreshold(Infinity)).error.code, 'INVALID_JACKPOT_THRESHOLD');
});

// §67 — order: entry gate resolves BEFORE the jackpot gate is evaluated, and the
// AutoRunner starts only after both. Modeled with the real gates + a fake runner.
test('order: entry READY -> jackpot READY -> AutoRunner.start (exactly once)', async () => {
  const { AviatorEntryGate } = require('../../desktop/protocol/aviator-entry.cjs');
  const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
  const order = [];
  const entryTracker = new RoundTracker({ ackWindowMs: 5000 });
  const entry = new AviatorEntryGate({
    roundTracker: entryTracker,
    send: async () => { order.push('enter-sent'); return { ok: true }; },
    getContext: () => ({ targetId: 'T', wirePrefix: '' }),
    timeoutMs: 1000,
  });
  const obs = makeObs(null);
  const gate = new JackpotGate({ observer: obs });
  let starts = 0;
  const fakeStart = () => { order.push('auto-start'); starts += 1; };

  // Simulate the main handler sequence.
  const run = (async () => {
    const e = await entry.ensureEntered();
    assert.equal(e.ready, true); order.push('entered');
    const j = await gate.ensureThreshold(50000000);
    assert.equal(j.ready, true); order.push('jackpot-ready');
    fakeStart();
  })();

  await tick();
  entryTracker.observe({ direction: 'recv', targetId: 'T', raw: '{"cmd":100005,"sid":10}' }); // entry evidence
  await tick();
  assert.equal(starts, 0, 'no start before jackpot');
  obs.set(50000000); // jackpot reached
  await run;
  assert.equal(starts, 1);
  assert.deepEqual(order, ['enter-sent', 'entered', 'jackpot-ready', 'auto-start']);
});
