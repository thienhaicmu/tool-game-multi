'use strict';

const EventEmitter = require('node:events');
const { PhomCoordinator } = require('./phom-coordinator.cjs');
const { SERVER_EVIDENCE_TYPES } = require('./phom-frame-classify.cjs');

// ---------------------------------------------------------------------------
// PhomSessionManager — the MAIN-PROCESS owner that binds a PhomCoordinator to
// three real BrowserRuns. It reuses the EXISTING owners:
//   - runManager        (BrowserRun ownership + target routing)
//   - wsReplay          (the ONLY send seam — the run's own live socket)
//   - the shared capture WS frame stream (routed here by target -> run)
//
// It creates NO second browser manager, NO second capture stack, NO global
// socket. profileId === browserRunId, so every frame/send is routed by the real
// run identity (never the active-run pointer). One active session at a time.
// ---------------------------------------------------------------------------

class PhomSessionManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._runManager = deps.runManager || null;
    this._wsReplay = deps.wsReplay || null;
    this._authorized = typeof deps.authorized === 'function' ? deps.authorized : () => false;
    this._resolveProfileMeta = typeof deps.resolveProfileMeta === 'function' ? deps.resolveProfileMeta : (() => ({}));
    this._now = deps.now || (() => Date.now());
    this._featureEnabled = typeof deps.featureEnabled === 'function' ? deps.featureEnabled : (() => true);

    this._session = null;   // { coord, runIds:Set }
  }

  featureEnabled() { return !!this._featureEnabled(); }
  authorized() { return !!this._authorized(); }
  active() { return !!this._session; }
  activeRunIds() { return this._session ? [...this._session.runIds] : []; }

  // §11 — start a 3-profile session over three existing BrowserRuns.
  startSession({ runIds } = {}) {
    if (!this._featureEnabled()) return { ok: false, error: { code: 'PHOM_FEATURE_DISABLED', message: 'Phỏm QA feature flag is off' } };
    const ids = Array.isArray(runIds) ? runIds.map(String) : [];
    if (ids.length !== 3) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'exactly three runs are required' } };
    if (new Set(ids).size !== 3) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'runs must be distinct' } };

    // Build one send seam per profile: bound to THIS run's own socket context that
    // the coordinator learned from observed frames (never a shared connection).
    const profiles = ids.map((runId) => {
      const meta = this._resolveProfileMeta(runId) || {};
      return {
        id: runId,
        displayName: meta.displayName || runId,
        proxyRef: meta.proxyRef || null,
        uid: meta.uid || null,
        send: async (payload, ctx) => {
          if (!this._wsReplay) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no send seam' } };
          if (!ctx || !ctx.targetId) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket observed yet for this profile' } };
          return this._wsReplay.sendProtocol(ctx, payload);
        },
      };
    });

    const coord = new PhomCoordinator({
      profiles,
      now: this._now,
      environmentAuthorized: this.authorized(),
      sessionId: `PHOM-${this._now()}`,
    });
    coord.on('update', (snap) => this.emit('update', snap));
    coord.on('hands', (hands) => this.emit('hands', hands));
    coord.on('state', (s) => this.emit('state', s));

    this._session = { coord, runIds: new Set(ids) };
    this.emit('update', coord.snapshot());
    return { ok: true, sessionId: coord.sessionId(), state: coord.state() };
  }

  endSession() {
    if (!this._session) return;
    this._session = null;
  }

  // Called from the shared capture WS frame hook in main.cjs. Routes ONLY frames
  // that belong to one of the session's runs, and only recognisable Phỏm frames.
  routeFrame(run, req) {
    if (!this._session || !run || !req || !req.isWebSocket || !req.wsDirection) return;
    if (!this._session.runIds.has(String(run.id))) return;
    this._session.coord.ingest(String(run.id), {
      raw: req.body && req.body.raw,
      direction: req.wsDirection,
      seq: req.seq,
      targetId: req.targetId,
      cdpSessionId: req.cdpSessionId || null,
      url: req.url,
      now: this._now(),
    });
  }

  // A run in the session lost its target / socket.
  routeDisconnect(runId) {
    if (!this._session || !this._session.runIds.has(String(runId))) return;
    this._session.coord.markDisconnected(String(runId));
  }

  // Inject identity learned from the run's authenticated runtime/login context.
  setIdentity(runId, identity) {
    if (this._session && this._session.runIds.has(String(runId))) this._session.coord.setIdentity(String(runId), identity);
  }

  // ---- delegated orchestration ----
  _c() { return this._session ? this._session.coord : null; }
  async requestChannels() { return this._guarded((c) => c.requestChannels()); }
  selectChannel(channel) { const c = this._c(); return c ? c.selectChannel(channel) : null; }
  async joinTogether(channel) { return this._guarded((c) => c.joinTogether(channel)); }
  async rejoinMismatched() { return this._guarded((c) => c.rejoinMismatched()); }
  async readyAll() { return this._guarded((c) => c.readyAll()); }
  async leaveAll() { return this._guarded((c) => c.leaveAll()); }
  stop() { const c = this._c(); if (c) c.stop(); }
  verifyTable() { const c = this._c(); return c ? c.verifyTable() : { result: 'IDLE' }; }
  snapshot() { const c = this._c(); return c ? c.snapshot() : null; }

  async _guarded(fn) {
    const c = this._c();
    if (!c) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no active session' } };
    return fn(c);
  }
}

// Helper reused by main.cjs to quickly decide if a captured frame is worth routing.
function isPhomServerType(type) { return SERVER_EVIDENCE_TYPES.has(type); }

module.exports = { PhomSessionManager, isPhomServerType };
