'use strict';

// ---------------------------------------------------------------------------
// WINDOW LAYOUT — which quarter of the screen each window takes: the three playing browsers (A/B/C = P1/P2/P3) and
// the TOOL (reserves P4/P5 sit behind the tool). A layout is a PERMUTATION of the four items over the four quarters,
// chosen by the user and saved; the default (user 2026-10-05) is
//      P2 | P3
//      P1 | Tool
// Pure: the quarter rects come from grid-layout's arrangement of the tool's monitor.
// ---------------------------------------------------------------------------

const QUADRANTS = Object.freeze(['TL', 'TR', 'BL', 'BR']);
const ITEMS = Object.freeze(['A', 'B', 'C', 'TOOL']);
const DEFAULT_LAYOUT = Object.freeze({ A: 'BL', B: 'TL', C: 'TR', TOOL: 'BR' });

// A valid layout puts each item in a different quarter; anything else falls back to the default.
function normalizeLayout(layout) {
  const l = layout && typeof layout === 'object' ? layout : {};
  const used = new Set();
  for (const it of ITEMS) {
    if (!QUADRANTS.includes(l[it]) || used.has(l[it])) return { ...DEFAULT_LAYOUT };
    used.add(l[it]);
  }
  return { A: l.A, B: l.B, C: l.C, TOOL: l.TOOL };
}

// Put `item` into `quadrant`; whatever was there takes the item's old quarter (so it stays a permutation).
function placeItem(layout, item, quadrant) {
  const l = normalizeLayout(layout);
  if (!ITEMS.includes(item) || !QUADRANTS.includes(quadrant)) return l;
  const other = ITEMS.find((it) => l[it] === quadrant);
  if (other && other !== item) l[other] = l[item];
  l[item] = quadrant;
  return l;
}

// The four quarter rects of an arrangeClusterWindows() result: slots[1..3] = TL, TR, BL and tool = BR.
function quadrantRects(arr) {
  if (!arr || !arr.slots) return null;
  return { TL: arr.slots[1], TR: arr.slots[2], BL: arr.slots[3], BR: arr.tool };
}

// The rect of one item ('A'|'B'|'C'|'TOOL') under a layout; a RESERVE ('D'|'E') sits where the tool is.
function rectForItem(item, arr, layout) {
  const q = quadrantRects(arr);
  if (!q) return null;
  const l = normalizeLayout(layout);
  const key = item === 'D' || item === 'E' ? 'TOOL' : item;
  const r = q[l[key]];
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

module.exports = { QUADRANTS, ITEMS, DEFAULT_LAYOUT, normalizeLayout, placeItem, quadrantRects, rectForItem };
