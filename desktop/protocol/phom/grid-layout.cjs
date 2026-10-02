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

// The four Phỏm windows (3 browsers + the Tool) FILL the work area together, so the game is as large as
// the screen allows. `DEFAULT_VIEWPORT` is only the smallest viewport the tool considers comfortable: a
// region below it is reported as LAYOUT_SPACE_INSUFFICIENT, never silently accepted.
const { DEFAULT_VIEWPORT, WINDOW_CHROME } = require('../../browser-run/browser-agent.cjs');
function _normMon(m) { return { x: Math.round(Number(m && m.x) || 0), y: Math.round(Number(m && m.y) || 0), width: Math.max(320, Math.round(Number(m && m.width) || 1280)), height: Math.max(240, Math.round(Number(m && m.height) || 800)) }; }

// PHASE-6.2 — the FOUR-window desktop arrangement: three real Chromium browser windows (1/2/3) + the
// Tool window, deterministic across the live monitor topology (slot i ALWAYS Browser i; the Tool is the
// 4th region). Each window FILLS the region it is given, so the four windows together cover the screen
// with no wasted desktop: the game is as large as the screen allows, and the page's viewport is simply
// that window minus the browser chrome (nothing is emulated or scaled).
//   ≥4 monitors → B1..B3 fill mon0..2, Tool on mon3
//   3 monitors  → B1..B3 fill mon0..2, Tool docks bottom-right of mon2
//   2 monitors  → B1|B2 split mon0, B3 fills mon1, Tool docks bottom-right of mon1
//   1 monitor   → 2×2 quadrants: B1 TL, B2 TR, B3 BL, Tool BR (no overlap)
function _toolDock(m, opts) { const w = Math.min(m.width, Number.isFinite(opts.toolWidth) ? opts.toolWidth : 560); const h = Math.min(m.height, Number.isFinite(opts.toolHeight) ? opts.toolHeight : 260); return { x: m.x + m.width - w, y: m.y + m.height - h, width: w, height: h }; }
// A browser window FILLS the region allocated to it (a full monitor, a half-monitor for SPLIT_2, or a
// quadrant for GRID_2x2). Its viewport is the region minus the browser chrome.
function _regionWindowRect(region, opts) {
  const frameW = Number.isFinite(opts.frameWidth) ? opts.frameWidth : WINDOW_CHROME.frameWidth;
  const chromeH = Number.isFinite(opts.chromeHeight) ? opts.chromeHeight : WINDOW_CHROME.chromeHeight;
  const width = Math.round(region.width);
  const height = Math.round(region.height);
  return { x: Math.round(region.x), y: Math.round(region.y), width, height, viewport: { width: Math.max(1, width - frameW), height: Math.max(1, height - chromeH) } };
}
function arrangeClusterWindows(monitors, opts = {}) {
  const mons = (Array.isArray(monitors) && monitors.length ? monitors : [{ x: 0, y: 0, width: 1280, height: 800 }]).map(_normMon);
  const regionRect = (region) => _regionWindowRect(region, opts);
  const slots = { 1: null, 2: null, 3: null };
  let tool = null, placement, insufficient = false;
  if (mons.length >= 4) {
    placement = 'PER_MONITOR_4';
    for (let i = 1; i <= 3; i++) slots[i] = regionRect(mons[i - 1]);
    tool = _toolDock(mons[3], opts);
  } else if (mons.length === 3) {
    placement = 'PER_MONITOR_3';
    slots[1] = regionRect(mons[0]);
    slots[2] = regionRect(mons[1]);
    slots[3] = regionRect(mons[2]);
    tool = _toolDock(mons[2], opts);
  } else if (mons.length === 2) {
    placement = 'SPLIT_2';
    const m0 = mons[0]; const halfW = Math.floor((m0.width - 8) / 2);
    const region1 = { x: m0.x, y: m0.y, width: halfW, height: m0.height };
    const region2 = { x: m0.x + halfW + 8, y: m0.y, width: halfW, height: m0.height };
    slots[1] = regionRect(region1);
    slots[2] = regionRect(region2);
    slots[3] = regionRect(mons[1]);
    tool = _toolDock(mons[1], opts);
  } else {
    placement = 'GRID_2x2';
    const g = computeGridLayout(mons[0], { gap: Number.isFinite(opts.gap) ? opts.gap : 8 });
    slots[1] = regionRect(g.A);
    slots[2] = regionRect(g.B);
    slots[3] = regionRect(g.C);
    tool = g.control;
  }
  // A region can be smaller than the default viewport on a low-res display: the window still fills it, but
  // the game then gets less room than the tool's own default — flag the tight space honestly.
  for (const i of [1, 2, 3]) {
    if (slots[i].viewport.width < DEFAULT_VIEWPORT.width || slots[i].viewport.height < DEFAULT_VIEWPORT.height) insufficient = true;
  }
  return { slots, tool, monitors: mons.length, placement, insufficient, insufficientReason: insufficient ? 'LAYOUT_SPACE_INSUFFICIENT' : null };
}

// Chrome CLI window flags for a rect (credential-free; geometry only).
function chromeWindowArgs(rect) {
  if (!rect) return [];
  return [`--window-position=${Math.round(rect.x)},${Math.round(rect.y)}`, `--window-size=${Math.round(rect.width)},${Math.round(rect.height)}`];
}

module.exports = { SLOTS, computeGridLayout, rectForSlot, chromeWindowArgs, toolWindowBounds, arrangeClusterWindows, WINDOW_CHROME, DEFAULT_VIEWPORT };
