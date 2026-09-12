'use strict';

// ---------------------------------------------------------------------------
// ChromeRuntime — real-Chrome transport for BrowserRuns.
//
// Replaces the Electron WebContentsView (InAppRuntime) transport with one real
// chrome.exe process per BrowserRun. It exposes the SAME facade the manager +
// main.cjs consume — launcher(run), targetManager(run, endpoint), webContents(runId),
// focus(runId), destroy(runId), destroyAll() — so NOTHING above the transport
// boundary changes:
//
//   BrowserRun -> ChromeRuntime -> chrome.exe (own profile + own CDP port)
//              -> TargetManager (chrome-remote-interface) -> per-target CRI client
//
// The per-target CRI client is byte-for-byte the interface protocol/AutoRunner/
// recovery already use (client.Domain.method(args, sessionId)), so the Cocos entry,
// WS capture, ProtocolContext, AutoRunner and recovery keep their exact semantics.
//
// webContents(runId) returns a CDP-backed adapter shaped like the Electron
// WebContents that recovery/health/navigation already consume: it maps CDP Page.*
// events to the SAME did-navigate / did-navigate-in-page / did-finish-load /
// render-process-gone signals, and getURL()/reload()/loadURL()/isDestroyed() to CDP.
// This keeps the recovery/health code in main.cjs UNCHANGED.
// ---------------------------------------------------------------------------

const EventEmitter = require('node:events');
const { ChromeLauncher, DEFAULT_WINDOW } = require('./chrome-launcher.cjs');
const { TargetManager } = require('../cdp/target-manager.cjs');

// A WebContents-shaped adapter over the owning run's active CDP page client. Only
// the surface recovery/health/navigation actually use is implemented; everything is
// best-effort and never throws (matching how the call sites are wrapped in try/catch).
class WcAdapter {
  constructor(rec) {
    this._rec = rec;
    this._em = new EventEmitter();
    this._em.setMaxListeners(0);
  }
  on(ev, fn) { this._em.on(ev, fn); return this; }
  once(ev, fn) { this._em.once(ev, fn); return this; }
  off(ev, fn) { this._em.off(ev, fn); return this; }
  removeListener(ev, fn) { this._em.removeListener(ev, fn); return this; }
  _emit(ev, ...args) { try { this._em.emit(ev, ...args); } catch { /* handler best-effort */ } }

  isDestroyed() { return !!this._rec.destroyed || !this._rec.activeClient; }
  getURL() { return this._rec.lastUrl || ''; }
  reload() { const c = this._rec.activeClient; if (c && c.Page) { try { c.Page.reload({}); } catch { /* best effort */ } } }
  loadURL(url) { const c = this._rec.activeClient; if (c && c.Page) { try { c.Page.navigate({ url: String(url) }); } catch { /* best effort */ } } }
  focus() { const c = this._rec.activeClient; if (c && c.Page && c.Page.bringToFront) { try { c.Page.bringToFront(); return true; } catch { /* best effort */ } } return false; }
  close() { try { if (this._rec.runtime) this._rec.runtime.destroy(this._rec.runId); } catch { /* best effort */ } }

  // Chrome provides its own real back/forward/reload UI — the app never draws a fake
  // toolbar. These inert stubs keep the (now unused) legacy nav IPC harmless.
  canGoBack() { return false; }
  goBack() { /* Chrome owns navigation history UI */ }
  canGoForward() { return false; }
  goForward() { /* Chrome owns navigation history UI */ }
}

class ChromeRuntime {
  // deps:
  //   env                 - process.env (Chrome discovery)
  //   windowSize          - { width, height } default opening size (720x405)
  //   chromeProfileFallback - profile root for runs with no persistent browserId
  //   onRunExit(runId)    - called when a run's Chrome exits WITHOUT the app asking
  //                         (user closed the window / crash) so main.cjs can safe-stop
  //   cdp / spawn         - injectable for tests
  constructor({ env = process.env, windowSize = DEFAULT_WINDOW, chromeProfileFallback = null, onRunExit = () => {}, cdp = null, spawn = null } = {}) {
    this._env = env;
    this._windowSize = windowSize || DEFAULT_WINDOW;
    this._profileFallback = chromeProfileFallback;
    this._onRunExit = typeof onRunExit === 'function' ? onRunExit : () => {};
    this._cdp = cdp;         // undefined -> TargetManager/ChromeLauncher use the real CDP
    this._spawn = spawn;     // undefined -> ChromeLauncher uses child_process.spawn
    this._byRun = new Map(); // runId -> rec
  }

  setOnRunExit(fn) { if (typeof fn === 'function') this._onRunExit = fn; }

  _profileFor(run) {
    if (run && run.profileDir) return String(run.profileDir);
    // Advanced/debug runs with no persistent browser: still isolate per run so no two
    // debug launches share a user-data-dir.
    const path = require('node:path');
    return this._profileFallback ? path.join(String(this._profileFallback), String(run.id)) : null;
  }

  _rec(run) {
    let rec = this._byRun.get(run.id);
    if (!rec) {
      rec = { runId: run.id, runtime: this, launcher: null, tm: null, wc: null, activeId: null, activeClient: null, lastUrl: '', destroyed: false, _closing: false, _unbindPage: null };
      rec.wc = new WcAdapter(rec);
      this._byRun.set(run.id, rec);
    }
    return rec;
  }

  has(runId) { return this._byRun.has(runId); }
  webContents(runId) { const r = this._byRun.get(runId); return r ? r.wc : null; }
  // No Electron partition in the real-Chrome model — the profile IS a directory on
  // disk (run.profileDir), deleted by the registry profile-dir cleanup. Kept for
  // facade parity; callers guard on a null return.
  partitionFor(/* browserId */) { return null; }

  // ---- launcher facade (createLauncher) ----
  launcher(run) {
    const rec = this._rec(run);
    const profile = this._profileFor(run);
    const real = new ChromeLauncher({
      profilePath: profile,
      env: this._env,
      windowSize: this._windowSize,
      spawn: this._spawn || undefined,
      cdp: this._cdp || undefined,
      // Per-run credential-free proxy resolved by the owner before launch (run.proxy).
      // null for Control/Aviator runs — unchanged direct behaviour.
      proxy: run && run.proxy ? run.proxy : null,
      onExit: () => {
        // Chrome process gone. Mark the page dead so recovery/health see it. If WE did
        // not initiate the close, tell main.cjs so it can run the safe-stop teardown for
        // THIS run only (user closed the Chrome window / crash).
        this._markPageGone(rec, /* crashed */ !rec._closing);
        if (!rec._closing) { try { this._onRunExit(run.id); } catch { /* best effort */ } }
      },
    });
    rec.launcher = real;
    // Wrap so app-initiated close is distinguishable from a user close (suppresses the
    // onRunExit re-entrancy). BrowserRunManager calls close()/closeGraceful() on this.
    return {
      open: (url) => real.open(url),
      close: () => { rec._closing = true; return real.close(); },
      closeGraceful: (t) => { rec._closing = true; return real.closeGraceful(t); },
      snapshot: () => real.snapshot(),
    };
  }

  // ---- TargetManager facade (createTargetManager) ----
  targetManager(run, endpoint = {}) {
    const rec = this._rec(run);
    const tm = new TargetManager({
      host: endpoint.host || '127.0.0.1',
      port: endpoint.port || 9222,
      runtimeHint: endpoint.runtimeHint || null,
      cdp: this._cdp || undefined,
    });
    rec.tm = tm;
    tm.on('attached', ({ target, client }) => this._onAttached(rec, target, client));
    tm.on('target-updated', (target) => this._onUpdated(rec, target));
    tm.on('target-removed', (id) => this._onRemoved(rec, id));
    return tm;
  }

  _onAttached(rec, target, client) {
    // Adopt the first attached page as the run's active page (the game tab). Real Chrome
    // launched with `--new-window <url>` exposes exactly one page target.
    if (rec.activeClient) return;
    rec.activeId = target.cdpTargetId;
    rec.activeClient = client;
    rec.destroyed = false;
    rec.lastUrl = target.url || rec.lastUrl || '';
    this._bindPage(rec, client);
  }

  _onUpdated(rec, target) {
    if (!target || target.cdpTargetId !== rec.activeId) return;
    if (target.url && target.url !== rec.lastUrl) {
      rec.lastUrl = target.url;
      rec.wc._emit('did-navigate', {}, rec.lastUrl);
    }
  }

  _onRemoved(rec, id) {
    if (id !== rec.activeId) return;
    this._markPageGone(rec, /* crashed */ false);
  }

  // Wire CDP Page.* events on the active page client to the Electron-WebContents-shaped
  // signals recovery/health already listen for. Uses the CRI client EventEmitter surface
  // (client.on('Domain.event', cb)) so it is transport-identical to chrome-remote-interface.
  _bindPage(rec, client) {
    if (rec._unbindPage) { try { rec._unbindPage(); } catch { /* ignore */ } rec._unbindPage = null; }
    try { if (client.Page && client.Page.enable) client.Page.enable().catch(() => {}); } catch { /* ignore */ }
    try { if (client.Inspector && client.Inspector.enable) client.Inspector.enable().catch(() => {}); } catch { /* ignore */ }
    const onFrameNavigated = (p) => {
      if (p && p.frame && !p.frame.parentId) { rec.lastUrl = p.frame.url || rec.lastUrl; rec.wc._emit('did-navigate', {}, rec.lastUrl); }
    };
    const onWithinDoc = (p) => {
      if (p) { rec.lastUrl = p.url || rec.lastUrl; rec.wc._emit('did-navigate-in-page', {}, rec.lastUrl); }
    };
    const onLoad = () => rec.wc._emit('did-finish-load', {});
    const onCrashed = () => this._markPageGone(rec, /* crashed */ true);
    const sub = (evt, cb) => { try { client.on(evt, cb); } catch { /* ignore */ } };
    const unsub = (evt, cb) => { try { client.off ? client.off(evt, cb) : client.removeListener(evt, cb); } catch { /* ignore */ } };
    sub('Page.frameNavigated', onFrameNavigated);
    sub('Page.navigatedWithinDocument', onWithinDoc);
    sub('Page.loadEventFired', onLoad);
    sub('Inspector.targetCrashed', onCrashed);
    rec._unbindPage = () => {
      unsub('Page.frameNavigated', onFrameNavigated);
      unsub('Page.navigatedWithinDocument', onWithinDoc);
      unsub('Page.loadEventFired', onLoad);
      unsub('Inspector.targetCrashed', onCrashed);
    };
  }

  _markPageGone(rec, crashed) {
    if (rec._unbindPage) { try { rec._unbindPage(); } catch { /* ignore */ } rec._unbindPage = null; }
    rec.activeId = null;
    rec.activeClient = null;
    rec.destroyed = true;
    if (crashed) rec.wc._emit('render-process-gone', {}, { reason: 'crashed' });
  }

  // Explicitly (re)focus a run — brings its Chrome page to the front (CDP Page.bringToFront).
  focus(runId) {
    const rec = this._byRun.get(runId);
    if (rec && rec.wc) return rec.wc.focus();
    return false;
  }

  destroy(runId) {
    const rec = this._byRun.get(runId);
    if (!rec) return;
    rec._closing = true;
    this._byRun.delete(runId);
    if (rec._unbindPage) { try { rec._unbindPage(); } catch { /* ignore */ } }
    try { if (rec.tm && rec.tm.stop) rec.tm.stop(); } catch { /* ignore */ }
    try { if (rec.launcher && rec.launcher.close) rec.launcher.close(); } catch { /* ignore */ }
  }
  destroyAll() { for (const id of [...this._byRun.keys()]) this.destroy(id); }
}

module.exports = { ChromeRuntime, WcAdapter };
