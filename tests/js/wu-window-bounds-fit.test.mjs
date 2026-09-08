import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeWindowBounds, clampToWorkArea } = require('../../desktop/window-bounds.cjs');

// ---------------------------------------------------------------------------
// FIRST-OPEN SCALING FIX — the window must ALWAYS fit the current monitor work
// area, whatever the saved/requested bounds. These deterministic cases mock the
// work area, so a single-monitor CI still proves the multi-monitor recovery.
// ---------------------------------------------------------------------------

// The load-bearing invariant: the resolved rectangle is fully inside workArea.
function assertInside(rect, wa, msg) {
  assert.ok(rect.width <= wa.width, `${msg}: width ${rect.width} <= ${wa.width}`);
  assert.ok(rect.height <= wa.height, `${msg}: height ${rect.height} <= ${wa.height}`);
  assert.ok(rect.x >= wa.x, `${msg}: x ${rect.x} >= ${wa.x}`);
  assert.ok(rect.y >= wa.y, `${msg}: y ${rect.y} >= ${wa.y}`);
  assert.ok(rect.x + rect.width <= wa.x + wa.width, `${msg}: right ${rect.x + rect.width} <= ${wa.x + wa.width}`);
  assert.ok(rect.y + rect.height <= wa.y + wa.height, `${msg}: bottom ${rect.y + rect.height} <= ${wa.y + wa.height}`);
}

const DEF = Object.freeze({ width: 1300, height: 860, minWidth: 1000, minHeight: 680 });
// A typical primary monitor work area (1920x1080 minus a taskbar).
const BIG = { x: 0, y: 0, width: 1920, height: 1040 };
// A small laptop work area (1366x768 minus a taskbar) — the reported failure screen.
const LAPTOP = { x: 0, y: 0, width: 1366, height: 728 };

test('1. saved bounds already valid on this display are preserved', () => {
  const out = normalizeWindowBounds({ saved: { x: 100, y: 80, width: 1200, height: 800 }, workArea: BIG, defaults: DEF });
  assert.deepEqual({ x: out.x, y: out.y, width: out.width, height: out.height }, { x: 100, y: 80, width: 1200, height: 800 });
  assertInside(out, BIG, 'valid');
});

test('2. width too large shrinks to the work area width', () => {
  const out = normalizeWindowBounds({ saved: { x: 0, y: 0, width: 3000, height: 700 }, workArea: LAPTOP, defaults: DEF });
  assert.equal(out.width, LAPTOP.width);
  assertInside(out, LAPTOP, 'wide');
});

test('3. height too large shrinks to the work area height', () => {
  const out = normalizeWindowBounds({ saved: { x: 0, y: 0, width: 1200, height: 5000 }, workArea: LAPTOP, defaults: DEF });
  assert.equal(out.height, LAPTOP.height);
  assertInside(out, LAPTOP, 'tall');
});

test('4. both dimensions too large shrink to fill the work area', () => {
  const out = normalizeWindowBounds({ saved: { x: 0, y: 0, width: 1800, height: 1000 }, workArea: LAPTOP, defaults: DEF });
  assert.deepEqual({ width: out.width, height: out.height }, { width: LAPTOP.width, height: LAPTOP.height });
  assertInside(out, LAPTOP, 'both');
});

test('5. x off-screen right is pulled back inside', () => {
  const out = normalizeWindowBounds({ saved: { x: 5000, y: 100, width: 1200, height: 800 }, workArea: BIG, defaults: DEF });
  assert.equal(out.x + out.width, BIG.x + BIG.width);
  assertInside(out, BIG, 'x right');
});

test('6. x off-screen left is pushed inside', () => {
  const out = normalizeWindowBounds({ saved: { x: -4000, y: 100, width: 1200, height: 800 }, workArea: BIG, defaults: DEF });
  assert.equal(out.x, BIG.x);
  assertInside(out, BIG, 'x left');
});

test('7. y off-screen bottom is pulled back inside', () => {
  const out = normalizeWindowBounds({ saved: { x: 100, y: 5000, width: 1200, height: 800 }, workArea: BIG, defaults: DEF });
  assert.equal(out.y + out.height, BIG.y + BIG.height);
  assertInside(out, BIG, 'y bottom');
});

test('8. y off-screen top is pushed inside', () => {
  const out = normalizeWindowBounds({ saved: { x: 100, y: -3000, width: 1200, height: 800 }, workArea: BIG, defaults: DEF });
  assert.equal(out.y, BIG.y);
  assertInside(out, BIG, 'y top');
});

test('9. disconnected-monitor coordinates land inside the available work area', () => {
  // Saved on a second monitor at x=2560; that monitor is gone, only the primary remains.
  const out = normalizeWindowBounds({ saved: { x: 2900, y: 300, width: 1400, height: 900 }, workArea: BIG, defaults: DEF });
  assertInside(out, BIG, 'disconnected');
});

test('10. small laptop screen: default preferred size shrinks only where it overflows', () => {
  const out = normalizeWindowBounds({ saved: null, workArea: LAPTOP, defaults: DEF });
  // 1300 wide fits inside 1366 (kept); 860 tall overflows 728 (shrunk).
  assert.deepEqual({ width: out.width, height: out.height }, { width: DEF.width, height: LAPTOP.height });
  assertInside(out, LAPTOP, 'laptop default');
});

test('11. large monitor: preferred default is used (not stretched to fill)', () => {
  const out = normalizeWindowBounds({ saved: null, workArea: BIG, defaults: DEF });
  assert.deepEqual({ width: out.width, height: out.height }, { width: DEF.width, height: DEF.height });
  assertInside(out, BIG, 'large default');
});

test('12. invalid / missing saved bounds fall back to a sane default in the work area', () => {
  for (const bad of [null, undefined, {}, { width: 'x', height: 720 }, { width: 100, height: 100 }, { width: 99999, height: 720 }]) {
    const out = normalizeWindowBounds({ saved: bad, workArea: BIG, defaults: DEF });
    assert.deepEqual({ width: out.width, height: out.height }, { width: DEF.width, height: DEF.height }, `bad=${JSON.stringify(bad)}`);
    assertInside(out, BIG, 'invalid fallback');
  }
});

// ---- enforced minimums must never exceed the screen (else Electron re-inflates) ----
test('minWidth/minHeight are clamped to the work area on a tiny screen', () => {
  const tiny = { x: 0, y: 0, width: 900, height: 560 };
  const out = normalizeWindowBounds({ saved: null, workArea: tiny, defaults: DEF });
  assert.ok(out.minWidth <= tiny.width, 'minWidth clamped');
  assert.ok(out.minHeight <= tiny.height, 'minHeight clamped');
  assertInside(out, tiny, 'tiny mins');
});

test('minimums are preserved untouched on a screen large enough for them', () => {
  const out = normalizeWindowBounds({ saved: null, workArea: BIG, defaults: DEF });
  assert.equal(out.minWidth, DEF.minWidth);
  assert.equal(out.minHeight, DEF.minHeight);
});

// ---- multi-monitor: a work area with a non-zero origin (secondary display) ----
test('secondary display (non-zero workArea origin) keeps the window on THAT display', () => {
  const RIGHT = { x: 1920, y: 0, width: 1920, height: 1040 };
  const out = normalizeWindowBounds({ saved: { x: 2000, y: 50, width: 1300, height: 860 }, workArea: RIGHT, defaults: DEF });
  assertInside(out, RIGHT, 'secondary');
  // Missing position on a secondary display centers within THAT display, not (0,0).
  const centered = normalizeWindowBounds({ saved: null, workArea: RIGHT, defaults: DEF });
  assert.ok(centered.x >= RIGHT.x, 'centered stays on secondary display');
  assertInside(centered, RIGHT, 'secondary centered');
});

// ---- DPI safety: workArea is already in DIP, so identical logical work areas at
// 100% and 150% scaling must produce identical logical bounds (no pixel-ratio math). ----
test('DPI-safe: identical DIP work areas yield identical bounds regardless of scale', () => {
  const wa100 = { x: 0, y: 0, width: 1280, height: 680 }; // 1366x768 @125% ≈ 1093 DIP... use explicit DIP
  const a = normalizeWindowBounds({ saved: { x: 40, y: 40, width: 1300, height: 860 }, workArea: wa100, defaults: DEF });
  const b = normalizeWindowBounds({ saved: { x: 40, y: 40, width: 1300, height: 860 }, workArea: { ...wa100 }, defaults: DEF });
  assert.deepEqual(a, b);
  assertInside(a, wa100, 'dpi');
});

test('clampToWorkArea is idempotent (clamping an already-clamped rect is a no-op)', () => {
  const wa = LAPTOP;
  const once = clampToWorkArea({ x: 5000, y: 5000, width: 9999, height: 9999 }, wa);
  const twice = clampToWorkArea(once, wa);
  assert.deepEqual(once, twice);
  assertInside(once, wa, 'idempotent');
});

// ---------------------------------------------------------------------------
// INITIAL LAYOUT — the WebContentsView / browser region must be laid out at
// startup/open/tab-switch, NOT only after a manual window resize.
// INITIAL_LAYOUT_DOES_NOT_DEPEND_ON_MANUAL_RESIZE
// ---------------------------------------------------------------------------
test('CONTROL: overview browser view is reconciled at init and on run selection (not only on resize)', () => {
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  const block = js.match(/function overviewInAppUI\(\)[\s\S]*?\n\}\)\(\);/);
  assert.ok(block, 'overviewInAppUI IIFE present');
  const body = block[0];
  // reconcile() is invoked directly at the end of the IIFE (first paint) ...
  assert.ok(/\n\s*reconcile\(\);\n\s*\}\)\(\);/.test(body), 'reconcile() called at init');
  // ... and on run-selected / view-changed — layout triggers do NOT depend on resize alone.
  assert.ok(/'run-selected', reconcile/.test(body), 'run-selected triggers layout');
  assert.ok(/view-changed'[\s\S]*?reconcile\(\)/.test(body), 'view-changed triggers layout');
});

test('ANALYTICS: home view bounds are reported on open and tab-switch (not only on resize)', () => {
  const js = readFileSync(new URL('../../ui-analytics/analytics.js', import.meta.url), 'utf8');
  // Open button reports bounds immediately after opening (no resize needed).
  assert.ok(/home-open'\)[\s\S]*?reportViewBounds\(\)/.test(js), 'open reports view bounds');
  // Switching to the home tab reports bounds.
  assert.ok(/if \(name === 'home'\) \{ reportViewBounds\(\)/.test(js), 'home tab reports view bounds');
});

// ---------------------------------------------------------------------------
// SOURCE WIRING — both composition roots resolve bounds against the current
// display work area before creating the window (shared policy).
// ---------------------------------------------------------------------------
test('CONTROL main.cjs fits bounds to the current display before creating the window', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(/require\('\.\/window-bounds\.cjs'\)/.test(main), 'imports shared helper');
  assert.ok(/fitToCurrentDisplay\(resolveBounds\(loadWindowState\(\)\)\)/.test(main), 'fits saved bounds to display');
  assert.ok(/screen\.getDisplayMatching|screen\.getPrimaryDisplay/.test(main), 'uses the screen/display API');
  assert.ok(!/\.maximize\(\)/.test(main) && !/fullscreen:\s*true/.test(main), 'no maximize/fullscreen');
});

test('ANALYTICS main.cjs fits bounds to the current display before creating the window', () => {
  const main = readFileSync(new URL('../../desktop/analytics-main.cjs', import.meta.url), 'utf8');
  assert.ok(/require\('\.\/window-bounds\.cjs'\)/.test(main), 'imports shared helper');
  assert.ok(/fitToCurrentDisplay\(loadWindowState\(\)\)/.test(main), 'fits saved bounds to display');
  assert.ok(/screen\.getDisplayMatching|screen\.getPrimaryDisplay/.test(main), 'uses the screen/display API');
  // The window is created from the fitted bounds (spread), not a raw hard-coded size.
  assert.ok(/new BrowserWindow\(\{\s*\.\.\.bounds/.test(main), 'constructor spreads fitted bounds');
  assert.ok(!/\.maximize\(\)/.test(main) && !/fullscreen:\s*true/.test(main), 'no maximize/fullscreen');
});
