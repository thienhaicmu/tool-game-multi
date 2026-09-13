import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeGridLayout, toolWindowBounds } = require('../../desktop/protocol/phom/grid-layout.cjs');

// §11 / §12 / §17.D — pure window geometry. The tool defaults to the bottom-right
// quadrant (≈ 1/4) and the four corners tile A=TL, B=TR, C=BL, tool=BR. Every rect
// must stay inside the work area; the tool grows to a minimum then clamps.

const within = (rect, wa) => rect.x >= wa.x && rect.y >= wa.y && rect.x + rect.width <= wa.x + wa.width + 1 && rect.y + rect.height <= wa.y + wa.height + 1;

function assertFourCorners(wa) {
  const g = computeGridLayout(wa, { gap: 8 });
  // A top-left, B top-right, C bottom-left, control bottom-right
  assert.equal(g.A.x, Math.round(wa.x), 'A at left');
  assert.equal(g.A.y, Math.round(wa.y), 'A at top');
  assert.ok(g.B.x > g.A.x, 'B right of A');
  assert.equal(g.B.y, g.A.y, 'B same top as A');
  assert.equal(g.C.x, g.A.x, 'C same left as A');
  assert.ok(g.C.y > g.A.y, 'C below A');
  assert.ok(g.control.x > g.C.x && g.control.y > g.B.y, 'control is bottom-right');
  for (const k of ['A', 'B', 'C', 'control']) assert.ok(within(g[k], wa), `${k} inside work area`);
  // no overlap beyond the gap/rounding tolerance
  assert.ok(g.A.x + g.A.width <= g.B.x + 1, 'A/B no horizontal overlap');
  assert.ok(g.A.y + g.A.height <= g.C.y + 1, 'A/C no vertical overlap');
}

test('four corners on 1920×1080 (origin 0,0)', () => {
  assertFourCorners({ x: 0, y: 0, width: 1920, height: 1080 });
});

test('four corners on a work area reduced by a taskbar (1920×1032)', () => {
  assertFourCorners({ x: 0, y: 0, width: 1920, height: 1032 });
});

test('four corners on 1366×728', () => {
  assertFourCorners({ x: 0, y: 0, width: 1366, height: 728 });
});

test('four corners with odd width/height', () => {
  assertFourCorners({ x: 0, y: 0, width: 1367, height: 769 });
});

test('four corners on a monitor with negative origin (left secondary)', () => {
  assertFourCorners({ x: -1920, y: 0, width: 1920, height: 1080 });
});

test('four corners on a right monitor with positive origin', () => {
  assertFourCorners({ x: 1920, y: 0, width: 2560, height: 1440 });
});

test('tool window defaults to the bottom-right quadrant (~1/4 area)', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  const t = toolWindowBounds(wa, { minWidth: 380, minHeight: 480 });
  assert.equal(t.width, 960);  // floor(1920/2)
  assert.equal(t.height, 540); // floor(1080/2)
  assert.equal(t.x, 960);      // anchored right
  assert.equal(t.y, 540);      // anchored bottom
  assert.ok(within(t, wa));
  // occupies about a quarter, never half/full
  assert.ok(t.width * t.height <= wa.width * wa.height * 0.30);
});

test('tool window on a negative-origin monitor stays inside and bottom-right', () => {
  const wa = { x: -1920, y: -200, width: 1920, height: 1080 };
  const t = toolWindowBounds(wa, { minWidth: 380, minHeight: 480 });
  assert.ok(within(t, wa));
  assert.equal(t.x + t.width, wa.x + wa.width);
  assert.equal(t.y + t.height, wa.y + wa.height);
});

test('minimum size clamps to the work area on a tiny display (never overflows)', () => {
  const wa = { x: 0, y: 0, width: 700, height: 500 };
  // a min bigger than the quadrant (350×250) grows the rect toward the min, but never past wa
  const t = toolWindowBounds(wa, { minWidth: 640, minHeight: 480 });
  assert.equal(t.width, 640);
  assert.equal(t.height, 480);
  assert.ok(within(t, wa), 'clamped inside work area');
  assert.ok(t.x >= wa.x && t.y >= wa.y);
});

test('minimum larger than the whole work area is clamped to the work area', () => {
  const wa = { x: 0, y: 0, width: 400, height: 300 };
  const t = toolWindowBounds(wa, { minWidth: 900, minHeight: 900 });
  assert.equal(t.width, 400);
  assert.equal(t.height, 300);
  assert.equal(t.x, 0);
  assert.equal(t.y, 0);
});
