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
// The Phỏm product / entry action id (== the NewLobby Cocos tile node name). This is the VERIFIED
// id used to enter Phỏm via the site's own in-engine action (same mechanism as Aviator's node),
// NOT a URL/deep-link and NOT a guessed selector.
const GAME_ID = 'vgcg_8';

// Confirmed command set. Names are stable semantic labels for UI / evidence.
const CMD = Object.freeze({
  SELF_IDENTITY: 100,  // server push of the OWN session identity (uid + own wallet As) — live-captured
  SEAT_UPDATE: 200,    // server push: ONE player took/updated a seat at THIS table ({p:{seat}, t}) — live-captured
  CHANNEL_LIST: 300,   // client asks for stake channels; server replies with rs[]
  CREATE_TABLE: 308,   // client creates a table ("TẠO BÀN"); server replies {ri:{rid,b,Mu,pwd}} or {mgs}
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
  [CMD.CREATE_TABLE]: 'CREATE_TABLE_REQUEST',
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
  'CHANNEL_LIST', 'FIND_TABLE', 'TABLE_STATE', 'SEAT_UPDATE', 'DEAL', 'PLAY', 'DRAW', 'ROUND_END', 'MELD',
  'SELF_IDENTITY', 'CREATE_TABLE_RESULT',
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
    // op 3 has TWO live-captured shapes distinguished by element [1]:
    //   client request  [3,"Simms",139,""]     — [1] is the zone STRING; [2] the join code
    //   server response  [3,true,0,-1,null]     — [1] is a BOOLEAN success flag
    // The server ack alone is NOT proof of table membership — the authoritative proof is the
    // ensuing TABLE_STATE ps[] push carrying own uid + sit. So neither op-3 shape is server
    // evidence for socket binding (only TABLE_STATE / other pushes are).
    if (typeof json[1] === 'boolean') {
      // Test D capture (2026-09-19): a refusal carries a code and a human message —
      //   [3,false,100,-1,"Phòng đầy"]   [3,false,104,-1,"Phòng đã bị hủy"]
      // so a rejected JOIN can fail FAST with the server's own reason instead of waiting for a
      // TABLE_STATE that will never come.
      return finalize(out, {
        type: 'JOIN_ACCEPTED', accepted: json[1],
        resultCode: Number.isFinite(json[2]) ? json[2] : null,
        resultMessage: typeof json[4] === 'string' && json[4] ? json[4] : null,
      });
    }
    // The numeric arg is the SmartFoxServer room-join code (live capture: 139). It is distinct
    // from the lobby stake-bucket rids in CHANNEL_LIST rs[] (141/142/320872 observed same
    // session) — physical membership is confirmed by TABLE_STATE, never by this send. Password
    // stays opaque.
    return finalize(out, {
      type: 'JOIN_REQUEST',
      channel: Number.isFinite(json[2]) ? json[2] : (json[2] != null ? Number(json[2]) : null),
      hasPassword: typeof json[3] === 'string' && json[3].length > 0,
    });
  }
  if (op === OP.LEAVE) {
    // Test D capture: the SERVER answers a leave with [4,true,<code>,-1,0,""] — it was classified as a
    // LEAVE_REQUEST. It is the proof that the player is out of the table (code 1 = left on request, code 2 =
    // moved out because a new JOIN was sent while seated).
    if (typeof json[1] === 'boolean') {
      return finalize(out, { type: 'LEAVE_ACK', accepted: json[1], resultCode: Number.isFinite(json[2]) ? json[2] : null, resultMessage: typeof json[5] === 'string' && json[5] ? json[5] : null });
    }
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
    // Server -> client. IMPORTANT (live-captured): a server RESPONSE echoes the request cmd —
    // the channel-list reply is [5,{rs:[...],cmd:300}], i.e. it carries cmd:300 (the same code
    // as the CLIENT request). So the STRUCTURAL server payload (rs[]/ps[]/b+mB) is authoritative
    // and MUST be checked BEFORE the CMD_TYPE map (which holds CLIENT-request semantics).
    // Otherwise the channel-list reply is misread as CHANNEL_LIST_REQUEST and misses server
    // evidence (the PHASE-2 blocker).
    // The shared socket also carries other games' rs[] (observed cmd:2011).
    // A known foreign command cannot become Phỏm evidence just by its shape.
    if (payload && Array.isArray(payload.rs) && (cmd == null || cmd === CMD.CHANNEL_LIST)) return finalize(out, { type: 'CHANNEL_LIST' });
    if (payload && Array.isArray(payload.ps) && (cmd == null || cmd === 202)) return finalize(out, { type: 'TABLE_STATE' });
    if (payload && Array.isArray(payload.b) && payload.mB !== undefined) return finalize(out, { type: 'FIND_TABLE' });
    // CREATE_TABLE reply (game client onReceiveQuickPlay): ri = the NEW table ({rid,b,sid,Mu,gid,pwd}); no ri →
    // refused, with the server's reason in mgs (e.g. not enough gold). ri.rid is the table's số bàn.
    if (cmd === CMD.CREATE_TABLE && payload) {
      const ri = payload.ri && typeof payload.ri === 'object' ? payload.ri : null;
      const rid = ri && Number.isFinite(Number(ri.rid)) ? Number(ri.rid) : null;
      return finalize(out, {
        type: 'CREATE_TABLE_RESULT', ok: rid != null, rid,
        stake: ri && Number.isFinite(Number(ri.b)) ? Number(ri.b) : null,
        maxPlayers: ri && Number.isFinite(Number(ri.Mu)) ? Number(ri.Mu) : null,
        hasPassword: !!(ri && typeof ri.pwd === 'string' && ri.pwd.length > 0),
        message: typeof payload.mgs === 'string' && payload.mgs ? payload.mgs : null,
      });
    }
    // In-table pushes (live capture 2026-09-21T12-06): [5,{uid,dn,cmd:5}] = that player is READY (the host's START is
    // the same cmd 5 — Phỏm's TableCommand.START === READY === 5); [5,{uid,dn,cmd:203}] = the table's HOST changed.
    if (cmd === 5 && payload && payload.uid != null && typeof json[1] === 'object') return finalize(out, { type: 'USER_READY', uid: String(payload.uid) });
    if (cmd === 203 && payload && payload.uid != null) return finalize(out, { type: 'HOST_CHANGED', uid: String(payload.uid) });
    // Single-seat delta (live-captured [5,{p:{...seat...},t:1,cmd:200}]): ONE player took/updated a
    // seat at THIS table. `p` is a single seat object (same shape as a ps[] entry); `t===1` = present
    // (joined). This is how an EARLY joiner learns about LATER joiners (the full ps[] snapshot only
    // arrives on one's own join), so it MUST be folded into table state. Removal (t!==1) is not yet
    // evidenced, so only presence is surfaced here.
    if (cmd === CMD.SEAT_UPDATE && payload && payload.p && typeof payload.p === 'object' && !Array.isArray(payload.p)) {
      return finalize(out, { type: 'SEAT_UPDATE', seat: payload.p, present: payload.t === 1, t: payload.t });
    }
    // Own-session identity push (live-captured [5,{uid,u,As:{gold},dn,cmd:100,id}]): carries the
    // authoritative own uid. `As` (own wallet) marks it as THIS session's identity, not a peer's.
    if (cmd === CMD.SELF_IDENTITY && (payload.uid != null || payload.u != null) && payload.As != null) {
      // Live capture shows TWO cmd:100 forms: the authoritative game identity (id:0, uid "<aid>_<n>"
      // — the SAME form used in ps[]) and a session-token identity (id:1, token uid + As.time). Surface
      // `id` so the context binds only the authoritative game uid (never the token, which races ahead).
      return finalize(out, { type: 'SELF_IDENTITY', uid: payload.uid != null ? payload.uid : payload.u, identityId: payload.id });
    }
    // Recognised game-event pushes (DEAL 850 / PLAY 851 / DRAW 852 / ROUND_END 853 / MELD 854).
    if (cmd != null && CMD_TYPE[cmd]) return finalize(out, { type: CMD_TYPE[cmd] });
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
    accepted: extra.accepted !== undefined ? extra.accepted : undefined,
    resultCode: extra.resultCode !== undefined ? extra.resultCode : undefined,
    resultMessage: extra.resultMessage !== undefined ? extra.resultMessage : undefined,
    // identity / seat-delta fields
    identityId: extra.identityId !== undefined ? extra.identityId : undefined,
    seat: extra.seat !== undefined ? extra.seat : undefined,     // single seat object (SEAT_UPDATE)
    present: extra.present !== undefined ? extra.present : undefined,
    t: extra.t !== undefined ? extra.t : undefined,
    // CREATE_TABLE_RESULT fields
    ok: extra.ok !== undefined ? extra.ok : undefined,
    rid: extra.rid !== undefined ? extra.rid : undefined,
    stake: extra.stake !== undefined ? extra.stake : undefined,
    maxPlayers: extra.maxPlayers !== undefined ? extra.maxPlayers : undefined,
    message: extra.message !== undefined ? extra.message : undefined,
    // identity / table fields (surfaced verbatim; undefined when absent)
    aid: p.aid !== undefined ? p.aid : undefined,
    uid: extra.uid !== undefined ? extra.uid : (p.uid !== undefined ? p.uid : undefined),
    gid: p.gid !== undefined ? p.gid : undefined,
    b: p.b !== undefined ? p.b : undefined,
    rs: Array.isArray(p.rs) ? p.rs : undefined,
    ps: Array.isArray(p.ps) ? p.ps : undefined,
    // TABLE_STATE routing tokens (Test D 2026-09-19): `hpwd` is the table's room CODE that another browser
    // JOINs with to land at THIS exact table; `cP` is the table/owner id. Surfaced verbatim so the follower
    // JOIN can carry the anchor's code (the protocol's positional [3,zone,rid,CODE] field).
    hpwd: typeof p.hpwd === 'string' ? p.hpwd : undefined,
    cP: p.cP !== undefined ? p.cP : undefined,
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
    host: entry.C === true, // ps[].C — the table owner ("chủ bàn"), the one who must press BẮT ĐẦU
    raw: entry,
  };
}

module.exports = {
  ZONE, GID, GAME_ID, CMD, OP, CMD_TYPE, HAND_EVENT_TYPES, SERVER_EVIDENCE_TYPES,
  classifyPhomFrame, normalizeChannel, normalizeSeat,
};
