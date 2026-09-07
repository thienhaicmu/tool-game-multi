'use strict';

// ---------------------------------------------------------------------------
// PURE, PASSIVE Aviator frame classification (extracted from aviator.cjs, M2).
//
// This module is the SOURCE OF TRUTH for the observed Aviator protocol command
// set and for turning one raw WebSocket text frame into a canonical descriptor.
// It is deliberately PURE and PASSIVE:
//   - no WebSocket send, no sendRaw/sendProtocol
//   - no BET / CASHOUT / ENTER sender
//   - no AutoRunner / Harness / ACK orchestration
//   - no dependency on any action-bearing module (no requires at all)
//
// Both products consume this: Aviator Control Studio (via aviator.cjs, which
// re-exports these symbols so existing callers stay API-compatible) and Aviator
// Analytics (which uses ONLY this module for passive frame interpretation).
//
// Only commands that were actually captured are recognised; everything else
// stays UNKNOWN and is never dropped. No undocumented fields are invented here.
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
    // WU-C.3: authoritative Jackpot telemetry. Observed live as eI.jp on the server
    // (recv) protocol payload; surfaced verbatim (no scaling — the raw value maps
    // directly to the displayed jackpot). Undefined when the frame carries no eI.jp.
    jp: (json.eI && typeof json.eI === 'object' && json.eI.jp != null && Number.isFinite(Number(json.eI.jp))) ? Number(json.eI.jp) : undefined,
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

module.exports = { CMD, CMD_TYPE, ROUND_STATE, classifyFrame, wirePrefixFor, parseFrameJson, protocolPayload };
