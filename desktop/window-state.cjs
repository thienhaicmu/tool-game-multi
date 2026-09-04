'use strict';

// WU11.1 — compact window defaults + saved-bounds restore. Presentation only.
// This is a focused control tool, not an IDE, so a fresh launch opens small.
// WU-E.1 — the Overview now hosts the live browser workspace (embedded web mirror), so the
// product opens at a workspace size, not the old compact-control size. min stays small
// enough to allow the 1100x700 acceptance viewport.
const DEFAULTS = Object.freeze({ width: 1300, height: 860, minWidth: 1000, minHeight: 680 });
const MAX_DIM = 10000;

// resolveBounds(saved) — return the BrowserWindow bounds to open with.
//   valid saved bounds  -> restore them (with on-screen-ish x/y when present)
//   missing / malformed -> default 960x680 (no position)
function resolveBounds(saved) {
  const w = saved ? Number(saved.width) : NaN;
  const h = saved ? Number(saved.height) : NaN;
  const okW = Number.isFinite(w) && w >= DEFAULTS.minWidth && w <= MAX_DIM;
  const okH = Number.isFinite(h) && h >= DEFAULTS.minHeight && h <= MAX_DIM;
  if (!okW || !okH) return { width: DEFAULTS.width, height: DEFAULTS.height };
  const out = { width: Math.round(w), height: Math.round(h) };
  const x = Number(saved.x), y = Number(saved.y);
  if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 20000 && Math.abs(y) < 20000) { out.x = Math.round(x); out.y = Math.round(y); }
  return out;
}

module.exports = { resolveBounds, DEFAULTS };
