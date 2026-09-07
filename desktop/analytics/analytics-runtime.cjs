'use strict';

const EventEmitter = require('node:events');
const { AnalyticsLiveState } = require('./live-state.cjs');

// ---------------------------------------------------------------------------
// AnalyticsRuntime — M2 composition core for Aviator Analytics.
//
// It owns, per Analytics browser profile:
//   - a persistent in-app browser view (InAppRuntime, 'persist:analytics-*')
//   - its own TargetManager (webContents.debugger / CDP)
//   - a PASSIVE capture attachment (Network + WebSocket frame events only)
//   - an AnalyticsLiveState (bounded live snapshot)
//
// It is strictly an OBSERVER. There is deliberately NO send/replay/bet/cashout/
// enter path anywhere in this module or its imports. The shared CaptureCorrelator
// is target-keyed, so B1 frames route to B1's live state and B2 frames to B2's —
// the UI selection never changes capture ownership.
//
// Electron-touching work (WebContentsView, CDP) is reached only via the injected
// `inappRuntime` + `capture`, so this module is unit-testable with fakes.
// ---------------------------------------------------------------------------

class AnalyticsRuntime extends EventEmitter {
  constructor({ registry, inappRuntime, capture, persistence = null, now } = {}) {
    super();
    if (!registry) throw new Error('AnalyticsRuntime requires a browser registry');
    if (!inappRuntime) throw new Error('AnalyticsRuntime requires an in-app runtime');
    if (!capture) throw new Error('AnalyticsRuntime requires a capture correlator');
    this._registry = registry;
    this._inapp = inappRuntime;
    this._capture = capture;
    this._persistence = persistence;   // optional AnalyticsPersistence (raw + round write path)
    this._now = now || (() => Date.now());
    this._runs = new Map();         // browserId -> run record
    this._targetIndex = new Map();  // cdpTargetId -> browserId
    this._selectedBrowserId = null;
    this._attachedClients = new WeakSet();

    // Shared, target-keyed WS frame stream -> owning browser's live state.
    // Never global: a frame with no known owner is ignored (not broadcast).
    this._capture.on('request', (req) => this._onCaptureRequest(req));
    this._capture.on('update', (req) => this._onCaptureUpdate(req));
  }

  // ---- identity / registry passthrough (identity-only; no action config) ----
  listBrowsers() {
    return this._registry.list().map((b) => this._decorate(b));
  }
  createBrowser({ displayName, name, configuredUrl, launchUrl } = {}) {
    return this._registry.create({ name: displayName != null ? displayName : name, launchUrl: configuredUrl != null ? configuredUrl : launchUrl });
  }
  deleteBrowser(browserId) {
    if (this._runs.has(String(browserId))) return { error: { code: 'BROWSER_OPEN', message: 'Close the profile before deleting it.' } };
    return this._registry.remove(browserId);
  }

  _decorate(b) {
    const run = this._runs.get(String(b.id));
    return {
      browserId: b.id,
      displayName: b.name,
      configuredUrl: b.launchUrl,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      partition: this._inapp.partitionFor(b.id),
      open: !!run,
      selected: this._selectedBrowserId === String(b.id),
      live: run ? run.liveState.snapshot({ events: false }) : null,
    };
  }

  // ---- lifecycle ----
  async open(browserId) {
    const id = String(browserId);
    const existing = this._runs.get(id);
    if (existing) { this.select(id); return { ok: true, reused: true, runId: existing.runId }; }
    const rec = this._registry.get(id);
    if (!rec) return { ok: false, error: { code: 'BROWSER_NOT_FOUND', message: 'No such Analytics browser: ' + id } };

    const run = {
      runId: 'AR-' + id,
      id: 'AR-' + id,                 // InAppRuntime keys its view map on run.id
      browserId: id,
      launchUrl: rec.launchUrl,
      launcher: null,
      targetManager: null,
      selectedTargetId: null,
      liveState: new AnalyticsLiveState({ browserId: id, now: this._now }),
    };
    run.liveState.on('update', () => this.emit('browser-updated', id));
    if (this._persistence) { try { this._persistence.beginSession(id); } catch { /* persistence best-effort; capture continues */ } }

    run.launcher = this._inapp.launcher(run);
    const launched = await run.launcher.open(rec.launchUrl);
    if (!launched || launched.ok === false) {
      return { ok: false, error: (launched && launched.error) || { code: 'OPEN_FAILED', message: 'Could not open Analytics browser' } };
    }

    const tm = this._inapp.targetManager(run);
    run.targetManager = tm;
    tm.on('attached', ({ target, client }) => {
      this._targetIndex.set(String(target.cdpTargetId), id);
      if (!run.selectedTargetId) run.selectedTargetId = target.cdpTargetId;
      this._attachPassiveCapture(client, target);
      this.emit('browser-updated', id);
    });
    tm.on('target-removed', (tid) => {
      this._targetIndex.delete(String(tid));
      if (run.selectedTargetId === String(tid)) {
        run.selectedTargetId = null; run.liveState.onDisconnect();
        if (this._persistence) { try { this._persistence.onDisconnect(id); } catch { /* best effort */ } }
      }
      this.emit('browser-updated', id);
    });
    await tm.start();

    this._runs.set(id, run);
    if (!this._selectedBrowserId) this._selectedBrowserId = id;
    try { this._registry.touchOpened(id, run.runId); } catch { /* metadata best-effort */ }
    this.emit('browsers-changed');
    return { ok: true, runId: run.runId, partition: this._inapp.partitionFor(id) };
  }

  async close(browserId) {
    const id = String(browserId);
    const run = this._runs.get(id);
    if (!run) return { ok: true, alreadyClosed: true };
    for (const [tid, bid] of [...this._targetIndex]) if (bid === id) this._targetIndex.delete(tid);
    try { if (run.targetManager && run.targetManager.stop) await run.targetManager.stop(); } catch { /* already gone */ }
    try { if (run.launcher && run.launcher.close) run.launcher.close(); } catch { /* best effort */ }
    run.liveState.onDisconnect();
    if (this._persistence) { try { this._persistence.endSession(id, 'STOPPED'); } catch { /* best effort */ } }
    this._runs.delete(id);
    if (this._selectedBrowserId === id) this._selectedBrowserId = this._runs.size ? [...this._runs.keys()][0] : null;
    this.emit('browsers-changed');
    return { ok: true };
  }

  select(browserId) {
    const id = String(browserId);
    this._selectedBrowserId = id;
    try { if (this._inapp.showOnly && this._runs.has(id)) this._inapp.showOnly('AR-' + id); } catch { /* view mgmt best-effort */ }
    this.emit('browsers-changed');
    return { ok: true, selectedBrowserId: id };
  }
  selectedBrowserId() { return this._selectedBrowserId; }

  // Resolve the owning target's OWN CDP client (used by the shared correlator for
  // lazy HTTP body fetches). Target-scoped by design: there is no "any client".
  clientForTarget(targetId) {
    const bid = this._targetIndex.get(String(targetId));
    const run = bid && this._runs.get(bid);
    if (!run || !run.targetManager || !run.targetManager.getSession) return null;
    const s = run.targetManager.getSession(targetId);
    return s ? s.client : null;
  }

  // View bounds/visibility control (display only — never input automation).
  setViewBounds(browserId, bounds, visible) {
    const id = String(browserId);
    const runId = 'AR-' + id;
    try {
      if (visible === false) { if (this._inapp.setBounds) this._inapp.setBounds(runId, { x: 0, y: 0, width: 0, height: 0 }); return { ok: true }; }
      if (this._inapp.setBounds && bounds) this._inapp.setBounds(runId, bounds);
      if (this._inapp.showOnly) this._inapp.showOnly(runId);
    } catch { /* best effort */ }
    return { ok: true };
  }

  liveSummary(browserId, { eventsLimit } = {}) {
    const id = browserId != null ? String(browserId) : this._selectedBrowserId;
    if (!id) return { browserId: null, open: false };
    const run = this._runs.get(id);
    const rec = this._registry.get(id);
    if (!run) return { browserId: id, open: false, displayName: rec ? rec.name : null, configuredUrl: rec ? rec.launchUrl : null };
    return {
      open: true,
      displayName: rec ? rec.name : null,
      configuredUrl: rec ? rec.launchUrl : null,
      ...run.liveState.snapshot({ events: true, eventsLimit }),
    };
  }

  // ---- shared-capture routing (passive) ----
  _onCaptureRequest(req) {
    if (!req || !req.isWebSocket || !req.wsDirection) return;
    const bid = this._targetIndex.get(String(req.targetId));
    if (!bid) return;                         // unknown owner -> ignore (never cross-route)
    const run = this._runs.get(bid);
    if (!run || !run.liveState) return;
    const raw = req.body && req.body.raw;
    const at = this._now();
    // Persist FIRST (source of truth) so a renderer failure cannot lose capture (§8/§23).
    if (this._persistence) { try { this._persistence.onFrame(bid, { direction: req.wsDirection, raw, at, wsConnectionId: req.id, targetId: req.targetId }); } catch { /* persistence failure must not stop live capture */ } }
    run.liveState.observeFrame({ direction: req.wsDirection, raw, at, targetId: req.targetId });
  }
  _onCaptureUpdate(req) {
    if (!req || !req.isWebSocket || req.state !== 'FINISHED' || req.wsDirection) return; // connection close only
    const bid = this._targetIndex.get(String(req.targetId));
    const run = bid && this._runs.get(bid);
    if (run && run.liveState) run.liveState.onDisconnect();
  }

  // PASSIVE CDP capture: subscribe a target's own client to Network + WebSocket
  // events and route them through the shared correlator, tagged with the target's
  // id. This is the observe-only subset of Control's attachCdpCapture: NO Fetch
  // interception, NO WS send-hook injection, NO click tracking, NO reload.
  _attachPassiveCapture(client, target) {
    if (!client || this._attachedClients.has(client)) return;
    this._attachedClients.add(client);
    const cap = this._capture;
    const tid = target.cdpTargetId;
    const Network = client.Network;
    const sub = () => {
      try {
        Network.requestWillBeSent((p, sid) => cap.onRequestWillBeSent(tid, p, sid));
        Network.responseReceived((p, sid) => cap.onResponseReceived(tid, p, sid));
        Network.loadingFinished((p, sid) => cap.onLoadingFinished(tid, p, sid));
        Network.loadingFailed((p, sid) => cap.onLoadingFailed(tid, p, sid));
        Network.webSocketCreated((p, sid) => cap.onWebSocketCreated(tid, p, sid));
        Network.webSocketHandshakeResponseReceived((p, sid) => cap.onWebSocketHandshakeResponseReceived(tid, p, sid));
        Network.webSocketFrameSent((p, sid) => cap.onWebSocketFrameSent(tid, p, sid));      // website SEND (observed evidence)
        Network.webSocketFrameReceived((p, sid) => cap.onWebSocketFrameReceived(tid, p, sid)); // server RECV
        Network.webSocketClosed((p, sid) => cap.onWebSocketClosed(tid, p, sid));
      } catch { /* client gone */ }
    };
    (async () => {
      try { await Network.enable(); } catch { return; }
      sub();
      // Cross-origin iframes (OOPIF) and Web Workers run in their own CDP session;
      // flatten auto-attach so the game's WS (often in a worker/iframe) is observed.
      const autoAttachArgs = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
      try { await client.Target.setAutoAttach(autoAttachArgs); } catch { /* unsupported */ }
      try {
        client.Target.attachedToTarget(async ({ sessionId, targetInfo }) => {
          if (targetInfo && targetInfo.type === 'page') return; // top-level pages get their own client
          try { await client.Network.enable({}, sessionId); await client.Target.setAutoAttach(autoAttachArgs, sessionId); } catch { /* child gone */ }
        });
      } catch { /* unsupported */ }
    })();
  }
}

module.exports = { AnalyticsRuntime };
