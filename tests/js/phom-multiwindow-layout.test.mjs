// PHASE 6 — deterministic multi-monitor 3-window arrangement. Pure geometry: slot i ALWAYS maps to
// Browser i regardless of input/launch order; windows are non-overlapping when space allows and
// LAYOUT_SPACE_INSUFFICIENT (spread + overlap) when not; the mobile-landscape viewport is never shrunk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { arrangeBrowserWindows, WINDOW_CHROME } = require('../../desktop/protocol/phom/grid-layout.cjs');

const PIXEL5 = { viewportWidth: 851, viewportHeight: 393 };
const DEVICES = [PIXEL5, PIXEL5, PIXEL5];
const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y;
}

// 13/14/15 — deterministic Browser 1/2/3 → slot mapping
test('slots 1/2/3 map to Browser 1/2/3 deterministically', () => {
  const a = arrangeBrowserWindows([{ x: 0, y: 0, width: 5760, height: 1080 }], DEVICES);
  assert.ok(a.slots[1] && a.slots[2] && a.slots[3]);
  assert.ok(a.slots[1].x < a.slots[2].x && a.slots[2].x < a.slots[3].x, 'left→right order 1,2,3');
});

// 17 — input/monitor order does not change the slot→browser mapping (deterministic)
test('reversed device order still yields slot i for browser i (viewport preserved per slot)', () => {
  const devs = [{ viewportWidth: 851, viewportHeight: 393 }, { viewportWidth: 800, viewportHeight: 360 }, { viewportWidth: 915, viewportHeight: 412 }];
  const a = arrangeBrowserWindows([{ x: 0, y: 0, width: 6000, height: 1080 }], devs);
  assert.deepEqual(a.slots[1].viewport, { width: 851, height: 393 });
  assert.deepEqual(a.slots[2].viewport, { width: 800, height: 360 });
  assert.deepEqual(a.slots[3].viewport, { width: 915, height: 412 });
});

// 18 — no overlap when the workspace is wide enough
test('single wide monitor: three windows do NOT overlap', () => {
  const a = arrangeBrowserWindows([{ x: 0, y: 0, width: 5760, height: 1080 }], DEVICES);
  assert.equal(a.placement, 'TILED');
  assert.equal(a.insufficient, false);
  assert.equal(overlapArea(a.slots[1], a.slots[2]), 0);
  assert.equal(overlapArea(a.slots[2], a.slots[3]), 0);
  assert.equal(overlapArea(a.slots[1], a.slots[3]), 0);
});

// 19 — multi-monitor: one browser per monitor (PER_MONITOR), each on its own display
test('three monitors: one browser per monitor, deterministic', () => {
  const mons = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1040 }, { x: 3840, y: 0, width: 1920, height: 1040 }];
  const a = arrangeBrowserWindows(mons, DEVICES);
  assert.equal(a.placement, 'PER_MONITOR');
  assert.equal(a.monitors, 3);
  assert.ok(a.slots[1].x >= 0 && a.slots[1].x < 1920, 'browser 1 on monitor 0');
  assert.ok(a.slots[2].x >= 1920 && a.slots[2].x < 3840, 'browser 2 on monitor 1');
  assert.ok(a.slots[3].x >= 3840, 'browser 3 on monitor 2');
  // no overlap across monitors
  assert.equal(overlapArea(a.slots[1], a.slots[2]), 0);
  assert.equal(overlapArea(a.slots[2], a.slots[3]), 0);
});

test('two monitors: browsers 1&2 tiled on monitor 0, browser 3 on monitor 1 (SPLIT_2)', () => {
  const mons = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1040 }];
  const a = arrangeBrowserWindows(mons, DEVICES);
  assert.equal(a.placement, 'SPLIT_2');
  assert.ok(a.slots[1].x < 1920 && a.slots[2].x < 1920, 'B1,B2 on monitor 0');
  assert.ok(a.slots[3].x >= 1920, 'B3 on monitor 1');
});

// 20 — viewport size unchanged; window = viewport + chrome
test('window outer size = device viewport + browser chrome (viewport preserved)', () => {
  const a = arrangeBrowserWindows([{ x: 0, y: 0, width: 5760, height: 1080 }], DEVICES);
  assert.equal(a.slots[1].width, 851 + WINDOW_CHROME.frameWidth);
  assert.equal(a.slots[1].height, 393 + WINDOW_CHROME.chromeHeight);
  assert.deepEqual(a.slots[1].viewport, { width: 851, height: 393 });
});

// 35 — insufficient space: overlap allowed but reported (never a silent perfect claim); viewport intact
test('narrow single monitor: LAYOUT_SPACE_INSUFFICIENT reported, viewport not shrunk', () => {
  const a = arrangeBrowserWindows([{ x: 0, y: 0, width: 1366, height: 728 }], DEVICES);
  assert.equal(a.placement, 'TILED');
  assert.equal(a.insufficient, true);
  assert.equal(a.insufficientReason, 'LAYOUT_SPACE_INSUFFICIENT');
  for (const i of [1, 2, 3]) assert.deepEqual(a.slots[i].viewport, { width: 851, height: 393 }, 'viewport never shrunk');
  // A left, C right, spread across the width
  assert.equal(a.slots[1].x, 0);
});

// 36 — negative-origin (left secondary) monitor honored
test('negative-origin monitor topology honored', () => {
  const mons = [{ x: -1920, y: 0, width: 1920, height: 1040 }, { x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1040 }];
  const a = arrangeBrowserWindows(mons, DEVICES);
  assert.ok(a.slots[1].x >= -1920 && a.slots[1].x < 0, 'browser 1 on the left secondary');
});

// robustness — empty/absent inputs never throw
test('absent monitors/devices fall back to a single sane monitor', () => {
  const a = arrangeBrowserWindows([], []);
  assert.equal(a.monitors, 1);
  assert.ok(a.slots[1] && a.slots[2] && a.slots[3]);
  for (const i of [1, 2, 3]) assert.ok(a.slots[i].viewport.width > a.slots[i].viewport.height, 'landscape fallback');
});
