'use strict';

// ---------------------------------------------------------------------------
// KHÓA KHUNG — each browser stays in its standard frame (user 2026-10-06: "giữ đúng size chuẩn"). Chromium has no
// switch to forbid maximize / resize, so the tool looks at every open browser's window every ~1.5 s and puts it back
// when it was maximized, made full screen, resized or moved. A minimized window is left alone (the user hid it).
//
// Chromium may not take the exact rect (minimum width, DPI rounding): after a put-back the bounds it really took
// become the reference for that rect, so the tool never fights it in a loop.
// ---------------------------------------------------------------------------

const TOLERANCE_PX = 6;
const CHECK_MS = 1500;

const sameRect = (a, b, tol = TOLERANCE_PX) => !!(a && b)
  && Math.abs(Number(a.left) - Number(b.left)) <= tol && Math.abs(Number(a.top) - Number(b.top)) <= tol
  && Math.abs(Number(a.width) - Number(b.width)) <= tol && Math.abs(Number(a.height) - Number(b.height)) <= tol;

const toBounds = (rect) => (rect ? { left: Math.round(rect.x), top: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null);

// bounds = what CDP Browser.getWindowForTarget returned ({ left, top, width, height, windowState });
// rect = the standard frame { x, y, width, height }; accepted = the bounds Chromium really took for this rect last time.
// → null (fine) or the reason to put it back.
function reframeReason(bounds, rect, accepted = null) {
  if (!bounds || !rect) return null;
  const state = bounds.windowState || 'normal';
  if (state === 'minimized') return null;
  if (state === 'maximized') return 'MAXIMIZED';
  if (state === 'fullscreen') return 'FULLSCREEN';
  const want = toBounds(rect);
  if (sameRect(bounds, want) || (accepted && sameRect(accepted.rect, want, 0) && sameRect(bounds, accepted.bounds))) return null;
  const sizeOk = Math.abs(bounds.width - want.width) <= TOLERANCE_PX && Math.abs(bounds.height - want.height) <= TOLERANCE_PX;
  return sizeOk ? 'MOVED' : 'RESIZED';
}

module.exports = { reframeReason, toBounds, sameRect, TOLERANCE_PX, CHECK_MS };
