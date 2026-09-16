// PHASE 6.2.4 — Flexible device profiles: Desktop / Laptop / Laptop Small /
// Mobile Landscape / Custom, with an OS Window axis that is INDEPENDENT from the
// game Viewport (§8). Chromium Browser 1/2/3 remain desktop OS windows in every
// case; a "mobile" profile is just a CDP emulation applied inside a desktop OS
// window. These tests exercise the model + geometry layer directly (pure math
// only — no OS calls, no Chromium launch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dp = require('../../desktop/browser-run/device-profile.cjs');
const { PhomProfileStore } = require('../../desktop/browser-run/phom-profile-store.cjs');
const { arrangeClusterWindows, desktopWindowRectForSlot, WINDOW_CHROME } = require('../../desktop/protocol/phom/grid-layout.cjs');

// ---------------------------------------------------------------------------
// The full preset catalog exposes every documented profile type.
// ---------------------------------------------------------------------------
test('listProfilePresets exposes Desktop / Laptop / Laptop Small / Mobile Landscape', () => {
  const presets = dp.listProfilePresets();
  const byId = Object.fromEntries(presets.map((p) => [p.id, p]));
  assert.ok(byId['desktop-1920x1080'], 'Desktop 1920×1080 preset exists');
  assert.ok(byId['laptop-1366x768'], 'Laptop 1366×768 preset exists');
  assert.ok(byId['laptop-small-960x540'], 'Laptop Small 960×540 preset exists');
  assert.ok(byId['laptop-small-mobile-landscape'], 'Laptop Small + Mobile Landscape preset exists');
  // §11 — existing mobile presets must be preserved.
  assert.ok(byId['android-pixel5-landscape'], 'Pixel 5 (Ngang) preserved');
  assert.ok(byId['android-galaxy-s20-landscape'], 'Galaxy S20 (Ngang) preserved');
  assert.ok(byId['android-generic-412-landscape'], 'Android 12 (Ngang) preserved');
});

test('listPresets (legacy) still returns only mobile-landscape presets', () => {
  const legacy = dp.listPresets();
  assert.ok(legacy.length >= 3);
  for (const p of legacy) {
    assert.equal(p.profileType, 'MOBILE_LANDSCAPE');
    assert.ok(p.viewportWidth > p.viewportHeight, `${p.id} is landscape`);
    assert.equal(p.mobile, true);
    assert.equal(p.touch, true);
  }
});

// ---------------------------------------------------------------------------
// normalizeDeviceProfile — each documented profile type produces a valid device.
// ---------------------------------------------------------------------------
test('DESKTOP 1920×1080 profile is valid (mouse only, no touch)', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'desktop-1920x1080' });
  assert.equal(r.ok, true);
  assert.equal(r.device.profileType, 'DESKTOP');
  assert.equal(r.device.osWindowWidth, 1920);
  assert.equal(r.device.osWindowHeight, 1080);
  assert.equal(r.device.viewportWidth, 1920);
  assert.equal(r.device.viewportHeight, 1080);
  assert.equal(r.device.mobile, false);
  assert.equal(r.device.touch, false);
});

test('LAPTOP 1366×768 profile is valid (mouse only)', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'laptop-1366x768' });
  assert.equal(r.ok, true);
  assert.equal(r.device.profileType, 'LAPTOP');
  assert.equal(r.device.osWindowWidth, 1366);
  assert.equal(r.device.osWindowHeight, 768);
  assert.equal(r.device.mobile, false);
  assert.equal(r.device.touch, false);
});

test('LAPTOP_SMALL 960×540 profile is valid', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'laptop-small-960x540' });
  assert.equal(r.ok, true);
  assert.equal(r.device.profileType, 'LAPTOP_SMALL');
  assert.equal(r.device.osWindowWidth, 960);
  assert.equal(r.device.osWindowHeight, 540);
});

test('LAPTOP_SMALL + Mobile Landscape viewport (960×540 OS + 851×393 VP + touch)', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'laptop-small-mobile-landscape' });
  assert.equal(r.ok, true);
  // OS Window is a Desktop 960×540 Chromium window.
  assert.equal(r.device.osWindowWidth, 960);
  assert.equal(r.device.osWindowHeight, 540);
  // Emulated game viewport is mobile landscape 851×393 (independent from OS window).
  assert.equal(r.device.viewportWidth, 851);
  assert.equal(r.device.viewportHeight, 393);
  assert.equal(r.device.touch, true);
  assert.equal(r.device.mobile, true);
  assert.equal(r.device.orientationType, 'landscapePrimary');
});

test('CUSTOM: desktop OS window with a mobile-landscape viewport is valid', () => {
  // §8 — OS window and viewport are INDEPENDENT. A user may build any mix.
  const r = dp.normalizeDeviceProfile({
    profileType: 'CUSTOM',
    osWindowWidth: 960, osWindowHeight: 540,
    viewportWidth: 851, viewportHeight: 393, screenWidth: 851, screenHeight: 393,
    deviceScaleFactor: 2, mobile: true, touch: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.device.osWindowWidth, 960);
  assert.equal(r.device.osWindowHeight, 540);
  assert.equal(r.device.viewportWidth, 851);
  assert.equal(r.device.viewportHeight, 393);
});

test('OS window dimensions must be positive integers when provided', () => {
  const bad = dp.normalizeDeviceProfile({ presetId: 'laptop-1366x768', osWindowWidth: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'PHOM_DEVICE_INVALID');
});

test('viewport width/height must be positive integers', () => {
  assert.equal(dp.normalizeDeviceProfile({ viewportWidth: 0, viewportHeight: 100, deviceScaleFactor: 1 }).error.code, 'PHOM_DEVICE_INVALID');
});

// ---------------------------------------------------------------------------
// Existing mobile presets still work end-to-end (§11).
// ---------------------------------------------------------------------------
test('Pixel 5 (Ngang) preset still normalizes cleanly', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'android-pixel5-landscape' });
  assert.equal(r.ok, true);
  assert.equal(r.device.profileType, 'MOBILE_LANDSCAPE');
  assert.equal(r.device.viewportWidth, 851); assert.equal(r.device.viewportHeight, 393);
  // Mobile preset has no explicit OS window (Desktop Window sized by geometry layer).
  assert.equal(r.device.osWindowWidth, null);
  assert.equal(r.device.osWindowHeight, null);
});
test('Galaxy S20 (Ngang) preset still normalizes cleanly', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'android-galaxy-s20-landscape' });
  assert.equal(r.ok, true);
  assert.equal(r.device.viewportWidth, 800); assert.equal(r.device.viewportHeight, 360);
});
test('Android 12 (Ngang) preset still normalizes cleanly', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'android-generic-412-landscape' });
  assert.equal(r.ok, true);
  assert.equal(r.device.viewportWidth, 915); assert.equal(r.device.viewportHeight, 412);
});

// ---------------------------------------------------------------------------
// The three slots can carry different profile types (§14).
// ---------------------------------------------------------------------------
test('B1/B2/B3 can reference DIFFERENT profile types (Desktop / Laptop / Laptop Small + Mobile)', () => {
  const store = new PhomProfileStore({ filePath: null });
  store.upsert('A', { name: 'B1', device: { presetId: 'desktop-1920x1080' } });
  store.upsert('B', { name: 'B2', device: { presetId: 'laptop-1366x768' } });
  store.upsert('C', { name: 'B3', device: { presetId: 'laptop-small-mobile-landscape' } });
  const A = store.getPublic('A'), B = store.getPublic('B'), C = store.getPublic('C');
  assert.equal(A.device.profileType, 'DESKTOP');
  assert.equal(B.device.profileType, 'LAPTOP');
  assert.equal(C.device.profileType, 'CUSTOM');
  assert.equal(C.device.osWindowWidth, 960);
  assert.equal(C.device.viewportWidth, 851);
});

// ---------------------------------------------------------------------------
// Geometry — grid-layout consumes OS window size when a device carries one (§7/§8).
// ---------------------------------------------------------------------------
test('desktopWindowRectForSlot uses osWindow size directly when a device supplies one', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const dev = { osWindowWidth: 960, osWindowHeight: 540, viewportWidth: 851, viewportHeight: 393 };
  const a = desktopWindowRectForSlot(wa, 'A', dev);
  assert.equal(a.width, 960, 'width = OS window width (not viewport + chrome)');
  assert.equal(a.height, 540, 'height = OS window height');
  assert.deepEqual(a.viewport, { width: 851, height: 393 }, 'emulated viewport preserved');
});

test('desktopWindowRectForSlot falls back to viewport + chrome for legacy mobile devices', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  // Legacy mobile-only shape: no osWindow → viewport + chrome allowance kicks in.
  const dev = { viewportWidth: 851, viewportHeight: 393 };
  const a = desktopWindowRectForSlot(wa, 'A', dev);
  assert.equal(a.width, 851 + WINDOW_CHROME.frameWidth);
  assert.equal(a.height, 393 + WINDOW_CHROME.chromeHeight);
});

test('arrangeClusterWindows honors device.osWindow on per-monitor placements', () => {
  const mons = [0, 1, 2, 3].map((i) => ({ x: i * 1920, y: 0, width: 1920, height: 1040 }));
  const devs = [
    { osWindowWidth: 1920, osWindowHeight: 1080, viewportWidth: 1920, viewportHeight: 1080 }, // Desktop
    { osWindowWidth: 1366, osWindowHeight: 768,  viewportWidth: 1366, viewportHeight: 768 }, // Laptop
    { osWindowWidth: 960,  osWindowHeight: 540,  viewportWidth: 851,  viewportHeight: 393 }, // Laptop Small + Mobile
  ];
  const a = arrangeClusterWindows(mons, devs);
  assert.equal(a.placement, 'PER_MONITOR_4');
  // OS window sizes are the authoritative Chromium window sizes.
  assert.equal(a.slots[1].width, 1920);
  assert.equal(a.slots[2].width, 1366);
  assert.equal(a.slots[3].width, 960);
  assert.equal(a.slots[3].height, 540);
  // Emulated viewport is preserved for reference (CDP applies it separately).
  assert.deepEqual(a.slots[3].viewport, { width: 851, height: 393 });
});

test('arrangeClusterWindows still fills a monitor when device has no explicit OS window', () => {
  // Legacy behavior for viewport-only devices — the 4-window layout test suite already
  // relies on this fallback (fill 90% of the monitor).
  const mons = [0, 1, 2, 3].map((i) => ({ x: i * 1920, y: 0, width: 1920, height: 1040 }));
  const devs = [{ viewportWidth: 851, viewportHeight: 393 }, { viewportWidth: 851, viewportHeight: 393 }, { viewportWidth: 851, viewportHeight: 393 }];
  const a = arrangeClusterWindows(mons, devs);
  assert.equal(a.placement, 'PER_MONITOR_4');
  // Filled 90% of a 1920-wide monitor.
  assert.ok(a.slots[1].width > 1200);
});

test('OS window and emulated viewport are independent (no cross-axis coupling)', () => {
  // The whole point of the split: a small Desktop OS window can host a smaller
  // mobile-landscape viewport. Neither dimension is derived from the other.
  const r = dp.normalizeDeviceProfile({
    profileType: 'CUSTOM',
    osWindowWidth: 960, osWindowHeight: 540,
    viewportWidth: 851, viewportHeight: 393, screenWidth: 851, screenHeight: 393,
    deviceScaleFactor: 2.75, mobile: true, touch: true,
    orientationType: 'landscapePrimary',
  });
  assert.equal(r.ok, true);
  // OS window is not enlarged to match viewport, and viewport is not shrunk to match OS window.
  assert.notEqual(r.device.osWindowWidth, r.device.viewportWidth);
  // Publish surface exposes both dimensions distinctly.
  const snap = dp.publicSnapshot(r.device);
  assert.equal(snap.osWindow, '960 × 540');
  assert.equal(snap.resolution, '851 × 393');
});

test('CDP emulation uses viewport (not OS window) as its device metrics', () => {
  const { device } = dp.normalizeDeviceProfile({ presetId: 'laptop-small-mobile-landscape' });
  const cdp = dp.toCdpEmulation(device);
  // Device metrics reflect the game viewport, NOT the OS window.
  assert.equal(cdp.deviceMetrics.width, 851);
  assert.equal(cdp.deviceMetrics.height, 393);
  assert.equal(cdp.deviceMetrics.mobile, true);
  assert.equal(cdp.touch.enabled, true);
});

test('Desktop profile CDP emulation is non-mobile with touch disabled', () => {
  const { device } = dp.normalizeDeviceProfile({ presetId: 'desktop-1920x1080' });
  const cdp = dp.toCdpEmulation(device);
  assert.equal(cdp.deviceMetrics.mobile, false);
  assert.equal(cdp.touch.enabled, false);
  assert.equal(cdp.emitTouchForMouse.enabled, false);
});

// ---------------------------------------------------------------------------
// Persistence — no existing profile is lost by the model change (§11).
// ---------------------------------------------------------------------------
test('an old serialized mobile device round-trips through normalize (osWindow stays null)', () => {
  // Simulates loading an existing phom-profiles.json entry saved by the previous
  // model (no osWindow*). The device store passes it back through normalize when
  // upsert is called with just a name change — the OS window field must NOT be
  // forcibly synthesized (existing behavior stays intact).
  const store = new PhomProfileStore({ filePath: null });
  store.upsert('A', { name: 'Legacy A', device: { presetId: 'android-pixel5-landscape' } });
  const a = store.getPublic('A');
  assert.equal(a.device.viewportWidth, 851);
  assert.equal(a.device.osWindowWidth, null);
});
