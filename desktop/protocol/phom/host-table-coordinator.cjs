'use strict';

const EventEmitter = require('node:events');
const { PhomContext } = require('./phom-context.cjs');
const { reduceHand, emptyHand, SYNC } = require('./hand-reducer.cjs');
const { ZONE, GID } = require('./phom-frame-classify.cjs');
const { buildChannelListFrame, buildJoinFrame, buildReadyFrame, buildLeaveFrame } = require('./phom-coordinator.cjs');

// ---------------------------------------------------------------------------
// HostTableCoordinator (§10–20) — the HOST/FOLLOWER controlled-table orchestration.
// It REUSES the Phỏm domain primitives (PhomContext, hand-reducer, frame classifier,
// wire builders); this module is only the asymmetric matchmaking POLICY:
//   - ONE host searches for an EMPTY table at the selected stake and acquires it
//   - the two followers LEAVE their current table and JOIN the host's table
//   - SAME_TABLE is proven from authoritative table state (never uC, never on-send)
//   - Ready policy: with only the 3 controlled accounts, host + follower1 READY and
//     follower2 stays NOT_READY (waiting for an authorized 4th); with 4 present, all
//     three controlled become READY
//   - a kicked FOLLOWER re-joins the host's table (bounded); a kicked HOST never
//     promotes a follower
//
// Pure of Electron/CDP so the whole state machine is unit-testable. `send(frame, ctx)`
// is the per-profile seam (main -> wsReplay.sendProtocol on that run's own socket).
// ---------------------------------------------------------------------------

const SESSION = Object.freeze({
  IDLE: 'IDLE',
  HOST_SEARCHING: 'HOST_SEARCHING',
  HOST_JOIN_SENT: 'HOST_JOIN_SENT',
  HOST_WAITING_CONFIRMATION: 'HOST_WAITING_CONFIRMATION',
  HOST_ACQUIRED: 'HOST_ACQUIRED',
  HOST_ACQUIRE_FAILED: 'HOST_ACQUIRE_FAILED',
  FOLLOWERS_JOINING: 'FOLLOWERS_JOINING',
  VERIFYING_SAME_TABLE: 'VERIFYING_SAME_TABLE',
  CONTROLLED_THREE_PRESENT: 'CONTROLLED_THREE_PRESENT',
  WAITING_AUTHORIZED_FOURTH: 'WAITING_AUTHORIZED_FOURTH',
  TABLE_FULL: 'TABLE_FULL',
  READY_3_OF_3: 'READY_3_OF_3',
  ROUND_RUNNING: 'ROUND_RUNNING',
  ROUND_ENDED: 'ROUND_ENDED',
  TABLE_MISMATCH: 'TABLE_MISMATCH',
  PARTIAL_JOIN: 'PARTIAL_JOIN',
  READY_POLICY_BLOCKED: 'READY_POLICY_BLOCKED',
  HOST_LOST: 'HOST_LOST',
  HOST_TABLE_LOST: 'HOST_TABLE_LOST',
  REJOIN_EXHAUSTED: 'REJOIN_EXHAUSTED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED_ENVIRONMENT_REQUIRED',
});

const ROLE = Object.freeze({ HOST: 'HOST', FOLLOWER: 'FOLLOWER' });
const PSTATE = Object.freeze({ IDLE: 'IDLE', JOINING: 'JOINING', AT_TABLE: 'AT_TABLE', MISMATCH: 'MISMATCH', READY: 'READY', KICKED: 'KICKED', REJOINING: 'REJOINING', DISCONNECTED: 'DISCONNECTED', LEFT: 'LEFT', ERROR: 'ERROR' });

class HostTableCoordinator extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._now = deps.now || (() => Date.now());
    this._sessionId = deps.sessionId || `PHOMHOST-${this._now()}`;
    this._authorized = deps.environmentAuthorized !== false;
    this._selectedStake = deps.selectedStake != null ? deps.selectedStake : null;
    this._maxRejoin = deps.maxRejoinAttempts != null ? deps.maxRejoinAttempts : 3;
    this._rejoinCooldownMs = deps.rejoinCooldownMs != null ? deps.rejoinCooldownMs : 1000;
    this._kickDebounce = deps.kickDebounce != null ? deps.kickDebounce : 2; // consecutive confirmations
    this._joinWindowMs = deps.joinWindowMs != null ? deps.joinWindowMs : 300;

    this._state = SESSION.IDLE;
    this._stopped = false;
    this._hostTableIdentity = null;
    this._roundRunning = false;
    this._profiles = new Map();

    const list = Array.isArray(deps.profiles) ? deps.profiles : [];
    for (const p of list) this._addProfile(p);
    if (deps.hostId != null) this.setHost(deps.hostId);
  }

  _addProfile(p) {
    if (!p || p.id == null) return;
    const id = String(p.id);
    const ctx = new PhomContext({ profileId: id, uid: p.uid });
    const rec = {
      id, displayName: p.displayName != null ? String(p.displayName) : id, proxyRef: p.proxyRef != null ? String(p.proxyRef) : null,
      role: p.role === ROLE.HOST ? ROLE.HOST : ROLE.FOLLOWER,
      send: typeof p.send === 'function' ? p.send : async () => ({ ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no send seam' } }),
      ctx, hand: emptyHand(id, p.uid), state: PSTATE.IDLE,
      confirmedInTable: false, leaving: false, rejoinAttempts: 0, lastRejoinAt: null,
      missingStreak: 0, lastError: null,
    };
    ctx.on('change', () => this._evaluate());
    this._profiles.set(id, rec);
  }

  // ---- roles ----
  setHost(hostId) {
    const hid = String(hostId);
    if (!this._profiles.has(hid)) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'unknown host profile' } };
    let followerN = 0;
    for (const rec of this._profiles.values()) {
      if (rec.id === hid) { rec.role = ROLE.HOST; rec.followerIndex = null; }
      else { rec.role = ROLE.FOLLOWER; rec.followerIndex = followerN++; }
    }
    this._hostId = hid;
    return { ok: true, hostId: hid };
  }
  host() { return this._hostId ? this._profiles.get(this._hostId) : null; }
  followers() { return [...this._profiles.values()].filter((r) => r.role === ROLE.FOLLOWER).sort((a, b) => a.followerIndex - b.followerIndex); }
  selectStake(stake) { this._selectedStake = Number.isFinite(stake) ? stake : (stake != null ? Number(stake) : null); return this._selectedStake; }
  state() { return this._state; }
  sessionId() { return this._sessionId; }
  hostTableIdentity() { return this._hostTableIdentity; }

  // ---- passive ingestion (always allowed) ----
  ingest(profileId, meta = {}) {
    const rec = this._profiles.get(String(profileId));
    if (!rec) return null;
    const now = meta.now != null ? meta.now : this._now();
    const cls = rec.ctx.observe({ ...meta, now });
    if (cls && cls.isHandEvent) {
      rec.hand = reduceHand(rec.hand, cls, { profileId: rec.id, profileUid: rec.ctx.uid(), seq: Number.isFinite(meta.seq) ? meta.seq : null, now });
    }
    if (cls && cls.type === 'DEAL') { this._roundRunning = true; this._setState(SESSION.ROUND_RUNNING); }
    if (cls && cls.type === 'ROUND_END') { this._roundRunning = false; this._setState(SESSION.ROUND_ENDED); }
    this._evaluate();
    this.emit('hands', this.handsSnapshot());
    return cls;
  }

  markDisconnected(profileId) {
    const rec = this._profiles.get(String(profileId));
    if (!rec) return;
    rec.state = (rec.role === ROLE.HOST) ? PSTATE.DISCONNECTED : PSTATE.DISCONNECTED;
    rec.ctx.onDisconnect();
    rec.hand = reduceHand(rec.hand, { type: 'CONTROL', control: 'DISCONNECT' }, { profileId: rec.id, profileUid: rec.ctx.uid(), now: this._now() });
    if (rec.role === ROLE.HOST) this._setState(SESSION.HOST_LOST);
    this._evaluate();
    this.emit('hands', this.handsSnapshot());
  }

  setIdentity(profileId, identity) { const rec = this._profiles.get(String(profileId)); if (rec) rec.ctx.setIdentity(identity); this._evaluate(); }

  // ---- §12 HOST acquires an EMPTY table at the selected stake ----
  async acquireHost() {
    if (!this._guard()) return this._unauthorized();
    const host = this.host();
    if (!host) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no host selected' } };
    if (this._selectedStake == null) return { ok: false, error: { code: 'PHOM_NO_STAKE_SELECTED', message: 'select a stake first' } };
    this._setState(SESSION.HOST_SEARCHING);
    // Only the host requests the channel list; followers do not join yet.
    const aid = host.ctx.aid();
    if (aid == null || !host.ctx.sendContext()) return { ok: false, error: { code: 'PHOM_PROTOCOL_CONTEXT_MISSING', message: 'host aid/socket not ready' } };
    await host.send(buildChannelListFrame(aid), host.ctx.sendContext());
    // Find a candidate channel matching the stake (empty table decided from real state
    // AFTER join — the channel list only narrows to the right stake/zone).
    const candidate = this._pickStakeChannel(host);
    if (!candidate) { this._setState(SESSION.HOST_ACQUIRE_FAILED); return { ok: false, error: { code: 'PHOM_NO_TABLE_FOR_SELECTED_STAKE', message: `no channel for stake ${this._selectedStake}` } }; }
    host.state = PSTATE.JOINING;
    this._setState(SESSION.HOST_JOIN_SENT);
    await host.send(buildJoinFrame(candidate.rid), host.ctx.sendContext());
    host._joinedRid = candidate.rid;
    this._setState(SESSION.HOST_WAITING_CONFIRMATION);
    this._evaluate();
    return { ok: true, candidate: { rid: candidate.rid, b: candidate.b } };
  }

  _pickStakeChannel(host) {
    const chans = host.ctx.channels().filter((c) => (c.zn == null || c.zn === ZONE) && (c.gid == null || c.gid === GID) && Number(c.b) === Number(this._selectedStake));
    if (!chans.length) return null;
    // Prefer the emptiest by uC as a HINT only (authoritative empty is confirmed from
    // ps[] after join, never from uC alone).
    return chans.slice().sort((a, b) => (a.uC || 0) - (b.uC || 0))[0];
  }

  // Called on each evaluate: confirm HOST acquisition from authoritative table state.
  _confirmHostAcquired() {
    const host = this.host();
    if (!host) return;
    const ts = host.ctx.tableState();
    const hostUid = host.ctx.uid();
    if (!ts || hostUid == null) return; // UNKNOWN_TABLE_OCCUPANCY until ps[] arrives
    if (!ts.uids.includes(hostUid)) return; // host not yet seated
    // External-player review: if a non-controlled player already sits here, do not
    // proceed to bring followers into a public table.
    const controlled = new Set(this._controlledUids());
    const outsiders = ts.uids.filter((u) => !controlled.has(u));
    if (outsiders.length > 0 && this._state === SESSION.HOST_WAITING_CONFIRMATION) {
      // A brand-new host table should be empty except for the host; an occupant means
      // this candidate is not a clean empty table.
      host._externalOnAcquire = true;
    }
    this._hostTableIdentity = {
      channelRid: host._joinedRid != null ? host._joinedRid : null,
      selectedStake: this._selectedStake,
      hostUid,
      hostSeat: host.ctx.seat(),
      playerSetFingerprint: ts.identity ? ts.identity.value : null,
      expectedCapacity: 4,
      acquiredAt: this._now(),
    };
    host.state = PSTATE.AT_TABLE;
    host.confirmedInTable = true;
  }

  // ---- §14 followers leave their table then join the host's table ----
  async joinFollowers() {
    if (!this._guard()) return this._unauthorized();
    if (this._state !== SESSION.HOST_ACQUIRED && this._state !== SESSION.PARTIAL_JOIN && this._state !== SESSION.TABLE_MISMATCH) {
      return { ok: false, error: { code: 'PHOM_HOST_NOT_ACQUIRED', message: `host not acquired (state ${this._state})` } };
    }
    const host = this.host();
    const rid = host && host._joinedRid;
    if (rid == null) return { ok: false, error: { code: 'PHOM_TABLE_IDENTITY_MISSING', message: 'no host table' } };
    this._setState(SESSION.FOLLOWERS_JOINING);
    const t0 = this._now();
    const out = [];
    await Promise.all(this.followers().map(async (rec) => {
      if (rec.confirmedInTable && this._followerAtHostTable(rec)) { out.push({ id: rec.id, skipped: true }); return; }
      rec.leaving = true; rec.state = PSTATE.JOINING;
      try { await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); } catch { /* best effort */ }
      rec.leaving = false;
      let res; try { res = await rec.send(buildJoinFrame(rid), rec.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) } }; }
      rec._joinedRid = rid;
      if (!res || !res.ok) { rec.state = PSTATE.ERROR; rec.lastError = res && res.error; }
      out.push({ id: rec.id, ...res });
    }));
    this._setState(SESSION.VERIFYING_SAME_TABLE);
    this._evaluate();
    return { ok: out.every((r) => r.skipped || r.ok), windowMs: this._now() - t0, results: out };
  }

  _followerAtHostTable(rec) {
    const ts = rec.ctx.tableState();
    const hostUid = this.host() && this.host().ctx.uid();
    return !!(ts && hostUid && ts.uids.includes(hostUid) && rec.ctx.uid() && ts.uids.includes(rec.ctx.uid()));
  }

  // ---- §15 same-table invariant across the three controlled profiles ----
  verifySameTable() {
    const recs = [...this._profiles.values()];
    const hostUid = this.host() && this.host().ctx.uid();
    if (!hostUid) return { result: 'PHOM_TABLE_IDENTITY_MISSING' };
    const controlled = this._controlledUids();
    if (controlled.length < 3) return { result: 'PARTIAL_JOIN', reason: 'controlled uids not all known' };
    const views = recs.map((r) => ({ id: r.id, uid: r.ctx.uid(), ts: r.ctx.tableState(), connected: r.ctx.get().connected }));
    if (views.some((v) => !v.ts)) return { result: 'PARTIAL_JOIN', reason: 'a profile has no table state', missing: views.filter((v) => !v.ts).map((v) => v.id) };
    if (views.some((v) => !v.connected)) return { result: 'PARTIAL_JOIN', reason: 'a profile is disconnected/transitioning' };
    // stake / channel consistency
    const stakes = new Set(views.map((v) => v.ts.b));
    if (stakes.size > 1) return { result: 'TABLE_MISMATCH', reason: 'stake differs' };
    // every view must contain the host uid AND all three controlled uids
    for (const v of views) {
      if (!v.ts.uids.includes(hostUid)) return { result: 'TABLE_MISMATCH', reason: `hostUid missing from ${v.id}` };
      if (!controlled.every((u) => v.ts.uids.includes(u))) return { result: 'TABLE_MISMATCH', reason: `a controlled uid missing from ${v.id}` };
    }
    // player-set fingerprint identical + seat mapping consistent
    if (new Set(views.map((v) => v.ts.identity ? v.ts.identity.value : '')).size > 1) return { result: 'TABLE_MISMATCH', reason: 'player set differs' };
    const seatConflict = this._seatConflict(views);
    if (seatConflict) return { result: 'TABLE_MISMATCH', reason: `seat conflict for ${seatConflict}` };
    return { result: 'SAME_TABLE', hostUid, controlled, playerCount: views[0].ts.playerCount };
  }

  // ---- §16 ready policy ----
  readyPolicy() {
    const host = this.host();
    const ts = host && host.ctx.tableState();
    const playerCount = ts ? ts.playerCount : 0;
    const followers = this.followers();
    // desired ready state per controlled profile.
    const desired = new Map();
    desired.set(host ? host.id : null, true);
    if (playerCount >= 4) { for (const f of followers) desired.set(f.id, true); }
    else { followers.forEach((f, i) => desired.set(f.id, i === 0)); } // follower1 ready, follower2 not
    return { playerCount, desired, waitingFourth: playerCount < 4 };
  }

  async applyReady() {
    if (!this._guard()) return this._unauthorized();
    const verdict = this.verifySameTable();
    if (verdict.result !== 'SAME_TABLE') return { ok: false, error: { code: 'PHOM_TABLE_MISMATCH', message: `cannot ready: ${verdict.result}` }, verdict };
    const { desired } = this.readyPolicy();
    const out = [];
    for (const rec of this._profiles.values()) {
      if (desired.get(rec.id) !== true) { out.push({ id: rec.id, ready: false, skipped: true }); continue; }
      if (rec.ctx.ready()) { out.push({ id: rec.id, ready: true, already: true }); continue; }
      let res; try { res = await rec.send(buildReadyFrame(), rec.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'PHOM_READY_FAILED', message: String(e && e.message || e) } }; }
      out.push({ id: rec.id, ...res });
    }
    this._evaluate();
    return { ok: out.every((r) => r.skipped || r.ok || r.already), results: out };
  }

  async leaveAll() {
    this._setState(SESSION.STOPPING);
    const out = [];
    for (const rec of this._profiles.values()) { rec.state = PSTATE.LEFT; try { await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); out.push({ id: rec.id, ok: true }); } catch { out.push({ id: rec.id, ok: false }); } }
    this._setState(SESSION.STOPPED);
    return { ok: true, results: out };
  }
  stop() { this._stopped = true; this._setState(SESSION.STOPPING); this.emit('update', this.snapshot()); }
  isStopped() { return this._stopped; }

  // ---- §17/§18 kick detection + follower rejoin ----
  // Debounced from authoritative evidence: a confirmed profile whose uid disappears
  // from the host's authoritative player set, with no pending voluntary leave.
  _updateKickDetection() {
    const host = this.host();
    const hostTs = host && host.ctx.tableState();
    if (!hostTs || !this._hostTableIdentity) return;
    for (const rec of this._profiles.values()) {
      if (rec.role === ROLE.HOST) continue;
      const uid = rec.ctx.uid();
      if (!rec.confirmedInTable || !uid || rec.leaving || rec.state === PSTATE.REJOINING) { rec.missingStreak = 0; continue; }
      const present = hostTs.uids.includes(uid);
      if (present) { rec.missingStreak = 0; if (rec.state === PSTATE.KICKED) rec.state = PSTATE.AT_TABLE; continue; }
      // uid missing from authoritative host set — but not during a round cleanup.
      if (this._roundRunning) { continue; } // don't treat round churn as a kick mid-round
      rec.missingStreak = (rec.missingStreak || 0) + 1;
      if (rec.missingStreak >= this._kickDebounce && rec.state !== PSTATE.KICKED) {
        rec.state = PSTATE.KICKED;
        this.emit('kick', { id: rec.id, uid });
      }
    }
    // host kick
    const hostUid = host && host.ctx.uid();
    if (hostUid && host.confirmedInTable && !host.leaving) {
      const hostSelfPresent = hostTs.uids.includes(hostUid);
      if (!hostSelfPresent && !this._roundRunning) {
        host.missingStreak = (host.missingStreak || 0) + 1;
        if (host.missingStreak >= this._kickDebounce) this._setState(SESSION.HOST_LOST);
      } else host.missingStreak = 0;
    }
  }

  async rejoinFollower(profileId) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._profiles.get(String(profileId));
    if (!rec || rec.role !== ROLE.FOLLOWER) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'not a follower' } };
    if (rec.state !== PSTATE.KICKED) return { ok: false, noop: true };
    const host = this.host();
    if (!host || !host.confirmedInTable || this._state === SESSION.HOST_LOST) return { ok: false, error: { code: 'PHOM_HOST_TABLE_LOST', message: 'host table not live' } };
    if (this._roundRunning) return { ok: false, error: { code: 'REJOIN_DEFERRED_ROUND_ACTIVE', message: 'waiting for round end' } };
    if (rec.rejoinAttempts >= this._maxRejoin) { rec.lastError = { code: 'PHOM_REJOIN_EXHAUSTED', message: 'max attempts' }; this._setState(SESSION.REJOIN_EXHAUSTED); return { ok: false, error: rec.lastError }; }
    const now = this._now();
    if (rec.lastRejoinAt != null && now - rec.lastRejoinAt < this._rejoinCooldownMs) return { ok: false, error: { code: 'PHOM_REJOIN_COOLDOWN', message: 'cooldown' } };
    rec.rejoinAttempts += 1; rec.lastRejoinAt = now; rec.state = PSTATE.REJOINING; rec.missingStreak = 0;
    const rid = host._joinedRid;
    try { await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); } catch { /* best effort */ }
    let res; try { res = await rec.send(buildJoinFrame(rid), rec.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) } }; }
    this._evaluate();
    return { ok: !!(res && res.ok), attempt: rec.rejoinAttempts, ...res };
  }

  // Attempt to bring a lost HOST back to the SAME table (never promote a follower).
  async recoverHost() {
    if (!this._guard()) return this._unauthorized();
    if (this._state !== SESSION.HOST_LOST) return { ok: false, noop: true };
    const host = this.host();
    if (!this._hostTableIdentity || this._hostTableIdentity.channelRid == null) { this._setState(SESSION.HOST_TABLE_LOST); return { ok: false, error: { code: 'PHOM_HOST_TABLE_LOST', message: 'host table identity lost' } }; }
    host.state = PSTATE.JOINING; host.missingStreak = 0;
    let res; try { res = await host.send(buildJoinFrame(this._hostTableIdentity.channelRid), host.ctx.sendContext()); } catch (e) { res = { ok: false, error: { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) } }; }
    this._setState(SESSION.HOST_WAITING_CONFIRMATION);
    this._evaluate();
    return { ok: !!(res && res.ok), ...res };
  }

  // ---- evaluation / state derivation ----
  _evaluate() {
    if (this._stopped) { this.emit('update', this.snapshot()); return; }
    // host acquisition confirmation
    if ([SESSION.HOST_WAITING_CONFIRMATION, SESSION.HOST_JOIN_SENT, SESSION.HOST_SEARCHING].includes(this._state)) {
      this._confirmHostAcquired();
      if (this.host() && this.host().confirmedInTable) this._setState(SESSION.HOST_ACQUIRED);
    }
    this._updateKickDetection();

    // same-table + ready derivation once we're past acquisition
    if ([SESSION.FOLLOWERS_JOINING, SESSION.VERIFYING_SAME_TABLE, SESSION.CONTROLLED_THREE_PRESENT, SESSION.WAITING_AUTHORIZED_FOURTH, SESSION.TABLE_FULL, SESSION.READY_3_OF_3, SESSION.TABLE_MISMATCH, SESSION.PARTIAL_JOIN].includes(this._state)) {
      const verdict = this.verifySameTable();
      if (verdict.result === 'SAME_TABLE') {
        // All three controlled profiles are now confirmed at the host table — this is
        // the precondition kick detection needs (a confirmed uid that later vanishes).
        for (const rec of this._profiles.values()) {
          rec.confirmedInTable = true;
          if (rec.state === PSTATE.MISMATCH || rec.state === PSTATE.JOINING) rec.state = PSTATE.AT_TABLE;
        }
        const { desired, playerCount } = this.readyPolicy();
        const allDesiredReady = [...this._profiles.values()].every((rec) => desired.get(rec.id) !== true || rec.ctx.ready());
        if (playerCount >= 4) this._setState(allDesiredReady ? SESSION.READY_3_OF_3 : SESSION.TABLE_FULL);
        else this._setState(SESSION.WAITING_AUTHORIZED_FOURTH);
        // mark ready states
        for (const rec of this._profiles.values()) if (rec.ctx.ready()) rec.state = PSTATE.READY;
      } else if (verdict.result === 'TABLE_MISMATCH') {
        this._setState(SESSION.TABLE_MISMATCH); this._markFollowerMismatch();
      } else if (verdict.result === 'PARTIAL_JOIN') {
        this._setState(SESSION.PARTIAL_JOIN);
      }
    }
    this.emit('update', this.snapshot());
  }

  _markFollowerMismatch() {
    const hostUid = this.host() && this.host().ctx.uid();
    for (const rec of this.followers()) {
      const ts = rec.ctx.tableState();
      const atHost = ts && hostUid && ts.uids.includes(hostUid) && rec.ctx.uid() && ts.uids.includes(rec.ctx.uid());
      if (!atHost && rec.state !== PSTATE.KICKED && rec.state !== PSTATE.DISCONNECTED) rec.state = PSTATE.MISMATCH;
    }
  }

  _seatConflict(views) {
    const seatByUid = new Map();
    for (const v of views) for (const s of (v.ts.seats || [])) {
      if (s.uid == null || s.sit == null) continue;
      if (seatByUid.has(s.uid) && seatByUid.get(s.uid) !== s.sit) return s.uid;
      if (!seatByUid.has(s.uid)) seatByUid.set(s.uid, s.sit);
    }
    return null;
  }
  _controlledUids() { return [...this._profiles.values()].map((r) => r.ctx.uid()).filter(Boolean); }
  _guard() { return this._authorized && !this._stopped; }
  _unauthorized() { if (!this._authorized) { this._setState(SESSION.UNAUTHORIZED); return { ok: false, error: { code: 'PHOM_UNAUTHORIZED_ENVIRONMENT', message: 'AUTHORIZED_ENVIRONMENT_REQUIRED' } }; } return { ok: false, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } }; }
  _setState(next) { if (this._state === next) return; this._state = next; this.emit('state', next); }

  // ---- snapshots ----
  handsSnapshot() { return [...this._profiles.values()].map((rec) => publicHand(rec)); }
  snapshot() {
    const verdict = this.verifySameTable();
    const rp = this.readyPolicy();
    const profiles = [...this._profiles.values()].map((rec) => {
      const c = rec.ctx.get();
      return {
        id: rec.id, displayName: rec.displayName, role: rec.role, proxyRef: rec.proxyRef,
        state: rec.state, uid: shortUid(c.uid), aid: c.aid, socketReady: c.socketReady, connected: c.connected,
        seat: c.seat, ready: c.ready, desiredReady: rp.desired.get(rec.id) === true,
        playerCount: c.tableState ? c.tableState.playerCount : 0,
        confirmedInTable: rec.confirmedInTable, rejoinAttempts: rec.rejoinAttempts, lastError: rec.lastError || null,
      };
    });
    const readyCount = profiles.filter((p) => p.ready).length;
    return {
      sessionId: this._sessionId, state: this._state, authorized: this._authorized, stopped: this._stopped,
      hostId: this._hostId || null, selectedStake: this._selectedStake,
      hostTableIdentity: this._hostTableIdentity,
      sameTable: verdict.result === 'SAME_TABLE', tableVerdict: verdict.result,
      playerCount: rp.playerCount, waitingFourth: rp.waitingFourth,
      controlledReadyCount: profiles.filter((p) => p.ready && p.desiredReady).length,
      readyCount, roundRunning: this._roundRunning,
      onlineCount: profiles.filter((p) => p.socketReady && p.connected).length,
      profiles, hands: this.handsSnapshot(),
    };
  }
}

function publicHand(rec) {
  const h = rec.hand;
  return {
    profileId: rec.id, displayName: rec.displayName, role: rec.role, uid: shortUid(h.uid), seat: h.seat,
    roundIdentity: h.roundIdentity, cards: h.cardsRaw.slice(),
    decoded: h.decodedCards.map((d) => ({ code: d.code, label: d.label, rank: d.rank, suit: d.suit, color: d.color })),
    sortedCards: h.sortedCards.slice(), serverMelds: h.serverMelds.slice(),
    publicMelds: h.publicMelds.map((m) => ({ meid: m.meid, cards: m.cards.slice() })),
    cardCount: h.cardCount, authoritative: h.authoritative, syncState: h.syncState, revision: h.revision,
    lastDrawn: h.lastDrawn, lastDiscarded: h.lastDiscarded, currentTurnUid: shortUid(h.currentTurnUid),
    resultDelta: h.resultDelta, updatedAt: h.updatedAt, lastError: h.lastError,
  };
}
function shortUid(uid) { if (uid == null) return null; const s = String(uid); return s.length <= 6 ? s : `${s.slice(0, 4)}…${s.slice(-3)}`; }

module.exports = { HostTableCoordinator, SESSION, ROLE, PSTATE, SYNC };
