'use strict';

const EventEmitter = require('node:events');
const { classifyPhomFrame, normalizeChannel, normalizeSeat, ZONE, GID } = require('./phom-frame-classify.cjs');

// ---------------------------------------------------------------------------
// PhomContext — per-BrowserRun (per-profile) Phỏm session context. Mirrors the
// Aviator ProtocolContext ownership rule: identity (aid/uid) and the game socket
// binding are LEARNED from observed frames, never hardcoded / user-entered.
//
// It also caches the last authoritative CHANNEL_LIST and TABLE_STATE so the
// coordinator can verify same-table membership from real server data (not uC,
// not a fixed delay). One instance per run; two runs never share state.
//
// PASSIVE: this module never sends. The send seam (wsReplay.sendProtocol) is
// owned by main.cjs and driven by the coordinator through the run's own socket.
// ---------------------------------------------------------------------------

class PhomContext extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._profileId = deps.profileId != null ? String(deps.profileId) : null;
    this._aid = null;
    this._uid = deps.uid != null ? String(deps.uid) : null; // may be injected from login/runtime ctx
    this._uidAuthoritative = false; // true once bound from an authoritative game identity (ps[] form)
    this._gid = GID;
    this._zone = ZONE;
    this._socket = null;      // { targetId, cdpSessionId, host } learned from server-evidence frames
    this._channels = [];      // normalized CHANNEL_LIST rs[]
    this._channelsAt = null;
    this._tableState = null;  // { b, seats, playerCount, fingerprint }
    this._tableStateAt = null;
    this._lastFrameAt = null;
    this._connected = false;
    this._identitySeen = false; // cmd 100 seen on this socket since the last reset
    this._displayName = null;   // the account's own name (dn), from cmd 100 — known before it sits anywhere
    // Server answers to our own JOIN / LEAVE (Test D capture). A JOIN refusal ([3,false,code,-1,msg]) lets a join
    // fail fast with the server's reason; a LEAVE ack ([4,true,code,...]) is the proof the player left the table.
    this._lastJoinAck = null;   // { accepted, code, message, at, seq }
    this._lastLeaveAck = null;  // { accepted, code, at, seq }
    this._ackSeq = 0;
    // Bumped on every FULL table snapshot (ps[]). A join is only proven by a snapshot that arrived AFTER it was
    // sent — the old table's state must never count as 'seated at the new one'.
    this._tableSeq = 0;
    // QUICK_PLAY (cmd 313) replies — the server naming a table. The seq lets the caller tell a fresh reply from an old one.
    this._roomAssign = null;    // { ok, rid, stake, maxPlayers, password, message, at, seq }
    this._roomAssignSeq = 0;
    // The SỐ BÀN list: rs[] rows that are real tables (7-digit rid, rn without '#'), kept apart from the stake
    // channels. The server sends the full table list rarely (~every 60s) while every CMD 300 reply carries only the
    // 14 channels — storing both in _channels meant the table list was overwritten seconds after it arrived.
    this._roomList = [];
    this._roomListAt = null;
  }

  // Inject identity known from the authenticated runtime/login context (§4). Never
  // overwrites a value already learned from a frame unless force is set.
  setIdentity({ aid, uid } = {}, force = false) {
    let changed = false;
    if (aid != null && (force || this._aid == null)) { this._aid = aid; changed = true; }
    if (uid != null && (force || this._uid == null)) { this._uid = String(uid); changed = true; }
    if (changed) this._emit();
  }

  // Feed one captured WebSocket frame. meta carries the socket identity + direction.
  // Returns the classified descriptor so the caller (coordinator) can also reduce
  // it into the per-profile hand — one classification, no duplicate parsing.
  observe(meta = {}) {
    const cls = classifyPhomFrame(meta.raw);
    if (!cls.op && cls.type === 'UNKNOWN' && !cls.json) return cls; // non-JSON noise
    const now = meta.now != null ? meta.now : Date.now();
    let changed = false;

    // Bind the owning game socket from an authoritative SERVER push (recv).
    if (cls.isServerEvidence && meta.direction === 'recv') {
      this._lastFrameAt = now;
      this._connected = true;
      const host = hostOf(meta.url);
      if (!this._socket || this._socket.targetId !== meta.targetId || this._socket.cdpSessionId !== (meta.cdpSessionId || null) || this._socket.host !== host) {
        this._socket = { targetId: meta.targetId, cdpSessionId: meta.cdpSessionId || null, host };
        changed = true;
      }
    }

    // Learn aid from any frame that carries it (e.g. the channel-list request).
    if (cls.aid != null && this._aid == null) { this._aid = cls.aid; changed = true; }

    // Learn OWN uid from an authoritative own-hand frame (sAC is only sent to the
    // receiving session, so its uid IS this profile's uid).
    if (Array.isArray(cls.sAC) && cls.uid != null && !this._uidAuthoritative) { this._uid = String(cls.uid); this._uidAuthoritative = true; changed = true; }
    // Learn OWN uid from the self-identity push (cmd:100). Live capture shows TWO forms: the
    // authoritative game identity (id:0, uid "<aid>_<n>" — the SAME form used in ps[]) and a session
    // token (id:1). The token binds as a FALLBACK so the READY gate (socketReady+uid) can pass before
    // a table exists; the authoritative id:0 identity OVERRIDES it (and any injected login uid) so
    // ps[] membership matching is correct — otherwise a token uid never matches ps[] (seat=null,
    // false TABLE_MISMATCH). Once the authoritative uid is bound it is never downgraded.
    if (cls.type === 'SELF_IDENTITY' && cls.uid != null) {
      // The server pushes this once, when the account logs in — the "login OK" signal the auto VÀO GAME waits for.
      if (!this._identitySeen) { this._identitySeen = true; changed = true; }
      if (cls.identityId !== 1 && cls.displayName && cls.displayName !== this._displayName) { this._displayName = cls.displayName; changed = true; }
      if (cls.identityId !== 1) {                       // authoritative game identity (id:0 / absent)
        if (!this._uidAuthoritative) { this._uid = String(cls.uid); this._uidAuthoritative = true; changed = true; }
      } else if (this._uid == null) {                   // token identity: fallback for the gate only
        this._uid = String(cls.uid); changed = true;
      }
    }

    if (cls.type === 'JOIN_ACCEPTED' && meta.direction !== 'send') {
      this._lastJoinAck = { accepted: cls.accepted === true, code: cls.resultCode != null ? cls.resultCode : null, message: cls.resultMessage || null, at: now, seq: ++this._ackSeq };
      changed = true;
    }
    if (cls.type === 'LEAVE_ACK' && meta.direction !== 'send') {
      this._lastLeaveAck = { accepted: cls.accepted === true, code: cls.resultCode != null ? cls.resultCode : null, at: now, seq: ++this._ackSeq };
      // the server says we are out of the table — drop it now instead of waiting for the lobby list
      if (cls.accepted === true && this._tableState) { this._tableState = null; this._tableStateAt = now; }
      changed = true;
    }

    if (cls.type === 'ROOM_ASSIGNED' && meta.direction !== 'send') {
      this._roomAssign = {
        ok: cls.ok === true, rid: cls.rid != null ? cls.rid : null,
        stake: cls.stake != null ? cls.stake : null, maxPlayers: cls.maxPlayers != null ? cls.maxPlayers : null,
        // Straight from the answer: how many sit there already, whether it is a real table (not a stake channel)
        // and whether it is password-locked — enough to accept or skip it without joining first.
        seated: cls.seated != null ? cls.seated : null, roomName: cls.roomName || null,
        isTable: cls.isTable === true, locked: cls.locked === true,
        password: typeof cls.password === 'string' ? cls.password : '',
        message: cls.message || null, at: now, seq: ++this._roomAssignSeq,
      };
      changed = true;
    }

    if (cls.type === 'CHANNEL_LIST' && Array.isArray(cls.rs)) {
      this._channels = cls.rs.map(normalizeChannel).filter(Boolean);
      this._channelsAt = now;
      const tables = this._channels.filter(isTableRow);
      if (tables.length) { this._roomList = tables; this._roomListAt = now; }
      // A list response may arrive AFTER JOIN. It is discovery data, not proof
      // of leaving. Only LEAVE_ACK or a fresh membership snapshot can do that.
      changed = true;
    }

    if (cls.type === 'TABLE_STATE' && Array.isArray(cls.ps)) {
      this._tableState = buildTableState(cls);
      this._tableSeq += 1;
      this._tableStateAt = now;
      // Own-uid anchor: if this profile joined an EMPTY table (exactly one occupant) and has not yet
      // bound its authoritative game uid, that lone occupant IS us — in the id:0 / ps[] form. This is
      // robust when the one-shot SELF_IDENTITY id:0 was missed and only a session token is known;
      // without it, own uid never matches ps[] and membership can never be confirmed.
      if (!this._uidAuthoritative && this._tableState.seats.length === 1 && this._tableState.seats[0].uid != null) {
        this._uid = String(this._tableState.seats[0].uid); this._uidAuthoritative = true;
      }
      changed = true;
    }

    // Fold a single-seat JOIN delta (cmd:200) into the current table state. The full ps[] snapshot
    // only arrives on THIS profile's own join; when a LATER player sits, an early joiner is told via
    // this delta. Without folding, the early joiner's player set stays stale and same-table can never
    // be confirmed. Requires an existing base table state (the delta carries no stake `b`). Only
    // presence (t===1) is applied — a removal delta is not yet evidenced, so it is not inferred.
    if (cls.type === 'SEAT_UPDATE' && cls.present && cls.seat && this._tableState) {
      const seat = normalizeSeat(cls.seat);
      if (seat && seat.uid != null) {
        this._tableState = foldSeat(this._tableState, seat);
        this._tableStateAt = now;
        changed = true;
      }
    }
    // t:2 = that player LEFT the table (capture 2026-10-02: [5,{p:{uid,dn,id},t:2,cmd:200}] each time the NOT_READY
    // account was kicked, followed by its t:1 when it sat down again). Our own row is never dropped this way — only
    // LEAVE_ACK / a fresh ps[] decide whether THIS browser is seated.
    if (cls.type === 'SEAT_UPDATE' && cls.t === 2 && cls.seat && cls.seat.uid != null && this._tableState && String(cls.seat.uid) !== this._uid) {
      this._tableState = dropSeat(this._tableState, String(cls.seat.uid));
      this._tableStateAt = now;
      changed = true;
    }

    if (changed) this._emit();
    return cls;
  }

  onDisconnect() {
    if (!this._connected && this._socket == null) return;
    this._connected = false;
    this._emit();
  }

  reset() {
    this._identitySeen = false; this._displayName = null;
    this._socket = null; this._channels = []; this._tableState = null; this._lastJoinAck = null; this._lastLeaveAck = null;
    this._connected = false;
    this._emit();
  }

  // Leave the current table but KEEP the live game socket/aid/uid/channels — used when the host
  // abandons a candidate and must immediately search/join again. Clearing the socket (reset) here
  // breaks the next acquireHost with PHOM_PROTOCOL_CONTEXT_MISSING (observed live).
  leaveTable() {
    if (this._tableState == null) return;
    this._tableState = null; this._tableStateAt = null;
    this._emit();
  }

  // Does a just-closed WebSocket belong to THIS profile's bound game socket? Used to map a
  // CDP `websocket-closed` event to a real game disconnect. A close for a different target or
  // a different host (e.g. an analytics/telemetry socket sharing the page) returns false so it
  // never flips connected. When neither targetId nor url is supplied it defaults to a match
  // (the caller already scoped the event to this run's target).
  socketMatches(meta = {}) {
    if (!this._socket) return false;
    if (meta.targetId != null && this._socket.targetId !== meta.targetId) return false;
    const host = meta.url != null ? hostOf(meta.url) : null;
    if (host && this._socket.host && host !== this._socket.host) return false;
    return true;
  }

  // The socket send-context the coordinator hands to wsReplay.sendProtocol.
  sendContext() { return this._socket ? { ...this._socket } : null; }

  socketReady() { return !!this._socket; }
  // The account's own identity arrived on the game socket (cmd 100): it is logged in.
  loggedIn() { return !!this._identitySeen; }
  displayName() { return this._displayName; }
  aid() { return this._aid; }
  uid() { return this._uid; }
  channels() { return this._channels.slice(); }
  // PHASE 6.3.7 — when the authoritative channel list (CMD 300 rs[]) was last received, for FIND freshness.
  channelsAt() { return this._channelsAt; }
  // The latest server answers to our JOIN / LEAVE, with a monotonic seq so a caller can tell 'new since I sent'.
  lastJoinAck() { return this._lastJoinAck ? { ...this._lastJoinAck } : null; }
  lastLeaveAck() { return this._lastLeaveAck ? { ...this._lastLeaveAck } : null; }
  ackSeq() { return this._ackSeq; }
  // The table the server last assigned this browser (QUICK_PLAY reply): số bàn + the password a JOIN must carry.
  lastRoomAssign() { return this._roomAssign ? { ...this._roomAssign } : null; }
  roomAssignSeq() { return this._roomAssignSeq; }
  // The latest SỐ BÀN list (real tables only) + when it arrived.
  roomList() { return this._roomList.slice(); }
  roomListAt() { return this._roomListAt; }
  tableSeq() { return this._tableSeq; }
  tableState() { return this._tableState; }

  // The seat this profile occupies at the current table (own uid within ps[]).
  seat() {
    if (!this._tableState || this._uid == null) return null;
    const mine = this._tableState.seats.find((s) => s.uid === this._uid);
    return mine ? mine.sit : null;
  }
  ready() {
    if (!this._tableState || this._uid == null) return false;
    const mine = this._tableState.seats.find((s) => s.uid === this._uid);
    return !!(mine && mine.ready);
  }

  get() {
    return {
      profileId: this._profileId,
      aid: this._aid,
      uid: this._uid,
      gid: this._gid,
      zone: this._zone,
      socketReady: this.socketReady(),
      host: this._socket ? this._socket.host : null,
      connected: this._connected,
      channels: this.channels(),
      channelsAt: this._channelsAt,
      tableState: this._tableState,
      tableStateAt: this._tableStateAt,
      seat: this.seat(),
      ready: this.ready(),
      physicalTableIdentity: this._tableState ? this._tableState.identity : null,
      // Phase-3A derivations from the authoritative TABLE_STATE (see buildTableState). The
      // protocol carries no server-assigned table id in TABLE_STATE, so the physical-table
      // reference is the PLAYER-SET FINGERPRINT (physicalTableIdentity) — never a rid guess.
      selectedStake: this._tableState ? this._tableState.b : null,
      ownSeat: this.seat(),
      players: this._tableState ? this._tableState.seats : [],
      playerCount: this._tableState ? this._tableState.playerCount : 0,
      lastFrameAt: this._lastFrameAt,
    };
  }

  _emit() { this.emit('change', this.get()); }
}

// Build a normalized, redaction-safe table state + a physical-table identity.
// The protocol carries no explicit physical table id in the captured evidence,
// so identity is a PLAYER-SET FINGERPRINT (sorted uid set) — an authoritative,
// server-sourced value, never a timestamp. If a future capture reveals a real
// table id field it should be preferred here.
function buildTableState(cls) {
  const seats = (cls.ps || []).map(normalizeSeat).filter(Boolean);
  const uids = seats.map((s) => s.uid).filter(Boolean).sort();
  return {
    b: cls.b != null ? cls.b : null,
    seats,
    playerCount: seats.length,
    uids,
    identity: uids.length ? { type: 'PLAYER_SET_FINGERPRINT', value: uids.join('|') } : null,
  };
}

// Merge one seat (from a cmd:200 JOIN delta) into an existing table state. Keyed by SEAT INDEX
// (each physical seat holds at most one uid), so a new occupant REPLACES the prior one — this bounds
// the set to the table's real capacity and handles seat re-occupation without a leave delta (a pure
// vacate with no replacement self-heals on the next full ps[] snapshot). Also drops any stale entry
// for the same uid (a uid that moved seats). Stake `b` is preserved from the base snapshot.
function foldSeat(ts, seat) {
  let seats = ts.seats.filter((s) => s.uid !== seat.uid);            // uid moved / re-announced
  if (seat.sit != null) seats = seats.filter((s) => s.sit !== seat.sit); // vacate the target seat
  seats.push(seat);
  const uids = seats.map((s) => s.uid).filter(Boolean).sort();
  return {
    b: ts.b,
    seats,
    playerCount: seats.length,
    uids,
    identity: uids.length ? { type: 'PLAYER_SET_FINGERPRINT', value: uids.join('|') } : null,
  };
}

function dropSeat(ts, uid) {
  const seats = ts.seats.filter((s) => s.uid !== uid);
  if (seats.length === ts.seats.length) return ts;
  const uids = seats.map((s) => s.uid).filter(Boolean).sort();
  return { ...ts, seats, playerCount: seats.length, uids, identity: uids.length ? { type: 'PLAYER_SET_FINGERPRINT', value: uids.join('|') } : null };
}

function hostOf(u) { try { return new URL(u).host; } catch { return String(u || ''); } }

// A real TABLE row of rs[] (a số bàn), not a stake channel: channels are named "Phom#<n>" with small rids
// (139…152); tables are named "Phom" with 7-digit rids (live capture 2026-09-21: 3673500, 3538594, …).
function isTableRow(c) {
  if (!c || !Number.isFinite(Number(c.rid)) || Number(c.rid) < 100000) return false;
  if ((c.zn != null && c.zn !== ZONE) || (c.gid != null && Number(c.gid) !== GID)) return false;
  return !(c.rn && c.rn.includes('#'));
}

module.exports = { PhomContext, buildTableState, isTableRow };
