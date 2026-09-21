'use strict';

const EventEmitter = require('node:events');
const { createTableGroup } = require('./table-group.cjs');
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

    this.endSession();
    const coord = new HostTableCoordinator({ profiles, hostId: host, selectedStake, now: this._now, environmentAuthorized: () => this.authorized(), sessionId: `PHOMHOST-${this._now()}` });
    // docs/phom-kich-ban.md — the group/role/auto flow (paced, one operation at a time) lives in its own module.
    const group = createTableGroup({ coord, log: (event, data) => this.emit('log', { tag: 'PHOM-GROUP', event, ...data }) });
    group.on('update', () => this.emit('update', coord.snapshot()));
    group.on('notice', (n) => this.emit('notice', n));
    this._group = group;
    coord.on('update', (snap) => this.emit('update', snap));
    coord.on('hands', (hands) => this.emit('hands', hands));
    coord.on('cards', (cards) => this.emit('cards', cards)); // PHASE 6.3.3.2 — card observation snapshot
    coord.on('state', (s) => this.emit('state', s));
    coord.on('kick', (k) => this.emit('kick', k));
    coord.on('log', (l) => this.emit('log', l));
    this._session = { coord, runIds: new Set(ids) };
    this._restarts = 0;
    this.emit('update', coord.snapshot());
    return { ok: true, sessionId: coord.sessionId(), hostId: host, state: coord.state() };
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

  setHost(hostId) { const c = this._c(); return c ? c.setHost(hostId) : { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no session' } }; }
  // PHASE 6.3.6 — USER-selected FINDER (room anchor). Passive config (no auth guard), like setHost/selectStake.
  setFinder(profileId) { const c = this._c(); return c ? c.setFinder(profileId == null ? null : String(profileId)) : { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no session' } }; }
  finderId() { const c = this._c(); return c && typeof c.finderId === 'function' ? c.finderId() : null; }
  selectStake(stake) { const c = this._c(); return c ? { ok: true, selected: c.selectStake(stake) } : { ok: false }; }
  requestChannels(opts) { return this._guarded((c) => c.requestChannels(opts || {})); }
  availableStakes() { const c = this._c(); return c && typeof c.availableStakes === 'function' ? c.availableStakes() : []; }
  stop() { const c = this._c(); if (c) c.stop(); }
  verifySameTable() { const c = this._c(); return c ? c.verifySameTable() : { result: 'IDLE' }; }
  coSeatStatus() { const c = this._c(); return c ? c.coSeatStatus() : { ok: false, result: 'IDLE', rid: null, seatedCount: 0, browserCount: 0 }; }
  sharedRidIsChannel() { const c = this._c(); return c ? c.sharedRidIsChannel() : false; }
  snapshot() { const c = this._c(); return c ? c.snapshot() : null; }
  // PHASE-2 — the monotonic discovery/sync milestone timeline (telemetry only; empty when no session).
  trace() { const c = this._c(); return c && typeof c.trace === 'function' ? c.trace() : []; }
  // PHASE-3 · PART B — observe-only native-JOIN experiment (A then B then C, same stake, no room forcing).
  // PHASE-4 — HOST ROOM ANCHOR test: A native-JOIN → confirm in ps[] → bind A's room → B/C JOIN that room.
  // PHASE-6 — MANUAL per-browser control (independent; no host/follower role).
  // PHASE-6.2.1 — REAL discovery: find a qualifying empty table (rid + stake from the server table), join it.
  // ---- docs/phom-kich-ban.md — every table/group action goes through the TableGroup (paced + serialized) ----
  _g() { return this._session ? this._group : null; }
  _grouped(fn) { const g = this._g(); if (!g) return Promise.resolve({ ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no active session' } }); return Promise.resolve(fn(g)); }
  createTable(id, opts) { return this._grouped((g) => g.createTable(String(id), opts || {})); }        // T1
  joinTable(id, rid) { return this._grouped((g) => g.joinTable(String(id), rid)); }                    // T2
  rejoinTable(id) { return this._grouped((g) => g.rejoin(String(id))); }                               // T3
  leaveTable(id) { return this._grouped((g) => g.leave(String(id))); }                                 // T5
  changeKey() { return this._grouped((g) => g.changeKey()); }                                          // T4 / A5
  setAuto(on, opts) { return this._grouped((g) => g.setAuto(!!on, opts || {})); }                      // A1/A2/A6
  leaveAllTables() { return this._grouped((g) => g.leaveAll()); }
  setStake(stake) { const g = this._g(); return g ? g.setStake(stake) : { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no active session' } }; }
  selectedStake() { const g = this._g(); return g ? g.stake() : null; }
  groupSnapshot() { const g = this._g(); return g ? g.snapshot() : null; }
  groupRoleOf(id) { const g = this._g(); return g ? g.roleOf(id) : null; }
  roomList(id) { const c = this._c(); return c && typeof c.roomList === 'function' ? c.roomList(id != null ? String(id) : null) : { rooms: [], at: null, ageSec: null }; }
  manualJoinRoom(id, rid, opts) { return this._guarded((c) => c.manualJoinRoom(String(id), rid, opts)); }
  // PHASE 6.3.5 — FOLLOWER JOIN of the shared anchor RID with bounded, generation-safe, single-flight retry.
  // §co-seat — join a specific SỐ BÀN + KEY (host token) with retry through "sai mật khẩu phòng".
  gameSessionId(id) { const c = this._c(); return c && typeof c.gameSessionId === 'function' ? c.gameSessionId(String(id)) : null; }
  // §34 — cancel the in-flight persistent TÌM BÀN on one browser.
  // §38 — the single authoritative shared room (header + Tool read the same value).
  sharedRid() { const c = this._c(); return c && typeof c.sharedRid === 'function' ? c.sharedRid() : null; }
  sharedRidOwner() { const c = this._c(); return c && typeof c.sharedRidOwner === 'function' ? c.sharedRidOwner() : null; }
  // §co-seat — the shared room CODE (hpwd) the followers' JOIN carries to co-seat at the finder's exact table.
  sharedRoomCode() { const c = this._c(); return c && typeof c.sharedRoomCode === 'function' ? c.sharedRoomCode() : null; }
  // PHASE 6.2.3-fix — reset one browser's Phỏm context after a web reload (so slotInPhom goes false).
  resetBrowser(id) { const c = this._c(); return c && typeof c.resetBrowser === 'function' ? c.resetBrowser(String(id)) : false; }
  manualBrowserSnapshot() {
    // The coordinator reports the TABLE facts; the group ROLE (KEY / READY / NOT_READY) comes from table-group.cjs.
    const c = this._c();
    const list = c && typeof c.manualBrowserSnapshot === 'function' ? c.manualBrowserSnapshot() : [];
    return list.map((b) => ({ ...b, groupRole: this.groupRoleOf(b.profileId) }));
  }
  remainingCards(opts) { const c = this._c(); return c && typeof c.remainingCards === 'function' ? c.remainingCards(opts) : { count: 0, codes: [], cards: [] }; }
  // PHASE 6.3.3.2 — the card-observation snapshot (players/discards/melds/remaining/capabilities), or an
  // empty/unknown shape when there is no active session (never fabricated).
  cardObserverSnapshot() { const c = this._c(); return c && typeof c.cardObserverSnapshot === 'function' ? c.cardObserverSnapshot() : { players: {}, remaining: { count: 0, codes: [], cards: [] }, discardPile: [], capabilities: {} }; }
}

module.exports = { HostSessionManager };
