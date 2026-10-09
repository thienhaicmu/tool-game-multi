'use strict';

const EventEmitter = require('node:events');
const { createTableGroup } = require('./table-group.cjs');
const { HostTableCoordinator } = require('./host-table-coordinator.cjs');
const { armExpression } = require('./phom-probe-guard.cjs');

// ---------------------------------------------------------------------------
// HostSessionManager — main-process owner of one Phỏm session: binds a table coordinator (per-browser primitives) and
// a table group (who does what, paced, one at a time — docs/phom-kich-ban.md) to the three real BrowserRuns.
// profileId === browserRunId; frames are routed by the owning run; sends go through wsReplay.sendProtocol on that
// run's own socket.
// ---------------------------------------------------------------------------

const EARLY_RING = 400;

class HostSessionManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._wsReplay = deps.wsReplay || null;
    this._authorized = typeof deps.authorized === 'function' ? deps.authorized : () => false;
    this._resolveProfileMeta = typeof deps.resolveProfileMeta === 'function' ? deps.resolveProfileMeta : (() => ({}));
    this._now = deps.now || (() => Date.now());
    this._featureEnabled = typeof deps.featureEnabled === 'function' ? deps.featureEnabled : (() => true);
    this._session = null; // { coord, runIds:Set }
    this._early = new Map(); // runId -> { ring: [], pinned: Map(kind -> frame) } — frames seen before a session covered the run
  }

  featureEnabled() { return !!this._featureEnabled(); }
  authorized() { return !!this._authorized(); }
  active() { return !!this._session; }

  // The three runs of this session. (Callers may still pass the old hostId; who leads is the user's DÒ KEY now.)
  startSession({ runIds } = {}) {
    if (!this._featureEnabled()) return { ok: false, error: { code: 'PHOM_FEATURE_DISABLED', message: 'Phỏm QA feature flag is off' } };
    // P1/P2/P3 play; a 4th/5th run is a RESERVE (P4/P5) — a full member of the session, never seated by TỰ ĐỘNG
    const ids = Array.isArray(runIds) ? runIds.map(String) : [];
    if (ids.length < 3 || ids.length > 5 || new Set(ids).size !== ids.length) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'three to five distinct runs are required' } };
    const profiles = ids.map((runId) => this._profileFor(runId));
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
    // A browser often logs in (cmd 100: who am I) before the tool starts the session — always so behind a slow
    // proxy, where the first browser is in the lobby long before the third one opens. Those frames used to be
    // dropped, so the account read as not logged in and VÀO GAME never fired by itself. Replay them, in order.
    for (const id of ids) this._replayEarly(id, coord);
    this.emit('update', coord.snapshot());
    return { ok: true, sessionId: coord.sessionId() };
  }

  _profileFor(runId) {
    const meta = this._resolveProfileMeta(runId) || {};
    return {
      id: runId, displayName: meta.displayName || runId, uid: meta.uid || null,
      send: async (payload, ctx) => {
        if (!this._wsReplay) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no send seam' } };
        if (!ctx || !ctx.targetId) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket observed yet for this profile' } };
        return this._wsReplay.sendProtocol(ctx, payload);
      },
      armProbe: async (ctx) => {
        if (!this._wsReplay || !this._wsReplay.evaluateIn || !ctx || !ctx.targetId) return { ok: false };
        return this._wsReplay.evaluateIn(ctx, armExpression());
      },
    };
  }

  // THAY PROFILE / mở lại — the slot's closed run is replaced by a NEW run in place (same P1/P2/P3 position) without
  // ending the session, so the other two browsers keep their table, group role and cards.
  replaceRun(oldRunId, newRunId) {
    const s = this._session;
    const oldId = String(oldRunId), newId = String(newRunId);
    if (!s || !s.runIds.has(oldId) || s.runIds.has(newId)) return { ok: false, replaced: false };
    if (!s.coord.replaceProfile(oldId, this._profileFor(newId))) return { ok: false, replaced: false };
    s.runIds.delete(oldId); s.runIds.add(newId);
    this._early.delete(oldId);
    this._replayEarly(newId, s.coord); // the new browser may already be logged in
    s.coord.rebindCardSlot(newId);     // LỌC BÀI of that slot = the new account
    // THAY ACC: the new browser takes the old one's role and sits at the group's table once it is in the game
    if (this._group) this._group.replaceMember(oldId, newId);
    this.emit('update', s.coord.snapshot());
    this.emit('cards', s.coord.cardObserverSnapshot());
    return { ok: true, replaced: true };
  }

  // ĐỔI — a reserve already in the session (warm: in the game, its bar live) takes a playing slot: the two swap places;
  // the reserve takes the replaced account's role and sits at the group's table (it is in the game already, so at
  // once). Falls back to replaceRun when the new run is not a member yet (a profile opened into a closed slot).
  swapRuns(oldRunId, newRunId) {
    const s = this._session;
    const oldId = String(oldRunId), newId = String(newRunId);
    if (!s || !s.runIds.has(oldId)) return { ok: false, swapped: false };
    if (!s.runIds.has(newId)) return this.replaceRun(oldId, newId);
    if (!s.coord.swapProfiles(oldId, newId)) return { ok: false, swapped: false };
    if (this._group) this._group.replaceMember(oldId, newId);
    this.emit('update', s.coord.snapshot());
    this.emit('cards', s.coord.cardObserverSnapshot());
    return { ok: true, swapped: true, replaced: true };
  }

  // N4 — reserves in and out: a reopened P4/P5 joins the session (warm, its bar works); a closed reserve — or a closed
  // playing browser that a reserve replaced (it moved to the reserve position) — leaves it, so no dead member stays.
  addRun(runId) {
    const s = this._session; const id = String(runId);
    if (!s || s.runIds.has(id) || s.runIds.size >= 5) return { ok: false, added: false };
    if (!s.coord.addProfile(this._profileFor(id))) return { ok: false, added: false };
    s.runIds.add(id);
    this._replayEarly(id, s.coord);
    this.emit('update', s.coord.snapshot());
    return { ok: true, added: true };
  }
  removeRun(runId) {
    const s = this._session; const id = String(runId);
    if (!s || !s.runIds.has(id)) return { ok: false, removed: false };
    if (!s.coord.removeProfile(id)) return { ok: false, removed: false };
    s.runIds.delete(id); this._early.delete(id);
    if (this._group) this._group.dropMember(id);
    this.emit('update', s.coord.snapshot());
    return { ok: true, removed: true };
  }

  // A browser about to leave the session (swapped out to the reserves) leaves the table first — straight through the
  // coordinator (confirmed by the server, no pacing): a benched browser must not keep a seat at the group's table.
  async leaveNow(runId) {
    const c = this._c();
    if (!c || !c.isSeated(String(runId))) return { ok: true, already: true };
    return c.leaveTable(String(runId));
  }

  endSession() {
    const old = this._session; this._session = null;
    if (this._group) { this._group.reset(); this._group.removeAllListeners(); this._group = null; }
    if (old) { old.coord.stop(); old.coord.removeAllListeners(); }
  }

  routeFrame(run, req) {
    if (!run || !req || !req.isWebSocket || !req.wsDirection) return;
    const frame = { raw: req.body && req.body.raw, direction: req.wsDirection, seq: req.seq, targetId: req.targetId, cdpSessionId: req.cdpSessionId || null, url: req.url, now: this._now() };
    const covered = !!(this._session && this._session.runIds.has(String(run.id)));
    this._keepEarly(String(run.id), frame, !covered); // the identity is kept even while covered: a restarted session needs it
    if (covered) this._session.coord.ingest(String(run.id), frame);
  }
  // Frames of a run no session covers yet: the last EARLY_RING of them (ring = true), plus — always — the latest
  // login identity (cmd 100) and wallet (cmd 317), pinned so lobby chatter can never push them out.
  _keepEarly(id, frame, ring) {
    let e = this._early.get(id);
    if (!e) { e = { ring: [], pinned: new Map() }; this._early.set(id, e); }
    if (ring) { e.ring.push(frame); if (e.ring.length > EARLY_RING) e.ring.shift(); }
    const raw = typeof frame.raw === 'string' ? frame.raw : '';
    const m = /"cmd"\s*:\s*(100|317)(?!\d)/.exec(raw);
    if (m) { const idm = /"id"\s*:\s*(\d+)/.exec(raw); e.pinned.set(m[1] + ':' + (idm ? idm[1] : ''), frame); }
  }
  _replayEarly(id, coord) {
    const e = this._early.get(id);
    if (!e) return;
    this._early.set(id, { ring: [], pinned: e.pinned }); // the identity stays pinned for a later restart
    const frames = [...e.pinned.values()].filter((f) => !e.ring.includes(f)).concat(e.ring).sort((a, b) => (a.now - b.now) || ((a.seq || 0) - (b.seq || 0)));
    for (const f of frames) { try { coord.ingest(id, { ...f, replay: true }); } catch { /* a bad frame never blocks the session */ } } // replay: state only, no reaction
  }
  // A new document (F5, ⟳, redirect) = a new login: what was buffered for the old page is void.
  forgetEarly(id) { this._early.delete(String(id)); }
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
  resetBrowser(id) { this.forgetEarly(id); const c = this._c(); return c ? c.resetBrowser(String(id)) : false; }
  // the game uid of one browser of the session (null before its login is seen)
  uidOf(id) { const c = this._c(); return c ? c.uidOf(String(id)) : null; }
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
  autoActive() { const g = this._g(); return !!(g && g.autoActive()); }
  actingOf(id) { const g = this._g(); return g ? g.actingOf(String(id)) : null; }
  groupBusy() { const g = this._g(); return g ? g.busy() : null; }
  groupSnapshot() { const g = this._g(); return g ? g.snapshot() : null; }
  groupRoleOf(id) { const g = this._g(); return g ? g.roleOf(id) : null; }
}

module.exports = { HostSessionManager };
