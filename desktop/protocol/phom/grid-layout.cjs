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

// Chrome CLI window flags for a rect (credential-free; geometry only).
function chromeWindowArgs(rect) {
  if (!rect) return [];
  return [`--window-position=${Math.round(rect.x)},${Math.round(rect.y)}`, `--window-size=${Math.round(rect.width)},${Math.round(rect.height)}`];
}

module.exports = { SLOTS, computeGridLayout, rectForSlot, chromeWindowArgs };
