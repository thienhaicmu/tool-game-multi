import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeCapacity } = require('../../desktop/browser-run/runtime-capacity.cjs');

// §24/§68 — the final concurrent slot cannot be double-claimed.
test('final-slot race: only one of two simultaneous reservations succeeds', () => {
  const rc = new RuntimeCapacity({ getMax: () => 1 });
  const a = rc.reserve('B-0001');
  const b = rc.reserve('B-0002'); // simultaneous (synchronous)
  assert.equal(a.ok, true);
  assert.equal(b.error.code, 'BROWSER_RUNTIME_LIMIT_REACHED');
  assert.equal(rc.runningCount(), 1);
});

// §19/§61 — capacity of N allows N concurrent, blocks N+1.
test('reserves up to max then blocks', () => {
  const rc = new RuntimeCapacity({ getMax: () => 2 });
  assert.equal(rc.reserve('B-1').ok, true);
  assert.equal(rc.reserve('B-2').ok, true);
  assert.equal(rc.reserve('B-3').error.code, 'BROWSER_RUNTIME_LIMIT_REACHED');
  assert.equal(rc.runningCount(), 2);
});

// §25/§69/§70 — releasing frees a slot (close / exit / crash / launch failure).
test('release frees a slot for the next launch', () => {
  const rc = new RuntimeCapacity({ getMax: () => 1 });
  const a = rc.reserve('B-1');
  assert.equal(rc.reserve('B-2').error.code, 'BROWSER_RUNTIME_LIMIT_REACHED');
  assert.equal(rc.release(a.token), true);
  assert.equal(rc.runningCount(), 0);
  assert.equal(rc.reserve('B-2').ok, true, 'slot freed');
});

test('release is idempotent (no double-release, no negative count)', () => {
  const rc = new RuntimeCapacity({ getMax: () => 2 });
  const a = rc.reserve('B-1');
  assert.equal(rc.release(a.token), true);
  assert.equal(rc.release(a.token), false, 'second release is a no-op');
  assert.equal(rc.runningCount(), 0);
});

test('releaseBrowser frees all slots owned by a browser', () => {
  const rc = new RuntimeCapacity({ getMax: () => 5 });
  rc.reserve('B-1'); rc.reserve('B-1'); rc.reserve('B-2');
  assert.equal(rc.releaseBrowser('B-1'), 2);
  assert.equal(rc.runningCount(), 1);
});

// null max = unlimited (legacy licenses).
test('unlimited capacity never blocks', () => {
  const rc = new RuntimeCapacity({ getMax: () => null });
  for (let i = 0; i < 50; i++) assert.equal(rc.reserve('B-' + i).ok, true);
  assert.equal(rc.max(), null);
  assert.equal(rc.snapshot().max, null);
});

// Capacity follows the live entitlement (e.g. license upgrade).
test('capacity follows the live max getter', () => {
  let max = 1;
  const rc = new RuntimeCapacity({ getMax: () => max });
  assert.equal(rc.reserve('B-1').ok, true);
  assert.equal(rc.reserve('B-2').error.code, 'BROWSER_RUNTIME_LIMIT_REACHED');
  max = 3; // upgraded
  assert.equal(rc.reserve('B-2').ok, true);
  assert.equal(rc.reserve('B-3').ok, true);
});
