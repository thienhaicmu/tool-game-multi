'use strict';

const EventEmitter = require('node:events');
const { performance } = require('node:perf_hooks');
const { PhomContext } = require('./phom-context.cjs');
const { reduceHand, emptyHand, SYNC } = require('./hand-reducer.cjs');
const { ZONE, GID } = require('./phom-frame-classify.cjs');
const { buildTableReadyFrame, buildAutoReadyPrefFrame, buildCreateTableFrame, buildCreateOptionsFrame, newRoomKey, buildChannelListFrame, buildFindTableFrame, buildJoinFrame, buildReadyFrame, buildLeaveFrame } = require('./phom-wire.cjs');
const { remainingCardsView } = require('./remaining-cards.cjs');
const { createCardObserver } = require('./phom-card-observer.cjs');
const { redactDiagnostic, maskSecret } = require('./diagnostic-redaction.cjs');

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

// Retry bounds (explicit, never magic numbers scattered around).
// §key-refresh — JOIN-by-số-bàn retries (initial attempt + 6). Each attempt costs a LEAVE + an 8s join wait, and
// the key is now REFRESHED between attempts, so a high ceiling buys nothing: either a key we know works within a
// few tries, or none of them does and the retry must stop and say so.
const MAX_JOIN_BY_CODE_RETRIES = 6;
// §37 — how long THOÁT BÀN waits for the server to prove the browser is out of the table.
const LEAVE_CONFIRM_MS = 5000;
// §53 — pause between leaving a table that does not fit and joining the stake again, so the server's
// seating has settled (the Test D capture shows the game itself waits a couple of seconds between tries).
const REROLL_COOLDOWN_MS = 1500;
// §53 — after the server REFUSES a JOIN, how long to still wait for a seat: when two JOINs are in flight
// (the game client's own + ours) one reply can be a refusal while the other seats the player.
const JOIN_REJECT_GRACE_MS = 600;

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
    this._capacity = deps.tableCapacity != null ? deps.tableCapacity : 4; // Phỏm seats per table (Mu)
        this._leaveConfirmMs = deps.leaveConfirmMs != null ? Number(deps.leaveConfirmMs) : LEAVE_CONFIRM_MS; // §37
    this._rerollCooldownMs = deps.rerollCooldownMs != null ? Number(deps.rerollCooldownMs) : REROLL_COOLDOWN_MS; // §53
    this._joinRejectGraceMs = deps.joinRejectGraceMs != null ? Number(deps.joinRejectGraceMs) : JOIN_REJECT_GRACE_MS; // §53
    // §create — how long TẠO BÀN gives the game client to JOIN its new table by itself before the tool sends the JOIN.
    this._createAutoJoinMs = deps.createAutoJoinMs != null ? Number(deps.createAutoJoinMs) : 2500;
    this._createOptionsMs = deps.createOptionsMs != null ? Number(deps.createOptionsMs) : 3000; // wait for the CMD 311 reply
    this._delay = deps.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));

    this._state = SESSION.IDLE;
    this._stopped = false;
    this._roundRunning = false;
    // Table facts observed from the server: who the table host is (ps[].C / cmd 203) and who signalled READY since
    // the last deal/end. The GROUP on top of them lives in table-group.cjs.
    this._tableHostUid = null;
    this._readyUids = new Set();
    this._roomKeyResolver = null;
    this._gen = 0;                 // orchestration generation token (§22 single orchestrator)
    // §36 — true once a LEGACY HOST/FOLLOWER entry point (acquireHost / joinFollowers / runDiscovery /
    // the PHASE-3/4 experiments) has actually been started. The UI drives only the PHASE-6 manual flow,
    // so the legacy whole-cluster lobby reset must stay dormant unless the legacy flow is really in use.
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
    if (cls && cls.type === 'DEAL') { this._roundRunning = true; this._readyUids.clear(); this._setState(SESSION.ROUND_RUNNING); this._mark('ROUND_DEAL'); }
    if (cls && cls.type === 'ROUND_END') { this._roundRunning = false; this._readyUids.clear(); this._setState(SESSION.ROUND_ENDED); this._mark('ROUND_END'); }
    if (cls && cls.type === 'USER_READY') this._readyUids.add(cls.uid);
    if (cls && cls.type === 'HOST_CHANGED') this._tableHostUid = cls.uid;
    // The server removed this browser from the table (LEAVE ack code 2, e.g. "Bạn thoát vì không bắt đầu"). What to
    // do about it is a GROUP decision (table-group.cjs) — here it is only observed and announced.
    if (cls && cls.type === 'LEAVE_ACK' && cls.accepted === true && cls.resultCode === 2 && meta.direction !== 'send') {
      rec._joinedRid = null; rec._joinedRidValidated = false; rec.confirmedInTable = false;
      rec.manualState = 'KICKED'; rec.lastError = { code: 'PHOM_KICKED', message: cls.resultMessage || 'Bị máy chủ đưa ra khỏi bàn' };
      this.emit('kicked', { id: rec.id, message: cls.resultMessage || null });
    }
    if (cls && cls.type === 'TABLE_STATE') {
      const ts = rec.ctx.tableState();
      const h = ts && ts.seats.find((s) => s.host);
      if (h && h.uid) this._tableHostUid = h.uid;
      if (ts) for (const s of ts.seats) if (s.ready && s.uid) this._readyUids.add(s.uid);
    }
    // ALWAYS-ON co-seat wire evidence (JOIN response + resulting table): so "who landed where" can be read from a
    // file without the Test D recorder. The JOIN request side is logged in manualJoinRoom (M_JOIN_SENT below).
    if (cls && cls.type === 'JOIN_ACCEPTED') this._coseatLog('JOIN_ACK', rec, { accepted: cls.accepted === true, code: cls.resultCode != null ? cls.resultCode : null, msg: cls.resultMessage || null });
    // CHANNELS — the FULL server room list (rs[]), every entry's rid + occupancy + hpwd (the key, kept verbatim
    // whether string or bool). This is where a real TABLE (7-digit rid) + its join key would appear if the server
    // lists it — the thing the "SS / Dò Key" of the reference tool reads. Logged untruncated (only needed fields).
    if (cls && cls.type === 'CHANNEL_LIST' && Array.isArray(cls.rs)) {
      this._coseatLog('CHANNELS', rec, { n: cls.rs.length, rooms: cls.rs.map((r) => ({ rid: r.rid, b: r.b, uC: r.uC, Mu: r.Mu, hpwd: r.hpwd, rn: r.rn, inc: r.inc })) });
    }
    // FULL SOCKET CAPTURE — EVERY frame, BOTH directions (dir:req = client→server request, dir:res = server→client
    // response), untruncated up to a generous cap. Nothing is filtered except pure heartbeats (`2` / op-7) and the
    // millicast/WebRTC video SDP (huge + irrelevant). Binary frames (BINB64:) are decoded → hex + printable ascii.
    // This is the complete request/response evidence so the số bàn / key can be found wherever it actually is.
    if (meta.raw != null) {
      const s = String(meta.raw);
      const dir = meta.direction === 'send' ? 'req' : 'res';
      if (s.startsWith('BINB64:')) {
        try { const buf = Buffer.from(s.slice(7), 'base64'); this._coseatLog('WIRE', rec, { dir, bin: true, len: buf.length, hex: buf.slice(0, 512).toString('hex'), ascii: buf.slice(0, 512).toString('latin1').replace(/[^\x20-\x7e]/g, '.') }); } catch { /* best effort */ }
      } else if (!/^\s*"?[23]"?\s*$/.test(s) && !/^\[\s*7\s*,/.test(s) && !/millicast|"sdp"|ice-ufrag|viewercount/i.test(s)) {
        this._coseatLog('WIRE', rec, { dir, raw: s.slice(0, 3000) });
      }
    }
    if (cls && cls.type === 'TABLE_STATE') {
      const ts = rec.ctx.tableState();
      // Dump ALL scalar table fields from the raw cmd-202 payload so a room-id field we haven't named yet
      // (the "23xx" room code) is visible without another capture. Big arrays (ps/mes) are skipped.
      let fields = null; try { const p = JSON.parse(meta.raw)[1]; if (p && typeof p === 'object') { fields = {}; for (const k of Object.keys(p)) { const v = p[k]; if (v == null || typeof v === 'object') continue; fields[k] = v; } } } catch { /* best effort */ }
      this._coseatLog('TABLE_STATE', rec, { seat: rec.ctx.seat(), members: ts ? ts.uids.slice() : [], roomCode: ts ? ts.roomCode : null, cP: ts ? ts.cP : null, fields });
    }
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
    rec._manualGen = (rec._manualGen || 0) + 1; rec._followGen = (rec._followGen || 0) + 1; rec._followInFlight = false; // §16/§17 — a dead socket cancels any in-flight join/retry
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
  //
  // §35 — SCOPED + SEAT-SAFE. `profileId` limits the request to ONE browser (the one whose
  // bets the user asked to reload) — it used to hit all three. And a browser that is SEATED is
  // never asked: PhomContext treats any CHANNEL_LIST as "back in the lobby" and drops the table
  // state (true for the real game client, which never lists channels while seated), so the tool
  // asking a seated browser made it look like that browser had LEFT its table — and with all
  // three affected, the lobby reset wiped every RID while everyone was still seated.
  async requestChannels({ profileId = null } = {}) {
    if (!this._guard()) return this._unauthorized();
    const out = [];
    for (const rec of this._profiles.values()) {
      if (profileId != null && rec.id !== String(profileId)) continue;
      if (this._seatedNow(rec)) { out.push({ id: rec.id, ok: false, skipped: true, reason: 'SEATED' }); continue; }
      const aid = rec.ctx.aid();
      const ctx = rec.ctx.sendContext();
      if (aid == null) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_PROTOCOL_CONTEXT_MISSING', message: 'aid not learned yet' } }); continue; }
      if (!ctx) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket yet' } }); continue; }
      let res; try { res = await rec.send(buildChannelListFrame(aid), ctx); } catch (e) { res = { ok: false, error: { code: 'PHOM_CHANNEL_REQUEST_FAILED', message: String(e && e.message || e) } }; }
      out.push({ id: rec.id, ...res });
    }
    return { ok: out.some((r) => r.ok), results: out };
  }

  // Table operations are serialised by table-group.cjs (one queue, one browser at a time), so this is only the
  // authorization gate every table command shares.
  async _withFindLock(profileId, operation) {
    if (!this._guard()) return this._unauthorized();
    return operation({ aborted: false });
  }

  // ---- §15 same-table invariant across the three controlled profiles ----
  verifySameTable() {
    const recs = [...this._profiles.values()];
    // The reference browser whose uid EVERY other browser's table state must contain. The LEGACY host/follower
    // flow names it with setHost(); the PHASE-6 manual flow never calls setHost, so this verdict was permanently
    // PHOM_TABLE_IDENTITY_MISSING there — the one check that proves "all three really are at the SAME table" was
    // dead code in the shipped flow, and "đủ 3 browser" was being read off each browser's own manualState
    // instead. The manual equivalent of the host is the ANCHOR: the browser that authoritatively holds the
    // shared room (the same one sharedRid() publishes).
    const refRec = this.host() || (this._holdsRoom(this._anchor()) ? this._anchor() : null);
    const hostUid = refRec && refRec.ctx.uid();
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

  async leaveAll() {
    if (!this._authorizedFn()) return this._unauthorized();
    if (this._leaveAllPromise) return this._leaveAllPromise;
    this._gen++;
    this._setState(SESSION.LEAVING_TABLE);
    this._leaveAllPromise = Promise.all([...this._profiles.values()].map((rec) => this.manualLeave(rec.id)))
      .then((results) => { const ok = results.every((r) => r.ok); this._setState(ok ? SESSION.STOPPED : SESSION.FAILED); return { ok, results }; })
      .finally(() => { this._leaveAllPromise = null; });
    return this._leaveAllPromise;
  }

  // §23 — DỪNG: stop orchestration only. Bumps the generation so every in-flight discovery/join/
  // rejoin step becomes a no-op; never closes browsers/tabs/sessions (that is a separate owner).
  stop() {
    this._stopped = true; this._gen++;
    for (const rec of this._profiles.values()) {
      rec._manualGen = (rec._manualGen || 0) + 1; rec._followGen = (rec._followGen || 0) + 1;
      rec._followInFlight = false;
    }
    this._setState(SESSION.STOPPED); this._log('STOPPED'); this.emit('update', this.snapshot());
  }
  isRunning() { return false; } // the discovery loop is gone; table-group.cjs owns sequencing
  isStopped() { return this._stopped; }

  _waitManual(pred, rec, myGen, timeoutMs, { allowStopped = false } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => { if (done) return; done = true; this.off('update', onUpdate); clearTimeout(timer); };
      const settle = (v) => { cleanup(); resolve(v); };
      const check = () => { if ((!allowStopped && this._stopped) || rec._manualGen !== myGen) { settle(false); return true; } let ok = false; try { ok = !!pred(); } catch { ok = false; } if (ok) { settle(true); return true; } return false; };
      const onUpdate = () => { check(); };
      const timer = setTimeout(() => { let ok = false; try { ok = !!pred(); } catch { ok = false; } settle(ok && (allowStopped || !this._stopped) && rec._manualGen === myGen); }, timeoutMs);
      if (check()) return;
      this.on('update', onUpdate);
    });
  }

  _rec(profileId) { return this._profiles.get(String(profileId)) || null; }
  _ownSeated(rec) { const ts = rec.ctx.tableState(); const uid = rec.ctx.uid(); return !!(ts && uid && ts.uids.includes(uid)); }
  // Seated as far as ANY flow knows: authoritative own uid in ps[], or the manual flow holds a confirmed room.
  _seatedNow(rec) { return !!rec && (this._ownSeated(rec) || rec.manualState === 'JOINED'); }
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
    // §53 — NEVER send a JOIN while seated. The Test D capture proves what the server does with one: it moves the
    // player OUT of the current table ([4,true,2,...]) and seats them again wherever it likes, refusing the extra
    // JOINs ("Phòng đầy" / "Phòng đã bị hủy"). That is how VÀO BÀN retries kept kicking a follower off tables.
    // Callers that mean to move a browser leave first (_leaveConfirmed).
    if (this._ownSeated(rec)) {
      rec.lastError = { code: 'PHOM_ALREADY_AT_TABLE', message: 'Browser đang ở bàn — rời bàn trước khi vào bàn khác' };
      this.emit('update', this.snapshot());
      return { ok: false, id: rec.id, rid: r, state: 'ALREADY_SEATED', error: rec.lastError };
    }
    const intent = opts.intent === 'FIND' ? 'FIND' : (opts.intent === 'REJOIN' ? 'REJOIN' : 'JOIN');
    const myGen = (rec._manualGen = (rec._manualGen || 0) + 1);
    // Answers already received BEFORE this JOIN must never be read as its answer.
    const ackBefore = rec.ctx.ackSeq ? rec.ctx.ackSeq() : 0;
    const tableBefore = rec.ctx.tableSeq ? rec.ctx.tableSeq() : 0;
    const fg = opts.findGen != null ? opts.findGen : myGen; // PHASE 6.3.4 — correlate FIND trace across discover→join
    rec.manualState = intent === 'FIND' ? 'SEARCHING' : (intent === 'REJOIN' ? 'RECONNECTING' : 'JOINING');
    this._mark(`M_${intent}_SENT`, { id: rec.id, rid: r });
    this.emit('update', this.snapshot());
    // §co-seat — a follower JOIN carries the anchor's room CODE (opts.roomCode) so the server seats it at the
    // anchor's exact table; a FIND / public join sends '' (the server picks a fresh table for the finder).
    const roomCode = opts.roomCode != null ? String(opts.roomCode) : '';
    try { const result = await rec.send(buildJoinFrame(r, roomCode), ctx); if (result?.ok === false) throw new Error('JOIN_SEND_FAILED'); } catch (e) { rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_JOIN_FAILED', message: String(e && e.message || e) }; this._findLog('FX_JOIN_REJECTED', rec, fg, { rid: r, intent }); this.emit('update', this.snapshot()); return { ok: false, id: rec.id, rid: r, error: rec.lastError }; }
    if (this._stopped || rec._manualGen !== myGen) return { ok: false, id: rec.id, superseded: true };
    if (roomCode) this._findLog('F6b_JOIN_WITH_CODE', rec, fg, { rid: r, intent });
    this._coseatLog('JOIN_SENT', rec, { rid: r, intent, roomCode });
    rec._joinedRid = r;
    // §stake-channel — is this rid a real TABLE, or the stake CHANNEL (the lobby row a player clicks, e.g. 139)?
    // A channel rid is NOT a shareable số bàn: the server picks a table behind it, so another browser JOINing the
    // same rid just gets matchmade somewhere else. Recorded beside the rid, by the one writer of both, so the
    // flag can never go stale. _holdsRoom() then keeps it out of the published shared room.
    rec._joinedViaChannel = opts.viaStakeChannel === true;
    this._findLog('F6_JOIN_SENT', rec, fg, { rid: r, intent });
    // Seated = own uid in a table snapshot that arrived AFTER this JOIN was sent.
    const seatedFresh = () => this._ownSeated(rec) && (!rec.ctx.tableSeq || rec.ctx.tableSeq() > tableBefore);
    const refusal = () => { const a = rec.ctx.lastJoinAck ? rec.ctx.lastJoinAck() : null; return a && a.seq > ackBefore && a.accepted === false ? a : null; };
    let seated = await this._waitManual(() => seatedFresh() || !!refusal(), rec, myGen, opts.timeoutMs != null ? opts.timeoutMs : 8000);
    if (seated && !seatedFresh()) seated = await this._waitManual(seatedFresh, rec, myGen, this._joinRejectGraceMs); // refused — unless another reply seats us
    const refused = !seated ? refusal() : null;
    if (rec._manualGen !== myGen) { this._findLog('FX_FIND_CANCELLED', rec, fg, { rid: r, intent, reason: 'SUPERSEDED' }); return { ok: false, id: rec.id, rid: r, superseded: true, state: rec.manualState }; }
    if (this._stopped) { rec.manualState = 'LEFT'; this._findLog('FX_SESSION_DEAD', rec, fg, { rid: r, intent }); return { ok: false, id: rec.id, rid: r, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } }; }
    if (!seated && refused) {
      // The server said no, with its own reason — report it instead of waiting out the timeout.
      rec._joinedRid = null; rec.manualState = 'ERROR';
      rec.lastError = { code: 'PHOM_JOIN_REJECTED', message: `Máy chủ từ chối vào bàn: ${refused.message || `mã ${refused.code}`}`, serverCode: refused.code };
      this._findLog('FX_JOIN_REJECTED', rec, fg, { rid: r, intent, serverCode: refused.code });
      this.emit('update', this.snapshot());
      return { ok: false, id: rec.id, rid: r, state: 'JOIN_REJECTED', error: rec.lastError };
    }
    if (!seated) { rec._joinedRid = null; rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_JOIN_NOT_CONFIRMED', message: 'no TABLE_STATE membership within timeout' }; this._findLog('FX_TIMEOUT', rec, fg, { rid: r, intent }); this.emit('update', this.snapshot()); return { ok: false, id: rec.id, rid: r, state: 'JOIN_FAILED', error: rec.lastError }; }
    rec.manualState = 'JOINED'; rec.confirmedInTable = true; rec.state = PSTATE.AT_TABLE; rec.lastError = null;
    // _lastRid survives LEAVE so REJOIN can return to this room — so it is written only once the join is
    // AUTHORITATIVELY confirmed (own uid ∈ ps[]). Writing it at send time let a room we never got into
    // become REJOIN's fallback target after an intentional LEAVE.
    rec._lastRid = r;
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

  async _leaveConfirmed(rec, myGen) {
    const ackBefore = rec.ctx.ackSeq ? rec.ctx.ackSeq() : 0;
    let sent = true; try { const result = await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); sent = result?.ok !== false; } catch { sent = false; }
    const acked = () => { const a = rec.ctx.lastLeaveAck ? rec.ctx.lastLeaveAck() : null; return !!(a && a.seq > ackBefore && a.accepted); };
    const confirmed = sent && await this._waitManual(() => acked() || !this._ownSeated(rec), rec, myGen, this._leaveConfirmMs);
    if (rec._manualGen !== myGen || this._stopped) return { confirmed: false, cancelled: true };
    if (!confirmed) {
      rec.manualState = 'LEAVE_UNCONFIRMED'; rec._joinedRidValidated = false;
      rec.lastError = { code: 'PHOM_LEAVE_NOT_CONFIRMED', message: 'Chưa xác nhận đã rời bàn — không gửi JOIN mới' };
      this.emit('update', this.snapshot());
      return { confirmed: false, cancelled: false };
    }
    rec.ctx.leaveTable(); rec.confirmedInTable = false; rec._joinedRid = null; rec._joinedRidValidated = false; rec.state = PSTATE.IDLE;
    this._mark(confirmed ? 'M_LEAVE_CONFIRMED' : 'M_LEAVE_UNCONFIRMED', { id: rec.id, internal: true });
    return { confirmed, cancelled: false };
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
  // A browser that AUTHORITATIVELY holds a room right now. Same predicate headerSharedRid (phom-main.cjs)
  // uses to publish the shared RID, so the coordinator's same-room proof and the header can never disagree
  // about who the anchor is. manualState === 'JOINED' is what excludes a FOLLOWER_ERROR browser that still
  // carries a stale _joinedRid.
  _holdsRoom(rec) { return !!(rec && rec.manualState === 'JOINED' && rec._joinedRid != null && rec._joinedRidValidated !== false); }
  // `excludeId` — the browser currently performing a follower JOIN. It must NEVER anchor on ITSELF: with no
  // finder chosen, once a browser holds ANY room (even a WRONG table it just landed in) it would otherwise
  // become its own anchor, "prove" co-seating against itself, and stick at that wrong table. Excluding self
  // makes the anchor the OTHER browser that holds the shared room (e.g. the finder/host P3). sharedRid()/the
  // header pass no excludeId (they publish the cluster's shared room, self-inclusive).
  _anchor(excludeId = null) {
    const ex = excludeId != null ? String(excludeId) : null;
    if (this._finderId && this._finderId !== ex && this._profiles.has(this._finderId)) return this._profiles.get(this._finderId);
    // No finder chosen (the shipped default) — the anchor is whichever OTHER browser ACTUALLY found+joined a room,
    // mirroring headerSharedRid. Defaulting to the first profile made the follower same-room proof compare
    // against a browser still sitting in the lobby, so VÀO BÀN reported PHOM_FOLLOWER_ROOM_MISMATCH even
    // though the browser was correctly seated at the published RID.
    for (const rec of this._profiles.values()) if (rec.id !== ex && this._holdsRoom(rec)) return rec;
    if (ex != null) return null; // excluding self and nobody else holds a room → there is no anchor
    const it = this._profiles.values().next(); return it && !it.done ? it.value : null;
  }
  _anchorRid(excludeId = null) { const a = this._anchor(excludeId); return a && a._joinedRid != null ? a._joinedRid : null; }
  // §38 — THE shared room, single source of truth for BOTH surfaces (in-Chromium header + Tool window). It used to
  // be derived three times — headerSharedRid in main, the renderer's manual-cluster-state, and _anchor() here —
  // and the renderer's copy ignored both the user-selected finder and the post-anchor capacity validation, so the
  // Tool could publish a different (or a not-yet-validated) room than the header. Now: the selected finder's
  // validated room, or — no finder chosen — the first browser that authoritatively holds a room; else null.
  sharedRid() { const a = this._anchor(); return this._holdsRoom(a) ? Number(a._joinedRid) : null; }
  // The CLUSTER-level co-seat verdict for the UI: "đủ N browser CÙNG MỘT BÀN", proven from every browser's own
  // authoritative ps[] via verifySameTable — never from one browser's player count and never from three separate
  // manualState === 'JOINED' flags (three browsers can each be happily seated at three different tables).
  coSeatStatus() {
    const v = this.verifySameTable();
    const recs = [...this._profiles.values()];
    return {
      ok: v.result === 'SAME_TABLE',
      result: v.result,
      reason: v.reason || null,
      rid: this.sharedRid(),
      seatedCount: recs.filter((r) => this._ownSeated(r)).length,
      browserCount: recs.length,
      playerCount: v.playerCount != null ? v.playerCount : null,
    };
  }
  sharedRidOwner() { const a = this._anchor(); return this._holdsRoom(a) ? a.id : null; }
  // §stake-channel — is the shared room a real 7-digit SỐ BÀN, or the lobby stake CHANNEL (e.g. 139)? Both are
  // joinable and both co-seat the group when the followers JOIN inside the server's fill-room window, so this
  // never gates the join — it only stops the surfaces from calling a channel id a "số bàn" (the reference tool's
  // SS), which is what sent users hunting for a 7-digit code that does not exist yet.
  sharedRidIsChannel() { const a = this._anchor(); return this._holdsRoom(a) ? !!a._joinedViaChannel : false; }
  // "Player N" for a profile, by the same 1-based order manualBrowserSnapshot uses. The anchor is no longer
  // always the first browser, so a message must name the browser that really holds the room.
  _playerLabel(rec) { if (!rec) return 'Player tìm bàn'; const i = [...this._profiles.keys()].indexOf(String(rec.id)); return i >= 0 ? `Player ${i + 1}` : rec.displayName || 'Player tìm bàn'; }
  // The uid to prove co-seating against — only when the anchor really is at a table. When no browser holds a
  // room (e.g. the anchor left between the header publishing its RID and the follower's click) this is null
  // and manualJoinShared falls back to the follower's OWN ps[] evidence instead of a proof that cannot pass.
  _anchorUid(excludeId = null) { const a = this._anchor(excludeId); return this._holdsRoom(a) ? a.ctx.uid() : null; }
  // The ROOM CODE (hpwd) of the browser that holds the shared room — the token a follower JOIN carries to land
  // at THAT exact table (co-seat), instead of empty-string public matchmaking that seats each browser alone.
  _anchorRoomCode(excludeId = null) { const a = this._anchor(excludeId); if (!this._holdsRoom(a)) return null; const ts = a.ctx.tableState(); return (ts && ts.roomCode) ? ts.roomCode : null; }
  // §co-seat — the CDP session id of the browser's GAME frame (the flattened OOPIF where the Cocos game + socket
  // live). Evaluating a probe with THIS session reaches the game's JS memory; the outer page cannot (cross-origin).
  gameSessionId(profileId) { const r = this._rec(profileId); const c = r && r.ctx.sendContext ? r.ctx.sendContext() : null; return c && c.cdpSessionId ? c.cdpSessionId : null; }
  // §co-seat — the shared room CODE + owner-id, published to BOTH surfaces alongside sharedRid() so the header
  // can show P1's "mã bàn" and the follower JOIN can target it. Null when no browser holds a room yet.
  sharedRoomCode() { return this._anchorRoomCode(); }
  // §room-key — the key of a table one of THIS tool's browsers created (CMD 308), '' for any other table. It is the
  // only password the tool ever sends without the user typing one.
  roomKeyFor(rid) {
    if (rid == null || !this._roomKeyResolver) return '';
    const k = this._roomKeyResolver(Number(rid));
    return k != null ? String(k) : '';
  }
  // Which follower-JOIN failures are worth a same-RID retry (§12). A transient room race / not-yet-confirmed
  // membership is retryable; a dead/cancelled/invalid situation is NOT (retrying it is pointless).
  _isMissingRoom(res) {
    return Number(res?.error?.serverCode) === 102 && /phòng không tồn tại|room (?:does not exist|not found)/i.test(res?.error?.message || '');
  }
  _isRetryableJoin(res) {
    if (!res || res.ok) return false;
    if (res.superseded || res.ridChanged) return false; // a newer op / anchor change already owns the flow
    const code = res.error && res.error.code;
    // Capture 2026-09-21: JOIN refusal 102 = room no longer exists.
    if (this._isMissingRoom(res)) return false;
    if (res.state === 'JOIN_FAILED' || res.state === 'ROOM_MISMATCH' || res.state === 'JOIN_REJECTED') return true;
    if (code === 'PHOM_JOIN_NOT_CONFIRMED' || code === 'PHOM_FOLLOWER_ROOM_MISMATCH' || code === 'PHOM_JOIN_REJECTED') return true;
    return false; // PHOM_INVALID_RID / PHOM_SOCKET_NOT_FOUND / PHOM_OPERATION_CANCELLED / PROFILE_NOT_READY
  }

  async manualJoinByCode(profileId, rid, key, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    const r = Number.isFinite(rid) ? rid : (rid != null && String(rid).trim() !== '' ? Number(rid) : NaN);
    if (!Number.isFinite(r)) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_INVALID_RID', message: 'Số bàn trống/không hợp lệ' } }; }
    // §key-refresh — the KEY is re-decided on EVERY attempt, and a key the server has already REJECTED is never
    // re-sent. The old code computed it ONCE before the loop and then replayed the SAME value up to 41 times: if
    // the key was stale, all 41 were stale, and each one cost a LEAVE + an 8s join wait. The keys, in order: the one
    // the user typed (pinned), then the empty code. When both are refused the retry STOPS with a typed error.
    const pinnedKey = (key != null && String(key).trim() !== '') ? String(key).trim() : null;
    // §no-password — only a key the USER typed is ever sent; nothing is lifted from the anchor's table state or its
    // login session. Without a typed key the JOIN carries '' exactly like the game's own table click.
    const rejectedKeys = new Set();
    const nextKey = () => {
      const seen = new Set(); const candidates = [];
      for (const k of [pinnedKey, this.roomKeyFor(r) || null, '']) { if (k == null || seen.has(k)) continue; seen.add(k); candidates.push(k); }
      const fresh = candidates.find((k) => !rejectedKeys.has(k));
      return { key: fresh, exhausted: fresh === undefined };
    };
    // Bounded like every other retry in this file. 40 was only ever a workaround for never refreshing the key.
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : MAX_JOIN_BY_CODE_RETRIES;
    if (rec._followInFlight && Number(rec._followRid) === r) return { ok: false, id: rec.id, busy: true, error: { code: 'PHOM_FOLLOW_IN_FLIGHT', message: 'đang vào bàn' } };
    rec._followInFlight = true; rec._followRid = r;
    const myGen = (rec._followGen = (rec._followGen || 0) + 1);
    this._findLog('C0_JOIN_BY_CODE_START', rec, myGen, { rid: r, pinnedKey: !!pinnedKey, maxRetries });
    try {
      let last = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (rec._followGen !== myGen || this._stopped) return { ok: false, id: rec.id, superseded: true };
        if (this._ownSeated(rec)) { // never JOIN while seated → leave any wrong table first
          const g = (rec._manualGen = (rec._manualGen || 0) + 1);
          const lv = await this._leaveConfirmed(rec, g);
          if (lv.cancelled || rec._followGen !== myGen) return { ok: false, id: rec.id, superseded: true };
          if (!lv.confirmed) return { ok: false, id: rec.id, error: rec.lastError };
          await this._waitManual(() => false, rec, g, this._rerollCooldownMs);
          if (rec._manualGen !== g || rec._followGen !== myGen) return { ok: false, id: rec.id, superseded: true };
        }
        // §key-refresh — pick the key for THIS attempt from the keys not yet refused. All refused → stop.
        const pick = nextKey();
        if (pick.exhausted) {
          this._findLog('C3_KEYS_EXHAUSTED', rec, myGen, { rid: r, tried: rejectedKeys.size });
          last = { ok: false, id: rec.id, rid: r, state: 'KEY_REJECTED', error: { code: 'PHOM_ROOM_KEY_REJECTED', message: `Máy chủ từ chối mọi mật khẩu phòng đã biết cho bàn ${r} — lấy lại mã bàn/key từ ${this._playerLabel(this._anchor(rec.id))} rồi thử lại` } };
          break;
        }
        const code = pick.key;
        rec.manualState = 'JOINING'; if (attempt > 0) { rec._searchAttempt = attempt; this.emit('update', this.snapshot()); }
        last = await this.manualJoinRoom(profileId, r, { ...opts, intent: 'JOIN', followGen: myGen, roomCode: code });
        if (last.ok) {
          // §same-room proof — own uid ∈ ps[] (manualJoinRoom) is NOT enough: the server decides which table a
          // JOIN lands on, so "seated somewhere" was being reported as "co-seated with the anchor". The proof is
          // the ANCHOR's uid present in the SAME authoritative table state — exactly what manualJoinShared does.
          // Without it the whole point of the co-seat flow went unverified and the header showed a green JOINED
          // for three browsers sitting at three different tables.
          const ts = rec.ctx.tableState();
          const anchorUid = this._anchorUid(rec.id);
          const sameRoom = anchorUid == null || !!(ts && ts.uids.includes(anchorUid));
          if (sameRoom) { rec.lastError = null; this._findLog('C1_JOIN_BY_CODE_OK', rec, myGen, { rid: r, attempts: attempt + 1, sameRoom: anchorUid != null }); this.emit('update', this.snapshot()); return { ...last, sameRoom: true, attempts: attempt + 1 }; }
          this._findLog('C4_ROOM_MISMATCH', rec, myGen, { rid: r, attempt });
          last = { ...last, ok: false, state: 'ROOM_MISMATCH', error: { code: 'PHOM_FOLLOWER_ROOM_MISMATCH', message: `không cùng bàn với ${this._playerLabel(this._anchor(rec.id))}` } };
        }
        // retry on wrong-password ("sai mật khẩu phòng") / rejected / not-confirmed / mismatch
        const msg = (last.error && last.error.message) || '';
        const wrongKey = /mật khẩu|password/i.test(msg);
        if (wrongKey) rejectedKeys.add(code); // §key-refresh — never send this key again
        const retry = !this._isMissingRoom(last) && (this._isRetryableJoin(last) || wrongKey || /Phòng|đầy|hủy/i.test(msg));
        this._findLog('C2_JOIN_BY_CODE_RETRY', rec, myGen, { rid: r, attempt, retry, wrongKey, code: last.state, msg });
        if (!retry || attempt === maxRetries) break;
        await this._waitManual(() => false, rec, myGen, this._rerollCooldownMs);
      }
      // §same-room proof — the server seated this browser at a DIFFERENT table on every try. Do not stay there:
      // it would be reported as joined and could even become the anchor (same rule manualJoinShared applies).
      if (last && last.state === 'ROOM_MISMATCH' && this._ownSeated(rec) && rec._followGen === myGen) {
        const g = (rec._manualGen = (rec._manualGen || 0) + 1);
        const leave = await this._leaveConfirmed(rec, g);
        if (!leave.confirmed) return { ok: false, id: rec.id, state: rec.manualState, error: rec.lastError };
        last = { ...last, error: { code: 'PHOM_FOLLOWER_ROOM_MISMATCH', message: `Máy chủ xếp vào bàn khác ${this._playerLabel(this._anchor(rec.id))} — đã rời bàn đó, bấm VÀO BÀN để thử lại` } };
      }
      rec.manualState = 'FOLLOWER_ERROR'; rec.lastError = (last && last.error) || { code: 'PHOM_JOIN_BY_CODE_FAILED', message: 'Không vào được bàn dù thử nhiều lần' };
      this.emit('update', this.snapshot());
      return { ...(last || { ok: false, id: rec.id }), retriesExhausted: true, error: rec.lastError };
    } finally { if (rec._followGen === myGen) rec._followInFlight = false; }
  }

  // §create — TẠO BÀN on ONE browser: a FRESH empty table via the game's own CREATE_TABLE (cmd 308), instead of
  // hunting the lobby for a table with room. Source of the protocol: the game client's requestcreateRoom +
  // onReceiveQuickPlay (read from its code cache, 2026-09-21). The reply's ri.rid is the table's real SỐ BÀN.
  // The game client JOINs that rid by itself when the reply arrives, so the tool waits for that JOIN first and only
  // sends its own when the game did not (a second JOIN while seated makes the server move the player — §53).
  // PRIMITIVE — create ONE keyed table for this browser (311 → 308 → the game joins it). The group flow on top of
  // this lives in table-group.cjs (docs/phom-kich-ban.md); this method only talks to the server.
  async createTable(profileId, opts = {}) {
    return this._withFindLock(profileId, () => this._createTable(profileId, opts));
  }
  async _createTable(profileId, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    const stake = Number(opts.stake);
    if (!Number.isFinite(stake) || stake <= 0) return { ok: false, id: rec.id, error: { code: 'PHOM_INVALID_STAKE', message: 'Chọn mức cược để tạo bàn' } };
    if (!rec.ctx.sendContext()) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'browser has no game socket yet' } }; }
    if (this._ownSeated(rec)) {
      const g = (rec._manualGen = (rec._manualGen || 0) + 1);
      const lv = await this._leaveConfirmed(rec, g);
      if (!lv.confirmed) return { ok: false, id: rec.id, state: rec.manualState, error: rec.lastError || { code: 'PHOM_OPERATION_CANCELLED' } };
    }
    const maxPlayers = opts.maxPlayers != null ? Number(opts.maxPlayers) : this._capacity;
    const myGen = (rec._manualGen = (rec._manualGen || 0) + 1);
    // Step 1 — CMD 311, exactly what the game's TẠO BÀN button sends first. Its b[] is the list of stakes this
    // account may create at (empty = not enough gold: the game says "Bạn không đủ tiền tạo bàn chơi!").
    const optsBefore = rec.ctx.createOptionsSeq();
    try { await rec.send(buildCreateOptionsFrame(), rec.ctx.sendContext()); } catch { /* the 308 below still reports */ }
    const optReply = () => { const o = rec.ctx.createOptions(); return o && o.seq > optsBefore ? o : null; };
    await this._waitManual(() => !!optReply(), rec, myGen, this._createOptionsMs);
    if (rec._manualGen !== myGen || this._stopped) return { ok: false, id: rec.id, superseded: true };
    const allowed = optReply();
    if (allowed && !allowed.stakes.length) { rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_CREATE_NO_GOLD', message: 'Không đủ tiền tạo bàn chơi' }; this.emit('update', this.snapshot()); return { ok: false, id: rec.id, error: rec.lastError }; }
    if (allowed && !allowed.stakes.includes(stake)) { rec.manualState = 'ERROR'; rec.lastError = { code: 'PHOM_CREATE_STAKE_NOT_ALLOWED', message: `Không tạo được bàn cược ${stake} — được tạo: ${allowed.stakes.join(', ')}` }; this.emit('update', this.snapshot()); return { ok: false, id: rec.id, error: rec.lastError, allowedStakes: allowed.stakes }; }
    if (typeof opts.pace === 'function') { const alive = await opts.pace(); if (alive === false || rec._manualGen !== myGen) return { ok: false, id: rec.id, superseded: true }; }
    // Step 2 — CMD 308 WITH a room key: Phỏm tables cannot be created without one (the server drops the request).
    // The key is generated here for this table only — never a login token — and only this tool's browsers get it.
    const roomKey = opts.password != null && String(opts.password) !== '' ? String(opts.password) : newRoomKey();
    const createBefore = rec.ctx.createSeq();
    const tableBefore = rec.ctx.tableSeq();
    const joinBefore = rec.ctx.joinSendSeq();
    rec.manualState = 'JOINING'; rec.lastError = null;
    this.emit('update', this.snapshot());
    const fail = (code, message, extra = {}) => {
      rec.manualState = 'ERROR'; rec.lastError = { code, message };
      this._coseatLog('CREATE_FAIL', rec, { code, ...extra });
      this.emit('update', this.snapshot());
      return { ok: false, id: rec.id, error: rec.lastError, ...extra };
    };
    this._coseatLog('CREATE_SENT', rec, { stake, maxPlayers, allowedStakes: allowed ? allowed.stakes : null });
    try {
      const sent = await rec.send(buildCreateTableFrame({ stake, maxPlayers, password: roomKey }), rec.ctx.sendContext());
      if (sent?.ok === false) throw new Error('CREATE_SEND_FAILED');
    } catch (e) { return fail('PHOM_CREATE_FAILED', String(e && e.message || e)); }
    const reply = () => { const r = rec.ctx.lastCreateResult(); return r && r.seq > createBefore ? r : null; };
    await this._waitManual(() => !!reply(), rec, myGen, opts.timeoutMs != null ? opts.timeoutMs : 8000);
    if (rec._manualGen !== myGen || this._stopped) return { ok: false, id: rec.id, superseded: true };
    const res = reply();
    if (!res) return fail('PHOM_CREATE_NO_REPLY', 'Máy chủ không trả lời lệnh tạo bàn');
    if (!res.ok) return fail('PHOM_CREATE_REJECTED', `Máy chủ từ chối tạo bàn: ${res.message || 'không rõ lý do'}`);
    const rid = Number(res.rid);
    this._coseatLog('CREATE_OK', rec, { rid, stake: res.stake, maxPlayers: res.maxPlayers });
    const seatedFresh = () => this._ownSeated(rec) && rec.ctx.tableSeq() > tableBefore;
    const gameJoined = () => { const j = rec.ctx.lastJoinSend(); return !!(j && j.seq > joinBefore && Number(j.rid) === rid); };
    await this._waitManual(() => seatedFresh() || gameJoined(), rec, myGen, this._createAutoJoinMs);
    if (rec._manualGen !== myGen || this._stopped) return { ok: false, id: rec.id, superseded: true };
    if (!seatedFresh() && gameJoined()) await this._waitManual(seatedFresh, rec, myGen, opts.timeoutMs != null ? opts.timeoutMs : 8000);
    if (rec._manualGen !== myGen || this._stopped) return { ok: false, id: rec.id, superseded: true };
    if (!seatedFresh()) {
      if (gameJoined()) return fail('PHOM_JOIN_NOT_CONFIRMED', `Đã tạo bàn ${rid} nhưng chưa thấy vào bàn`, { rid });
      const j = await this.manualJoinRoom(profileId, rid, { intent: 'JOIN', roomCode: roomKey, timeoutMs: opts.timeoutMs });
      if (!j.ok) return { ...j, rid, created: true };
    }
    rec._joinedRid = rid; rec._lastRid = rid; rec._createdRid = rid;
    rec._joinedViaChannel = false; rec._joinedRidValidated = true;
    rec.manualState = 'JOINED'; rec.confirmedInTable = true; rec.state = PSTATE.AT_TABLE; rec.lastError = null;
    this._mark('M_CREATE_CONFIRMED', { id: rec.id, rid, seat: rec.ctx.seat() });
    this.emit('update', this.snapshot());
    return { ok: true, id: rec.id, rid, roomKey, created: true, state: 'JOINED', seat: rec.ctx.seat() };
  }

  // ---- PRIMITIVES used by table-group.cjs (the group/role/auto flow lives there, not here) ----
  // Is this browser in the game (its own socket + channel list), i.e. can it be told to do anything at all?
  browserReady(profileId) { const r = this._rec(profileId); if (!r) return false; const c = r.ctx.get(); return !!(c.connected && c.socketReady); }
  profileIds() { return [...this._profiles.keys()]; }
  uidOf(profileId) { const r = this._rec(profileId); return r ? r.ctx.uid() : null; }
  // Seated = own uid in this browser's authoritative ps[]; seatedRid = the room it last confirmed.
  isSeated(profileId) { const r = this._rec(profileId); return !!(r && this._ownSeated(r)); }
  seatedRid(profileId) { const r = this._rec(profileId); return r && this._ownSeated(r) && r._joinedRid != null ? Number(r._joinedRid) : null; }
  lastRidOf(profileId) { const r = this._rec(profileId); return r ? (r._joinedRid != null ? Number(r._joinedRid) : (r._lastRid != null ? Number(r._lastRid) : null)) : null; }
  isReady(profileId) { return this._isReady(this._rec(profileId)); }
  // Ready = this browser signalled READY since the last deal/end, or its own seat row says so.
  _isReady(rec) {
    if (!rec) return false;
    const uid = rec.ctx.uid();
    if (uid != null && this._readyUids.has(uid)) return true;
    const ts = rec.ctx.tableState();
    const s = ts && uid != null ? ts.seats.find((x) => x.uid === uid) : null;
    return !!(s && s.ready);
  }
  tableHostUid() { return this._tableHostUid; }
  isTableHost(profileId) { const uid = this.uidOf(profileId); return uid != null && uid === this._tableHostUid && this.isSeated(profileId); }
  roundRunning() { return this._roundRunning; }
  // Leave the current table and WAIT for the server's confirmation (never a fire-and-forget leave).
  async leaveTable(profileId) {
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY' } };
    if (!this._ownSeated(rec)) return { ok: true, already: true };
    const gen = (rec._manualGen = (rec._manualGen || 0) + 1);
    const left = await this._leaveConfirmed(rec, gen);
    return left.confirmed ? { ok: true } : { ok: false, error: rec.lastError || { code: 'PHOM_LEAVE_NOT_CONFIRMED' } };
  }
  // The account's server-side "tự sẵn sàng" preference (CMD 363). Set BEFORE a browser sits down: with it on the
  // game client readies by itself on join / after a round, and there is no un-ready command.
  async setAutoReadyPref(profileId, on) {
    const rec = this._rec(profileId);
    if (!rec || !rec.ctx.sendContext()) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND' } };
    try { const r = await rec.send(buildAutoReadyPrefFrame(on), rec.ctx.sendContext()); return { ok: r?.ok !== false }; }
    catch (e) { return { ok: false, error: { code: 'PHOM_PREF_FAILED', message: String(e && e.message || e) } }; }
  }
  // SẴN SÀNG at the current table (never sent for the table HOST — for a host the same cmd means BẮT ĐẦU).
  async sendTableReady(profileId, rid) {
    const rec = this._rec(profileId);
    if (!rec || !rec.ctx.sendContext()) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND' } };
    if (this.isTableHost(profileId)) return { ok: false, error: { code: 'PHOM_HOST_NEVER_STARTS', message: 'Chủ bàn không tự bấm Bắt đầu' } };
    try { const r = await rec.send(buildTableReadyFrame(rid), rec.ctx.sendContext()); return { ok: r?.ok !== false }; }
    catch (e) { return { ok: false, error: { code: 'PHOM_READY_FAILED', message: String(e && e.message || e) } }; }
  }
  // table-group.cjs owns the room keys; a JOIN sent by any path asks it for the key of the room it targets.
  setRoomKeyResolver(fn) { this._roomKeyResolver = typeof fn === 'function' ? fn : null; }

  // The latest SỐ BÀN list one browser has received (real tables only, never stake channels), for the header's
  // "Danh sách số bàn". `ageSec` because the server only broadcasts the full list about once a minute.
  roomList(profileId) {
    const rec = this._rec(profileId) || [...this._profiles.values()].find((r) => r.ctx.roomListAt() != null);
    if (!rec) return { rooms: [], at: null, ageSec: null };
    const at = rec.ctx.roomListAt();
    const rooms = rec.ctx.roomList().map((c) => ({ rid: Number(c.rid), b: c.b, uC: c.uC, Mu: c.Mu, locked: !!c.hpwd }));
    return { rooms, at, ageSec: at != null ? Math.max(0, Math.round((this._now() - at) / 1000)) : null };
  }

  resetBrowser(profileId) {
    const rec = this._rec(profileId);
    if (!rec) return false;
    rec._manualGen = (rec._manualGen || 0) + 1; // supersede any pending find/join for this browser
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
        // When a frame from THIS browser's game socket last arrived. A browser that is in the game but whose frames
        // stopped is NOT "chưa vào game" — it is a lost data stream, and the surfaces must say so (and re-hook).
        lastFrameAt: c.lastFrameAt != null ? c.lastFrameAt : null,
        // channelCount > 0 == this browser received the Phỏm stake list, i.e. it is in the Phỏm lobby
        // (mirrors snapshot().channelCount). The header uses it to decide "inGame" (§6.3.2).
        channelCount: Array.isArray(c.channels) ? c.channels.length : 0,
        rid: rec._joinedRid != null ? rec._joinedRid : null,
        // §stake-channel — this rid came from the lobby stake CHANNEL, not a table row: joinable, but not a SỐ BÀN.
        joinedViaChannel: !!rec._joinedViaChannel,
        lastRid: rec._lastRid != null ? rec._lastRid : null,
        // §co-seat — the room CODE (hpwd) the SERVER assigned to THIS browser's table (from authoritative ps[]).
        // Shown on the finder so the user can see "mã bàn"; it is what the followers' JOIN carries to co-seat.
        roomCode: maskSecret(ts && ts.roomCode),
        tableOwner: (ts && ts.cP) ? ts.cP : null,
        // §room-key — the key of the table this browser is at, when the tool created it (shown as "KEY" in the bar).
        roomKey: rec._joinedRid != null ? (this.roomKeyFor(rec._joinedRid) || null) : null,
        // Table facts: is this browser ready, and does the server name it the table host (chủ bàn)? The group ROLE is
        // merged in by the session manager (table-group.cjs owns it).
        ready: this._isReady(rec),
        isTableHost: rec.ctx.uid() != null && rec.ctx.uid() === this._tableHostUid && this._ownSeated(rec),
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
  _log(event, data = {}) { this.emit('log', { tag: 'PHOM-3B', event, at: this._now(), ...redactDiagnostic(data) }); }

  // PHASE 6.3.4 §27/§28 — FIND trace + latency, gated behind PHOM_FIND_LOG=1 (zero overhead when off). Every
  // milestone carries runId + slotId + findGen so overlapping FIND operations can never be confused. Also
  // emitted on the existing 'log' stream so it reaches phom:log.
  _slotOf(rec) { const i = [...this._profiles.keys()].indexOf(rec ? rec.id : null); return i >= 0 ? 'B' + (i + 1) : null; }
  _findLog(event, rec, findGen, data = {}) {
    if (process.env.PHOM_FIND_LOG !== '1') return;
    const entry = { tag: 'PHOM-FIND', event, runId: rec ? rec.id : null, slotId: this._slotOf(rec), findGen: findGen != null ? findGen : null, mono: Math.round(this._mono() * 1000) / 1000, at: this._now(), ...redactDiagnostic(data) };
    try { console.log(`[PHOM-FIND] ${event}`, JSON.stringify(entry)); } catch { /* best effort */ }
    this.emit('log', entry);
  }
  // ALWAYS-ON co-seat wire log — the JOIN request/response + the resulting table membership + room code, per
  // browser. Emitted on the existing 'log' stream; phom-main appends every PHOM-COSEAT entry to a file so the
  // request/response evidence for "who landed where" can be read directly (no Test D recorder, no env var).
  _coseatLog(event, rec, data = {}) {
    try {
      this.emit('log', redactDiagnostic({ tag: 'PHOM-COSEAT', event, at: this._now(), slot: this._slotOf(rec), runId: rec ? rec.id : null,
        anchorOwner: this.sharedRidOwner(), ...data }));
    } catch { /* never throw from logging */ }
  }

  // ---- PHASE-2 instrumentation ----
  // Push one milestone onto the bounded monotonic timeline (and emit it on the existing log stream
  // so it also reaches phom:log). `milestone` is a stable T-name (see trace() consumers).
  _mark(milestone, extra = {}) {
    const rid = this._hostTableIdentity && this._hostTableIdentity.channelRid != null ? this._hostTableIdentity.channelRid : (this.host() && this.host()._joinedRid != null ? this.host()._joinedRid : null);
    const entry = { milestone, mono: Math.round(this._mono() * 1000) / 1000, at: this._now(), gen: this._gen, state: this._state, roomId: rid, ...redactDiagnostic(extra) };
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

  // ---- evaluation / state derivation ----
  // One derivation per observed frame: which browsers are (still) seated, and the cluster's same-table verdict.
  // The old HOST/FOLLOWER acquisition + discovery state machine is gone; table-group.cjs owns what to DO about
  // any of this, so here it is purely observation → state → one 'update'.
  _evaluate() {
    if (this._stopped) { this.emit('update', this.snapshot()); return; }
    const verdict = this.verifySameTable();
    if (verdict.result === 'SAME_TABLE') {
      for (const rec of this._profiles.values()) {
        rec.confirmedInTable = true;
        if (rec.state === PSTATE.MISMATCH || rec.state === PSTATE.JOINING) rec.state = PSTATE.AT_TABLE;
        if (this._isReady(rec)) rec.state = PSTATE.READY;
      }
      this._setState(SESSION.SAME_TABLE);
    } else if (verdict.result === 'TABLE_MISMATCH') this._setState(SESSION.TABLE_MISMATCH);
    else if (verdict.result === 'PARTIAL_JOIN') this._setState(SESSION.PARTIAL_JOIN);
    this._reconcileManualSeats();
    this.emit('update', this.snapshot());
  }

  // §36 — PER-BROWSER lobby reconciliation for the manual flow. A browser the tool believes is JOINED but whose
  // table state is gone was sent back to the lobby by the GAME itself (the player left via the game UI, was
  // kicked, the round closed the table): only a CHANNEL_LIST clears table state for a JOINED browser, and the
  // tool no longer requests one for a seated browser (§35). Only THAT browser is moved back to READY; the other
  // browsers and the shared anchor are untouched, and _lastRid is kept so REJOIN can still return.
  _reconcileManualSeats() {
    for (const rec of this._profiles.values()) {
      if (rec.manualState !== 'JOINED' || rec.ctx.tableState()) continue;
      rec.manualState = 'READY'; rec._joinedRid = null; rec._joinedRidValidated = false; rec.confirmedInTable = false;
      if (rec.state === PSTATE.AT_TABLE || rec.state === PSTATE.READY) rec.state = PSTATE.IDLE;
      this._mark('M_BACK_TO_LOBBY', { id: rec.id });
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
    const anyTable = [...this._profiles.values()].map((r) => r.ctx.tableState()).find(Boolean);
    const playerCount = anyTable ? anyTable.playerCount : 0;
    const profiles = [...this._profiles.values()].map((rec) => {
      const c = rec.ctx.get();
      return {
        id: rec.id, displayName: rec.displayName, role: rec.role, proxyRef: rec.proxyRef,
        state: rec.state, uid: shortUid(c.uid), aid: c.aid, socketReady: c.socketReady, connected: c.connected,
        seat: c.seat, ready: this._isReady(rec),
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
      sameTable: verdict.result === 'SAME_TABLE', tableVerdict: verdict.result,
      playerCount, readyCount, roundRunning: this._roundRunning,
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
