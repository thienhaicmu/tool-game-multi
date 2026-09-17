'use strict';

const EventEmitter = require('node:events');
const { performance } = require('node:perf_hooks');
const { PhomContext } = require('./phom-context.cjs');
const { reduceHand, emptyHand, SYNC } = require('./hand-reducer.cjs');
const { ZONE, GID } = require('./phom-frame-classify.cjs');
const { buildChannelListFrame, buildJoinFrame, buildReadyFrame, buildLeaveFrame } = require('./phom-coordinator.cjs');
const { remainingCardsView } = require('./remaining-cards.cjs');
const { pickQualifiedCandidate } = require('./table-qualify.cjs');
const { createCardObserver } = require('./phom-card-observer.cjs');

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
  // Phase-3B FINAL host-first discovery states (§21). Membership/validity are proven ONLY from
  // authoritative TABLE_STATE.ps[], never from JOIN ACK or rs[].uC.
  LOBBY_WAITING: 'LOBBY_WAITING',
  HOST_VALIDATING: 'HOST_VALIDATING',           // A joined; awaiting ps[] to validate the candidate
  HOST_CANDIDATE_VALID: 'HOST_CANDIDATE_VALID', // A present in ps[] + table can still form A+B+C
  INVALID_TABLE: 'INVALID_TABLE',               // candidate/table cannot form A+B+C -> leave + restart
  LEAVING_TABLE: 'LEAVING_TABLE',
  RESTART_SEARCH: 'RESTART_SEARCH',
  C_REJOINING: 'C_REJOINING',
  MONITORING: 'MONITORING',
  FOLLOWERS_JOINING: 'FOLLOWERS_JOINING',
  VERIFYING_SAME_TABLE: 'VERIFYING_SAME_TABLE',
  CONTROLLED_THREE_PRESENT: 'CONTROLLED_THREE_PRESENT',
  SAME_TABLE: 'SAME_TABLE',
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

// PHASE 6.3.5 — FIND RESILIENCE V2 bounds (all explicit, no hard-coded magic scattered around):
const DISCOVER_FREE_SLOTS = 3;         // §21 — BEFORE P1 joins, a table must fit P1+P2+P3 (freeSlots >= 3)
const POST_ANCHOR_FREE_SLOTS = 2;      // §20 — AFTER P1 is seated, it must still fit P2+P3 (freeSlots >= 2)
const MAX_ANCHOR_RECOVERY = 2;         // §8  — bounded P1 re-FIND attempts after an invalid anchor
const MAX_SHARED_RID_JOIN_RETRIES = 2; // §11 — follower same-RID retries (initial attempt + 2 = 3 tries max)

class HostTableCoordinator extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._now = deps.now || (() => Date.now());
    this._sessionId = deps.sessionId || `PHOMHOST-${this._now()}`;
    // Authorization may be a boolean (legacy) OR a live getter. A live getter lets a licensed app grant
    // authorization the moment its license is active, regardless of when the session/coordinator was built.
    this._authorizedFn = typeof deps.environmentAuthorized === 'function' ? deps.environmentAuthorized : () => deps.environmentAuthorized !== false;
    this._selectedStake = deps.selectedStake != null ? deps.selectedStake : null;
    // PHASE 6.3.6 — the FINDER (room anchor) is the USER's explicit choice, NOT defaulted to the first profile.
    // null = no finder chosen yet (every browser may FIND); a valid profileId = that browser is the sole finder.
    this._finderId = deps.finderId != null ? String(deps.finderId) : null;
    this._maxRejoin = deps.maxRejoinAttempts != null ? deps.maxRejoinAttempts : 3;
    this._rejoinCooldownMs = deps.rejoinCooldownMs != null ? deps.rejoinCooldownMs : 1000;
    this._kickDebounce = deps.kickDebounce != null ? deps.kickDebounce : 2; // consecutive confirmations
    this._joinWindowMs = deps.joinWindowMs != null ? deps.joinWindowMs : 300;
    // Phase-3B FINAL discovery config.
    this._capacity = deps.tableCapacity != null ? deps.tableCapacity : 4; // Phỏm seats per table (Mu)
    this._maxHostSearch = deps.maxHostSearchAttempts != null ? deps.maxHostSearchAttempts : 8;
    this._discoverBackoffMs = deps.discoverBackoffMs != null ? deps.discoverBackoffMs : 800;
    this._delay = deps.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));

    this._state = SESSION.IDLE;
    this._stopped = false;
    this._hostTableIdentity = null;
    this._roundRunning = false;
    this._gen = 0;                 // orchestration generation token (§22 single orchestrator)
    this._running = false;         // discovery loop active
    this._hostSearchAttempts = 0;
    this._candidateValid = false;
    this._failedRids = new Set();  // candidates whose authoritative state proved invalid (avoid re-pick)
    this._profiles = new Map();
    // PHASE-2 instrumentation (§4/§14): a bounded, monotonic timeline of discovery/sync milestones so
    // a LIVE trace (T0..T12) + latency (server-evidence → state → snapshot) can be measured without a
    // fabricated feed. Pure telemetry — it never influences a state decision. Monotonic ms via
    // performance.now() (immune to wall-clock jumps); wall ts kept for human-readable correlation.
    this._trace = [];
    this._traceCap = deps.traceCap != null ? deps.traceCap : 400;
    this._mono = typeof deps.mono === 'function' ? deps.mono : (() => performance.now());
    this._markedThisGen = new Set(); // one-shot milestones per discovery generation

    // PHASE 6.3.3.2 — one table-level CARD OBSERVER, fed from the SAME classified frames this
    // coordinator already ingests (no second WS listener / no second CDP connection). It records
    // only what the protocol proves and never sends. Its round lifecycle is self-detected (DEAL/END).
    this._cardObserver = createCardObserver({ runId: this._sessionId, now: this._now });

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

  // §13 — the AUTHORITATIVE distinct stakes observed in the server's channel list
  // (CMD 300 rs[] `b`), for this zone/game only. Returns [] until the list has been
  // captured (the UI must show loading; there is NO hard-coded stake fallback).
  availableStakes() {
    const seen = new Set();
    for (const rec of this._profiles.values()) {
      let chans = [];
      try { chans = rec.ctx.channels() || []; } catch { chans = []; }
      for (const c of chans) {
        if ((c.zn != null && c.zn !== ZONE) || (c.gid != null && c.gid !== GID)) continue;
        const b = Number(c.b);
        if (Number.isFinite(b) && b > 0) seen.add(b);
      }
    }
    return [...seen].sort((a, b) => a - b);
  }
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
    // PHASE 6.3.3.2 — feed the table-level card observer with the SAME classified frame. The browser SLOT
    // (B1/B2/B3, by profile order) + this run's AUTHORITATIVE own uid (ctx.uid(), never the index) let the
    // observer attribute own hands + bind slot→uid. Public discards/melds are deduped across the 3 echoes.
    if (cls && (cls.isHandEvent || cls.type === 'TABLE_STATE')) {
      const idx = [...this._profiles.keys()].indexOf(String(profileId));
      this._cardObserver.ingestFrame({ slot: idx >= 0 ? 'B' + (idx + 1) : null, browserIndex: idx + 1, ownUid: rec.ctx.uid(), cls, seq: Number.isFinite(meta.seq) ? meta.seq : null, now });
    }
    // PHASE-2 trace: authoritative server-evidence arrival (from the HOST run — the run driving discovery).
    if (cls && this._hostId && rec.id === this._hostId) {
      if (cls.type === 'CHANNEL_LIST') this._markOnce('channel-list', 'T2_CHANNEL_LIST_RECEIVED');
      if (cls.type === 'TABLE_STATE') this._markOnce('first-table-state', 'T5_FIRST_TABLE_STATE_RECEIVED');
    }
    if (cls && cls.type === 'DEAL') { this._roundRunning = true; this._setState(SESSION.ROUND_RUNNING); this._mark('ROUND_DEAL'); }
    if (cls && cls.type === 'ROUND_END') { this._roundRunning = false; this._setState(SESSION.ROUND_ENDED); this._mark('ROUND_END'); }
    this._evaluate();
    this.emit('hands', this.handsSnapshot());
    if (cls && (cls.isHandEvent || cls.type === 'TABLE_STATE')) this.emit('cards', this.cardObserverSnapshot());
    return cls;
  }

  // PHASE 6.3.3.2 — the deep-cloned, immutable card-observation snapshot for the renderer (Screen 2).
  cardObserverSnapshot() { return this._cardObserver.getSnapshot(); }

  markDisconnected(profileId) {
    const rec = this._profiles.get(String(profileId));
    if (!rec) return;
    rec.state = (rec.role === ROLE.HOST) ? PSTATE.DISCONNECTED : PSTATE.DISCONNECTED;
    rec._manualGen = (rec._manualGen || 0) + 1; rec._followGen = (rec._followGen || 0) + 1; rec._discovering = false; rec._followInFlight = false; // §16/§17 — a dead socket cancels any in-flight find/join/retry
    rec.ctx.onDisconnect();
    rec.hand = reduceHand(rec.hand, { type: 'CONTROL', control: 'DISCONNECT' }, { profileId: rec.id, profileUid: rec.ctx.uid(), now: this._now() });
    if (rec.role === ROLE.HOST) this._setState(SESSION.HOST_LOST);
    this._evaluate();
    this.emit('hands', this.handsSnapshot());
  }

  setIdentity(profileId, identity) { const rec = this._profiles.get(String(profileId)); if (rec) rec.ctx.setIdentity(identity); this._evaluate(); }

  // PH-2 — a CDP `websocket-closed` fired for this run. Treat it as a real game disconnect ONLY
  // when it matches this profile's bound game socket (never an unrelated socket on the same page);
  // then reuse the existing disconnect path so the authoritative snapshot flips connected=false
  // (host → HOST_LOST) and the renderer updates immediately instead of after a poll cycle.
  markSocketClosed(profileId, meta = {}) {
    const rec = this._profiles.get(String(profileId));
    if (!rec || !rec.ctx.socketMatches(meta)) return false;
    this.markDisconnected(profileId);
    return true;
  }

  // §13 — actively request the authoritative stake channel list (CMD 300) so the
  // server replies with rs[], which is ingested passively into each ctx.channels().
  // The stake dropdown then reads availableStakes(). No hard-coded stakes; no stale
  // list — the list only becomes non-empty once a real CHANNEL_LIST frame arrives.
  // Requesting is an active send, so it is environment-guarded like Join/Ready.
  async requestChannels() {
    if (!this._guard()) return this._unauthorized();
    const out = [];
    for (const rec of this._profiles.values()) {
      const aid = rec.ctx.aid();
      const ctx = rec.ctx.sendContext();
      if (aid == null) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_PROTOCOL_CONTEXT_MISSING', message: 'aid not learned yet' } }); continue; }
      if (!ctx) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket yet' } }); continue; }
      let res; try { res = await rec.send(buildChannelListFrame(aid), ctx); } catch (e) { res = { ok: false, error: { code: 'PHOM_CHANNEL_REQUEST_FAILED', message: String(e && e.message || e) } }; }
      out.push({ id: rec.id, ...res });
    }
    return { ok: out.some((r) => r.ok), results: out };
  }

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
    this._markOnce('channel-request', 'T1_REQUEST_CHANNELS_SENT');
    await host.send(buildChannelListFrame(aid), host.ctx.sendContext());
    // Wait briefly for the authoritative CHANNEL_LIST reply (rs[]) to arrive so selection sees the
    // real, current room set (not a stale/empty cache). The rs is ingested asynchronously via the
    // capture stream, so an immediate pick can miss it.
    for (let i = 0; i < 10; i++) {
      const chans = host.ctx.channels().filter((c) => Number(c.b) === Number(this._selectedStake) && !this._failedRids.has(c.rid));
      if (chans.length) break;
      await this._delay(200);
    }
    // Find a candidate channel matching the stake (empty table decided from real state
    // AFTER join — the channel list only narrows to the right stake/zone).
    const candidate = this._pickStakeChannel(host);
    if (!candidate) { this._setState(SESSION.HOST_ACQUIRE_FAILED); return { ok: false, error: { code: 'PHOM_NO_TABLE_FOR_SELECTED_STAKE', message: `no channel for stake ${this._selectedStake}` } }; }
    this._mark('T3_CANDIDATE_SELECTED', { candidateRid: candidate.rid, b: candidate.b });
    host.state = PSTATE.JOINING;
    this._setState(SESSION.HOST_JOIN_SENT);
    this._mark('T4_HOST_JOIN_SENT', { candidateRid: candidate.rid });
    await host.send(buildJoinFrame(candidate.rid), host.ctx.sendContext());
    host._joinedRid = candidate.rid;
    this._setState(SESSION.HOST_WAITING_CONFIRMATION);
    this._evaluate();
    return { ok: true, candidate: { rid: candidate.rid, b: candidate.b } };
  }

  _pickStakeChannel(host) {
    let chans = host.ctx.channels().filter((c) => (c.zn == null || c.zn === ZONE) && (c.gid == null || c.gid === GID) && Number(c.b) === Number(this._selectedStake));
    if (!chans.length) return null;
    // Skip candidates whose authoritative state already proved invalid this discovery run (so the host
    // tries a DIFFERENT room instead of re-picking the same racy/populated one). If every candidate
    // has been excluded, fall back to the full set (state may have changed since).
    const fresh = chans.filter((c) => !this._failedRids.has(c.rid));
    if (fresh.length) chans = fresh;
    // Prefer a REAL table that can still seat the whole controlled group A+B+C: a single-table entry
    // (uC <= Mu — a stake BUCKET has uC far above Mu and must NOT be joined) with at least 3 FREE
    // seats. uC/Mu are HINTS only (authoritative membership is confirmed from ps[] after join), but
    // they let the host target an actually-joinable empty table instead of a full/bucket one.
    const need = 3;
    const fittable = chans.filter((c) => { const Mu = c.Mu != null ? c.Mu : this._capacity; const uC = c.uC != null ? c.uC : 0; return uC <= Mu && (Mu - uC) >= need; });
    const pool = fittable.length ? fittable : chans;
    return pool.slice().sort((a, b) => (a.uC || 0) - (b.uC || 0))[0];
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
    this._markOnce('room-bound', 'T7_ROOM_BOUND', { roomId: this._hostTableIdentity.channelRid });
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
    this._markOnce('ready-sent', 'T11_READY_SENT');
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
  // §23 — DỪNG: stop orchestration only. Bumps the generation so every in-flight discovery/join/
  // rejoin step becomes a no-op; never closes browsers/tabs/sessions (that is a separate owner).
  stop() { this._stopped = true; this._gen++; this._running = false; this._setState(SESSION.STOPPING); this._log('STOPPED'); this.emit('update', this.snapshot()); }
  isRunning() { return this._running; } // a discovery loop owns join/ready/rejoin/restart while true
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

  // ---- PHASE-3 · PART B — observe-only native-JOIN experiment ----
  // Sends the RAW native join ([3,"Simms",<channel/stake>,""]) for A, then B, then C — SAME channel,
  // NO room id, NEVER A's rid handed to B/C — and records, from authoritative TABLE_STATE.ps[], WHERE
  // the SERVER actually seats each account. It does NOT force a shared room and does NOT change the
  // production host-first flow (runDiscovery). Pure observation. Guarded like any active send; bumps
  // the generation so it is the single orchestrator while it runs (a concurrent discovery is cancelled).
  async runJoinExperiment(channel, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const host = this.host();
    if (!host) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no host selected' } };
    const ch = Number.isFinite(channel) ? channel : (channel != null ? Number(channel) : this._selectedStake);
    if (ch == null || !Number.isFinite(ch)) return { ok: false, error: { code: 'PHOM_NO_STAKE_SELECTED', message: 'no channel/stake to join' } };
    const perJoinTimeoutMs = opts.perJoinTimeoutMs != null ? opts.perJoinTimeoutMs : 8000;
    const gen = ++this._gen; this._running = true; this._markedThisGen.clear();
    this._mark('JX0_EXPERIMENT_START', { channel: ch });
    // Order: HOST first (must be ps[]-confirmed before the next), then followers B, C.
    const steps = [
      { rec: host, label: 'HOST', sent: 'J0_HOST_JOIN_SENT', conf: 'J1_HOST_PS_CONFIRMED' },
      ...this.followers().map((f, i) => ({ rec: f, label: i === 0 ? 'B' : 'C', sent: `J${2 + i * 2}_${i === 0 ? 'B' : 'C'}_JOIN_SENT`, conf: `J${3 + i * 2}_${i === 0 ? 'B' : 'C'}_PS_CONFIRMED` })),
    ];
    const observed = [];
    try {
      for (const step of steps) {
        if (this._gen !== gen || this._stopped) return { ok: false, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'experiment cancelled' }, observed };
        const { rec, label } = step;
        const ctx = rec.ctx.sendContext();
        const tSent = this._mark(step.sent, { id: rec.id, label });
        if (!ctx) { observed.push({ id: rec.id, label, seated: false, error: { code: 'PHOM_SOCKET_NOT_FOUND' } }); this._mark(step.conf, { id: rec.id, label, seated: false }); continue; }
        try { await rec.send(buildJoinFrame(ch), ctx); } catch (e) { rec.lastError = { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) }; }
        // Authoritative confirmation ONLY: own uid present in this profile's own TABLE_STATE.ps[].
        const seated = await this._waitUntil(() => { const uid = rec.ctx.uid(); const ts = rec.ctx.tableState(); return !!(uid && ts && ts.uids.includes(uid)); }, gen, perJoinTimeoutMs);
        const ts = rec.ctx.tableState();
        const tConf = this._mark(step.conf, { id: rec.id, label, seated, table: ts && ts.identity ? ts.identity.value : null, seat: rec.ctx.seat() });
        observed.push({ id: rec.id, label, role: rec.role, seated,
          table: ts && ts.identity ? ts.identity.value : null, seat: rec.ctx.seat(),
          stake: ts ? ts.b : null, playerCount: ts ? ts.playerCount : 0,
          joinToPsMs: seated ? Math.round((tConf.mono - tSent.mono) * 1000) / 1000 : null });
      }
    } finally { if (this._gen === gen) this._running = false; }
    const result = this._classifyExperiment();
    this._mark('J6_RESULT', result);
    return { ok: true, channel: ch, observed, ...result };
  }

  // Classify per-profile table membership from the FINAL authoritative state (read live from each
  // ctx, NOT the per-join snapshot): once B/C are seated, an earlier joiner has folded their seat
  // deltas, so co-seated profiles converge to the SAME player-set fingerprint. Same table ⇔ identical
  // fingerprint (with own uid present). Never asserts a server "failure": all-same / partial / all-
  // different are equally valid OBSERVED matchmaking outcomes (§17).
  _classifyExperiment() {
    const host = this.host(); const fol = this.followers();
    const A = host, B = fol[0] || null, C = fol[1] || null;
    const fp = (rec) => { if (!rec) return null; const ts = rec.ctx.tableState(); const uid = rec.ctx.uid(); return (ts && uid && ts.identity && ts.uids.includes(uid)) ? ts.identity.value : null; };
    const seatOf = (rec) => (rec ? rec.ctx.seat() : null);
    const aT = fp(A), bT = fp(B), cT = fp(C);
    const same = (x, y) => !!(x && y && x === y);
    const aB = same(aT, bT), aC = same(aT, cT), bC = same(bT, cT);
    const allThreeSame = aB && aC;
    return {
      aTable: aT, bTable: bT, cTable: cT,
      aSeat: seatOf(A), bSeat: seatOf(B), cSeat: seatOf(C),
      aBSame: aB, aCSame: aC, bCSame: bC, allThreeSame,
      classification: allThreeSame ? 'ALL_THREE_SAME' : (aB || aC || bC ? 'PARTIAL_SAME' : 'ALL_DIFFERENT'),
    };
  }

  // ---- PHASE-4 · HOST ROOM ANCHOR experiment (A → room → B/C) ----
  // Verifies the host-first + room-anchor direction: A native-JOINs a channel, is CONFIRMED in its own
  // authoritative TABLE_STATE.ps[], its ROOM ANCHOR is bound (the rid A joined — the ONLY room id the
  // protocol exposes; TABLE_STATE carries NO server table id, so same-room is proven by the player-set
  // fingerprint), then B and C JOIN THAT EXACT rid (never a fresh stake matchmake) and are each confirmed
  // co-seated with A. Observe-only; does NOT touch the production runDiscovery flow. Its own generation.
  //
  // SOURCE-REALITY caveat (documented, not guessed): the "room id" is host._joinedRid (the JOIN rid),
  // authoritative once A ∈ ps[]. It is NOT a field inside TABLE_STATE — the captured protocol has none.

  // Extract A's authoritative room anchor. Requires A actually seated in its own ps[]; the room id is the
  // rid A joined (host._joinedRid). Returns HOST_ROOM_ID_NOT_FOUND if A is not seated or has no join rid.
  _extractHostRoom(host) {
    const ts = host && host.ctx.tableState();
    const uid = host && host.ctx.uid();
    if (!ts || !uid || !ts.uids.includes(uid)) return { ok: false, error: { code: 'HOST_ROOM_ID_NOT_FOUND', message: 'host not authoritatively seated in ps[]' } };
    const roomId = host._joinedRid;
    if (roomId == null || !Number.isFinite(Number(roomId))) return { ok: false, error: { code: 'HOST_ROOM_ID_NOT_FOUND', message: 'no room id (join rid) for the host' } };
    return { ok: true, roomId: Number(roomId), fingerprint: ts.identity ? ts.identity.value : null, seat: host.ctx.seat() };
  }

  // Both authoritative views agree host H and follower F are co-seated (H+F present in BOTH ps[] sets).
  _coSeated(H, F) {
    const ht = H.ctx.tableState(), ft = F.ctx.tableState();
    const hu = H.ctx.uid(), fu = F.ctx.uid();
    return !!(ht && ft && hu && fu && ht.uids.includes(hu) && ht.uids.includes(fu) && ft.uids.includes(hu) && ft.uids.includes(fu));
  }
  _hostStillSeated(H, roomId) {
    const ht = H.ctx.tableState(), hu = H.ctx.uid();
    return !!(ht && hu && ht.uids.includes(hu) && Number(H._joinedRid) === Number(roomId));
  }

  async runHostAnchoredJoin(channel, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const host = this.host();
    if (!host) return { ok: false, result: 'HOST_JOIN_FAILED', error: { code: 'PHOM_PROFILE_NOT_READY', message: 'no host selected' } };
    const followers = this.followers();
    if (followers.length < 2) return { ok: false, result: 'HOST_JOIN_FAILED', error: { code: 'PHOM_PROFILE_NOT_READY', message: 'need two followers (B, C)' } };
    const ch = Number.isFinite(channel) ? channel : (channel != null ? Number(channel) : this._selectedStake);
    if (ch == null || !Number.isFinite(ch)) return { ok: false, result: 'HOST_JOIN_FAILED', error: { code: 'PHOM_NO_STAKE_SELECTED', message: 'no channel/stake to join' } };
    const timeoutMs = opts.perStageTimeoutMs != null ? opts.perStageTimeoutMs : 8000;
    const gen = ++this._gen; this._running = true; this._markedThisGen.clear();
    // Abort precedence: an explicit stop() (which also bumps _gen) reports CANCELLED; a competing new
    // operation that only bumps the generation reports STALE_GENERATION.
    const stale = () => (this._stopped ? 'CANCELLED' : (this._gen !== gen ? 'STALE_GENERATION' : null));
    const observed = [];
    try {
      // ---- J0/J1 — A native JOIN by channel, confirmed from A's own ps[] ----
      const ctxA = host.ctx.sendContext();
      if (!ctxA) return { ok: false, result: 'HOST_JOIN_FAILED', error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'host has no game socket' }, observed };
      this._mark('J0_HOST_JOIN_SENT', { id: host.id, stake: ch });
      try { await host.send(buildJoinFrame(ch), ctxA); } catch (e) { return { ok: false, result: 'HOST_JOIN_FAILED', error: { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) }, observed }; }
      host._joinedRid = ch; // A's room anchor (the rid A joined); becomes authoritative once ps[] confirms
      const aSeated = await this._waitUntil(() => { const ts = host.ctx.tableState(); const uid = host.ctx.uid(); return !!(ts && uid && ts.uids.includes(uid)); }, gen, timeoutMs);
      const s0 = stale(); if (s0) return { ok: false, result: s0, observed };
      if (!aSeated) return { ok: false, result: 'TIMEOUT', timeoutStage: 'HOST_CONFIRM', observed };
      this._mark('J1_HOST_CONFIRMED', { id: host.id, uid: shortUid(host.ctx.uid()), seat: host.ctx.seat() });
      observed.push({ id: host.id, label: 'HOST', seated: true, seat: host.ctx.seat(), fingerprint: host.ctx.tableState().identity ? host.ctx.tableState().identity.value : null });

      // ---- J2 — bind the host room anchor from authoritative evidence ----
      const room = this._extractHostRoom(host);
      if (!room.ok) return { ok: false, result: 'HOST_ROOM_ID_NOT_FOUND', error: room.error, observed };
      const hostRoomId = room.roomId;
      this._mark('J2_HOST_ROOM_BOUND', { id: host.id, roomId: hostRoomId, seat: room.seat });

      // ---- J3/J4 — B joins the HOST ROOM id; confirm co-seated ----
      const bRes = await this._anchorFollower(followers[0], hostRoomId, gen, timeoutMs, 'B', 'J3_B_JOIN_SENT', 'J4_B_SAME_ROOM_CONFIRMED', host, observed);
      if (!bRes.ok) return { ok: false, result: bRes.result, timeoutStage: bRes.timeoutStage, roomId: hostRoomId, observed };

      // ---- J5/J6 — C joins the HOST ROOM id; confirm co-seated ----
      const cRes = await this._anchorFollower(followers[1], hostRoomId, gen, timeoutMs, 'C', 'J5_C_JOIN_SENT', 'J6_C_SAME_ROOM_CONFIRMED', host, observed);
      if (!cRes.ok) return { ok: false, result: cRes.result, timeoutStage: cRes.timeoutStage, roomId: hostRoomId, observed };

      // ---- J7 — final authoritative A+B+C co-membership ----
      if (!this._coSeated(host, followers[0]) || !this._coSeated(host, followers[1])) return { ok: false, result: 'ROOM_CHANGED', roomId: hostRoomId, observed };
      const members = [host.id, followers[0].id, followers[1].id];
      this._mark('J7_FINAL_CLUSTER_CONFIRMED', { roomId: hostRoomId, members });
      return { ok: true, result: 'HOST_ANCHORED_SAME_ROOM', roomId: hostRoomId, fingerprint: host.ctx.tableState().identity ? host.ctx.tableState().identity.value : null,
        members, seats: { A: host.ctx.seat(), B: followers[0].ctx.seat(), C: followers[1].ctx.seat() }, observed };
    } finally { if (this._gen === gen) this._running = false; }
  }

  // One follower joins the HOST ROOM id and is confirmed co-seated with A (from BOTH ps[] views). Emits
  // the sent/confirmed milestones. Distinguishes: STALE_GENERATION / CANCELLED / <L>_JOIN_FAILED /
  // ROOM_CHANGED (host left/room changed) / <L>_NOT_CONFIRMED_IN_PS (timeout, follower never seated) /
  // <L>_JOIN_WRONG_ROOM (seated elsewhere).
  async _anchorFollower(F, hostRoomId, gen, timeoutMs, label, sentM, confM, host, observed) {
    if (this._stopped) return { ok: false, result: 'CANCELLED' };
    if (this._gen !== gen) return { ok: false, result: 'STALE_GENERATION' };
    const ctx = F.ctx.sendContext();
    if (!ctx) { observed.push({ id: F.id, label, seated: false, error: 'PHOM_SOCKET_NOT_FOUND' }); return { ok: false, result: `${label}_JOIN_FAILED` }; }
    this._mark(sentM, { id: F.id, roomId: hostRoomId });
    try { await F.send(buildJoinFrame(hostRoomId), ctx); } catch (e) { observed.push({ id: F.id, label, seated: false, error: String(e && e.message || e) }); return { ok: false, result: `${label}_JOIN_FAILED` }; }
    F._joinedRid = hostRoomId;
    const seated = await this._waitUntil(() => { const ft = F.ctx.tableState(); const fu = F.ctx.uid(); return !!(ft && fu && ft.uids.includes(fu)); }, gen, timeoutMs);
    if (this._stopped) return { ok: false, result: 'CANCELLED' };
    if (this._gen !== gen) return { ok: false, result: 'STALE_GENERATION' };
    // Host must still be authoritatively seated in the SAME bound room (A didn't leave / room didn't change).
    if (!this._hostStillSeated(host, hostRoomId)) { observed.push({ id: F.id, label, seated, error: 'ROOM_CHANGED' }); return { ok: false, result: 'ROOM_CHANGED' }; }
    if (!seated) return { ok: false, result: `${label}_NOT_CONFIRMED_IN_PS`, timeoutStage: `${label}_SAME_ROOM` };
    if (!this._coSeated(host, F)) { observed.push({ id: F.id, label, seated: true, error: 'WRONG_ROOM', fingerprint: F.ctx.tableState().identity ? F.ctx.tableState().identity.value : null }); return { ok: false, result: `${label}_JOIN_WRONG_ROOM` }; }
    this._mark(confM, { id: F.id, roomId: hostRoomId, hostSeat: host.ctx.seat(), followerSeat: F.ctx.seat() });
    observed.push({ id: F.id, label, seated: true, seat: F.ctx.seat(), fingerprint: F.ctx.tableState().identity ? F.ctx.tableState().identity.value : null });
    return { ok: true };
  }

  // ---- PHASE-6 · MANUAL per-browser table control (NO host/follower role) ----
  // Each browser (profileId === browserRunId) is driven INDEPENDENTLY by the user: FIND / JOIN by RID /
  // REJOIN / LEAVE. These operate on ONE profile, never assign a host, never run _followTogether, and
  // never touch the global discovery generation (_gen) — so one browser's action does not cancel
  // another's. Cancellation is per-browser via rec._manualGen. Confirmation is authoritative: own uid
  // in own TABLE_STATE.ps[]. Reuses buildJoinFrame / buildLeaveFrame (no invented protocol).

  // Per-browser event-driven wait (mirrors _waitUntil but scoped to ONE browser's generation).
  _waitManual(pred, rec, myGen, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => { if (done) return; done = true; this.off('update', onUpdate); clearTimeout(timer); };
      const settle = (v) => { cleanup(); resolve(v); };
      const check = () => { if (this._stopped || rec._manualGen !== myGen) { settle(false); return true; } let ok = false; try { ok = !!pred(); } catch { ok = false; } if (ok) { settle(true); return true; } return false; };
      const onUpdate = () => { check(); };
      const timer = setTimeout(() => { let ok = false; try { ok = !!pred(); } catch { ok = false; } settle(ok && !this._stopped && rec._manualGen === myGen); }, timeoutMs);
      if (check()) return;
      this.on('update', onUpdate);
    });
  }

  _rec(profileId) { return this._profiles.get(String(profileId)) || null; }
  _ownSeated(rec) { const ts = rec.ctx.tableState(); const uid = rec.ctx.uid(); return !!(ts && uid && ts.uids.includes(uid)); }
  // Authoritative logged-in username = the display name (dn) on this browser's OWN seat in ps[]. From
  // server evidence only; USER_UNKNOWN until seated (never guessed, never a "Browser N" placeholder §11).
  _username(rec) { const ts = rec.ctx.tableState(); const uid = rec.ctx.uid(); if (!ts || !uid) return null; const mine = (ts.seats || []).find((s) => s.uid === uid); return mine && mine.dn ? mine.dn : null; }

  // JOIN a specific RID on ONE browser; confirm from that browser's own ps[]. `intent` labels the trace
  // (FIND vs JOIN vs REJOIN) but the wire frame is identical (buildJoinFrame(rid)).
  async manualJoinRoom(profileId, rid, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    const r = Number.isFinite(rid) ? rid : (rid != null && String(rid).trim() !== '' ? Number(rid) : NaN);
    if (!Number.isFinite(r)) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_INVALID_RID', message: 'Room/RID trống hoặc không hợp lệ' } }; }
    const ctx = rec.ctx.sendContext();
    if (!ctx) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'browser has no game socket yet' } }; }
    const intent = opts.intent === 'FIND' ? 'FIND' : (opts.intent === 'REJOIN' ? 'REJOIN' : 'JOIN');
    const myGen = (rec._manualGen = (rec._manualGen || 0) + 1);
    const fg = opts.findGen != null ? opts.findGen : myGen; // PHASE 6.3.4 — correlate FIND trace across discover→join
    rec.manualState = intent === 'FIND' ? 'SEARCHING' : (intent === 'REJOIN' ? 'RECONNECTING' : 'JOINING');
    this._mark(`M_${intent}_SENT`, { id: rec.id, rid: r });
    this.emit('update', this.snapshot());
    try { await rec.send(buildJoinFrame(r), ctx); } catch (e) { rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) }; this._findLog('FX_JOIN_REJECTED', rec, fg, { rid: r, intent }); this.emit('update', this.snapshot()); return { ok: false, id: rec.id, rid: r, error: rec.lastError }; }
    rec._joinedRid = r; rec._lastRid = r; // _lastRid survives LEAVE so REJOIN can return to this room
    this._findLog('F6_JOIN_SENT', rec, fg, { rid: r, intent });
    const seated = await this._waitManual(() => this._ownSeated(rec), rec, myGen, opts.timeoutMs != null ? opts.timeoutMs : 8000);
    if (rec._manualGen !== myGen) { this._findLog('FX_FIND_CANCELLED', rec, fg, { rid: r, intent, reason: 'SUPERSEDED' }); return { ok: false, id: rec.id, rid: r, superseded: true, state: rec.manualState }; }
    if (this._stopped) { rec.manualState = 'LEFT'; this._findLog('FX_SESSION_DEAD', rec, fg, { rid: r, intent }); return { ok: false, id: rec.id, rid: r, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } }; }
    if (!seated) { rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_JOIN_NOT_CONFIRMED', message: 'no TABLE_STATE membership within timeout' }; this._findLog('FX_TIMEOUT', rec, fg, { rid: r, intent }); this.emit('update', this.snapshot()); return { ok: false, id: rec.id, rid: r, state: 'JOIN_FAILED', error: rec.lastError }; }
    rec.manualState = 'JOINED'; rec.confirmedInTable = true; rec.state = PSTATE.AT_TABLE; rec.lastError = null;
    // PHASE 6.3.5 §7 — a discover join is PROVISIONAL until manualDiscoverTable's post-anchor capacity check
    // passes; it must NOT be published to followers yet. Every other join (follower JOIN / REJOIN / direct
    // find-by-channel) is valid on ps[] immediately.
    rec._joinedRidValidated = !opts.provisional;
    // §15/§16 — success is authoritative: own uid ∈ ps[]; the shared/anchor RID is the ACTUAL joined rid.
    this._findLog('F7_TABLE_STATE', rec, fg, { rid: r, intent }); this._findLog('F8_OWN_UID_CONFIRMED', rec, fg, { rid: r, seat: rec.ctx.seat() }); this._findLog('F9_RID_READY', rec, fg, { rid: r });
    this._mark(`M_${intent}_CONFIRMED`, { id: rec.id, rid: r, seat: rec.ctx.seat() });
    this.emit('update', this.snapshot());
    const ts = rec.ctx.tableState();
    return { ok: true, id: rec.id, rid: r, state: 'JOINED', seat: rec.ctx.seat(), membership: ts ? ts.uids.slice() : [], fingerprint: ts && ts.identity ? ts.identity.value : null };
  }

  // The REAL bet options for ONE browser (PHASE 6.2.3): the DISTINCT stake values (rs[].b) in this
  // browser's authoritative channel list for this zone/game. Server-sourced — never hard-coded, never a
  // fallback list. Empty until the channel list (CMD 300) has arrived for this browser.
  _betOptionsFor(rec) {
    const seen = new Set();
    let chans = []; try { chans = rec.ctx.channels() || []; } catch { chans = []; }
    for (const c of chans) { if ((c.zn != null && c.zn !== ZONE) || (c.gid != null && c.gid !== GID)) continue; const b = Number(c.b); if (Number.isFinite(b) && b > 0) seen.add(b); }
    return [...seen].sort((a, b) => a - b);
  }

  // Pick a QUALIFYING EMPTY table from this browser's authoritative channel list (server rs[]) via the pure
  // qualifier (table-qualify.cjs): right zone/game, MATCHING selected stake, a REAL table (uC <= Mu), and
  // >= `need` (default 3) FREE seats so B1+B2+B3 can all JOIN. Prefers the emptiest. Logs each reject (esp.
  // NOT_ENOUGH_FREE_SLOTS) for diagnosis (§B5). Qualification happens BEFORE any JOIN (§B6). Returns null
  // when nothing qualifies. The rid + stake come from the table itself — never invented.
  _pickManualCandidate(rec, need, selectedStake) {
    let chans = []; try { chans = rec.ctx.channels() || []; } catch { chans = []; }
    const { candidate, rejects } = pickQualifiedCandidate(chans, {
      need, selectedStake, zone: ZONE, gid: GID, isFailedRid: (rid) => this._failedRids.has(rid),
    });
    for (const r of rejects) {
      // Surface WHY a table was skipped (never a secret). The free-slots shortfall is the key new rule.
      if (r.reason === 'NOT_ENOUGH_FREE_SLOTS') this._mark('TABLE_REJECT', { id: rec.id, rid: r.rid, stake: r.stake, uC: r.uC, Mu: r.Mu, freeSlots: r.freeSlots, reason: r.reason });
    }
    return candidate;
  }

  // REAL table discovery for ONE browser (PHASE 6.2.1): request the authoritative channel list (CMD 300),
  // pick a qualifying EMPTY table, JOIN its real RID, and confirm from ps[]. The RID and STAKE both come
  // from the SELECTED SERVER TABLE — never invented, never user-entered. Reuses the production channel-list
  // request + the qualification concept + the tested manualJoinRoom (own uid in own ps[]) for the join.
  async manualDiscoverTable(profileId, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    const ctx = rec.ctx.sendContext();
    if (!ctx) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'browser has no game socket yet' } }; }
    // §5/§6/§14 — the finder chooses a REAL stake from the server bet options; discovery filters by it.
    const selectedStake = opts.selectedStake != null ? Number(opts.selectedStake) : null;
    if (selectedStake == null || !Number.isFinite(selectedStake)) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_NO_STAKE_SELECTED', message: 'Chọn mức cược trước khi tìm bàn' } }; }
    const need = opts.need != null ? opts.need : DISCOVER_FREE_SLOTS; // §21 — BEFORE join: fit P1+P2+P3 (>=3)
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 8000;
    const maxRecovery = opts.maxRecovery != null ? opts.maxRecovery : MAX_ANCHOR_RECOVERY; // §8 bounded re-FIND
    // PHASE 6.3.4 §7/§23/§24 — SINGLE-FLIGHT: a duplicate FIND while one is already in flight for THIS browser
    // is ignored (never a second CMD 300 per rapid click). The header/renderer disable the button too; this
    // is defence-in-depth for the coordinator regardless of caller.
    if (rec._discovering) { this._findLog('FX_DUPLICATE_IGNORED', rec, rec._manualGen); return { ok: false, id: rec.id, busy: true, state: 'SEARCHING', error: { code: 'PHOM_FIND_IN_FLIGHT', message: 'đang tìm bàn' } }; }
    rec._discovering = true;
    let myGen = (rec._manualGen = (rec._manualGen || 0) + 1); // §8 — find generation / cancellation token
    const t0 = this._mono();
    rec.manualState = 'SEARCHING'; rec.lastError = null;
    this._findLog('F0_FIND_START', rec, myGen, { selectedStake, need });
    this._mark('M_DISCOVER_SENT', { id: rec.id, selectedStake });
    this.emit('update', this.snapshot());
    try {
      // §8 — BOUNDED re-anchor loop (never a while(true)). Each pass: (re)acquire a qualifying table, JOIN,
      // confirm from ps[], then PROACTIVELY verify the room STILL fits both followers before publishing (§4/§6).
      for (let recovery = 0; recovery <= maxRecovery; recovery++) {
        // §10/§11/§12 — REUSE the fresh cached rs[] on the FIRST pass; on a RECOVERY pass force a fresh CMD 300
        // (the just-invalidated room proved the cache stale, so re-request authoritative capacity — §22).
        let candidate = recovery === 0 ? this._pickManualCandidate(rec, need, selectedStake) : null;
        if (candidate) {
          this._findLog('F3_TABLE_LIST_READY', rec, myGen, { reused: true });
        } else {
          const aid = rec.ctx.aid();
          if (aid != null) { try { await rec.send(buildChannelListFrame(aid), ctx); this._findLog('F1_CMD300_REQUEST', rec, myGen, { recovery }); } catch { /* best effort */ } }
          // Wait (event-driven) for a qualifying empty table AT THE SELECTED STAKE to appear (§9/§30 — no polling).
          await this._waitManual(() => { candidate = this._pickManualCandidate(rec, need, selectedStake); return !!candidate; }, rec, myGen, timeoutMs);
          if (candidate) this._findLog('F3_TABLE_LIST_READY', rec, myGen, { reused: false });
        }
        // §8 — a stale FIND (superseded by a newer op / leave / stop) must NOT proceed to JOIN.
        if (rec._manualGen !== myGen) { this._findLog('FX_FIND_CANCELLED', rec, myGen); return { ok: false, id: rec.id, result: 'STALE' }; }
        if (this._stopped) { rec.manualState = 'LEFT'; this._findLog('FX_SESSION_DEAD', rec, myGen); return { ok: false, id: rec.id, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } }; }
        // §7/§21 — no auto-switch to another stake: fail typed and let the user pick a different stake.
        if (!candidate) { rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_NO_EMPTY_TABLE', message: `Không tìm thấy bàn trống với mức cược ${selectedStake}` }; this._findLog('FX_NO_TABLE', rec, myGen); this.emit('update', this.snapshot()); return { ok: false, id: rec.id, error: rec.lastError, selectedStake }; }
        this._findLog('F5_CANDIDATE_QUALIFIED', rec, myGen, { rid: candidate.rid, stake: candidate.b, freeSlots: Number(candidate.Mu) - Number(candidate.uC) });
        this._mark('M_TABLE_SELECTED', { id: rec.id, rid: candidate.rid, stake: candidate.b, players: `${candidate.uC}/${candidate.Mu}` });
        // JOIN the selected table's REAL rid; authoritative confirmation via own uid in own ps[] (§15/§16).
        const res = await this.manualJoinRoom(profileId, candidate.rid, { ...opts, intent: 'FIND', findGen: myGen, provisional: true });
        if (!res.ok) {
          // §14/§21 — the table changed under us (lost the slot / rejected) → typed failure, never a hang.
          this._findLog(res.state === 'JOIN_FAILED' ? 'FX_TABLE_CHANGED' : 'FX_JOIN_REJECTED', rec, myGen, { rid: candidate.rid });
          return { ...res, stake: candidate.b, playerCount: candidate.uC };
        }
        // §4/§5/§19/§20 — POST-ANCHOR CAPACITY CHECK from AUTHORITATIVE state: Mu (the table's fixed capacity)
        // minus the LIVE ps[] occupancy. P1 already holds a seat, so it must still leave >= 2 for P2 + P3.
        const ts = rec.ctx.tableState();
        const occupancy = ts ? ts.playerCount : null;
        const freeAfter = (occupancy != null && Number.isFinite(Number(candidate.Mu))) ? Number(candidate.Mu) - occupancy : null;
        this._findLog('F11_ANCHOR_CAPACITY_CHECK', rec, myGen, { rid: res.rid, Mu: candidate.Mu, uC: occupancy, freeAfter, need: POST_ANCHOR_FREE_SLOTS });
        if (freeAfter != null && freeAfter >= POST_ANCHOR_FREE_SLOTS) {
          rec._joinedRidValidated = true; // §6/§7 — now the anchor may be published to followers
          this._findLog('F12_ANCHOR_VALID', rec, myGen, { rid: res.rid, freeAfter });
          this._findLog('F10_FIND_SUCCESS', rec, myGen, { rid: res.rid, totalMs: Math.round((this._mono() - t0) * 1000) / 1000 });
          this.emit('update', this.snapshot());
          return { ...res, state: 'FOUND', roomAnchor: res.rid, stake: candidate.b, playerCountBefore: candidate.uC, freeAfter, anchorValid: true };
        }
        // §7 — ANCHOR INVALID: do NOT publish this RID. Blacklist it, LEAVE it, and (if attempts remain) re-FIND.
        this._findLog('F13_ANCHOR_INVALID', rec, myGen, { rid: res.rid, freeAfter, need: POST_ANCHOR_FREE_SLOTS });
        this._failedRids.add(candidate.rid); if (this._failedRids.size > 32) this._failedRids.delete(this._failedRids.values().next().value);
        try { await rec.send(buildLeaveFrame(), ctx); } catch { /* best effort */ }
        rec.ctx.leaveTable(); rec.confirmedInTable = false; rec._joinedRid = null; rec.state = PSTATE.IDLE;
        // §9/§18 — a NEW generation makes the just-left RID's callbacks stale: an old-RID result can never
        // overwrite the new anchor, and any follower still on the old RID is cancelled by the anchor change.
        myGen = (rec._manualGen = (rec._manualGen || 0) + 1);
        rec.manualState = 'SEARCHING';
        this.emit('update', this.snapshot());
        if (recovery < maxRecovery) this._findLog('F14_REANCHOR_START', rec, myGen, { attempt: recovery + 1 });
      }
      // §31 — bounded recovery exhausted: stop (never an infinite re-FIND). The user can retry (TÌM LẠI).
      rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_FIND_RESILIENCE_EXHAUSTED', message: 'Không tìm được bàn còn đủ chỗ cho 3 người' };
      this._findLog('FX_RESILIENCE_EXHAUSTED', rec, myGen, { attempts: maxRecovery + 1 });
      this.emit('update', this.snapshot());
      return { ok: false, id: rec.id, error: rec.lastError, resilienceExhausted: true };
    } finally { rec._discovering = false; }
  }

  // PHASE 6.3.6 — the FINDER/room anchor is the USER-selected profile when set; only when NO finder has been
  // chosen does it fall back to the first profile (unchanged 6.3.5 default), so existing single-finder flows
  // behave identically. Followers read the anchor's OWN _joinedRid / uid from authoritative state (§7 same-room
  // proof) — never a cached/UI value. Set/clear via setFinder (user choice); the finder itself NEVER discovers
  // on behalf of another browser and a follower NEVER becomes a finder (manualJoinShared, unchanged).
  setFinder(profileId) {
    if (profileId == null) { this._finderId = null; return { ok: true, finderId: null }; }
    const id = String(profileId);
    if (!this._profiles.has(id)) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: 'unknown finder profile' } };
    this._finderId = id; return { ok: true, finderId: id };
  }
  finderId() { return this._finderId; }
  // True when THIS profile is allowed to FIND: no finder chosen yet (every browser may FIND) OR it IS the finder.
  isFinder(profileId) { return this._finderId == null ? true : String(profileId) === this._finderId; }
  _anchor() {
    if (this._finderId && this._profiles.has(this._finderId)) return this._profiles.get(this._finderId);
    const it = this._profiles.values().next(); return it && !it.done ? it.value : null;
  }
  _anchorRid() { const a = this._anchor(); return a && a._joinedRid != null ? a._joinedRid : null; }
  _anchorUid() { const a = this._anchor(); return a ? a.ctx.uid() : null; }
  // Which follower-JOIN failures are worth a same-RID retry (§12). A transient room race / not-yet-confirmed
  // membership is retryable; a dead/cancelled/invalid situation is NOT (retrying it is pointless).
  _isRetryableJoin(res) {
    if (!res || res.ok) return false;
    if (res.superseded || res.ridChanged) return false; // a newer op / anchor change already owns the flow
    const code = res.error && res.error.code;
    if (res.state === 'JOIN_FAILED' || res.state === 'ROOM_MISMATCH') return true;
    if (code === 'PHOM_JOIN_NOT_CONFIRMED' || code === 'PHOM_FOLLOWER_ROOM_MISMATCH') return true;
    return false; // PHOM_INVALID_RID / PHOM_SOCKET_NOT_FOUND / PHOM_OPERATION_CANCELLED / PROFILE_NOT_READY
  }

  // FOLLOWER JOIN of the shared anchor RID with BOUNDED, generation-safe, single-flight same-RID retry (§10/
  // §11/§13/§14/§15/§16/§25). A follower NEVER discovers. Success requires own uid ∈ ps[] AND the anchor's uid
  // present in the SAME authoritative TABLE_STATE (real same-room proof). Retry is cancelled when the session
  // dies, the browser is superseded, or the anchor RID changes (P1 re-anchored) — no second finder, no loop.
  async manualJoinShared(profileId, rid, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    const r = Number.isFinite(rid) ? rid : (rid != null && String(rid).trim() !== '' ? Number(rid) : NaN);
    if (!Number.isFinite(r)) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_INVALID_RID', message: 'Room/RID trống hoặc không hợp lệ' } }; }
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : MAX_SHARED_RID_JOIN_RETRIES;
    // §25 — SINGLE-FLIGHT: a duplicate JOIN of the SAME rid while one is already retrying is ignored; a JOIN
    // of a DIFFERENT rid (anchor moved) supersedes the old loop via the generation bump below.
    if (rec._followInFlight && Number(rec._followRid) === r) { this._findLog('FX_DUPLICATE_IGNORED', rec, rec._followGen, { rid: r, follower: true }); return { ok: false, id: rec.id, busy: true, state: 'JOINING', error: { code: 'PHOM_FOLLOW_IN_FLIGHT', message: 'đang vào bàn' } }; }
    rec._followInFlight = true; rec._followRid = r;
    const myGen = (rec._followGen = (rec._followGen || 0) + 1);
    const t0 = this._mono();
    this._findLog('J0_FOLLOWER_JOIN_START', rec, myGen, { rid: r, maxRetries });
    try {
      let last = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (rec._followGen !== myGen) { this._findLog('FX_FIND_CANCELLED', rec, myGen, { rid: r, follower: true, reason: 'SUPERSEDED' }); return { ok: false, id: rec.id, superseded: true }; }
        if (this._stopped) { this._findLog('FX_SESSION_DEAD', rec, myGen, { rid: r, follower: true }); return { ok: false, id: rec.id, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } }; }
        // §17/§18 — the anchor moved to a new RID → stop retrying the dead one (no parallel old/new flows).
        const anchor = this._anchorRid();
        if (anchor != null && Number(anchor) !== r) { this._findLog('FX_TABLE_CHANGED', rec, myGen, { rid: r, anchor, follower: true }); return { ok: false, id: rec.id, ridChanged: true, error: { code: 'PHOM_SHARED_RID_CHANGED', message: 'Player 1 đã đổi bàn' } }; }
        if (attempt > 0) this._findLog('J5_RETRY', rec, myGen, { rid: r, attempt });
        last = await this.manualJoinRoom(profileId, r, { ...opts, intent: 'JOIN', followGen: myGen });
        if (last.ok) {
          // §13/§14 — SAME-ROOM PROOF from authoritative ps[]: own uid confirmed (manualJoinRoom) AND the
          // anchor (P1) uid present in the SAME table state. Otherwise it's a room mismatch → retryable.
          this._findLog('J3_UID_CONFIRMED', rec, myGen, { rid: r });
          const ts = rec.ctx.tableState();
          const anchorUid = this._anchorUid();
          const sameRoom = anchorUid == null || !!(ts && ts.uids.includes(anchorUid));
          if (sameRoom) { this._findLog('J4_SAME_ROOM_CONFIRMED', rec, myGen, { rid: r, totalMs: Math.round((this._mono() - t0) * 1000) / 1000 }); return { ...last, sameRoom: true, attempts: attempt + 1 }; }
          last = { ...last, ok: false, state: 'ROOM_MISMATCH', error: { code: 'PHOM_FOLLOWER_ROOM_MISMATCH', message: 'không cùng bàn với Player 1' } };
        }
        if (!this._isRetryableJoin(last) || attempt === maxRetries) break; // §12 — non-retryable / out of tries
      }
      // §15/§16/§31 — retry exhausted or a non-retryable error: FOLLOWER_ERROR. NEVER become a finder.
      rec.manualState = 'FOLLOWER_ERROR';
      this._findLog('J6_RETRY_EXHAUSTED', rec, myGen, { rid: r });
      this.emit('update', this.snapshot());
      return { ...(last || { ok: false, id: rec.id }), retriesExhausted: true, error: (last && last.error) || { code: 'PHOM_FOLLOWER_JOIN_FAILED', message: 'Không vào được bàn' } };
    } finally { if (rec._followGen === myGen) { rec._followInFlight = false; } }
  }

  // FIND a table on ONE browser: native JOIN by the chosen channel/stake and report the RID it landed
  // in (that browser's own _joinedRid) for the user to share. No matchmaking coupling to other browsers.
  async manualFindTable(profileId, channel, opts = {}) {
    const ch = Number.isFinite(channel) ? channel : (channel != null && String(channel).trim() !== '' ? Number(channel) : this._selectedStake);
    if (ch == null || !Number.isFinite(ch)) { const rec = this._rec(profileId); if (rec) rec.manualState = 'ERROR'; return { ok: false, error: { code: 'PHOM_NO_STAKE_SELECTED', message: 'chọn mức cược/kênh để tìm bàn' } }; }
    const res = await this.manualJoinRoom(profileId, ch, { ...opts, intent: 'FIND' });
    return res.ok ? { ...res, state: 'FOUND', roomAnchor: res.rid } : res;
  }

  // REJOIN ONE browser using ITS OWN last known RID (never a fresh find, never a new room).
  async manualRejoin(profileId, opts = {}) {
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    const rid = rec._joinedRid != null ? rec._joinedRid : rec._lastRid; // survives an intentional LEAVE
    if (rid == null) return { ok: false, id: rec.id, error: { code: 'PHOM_REJOIN_NO_RID', message: 'Chưa có Room/RID để Rejoin' } };
    return this.manualJoinRoom(profileId, rid, { ...opts, intent: 'REJOIN' });
  }

  // LEAVE ONE browser only (never leave-all). Sends the native LEAVE and clears that browser's table.
  async manualLeave(profileId) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    rec._manualGen = (rec._manualGen || 0) + 1; rec._discovering = false; rec._followGen = (rec._followGen || 0) + 1; rec._followInFlight = false; // §8/§17 cancel in-flight find/join/retry
    rec.manualState = 'LEAVING';
    this.emit('update', this.snapshot());
    let ok = true; try { await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); } catch { ok = false; }
    rec.ctx.leaveTable(); rec.confirmedInTable = false; rec._joinedRid = null; rec._joinedRidValidated = false; rec.state = PSTATE.LEFT; rec.manualState = 'LEFT';
    this._mark('M_LEAVE_SENT', { id: rec.id });
    this.emit('update', this.snapshot());
    return { ok, id: rec.id, state: 'LEFT' };
  }

  // PHASE 6.2.3-fix — reset ONE browser's Phỏm context after a web reload (↻ WEB). The reloaded page has
  // left the Phỏm game, so its socket/channels/table are gone; clearing them makes slotInPhom correctly
  // go false → the UI shows VÀO GAME again until the user re-enters. Only this browser is affected; the
  // channel list + socket are rebound from the new page's own frames on re-entry. Cancels any in-flight
  // manual op for this browser. Never touches the other browsers.
  resetBrowser(profileId) {
    const rec = this._rec(profileId);
    if (!rec) return false;
    rec._manualGen = (rec._manualGen || 0) + 1; // supersede any pending find/join for this browser
    rec._discovering = false;                    // PHASE 6.3.4 — release the FIND single-flight on ↻ WEB reset
    rec._followGen = (rec._followGen || 0) + 1; rec._followInFlight = false; // PHASE 6.3.5 — cancel follower retry
    try { rec.ctx.reset(); } catch { /* best effort */ }
    rec.confirmedInTable = false; rec._joinedRid = null; rec._joinedRidValidated = false; rec.missingStreak = 0; rec.lastError = null;
    rec.state = PSTATE.IDLE; rec.manualState = 'READY';
    this._mark('M_WEB_RELOAD_RESET', { id: rec.id });
    this._evaluate();
    this.emit('update', this.snapshot());
    this.emit('hands', this.handsSnapshot());
    return true;
  }

  // Per-browser INDEPENDENT state for the manual UI (no host/follower; stable Browser 1/2/3 order).
  manualBrowserSnapshot() {
    const recs = [...this._profiles.values()];
    return recs.map((rec, i) => {
      const c = rec.ctx.get();
      const ts = rec.ctx.tableState();
      return {
        browserIndex: i + 1, profileId: rec.id, displayName: rec.displayName,
        // PHASE 6.3.6 — FIND gating is the USER's finder choice, never browserIndex. isFinder is true for EVERY
        // browser until a finder is chosen; then only the chosen profile is finder (others show WAIT_ANCHOR).
        isFinder: this._finderId == null ? true : (rec.id === this._finderId),
        isSelectedFinder: this._finderId != null && rec.id === this._finderId,
        username: this._username(rec) || 'USER_UNKNOWN',
        connected: c.connected, socketReady: c.socketReady,
        // channelCount > 0 == this browser received the Phỏm stake list, i.e. it is in the Phỏm lobby
        // (mirrors snapshot().channelCount). The header uses it to decide "inGame" (§6.3.2).
        channelCount: Array.isArray(c.channels) ? c.channels.length : 0,
        rid: rec._joinedRid != null ? rec._joinedRid : null,
        lastRid: rec._lastRid != null ? rec._lastRid : null,
        // PHASE 6.3.5 §7 — a discover anchor is published to followers ONLY after its post-anchor capacity
        // check passes. A provisional (mid-check) FIND join reports anchorValid=false so headerSharedRid
        // never publishes an unverified RID. Non-discover joins are valid immediately.
        anchorValid: rec._joinedRidValidated !== false,
        // §3/§4 — REAL bet options for THIS browser (distinct server stakes from its channel list). Empty
        // until it has entered the game + received the channel list; scoped per browser (not the cluster).
        betOptions: this._betOptionsFor(rec),
        canRejoin: (rec._joinedRid != null || rec._lastRid != null),
        manualState: rec.manualState || (c.socketReady && c.connected ? 'READY' : 'CLOSED'),
        seat: c.seat, uid: shortUid(c.uid),
        membership: ts ? ts.uids.map(shortUid) : [],
        playerCount: ts ? ts.playerCount : 0,
        lastError: rec.lastError || null,
      };
    });
  }

  // Screen 2 — cards REMAINING after removing every card held by the three browsers (NOT player 4).
  remainingCards(opts = {}) {
    const hands = [...this._profiles.values()].map((rec) => (rec.hand && Array.isArray(rec.hand.cardsRaw) ? rec.hand.cardsRaw : []));
    return remainingCardsView(hands, opts);
  }

  // ---- Phase-3B FINAL: host-first discovery / validation / restart ----
  _log(event, data = {}) { this.emit('log', { tag: 'PHOM-3B', event, at: this._now(), ...data }); }

  // PHASE 6.3.4 §27/§28 — FIND trace + latency, gated behind PHOM_FIND_LOG=1 (zero overhead when off). Every
  // milestone carries runId + slotId + findGen so overlapping FIND operations can never be confused. Also
  // emitted on the existing 'log' stream so it reaches phom:log.
  _slotOf(rec) { const i = [...this._profiles.keys()].indexOf(rec ? rec.id : null); return i >= 0 ? 'B' + (i + 1) : null; }
  _findLog(event, rec, findGen, data = {}) {
    if (process.env.PHOM_FIND_LOG !== '1') return;
    const entry = { tag: 'PHOM-FIND', event, runId: rec ? rec.id : null, slotId: this._slotOf(rec), findGen: findGen != null ? findGen : null, mono: Math.round(this._mono() * 1000) / 1000, at: this._now(), ...data };
    try { console.log(`[PHOM-FIND] ${event}`, JSON.stringify(entry)); } catch { /* best effort */ }
    this.emit('log', entry);
  }

  // ---- PHASE-2 instrumentation ----
  // Push one milestone onto the bounded monotonic timeline (and emit it on the existing log stream
  // so it also reaches phom:log). `milestone` is a stable T-name (see trace() consumers).
  _mark(milestone, extra = {}) {
    const rid = this._hostTableIdentity && this._hostTableIdentity.channelRid != null ? this._hostTableIdentity.channelRid : (this.host() && this.host()._joinedRid != null ? this.host()._joinedRid : null);
    const entry = { milestone, mono: Math.round(this._mono() * 1000) / 1000, at: this._now(), gen: this._gen, state: this._state, roomId: rid, ...extra };
    this._trace.push(entry);
    if (this._trace.length > this._traceCap) this._trace.splice(0, this._trace.length - this._traceCap);
    this.emit('log', { tag: 'PHOM-TRACE', event: milestone, ...entry });
    return entry;
  }
  // Emit a milestone at most once per discovery generation (idempotent stage markers).
  _markOnce(key, milestone, extra) { const tag = `${this._gen}:${key}`; if (this._markedThisGen.has(tag)) return; this._markedThisGen.add(tag); this._mark(milestone, extra); }
  // The recent milestone timeline (copy). Consumers compute latency deltas between named milestones.
  trace() { return this._trace.map((e) => ({ ...e })); }

  // Event-driven wait: resolve as soon as `pred()` is true, waking on the coordinator's OWN authoritative
  // 'update' (emitted on every ingest/evaluate) instead of a fixed polling tick — so a stage advances the
  // instant the server evidence (ps[]) arrives, not up to a poll interval later. This removes latency WITHOUT
  // adding polling or artificial delay. Generation/stop aware; a bounded timeout is the only fallback.
  _waitUntil(pred, gen, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => { if (done) return; done = true; this.off('update', onUpdate); clearTimeout(timer); };
      const settle = (v) => { cleanup(); resolve(v); };
      const check = () => {
        if (this._gen !== gen || this._stopped) { settle(false); return true; }
        let ok = false; try { ok = !!pred(); } catch { ok = false; }
        if (ok) { settle(true); return true; }
        return false;
      };
      const onUpdate = () => { check(); };
      const timer = setTimeout(() => { let ok = false; try { ok = !!pred(); } catch { ok = false; } settle(ok && this._gen === gen && !this._stopped); }, timeoutMs);
      if (check()) return;           // already satisfied synchronously (e.g. evidence arrived before the wait)
      this.on('update', onUpdate);   // otherwise wake on the next authoritative snapshot
    });
  }
  // Two different uids occupying the same seat index within ONE authoritative table state.
  _duplicateSeat(ts) { const sits = (ts.seats || []).map((s) => s.sit).filter((s) => s != null); return new Set(sits).size !== sits.length; }

  // §5/§6 — validate the host's candidate from AUTHORITATIVE ps[] only (never JOIN ACK / rs[].uC).
  // Valid iff: A appears in ps[], AND the table can still seat the controlled group A+B+C, i.e. the
  // number of free seats is enough for the controlled followers not yet seated.
  validateHostCandidate() {
    const host = this.host();
    const ts = host && host.ctx.tableState();
    if (!ts) return { valid: false, reason: 'NO_TABLE_STATE' };            // not yet authoritative
    const hostUid = host.ctx.uid();
    if (!hostUid) return { valid: false, reason: 'HOST_UID_UNKNOWN' };
    // ACK != membership. If A is not in ps[] AND the table is already FULL, A can never be seated here
    // (the live 139 stale-uC race) -> decisively invalid, abandon at once. If the table still has room,
    // A's own seating frame may just be in flight -> keep waiting (HOST_NOT_IN_PS is non-decisive).
    if (!ts.uids.includes(hostUid)) return { valid: false, reason: ts.playerCount >= this._capacity ? 'TABLE_FULL_NO_HOST_SEAT' : 'HOST_NOT_IN_PS' };
    if (this._duplicateSeat(ts)) return { valid: false, reason: 'SEAT_CONFLICT' };
    const controlled = new Set(this._controlledUids());
    const controlledSeated = ts.uids.filter((u) => controlled.has(u)).length;
    const needSeats = 3 - controlledSeated;                                // seats still needed for B/C
    const freeSeats = this._capacity - ts.playerCount;
    if (freeSeats < needSeats) return { valid: false, reason: 'INSUFFICIENT_CAPACITY', freeSeats, needSeats };
    const outsiders = ts.uids.filter((u) => !controlled.has(u));
    return { valid: true, freeSeats, outsiders };
  }

  // §12/§14 — reconcile a table that WAS seated: SAME_TABLE holds; else a missing controlled follower
  // that the (still-valid, host-present) table can re-seat -> C_REJOIN; otherwise -> INVALID (all leave).
  reconcileSeated() {
    const v = this.verifySameTable();
    if (v.result === 'SAME_TABLE') return { verdict: 'SAME_TABLE' };
    const host = this.host();
    const ts = host && host.ctx.tableState();
    const hostUid = host && host.ctx.uid();
    if (!ts || !hostUid || !ts.uids.includes(hostUid)) return { verdict: 'INVALID', reason: 'HOST_LOST_OR_NO_STATE' };
    const controlled = new Set(this._controlledUids());
    const missing = [...controlled].filter((u) => u !== hostUid && !ts.uids.includes(u));
    const freeSeats = this._capacity - ts.playerCount;
    if (this._duplicateSeat(ts)) return { verdict: 'INVALID', reason: 'SEAT_CONFLICT' };
    if (missing.length >= 1 && freeSeats >= missing.length) return { verdict: 'C_REJOIN', missing };
    return { verdict: 'INVALID', reason: 'CANNOT_RESEAT_CONTROLLED' };
  }

  async _leaveHost() {
    const host = this.host();
    if (!host) return;
    this._setState(SESSION.LEAVING_TABLE);
    if (host._joinedRid != null) { this._failedRids.add(host._joinedRid); if (this._failedRids.size > 32) this._failedRids.delete(this._failedRids.values().next().value); }
    // Leave the TABLE but keep the live socket/aid so the very next acquireHost can send again
    // (ctx.reset() would drop the socket -> PHOM_PROTOCOL_CONTEXT_MISSING on the retry, observed live).
    host.state = PSTATE.LEFT; host.confirmedInTable = false; host._joinedRid = null; host.ctx.leaveTable();
    try { await host.send(buildLeaveFrame(), host.ctx.sendContext()); } catch { /* best effort */ }
  }

  // §22 — SINGLE orchestrator. Increments the generation token; any in-flight loop from a prior
  // generation becomes a no-op. §18 — the host-first find-again loop.
  async runDiscovery() {
    if (!this._guard()) return this._unauthorized();
    if (this._running) { this._log('DISCOVERY_ALREADY_RUNNING'); return { ok: true, already: true, gen: this._gen }; }
    const gen = ++this._gen;
    this._running = true; this._hostSearchAttempts = 0; this._failedRids.clear();
    this._markedThisGen.clear(); this._mark('T0_DISCOVERY_START');
    const stale = () => this._gen !== gen || this._stopped;
    try {
      while (!stale()) {
        this._setState(SESSION.HOST_SEARCHING); this._log('HOST_SEARCH', { attempt: this._hostSearchAttempts });
        const acq = await this.acquireHost();
        if (stale()) break;
        if (!acq.ok) {
          if (++this._hostSearchAttempts >= this._maxHostSearch) { this._setState(SESSION.HOST_ACQUIRE_FAILED); this._log('HOST_SEARCH_EXHAUSTED', {}); return { ok: false, error: acq.error }; }
          await this._delay(this._discoverBackoffMs); continue;
        }
        this._log('CANDIDATE_SELECTED', { rid: acq.candidate && acq.candidate.rid, b: acq.candidate && acq.candidate.b });
        this._setState(SESSION.HOST_VALIDATING); this._log('HOST_JOIN_SENT', {});
        const val = await this._awaitHostValidation(gen);
        if (stale()) break;
        if (!val.valid) {
          this._log('CANDIDATE_INVALID', { reason: val.reason });
          await this._leaveHost();
          this._setState(SESSION.RESTART_SEARCH);
          if (++this._hostSearchAttempts >= this._maxHostSearch) { this._setState(SESSION.HOST_ACQUIRE_FAILED); return { ok: false, error: { code: 'PHOM_HOST_SEARCH_EXHAUSTED' } }; }
          await this._delay(this._discoverBackoffMs); continue;
        }
        this._candidateValid = true; this._setState(SESSION.HOST_CANDIDATE_VALID); this._log('HOST_MEMBERSHIP_CONFIRMED', {}); this._log('CANDIDATE_VALID', { freeSeats: val.freeSeats });
        // After A is valid, B and C join A's table TOGETHER, then reconcile against A's authoritative
        // ps[]: all three present => SAME_TABLE; one missing but a seat is free => rejoin it; A + one
        // follower with the table full (no slot for the third) => INVALID (all leave + A searches
        // again). Goal is strictly all three on one table.
        const followed = await this._followTogether(gen);
        if (stale()) break;
        const same = followed && await this._awaitSameTable(gen);
        if (stale()) break;
        if (same) { this._setState(SESSION.SAME_TABLE); this._log('SAME_TABLE', this._sameTableEvidence()); await this.applyReady(); this._setState(SESSION.MONITORING); this._log('READY_POLICY', { policy: this._readyPolicySummary() }); return { ok: true, sameTable: true }; }
        const rec = this.reconcileSeated();
        if (rec.verdict === 'INVALID') { this._log('TABLE_INVALIDATED', { reason: rec.reason }); await this.leaveAll(); this._setState(SESSION.RESTART_SEARCH); this._log('RESTART_SEARCH'); await this._delay(this._discoverBackoffMs); continue; }
        // else partial/other -> loop re-evaluates
        await this._delay(this._discoverBackoffMs);
      }
      return { ok: !this._stopped, stale: this._gen !== gen };
    } finally { if (this._gen === gen) this._running = false; }
  }

  async _awaitHostValidation(gen, timeoutMs = 8000) {
    // Wake the instant the authoritative ps[] resolves the candidate (valid OR decisively invalid),
    // never a fixed 200ms tick. Same verdict semantics as before; only the latency changes.
    let verdict = null;
    await this._waitUntil(() => {
      const v = this.validateHostCandidate();
      if (v.valid) { verdict = v; return true; }
      if (v.reason && v.reason !== 'NO_TABLE_STATE' && v.reason !== 'HOST_UID_UNKNOWN' && v.reason !== 'HOST_NOT_IN_PS') { verdict = v; return true; } // decisively invalid
      return false;
    }, gen, timeoutMs);
    if (verdict) { if (verdict.valid) this._markOnce('host-confirmed', 'T6_HOST_CONFIRMED_IN_PS'); return verdict; }
    const v = this.validateHostCandidate();
    if (v.valid) this._markOnce('host-confirmed', 'T6_HOST_CONFIRMED_IN_PS');
    return v.valid ? v : { valid: false, reason: v.reason || 'HOST_VALIDATION_TIMEOUT' };
  }

  // Bring B and C to the host's table TOGETHER (each on its own socket), then reconcile from the
  // host's authoritative ps[]. Goal: all three on one table. Outcomes:
  //   SAME_TABLE           -> success
  //   one missing + a seat free -> rejoin only the missing follower
  //   A + one follower, table FULL (no room for the third) -> abort (caller leaves ALL + A retries)
  async _followTogether(gen) {
    const host = this.host(); const rid = host && host._joinedRid;
    if (rid == null) return false;
    this._setState(SESSION.FOLLOWERS_JOINING); this._log('FOLLOWER_B_JOIN'); this._log('FOLLOWER_C_JOIN');
    const joinOne = async (rec) => {
      if (rec.confirmedInTable && this._followerAtHostTable(rec)) return;
      rec.leaving = true; rec.state = PSTATE.JOINING;
      try { await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); } catch { /* best effort */ }
      rec.leaving = false;
      try { await rec.send(buildJoinFrame(rid), rec.ctx.sendContext()); } catch (e) { rec.state = PSTATE.ERROR; rec.lastError = { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) }; }
      rec._joinedRid = rid;
    };
    await Promise.all(this.followers().map(joinOne)); // B and C join ONCE, simultaneously
    this._markOnce('followers-join-sent', 'T8_FOLLOWER_JOIN_SENT', { rid });
    // Then just WAIT for the authoritative outcome — do NOT re-issue joins in a tight loop (that
    // floods the server with join/leave churn). Per-browser TABLE_STATE frames arrive out of order,
    // so require INVALID to PERSIST across a few consecutive reads before bailing (avoids a false
    // restart on a transient/stale read — the "desync" case). On timeout / persistent INVALID the
    // discovery loop leaves-all + restarts (bounded, spaced).
    const t0 = this._now(); let invalidStreak = 0;
    while (this._gen === gen && !this._stopped && this._now() - t0 < 10000) {
      if (this.verifySameTable().result === 'SAME_TABLE') return true;
      if (this.reconcileSeated().verdict === 'INVALID') { if (++invalidStreak >= 3) return false; } else invalidStreak = 0;
      await this._delay(500);
    }
    return this.verifySameTable().result === 'SAME_TABLE';
  }

  // §4 — bring followers to the host's table ONE AT A TIME (B then C), each confirmed present in the
  // host's authoritative ps[] before the next joins; re-validate capacity after every seat so an
  // outsider that fills the table mid-sequence aborts cleanly (caller then leaves all + restarts).
  async _followSequential(gen) {
    const host = this.host(); const rid = host && host._joinedRid;
    if (rid == null) return false;
    this._setState(SESSION.FOLLOWERS_JOINING);
    for (const rec of this.followers()) { // followerIndex order: B (0) then C (1)
      if (this._gen !== gen || this._stopped) return false;
      this._log(rec.followerIndex === 0 ? 'FOLLOWER_B_JOIN' : 'FOLLOWER_C_JOIN', { id: rec.id });
      if (!(rec.confirmedInTable && this._followerAtHostTable(rec))) {
        rec.leaving = true; rec.state = PSTATE.JOINING;
        try { await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); } catch { /* best effort */ }
        rec.leaving = false;
        try { await rec.send(buildJoinFrame(rid), rec.ctx.sendContext()); } catch (e) { rec.state = PSTATE.ERROR; rec.lastError = { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) }; }
        rec._joinedRid = rid;
      }
      const seated = await this._awaitFollowerSeated(rec, gen);
      if (this._gen !== gen || this._stopped) return false;
      if (!seated) return false;                          // this follower could not be seated
      if (this.reconcileSeated().verdict === 'INVALID') return false; // outsider filled it mid-sequence
    }
    return true;
  }

  async _awaitFollowerSeated(rec, gen, timeoutMs = 8000) {
    const host = this.host();
    const present = () => { const uid = rec.ctx.uid(); const hts = host && host.ctx.tableState(); return !!(uid && hts && hts.uids.includes(uid)); };
    await this._waitUntil(present, gen, timeoutMs);
    return present();
  }

  async _awaitSameTable(gen, timeoutMs = 8000) {
    await this._waitUntil(() => this.verifySameTable().result === 'SAME_TABLE', gen, timeoutMs);
    const same = this.verifySameTable().result === 'SAME_TABLE';
    if (same) this._markOnce('same-table', 'T10_SAME_TABLE_CONFIRMED');
    return same;
  }

  _sameTableEvidence() {
    const v = this.verifySameTable();
    const host = this.host(); const ts = host && host.ctx.tableState();
    return { stake: ts ? ts.b : null, playerCount: ts ? ts.playerCount : 0, fingerprint: ts && ts.identity ? ts.identity.value : null, controlled: v.controlled ? v.controlled.map(shortUid) : [] };
  }
  _readyPolicySummary() { const rp = this.readyPolicy(); return { playerCount: rp.playerCount, waitingFourth: rp.waitingFourth }; }

  // §8/§17 — lobby reset (recovery for repeated use). Whenever ALL controlled runs are back in the
  // Phỏm LOBBY (have the channel list, no table state) and no discovery loop is running, clear any
  // stale membership/identity/PSTATE and return to a clean LOBBY_WAITING — so a fresh TÌM BÀN always
  // works, even after a previous partial/failed attempt (no sticky BÀN / MISMATCH / ĐÃ RỜI / HOST_LOST).
  _maybeLobbyReset() {
    if (this._running) return false;
    const profs = [...this._profiles.values()];
    if (!profs.length) return false;
    const allInLobby = profs.every((r) => { const g = r.ctx.get(); return g.socketReady && g.connected && Array.isArray(g.channels) && g.channels.length > 0 && !g.tableState; });
    if (!allInLobby) return false;
    const alreadyClean = (this._state === SESSION.LOBBY_WAITING || this._state === SESSION.IDLE)
      && !this._hostTableIdentity
      && profs.every((r) => r.state === PSTATE.IDLE || r.state === PSTATE.DISCONNECTED);
    if (alreadyClean) return false;
    this._hostTableIdentity = null; this._failedRids.clear();
    for (const r of profs) {
      r.confirmedInTable = false; r._joinedRid = null; r.missingStreak = 0;
      if (r.state !== PSTATE.DISCONNECTED) r.state = PSTATE.IDLE;
    }
    this._setState(SESSION.LOBBY_WAITING); this._log('LOBBY_RESET');
    return true;
  }

  // ---- evaluation / state derivation ----
  _evaluate() {
    if (this._stopped) { this.emit('update', this.snapshot()); return; }
    if (this._maybeLobbyReset()) { this.emit('update', this.snapshot()); return; }
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
        if (playerCount >= 4) { this._setState(allDesiredReady ? SESSION.READY_3_OF_3 : SESSION.TABLE_FULL); if (allDesiredReady) this._markOnce('ready-confirmed', 'T12_READY_CONFIRMED'); }
        else this._setState(SESSION.WAITING_AUTHORIZED_FOURTH);
        // mark ready states
        for (const rec of this._profiles.values()) if (rec.ctx.ready()) rec.state = PSTATE.READY;
      } else if (verdict.result === 'TABLE_MISMATCH') {
        this._setState(SESSION.TABLE_MISMATCH); this._markFollowerMismatch();
      } else if (verdict.result === 'PARTIAL_JOIN') {
        this._setState(SESSION.PARTIAL_JOIN);
      }
    }

    // §12/§13/§14 — post-seated MONITORING reconciliation (no sticky table). Once the controlled
    // group has been seated, every authoritative TABLE_STATE change is reconciled: a recoverable
    // missing follower (host still present, seat free) => C_REJOINING; an unrecoverable composition
    // => INVALID_TABLE (the owner then leaves all + restarts host search).
    if ([SESSION.MONITORING, SESSION.READY_3_OF_3, SESSION.TABLE_FULL, SESSION.WAITING_AUTHORIZED_FOURTH, SESSION.SAME_TABLE, SESSION.C_REJOINING].includes(this._state)) {
      const rc = this.reconcileSeated();
      if (rc.verdict === 'INVALID' && this._state !== SESSION.INVALID_TABLE) {
        this._setState(SESSION.INVALID_TABLE); this._log('TABLE_INVALIDATED', { reason: rc.reason }); this.emit('invalidated', { reason: rc.reason });
      } else if (rc.verdict === 'C_REJOIN' && this._state !== SESSION.C_REJOINING) {
        this._setState(SESSION.C_REJOINING); this._log('C_REJOIN_REQUIRED', { missing: (rc.missing || []).map(shortUid) }); this.emit('cRejoinRequired', { missing: rc.missing });
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
  _guard() { return this._authorizedFn() && !this._stopped; }
  _unauthorized() { if (!this._authorizedFn()) { this._setState(SESSION.UNAUTHORIZED); return { ok: false, error: { code: 'PHOM_UNAUTHORIZED_ENVIRONMENT', message: 'AUTHORIZED_ENVIRONMENT_REQUIRED' } }; } return { ok: false, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } }; }
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
        // channelCount > 0 means this run received the Phỏm stake list (CHANNEL_LIST) — i.e. it is in
        // the Phỏm LOBBY, not merely logged in at the portal (where the socket may connect early).
        channelCount: Array.isArray(c.channels) ? c.channels.length : 0,
        confirmedInTable: rec.confirmedInTable, rejoinAttempts: rec.rejoinAttempts, lastError: rec.lastError || null,
      };
    });
    const readyCount = profiles.filter((p) => p.ready).length;
    return {
      sessionId: this._sessionId, state: this._state, authorized: this._authorizedFn(), stopped: this._stopped,
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
