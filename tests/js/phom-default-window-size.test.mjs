// ONE window size for every Phỏm browser (2026-10-02). The device-profile catalog is gone: a browser
// window is DEFAULT_VIEWPORT (600×338, 16:9) plus the Chromium chrome allowance, and the page gets
// exactly that viewport because nothing is emulated or scaled any more. Three of them must tile on a
// single 1920×1080 monitor — which is what the old "Desktop 22/24"" preset was for, now the only size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ba = require('../../desktop/browser-run/browser-agent.cjs');
const gl = require('../../desktop/protocol/phom/grid-layout.cjs');

const MON_1920 = { x: 0, y: 0, width: 1920, height: 1040 };
const expectedWin = ba.defaultWindowSize();

test('the window is the viewport + chrome, and the page is never asked to render more', () => {
  assert.deepEqual({ ...ba.DEFAULT_VIEWPORT }, { width: 600, height: 338 });
  assert.ok(Math.abs(ba.DEFAULT_VIEWPORT.width / ba.DEFAULT_VIEWPORT.height - 16 / 9) < 0.01, 'aspect ≈ 16:9');
  const rect = gl.desktopWindowRectForSlot(MON_1920, 'A');
  assert.equal(rect.width, expectedWin.width, 'width = viewport + frame');
  assert.equal(rect.height, expectedWin.height, 'height = viewport + chrome');
  assert.deepEqual(rect.viewport, { width: 600, height: 338 });
});

test('three browser windows tile on ONE 1920×1080 monitor without overlap', () => {
  const arr = gl.arrangeBrowserWindows([MON_1920], {});
  assert.equal(arr.placement, 'TILED');
  assert.equal(arr.insufficient, false, 'three windows fit — no spread/overlap');
  const rects = [1, 2, 3].map((k) => arr.slots[k]);
  for (const s of rects) {
    assert.ok(s.x >= 0 && s.x + s.width <= 1920, 'window inside 1920 width');
    assert.equal(s.width, expectedWin.width);
    assert.equal(s.height, expectedWin.height);
    assert.deepEqual(s.viewport, { width: 600, height: 338 });
  }
  assert.ok(rects[0].x + rects[0].width <= rects[1].x, 'B1 before B2');
  assert.ok(rects[1].x + rects[1].width <= rects[2].x, 'B2 before B3');
});

test('every slot of the four-window arrangement gets the SAME size — never stretched to a monitor', () => {
  for (const mons of [[MON_1920], [MON_1920, MON_1920], [MON_1920, MON_1920, MON_1920]]) {
    const arr = gl.arrangeClusterWindows(mons, {});
    for (const i of [1, 2, 3]) {
      assert.equal(arr.slots[i].width, expectedWin.width, `${mons.length} monitors · slot ${i} width`);
      assert.equal(arr.slots[i].height, expectedWin.height, `${mons.length} monitors · slot ${i} height`);
    }
    assert.ok(arr.tool, 'the Tool window is still placed');
  }
});

test('a display too small for the default window is reported, never silently shrunk below it', () => {
  const tiny = { x: 0, y: 0, width: 900, height: 500 };
  const arr = gl.arrangeBrowserWindows([tiny], {});
  assert.equal(arr.insufficient, true);
  assert.equal(arr.insufficientReason, 'LAYOUT_SPACE_INSUFFICIENT');
  for (const i of [1, 2, 3]) assert.deepEqual(arr.slots[i].viewport, { width: 600, height: 338 }, 'the viewport is still reported as the default');
});

test('slot → window mapping stays deterministic (slot i is always browser i)', () => {
  const a = gl.arrangeBrowserWindows([MON_1920], {});
  const b = gl.arrangeBrowserWindows([MON_1920], {});
  assert.deepEqual(a.slots, b.slots, 'same topology → same rects, every time');
  assert.ok(a.slots[1].x < a.slots[3].x, 'B1 left of B3');
});
