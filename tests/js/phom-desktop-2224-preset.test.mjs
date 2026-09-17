// §6.3.13 — STANDARD DISPLAY PRESET for 22"/24" monitors.
// The new "Desktop 22/24" — 16:9" preset (game viewport 600×338) must:
//   (a) exist in the catalog with the documented dimensions + DESKTOP_16_9 type,
//   (b) keep mobile/touch emulation ON (the Cocos game needs it),
//   (c) let THREE B1/B2/B3 windows tile side-by-side on ONE 1920×1080 monitor,
//   (d) NOT disturb the existing presets (mobile 851×393 stays; nothing migrated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dp = require('../../desktop/browser-run/device-profile.cjs');
const gl = require('../../desktop/protocol/phom/grid-layout.cjs');

const PRESET_ID = 'desktop-22-24-16x9';

test('Desktop 22/24" preset exists with 600×338 16:9 viewport + DESKTOP_16_9 type', () => {
  const p = dp.listProfilePresets().find((x) => x.id === PRESET_ID);
  assert.ok(p, 'preset present in catalog');
  assert.equal(p.name, 'Desktop 22/24" — 16:9');
  assert.equal(p.profileType, 'DESKTOP_16_9');
  assert.equal(p.viewportWidth, 600);
  assert.equal(p.viewportHeight, 338);
  // ~16:9 (600/338 = 1.775 ≈ 1.778).
  assert.ok(Math.abs(p.viewportWidth / p.viewportHeight - 16 / 9) < 0.01, 'aspect ≈ 16:9');
  // §8 — emulation stays ON; the tag describes the DISPLAY, not the emulation.
  assert.equal(p.mobile, true);
  assert.equal(p.touch, true);
  // §2 — no explicit OS window: the geometry layer derives viewport + chrome allowance.
  assert.equal(p.osWindowWidth, null);
  assert.equal(p.osWindowHeight, null);
});

test('Desktop 22/24" preset normalizes into a valid landscape device', () => {
  const r = dp.normalizeDeviceProfile({ presetId: PRESET_ID });
  assert.equal(r.ok, true);
  assert.equal(r.device.profileType, 'DESKTOP_16_9');
  assert.equal(r.device.viewportWidth, 600);
  assert.equal(r.device.viewportHeight, 338);
  assert.equal(r.device.mobile, true);
  assert.equal(r.device.touch, true);
  assert.ok(r.device.viewportWidth > r.device.viewportHeight, 'landscape viewport');
});

test('three Desktop 22/24" windows tile on ONE 1920×1080 monitor without overlap', () => {
  const dev = dp.normalizeDeviceProfile({ presetId: PRESET_ID }).device;
  const arr = gl.arrangeBrowserWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], [dev, dev, dev], {});
  assert.equal(arr.placement, 'TILED');
  assert.equal(arr.insufficient, false, 'three windows fit — no spread/overlap');
  const rects = [1, 2, 3].map((k) => arr.slots[k]);
  // Every window stays inside the monitor and preserves the 600×338 emulated viewport.
  for (const s of rects) {
    assert.ok(s.x >= 0 && s.x + s.width <= 1920, 'window inside 1920 width');
    assert.equal(s.viewport.width, 600);
    assert.equal(s.viewport.height, 338);
  }
  // Non-overlapping left→right.
  assert.ok(rects[0].x + rects[0].width <= rects[1].x, 'B1 before B2');
  assert.ok(rects[1].x + rects[1].width <= rects[2].x, 'B2 before B3');
});

test('§4/§11 — existing presets are preserved (mobile 851×393 untouched)', () => {
  const byId = Object.fromEntries(dp.listProfilePresets().map((p) => [p.id, p]));
  const pixel = byId['android-pixel5-landscape'];
  assert.ok(pixel, 'mobile-landscape preset still present');
  assert.equal(pixel.viewportWidth, 851);
  assert.equal(pixel.viewportHeight, 393);
  assert.equal(pixel.profileType, 'MOBILE_LANDSCAPE');
  // The current 3× mobile-landscape windows are exactly the OVERFLOW case the new
  // preset solves: 3 × (851 + chrome) exceeds 1920 (documents the "why").
  const mob = dp.normalizeDeviceProfile({ presetId: 'android-pixel5-landscape' }).device;
  const arr = gl.arrangeBrowserWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], [mob, mob, mob], {});
  assert.equal(arr.insufficient, true, 'three mobile windows do NOT fit 1920 (motivates the preset)');
});
