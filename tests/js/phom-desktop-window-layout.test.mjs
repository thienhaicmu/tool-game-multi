// Desktop window placement. Pure geometry (no OS calls): every window's OUTER size is the ONE default
// viewport + browser chrome (browser-agent.DEFAULT_VIEWPORT — the page renders at that size, nothing is
// emulated), A/B/C spread left/center/right, and a window is always fully inside the work area.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { desktopWindowRectForSlot, WINDOW_CHROME } = require('../../desktop/protocol/phom/grid-layout.cjs');
const { DEFAULT_VIEWPORT } = require('../../desktop/browser-run/browser-agent.cjs');

const VP = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
const WA_1080 = { x: 0, y: 0, width: 1920, height: 1040 }; // 1080 minus a taskbar

test('window content fits the default viewport + browser chrome (not squashed, not a full quadrant)', () => {
  const a = desktopWindowRectForSlot(WA_1080, 'A');
  assert.equal(a.width, VP.width + WINDOW_CHROME.frameWidth, 'width = viewport + frame');
  assert.equal(a.height, VP.height + WINDOW_CHROME.chromeHeight, 'height = viewport + chrome');
  assert.deepEqual(a.viewport, VP, 'the page gets exactly the default viewport');
});

test('A/B/C spread left, center, right across the work area — and fit on a 1920 screen', () => {
  const a = desktopWindowRectForSlot(WA_1080, 'A');
  const b = desktopWindowRectForSlot(WA_1080, 'B');
  const c = desktopWindowRectForSlot(WA_1080, 'C');
  assert.equal(a.x, 0, 'A at the left edge');
  assert.equal(c.x, WA_1080.width - c.width, 'C at the right edge');
  assert.ok(b.x > a.x && b.x < c.x, 'B is centered between A and C (left→center→right order)');
  // Three default windows (616px each) fit side by side in 1920 — that is why this size is the default.
  assert.ok(a.x + a.width <= b.x, 'no overlap on a standard 1920 screen');
  assert.ok(b.x + b.width <= c.x, 'no overlap on a standard 1920 screen');
});

test('all three windows are identical in size and vertically centered', () => {
  const rects = ['A', 'B', 'C'].map((s) => desktopWindowRectForSlot(WA_1080, s));
  const [a, b, c] = rects;
  assert.ok(a.width === b.width && b.width === c.width);
  assert.ok(a.height === b.height && b.height === c.height);
  assert.ok(a.y === b.y && b.y === c.y, 'same vertical band');
  for (const r of rects) assert.equal(r.y, Math.round((WA_1080.height - r.height) / 2));
});

test('never exceeds the work area; clamped inside on a small display', () => {
  const small = { x: 0, y: 0, width: 900, height: 500 };
  for (const s of ['A', 'B', 'C']) {
    const r = desktopWindowRectForSlot(small, s);
    assert.ok(r.width <= small.width && r.height <= small.height, 'window fits the work area');
    assert.ok(r.x >= 0 && r.x + r.width <= small.width, `${s} inside horizontally`);
    assert.ok(r.y >= 0 && r.y + r.height <= small.height, `${s} inside vertically`);
  }
});

test('the window is NEVER shrunk below the default to fit a narrow screen (they overlap instead)', () => {
  const narrow = { x: 0, y: 0, width: 1000, height: 900 };
  const a = desktopWindowRectForSlot(narrow, 'A');
  const c = desktopWindowRectForSlot(narrow, 'C');
  assert.deepEqual(a.viewport, VP, 'the default viewport is kept even though 3 windows do not fit 1000px');
  assert.equal(a.width, VP.width + WINDOW_CHROME.frameWidth);
  assert.equal(a.x, 0);
  assert.equal(c.x, narrow.width - c.width);
  assert.ok(c.x < a.x + a.width, 'they overlap (expected) rather than being shrunk');
});

test('honors a negative-origin (left secondary) monitor work area', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  const a = desktopWindowRectForSlot(left, 'A');
  assert.equal(a.x, -1920, 'anchored to the monitor origin');
  assert.ok(a.x + a.width <= left.x + left.width);
});

test('there is nothing per-profile left to pass: the size comes from the one default', () => {
  const r = desktopWindowRectForSlot(WA_1080, 'A');
  assert.deepEqual(r.viewport, VP);
  assert.ok(r.viewport.width > r.viewport.height, 'landscape');
});
