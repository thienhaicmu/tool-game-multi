import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseObservedIp, isIp } = require('../../desktop/browser-run/ip-parse.cjs');
const { computeGridLayout, rectForSlot, chromeWindowArgs, SLOTS } = require('../../desktop/protocol/phom/grid-layout.cjs');

// §6/§7 — observed-IP parsing (JSON + plain text) with a strict IP check.
test('parseObservedIp handles JSON shapes and plain text', () => {
  assert.equal(parseObservedIp('{"ip":"203.0.113.7"}'), '203.0.113.7');
  assert.equal(parseObservedIp('{"origin":"198.51.100.9, 10.0.0.1"}'), '198.51.100.9');
  assert.equal(parseObservedIp('{"query":"192.0.2.5"}'), '192.0.2.5');
  assert.equal(parseObservedIp('Your IP is 192.0.2.33 today'), '192.0.2.33');
  assert.equal(parseObservedIp('no ip here'), null);
  assert.equal(parseObservedIp(''), null);
  assert.equal(parseObservedIp('{"nope":true}'), null);
});
test('isIp validates v4 and v6', () => {
  assert.equal(isIp('1.2.3.4'), true);
  assert.equal(isIp('2001:db8::1'), true);
  assert.equal(isIp('999.1'), false);
  assert.equal(isIp('hello'), false);
});

// §9/§13 — 2×2 grid geometry: four non-overlapping quadrants.
test('computeGridLayout tiles four quadrants inside the work area', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  const g = computeGridLayout(wa, { gap: 8 });
  for (const k of ['A', 'B', 'C', 'control']) { assert.ok(g[k].width > 0 && g[k].height > 0); }
  // A top-left, B top-right, C bottom-left, control bottom-right
  assert.equal(g.A.x, 0); assert.equal(g.A.y, 0);
  assert.ok(g.B.x > g.A.x); assert.equal(g.B.y, 0);
  assert.equal(g.C.x, 0); assert.ok(g.C.y > g.A.y);
  assert.ok(g.control.x > g.A.x && g.control.y > g.A.y);
  // no horizontal overlap between A and B
  assert.ok(g.A.x + g.A.width <= g.B.x);
  // no vertical overlap between A and C
  assert.ok(g.A.y + g.A.height <= g.C.y);
});

test('rectForSlot + chromeWindowArgs produce credential-free geometry flags', () => {
  const wa = { x: 100, y: 50, width: 1600, height: 900 };
  const rectA = rectForSlot(wa, 'A', { gap: 6 });
  assert.equal(rectA.x, 100); assert.equal(rectA.y, 50);
  const args = chromeWindowArgs(rectA);
  assert.equal(args.length, 2);
  assert.match(args[0], /^--window-position=100,50$/);
  assert.match(args[1], /^--window-size=\d+,\d+$/);
  assert.deepEqual(SLOTS, ['A', 'B', 'C']);
});
