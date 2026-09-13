'use strict';

// ---------------------------------------------------------------------------
// PURE 2×2 workspace geometry (§9/§13). Given the current display work area, it
// computes four quadrants: three for the managed external Chrome windows (Profile
// A/B/C) and one for the Electron control window. This is layout MATH only — the
// caller applies it (chrome --window-position/--window-size for the browsers, and
// BrowserWindow.setBounds for the control). No OS calls, so it is unit-testable.
//
// Layout:
//   ┌───────────┬───────────┐
//   │  A (TL)   │  B (TR)   │
//   ├───────────┼───────────┤
//   │  C (BL)   │ CONTROL   │
//   └───────────┴───────────┘
// ---------------------------------------------------------------------------

const SLOTS = Object.freeze(['A', 'B', 'C']);

function computeGridLayout(workArea = {}, opts = {}) {
  const gap = Number.isFinite(opts.gap) ? opts.gap : 6;
  const x0 = Math.round(Number(workArea.x) || 0);
  const y0 = Math.round(Number(workArea.y) || 0);
  const W = Math.max(400, Math.round(Number(workArea.width) || 1280));
  const H = Math.max(300, Math.round(Number(workArea.height) || 800));
  const cellW = Math.floor((W - gap) / 2);
  const cellH = Math.floor((H - gap) / 2);
  const rightX = x0 + cellW + gap;
  const bottomY = y0 + cellH + gap;
  const rect = (x, y) => ({ x, y, width: cellW, height: cellH });
  return {
    A: rect(x0, y0),          // top-left
    B: rect(rightX, y0),      // top-right
    C: rect(x0, bottomY),     // bottom-left
    control: rect(rightX, bottomY), // bottom-right (Electron control window)
  };
}

// The geometry for one profile slot ('A'|'B'|'C').
function rectForSlot(workArea, slot, opts) {
  const layout = computeGridLayout(workArea, opts);
  return layout[slot] || null;
}

// The Electron TOOL window bounds (§11): the bottom-right quadrant of the current
// work area (≈ 1/4), anchored to the bottom-right corner. A minimum usable size is
// enforced by GROWING the rect leftward/upward (never past the work-area origin) so
// controls are never clipped; on a work area smaller than the minimum the rect is
// clamped to the whole work area (UI then scrolls). Pure math — deterministically
// testable with mocked work areas. Never exceeds the work area (taskbar-safe) and
// never assumes a fixed resolution.
function toolWindowBounds(workArea = {}, opts = {}) {
  const x0 = Math.round(Number(workArea.x) || 0);
  const y0 = Math.round(Number(workArea.y) || 0);
  const W = Math.max(1, Math.round(Number(workArea.width) || 1280));
  const H = Math.max(1, Math.round(Number(workArea.height) || 800));
  const minW = Math.max(0, Math.round(Number(opts.minWidth) || 0));
  const minH = Math.max(0, Math.round(Number(opts.minHeight) || 0));
  // Start from the quadrant; grow to the minimum; never larger than the work area.
  let width = Math.min(W, Math.max(Math.floor(W / 2), Math.min(minW, W)));
  let height = Math.min(H, Math.max(Math.floor(H / 2), Math.min(minH, H)));
  // Anchor bottom-right, then guarantee the near edge stays inside the work area.
  let x = Math.max(x0, x0 + W - width);
  let y = Math.max(y0, y0 + H - height);
  return { x, y, width, height };
}

// Chrome CLI window flags for a rect (credential-free; geometry only).
function chromeWindowArgs(rect) {
  if (!rect) return [];
  return [`--window-position=${Math.round(rect.x)},${Math.round(rect.y)}`, `--window-size=${Math.round(rect.width)},${Math.round(rect.height)}`];
}

module.exports = { SLOTS, computeGridLayout, rectForSlot, chromeWindowArgs, toolWindowBounds };
