'use strict';

const EventEmitter = require('node:events');
const { HostTableCoordinator } = require('./host-table-coordinator.cjs');

// ---------------------------------------------------------------------------
// HostSessionManager — main-process owner that binds a HostTableCoordinator to
// three real BrowserRuns for the HOST/FOLLOWER controlled-table flow. Same routing
// contract as PhomSessionManager (profileId === browserRunId; frames routed by the
// owning run; sends go through wsReplay.sendProtocol on that run's own socket). It
// does NOT replace PhomSessionManager — it is the host-flow orchestration owner.
// ---------------------------------------------------------------------------

class HostSessionManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._wsReplay = deps.wsReplay || null;
    this._authorized = typeof deps.authorized === 'function' ? deps.authorized : () => false;
    this._resolveProfileMeta = typeof deps.resolveProfileMeta === 'function' ? deps.resolveProfileMeta : (() => ({}));
    this._now = deps.now || (() => Date.now());
    this._featureEnabled = typeof deps.featureEnabled === 'function' ? deps.featureEnabled : (() => true);
    this._session = null; // { coord, runIds:Set }
  }

  featureEnabled() { return !!this._featureEnabled(); }
  authorized() { return !!this._authorized(); }
  active() { return !!this._session; }
  activeRunIds() { return this._session ? [...this._session.runIds] : []; }

  startSession({ runIds, hostId, selectedStake } = {}) {
    if (!this._featureEnabled()) return { ok: false, error: { code: 'PHOM_FEATURE_DISABLED', message: 'Phỏm QA feature flag is off' } };
    const ids = Array.isArray(runIds) ? runIds.map(String) : [];
    if (ids.length !== 3 || new Set(ids).size !== 3) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'exactly three distinct runs are required' } };
    const host = hostId != null ? String(hostId) : ids[0];
    if (!ids.includes(host)) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'host must be one of the three runs' } };

    const profiles = ids.map((runId) => {
      const meta = this._resolveProfileMeta(runId) || {};
      return {
        id: runId, displayName: meta.displayName || runId, proxyRef: meta.proxyRef || null, uid: meta.uid || null,
        role: runId === host ? 'HOST' : 'FOLLOWER',
        send: async (payload, ctx) => {
          if (!this._wsReplay) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no send seam' } };
          if (!ctx || !ctx.targetId) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket observed yet for this profile' } };
          return this._wsReplay.sendProtocol(ctx, payload);
        },
      };
    });

    const coord = new HostTableCoordinator({ profiles, hostId: host, selectedStake, now: this._now, environmentAuthorized: () => this.authorized(), sessionId: `PHOMHOST-${this._now()}` });
    coord.on('update', (snap) => this.emit('update', snap));
    coord.on('hands', (hands) => this.emit('hands', hands));
    coord.on('cards', (cards) => this.emit('cards', cards)); // PHASE 6.3.3.2 — card observation snapshot
    coord.on('state', (s) => this.emit('state', s));
    coord.on('kick', (k) => this.emit('kick', k));
    coord.on('log', (l) => this.emit('log', l));
    // §14 — autonomous C rejoin: a debounced kick of a confirmed follower triggers an immediate
    // rejoin to the SAME host table. Only when a discovery loop is NOT running (the loop owns joins
    // while active) — otherwise the two double-drive and flood join/leave. rejoinFollower itself has
    // cooldown + a REJOINING guard against duplicates.
    coord.on('kick', ({ id } = {}) => { if (id && this.authorized() && !coord.isStopped() && !coord.isRunning()) Promise.resolve(coord.rejoinFollower(id)).catch(() => {}); });
    // §12/§17 — global invalidation: all leave, then the host restarts discovery. Debounced + gated
    // on NOT already running, so a per-frame stream of 'invalidated' can't spam leaveAll/restart.
    coord.on('invalidated', async () => {
      if (!this.authorized() || coord.isStopped() || coord.isRunning() || this._restartInFlight) return;
      this._restartInFlight = true;
      this._restarts = (this._restarts || 0) + 1;
      try { await coord.leaveAll(); } catch { /* best effort */ }
      if (this._restarts <= (this._maxRestarts || 20) && !coord.isStopped()) { try { await coord.runDiscovery(); } catch {} }
      this._restartInFlight = false;
    });
    this._session = { coord, runIds: new Set(ids) };
    this._restarts = 0;
    this.emit('update', coord.snapshot());
    return { ok: true, sessionId: coord.sessionId(), hostId: host, state: coord.state() };
  }

  endSession() { this._session = null; }

  routeFrame(run, req) {
    if (!this._session || !run || !req || !req.isWebSocket || !req.wsDirection) return;
    if (!this._session.runIds.has(String(run.id))) return;
    this._session.coord.ingest(String(run.id), { raw: req.body && req.body.raw, direction: req.wsDirection, seq: req.seq, targetId: req.targetId, cdpSessionId: req.cdpSessionId || null, url: req.url, now: this._now() });
  }
  routeDisconnect(runId) { if (this._session && this._session.runIds.has(String(runId))) this._session.coord.markDisconnected(String(runId)); }
  // PH-2 — route a CDP websocket-closed for one run; the coordinator ignores it unless the closed
  // socket was that profile's bound game socket. Returns true if it flipped the profile offline.
  routeSocketClosed(runId, meta) { return !!(this._session && this._session.runIds.has(String(runId)) && this._session.coord.markSocketClosed(String(runId), meta || {})); }
  setIdentity(runId, identity) { if (this._session && this._session.runIds.has(String(runId))) this._session.coord.setIdentity(String(runId), identity); }

  _c() { return this._session ? this._session.coord : null; }
  _guarded(fn) { const c = this._c(); if (!c) return Promise.resolve({ ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no active session' } }); return Promise.resolve(fn(c)); }

  setHost(hostId) { const c = this._c(); return c ? c.setHost(hostId) : { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no session' } }; }
  selectStake(stake) { const c = this._c(); return c ? { ok: true, selected: c.selectStake(stake) } : { ok: false }; }
  requestChannels() { return this._guarded((c) => c.requestChannels()); }
  availableStakes() { const c = this._c(); return c && typeof c.availableStakes === 'function' ? c.availableStakes() : []; }
  acquireHost() { return this._guarded((c) => c.acquireHost()); }
  runDiscovery() { return this._guarded((c) => c.runDiscovery()); }
  joinFollowers() { return this._guarded((c) => c.joinFollowers()); }
  applyReady() { return this._guarded((c) => c.applyReady()); }
  rejoinFollower(id) { return this._guarded((c) => c.rejoinFollower(id)); }
  recoverHost() { return this._guarded((c) => c.recoverHost()); }
  leaveAll() { return this._guarded((c) => c.leaveAll()); }
  stop() { const c = this._c(); if (c) c.stop(); }
  verifySameTable() { const c = this._c(); return c ? c.verifySameTable() : { result: 'IDLE' }; }
  snapshot() { const c = this._c(); return c ? c.snapshot() : null; }
  // PHASE-2 — the monotonic discovery/sync milestone timeline (telemetry only; empty when no session).
  trace() { const c = this._c(); return c && typeof c.trace === 'function' ? c.trace() : []; }
  // PHASE-3 · PART B — observe-only native-JOIN experiment (A then B then C, same stake, no room forcing).
  runJoinExperiment(channel, opts) { return this._guarded((c) => c.runJoinExperiment(channel, opts)); }
  // PHASE-4 — HOST ROOM ANCHOR test: A native-JOIN → confirm in ps[] → bind A's room → B/C JOIN that room.
  runHostAnchoredJoin(channel, opts) { return this._guarded((c) => c.runHostAnchoredJoin(channel, opts)); }
  // PHASE-6 — MANUAL per-browser control (independent; no host/follower role).
  manualFindTable(id, channel, opts) { return this._guarded((c) => c.manualFindTable(String(id), channel, opts)); }
  // PHASE-6.2.1 — REAL discovery: find a qualifying empty table (rid + stake from the server table), join it.
  manualDiscoverTable(id, opts) { return this._guarded((c) => c.manualDiscoverTable(String(id), opts)); }
  manualJoinRoom(id, rid, opts) { return this._guarded((c) => c.manualJoinRoom(String(id), rid, opts)); }
  manualRejoin(id, opts) { return this._guarded((c) => c.manualRejoin(String(id), opts)); }
  manualLeave(id) { return this._guarded((c) => c.manualLeave(String(id))); }
  // PHASE 6.2.3-fix — reset one browser's Phỏm context after a web reload (so slotInPhom goes false).
  resetBrowser(id) { const c = this._c(); return c && typeof c.resetBrowser === 'function' ? c.resetBrowser(String(id)) : false; }
  manualBrowserSnapshot() { const c = this._c(); return c && typeof c.manualBrowserSnapshot === 'function' ? c.manualBrowserSnapshot() : []; }
  remainingCards(opts) { const c = this._c(); return c && typeof c.remainingCards === 'function' ? c.remainingCards(opts) : { count: 0, codes: [], cards: [] }; }
  // PHASE 6.3.3.2 — the card-observation snapshot (players/discards/melds/remaining/capabilities), or an
  // empty/unknown shape when there is no active session (never fabricated).
  cardObserverSnapshot() { const c = this._c(); return c && typeof c.cardObserverSnapshot === 'function' ? c.cardObserverSnapshot() : { players: {}, remaining: { count: 0, codes: [], cards: [] }, discardPile: [], capabilities: {} }; }
}

module.exports = { HostSessionManager };
