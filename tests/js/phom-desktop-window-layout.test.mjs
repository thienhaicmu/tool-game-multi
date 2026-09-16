// PHASE 3 · PART A — desktop windows sized to the mobile-landscape viewport. Pure geometry
// (no OS calls): a window's OUTER size = device viewport + browser chrome; A/B/C spread left/center/
// right; always fully inside the work area; the emulated viewport value is preserved (device
// emulation itself is unchanged — this only sizes the native window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { desktopWindowRectForSlot, WINDOW_CHROME } = require('../../desktop/protocol/phom/grid-layout.cjs');

const PIXEL5 = { viewportWidth: 851, viewportHeight: 393 };
const WA_1080 = { x: 0, y: 0, width: 1920, height: 1040 }; // 1080 minus a taskbar

test('window content fits the device viewport + browser chrome (not squashed, not a full quadrant)', () => {
  const a = desktopWindowRectForSlot(WA_1080, 'A', PIXEL5);
  assert.equal(a.width, 851 + WINDOW_CHROME.frameWidth, 'width = viewport + frame');
  assert.equal(a.height, 393 + WINDOW_CHROME.chromeHeight, 'height = viewport + chrome');
  assert.deepEqual(a.viewport, { width: 851, height: 393 }, 'emulated viewport preserved unchanged');
});

test('A/B/C spread left, center, right across the work area', () => {
  const a = desktopWindowRectForSlot(WA_1080, 'A', PIXEL5);
  const b = desktopWindowRectForSlot(WA_1080, 'B', PIXEL5);
  const c = desktopWindowRectForSlot(WA_1080, 'C', PIXEL5);
  assert.equal(a.x, 0, 'A at the left edge');
  assert.equal(c.x, WA_1080.width - c.width, 'C at the right edge');
  assert.ok(b.x > a.x && b.x < c.x, 'B is centered between A and C (left→center→right order)');
  // Three device-sized windows (851+chrome ≈ 867px each) cannot fit in 1920 without overlap
  // (3×867 > 1920). Overlap is EXPECTED and correct — the viewport is preserved over fit (§5).
  assert.ok(a.x + a.width > b.x, 'device-sized windows overlap on a standard 1920 screen (viewport not shrunk)');
});

test('all three windows are identical device size and vertically centered', () => {
  const rects = ['A', 'B', 'C'].map((s) => desktopWindowRectForSlot(WA_1080, s, PIXEL5));
  const [a, b, c] = rects;
  assert.ok(a.width === b.width && b.width === c.width);
  assert.ok(a.height === b.height && b.height === c.height);
  assert.ok(a.y === b.y && b.y === c.y, 'same vertical band');
  for (const r of rects) assert.equal(r.y, Math.round((WA_1080.height - r.height) / 2));
});

test('never exceeds the work area; clamped inside on a small display', () => {
  const small = { x: 0, y: 0, width: 900, height: 500 };
  for (const s of ['A', 'B', 'C']) {
    const r = desktopWindowRectForSlot(small, s, PIXEL5);
    assert.ok(r.width <= small.width && r.height <= small.height, 'window fits the work area');
    assert.ok(r.x >= 0 && r.x + r.width <= small.width, `${s} inside horizontally`);
    assert.ok(r.y >= 0 && r.y + r.height <= small.height, `${s} inside vertically`);
  }
});

test('viewport is NEVER shrunk to fit a narrow screen (windows may overlap instead)', () => {
  const narrow = { x: 0, y: 0, width: 1000, height: 900 };
  const a = desktopWindowRectForSlot(narrow, 'A', PIXEL5);
  const c = desktopWindowRectForSlot(narrow, 'C', PIXEL5);
  // viewport preserved even though 3×(851+frame) > 1000
  assert.deepEqual(a.viewport, { width: 851, height: 393 });
  // overlap is allowed; A left, C right, each full device size
  assert.equal(a.x, 0);
  assert.equal(c.x, narrow.width - c.width);
  assert.ok(c.x < a.x + a.width, 'they overlap (expected) rather than shrinking the viewport');
});

test('honors a negative-origin (left secondary) monitor work area', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  const a = desktopWindowRectForSlot(left, 'A', PIXEL5);
  assert.equal(a.x, -1920, 'anchored to the monitor origin');
  assert.ok(a.x + a.width <= left.x + left.width);
});

test('falls back to a sane default viewport when the device is missing dimensions', () => {
  const r = desktopWindowRectForSlot(WA_1080, 'A', {});
  assert.ok(r.viewport.width >= 320 && r.viewport.height >= 180, 'usable fallback mobile-landscape size');
  assert.ok(r.viewport.width > r.viewport.height, 'landscape fallback');
});
