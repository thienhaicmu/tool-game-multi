'use strict';

const EventEmitter = require('node:events');
const { PhomContext } = require('./phom-context.cjs');
const { reduceHand, emptyHand, SYNC } = require('./hand-reducer.cjs');
const { ZONE, GID } = require('./phom-frame-classify.cjs');

// ---------------------------------------------------------------------------
// PhomCoordinator — orchestrates a THREE-PROFILE Phỏm QA session. It does NOT
// own a global WebSocket: each profile has its OWN PhomContext + hand and the
// coordinator only sequences per-profile sends (join/ready/leave) through the
// injected per-profile `send` seam (main.cjs -> wsReplay.sendProtocol on that
// run's own socket). Pure of Electron/CDP so it is fully unit-testable.
//
// Authoritative-evidence rule everywhere: no transition to SAME_TABLE / READY
// on a timer or on "we sent the frame"; only real table-state / seat evidence.
// ---------------------------------------------------------------------------

const SESSION = Object.freeze({
  IDLE: 'IDLE',
  REQUESTING_CHANNELS: 'REQUESTING_CHANNELS',
  CHANNEL_SELECTED: 'CHANNEL_SELECTED',
  JOINING_TOGETHER: 'JOINING_TOGETHER',
  VERIFYING_TABLE: 'VERIFYING_TABLE',
  SAME_TABLE: 'SAME_TABLE',
  READYING: 'READYING',
  READY: 'READY',
  IN_ROUND: 'IN_ROUND',
  ROUND_ENDED: 'ROUND_ENDED',
  LEAVING: 'LEAVING',
  LEFT: 'LEFT',
  // failure / terminal-ish
  PARTIAL_JOIN: 'PARTIAL_JOIN',
  TABLE_MISMATCH: 'TABLE_MISMATCH',
  UNAUTHORIZED: 'UNAUTHORIZED_ENVIRONMENT_REQUIRED',
  ERROR: 'ERROR',
});

const PROFILE = Object.freeze({
  IDLE: 'IDLE', JOINING: 'JOINING', AT_TABLE: 'AT_TABLE', MISMATCH: 'MISMATCH',
  READYING: 'READYING', READY: 'READY', LEAVING: 'LEAVING', LEFT: 'LEFT',
  DISCONNECTED: 'DISCONNECTED', ERROR: 'ERROR',
});

// ---- pure wire builders (the only place join/ready/leave frames are shaped) ----
function buildChannelListFrame(aid) { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 300, aid, gid: GID }]); }
function buildFindTableFrame() { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 311, gid: GID }]); }
function buildJoinFrame(channel) { return JSON.stringify([3, ZONE, channel, '']); }
function buildReadyFrame() { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 363, aRd: 'true' }]); }
function buildLeaveFrame() { return JSON.stringify([4, ZONE, -1]); }

class PhomCoordinator extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._now = deps.now || (() => Date.now());
    this._sessionId = deps.sessionId || `PHOM-${this._now()}`;
    this._authorized = deps.environmentAuthorized !== false; // active orchestration gate (§19)
    this._joinWindowMs = deps.joinWindowMs != null ? deps.joinWindowMs : 250;
    this._maxRejoin = deps.maxRejoinAttempts != null ? deps.maxRejoinAttempts : 3;
    this._rejoinCooldownMs = deps.rejoinCooldownMs != null ? deps.rejoinCooldownMs : 1500;

    this._state = SESSION.IDLE;
    this._selectedChannel = null;
    this._stopped = false;
    this._profiles = new Map(); // profileId -> profile record

    const list = Array.isArray(deps.profiles) ? deps.profiles : [];
    if (list.length !== 3) {
      // Not fatal for construction (tests may add later), but the QA session needs 3.
      this._profileCountWarning = list.length;
    }
    for (const p of list) this._addProfile(p);
  }

  _addProfile(p) {
    if (!p || p.id == null) return;
    const id = String(p.id);
    const ctx = new PhomContext({ profileId: id, uid: p.uid });
    const rec = {
      id,
      displayName: p.displayName != null ? String(p.displayName) : id,
      proxyRef: p.proxyRef != null ? String(p.proxyRef) : null,
      send: typeof p.send === 'function' ? p.send : async () => ({ ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'No send seam' } }),
      ctx,
      hand: emptyHand(id, p.uid),
      state: PROFILE.IDLE,
      joinSentAt: null,
      rejoinAttempts: 0,
      lastRejoinAt: null,
      lastError: null,
    };
    ctx.on('change', () => this._evaluate());
    this._profiles.set(id, rec);
  }

  profileIds() { return [...this._profiles.keys()]; }
  sessionId() { return this._sessionId; }
  state() { return this._state; }

  // ---- passive ingestion (always allowed, even unauthorized) ----
  // Route ONE captured WS frame for a specific profile. Classifies once, updates
  // that profile's context + hand, never touches another profile.
  ingest(profileId, meta = {}) {
    const rec = this._profiles.get(String(profileId));
    if (!rec) return null;
    const now = meta.now != null ? meta.now : this._now();
    const cls = rec.ctx.observe({ ...meta, now });
    if (cls && cls.isHandEvent) {
      const seq = Number.isFinite(meta.seq) ? meta.seq : null;
      rec.hand = reduceHand(rec.hand, cls, { profileId: rec.id, profileUid: rec.ctx.uid(), seq, now });
    }
    // Keep seat/table identity mirrored onto the hand for the UI aggregate.
    const seat = rec.ctx.seat();
    const ident = rec.ctx.get().physicalTableIdentity;
    if (seat != null || ident != null) {
      rec.hand = reduceHand(rec.hand, { type: 'CONTROL', control: 'SEAT', seat, physicalTableIdentity: ident }, { profileId: rec.id, profileUid: rec.ctx.uid(), now });
    }
    if (cls && cls.type === 'DEAL') this._setState(SESSION.IN_ROUND);
    if (cls && cls.type === 'ROUND_END') this._setState(SESSION.ROUND_ENDED);
    this._evaluate();
    this.emit('hands', this.handsSnapshot());
    return cls;
  }

  // A profile's socket dropped: hand -> STALE, profile -> DISCONNECTED (§14 reconnect).
  markDisconnected(profileId) {
    const rec = this._profiles.get(String(profileId));
    if (!rec) return;
    rec.state = PROFILE.DISCONNECTED;
    rec.ctx.onDisconnect();
    rec.hand = reduceHand(rec.hand, { type: 'CONTROL', control: 'DISCONNECT' }, { profileId: rec.id, profileUid: rec.ctx.uid(), now: this._now() });
    this._evaluate();
    this.emit('hands', this.handsSnapshot());
  }

  // Inject identity known from the authenticated runtime/login context (§4).
  setIdentity(profileId, identity) {
    const rec = this._profiles.get(String(profileId));
    if (rec) rec.ctx.setIdentity(identity);
    this._evaluate();
  }

  // ---- active orchestration (gated by authorized environment §19) ----
  async requestChannels() {
    if (!this._guard()) return this._unauthorized();
    this._setState(SESSION.REQUESTING_CHANNELS);
    const out = [];
    for (const rec of this._profiles.values()) {
      const aid = rec.ctx.aid();
      const ctx = rec.ctx.sendContext();
      if (aid == null) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_PROTOCOL_CONTEXT_MISSING', message: 'aid not learned yet' } }); continue; }
      if (!ctx) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket yet' } }); continue; }
      const res = await rec.send(buildChannelListFrame(aid), ctx);
      out.push({ id: rec.id, ...res });
    }
    return { ok: out.every((r) => r.ok), results: out };
  }

  selectChannel(channel) {
    const c = Number.isFinite(channel) ? channel : (channel != null ? Number(channel) : null);
    this._selectedChannel = c;
    if (c != null) this._setState(SESSION.CHANNEL_SELECTED);
    this._evaluate();
    return this._selectedChannel;
  }
  selectedChannel() { return this._selectedChannel; }

  // §7 — dispatch the SAME channel join for all three profiles inside a small
  // concurrency window. Records each send timestamp. Never reports success here;
  // success is decided later by VERIFYING_TABLE from real table state.
  async joinTogether(channel) {
    if (!this._guard()) return this._unauthorized();
    if (this._stopped) return { ok: false, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } };
    const c = channel != null ? this.selectChannel(channel) : this._selectedChannel;
    if (c == null) return { ok: false, error: { code: 'PHOM_CHANNEL_NOT_FOUND', message: 'no channel selected' } };
    this._setState(SESSION.JOINING_TOGETHER);
    const frame = buildJoinFrame(c);
    const t0 = this._now();
    // Fire all three near-simultaneously (no long fixed delay between them).
    const sends = [...this._profiles.values()].map(async (rec) => {
      rec.state = PROFILE.JOINING;
      rec.joinSentAt = this._now();
      let res;
      try { res = await rec.send(frame, rec.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) } }; }
      if (!res || !res.ok) { rec.state = PROFILE.ERROR; rec.lastError = res && res.error; }
      return { id: rec.id, sentAt: rec.joinSentAt, ...res };
    });
    const results = await Promise.all(sends);
    const window = this._now() - t0;
    this._setState(SESSION.VERIFYING_TABLE);
    this._evaluate();
    return { ok: results.every((r) => r.ok), windowMs: window, joinWindowBudgetMs: this._joinWindowMs, withinWindow: window <= this._joinWindowMs, results };
  }

  // §7 — verify the three profiles landed on the SAME physical table using each
  // session's authoritative table state (never uC, never the join echo).
  verifyTable() {
    const recs = [...this._profiles.values()];
    const views = recs.map((r) => ({ id: r.id, uid: r.ctx.uid(), ts: r.ctx.tableState(), connected: r.ctx.get().connected }));
    const withState = views.filter((v) => v.ts);
    if (withState.length < recs.length) {
      return { result: 'PARTIAL_JOIN', reason: 'not all profiles have a table state', views: this._viewSummaries(views), missing: views.filter((v) => !v.ts).map((v) => v.id) };
    }
    if (views.some((v) => !v.connected)) {
      return { result: 'PARTIAL_JOIN', reason: 'a profile is disconnected/transitioning', views: this._viewSummaries(views) };
    }
    const ownUids = views.map((v) => v.uid).filter(Boolean);
    // Stake (b) must match across all views.
    const stakes = new Set(views.map((v) => v.ts.b));
    if (stakes.size > 1) return { result: 'TABLE_MISMATCH', reason: 'stake (b) differs', views: this._viewSummaries(views) };
    // Player-set fingerprint must be identical across the three views.
    const fps = new Set(views.map((v) => v.ts.identity ? v.ts.identity.value : ''));
    if (fps.size > 1) return { result: 'TABLE_MISMATCH', reason: 'player set differs between profiles', views: this._viewSummaries(views) };
    // Seat mapping must be consistent for every shared uid across views.
    const seatConflict = this._seatConflict(views);
    if (seatConflict) return { result: 'TABLE_MISMATCH', reason: `seat conflict for uid ${seatConflict}`, views: this._viewSummaries(views) };
    // Each view must contain all three OWN uids (proves our three are co-located).
    if (ownUids.length < 3 || new Set(ownUids).size < 3) {
      return { result: 'PARTIAL_JOIN', reason: 'own uid not yet learned for all three profiles', views: this._viewSummaries(views) };
    }
    const allContainOwn = views.every((v) => ownUids.every((u) => v.ts.uids.includes(u)));
    if (!allContainOwn) return { result: 'TABLE_MISMATCH', reason: 'a profile is missing from a table view', views: this._viewSummaries(views) };
    // Outsiders (real 4th player) don't break same-table, but the UI flags them.
    const commonUids = withState[0].ts.uids;
    const hasOutsider = commonUids.some((u) => !ownUids.includes(u));
    return { result: 'SAME_TABLE', hasOutsider, stake: [...stakes][0], fingerprint: [...fps][0], ownUids, views: this._viewSummaries(views) };
  }

  // §11/§7 — re-join ONLY the profiles that are not at the shared table. Bounded
  // attempts + cooldown; never touches correctly-seated profiles; Stop cancels.
  async rejoinMismatched() {
    if (!this._guard()) return this._unauthorized();
    if (this._stopped) return { ok: false, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } };
    const verdict = this.verifyTable();
    if (verdict.result === 'SAME_TABLE') return { ok: true, noop: true, verdict };
    const c = this._selectedChannel;
    if (c == null) return { ok: false, error: { code: 'PHOM_CHANNEL_NOT_FOUND', message: 'no channel selected' } };

    // The reference player-set = the largest agreeing group; profiles NOT in it rejoin.
    const recs = [...this._profiles.values()];
    const majority = this._majorityFingerprint(recs);
    const out = [];
    for (const rec of recs) {
      const ts = rec.ctx.tableState();
      const inMajority = ts && ts.identity && ts.identity.value === majority;
      if (inMajority) { out.push({ id: rec.id, skipped: true, reason: 'already at shared table' }); continue; }
      if (rec.rejoinAttempts >= this._maxRejoin) {
        rec.state = PROFILE.ERROR; rec.lastError = { code: 'PHOM_REJOIN_EXHAUSTED', message: 'max rejoin attempts reached' };
        out.push({ id: rec.id, ok: false, error: rec.lastError }); continue;
      }
      const now = this._now();
      if (rec.lastRejoinAt != null && now - rec.lastRejoinAt < this._rejoinCooldownMs) {
        out.push({ id: rec.id, ok: false, error: { code: 'PHOM_REJOIN_COOLDOWN', message: 'cooldown active' } }); continue;
      }
      rec.rejoinAttempts += 1;
      rec.lastRejoinAt = now;
      rec.state = PROFILE.JOINING;
      // Leave the wrong table (if seated) then rejoin the same channel code.
      try { await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); } catch { /* best effort */ }
      let res;
      try { res = await rec.send(buildJoinFrame(c), rec.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) } }; }
      out.push({ id: rec.id, attempt: rec.rejoinAttempts, ...res });
    }
    this._setState(SESSION.VERIFYING_TABLE);
    this._evaluate();
    return { ok: out.every((r) => r.skipped || r.ok), results: out };
  }

  // §11 — READY only the profiles verified SAME_TABLE. Never 3/3 on 2/3.
  async readyAll() {
    if (!this._guard()) return this._unauthorized();
    const verdict = this.verifyTable();
    if (verdict.result !== 'SAME_TABLE') {
      return { ok: false, error: { code: 'PHOM_TABLE_MISMATCH', message: `cannot ready: table verdict ${verdict.result}` }, verdict };
    }
    this._setState(SESSION.READYING);
    const frame = buildReadyFrame();
    const out = [];
    for (const rec of this._profiles.values()) {
      rec.state = PROFILE.READYING;
      let res;
      try { res = await rec.send(frame, rec.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'PHOM_READY_FAILED', message: String(e && e.message || e) } }; }
      if (!res || !res.ok) { rec.state = PROFILE.ERROR; rec.lastError = res && res.error; }
      out.push({ id: rec.id, ...res });
    }
    this._evaluate();
    return { ok: out.every((r) => r.ok), results: out };
  }

  async leaveAll() {
    this._setState(SESSION.LEAVING);
    const frame = buildLeaveFrame();
    const out = [];
    for (const rec of this._profiles.values()) {
      rec.state = PROFILE.LEAVING;
      let res; try { res = await rec.send(frame, rec.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'ERROR', message: String(e && e.message || e) } }; }
      rec.state = PROFILE.LEFT;
      out.push({ id: rec.id, ...res });
    }
    this._setState(SESSION.LEFT);
    this._evaluate();
    return { ok: true, results: out };
  }

  // Emergency stop: cancel pending orchestration; passive ingest still works.
  stop() { this._stopped = true; this._setState(SESSION.LEAVING); this.emit('update', this.snapshot()); }
  isStopped() { return this._stopped; }

  // ---- state evaluation ----
  _evaluate() {
    // Per-profile state from table membership.
    for (const rec of this._profiles.values()) {
      if (rec.state === PROFILE.DISCONNECTED || rec.state === PROFILE.LEFT || rec.state === PROFILE.LEAVING) continue;
      const ts = rec.ctx.tableState();
      if (ts && rec.state !== PROFILE.READY && rec.state !== PROFILE.READYING) rec.state = PROFILE.AT_TABLE;
      if (rec.ctx.ready()) rec.state = PROFILE.READY;
    }
    // Derive session verdict-driven state (only within the join/verify band).
    if ([SESSION.VERIFYING_TABLE, SESSION.JOINING_TOGETHER, SESSION.SAME_TABLE, SESSION.TABLE_MISMATCH, SESSION.PARTIAL_JOIN, SESSION.READYING].includes(this._state)) {
      const verdict = this.verifyTable();
      if (verdict.result === 'SAME_TABLE') {
        const allReady = [...this._profiles.values()].every((r) => r.ctx.ready());
        this._setState(allReady ? SESSION.READY : SESSION.SAME_TABLE);
        for (const rec of this._profiles.values()) if (rec.state === PROFILE.MISMATCH) rec.state = PROFILE.AT_TABLE;
      } else if (verdict.result === 'TABLE_MISMATCH') {
        this._setState(SESSION.TABLE_MISMATCH);
        this._markMismatch();
      } else if (verdict.result === 'PARTIAL_JOIN') {
        this._setState(SESSION.PARTIAL_JOIN);
      }
    }
    this.emit('update', this.snapshot());
  }

  _markMismatch() {
    const recs = [...this._profiles.values()];
    const majority = this._majorityFingerprint(recs);
    for (const rec of recs) {
      const ts = rec.ctx.tableState();
      if (!ts || !ts.identity || ts.identity.value !== majority) {
        if (rec.state !== PROFILE.DISCONNECTED && rec.state !== PROFILE.LEFT) rec.state = PROFILE.MISMATCH;
      }
    }
  }

  _seatConflict(views) {
    const seatByUid = new Map();
    for (const v of views) {
      for (const s of v.ts.seats) {
        if (s.uid == null || s.sit == null) continue;
        if (seatByUid.has(s.uid) && seatByUid.get(s.uid) !== s.sit) return s.uid;
        if (!seatByUid.has(s.uid)) seatByUid.set(s.uid, s.sit);
      }
    }
    return null;
  }

  _majorityFingerprint(recs) {
    const counts = new Map();
    for (const rec of recs) {
      const ts = rec.ctx.tableState();
      const fp = ts && ts.identity ? ts.identity.value : null;
      if (fp == null) continue;
      counts.set(fp, (counts.get(fp) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [fp, n] of counts) if (n > bestN) { best = fp; bestN = n; }
    return best;
  }

  _viewSummaries(views) {
    return views.map((v) => ({ id: v.id, uid: v.uid, connected: v.connected, playerCount: v.ts ? v.ts.playerCount : 0, fingerprint: v.ts && v.ts.identity ? v.ts.identity.value : null, stake: v.ts ? v.ts.b : null }));
  }

  _guard() { return this._authorized && !this._stopped; }
  _unauthorized() {
    if (!this._authorized) { this._setState(SESSION.UNAUTHORIZED); return { ok: false, error: { code: 'PHOM_UNAUTHORIZED_ENVIRONMENT', message: 'AUTHORIZED_ENVIRONMENT_REQUIRED' } }; }
    return { ok: false, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'session stopped' } };
  }

  _setState(next) {
    if (this._state === next) return;
    this._state = next;
    this.emit('state', next);
  }

  // ---- snapshots (serialisable; redaction-safe: dn is dropped from public snapshot) ----
  handsSnapshot() {
    return [...this._profiles.values()].map((rec) => publicHand(rec));
  }

  snapshot() {
    const verdict = this.verifyTable();
    const profiles = [...this._profiles.values()].map((rec) => {
      const c = rec.ctx.get();
      return {
        id: rec.id,
        displayName: rec.displayName,
        proxyRef: rec.proxyRef,
        state: rec.state,
        uid: shortUid(c.uid),
        aid: c.aid,
        socketReady: c.socketReady,
        connected: c.connected,
        seat: c.seat,
        ready: c.ready,
        joinedChannel: c.joinedChannel,
        playerCount: c.tableState ? c.tableState.playerCount : 0,
        physicalTableIdentity: c.physicalTableIdentity,
        rejoinAttempts: rec.rejoinAttempts,
        lastError: rec.lastError || null,
        channels: c.channels.map((ch) => ({ rid: ch.rid, rn: ch.rn, b: ch.b, mM: ch.mM, Mu: ch.Mu, uC: ch.uC, hpwd: ch.hpwd, zn: ch.zn })),
      };
    });
    const readyCount = profiles.filter((p) => p.ready).length;
    const onlineCount = profiles.filter((p) => p.socketReady && p.connected).length;
    return {
      sessionId: this._sessionId,
      state: this._state,
      authorized: this._authorized,
      stopped: this._stopped,
      selectedChannel: this._selectedChannel,
      sameTable: verdict.result === 'SAME_TABLE',
      tableVerdict: verdict.result,
      hasOutsider: verdict.result === 'SAME_TABLE' ? !!verdict.hasOutsider : false,
      onlineCount,
      readyCount,
      profileCount: profiles.length,
      profiles,
      hands: this.handsSnapshot(),
    };
  }
}

// UI/persistence-facing hand view. Never leaks display names; uid is shortened.
function publicHand(rec) {
  const h = rec.hand;
  return {
    profileId: rec.id,
    displayName: rec.displayName,
    uid: shortUid(h.uid),
    seat: h.seat,
    roundIdentity: h.roundIdentity,
    cards: h.cardsRaw.slice(),
    decoded: h.decodedCards.map((d) => ({ code: d.code, label: d.label, rank: d.rank, suit: d.suit, color: d.color })),
    sortedCards: h.sortedCards.slice(),
    serverMelds: h.serverMelds.slice(),
    publicMelds: h.publicMelds.map((m) => ({ meid: m.meid, cards: m.cards.slice() })),
    discardedCards: h.discardedCards.slice(),
    cardCount: h.cardCount,
    authoritative: h.authoritative,
    syncState: h.syncState,
    revision: h.revision,
    sourceCommand: h.sourceCommand,
    lastDrawn: h.lastDrawn,
    lastDiscarded: h.lastDiscarded,
    currentTurnUid: shortUid(h.currentTurnUid),
    resultDelta: h.resultDelta,
    updatedAt: h.updatedAt,
    lastError: h.lastError,
  };
}

// Redact-lite: keep enough to distinguish profiles, drop the full account id tail.
function shortUid(uid) {
  if (uid == null) return null;
  const s = String(uid);
  if (s.length <= 6) return s;
  return `${s.slice(0, 4)}…${s.slice(-3)}`;
}

module.exports = {
  PhomCoordinator, SESSION, PROFILE, SYNC,
  buildChannelListFrame, buildFindTableFrame, buildJoinFrame, buildReadyFrame, buildLeaveFrame,
};
