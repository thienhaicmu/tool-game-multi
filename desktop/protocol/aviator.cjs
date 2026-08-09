'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// SOURCE OF TRUTH — observed Aviator protocol (WU7 §1). Only commands that were
// actually captured are recognised; everything else stays UNKNOWN and is never
// dropped. No undocumented fields are invented here.
// ---------------------------------------------------------------------------
const CMD = Object.freeze({
  ENTER_A: 100000,     // subscribe / enter
  ENTER_B: 100001,     // subscribe / enter
  BET: 100002,         // client places bet  /  server bet ack
  CASHOUT: 100003,     // client cashout     /  server cashout ack
  ROUND_OPEN: 100005,  // server announces a new/open round (authoritative sid)
  ROUND_LOCK: 100006,  // server locks the round (flying)
  ROUND_END: 100007,   // server ends the round
  ROUND_SNAPSHOT: 100008, // server round/player snapshot (also carries sid)
  ODD: 100009,         // server streams current odd
});

// cmd -> stable semantic label (UI / evidence). Unknown -> 'UNKNOWN'.
const CMD_TYPE = Object.freeze({
  [CMD.ENTER_A]: 'ENTER',
  [CMD.ENTER_B]: 'ENTER',
  [CMD.BET]: 'BET',
  [CMD.CASHOUT]: 'CASHOUT',
  [CMD.ROUND_OPEN]: 'ROUND_OPEN',
  [CMD.ROUND_LOCK]: 'ROUND_LOCK',
  [CMD.ROUND_END]: 'ROUND_END',
  [CMD.ROUND_SNAPSHOT]: 'ROUND_OPEN',
  [CMD.ODD]: 'ODD_UPDATE',
});

// Round lifecycle state — derived ONLY from observed server frames (WU7 §4).
const ROUND_STATE = Object.freeze({
  OPEN: 'OPEN', LOCKED: 'LOCKED', RUNNING: 'RUNNING', ENDED: 'ENDED',
});

/**
 * classifyFrame(raw) — parse one WebSocket text frame payload (JSON string) into
 * a canonical descriptor. Pure and total: malformed / non-JSON / binary frames
 * come back as { known:false, type:'UNKNOWN' } rather than throwing.
 */
function classifyFrame(raw) {
  const base = { raw: raw == null ? '' : String(raw), json: null, cmd: null, type: 'UNKNOWN', known: false };
  const wirePrefix = wirePrefixFor(base.raw);
  let json;
  try { json = parseFrameJson(base.raw); } catch { return base; }
  json = protocolPayload(json);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return base;
  const cmd = Number.isFinite(json.cmd) ? json.cmd : (json.cmd != null ? Number(json.cmd) : null);
  const type = (cmd != null && CMD_TYPE[cmd]) ? CMD_TYPE[cmd] : 'UNKNOWN';
  return {
    raw: base.raw,
    json,
    wirePrefix,
    cmd: Number.isFinite(cmd) ? cmd : null,
    type,
    known: type !== 'UNKNOWN',
    // Only surface fields the protocol actually carries; undefined when absent.
    sid: json.sid != null ? json.sid : undefined,
    odd: json.odd != null ? Number(json.odd) : undefined,
    b: json.b != null ? json.b : undefined,
    aid: json.aid != null ? json.aid : undefined,
    eid: json.eid != null ? json.eid : undefined,
    agentId: json.agentId != null ? json.agentId : undefined,
    wm: json.wm != null ? json.wm : undefined,
    iOE: json.iOE != null ? json.iOE : undefined,
  };
}

function wirePrefixFor(raw) {
  const text = String(raw || '').trim();
  const firstJson = text.search(/[\[{]/);
  return firstJson > 0 ? text.slice(0, firstJson) : '';
}

function parseFrameJson(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const firstObject = text.search(/[\[{]/);
  if (firstObject < 0) throw new Error('not json');
  return JSON.parse(text.slice(firstObject));
}

function protocolPayload(json) {
  if (!Array.isArray(json)) return json;
  return json.find((item) => item && typeof item === 'object' && !Array.isArray(item) && item.cmd != null)
    || json.find((item) => item && typeof item === 'object' && !Array.isArray(item) && item.agentId != null)
    || null;
}

/**
 * RoundTracker observes classified Aviator frames and maintains the authoritative
 * CurrentRound, the SID history and per-round state history. It also pairs sent
 * client frames (bet/cashout) with their server acks into ActionTraces.
 *
 * CRITICAL (WU7 §2): the current sid comes from the server ROUND_OPEN (cmd 100005)
 * frame ONLY. Sequential/arithmetic prediction of the next sid is never performed.
 *
 * Events: 'frame' (every classified frame), 'round' (CurrentRound changed),
 *         'actiontrace' (a send->ack pair or a new pending client action).
 */
class RoundTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this._ackWindowMs = Number(options.ackWindowMs || 10000);
    this._current = null;         // CurrentRound | null
    this._sidHistory = [];        // [{ sid, delta, at }]
    this._sidSeen = new Set();
    this._rounds = new Map();      // sid -> round state record
    this._roundOrder = [];         // sids in observation order
    this._socketByTarget = new Map(); // targetId -> { host, cdpSessionId, at } (send seam context)
    this._pendingActions = [];     // unacked client frames awaiting server ack
    this._actionTraces = [];       // newest-last ActionTrace records
    this._seq = 0;
  }

  currentRound() { return this._current ? { ...this._current } : null; }
  sidHistory() { return this._sidHistory.map((x) => ({ ...x })); }
  roundHistory() { return this._roundOrder.map((sid) => ({ ...this._rounds.get(sid) })); }
  actionTraces() { return this._actionTraces.map((t) => ({ ...t })); }
  // Send-seam context for a target (the live game socket we can .send() through).
  socketContext(targetId) { const c = this._socketByTarget.get(String(targetId)); return c ? { ...c, targetId: String(targetId) } : null; }
  anySocketContext() { const it = this._socketByTarget.entries().next(); return it.done ? null : { ...it.value[1], targetId: it.value[0] }; }

  /**
   * observe(frame) — feed a captured WebSocket frame.
   * frame: { targetId?, cdpSessionId?, url?, direction: 'send'|'recv', raw }
   * Round state transitions apply ONLY to server (recv) frames (WU7 §4).
   */
  observe(frame = {}) {
    const direction = frame.direction === 'send' ? 'send' : 'recv';
    const cls = classifyFrame(frame.raw);
    const at = frame.at || Date.now();
    const ev = { ...cls, direction, targetId: frame.targetId != null ? String(frame.targetId) : undefined, at, seq: this._seq++ };

    // Remember where the game socket lives so a test can be sent through the
    // page's own authenticated connection (never a second socket).
    if (frame.targetId != null && (cls.known || cls.agentId != null)) {
      let host = '';
      try { host = frame.url ? new URL(frame.url).host : ''; } catch { host = ''; }
      this._socketByTarget.set(String(frame.targetId), { host, cdpSessionId: frame.cdpSessionId != null ? frame.cdpSessionId : null, at, wirePrefix: cls.wirePrefix || '' });
    }

    if (direction === 'recv') this._applyServerFrame(cls, at);
    if (direction === 'send') this._recordSentAction(cls, at);
    else this._tryAck(cls, at);

    this.emit('frame', ev);
    return ev;
  }

  _applyServerFrame(cls, at) {
    switch (cls.cmd) {
      case CMD.ROUND_OPEN: {
        if (cls.sid == null) break;
        this._openRound(cls.sid, at);
        break;
      }
      case CMD.ROUND_SNAPSHOT: {
        if (cls.sid == null) break;
        if (!this._current || String(this._current.sid) !== String(cls.sid)) this._openRound(cls.sid, at);
        break;
      }
      case CMD.ROUND_LOCK: {
        this._transition(cls.sid, ROUND_STATE.LOCKED, at, { lockedAt: isoOrNow(at) });
        break;
      }
      case CMD.ODD: {
        if (cls.odd != null) this._transition(cls.sid, ROUND_STATE.RUNNING, at, { runningAt: isoOrNow(at), lastOdd: cls.odd });
        break;
      }
      case CMD.ROUND_END: {
        this._transition(cls.sid, ROUND_STATE.ENDED, at, { endedAt: isoOrNow(at), lastOdd: cls.odd != null ? cls.odd : undefined, closedAt: isoOrNow(at) });
        break;
      }
      default: break;
    }
  }

  _openRound(sid, at) {
    const iso = isoOrNow(at);
    // Authoritative current round = the server-published sid.
    this._current = { sid, state: ROUND_STATE.OPEN, openedAt: iso, closedAt: undefined, lastOdd: undefined, updatedAt: iso };
    if (!this._rounds.has(sid)) {
      this._rounds.set(sid, { sid, state: ROUND_STATE.OPEN, open: iso, locked: null, running: null, ended: null, lastOdd: null });
      this._roundOrder.push(sid);
      if (this._roundOrder.length > 500) { const old = this._roundOrder.shift(); this._rounds.delete(old); }
    } else {
      const rec = this._rounds.get(sid); rec.state = ROUND_STATE.OPEN; rec.open = rec.open || iso;
    }
    // SID history is diagnostic only — never used to predict the next sid.
    if (!this._sidSeen.has(sid)) {
      this._sidSeen.add(sid);
      const prev = this._sidHistory.length ? this._sidHistory[this._sidHistory.length - 1].sid : null;
      const delta = (prev != null && Number.isFinite(Number(sid)) && Number.isFinite(Number(prev))) ? Number(sid) - Number(prev) : null;
      this._sidHistory.push({ sid, delta, at: iso });
      if (this._sidHistory.length > 500) this._sidHistory.shift();
    }
    this.emit('round', this.currentRound());
  }

  _transition(sid, state, at, patch = {}) {
    const iso = isoOrNow(at);
    // Only advance the CurrentRound if the frame refers to it (or carries no sid).
    if (this._current && (sid == null || String(sid) === String(this._current.sid))) {
      this._current.state = state;
      this._current.updatedAt = iso;
      if (patch.lastOdd != null) this._current.lastOdd = patch.lastOdd;
      if (patch.closedAt) this._current.closedAt = patch.closedAt;
      this.emit('round', this.currentRound());
    }
    const roundSid = sid != null ? sid : (this._current ? this._current.sid : null);
    if (roundSid != null && this._rounds.has(roundSid)) {
      const rec = this._rounds.get(roundSid);
      rec.state = state;
      if (patch.lockedAt && !rec.locked) rec.locked = patch.lockedAt;
      if (patch.runningAt && !rec.running) rec.running = patch.runningAt;
      if (patch.endedAt) rec.ended = patch.endedAt;
      if (patch.lastOdd != null) rec.lastOdd = patch.lastOdd;
    }
  }

  // ---- ActionTrace: client frame -> server ack correlation (WU7 §12/§14) ----
  _recordSentAction(cls, at) {
    if (cls.cmd !== CMD.BET && cls.cmd !== CMD.CASHOUT) return;
    const rec = { id: `atr_${this._seq}`, cmd: cls.cmd, type: cls.type, sid: cls.sid, b: cls.b, aid: cls.aid, eid: cls.eid, sentAt: at, sentIso: isoOrNow(at), ackedAt: null, ack: null };
    this._pendingActions.push(rec);
    this._actionTraces.push(rec);
    if (this._actionTraces.length > 500) this._actionTraces.shift();
    this._gcPending(at);
    this.emit('actiontrace', { ...rec });
  }

  _tryAck(cls, at) {
    if (cls.cmd !== CMD.BET && cls.cmd !== CMD.CASHOUT) return;
    this._gcPending(at);
    for (let i = 0; i < this._pendingActions.length; i++) {
      const p = this._pendingActions[i];
      if (p.ack) continue;
      if (p.cmd !== cls.cmd) continue;
      // Correlate by command (+ eid when both carry it), within the ack window —
      // never by full payload equality (WU7 §14).
      if (p.eid != null && cls.eid != null && String(p.eid) !== String(cls.eid)) continue;
      p.ackedAt = at; p.ackIso = isoOrNow(at); p.ack = { cmd: cls.cmd, b: cls.b, wm: cls.wm, odd: cls.odd, aid: cls.aid, eid: cls.eid, raw: cls.raw };
      this._pendingActions.splice(i, 1);
      this.emit('actiontrace', { ...p });
      return;
    }
  }

  _gcPending(now) {
    const cutoff = now - this._ackWindowMs;
    this._pendingActions = this._pendingActions.filter((p) => p.sentAt >= cutoff);
  }
}

function isoOrNow(at) { try { return new Date(at).toISOString(); } catch { return new Date().toISOString(); } }

module.exports = { RoundTracker, classifyFrame, CMD, CMD_TYPE, ROUND_STATE };
