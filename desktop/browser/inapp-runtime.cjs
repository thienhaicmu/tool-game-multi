'use strict';

// ---------------------------------------------------------------------------
// WU-E.4 — TRUE in-app browser runtime. Renders each BrowserRun's web/game inside
// the product window via an Electron WebContentsView on a per-B-* persistent partition,
// instrumented by webContents.debugger (the SAME Chrome DevTools Protocol). It exposes
// launcher + TargetManager facades that are drop-in compatible with the existing
// BrowserRunManager wiring, so capture / wsReplay (worker-safe send) / RoundObserver /
// ProtocolContext / AutoRunner keep working with NO change to those modules.
//
// No external chrome.exe, no remote debugging port, no screencast: display is the native
// view; user input is native. One WebContentsView per run; only the selected one is
// visible; background views keep running (setBackgroundThrottling(false)).
// ---------------------------------------------------------------------------

const EventEmitter = require('node:events');

// A CRI-compatible client over one webContents.debugger (flat session). Command methods
// return promises; event methods (called with a function) subscribe. Child (iframe/worker)
// sessions are addressed by the trailing sessionId arg, exactly like the flattened CRI API.
function makeDebuggerClient(wc) {
  const dbg = wc.debugger;
  try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch { /* already attached (e.g. devtools) */ }
  const handlers = new Map();          // 'Domain.event' -> Set(cb)
  const emitter = new EventEmitter();
  const onMessage = (_e, method, params, sessionId) => {
    const set = handlers.get(method);
    if (set) for (const cb of [...set]) { try { cb(params, sessionId); } catch { /* handler best-effort */ } }
  };
  dbg.on('message', onMessage);
  const fireDisconnect = () => emitter.emit('disconnect');
  dbg.on('detach', fireDisconnect);
  try { wc.once('destroyed', fireDisconnect); } catch {}

  const domain = (name) => new Proxy({}, {
    get(_t, member) {
      return (arg, sessionId) => {
        if (typeof arg === 'function') {          // CRI convention: subscribe to Domain.member
          const key = name + '.' + member;
          if (!handlers.has(key)) handlers.set(key, new Set());
          handlers.get(key).add(arg);
          return () => { const s = handlers.get(key); if (s) s.delete(arg); };
        }
        try { return dbg.sendCommand(name + '.' + member, arg || {}, sessionId); }   // command
        catch (e) { return Promise.reject(e); }
      };
    },
  });
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'close') return async () => { try { dbg.off('message', onMessage); } catch {} try { if (dbg.isAttached()) dbg.detach(); } catch {} };
      if (prop === 'on') return (ev, cb) => emitter.on(ev, cb);
      if (prop === 'off' || prop === 'removeListener') return (ev, cb) => emitter.removeListener(ev, cb);
      if (prop === 'sessionId') return undefined;
      if (prop === '__wc') return wc;
      return domain(String(prop));
    },
  });
}

class InAppRuntime {
  constructor({ getHostWindow, partitionPrefix = 'persist:aviator-' } = {}) {
    this._host = getHostWindow || (() => null);       // () => product BrowserWindow
    this._prefix = partitionPrefix;
    this._byRun = new Map();                           // runId -> { view, wc, browserId, client }
  }
  partitionFor(browserId) { return this._prefix + String(browserId); }
  has(runId) { return this._byRun.has(runId); }
  webContents(runId) { const r = this._byRun.get(runId); return r ? r.wc : null; }
  view(runId) { const r = this._byRun.get(runId); return r ? r.view : null; }

  // ---- launcher facade (used where ChromeLauncher was) ----
  launcher(run) {
    const self = this;
    return {
      async open(url) {
        const { WebContentsView, session } = require('electron');
        const host = self._host();
        if (!host || host.isDestroyed()) return { ok: false, error: { code: 'NO_HOST_WINDOW', message: 'Product window not ready' } };
        const partition = self.partitionFor(run.browserId || run.id);
        const sess = session.fromPartition(partition);
        const view = new WebContentsView({ webPreferences: { session: sess, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
        const wc = view.webContents;
        try { wc.setBackgroundThrottling(false); } catch {}
        try { host.contentView.addChildView(view); } catch {}
        try { view.setVisible(false); view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch {}
        self._byRun.set(run.id, { view, wc, browserId: run.browserId, client: null });
        try { wc.loadURL(String(url || 'about:blank')); } catch {}
        return { ok: true, reused: false, endpoint: { inapp: true, host: 'inapp', port: 0 }, pid: null, profile: partition };
      },
      close() { self.destroy(run.id); },
      async closeGraceful() { self.destroy(run.id); return { ok: true, graceful: true, forced: false }; },
      snapshot() { return { cdpPort: null, chromePid: null, chromeProfile: self.partitionFor(run.browserId || run.id) }; },
    };
  }

  // ---- TargetManager facade (used where cdp/TargetManager was) ----
  targetManager(run) {
    const self = this;
    const em = new EventEmitter();
    const tid = 'INAPP-' + run.id;
    let started = false, client = null, target = null;
    return {
      on: (...a) => { em.on(...a); }, once: (...a) => { em.once(...a); },
      endpoint: { inapp: true, host: 'inapp', port: 0 },
      async start() {
        if (started) return; started = true;
        const rec = self._byRun.get(run.id);
        if (!rec || !rec.wc || rec.wc.isDestroyed()) throw new Error('No in-app webContents for run ' + run.id);
        client = makeDebuggerClient(rec.wc);
        rec.client = client;
        target = { cdpTargetId: tid, type: 'page', url: (() => { try { return rec.wc.getURL(); } catch { return ''; } })(), title: '', attached: true, sessionId: tid };
        // Re-emit 'attached' as the page navigates so capture/hook re-bind on each real load.
        const reattach = () => { target.url = (() => { try { return rec.wc.getURL(); } catch { return ''; } })(); em.emit('target-updated', { ...target }); };
        try { rec.wc.on('did-navigate', reattach); rec.wc.on('did-navigate-in-page', reattach); } catch {}
        setImmediate(() => { em.emit('target-added', { ...target }); em.emit('attached', { target: { ...target }, client }); });
      },
      async stop() { started = false; try { if (client) await client.close(); } catch {} em.emit('target-removed', tid); em.emit('detached', tid); },
      listTargets() { return target ? [{ ...target }] : []; },
      getSession(id) { return (target && String(id) === tid) ? { target: { ...target }, client } : undefined; },
    };
  }

  // ---- view management (bounds/visibility) ----
  setBounds(runId, b) { const r = this._byRun.get(runId); if (r && r.view && r.wc && !r.wc.isDestroyed()) { try { r.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) }); } catch {} } }
  showOnly(runId) { for (const [id, r] of this._byRun) { try { if (r.view && r.wc && !r.wc.isDestroyed()) r.view.setVisible(id === runId); } catch {} } }
  hideAll() { for (const [, r] of this._byRun) { try { if (r.view && r.wc && !r.wc.isDestroyed()) r.view.setVisible(false); } catch {} } }

  destroy(runId) {
    const r = this._byRun.get(runId);
    if (!r) return;
    this._byRun.delete(runId);
    try { const host = this._host(); if (host && !host.isDestroyed() && r.view) host.contentView.removeChildView(r.view); } catch {}
    try { if (r.wc && !r.wc.isDestroyed()) r.wc.close(); } catch {}
  }
  destroyAll() { for (const id of [...this._byRun.keys()]) this.destroy(id); }
}

module.exports = { InAppRuntime, makeDebuggerClient };
