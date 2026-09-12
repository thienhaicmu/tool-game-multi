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
    if (this._uid == null && Array.isArray(cls.sAC) && cls.uid != null) { this._uid = String(cls.uid); changed = true; }

    if (cls.type === 'CHANNEL_LIST' && Array.isArray(cls.rs)) {
      this._channels = cls.rs.map(normalizeChannel).filter(Boolean);
      this._channelsAt = now;
      changed = true;
    }

    if (cls.type === 'TABLE_STATE' && Array.isArray(cls.ps)) {
      this._tableState = buildTableState(cls);
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
    this._socket = null; this._channels = []; this._tableState = null;
    this._joinedChannel = null; this._connected = false;
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

function hostOf(u) { try { return new URL(u).host; } catch { return String(u || ''); } }

module.exports = { PhomContext, buildTableState };
