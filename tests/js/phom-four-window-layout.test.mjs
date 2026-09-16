// PHASE 6.2 — the FOUR-window desktop arrangement (3 desktop Chromium windows + the Tool window),
// deterministic across the live monitor topology. Pure geometry: slot i -> Browser i, the Tool is the
// 4th region, browser windows are DESKTOP-sized (fill their monitor region, not a mobile size), and the
// mobile-landscape viewport value is preserved (device emulation itself is unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { arrangeClusterWindows } = require('../../desktop/protocol/phom/grid-layout.cjs');

const PIXEL5 = { viewportWidth: 851, viewportHeight: 393 };
const DEV = [PIXEL5, PIXEL5, PIXEL5];
const overlap = (a, b) => { const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)); const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); return x * y; };

test('produces four windows: three browser slots + the Tool', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], DEV);
  assert.ok(a.slots[1] && a.slots[2] && a.slots[3], 'three browser slots');
  assert.ok(a.tool && Number.isFinite(a.tool.width) && Number.isFinite(a.tool.height), 'a Tool window rect');
});

test('single monitor => 2×2 quadrants (B1 TL, B2 TR, B3 BL, Tool BR), no overlap', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], DEV);
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
  const a = arrangeClusterWindows(mons, DEV);
  assert.equal(a.placement, 'PER_MONITOR_4');
  assert.ok(a.slots[1].x < 1920, 'B1 on monitor 0');
  assert.ok(a.slots[2].x >= 1920 && a.slots[2].x < 3840, 'B2 on monitor 1');
  assert.ok(a.slots[3].x >= 3840 && a.slots[3].x < 5760, 'B3 on monitor 2');
  assert.ok(a.tool.x >= 5760, 'Tool on monitor 3');
});

test('3 monitors => B1/B2/B3 one per monitor, Tool docks on monitor 3', () => {
  const mons = [0, 1, 2].map((i) => ({ x: i * 1920, y: 0, width: 1920, height: 1040 }));
  const a = arrangeClusterWindows(mons, DEV);
  assert.equal(a.placement, 'PER_MONITOR_3');
  assert.ok(a.tool.x >= 3840, 'Tool docked on the 3rd monitor');
  assert.equal(overlap(a.slots[1], a.slots[2]), 0);
});

test('2 monitors => B1|B2 split monitor 0, B3 + Tool on monitor 1', () => {
  const mons = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1040 }];
  const a = arrangeClusterWindows(mons, DEV);
  assert.equal(a.placement, 'SPLIT_2');
  assert.ok(a.slots[1].x < 1920 && a.slots[2].x < 1920, 'B1,B2 on monitor 0');
  assert.equal(overlap(a.slots[1], a.slots[2]), 0, 'B1,B2 split without overlap');
  assert.ok(a.slots[3].x >= 1920 && a.tool.x >= 1920, 'B3 + Tool on monitor 1');
});

test('browser windows are DESKTOP-sized (fill the monitor region), not a mobile size', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], DEV);
  // a 2x2 quadrant on 1920x1040 is ~956x516 — far larger than the ~867 mobile window; a real desktop window
  assert.ok(a.slots[1].width > 851 + 16, 'wider than a viewport-sized mobile window');
  const per = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1040 }, { x: 3840, y: 0, width: 1920, height: 1040 }], DEV);
  assert.ok(per.slots[1].width > 1200, 'per-monitor browser window fills most of the monitor');
});

test('the mobile-landscape viewport is preserved on every browser slot (emulation unchanged)', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], [{ viewportWidth: 851, viewportHeight: 393 }, { viewportWidth: 800, viewportHeight: 360 }, { viewportWidth: 915, viewportHeight: 412 }]);
  assert.deepEqual(a.slots[1].viewport, { width: 851, height: 393 });
  assert.deepEqual(a.slots[2].viewport, { width: 800, height: 360 });
  assert.deepEqual(a.slots[3].viewport, { width: 915, height: 412 });
});

test('tiny single display flags LAYOUT_SPACE_INSUFFICIENT (viewport still preserved)', () => {
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 900, height: 500 }], DEV);
  assert.equal(a.placement, 'GRID_2x2');
  assert.equal(a.insufficient, true);
  assert.equal(a.insufficientReason, 'LAYOUT_SPACE_INSUFFICIENT');
  for (const i of [1, 2, 3]) assert.deepEqual(a.slots[i].viewport, { width: 851, height: 393 });
});

test('deterministic: reversed device list still yields slot i for browser i', () => {
  const devs = [{ viewportWidth: 851, viewportHeight: 393 }, { viewportWidth: 800, viewportHeight: 360 }, { viewportWidth: 915, viewportHeight: 412 }];
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 3840, height: 1040 }, { x: 3840, y: 0, width: 1920, height: 1040 }, { x: 5760, y: 0, width: 1920, height: 1040 }], devs);
  assert.deepEqual(a.slots[1].viewport, { width: 851, height: 393 });
  assert.deepEqual(a.slots[3].viewport, { width: 915, height: 412 });
});
