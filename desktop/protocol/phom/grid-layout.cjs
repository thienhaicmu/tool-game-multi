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

// PHASE-3 — a DESKTOP window whose content area fits the profile's MOBILE-LANDSCAPE viewport.
// The window is a normal desktop Chromium window; its size is derived from the device's emulated
// viewport (CSS px) + an allowance for the browser chrome (tab strip + address bar + frame), so the
// mobile-landscape content shows at its true ratio without being squashed. Device emulation itself is
// unchanged (still CDP setDeviceMetricsOverride) — this ONLY sizes/places the native window.
//
// Placement spreads the three windows across the work-area width: A left, C right, B centered. When
// the work area is too narrow for three device-sized windows they overlap in the middle (each stays
// FULL device size + draggable) rather than the viewport being shrunk to fit (§5). Pure math.
const WINDOW_CHROME = Object.freeze({ frameWidth: 16, chromeHeight: 120 });
function desktopWindowRectForSlot(workArea = {}, slot, device = {}, opts = {}) {
  const x0 = Math.round(Number(workArea.x) || 0);
  const y0 = Math.round(Number(workArea.y) || 0);
  const W = Math.max(320, Math.round(Number(workArea.width) || 1280));
  const H = Math.max(240, Math.round(Number(workArea.height) || 800));
  const frameW = Number.isFinite(opts.frameWidth) ? opts.frameWidth : WINDOW_CHROME.frameWidth;
  const chromeH = Number.isFinite(opts.chromeHeight) ? opts.chromeHeight : WINDOW_CHROME.chromeHeight;
  // Device viewport (landscape: width > height). Fallback to a common mobile-landscape size.
  const vw = Math.max(320, Math.round(Number(device.viewportWidth) || 851));
  const vh = Math.max(180, Math.round(Number(device.viewportHeight) || 393));
  // Window OUTER size = viewport + browser chrome, never larger than the work area.
  const width = Math.min(W, vw + frameW);
  const height = Math.min(H, vh + chromeH);
  const idx = Math.max(0, SLOTS.indexOf(slot)); // A=0, B=1, C=2
  const last = SLOTS.length - 1;
  let x;
  if (idx <= 0) x = x0;                         // A: left edge
  else if (idx >= last) x = x0 + W - width;     // C: right edge
  else x = x0 + Math.round((W - width) / 2);    // B: centered
  let y = y0 + Math.max(0, Math.round((H - height) / 2)); // vertically centered
  // Clamp fully inside the work area (taskbar/multi-monitor safe).
  x = Math.min(Math.max(x, x0), x0 + W - width);
  y = Math.min(Math.max(y, y0), y0 + H - height);
  return { x, y, width, height, viewport: { width: vw, height: vh } };
}

// PHASE-6 — deterministic multi-monitor arrangement for the THREE manual browser windows. Slot i ALWAYS
// maps to Browser i (1/2/3) regardless of launch/PID/enumeration order (§7/§34). Each window keeps its
// device mobile-landscape viewport (device emulation is separate); the outer window = viewport + chrome.
//   ≥3 monitors → one browser per monitor (PER_MONITOR)
//   2 monitors  → browsers 1&2 tiled on monitor 0, browser 3 on monitor 1 (SPLIT_2)
//   1 monitor   → all three tiled side-by-side (TILED)
// When a target region cannot fit the device-sized windows side-by-side they are SPREAD (may overlap)
// and `insufficient` is set to LAYOUT_SPACE_INSUFFICIENT — never a silent "perfect" claim, and the
// viewport is NEVER shrunk below the device size (§35).
function _normMon(m) { return { x: Math.round(Number(m && m.x) || 0), y: Math.round(Number(m && m.y) || 0), width: Math.max(320, Math.round(Number(m && m.width) || 1280)), height: Math.max(240, Math.round(Number(m && m.height) || 800)) }; }
function _winSize(device, frameW, chromeH) {
  const vw = Math.max(320, Math.round(Number(device && device.viewportWidth) || 851));
  const vh = Math.max(180, Math.round(Number(device && device.viewportHeight) || 393));
  return { vw, vh, width: vw + frameW, height: chromeH + vh };
}
function _centerIn(size, m) {
  const width = Math.min(size.width, m.width), height = Math.min(size.height, m.height);
  const x = m.x + Math.max(0, Math.round((m.width - width) / 2));
  const y = m.y + Math.max(0, Math.round((m.height - height) / 2));
  return { x, y, width, height, viewport: { width: size.vw, height: size.vh } };
}
// Lay N windows left→right in monitor m. Non-overlapping (gap-separated) when they fit; else spread
// across (overlap allowed) with insufficient=true. Never shrinks the viewport.
function _tileAcross(sizes, m, gap) {
  const n = sizes.length;
  const clamped = sizes.map((s) => ({ ...s, width: Math.min(s.width, m.width), height: Math.min(s.height, m.height) }));
  const total = clamped.reduce((a, s) => a + s.width, 0) + gap * (n - 1);
  const rects = []; let insufficient = false;
  if (total <= m.width) {
    let x = m.x + Math.round((m.width - total) / 2);
    for (const s of clamped) { const y = m.y + Math.max(0, Math.round((m.height - s.height) / 2)); rects.push({ x, y, width: s.width, height: s.height, viewport: { width: s.vw, height: s.vh } }); x += s.width + gap; }
  } else {
    insufficient = true;
    for (let i = 0; i < n; i++) { const s = clamped[i]; const span = n > 1 ? (m.width - s.width) / (n - 1) : 0; const x = Math.round(m.x + i * span); const y = m.y + Math.max(0, Math.round((m.height - s.height) / 2)); rects.push({ x, y, width: s.width, height: s.height, viewport: { width: s.vw, height: s.vh } }); }
  }
  return { rects, insufficient };
}
function arrangeBrowserWindows(monitors, devices, opts = {}) {
  const gap = Number.isFinite(opts.gap) ? opts.gap : 8;
  const frameW = Number.isFinite(opts.frameWidth) ? opts.frameWidth : WINDOW_CHROME.frameWidth;
  const chromeH = Number.isFinite(opts.chromeHeight) ? opts.chromeHeight : WINDOW_CHROME.chromeHeight;
  const mons = (Array.isArray(monitors) && monitors.length ? monitors : [{ x: 0, y: 0, width: 1280, height: 800 }]).map(_normMon);
  const dev = Array.isArray(devices) ? { 1: devices[0], 2: devices[1], 3: devices[2] } : (devices && typeof devices === 'object' ? devices : {});
  const size = (i) => _winSize(dev[i] || {}, frameW, chromeH);
  const slots = { 1: null, 2: null, 3: null };
  let insufficient = false, placement;
  if (mons.length >= 3) {
    placement = 'PER_MONITOR';
    for (let i = 1; i <= 3; i++) { const s = size(i); slots[i] = _centerIn(s, mons[i - 1]); if (s.width > mons[i - 1].width || s.height > mons[i - 1].height) insufficient = true; }
  } else if (mons.length === 2) {
    placement = 'SPLIT_2';
    const pair = _tileAcross([size(1), size(2)], mons[0], gap); slots[1] = pair.rects[0]; slots[2] = pair.rects[1];
    const s3 = size(3); slots[3] = _centerIn(s3, mons[1]); insufficient = pair.insufficient || s3.width > mons[1].width || s3.height > mons[1].height;
  } else {
    placement = 'TILED';
    const t = _tileAcross([size(1), size(2), size(3)], mons[0], gap); slots[1] = t.rects[0]; slots[2] = t.rects[1]; slots[3] = t.rects[2]; insufficient = t.insufficient;
  }
  return { slots, monitors: mons.length, placement, insufficient, insufficientReason: insufficient ? 'LAYOUT_SPACE_INSUFFICIENT' : null };
}

// Chrome CLI window flags for a rect (credential-free; geometry only).
function chromeWindowArgs(rect) {
  if (!rect) return [];
  return [`--window-position=${Math.round(rect.x)},${Math.round(rect.y)}`, `--window-size=${Math.round(rect.width)},${Math.round(rect.height)}`];
}

module.exports = { SLOTS, computeGridLayout, rectForSlot, chromeWindowArgs, toolWindowBounds, desktopWindowRectForSlot, arrangeBrowserWindows, WINDOW_CHROME };
