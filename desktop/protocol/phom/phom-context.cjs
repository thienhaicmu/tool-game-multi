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
    this._joinedChannel = null;
    this._lastFrameAt = null;
    this._connected = false;
  }

  // Inject identity known from the authenticated runtime/login context (§4). Never
  // overwrites a value already learned from a frame unless force is set.
  setIdentity({ aid, uid } = {}, force = false) {
    let changed = false;
    if (aid != null && (force || this._aid == null)) { this._aid = aid; changed = true; }
    if (uid != null && (force || this._uid == null)) { this._uid = String(uid); changed = true; }
    if (changed) this._emit();
  }

  setJoinedChannel(channel) {
    const c = Number.isFinite(channel) ? channel : (channel != null ? Number(channel) : null);
    if (this._joinedChannel !== c) { this._joinedChannel = c; this._emit(); }
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
      if (cls.identityId !== 1) {                       // authoritative game identity (id:0 / absent)
        if (!this._uidAuthoritative) { this._uid = String(cls.uid); this._uidAuthoritative = true; changed = true; }
      } else if (this._uid == null) {                   // token identity: fallback for the gate only
        this._uid = String(cls.uid); changed = true;
      }
    }

    if (cls.type === 'CHANNEL_LIST' && Array.isArray(cls.rs)) {
      this._channels = cls.rs.map(normalizeChannel).filter(Boolean);
      this._channelsAt = now;
      // Receiving the stake channel list means this profile is in the LOBBY, not seated (the client
      // never polls the channel list while at a table). Clear any stale table membership so returning
      // to the lobby resets state — no sticky BÀN / SAME_TABLE / MISMATCH after leaving a table.
      if (this._tableState) { this._tableState = null; this._tableStateAt = now; }
      changed = true;
    }

    if (cls.type === 'TABLE_STATE' && Array.isArray(cls.ps)) {
      this._tableState = buildTableState(cls);
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

    if (changed) this._emit();
    return cls;
  }

  onDisconnect() {
    if (!this._connected && this._socket == null) return;
    this._connected = false;
    this._emit();
  }

  reset() {
    this._socket = null; this._channels = []; this._tableState = null;
    this._joinedChannel = null; this._connected = false;
    this._emit();
  }

  // Leave the current table but KEEP the live game socket/aid/uid/channels — used when the host
  // abandons a candidate and must immediately search/join again. Clearing the socket (reset) here
  // breaks the next acquireHost with PHOM_PROTOCOL_CONTEXT_MISSING (observed live).
  leaveTable() {
    if (this._tableState == null && this._joinedChannel == null) return;
    this._tableState = null; this._tableStateAt = null; this._joinedChannel = null;
    this._emit();
  }

  // The socket send-context the coordinator hands to wsReplay.sendProtocol.
  sendContext() { return this._socket ? { ...this._socket } : null; }

  socketReady() { return !!this._socket; }
  aid() { return this._aid; }
  uid() { return this._uid; }
  channels() { return this._channels.slice(); }
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
      joinedChannel: this._joinedChannel,
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

function hostOf(u) { try { return new URL(u).host; } catch { return String(u || ''); } }

module.exports = { PhomContext, buildTableState };
