'use strict';

const EventEmitter = require('node:events');
const { createTableGroup } = require('./table-group.cjs');
const { HostTableCoordinator } = require('./host-table-coordinator.cjs');

// ---------------------------------------------------------------------------
// HostSessionManager — main-process owner of one Phỏm session: binds a table coordinator (per-browser primitives) and
// a table group (who does what, paced, one at a time — docs/phom-kich-ban.md) to the three real BrowserRuns.
// profileId === browserRunId; frames are routed by the owning run; sends go through wsReplay.sendProtocol on that
// run's own socket.
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

  // The three runs of this session. (Callers may still pass the old hostId; who leads is the user's DÒ KEY now.)
  startSession({ runIds } = {}) {
    if (!this._featureEnabled()) return { ok: false, error: { code: 'PHOM_FEATURE_DISABLED', message: 'Phỏm QA feature flag is off' } };
    const ids = Array.isArray(runIds) ? runIds.map(String) : [];
    if (ids.length !== 3 || new Set(ids).size !== 3) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'exactly three distinct runs are required' } };
    const profiles = ids.map((runId) => {
      const meta = this._resolveProfileMeta(runId) || {};
      return {
        id: runId, displayName: meta.displayName || runId, uid: meta.uid || null,
        send: async (payload, ctx) => {
          if (!this._wsReplay) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no send seam' } };
          if (!ctx || !ctx.targetId) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket observed yet for this profile' } };
          return this._wsReplay.sendProtocol(ctx, payload);
        },
      };
    });
    this.endSession();
    const coord = new HostTableCoordinator({ profiles, now: this._now, environmentAuthorized: () => this.authorized(), sessionId: `PHOMHOST-${this._now()}` });
    const group = createTableGroup({ coord, log: (event, data) => this.emit('log', { tag: 'PHOM-GROUP', event, ...data }) });
    group.on('update', () => this.emit('update', coord.snapshot()));
    group.on('notice', (n) => this.emit('notice', n));
    this._group = group;
    coord.on('update', (snap) => this.emit('update', snap));
    coord.on('hands', (hands) => this.emit('hands', hands));
    coord.on('cards', (cards) => this.emit('cards', cards));
    coord.on('log', (l) => this.emit('log', l));
    coord.on('kicked', (k) => this.emit('kick', k)); // the tool window refreshes that browser at once
    this._session = { coord, runIds: new Set(ids) };
    this.emit('update', coord.snapshot());
    return { ok: true, sessionId: coord.sessionId() };
  }

  endSession() {
    const old = this._session; this._session = null;
    if (this._group) { this._group.reset(); this._group.removeAllListeners(); this._group = null; }
    if (old) { old.coord.stop(); old.coord.removeAllListeners(); }
  }

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

  // ---- read side (coordinator facts) ----
  requestChannels(opts) { return this._guarded((c) => c.requestChannels(opts || {})); }
  availableStakes() { const c = this._c(); return c ? c.availableStakes() : []; }
  stop() { const c = this._c(); if (c) c.stop(); }
  coSeatStatus() {
    const c = this._c();
    if (!c) return { ok: false, result: 'IDLE', rid: null, seatedCount: 0, browserCount: 0 };
    return { ...c.coSeatStatus(), rid: this.sharedRid() };
  }
  snapshot() { const c = this._c(); return c ? c.snapshot() : null; }
  roomList(id) { const c = this._c(); return c ? c.roomList(id != null ? String(id) : null) : { rooms: [], at: null, ageSec: null }; }
  // The page reloaded — forget that browser's old document.
  resetBrowser(id) { const c = this._c(); return c ? c.resetBrowser(String(id)) : false; }
  remainingCards(opts) { const c = this._c(); return c ? c.remainingCards(opts) : { count: 0, codes: [], cards: [] }; }
  // The card-observation snapshot, or an empty/unknown shape when there is no active session (never fabricated).
  cardObserverSnapshot() { const c = this._c(); return c ? c.cardObserverSnapshot() : { players: {}, remaining: { count: 0, codes: [], cards: [] }, discardPile: [], capabilities: {} }; }
  manualBrowserSnapshot() {
    // The coordinator reports the TABLE facts; the group ROLE (KEY / READY / NOT_READY) + ReJoin come from table-group.cjs.
    const c = this._c(); const g = this._g();
    return (c ? c.manualBrowserSnapshot() : []).map((b) => ({ ...b, groupRole: this.groupRoleOf(b.profileId), rejoinOn: !!(g && g.rejoinOn(b.profileId)) }));
  }
  // The group's số bàn (SS) — the one value the header and the tool both show. Null until Tạo found the KEY's table.
  sharedRid() { const g = this._g(); return g ? g.rid() : null; }
  // The KEY browser once the số bàn is known.
  sharedRidOwner() {
    const g = this._g(); const s = g && g.rid() != null ? g.snapshot() : null;
    const key = s && s.members.find((m) => m.role === 'KEY');
    return key ? key.id : null;
  }

  // ---- docs/phom-kich-ban.md — every table/group action goes through the TableGroup (paced + serialized) ----
  _g() { return this._session ? this._group : null; }
  _grouped(fn) { const g = this._g(); if (!g) return Promise.resolve({ ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no active session' } }); return Promise.resolve(fn(g)); }
  findTable(id, opts) { return this._grouped((g) => g.findTable(String(id), opts || {})); }            // T1 DÒ KEY
  scanTable(id) { return this._grouped((g) => g.scanTable(String(id))); }                             // T2a TẠO
  joinTable(id, rid) { return this._grouped((g) => g.joinTable(String(id), rid)); }                    // T2 VÀO
  rejoinTable(id) { return this._grouped((g) => g.rejoin(String(id))); }                               // T3 ReJoin
  leaveTable(id) { return this._grouped((g) => g.leave(String(id))); }                                 // T5
  newTable() { return this._grouped((g) => g.newTable()); }                                            // T4 / A5
  cancelFind(id) { return this._grouped((g) => g.cancelSearch(String(id))); }                         // DỪNG
  setAuto(on, opts) { return this._grouped((g) => g.setAuto(!!on, opts || {})); }                      // A1/A2/A6
  leaveAllTables() { return this._grouped((g) => g.leaveAll()); }
  setStake(stake) { const g = this._g(); return g ? g.setStake(stake) : { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no active session' } }; }
  selectedStake() { const g = this._g(); return g ? g.stake() : null; }
  groupSnapshot() { const g = this._g(); return g ? g.snapshot() : null; }
  groupRoleOf(id) { const g = this._g(); return g ? g.roleOf(id) : null; }
}

module.exports = { HostSessionManager };
