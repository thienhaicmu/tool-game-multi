'use strict';

// ---------------------------------------------------------------------------
// PURE, PASSIVE Phỏm (game_id vgcg_8 / gid 8 / namespace "Simms") frame
// classification. Mirrors the Aviator frame-classify.cjs contract: one raw
// WebSocket text frame -> one canonical descriptor. Deliberately PURE + PASSIVE:
//   - no WebSocket send, no join/ready/leave sender
//   - no dependency on any action-bearing module
//   - never throws: malformed / non-JSON / binary frames -> { known:false }
//
// Only commands actually captured in the evidence (phom.log / play2.log / the
// IMG_*.MOV protocol traces) are recognised; everything else stays UNKNOWN and
// is never dropped. No undocumented fields are invented.
//
// Wire format (SmartFoxServer-style array with a numeric opcode head):
//   [3,"Simms",<rid>,"<pwd>"]                     op 3  JOIN room request  (client)
//   [4,"Simms",<rid>]                             op 4  LEAVE room request (client)
//   [5,{...}]                                     op 5  extension/room push (server)
//   [6,"Simms","channelPlugin",{cmd:...}]         op 6  extension request  (client)
// ---------------------------------------------------------------------------

const ZONE = 'Simms';
const GID = 8;

// Confirmed command set. Names are stable semantic labels for UI / evidence.
const CMD = Object.freeze({
  CHANNEL_LIST: 300,   // client asks for stake channels; server replies with rs[]
  FIND_TABLE: 311,     // client quick-find; server replies { b:[], mB }
  READY: 363,          // client marks ready (aRd:"true")
  DEAL: 850,           // server deals the opening 9 cards (cs[]) — per-session authoritative
  PLAY: 851,           // a player discards (fP.dCs) and the turn moves to tP.uid
  DRAW: 852,           // a player draws (cs single); own session also gets sAC/sMs
  END: 853,            // round end / eaten / won — carries subtypes
  MELD: 854,           // public meld laid down (mes[].cs)
});

// Wire opcodes.
const OP = Object.freeze({ JOIN: 3, LEAVE: 4, PUSH: 5, EXT_REQUEST: 6 });

const CMD_TYPE = Object.freeze({
  [CMD.CHANNEL_LIST]: 'CHANNEL_LIST_REQUEST',
  [CMD.FIND_TABLE]: 'FIND_TABLE_REQUEST',
  [CMD.READY]: 'READY_REQUEST',
  [CMD.DEAL]: 'DEAL',
  [CMD.PLAY]: 'PLAY',
  [CMD.DRAW]: 'DRAW',
  [CMD.END]: 'ROUND_END',
  [CMD.MELD]: 'MELD',
});

// Types that mutate a per-profile hand model (consumed by hand-reducer).
const HAND_EVENT_TYPES = Object.freeze(new Set(['DEAL', 'PLAY', 'DRAW', 'ROUND_END', 'MELD']));

// A frame carries authoritative Phỏm SERVER evidence (used to bind the owning
// game socket) when it is a recognised server push for this game.
const SERVER_EVIDENCE_TYPES = Object.freeze(new Set([
  'CHANNEL_LIST', 'FIND_TABLE', 'TABLE_STATE', 'DEAL', 'PLAY', 'DRAW', 'ROUND_END', 'MELD',
]));

function base(raw) {
  return { raw: raw == null ? '' : String(raw), json: null, op: null, cmd: null, type: 'UNKNOWN', known: false, isServerEvidence: false, isHandEvent: false, zone: null, payload: null };
}

/**
 * classifyPhomFrame(raw) — parse one WebSocket text frame payload into a canonical
 * descriptor. Pure and total.
 */
function classifyPhomFrame(raw) {
  const out = base(raw);
  let json;
  try { json = JSON.parse(String(out.raw).trim()); } catch { return out; }
  out.json = json;
  if (!Array.isArray(json) || json.length === 0) return out;

  const op = Number.isFinite(json[0]) ? json[0] : null;
  out.op = op;
  const payload = firstObject(json);
  out.payload = payload;
  // zone (namespace) appears as the 2nd element on op 3/4/6 frames.
  if (typeof json[1] === 'string') out.zone = json[1];

  // ---- client request frames (no server cmd) ----
  if (op === OP.JOIN) {
    // [3,"Simms",<rid>,"<pwd>"] — the numeric arg is a stake/CHANNEL code, NOT a
    // physical table id (server assigns the physical table). Password stays opaque.
    return finalize(out, {
      type: 'JOIN_REQUEST',
      channel: Number.isFinite(json[2]) ? json[2] : (json[2] != null ? Number(json[2]) : null),
      hasPassword: typeof json[3] === 'string' && json[3].length > 0,
    });
  }
  if (op === OP.LEAVE) {
    return finalize(out, { type: 'LEAVE_REQUEST', channel: Number.isFinite(json[2]) ? json[2] : null });
  }

  // ---- extension request / server push carrying an object payload ----
  const cmdRaw = payload && payload.cmd != null ? Number(payload.cmd) : null;
  const cmd = Number.isFinite(cmdRaw) ? cmdRaw : null;
  out.cmd = cmd;

  if (op === OP.EXT_REQUEST) {
    // Client -> server extension request. cmd tells us which.
    if (cmd != null && CMD_TYPE[cmd]) return finalize(out, { type: CMD_TYPE[cmd], plugin: typeof json[2] === 'string' ? json[2] : null });
    return finalize(out, { type: 'UNKNOWN', plugin: typeof json[2] === 'string' ? json[2] : null });
  }

  if (op === OP.PUSH) {
    // Server -> client. May be a cmd game event, a channel list (rs[]), a
    // find-table reply (b array + mB), or an authoritative table state (ps[]).
    if (cmd != null && CMD_TYPE[cmd]) return finalize(out, { type: CMD_TYPE[cmd] });
    if (payload && Array.isArray(payload.rs)) return finalize(out, { type: 'CHANNEL_LIST' });
    if (payload && Array.isArray(payload.ps)) return finalize(out, { type: 'TABLE_STATE' });
    if (payload && Array.isArray(payload.b) && payload.mB !== undefined) return finalize(out, { type: 'FIND_TABLE' });
    return finalize(out, { type: 'UNKNOWN' });
  }

  return out;
}

// Attach the semantic type + surfaced protocol fields (undefined when absent).
function finalize(out, extra) {
  const p = out.payload || {};
  const type = extra.type || 'UNKNOWN';
  return {
    raw: out.raw,
    json: out.json,
    op: out.op,
    zone: out.zone,
    plugin: extra.plugin !== undefined ? extra.plugin : undefined,
    cmd: out.cmd,
    type,
    known: type !== 'UNKNOWN',
    isServerEvidence: SERVER_EVIDENCE_TYPES.has(type),
    isHandEvent: HAND_EVENT_TYPES.has(type),
    // request-frame fields
    channel: extra.channel !== undefined ? extra.channel : undefined,
    hasPassword: extra.hasPassword !== undefined ? extra.hasPassword : undefined,
    // identity / table fields (surfaced verbatim; undefined when absent)
    aid: p.aid !== undefined ? p.aid : undefined,
    uid: p.uid !== undefined ? p.uid : undefined,
    gid: p.gid !== undefined ? p.gid : undefined,
    b: p.b !== undefined ? p.b : undefined,
    rs: Array.isArray(p.rs) ? p.rs : undefined,
    ps: Array.isArray(p.ps) ? p.ps : undefined,
    mB: p.mB !== undefined ? p.mB : undefined,
    // gameplay fields (surfaced verbatim)
    cs: p.cs !== undefined ? p.cs : undefined,      // array (DEAL) or single (DRAW)
    sAC: Array.isArray(p.sAC) ? p.sAC : undefined,  // server-arranged full hand (own session)
    sMs: Array.isArray(p.sMs) ? p.sMs : undefined,  // server-computed meld cards (own session)
    lpi: p.lpi !== undefined ? p.lpi : undefined,   // turn order
    tP: p.tP !== undefined ? p.tP : undefined,      // { uid } whose turn is next
    fP: p.fP !== undefined ? p.fP : undefined,      // { uid, dCs, lm } acting player
    mes: Array.isArray(p.mes) ? p.mes : undefined,  // public melds [{ meid, cs }]
    mX: p.mX !== undefined ? p.mX : undefined,
    m: p.m !== undefined ? p.m : undefined,
    mes_present: Array.isArray(p.mes),
  };
}

// The first plain (non-array) object element of a wire array, or null.
function firstObject(arr) {
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) return item;
  }
  return null;
}

// Normalize a channel/room descriptor from a CHANNEL_LIST rs[] entry. Preserves
// every observed field verbatim — never rejects uC just because it exceeds Mu.
function normalizeChannel(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    rid: entry.rid != null ? entry.rid : null,
    rn: entry.rn != null ? String(entry.rn) : null,
    gid: entry.gid != null ? entry.gid : null,
    b: entry.b != null ? entry.b : null,
    mM: entry.mM != null ? entry.mM : null,
    Mu: entry.Mu != null ? entry.Mu : null,
    uC: entry.uC != null ? entry.uC : null,
    hpwd: entry.hpwd === true,
    zn: entry.zn != null ? String(entry.zn) : null,
    raw: entry,
  };
}

// Normalize a table-state ps[] entry into a seat record. dn (display name) is
// preserved but callers may redact it before persistence.
function normalizeSeat(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.sit == null && entry.uid == null) return null;
  return {
    sit: entry.sit != null ? entry.sit : null,
    uid: entry.uid != null ? String(entry.uid) : null,
    dn: entry.dn != null ? String(entry.dn) : null,
    m: entry.m != null ? entry.m : null,
    ready: entry.r === true,
    raw: entry,
  };
}

module.exports = {
  ZONE, GID, CMD, OP, CMD_TYPE, HAND_EVENT_TYPES, SERVER_EVIDENCE_TYPES,
  classifyPhomFrame, normalizeChannel, normalizeSeat,
};
