import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// BrowserRuntimeHealth — pure model tests. Proves browser RUNTIME liveness is
// derived ONLY from the run's OWN WebContents operational signals, never from the
// object's mere existence (§9) and never from any game/selection input.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const { BrowserRuntimeHealth, deriveBrowserRuntimeState, STATE } =
  require('../../desktop/browser-run/browser-runtime-health.cjs');

const LIVE_EV = { wcExists: true, wcDestroyed: false, rendererGone: false, unresponsive: false, pageLoaded: true, loginDetected: false };

test('classifier: severity ordering CLOSED > CRASHED > DEGRADED > LAUNCHING > LOGIN_REQUIRED > LIVE', () => {
  assert.equal(deriveBrowserRuntimeState(LIVE_EV), STATE.LIVE);
  assert.equal(deriveBrowserRuntimeState({ ...LIVE_EV, loginDetected: true }), STATE.LOGIN_REQUIRED);
  assert.equal(deriveBrowserRuntimeState({ ...LIVE_EV, pageLoaded: false }), STATE.LAUNCHING);
  assert.equal(deriveBrowserRuntimeState({ ...LIVE_EV, unresponsive: true }), STATE.DEGRADED);
  assert.equal(deriveBrowserRuntimeState({ ...LIVE_EV, rendererGone: true }), STATE.CRASHED);
  assert.equal(deriveBrowserRuntimeState({ ...LIVE_EV, wcDestroyed: true }), STATE.CLOSED);
  assert.equal(deriveBrowserRuntimeState({ ...LIVE_EV, wcExists: false }), STATE.CLOSED);
});

test('a mere non-destroyed WebContents object is NOT enough to certify LIVE (§9)', () => {
  // wcExists + !wcDestroyed but the renderer is gone → CRASHED, not LIVE.
  assert.equal(deriveBrowserRuntimeState({ wcExists: true, wcDestroyed: false, rendererGone: true, pageLoaded: true }), STATE.CRASHED);
  // ...and before any page has loaded it is only LAUNCHING.
  assert.equal(deriveBrowserRuntimeState({ wcExists: true, wcDestroyed: false, pageLoaded: false }), STATE.LAUNCHING);
});

test('crash severity wins over an unresponsive flag', () => {
  assert.equal(deriveBrowserRuntimeState({ ...LIVE_EV, rendererGone: true, unresponsive: true }), STATE.CRASHED);
});

test('tick() reports change only on transition and emits state', () => {
  const h = new BrowserRuntimeHealth();
  assert.equal(h.state(), STATE.LAUNCHING);
  const seen = [];
  h.on('state', (e) => seen.push(e.to));

  assert.deepEqual(h.tick(LIVE_EV), { state: STATE.LIVE, changed: true });
  assert.deepEqual(h.tick(LIVE_EV), { state: STATE.LIVE, changed: false }); // steady: no re-emit
  assert.equal(h.isLive(), true);

  h.tick({ ...LIVE_EV, unresponsive: true });   // LIVE -> DEGRADED
  h.tick(LIVE_EV);                               // DEGRADED -> LIVE (recovered)
  h.tick({ ...LIVE_EV, rendererGone: true });    // LIVE -> CRASHED
  assert.deepEqual(seen, [STATE.LIVE, STATE.DEGRADED, STATE.LIVE, STATE.CRASHED]);
});

test('health has NO game/selection inputs — LIVE is independent of any game state', () => {
  // The evidence shape contains only browser-runtime signals; there is no aviator/selection field.
  const h = new BrowserRuntimeHealth();
  h.tick(LIVE_EV);
  // Passing arbitrary game-ish fields must not change the derived runtime state.
  const r = h.tick({ ...LIVE_EV, aviatorContextState: 'CONTEXT_LOST', selected: false, currentPage: 'Lobby' });
  assert.equal(r.state, STATE.LIVE);
});
