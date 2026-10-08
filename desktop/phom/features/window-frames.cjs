'use strict';

// ---------------------------------------------------------------------------
// FEATURE window-frames — where each window sits, and that it stays there.
//  rectFor(slot): the quarter of the 2×2 grid a slot takes, following the user's LAYOUT (window-layout.cjs; default
//          P2|P3 over P1|Tool) on the monitor the tool is on. A/B/C = the three playing places; a RESERVE (D/E, not
//          playing) sits exactly where the tool is, behind it.
//  move(runId, rect): a RUNNING browser's window, through its own page client (CDP Browser.setWindowBounds).
//  arrange(): XẾP CỬA SỔ — the tool to its quarter, every OPEN browser back into its place, the tool in front of the
//          reserves. Only our own runs are moved; no other window is touched.
//  lock (KHÓA KHUNG, user 2026-10-06): every CHECK_MS each open browser that was maximized / made full screen / resized
//          / moved is put back (window-lock.cjs). The bounds Chromium really took for a rect become the reference, so
//          it never fights Chromium in a loop. PHOM_FEATURES_OFF=window-frames stops the lock (arrange still works).
//  IPC: phom:layout-get, phom:layout-set (save + arrange at once), phom:restore-layout.
//
// state: session.window = { accepted: { rect, bounds } | null }
// deps:  { sessions, layout: { get(), set(l), defaults }, rectForItem(item, layout), fallbackRect(item), toolFallback(),
//          openRuns() → [[runId, slot]], clientFor(rid), tool() → BrowserWindow|null, lockOn(), log, checkMs }
// ---------------------------------------------------------------------------

const windowLock = require('../../protocol/phom/window-lock.cjs');

const ITEMS = Object.freeze({ A: 'A', B: 'B', C: 'C', D: 'D', E: 'E' });

function createWindowFramesFeature(deps) {
  const { sessions, layout, log = () => {}, lockOn = () => true, checkMs = windowLock.CHECK_MS } = deps;
  let busy = false;
  let timer = null;

  function rectFor(slot) {
    const item = ITEMS[slot] || 'TOOL';
    let r = null;
    try { r = deps.rectForItem(item, layout.get()); } catch { r = null; }
    return r || deps.fallbackRect(item === 'B' || item === 'C' ? item : 'A');
  }

  async function move(runId, rect) {
    const client = deps.clientFor(runId);
    if (!client || !client.Browser || !rect) return false;
    try {
      const { windowId } = await client.Browser.getWindowForTarget({});
      await client.Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      await client.Browser.setWindowBounds({ windowId, bounds: { left: Math.round(rect.x), top: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
      return true;
    } catch { return false; }
  }

  async function enforce() {
    if (busy || !lockOn()) return;
    busy = true;
    try {
      for (const [runId, slot] of deps.openRuns()) {
        const client = deps.clientFor(runId);
        if (!client || !client.Browser) continue;
        const rect = rectFor(slot);
        if (!rect) continue;
        const s = sessions.get(runId);
        try {
          const { windowId, bounds } = await client.Browser.getWindowForTarget({});
          const why = windowLock.reframeReason(bounds, rect, s.window.accepted);
          if (!why) continue;
          await move(runId, rect);
          const after = await client.Browser.getWindowBounds({ windowId }).catch(() => null);
          if (after && after.bounds) s.window.accepted = { rect: windowLock.toBounds(rect), bounds: after.bounds };
          log('window-reframed', { runId, slotId: slot, reason: why });
        } catch { /* the browser may be closing */ }
      }
    } finally { busy = false; }
  }

  function arrange() {
    try {
      const shell = deps.tool();
      let control = null;
      try { control = deps.rectForItem('TOOL', layout.get()); } catch { control = null; }
      if (!control) control = deps.toolFallback();
      if (shell && !shell.isDestroyed() && control) shell.setBounds({ x: Math.round(control.x), y: Math.round(control.y), width: Math.round(control.width), height: Math.round(control.height) });
      try { for (const [runId, slot] of deps.openRuns()) move(runId, rectFor(slot)).catch(() => {}); } catch { /* best effort */ }
      // reserve browsers (4th/5th profile) open at the tool's place — keep the tool in front of them
      if (shell && !shell.isDestroyed()) shell.moveTop();
    } catch { /* best effort */ }
    return { ok: true };
  }

  return {
    id: 'window-frames',
    rectFor,
    move,
    enforce,
    arrange,
    start() {
      if (timer) return;
      timer = setInterval(() => { enforce().catch(() => {}); }, checkMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    registerIpc(handle) {
      handle('phom:layout-get', () => ({ ok: true, layout: layout.get(), defaultLayout: { ...layout.defaults } }));
      handle('phom:layout-set', (_e, cfg) => { const l = layout.set(cfg && cfg.layout); arrange(); return { ok: true, layout: l }; }, { guarded: true });
      handle('phom:restore-layout', () => arrange(), { guarded: true });
    },
  };
}

module.exports = { createWindowFramesFeature };
