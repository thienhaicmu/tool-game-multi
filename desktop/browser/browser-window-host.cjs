'use strict';

// ---------------------------------------------------------------------------
// BrowserWindowHost — CONTROL-V3.
//
// Hosts each BrowserRun's web/game in its OWN top-level browser window, instead of
// embedding every run's WebContentsView inside the single Control window. One window
// per runId; the run's existing WebContentsView (same webContents / debugger / persistent
// partition) is re-parented into that window — NO duplicate webContents, no new runtime.
//
// The window's own HTML (app://ui/browser-chrome.html) is a minimal browser chrome
// (Back / Forward / Reload / address). The run's WebContentsView is added as a child view
// and sized to FILL the window below the toolbar; a native child view always paints above
// the window HTML, so the toolbar occupies the top strip and the site fills the rest.
//
// Ownership is per-run and independent: creating/focusing/closing B-0010's window never
// touches B-0011's window or runtime. Closing the window (user X) is surfaced via onClose so
// the caller can run the existing safe Stop + teardown of ONLY that run.
//
// Electron is dependency-injected (electron/screen) so the whole module is unit testable
// with lightweight fakes — the same way BrowserRunManager is Electron-free.
// ---------------------------------------------------------------------------

const TOOLBAR_HEIGHT = 44;  // DIP; the chrome toolbar strip height

// Compact landscape default. Height includes the 44px toolbar; the WEB AREA below it is a clean
// 16:9 (≈854×480). setAspectRatio(16:9, extraSize=toolbar) keeps the site 16:9 on user resize.
const DEFAULTS = Object.freeze({ width: 854, height: 524, minWidth: 640, minHeight: 404 });

class BrowserWindowHost {
  constructor(deps = {}) {
    // { BrowserWindow, WebContentsView } — injected so tests can supply fakes.
    this._electron = deps.electron || require('electron');
    this._screen = deps.screen || (this._electron && this._electron.screen) || null;
    this._boundsStore = deps.boundsStore || null;             // BrowserWindowBoundsStore (per-browserId geometry)
    this._normalizeWindowBounds = deps.normalizeWindowBounds || ((o) => ({ ...(o && o.defaults || {}), ...(o && o.saved || {}) }));
    this._defaults = { ...DEFAULTS, ...(deps.defaults || {}) };
    this._preloadPath = deps.preloadPath || null;             // chrome toolbar preload
    this._chromeUrl = deps.chromeUrl || 'app://ui/browser-chrome.html';
    this._onClose = typeof deps.onClose === 'function' ? deps.onClose : () => {};   // (runId) => void  — user closed the window
    this._toolbarHeight = deps.toolbarHeight != null ? deps.toolbarHeight : TOOLBAR_HEIGHT;
    this._saveDelayMs = deps.saveDelayMs != null ? deps.saveDelayMs : 400;

    this._byRun = new Map();   // runId -> { win, view, browserId, saveTimer }
  }

  has(runId) { return this._byRun.has(runId); }
  window(runId) { const r = this._byRun.get(runId); return r ? r.win : null; }

  // Resolve the window rectangle: saved per-profile geometry clamped to the current display's
  // work area, else the compact landscape default. Mirrors main's fitToCurrentDisplay.
  _resolveBounds(browserId) {
    const saved = (this._boundsStore && browserId != null) ? this._boundsStore.get(browserId) : null;
    let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    try {
      const hasPos = saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y));
      const display = (this._screen && hasPos)
        ? this._screen.getDisplayMatching({ x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.width), height: Math.round(saved.height) })
        : (this._screen ? this._screen.getPrimaryDisplay() : null);
      if (display && display.workArea) workArea = display.workArea;
    } catch { /* fall back to default work area */ }
    return this._normalizeWindowBounds({ saved, workArea, defaults: this._defaults });
  }

  // Position the run's child view to fill the window below the toolbar.
  _reflow(rec) {
    if (!rec || !rec.win || rec.win.isDestroyed() || !rec.view) return;
    let cw = this._defaults.width, ch = this._defaults.height;
    try { const b = rec.win.getContentBounds(); cw = b.width; ch = b.height; } catch { /* use defaults */ }
    const top = this._toolbarHeight;
    try { rec.view.setBounds({ x: 0, y: top, width: Math.max(0, cw), height: Math.max(0, ch - top) }); } catch { /* view gone */ }
  }

  _scheduleSave(rec) {
    if (!rec || !this._boundsStore || rec.browserId == null) return;
    if (rec.saveTimer) { try { clearTimeout(rec.saveTimer); } catch {} }
    rec.saveTimer = setTimeout(() => {
      rec.saveTimer = null;
      if (!rec.win || rec.win.isDestroyed()) return;
      try { if (rec.win.isMinimized && rec.win.isMinimized()) return; } catch {}
      try { this._boundsStore.set(rec.browserId, rec.win.getBounds()); } catch { /* best effort */ }
    }, this._saveDelayMs);
    try { if (rec.saveTimer.unref) rec.saveTimer.unref(); } catch {}
  }

  // Create (or return the existing) window for a run and re-parent its view into it.
  // `view` is the run's existing WebContentsView (created by InAppRuntime).
  ensureWindow(run, view, { title, url } = {}) {
    const runId = run && run.id;
    if (!runId) return null;
    const existing = this._byRun.get(runId);
    if (existing) { this.focusWindow(runId); return existing.win; }

    const { BrowserWindow } = this._electron;
    const bounds = this._resolveBounds(run.browserId);
    const win = new BrowserWindow({
      ...bounds,
      title: title || windowTitle(run),
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      webPreferences: {
        preload: this._preloadPath || undefined,
        contextIsolation: true,
        sandbox: true,
      },
    });
    try { win.setMenuBarVisibility(false); } catch {}
    // Keep the WEB AREA (below the toolbar) at a 16:9 ratio while the user resizes — smaller or
    // larger, always correctly proportioned (never stretched). extraSize excludes the toolbar.
    try { win.setAspectRatio(16 / 9, { width: 0, height: this._toolbarHeight }); } catch {}

    const rec = { win, view, browserId: run.browserId != null ? run.browserId : null, saveTimer: null };
    this._byRun.set(runId, rec);

    // Load the toolbar chrome (the window's own HTML). runId is passed so the toolbar binds
    // its Back/Forward/Reload/address actions to THIS run only.
    try { win.loadURL(this._chromeUrl + '?runId=' + encodeURIComponent(runId)); } catch {}

    // Re-parent the run's existing view into THIS window and fill below the toolbar.
    try { win.contentView.addChildView(view); } catch {}
    try { if (view.setVisible) view.setVisible(true); } catch {}
    this._reflow(rec);

    // Keep the view filling the window on resize/move; persist geometry per profile.
    try { win.on('resize', () => { this._reflow(rec); this._scheduleSave(rec); }); } catch {}
    try { win.on('move', () => this._scheduleSave(rec)); } catch {}

    // Relay the site's navigation state to the toolbar so the address bar + Back/Forward
    // reflect reality. Never exposes page content — URL + can-go flags only.
    try {
      const wc = view.webContents;
      const pushUrl = () => {
        if (!win || win.isDestroyed()) return;
        let u = ''; try { u = wc.getURL(); } catch {}
        let back = false, fwd = false;
        try { back = wc.canGoBack(); fwd = wc.canGoForward(); } catch {}
        try { win.webContents.send('browser-url', { runId, url: u, canGoBack: back, canGoForward: fwd }); } catch {}
      };
      wc.on('did-navigate', pushUrl);
      wc.on('did-navigate-in-page', pushUrl);
      win.webContents.on('did-finish-load', pushUrl);  // toolbar reloaded → re-sync
    } catch { /* wc gone */ }

    // User closed the window (X). Surface it so the caller runs the safe Stop + teardown of
    // ONLY this run. We do NOT preventDefault — the window closes; teardown then calls
    // destroyWindow (win.destroy, which does not re-emit 'close').
    try {
      win.on('close', () => {
        if (rec.saveTimer) { try { clearTimeout(rec.saveTimer); } catch {} rec.saveTimer = null; }
        try { if (rec.win && !rec.win.isDestroyed() && !(rec.win.isMinimized && rec.win.isMinimized()) && this._boundsStore && rec.browserId != null) this._boundsStore.set(rec.browserId, rec.win.getBounds()); } catch {}
        this._byRun.delete(runId);
        try { this._onClose(runId); } catch { /* caller best-effort */ }
      });
    } catch {}

    return win;
  }

  focusWindow(runId) {
    const rec = this._byRun.get(runId);
    if (!rec || !rec.win || rec.win.isDestroyed()) return false;
    try { if (rec.win.isMinimized()) rec.win.restore(); } catch {}
    try { rec.win.show(); } catch {}
    try { rec.win.focus(); } catch {}
    try { if (rec.view && rec.view.webContents && !rec.view.webContents.isDestroyed()) rec.view.webContents.focus(); } catch {}
    return true;
  }

  setTitle(runId, text) {
    const rec = this._byRun.get(runId);
    if (rec && rec.win && !rec.win.isDestroyed() && text) { try { rec.win.setTitle(String(text)); } catch {} }
  }

  // Programmatic teardown of a run's window (called from the run's disposal). Removes the
  // child view first (its webContents is owned/closed by InAppRuntime), then destroys the
  // window. win.destroy() does NOT emit 'close', so this never re-enters onClose.
  destroyWindow(runId) {
    const rec = this._byRun.get(runId);
    if (!rec) return;
    this._byRun.delete(runId);
    if (rec.saveTimer) { try { clearTimeout(rec.saveTimer); } catch {} rec.saveTimer = null; }
    try { if (rec.win && !rec.win.isDestroyed() && rec.view) rec.win.contentView.removeChildView(rec.view); } catch {}
    try { if (rec.win && !rec.win.isDestroyed()) rec.win.destroy(); } catch {}
  }

  destroyAll() { for (const id of [...this._byRun.keys()]) this.destroyWindow(id); }
}

function windowTitle(run) {
  const b = run && run.browserId ? String(run.browserId) : (run && run.id) || 'Browser';
  return b;
}

module.exports = { BrowserWindowHost, TOOLBAR_HEIGHT, DEFAULTS, windowTitle };
