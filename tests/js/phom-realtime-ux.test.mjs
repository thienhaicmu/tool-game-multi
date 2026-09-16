import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Real-time interaction + UX phase — source-level assertions (no DOM runtime in CI) that the
// renderer wiring reflects: PH-2 WS-close propagation, staged host-first find-table feedback,
// duplicate-RUN-GAME guard, and the cluster-level QUAY VỀ SETUP navigation.

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const preload = read('desktop/phom-preload.cjs');
const main = read('desktop/phom-main.cjs');
const capture = read('desktop/cdp/capture.cjs');

test('capture emits a websocket-closed lifecycle signal carrying the socket url', () => {
  assert.match(capture, /emit\('websocket-closed'/);
  assert.match(capture, /url:\s*conn\.url/);
});

test('main routes websocket-closed to the owning run via routeSocketClosed (PH-2)', () => {
  assert.match(main, /capture\.on\('websocket-closed'/);
  assert.match(main, /runForTarget\(info\.targetId\)/);
  assert.match(main, /routeSocketClosed\(run\.id/);
});

test('QUAY VỀ SETUP is a Control-screen action that keeps browsers open', () => {
  assert.match(js, /QUAY VỀ SETUP/);
  assert.match(js, /function returnToSetup\(/);
  // It cancels orchestration (generation guard) rather than closing browsers.
  assert.match(js, /returnToSetup[\s\S]*?orchestrationStop\(\)/);
  // It must NOT call the browser-close seam.
  const body = js.slice(js.indexOf('async function returnToSetup('), js.indexOf('async function closeBrowsers('));
  assert.equal(/closeBrowsers\(\)|api\.clusterStop|api\.closeBrowsers/.test(body), false, 'return-to-setup must not close browsers');
});

test('RUN GAME is guarded against a duplicate click (no second cluster)', () => {
  assert.match(js, /clusterOpBusy/);
  assert.match(js, /if \(clusterOpBusy\)/);
});

test('autoFlowLabel maps the ACTUAL host-first SESSION states (staged feedback)', () => {
  for (const s of ['HOST_SEARCHING', 'HOST_VALIDATING', 'HOST_CANDIDATE_VALID', 'VERIFYING_SAME_TABLE', 'C_REJOINING', 'INVALID_TABLE', 'MONITORING', 'WAITING_AUTHORIZED_FOURTH']) {
    assert.match(js, new RegExp(s + ':'), `autoFlowLabel should map ${s}`);
  }
  // Legacy symmetric-only name that never appears in HostTableCoordinator must be gone as a key.
  assert.equal(/HOST_ACQUIRING:/.test(js), false, 'stale HOST_ACQUIRING key removed');
});
