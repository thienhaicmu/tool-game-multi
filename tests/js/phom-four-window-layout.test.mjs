// The FOUR Phỏm windows (Browser 1/2/3 + the Tool) FILL the work area together: on one monitor they are
// the four quadrants of a 2×2 grid, with no wasted desktop and no overlap. Slot i is ALWAYS Browser i,
// whatever the monitor topology. The page's viewport is simply the window minus the browser chrome —
// nothing is emulated or scaled (see browser-agent.cjs), so a bigger window means a bigger game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { arrangeClusterWindows, computeGridLayout, WINDOW_CHROME, DEFAULT_VIEWPORT } = require('../../desktop/protocol/phom/grid-layout.cjs');

const MON = { x: 0, y: 0, width: 1920, height: 1040 };          // 1080 minus a taskbar
const MON2 = { x: 1920, y: 0, width: 1920, height: 1040 };
const MON3 = { x: 3840, y: 0, width: 1920, height: 1040 };
const MON4 = { x: 5760, y: 0, width: 1920, height: 1040 };
const area = (r) => r.width * r.height;
const overlap = (a, b) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

test('ONE monitor: the three browsers + the Tool are the four quadrants, filling the screen', () => {
  const arr = arrangeClusterWindows([MON], {});
  assert.equal(arr.placement, 'GRID_2x2');
  const g = computeGridLayout(MON, { gap: 8 });
  assert.deepEqual({ x: arr.slots[1].x, y: arr.slots[1].y, width: arr.slots[1].width, height: arr.slots[1].height }, g.A, 'B1 = top-left quadrant');
  assert.deepEqual({ x: arr.slots[2].x, y: arr.slots[2].y, width: arr.slots[2].width, height: arr.slots[2].height }, g.B, 'B2 = top-right quadrant');
  assert.deepEqual({ x: arr.slots[3].x, y: arr.slots[3].y, width: arr.slots[3].width, height: arr.slots[3].height }, g.C, 'B3 = bottom-left quadrant');
  assert.deepEqual(arr.tool, g.control, 'the Tool is the fourth quadrant');
  // together they cover (almost) the whole work area — only the 8px gaps are left over
  const covered = area(arr.slots[1]) + area(arr.slots[2]) + area(arr.slots[3]) + area(arr.tool);
  assert.ok(covered > area(MON) * 0.97, `the four windows fill the screen (covered ${covered} of ${area(MON)})`);
  // and they never overlap
  const rects = [arr.slots[1], arr.slots[2], arr.slots[3], arr.tool];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.equal(overlap(rects[i], rects[j]), false, `window ${i} and ${j} overlap`);
});

test('the game viewport is the window minus the browser chrome (bigger window = bigger game)', () => {
  const arr = arrangeClusterWindows([MON], {});
  for (const i of [1, 2, 3]) {
    assert.equal(arr.slots[i].viewport.width, arr.slots[i].width - WINDOW_CHROME.frameWidth);
    assert.equal(arr.slots[i].viewport.height, arr.slots[i].height - WINDOW_CHROME.chromeHeight);
    assert.ok(arr.slots[i].viewport.width >= DEFAULT_VIEWPORT.width, 'a quadrant of a 1920 screen is roomier than the minimum');
  }
  assert.equal(arr.insufficient, false);
});

test('TWO monitors: B1|B2 split the first, B3 fills the second, the Tool docks bottom-right', () => {
  const arr = arrangeClusterWindows([MON, MON2], {});
  assert.equal(arr.placement, 'SPLIT_2');
  assert.equal(arr.slots[1].x, MON.x);
  assert.ok(arr.slots[2].x > arr.slots[1].x && arr.slots[2].x + arr.slots[2].width <= MON.x + MON.width);
  assert.equal(overlap(arr.slots[1], arr.slots[2]), false);
  assert.deepEqual({ x: arr.slots[3].x, y: arr.slots[3].y, width: arr.slots[3].width, height: arr.slots[3].height }, MON2, 'B3 fills the second monitor');
  assert.ok(arr.tool.x + arr.tool.width <= MON2.x + MON2.width && arr.tool.y + arr.tool.height <= MON2.y + MON2.height);
});

test('THREE / FOUR monitors: one browser fills each monitor; the Tool gets the spare one', () => {
  const three = arrangeClusterWindows([MON, MON2, MON3], {});
  assert.equal(three.placement, 'PER_MONITOR_3');
  for (const [i, m] of [[1, MON], [2, MON2], [3, MON3]]) {
    assert.deepEqual({ x: three.slots[i].x, y: three.slots[i].y, width: three.slots[i].width, height: three.slots[i].height }, m, `B${i} fills its monitor`);
  }
  const four = arrangeClusterWindows([MON, MON2, MON3, MON4], {});
  assert.equal(four.placement, 'PER_MONITOR_4');
  assert.ok(four.tool.x >= MON4.x, 'the Tool moves to the fourth monitor');
});

test('a display too small for a comfortable game is reported, never silently accepted', () => {
  const arr = arrangeClusterWindows([{ x: 0, y: 0, width: 900, height: 500 }], {});
  assert.equal(arr.insufficient, true);
  assert.equal(arr.insufficientReason, 'LAYOUT_SPACE_INSUFFICIENT');
  // the windows still fill their quadrants — the layout is honest about being tight, not broken
  for (const i of [1, 2, 3]) assert.ok(arr.slots[i].width > 0 && arr.slots[i].height > 0);
});

test('slot → window mapping is deterministic (slot i is always browser i)', () => {
  const a = arrangeClusterWindows([MON, MON2], {});
  const b = arrangeClusterWindows([MON, MON2], {});
  assert.deepEqual(a.slots, b.slots);
  assert.deepEqual(a.tool, b.tool);
});
