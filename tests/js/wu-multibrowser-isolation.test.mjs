import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AviatorContextTracker, ACTION, STATE } = require('../../desktop/protocol/aviator-context.cjs');
const { AutoStartIntent } = require('../../desktop/browser-run/auto-start-intent.cjs');

// ---------------------------------------------------------------------------
// FINAL CERTIFICATION — Control per-BrowserRun isolation at the canonical owners.
//
// Each BrowserRun owns its OWN AviatorContextTracker + AutoStartIntent (see
// buildProtocolSubsystem). Evidence is routed per-target -> per-run in main.cjs
// (runForTarget), and the per-run recovery interval ticks every run independently
// regardless of UI selection. These tests prove the owners themselves never share
// state, so one browser's evidence/intent can never move another browser.
// ---------------------------------------------------------------------------

const CFG = { freshMs: 20000, verifyWindowMs: 6000, maxReentryAttempts: 3 };

test('Scenario 1: fresh Aviator evidence for B1 changes ONLY B1 — B2 tracker is independent', () => {
  const b1 = new AviatorContextTracker({ config: CFG });
  const b2 = new AviatorContextTracker({ config: CFG });
  // Both start ACTIVE at t=1000 from their OWN last-frame timestamps.
  assert.equal(b1.tick({ now: 1000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true }).state, STATE.ACTIVE);
  assert.equal(b2.tick({ now: 1000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true }).state, STATE.ACTIVE);
  // Only B1 receives a new frame at t=30000; B2 gets none (its last frame stays 1000).
  const r1 = b1.tick({ now: 30000, lastAviatorMono: 30000, pageHealthy: true, hasIntent: true });
  assert.equal(r1.state, STATE.ACTIVE, 'B1 stays ACTIVE on its own fresh evidence');
  // B2, ticked at the same wall-clock with its OWN stale last-frame, is NOT ACTIVE — proving B1's
  // fresh frame did not leak into B2's freshness.
  const r2 = b2.tick({ now: 30000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true });
  assert.notEqual(r2.state, STATE.ACTIVE, 'B2 unaffected by B1 evidence (its own stream is stale)');
});

test('Scenario 2: B1 kicked to Lobby re-enters (REENTER action) while B2 stays ACTIVE (no action)', () => {
  const b1 = new AviatorContextTracker({ config: CFG });
  const b2 = new AviatorContextTracker({ config: CFG });
  b1.tick({ now: 1000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true });
  b2.tick({ now: 1000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true });
  // t=28000: B1 silent since 1000 (>freshMs+verifyWindowMs) -> CONTEXT_LOST -> one REENTER.
  const r1 = b1.tick({ now: 28000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true });
  assert.equal(r1.state, STATE.CONTEXT_LOST);
  assert.deepEqual(r1.actions, [ACTION.REENTER], 'only B1 issues a re-entry');
  // Same wall-clock: B2 kept receiving frames (fresh at 28000) -> ACTIVE, NO action.
  const r2 = b2.tick({ now: 28000, lastAviatorMono: 28000, pageHealthy: true, hasIntent: true });
  assert.equal(r2.state, STATE.ACTIVE);
  assert.deepEqual(r2.actions, [], 'B2 receives zero entry invocation');
});

test('Scenario 2b: B2 kicked re-enters while B1 stays ACTIVE (no first-browser assumption)', () => {
  const b1 = new AviatorContextTracker({ config: CFG });
  const b2 = new AviatorContextTracker({ config: CFG });
  b1.tick({ now: 1000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true });
  b2.tick({ now: 1000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true });
  const r2 = b2.tick({ now: 28000, lastAviatorMono: 1000, pageHealthy: true, hasIntent: true });
  const r1 = b1.tick({ now: 28000, lastAviatorMono: 28000, pageHealthy: true, hasIntent: true });
  assert.deepEqual(r2.actions, [ACTION.REENTER], 'B2 (not B1) re-enters — inverse direction');
  assert.equal(r1.state, STATE.ACTIVE);
  assert.deepEqual(r1.actions, []);
});

test('Scenario 3: per-run AutoStartIntent — cancelling B2 never cancels B1 pending', () => {
  const b1 = new AutoStartIntent();
  const b2 = new AutoStartIntent();
  const t1 = b1.begin();          // B1 START pending
  b2.begin(); b2.cancel();        // B2 STOP cancels only B2
  assert.equal(b1.pending(), true, 'B1 intent still pending');
  assert.equal(b1.cancelled(t1), false, 'B1 token still valid after B2 STOP');
  assert.equal(b2.pending(), false);
});

test('Scenario D (passive guard preserved): a never-confirmed browser with no intent does NOT re-enter', () => {
  const b = new AviatorContextTracker({ config: CFG });
  // Never saw Aviator (lastAviatorMono null) and no intent -> UNKNOWN, never a REENTER.
  const r = b.tick({ now: 50000, lastAviatorMono: null, pageHealthy: true, hasIntent: false });
  assert.equal(r.state, STATE.UNKNOWN);
  assert.deepEqual(r.actions, []);
  // Even with a healthy page and long silence, no unsolicited entry without ownership/intent.
  const r2 = b.tick({ now: 90000, lastAviatorMono: null, pageHealthy: true, hasIntent: false });
  assert.deepEqual(r2.actions, []);
});
