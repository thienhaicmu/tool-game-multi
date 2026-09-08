'use strict';

const EventEmitter = require('node:events');
const { AnalyticsLiveState } = require('./live-state.cjs');
const { classifyFrame } = require('../protocol/frame-classify.cjs');
const { AVIATOR_EVIDENCE_CMDS } = require('../protocol/aviator-context.cjs');
const { EntryOnlyTransport } = require('./entry-only-transport.cjs');
const { AnalyticsAviatorEntryGate } = require('./analytics-aviator-entry.cjs');
const { AnalyticsContextRecovery, STATE: RECOVERY_STATE } = require('./analytics-context-recovery.cjs');
const { looksLikeLoginUrl } = require('../browser-run/login-signal.cjs');

// The single Aviator ENTER cmd (client-originated). Kept as a literal here only to RECOGNISE
// our own outbound entry frame for provenance tagging — never to construct a send.
const CMD_AVIATOR_ENTER = 100000;
// Recovery cadence + thresholds. freshMs MUST exceed a normal between-round gap so quiet pauses
// never read as loss. Fast profile for the deterministic acceptance harness (mirrors Control).
const FAST = process.env.OBSERVATORY_RECOVERY_FAST === '1';
const RECOVERY_CONFIG = FAST
  ? { freshMs: 4000, verifyWindowMs: 2000, maxReentryAttempts: 3 }
  : { freshMs: 20000, verifyWindowMs: 6000, maxReentryAttempts: 3 };
const ENTRY_CONFIRM_TIMEOUT_MS = FAST ? 4000 : 10000;
const RECOVERY_TICK_MS = FAST ? 1000 : 3000;
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const wsKeyOf = (t, s, r) => `${t != null ? t : ''}:${s != null ? s : ''}:${r != null ? r : ''}`;

// ---------------------------------------------------------------------------
// AnalyticsRuntime — M2 composition core for Aviator Analytics.
//
// It owns, per Analytics browser profile:
//   - a persistent in-app browser view (InAppRuntime, 'persist:analytics-*')
//   - its own TargetManager (webContents.debugger / CDP)
//   - a PASSIVE capture attachment (Network + WebSocket frame events only)
//   - an AnalyticsLiveState (bounded live snapshot)
//
// It is passive for game OBSERVATION and all WAGERING behavior: there is deliberately NO
// bet/cashout/replay/arbitrary-send/AutoRunner path anywhere in this module or its imports.
// The ONE permitted protocol-originated action is the fixed Aviator ENTER cmd100000, used only
// for bounded context re-entry via the sealed EntryOnlyTransport + AnalyticsAviatorEntryGate
// (see ADR 0003). The shared CaptureCorrelator is target-keyed, so B1 frames route to B1's live
// state and B2 frames to B2's — the UI selection never changes capture ownership.
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
      live: run ? this._liveWithRecovery(run, run.liveState.snapshot({ events: false })) : null,
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
      liveState: new AnalyticsLiveState({ browserId: id, now: this._now, contextConfig: RECOVERY_CONFIG }),
      aviatorWsCtx: null,        // { targetId, cdpSessionId, host } of the socket carrying Aviator evidence
      aviatorWsKey: null,        // §12 exact wsKey of that owning socket — matched on WS-close by identity
      wsHostByKey: new Map(),    // wsKey -> host (from webSocketCreated) for entry targeting
      recoveryTick: null,        // per-run tick timer
    };
    run.liveState.on('update', () => this.emit('browser-updated', id));
    if (this._persistence) { try { this._persistence.beginSession(id); } catch { /* persistence best-effort; capture continues */ } }

    // ENTRY-ONLY auto-reentry (this WU). The ONLY protocol action Analytics may originate is the
    // fixed Aviator ENTER frame, and only for confirmed context recovery. The transport is sealed
    // (no payload arg); the gate is the semantic owner (SEND != ENTERED); the coordinator reuses the
    // same proven pure AviatorContextTracker Control uses. No BET/CASHOUT/replay/AutoRunner exists here.
    const transport = new EntryOnlyTransport({ resolveClient: (tid) => this.clientForTarget(tid) });
    run.entryGate = new AnalyticsAviatorEntryGate({
      sendEntry: (ctx) => transport.sendEntry(ctx),
      getContext: () => run.aviatorWsCtx,
      now: this._now,
      timeoutMs: ENTRY_CONFIRM_TIMEOUT_MS,
    });
    run.recovery = new AnalyticsContextRecovery({
      entryGate: run.entryGate,
      config: RECOVERY_CONFIG,
      now: this._now,
      onDiag: (evt) => this.emit('recovery-diag', { browserId: id, ...evt }),
    });
    run.recovery.on('state', () => this.emit('browser-updated', id));

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
        run.aviatorWsCtx = null; run.aviatorWsKey = null;          // owning socket gone: no entry target
        try { if (run.entryGate) run.entryGate.cancel('ANALYTICS_ENTRY_DISCONNECTED'); } catch { /* best effort */ }
        if (this._persistence) { try { this._persistence.onDisconnect(id); } catch { /* best effort */ } }
      }
      this.emit('browser-updated', id);
    });
    await tm.start();

    // Per-run recovery tick — advances VERIFYING→CONTEXT_LOST→REENTERING on time, independent of
    // whether new frames arrive. Unref'd so it never keeps the process alive.
    run.recoveryTick = setInterval(() => { try { this._recoveryTick(run); } catch { /* tick best-effort */ } }, RECOVERY_TICK_MS);
    if (run.recoveryTick.unref) run.recoveryTick.unref();

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
    // Stop recovery FIRST so no late frame/callback can resurrect a closing browser (§18).
    try { if (run.recoveryTick) clearInterval(run.recoveryTick); } catch { /* noop */ }
    run.recoveryTick = null;
    try { if (run.recovery) run.recovery.dispose(); } catch { /* noop */ }
    run.aviatorWsCtx = null; run.aviatorWsKey = null;
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
      ...this._liveWithRecovery(run, run.liveState.snapshot({ events: true, eventsLimit })),
    };
  }

  // Overlay the ONE authoritative composite context state onto a live snapshot. The recovery-only
  // runtime states (REENTERING / LOGIN_REQUIRED / RECOVERY_FAILED) override and force live SID/ODD/
  // Jackpot to unavailable; for the base detection states we trust the live-state snapshot itself
  // (same freshness derivation the coordinator's tracker uses — it already nulls on CONTEXT_LOST),
  // so a not-yet-ticked coordinator never wipes genuinely fresh values.
  _liveWithRecovery(run, snap) {
    if (!run.recovery) return snap;
    const composite = run.recovery.state();
    const overlay = composite === RECOVERY_STATE.REENTERING
      || composite === RECOVERY_STATE.LOGIN_REQUIRED
      || composite === RECOVERY_STATE.RECOVERY_FAILED;
    if (!overlay) return snap; // ACTIVE / VERIFYING / CONTEXT_LOST / UNKNOWN: snapshot is authoritative
    return { ...snap, aviatorContext: composite, currentSid: null, currentOdd: null, currentJackpot: null };
  }

  // WU ENTRY-ONLY — evaluate one browser's context/recovery. Gathers the two DISTINCT freshness
  // signals + page/login/socket health and ticks the coordinator (which may fire a bounded, sealed
  // entry request). Time-driven so VERIFYING→CONTEXT_LOST advances even with no new frames.
  _recoveryTick(run) {
    if (!run || !run.recovery) return;
    const now = this._now();
    const ls = run.liveState;
    const wc = (typeof this._inapp.webContents === 'function') ? this._inapp.webContents(run.id) : null;
    let url = '';
    try { if (wc && !wc.isDestroyed()) url = wc.getURL() || ''; } catch { /* wc gone */ }
    const wsConnected = ls.wsStatus() === 'CONNECTED';
    const wcAlive = wc ? !wc.isDestroyed() : wsConnected; // no introspection (tests) → trust WS
    const lastWsRecvMono = ls.lastWsRecvMono();
    const lastWsRecvFresh = lastWsRecvMono != null && (now - lastWsRecvMono) <= RECOVERY_CONFIG.freshMs;
    run.recovery.tick({
      now,
      lastAviatorMono: ls.lastAviatorFrameMono(),
      lastWsRecvMono,
      wcAlive,
      wsConnected,
      lastWsRecvFresh,
      loginRequired: looksLikeLoginUrl(url),
      hasSocket: !!run.aviatorWsCtx,
    });
  }

  // ---- shared-capture routing (passive) ----
  // Routes ALL captured evidence (HTTP + WebSocket) to the owning browser by
  // targetId. Persistence is the source of truth (best-effort, never blocks live
  // capture). The live UI only consumes WS protocol frames.
  _onCaptureRequest(req) {
    if (!req) return;
    const bid = this._targetIndex.get(String(req.targetId));
    if (!bid) return;                         // unknown owner -> ignore (never cross-route)
    const run = this._runs.get(bid);
    if (!run) return;
    const p = this._persistence;
    if (req.isWebSocket && req.wsDirection) {           // WS data frame
      const raw = req.body && req.body.raw;
      const at = this._now();
      const cls = classifyFrame(raw);
      const isAviatorEvidence = req.wsDirection === 'recv' && (AVIATOR_EVIDENCE_CMDS.has(cls.cmd) || cls.jp != null);
      // Bind the game-socket context from the socket that actually carries Aviator evidence —
      // this is the ONLY socket the sealed entry frame may ride. Never guessed, never global.
      if (isAviatorEvidence) {
        const wsKey = wsKeyOf(req.targetId, req.cdpSessionId, req.cdpRequestId);
        const host = run.wsHostByKey.get(wsKey) || '';
        run.aviatorWsCtx = { targetId: req.targetId, cdpSessionId: req.cdpSessionId, host };
        // §12 — remember the EXACT owning socket key so a later WS-close can be matched by identity.
        // Only THIS socket's close may clear Aviator context; unrelated socket churn must not.
        run.aviatorWsKey = wsKey;
        try { if (run.entryGate) run.entryGate.onAviatorEvidence(at); } catch { /* best effort */ }
      }
      // Provenance (§22): tag our OWN sealed entry frame so it is never mislabelled as a website
      // action. A SEND cmd100000 within the gate's self-send window is Analytics-recovery-originated.
      let origin;
      if (req.wsDirection === 'send' && cls.cmd === CMD_AVIATOR_ENTER && run.entryGate && run.entryGate.wasSelfSentRecently(at)) {
        origin = 'ANALYTICS_ENTRY_RECOVERY';
      }
      if (p) { try { p.onWsFrame(bid, { direction: req.wsDirection, raw, at, targetId: req.targetId, cdpRequestId: req.cdpRequestId, cdpSessionId: req.cdpSessionId, origin }); } catch { /* never stop capture */ } }
      if (run.liveState) run.liveState.observeFrame({ direction: req.wsDirection, raw, at, targetId: req.targetId, origin });
    } else if (req.isWebSocket) {                        // WS connection opened
      try { run.wsHostByKey.set(wsKeyOf(req.targetId, req.cdpSessionId, req.cdpRequestId), hostOf(req.url)); } catch { /* best effort */ }
      if (p) { try { p.onWsCreated(bid, req); } catch { /* best effort */ } }
    } else {                                             // HTTP/XHR/fetch/document request
      if (p) { try { p.onHttpRequest(bid, req); } catch { /* best effort */ } }
    }
  }
  _onCaptureUpdate(req) {
    if (!req) return;
    const bid = this._targetIndex.get(String(req.targetId));
    const run = bid && this._runs.get(bid);
    if (!run) return;
    const p = this._persistence;
    if (req.isWebSocket && !req.wsDirection && req.state === 'FINISHED') {   // WS connection closed
      if (p) { try { p.onWsClosed(bid, req); } catch { /* best effort */ } }
      // §12 CONNECTION-AWARE disconnect: ONLY the socket that actually carries Aviator evidence owns
      // the live Aviator context. Unrelated socket churn (gemsdatapi / millicast / analytics side
      // channels open & close constantly) must NEVER wipe _lastAviatorFrameMono or the live snapshot,
      // or a healthy in-game browser would falsely read as "context lost". Genuine whole-page loss is
      // handled separately by tm.on('target-removed'). We match the closed socket by exact identity.
      const closedKey = wsKeyOf(req.targetId, req.cdpSessionId, req.cdpRequestId);
      if (run.aviatorWsKey != null && closedKey === run.aviatorWsKey) {
        run.aviatorWsKey = null;
        run.aviatorWsCtx = null;                                   // owning game socket gone: no entry target
        try { if (run.entryGate) run.entryGate.cancel('ANALYTICS_ENTRY_DISCONNECTED'); } catch { /* best effort */ }
        if (run.liveState) run.liveState.onDisconnect();
      }
    } else if (!req.isWebSocket && (req.state === 'BODY_AVAILABLE' || req.state === 'FINISHED' || req.state === 'FAILED')) {
      // Terminal HTTP: persist response + body (passive body fetch via the owning target's client).
      if (p) { p.onHttpFinalize(bid, req, () => this._capture.getResponseBody(req.id)).catch(() => {}); }
    }
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
