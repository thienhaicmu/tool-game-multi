// PHASE 6.2 — the FOUR-window desktop arrangement (3 desktop Chromium windows + the Tool window),
// deterministic across the live monitor topology. Pure geometry: slot i -> Browser i, the Tool is the
// 4th region, browser windows are DESKTOP-sized (fill their monitor region, not a mobile size), and the
// one default window size is used for every slot (the window IS the page's viewport).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { arrangeClusterWindows } = require('../../desktop/protocol/phom/grid-layout.cjs');

const { DEFAULT_VIEWPORT, defaultWindowSize } = require('../../desktop/browser-run/browser-agent.cjs');
const VP = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
const WIN = defaultWindowSize();
const overlap = (a, b) => { const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)); const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); return x * y; };

test('produces four windows: three browser slots + the Tool', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  assert.ok(a.slots[1] && a.slots[2] && a.slots[3], 'three browser slots');
  assert.ok(a.tool && Number.isFinite(a.tool.width) && Number.isFinite(a.tool.height), 'a Tool window rect');
});

test('single monitor => 2×2 quadrants (B1 TL, B2 TR, B3 BL, Tool BR), no overlap', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  assert.equal(a.placement, 'GRID_2x2');
  const { slots, tool } = a;
  assert.ok(slots[1].x < slots[2].x, 'B1 left of B2');
  assert.ok(slots[1].y < slots[3].y, 'B1 above B3');
  assert.ok(tool.x >= slots[3].x + slots[3].width - 2 || tool.y >= slots[1].y, 'Tool in the BR region');
  // quadrants do not overlap
  assert.equal(overlap(slots[1], slots[2]), 0);
  assert.equal(overlap(slots[1], slots[3]), 0);
  assert.equal(overlap(slots[2], slots[3]), 0);
  assert.equal(overlap(slots[3], tool), 0);
});

test('4 monitors => one browser per monitor + Tool on the 4th (deterministic mapping)', () => {
  const mons = [0, 1, 2, 3].map((i) => ({ x: i * 1920, y: 0, width: 1920, height: 1040 }));
  const a = arrangeClusterWindows(mons);
  assert.equal(a.placement, 'PER_MONITOR_4');
  assert.ok(a.slots[1].x < 1920, 'B1 on monitor 0');
  assert.ok(a.slots[2].x >= 1920 && a.slots[2].x < 3840, 'B2 on monitor 1');
  assert.ok(a.slots[3].x >= 3840 && a.slots[3].x < 5760, 'B3 on monitor 2');
  assert.ok(a.tool.x >= 5760, 'Tool on monitor 3');
});

test('3 monitors => B1/B2/B3 one per monitor, Tool docks on monitor 3', () => {
  const mons = [0, 1, 2].map((i) => ({ x: i * 1920, y: 0, width: 1920, height: 1040 }));
  const a = arrangeClusterWindows(mons);
  assert.equal(a.placement, 'PER_MONITOR_3');
  assert.ok(a.tool.x >= 3840, 'Tool docked on the 3rd monitor');
  assert.equal(overlap(a.slots[1], a.slots[2]), 0);
});

test('2 monitors => B1|B2 split monitor 0, B3 + Tool on monitor 1', () => {
  const mons = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1040 }];
  const a = arrangeClusterWindows(mons);
  assert.equal(a.placement, 'SPLIT_2');
  assert.ok(a.slots[1].x < 1920 && a.slots[2].x < 1920, 'B1,B2 on monitor 0');
  assert.equal(overlap(a.slots[1], a.slots[2]), 0, 'B1,B2 split without overlap');
  assert.ok(a.slots[3].x >= 1920 && a.tool.x >= 1920, 'B3 + Tool on monitor 1');
});

test('a browser window is the ONE default size — never stretched to fill a monitor region', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  assert.equal(a.slots[1].width, WIN.width);
  assert.equal(a.slots[1].height, WIN.height);
  const per = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1040 }, { x: 3840, y: 0, width: 1920, height: 1040 }]);
  assert.equal(per.slots[1].width, WIN.width, 'a whole monitor to itself does not make the window bigger');
});

test('every browser slot reports the default viewport (the window IS the viewport)', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }]);
  for (const i of [1, 2, 3]) assert.deepEqual(a.slots[i].viewport, VP);
});

test('tiny single display flags LAYOUT_SPACE_INSUFFICIENT (the default viewport is still reported)', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 900, height: 500 }]);
  assert.equal(a.placement, 'GRID_2x2');
  assert.equal(a.insufficient, true);
  assert.equal(a.insufficientReason, 'LAYOUT_SPACE_INSUFFICIENT');
  for (const i of [1, 2, 3]) assert.deepEqual(a.slots[i].viewport, VP);
});

test('deterministic: the same topology always yields slot i for browser i', () => {
  const mons = [{ x: 0, y: 0, width: 3840, height: 1040 }, { x: 3840, y: 0, width: 1920, height: 1040 }, { x: 5760, y: 0, width: 1920, height: 1040 }];
  const a = arrangeClusterWindows(mons);
  const b = arrangeClusterWindows(mons);
  assert.deepEqual(a.slots, b.slots);
  assert.ok(a.slots[1].x < a.slots[3].x, 'slot 1 is on the left-most monitor');
});
