'use strict';

// ===========================================================================
// Shared, pure window-bounds normalization for BOTH products (Control + Analytics).
//
// Guarantees the returned rectangle is fully contained inside the TARGET DISPLAY's
// workArea (NOT raw display bounds), so the window always opens fully visible and
// correctly sized on first show — the user never has to maximize/restore/resize once.
//
// DPI-safe: Electron's screen workArea is reported in DIP (device-independent pixels),
// the SAME coordinate space as BrowserWindow bounds, so we clamp directly with no
// devicePixelRatio math. This holds at 100/125/150/175% Windows scaling.
//
// No electron import — this module is pure and deterministically unit-testable with
// mocked work areas (single-monitor CI can still cover multi-monitor cases).
// ===========================================================================

const MAX_DIM = 10000;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// clampToWorkArea(rect, workArea) -> a rectangle fully inside workArea.
//   size : width/height are shrunk to fit (never larger than the work area).
//   pos  : the near edge is pushed in, then the far edge is pulled back so the
//          whole window is on-screen; missing x/y are centered in the work area.
function clampToWorkArea(rect, workArea) {
  const wa = {
    x: num(workArea && workArea.x, 0),
    y: num(workArea && workArea.y, 0),
    width: Math.max(1, num(workArea && workArea.width, 1)),
    height: Math.max(1, num(workArea && workArea.height, 1)),
  };

  const width = Math.max(1, Math.min(Math.round(num(rect.width, wa.width)), wa.width));
  const height = Math.max(1, Math.min(Math.round(num(rect.height, wa.height)), wa.height));

  const hasPos = Number.isFinite(Number(rect.x)) && Number.isFinite(Number(rect.y));
  let x = hasPos ? Math.round(Number(rect.x)) : wa.x + Math.round((wa.width - width) / 2);
  let y = hasPos ? Math.round(Number(rect.y)) : wa.y + Math.round((wa.height - height) / 2);

  // Pull the far edge back inside first, then guarantee the near edge is inside.
  // Order matters: near-edge clamp wins so x >= wa.x / y >= wa.y always holds.
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));

  return { x, y, width, height };
}

// normalizeWindowBounds({ saved, workArea, defaults }) -> { x, y, width, height, minWidth, minHeight }
//
//   saved     : previously persisted { x, y, width, height } (may be stale / off-screen / missing)
//   workArea  : the target display's work area { x, y, width, height }
//   defaults  : { width, height, minWidth, minHeight } — the product's preferred size + minimums
//
//   - a valid saved size is preferred, otherwise the product default is used
//   - the chosen size is shrunk to fit the work area (never assume 1920x1080)
//   - minWidth/minHeight are ALSO clamped to the work area: an enforced minimum larger
//     than the screen would let Electron re-inflate the window and overflow again
//   - the final rectangle is guaranteed fully inside workArea
function normalizeWindowBounds({ saved, workArea, defaults } = {}) {
  const wa = {
    x: num(workArea && workArea.x, 0),
    y: num(workArea && workArea.y, 0),
    width: Math.max(1, num(workArea && workArea.width, 1)),
    height: Math.max(1, num(workArea && workArea.height, 1)),
  };
  const d = defaults || {};
  const minW = Math.max(0, num(d.minWidth, 0));
  const minH = Math.max(0, num(d.minHeight, 0));
  const defW = num(d.width, wa.width);
  const defH = num(d.height, wa.height);

  const s = saved || {};
  const sw = num(s.width, NaN);
  const sh = num(s.height, NaN);
  const validSize =
    Number.isFinite(sw) && Number.isFinite(sh) &&
    sw >= minW && sh >= minH && sw <= MAX_DIM && sh <= MAX_DIM;

  const rect = {
    width: validSize ? sw : defW,
    height: validSize ? sh : defH,
  };
  const sx = Number(s.x);
  const sy = Number(s.y);
  if (Number.isFinite(sx) && Number.isFinite(sy)) { rect.x = sx; rect.y = sy; }

  const clamped = clampToWorkArea(rect, wa);
  return {
    ...clamped,
    minWidth: Math.min(minW, wa.width),
    minHeight: Math.min(minH, wa.height),
  };
}

module.exports = { normalizeWindowBounds, clampToWorkArea, MAX_DIM };
