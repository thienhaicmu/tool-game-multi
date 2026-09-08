import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AviatorContextTracker, deriveState, STATE, ACTION, REASON } =
  require('../../desktop/protocol/aviator-context.cjs');

// Deterministic small windows: ACTIVE if seen within 1000ms; VERIFYING within +500ms; then LOST.
const CFG = { freshMs: 1000, verifyWindowMs: 500, maxReentryAttempts: 2 };
const mk = () => new AviatorContextTracker({ config: CFG });

// ---------------------------------------------------------------------------
// Pure classifier (deriveState) — the state model + VERIFY-before-ACT boundaries.
// ---------------------------------------------------------------------------

test('C1: fresh Aviator evidence => ACTIVE (WAITING_JACKPOT keeps waiting, no loss)', () => {
  const s = deriveState({ now: 10000, lastAviatorMono: 9500, pageHealthy: true, hasIntent: true }, CFG);
  assert.equal(s, STATE.ACTIVE);
});

test('C2: normal between-round silence (< freshMs) => ACTIVE (no false context loss)', () => {
  // 900ms of Aviator silence — a legitimate ROUND_END -> next ROUND_OPEN gap.
  const s = deriveState({ now: 10900, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true }, CFG);
  assert.equal(s, STATE.ACTIVE);
});

test('C3: Aviator stale + page healthy (lobby traffic continues) => VERIFYING', () => {
  // 1200ms since last Aviator frame: past freshMs, still inside the verify window.
  const s = deriveState({ now: 11200, lastAviatorMono: 10000, lastWsRecvMono: 11150, pageHealthy: true, hasIntent: true }, CFG);
  assert.equal(s, STATE.VERIFYING);
});

test('confirmed: Aviator silent beyond verify window + page healthy => CONTEXT_LOST', () => {
  const s = deriveState({ now: 11700, lastAviatorMono: 10000, lastWsRecvMono: 11650, pageHealthy: true, hasIntent: true }, CFG);
  assert.equal(s, STATE.CONTEXT_LOST);
});

test('C16: page unhealthy (login wall / disconnect) is NOT context loss => UNKNOWN (session recovery owns it)', () => {
  const s = deriveState({ now: 20000, lastAviatorMono: 10000, pageHealthy: false, hasIntent: true }, CFG);
  assert.equal(s, STATE.UNKNOWN);
});

test('no active intent => UNKNOWN (a user who left Aviator themselves is not "context lost")', () => {
  const s = deriveState({ now: 20000, lastAviatorMono: 10000, pageHealthy: true, hasIntent: false }, CFG);
  assert.equal(s, STATE.UNKNOWN);
});

test('never seen Aviator => UNKNOWN', () => {
  assert.equal(deriveState({ now: 10000, lastAviatorMono: null, pageHealthy: true, hasIntent: true }, CFG), STATE.UNKNOWN);
});

// ---------------------------------------------------------------------------
// Stateful tracker — actions, VERIFY-before-ACT, dedup, bounded escalation.
// ---------------------------------------------------------------------------

test('C4: a fresh Aviator frame during VERIFYING cancels and restores ACTIVE (no re-entry)', () => {
  const t = mk();
  t.tick({ now: 10000, lastAviatorMono: 9800, pageHealthy: true, hasIntent: true }); // ACTIVE
  let r = t.tick({ now: 11200, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.equal(r.state, STATE.VERIFYING);
  assert.deepEqual(r.actions, []);
  // Fresh Aviator evidence arrives (lastAviatorMono jumps forward) mid-verify.
  r = t.tick({ now: 11300, lastAviatorMono: 11300, pageHealthy: true, hasIntent: true });
  assert.equal(r.state, STATE.ACTIVE);
  assert.deepEqual(r.actions, []);
});

test('C5/C6: confirmed CONTEXT_LOST emits exactly one REENTER action (no reload requested)', () => {
  const t = mk();
  t.tick({ now: 10000, lastAviatorMono: 9800, pageHealthy: true, hasIntent: true });
  const r = t.tick({ now: 12000, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.equal(r.state, STATE.CONTEXT_LOST);
  assert.deepEqual(r.actions, [ACTION.REENTER]);
  assert.equal(r.reason, REASON.REENTRY_STARTED);
  // No ESCALATE / reload in the first attempt — direct re-entry precedes any full recovery.
  assert.ok(!r.actions.includes(ACTION.ESCALATE_FULL_RECOVERY));
});

test('C18: duplicate context-loss evidence while a re-entry is in flight does NOT re-issue REENTER', () => {
  const t = mk();
  t.tick({ now: 10000, lastAviatorMono: 9800, pageHealthy: true, hasIntent: true });
  const first = t.tick({ now: 12000, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.deepEqual(first.actions, [ACTION.REENTER]);
  // Aviator still silent, still lost — but a re-entry is already in flight.
  const dup1 = t.tick({ now: 12200, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  const dup2 = t.tick({ now: 12400, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.deepEqual(dup1.actions, []);
  assert.deepEqual(dup2.actions, []);
});

test('bounded: after maxReentryAttempts failed light re-entries, escalate to full recovery exactly once', () => {
  const t = mk();
  t.tick({ now: 10000, lastAviatorMono: 9800, pageHealthy: true, hasIntent: true });
  // Attempt 1
  let r = t.tick({ now: 12000, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.deepEqual(r.actions, [ACTION.REENTER]);
  t.reentryFinished();
  // Attempt 2
  r = t.tick({ now: 12500, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.deepEqual(r.actions, [ACTION.REENTER]);
  t.reentryFinished();
  // Exhausted -> ESCALATE
  r = t.tick({ now: 13000, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.deepEqual(r.actions, [ACTION.ESCALATE_FULL_RECOVERY]);
  assert.equal(r.reason, REASON.REENTRY_EXHAUSTED);
  // ...and never a second escalation on subsequent duplicate loss ticks.
  r = t.tick({ now: 13500, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
  assert.deepEqual(r.actions, []);
});

test('a successful re-entry (fresh Aviator) resets the attempt budget for a future episode', () => {
  const t = mk();
  t.tick({ now: 10000, lastAviatorMono: 9800, pageHealthy: true, hasIntent: true });
  t.tick({ now: 12000, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true }); // REENTER (attempt 1)
  // Re-entry succeeds: fresh Aviator evidence.
  const active = t.tick({ now: 12100, lastAviatorMono: 12100, pageHealthy: true, hasIntent: true });
  assert.equal(active.state, STATE.ACTIVE);
  assert.equal(t.reentryAttempts(), 0);
  // A brand-new later loss episode gets a fresh REENTER (not an immediate escalate).
  const r = t.tick({ now: 14000, lastAviatorMono: 12100, pageHealthy: true, hasIntent: true });
  assert.deepEqual(r.actions, [ACTION.REENTER]);
});

// ---------------------------------------------------------------------------
// FALSE-POSITIVE MATRIX (§15) — prove NO re-entry/action for benign conditions.
// ---------------------------------------------------------------------------

test('FP: ROUND_END -> ROUND_OPEN gap never triggers an action', () => {
  const t = mk();
  let acted = false;
  for (let dt = 0; dt <= 900; dt += 100) {
    const r = t.tick({ now: 10000 + dt, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true });
    if (r.actions.length) acted = true;
    assert.equal(r.state, STATE.ACTIVE);
  }
  assert.equal(acted, false);
});

test('FP: short WS jitter that recovers before freshMs never triggers an action', () => {
  const t = mk();
  const r1 = t.tick({ now: 10800, lastAviatorMono: 10000, pageHealthy: true, hasIntent: true }); // 800ms silence
  assert.equal(r1.state, STATE.ACTIVE);
  const r2 = t.tick({ now: 10900, lastAviatorMono: 10850, pageHealthy: true, hasIntent: true }); // frame returns
  assert.equal(r2.state, STATE.ACTIVE);
  assert.deepEqual(r2.actions, []);
});

test('FP: healthy Jackpot wait with a live Aviator lifecycle stays ACTIVE indefinitely', () => {
  const t = mk();
  // Simulate a long jackpot wait: Aviator frames keep arriving every 500ms for 30 "rounds".
  let last = 10000;
  for (let i = 0; i < 30; i++) {
    const now = 10000 + i * 500;
    last = now; // an Aviator frame this tick
    const r = t.tick({ now, lastAviatorMono: last, pageHealthy: true, hasIntent: true });
    assert.equal(r.state, STATE.ACTIVE);
    assert.deepEqual(r.actions, []);
  }
});

test('FP: verifying without page health falls back to UNKNOWN, never CONTEXT_LOST', () => {
  const t = mk();
  t.tick({ now: 10000, lastAviatorMono: 9800, pageHealthy: true, hasIntent: true });
  const r = t.tick({ now: 12000, lastAviatorMono: 10000, pageHealthy: false, hasIntent: true });
  assert.equal(r.state, STATE.UNKNOWN);
  assert.deepEqual(r.actions, []);
});
