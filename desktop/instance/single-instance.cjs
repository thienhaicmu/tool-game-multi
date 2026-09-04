'use strict';

// ---------------------------------------------------------------------------
// WU-C.4 — Customer application single-instance ownership.
//
// The FIRST customer app instance owns the product runtime. A second launch must
// NOT initialize another BrowserRegistry / BrowserRunManager / Chrome launcher /
// BrowserRun / AutoRunner / Jackpot* — it focuses the existing window and exits.
// This closes the capacity-bypass hole where two app instances each see their own
// maxConcurrentBrowsers counter (§28).
//
// This SUPERSEDES the earlier multi-application-instance policy. InstanceManager is
// intentionally preserved for data-dir layout / path ownership; only the top-level
// application multiplicity changes. The seller Generator is a SEPARATE Electron app
// with its own identity and does NOT share this lock.
//
// Extracted as a tiny seam so the decision is unit-testable with a fake `app`.
// ---------------------------------------------------------------------------

function acquireSingleInstance(app, { onSecondInstance } = {}) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) return { primary: false };
  app.on('second-instance', () => { try { if (onSecondInstance) onSecondInstance(); } catch { /* best effort */ } });
  return { primary: true };
}

// Bring the existing main window to the foreground (used from 'second-instance').
function focusExistingWindow(win) {
  if (!win || win.isDestroyed && win.isDestroyed()) return false;
  try {
    if (win.isMinimized && win.isMinimized()) win.restore();
    if (win.isVisible && !win.isVisible()) win.show();
    win.focus();
    return true;
  } catch { return false; }
}

module.exports = { acquireSingleInstance, focusExistingWindow };
