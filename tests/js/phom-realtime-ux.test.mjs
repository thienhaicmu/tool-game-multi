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

test('RUN GAME is guarded against a duplicate click (no second cluster)', () => {
  assert.match(js, /clusterOpBusy/);
  assert.match(js, /if \(clusterOpBusy\)/);
});

