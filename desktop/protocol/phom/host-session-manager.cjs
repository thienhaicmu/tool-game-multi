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

    const coord = new HostTableCoordinator({ profiles, hostId: host, selectedStake, now: this._now, environmentAuthorized: this.authorized(), sessionId: `PHOMHOST-${this._now()}` });
    coord.on('update', (snap) => this.emit('update', snap));
    coord.on('hands', (hands) => this.emit('hands', hands));
    coord.on('state', (s) => this.emit('state', s));
    coord.on('kick', (k) => this.emit('kick', k));
    this._session = { coord, runIds: new Set(ids) };
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
  setIdentity(runId, identity) { if (this._session && this._session.runIds.has(String(runId))) this._session.coord.setIdentity(String(runId), identity); }

  _c() { return this._session ? this._session.coord : null; }
  _guarded(fn) { const c = this._c(); if (!c) return Promise.resolve({ ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no active session' } }); return Promise.resolve(fn(c)); }

  setHost(hostId) { const c = this._c(); return c ? c.setHost(hostId) : { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no session' } }; }
  selectStake(stake) { const c = this._c(); return c ? { ok: true, selected: c.selectStake(stake) } : { ok: false }; }
  acquireHost() { return this._guarded((c) => c.acquireHost()); }
  joinFollowers() { return this._guarded((c) => c.joinFollowers()); }
  applyReady() { return this._guarded((c) => c.applyReady()); }
  rejoinFollower(id) { return this._guarded((c) => c.rejoinFollower(id)); }
  recoverHost() { return this._guarded((c) => c.recoverHost()); }
  leaveAll() { return this._guarded((c) => c.leaveAll()); }
  stop() { const c = this._c(); if (c) c.stop(); }
  verifySameTable() { const c = this._c(); return c ? c.verifySameTable() : { result: 'IDLE' }; }
  snapshot() { const c = this._c(); return c ? c.snapshot() : null; }
}

module.exports = { HostSessionManager };
