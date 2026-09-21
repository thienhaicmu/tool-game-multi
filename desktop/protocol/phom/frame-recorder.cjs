'use strict';

// ---------------------------------------------------------------------------
// TEST D — FRAME RECORDER. Records the WebSocket frames of ONE browser (or all) between a user-driven
// START and STOP, so we can see exactly what the GAME CLIENT itself sends and receives when a player clicks
// a table by hand — the evidence that decides how TÌM BÀN should enter a table, instead of guessing.
//
// PASSIVE: it never sends anything. It sees the same frames the capture hook already routes to the
// coordinator. Bounded (frame count + per-frame size) so a forgotten recording cannot grow without limit.
//
// REDACTION: secrets are removed BEFORE a frame is stored — the join password (element 3 of an op-3 JOIN)
// and the value of any key that looks like a credential (pass/pwd/token/session/secret/auth/cookie/sig).
// Account ids and display names are kept on purpose: they are what shows who sat where.
// ---------------------------------------------------------------------------

const { randomBytes, createHmac } = require('node:crypto');
const { classifyPhomFrame } = require('./phom-frame-classify.cjs');

const SECRET_KEY = /pass|pwd|token|sess|secret|auth|cookie|sig|roomcode|sharedcode|hostkey|^key$/i;
// TABLE-ROUTING tokens, NOT user credentials: `hpwd` (a table's host/room password) and the positional JOIN
// room-code are exactly what decides WHICH table you land in — the evidence a private-table co-seat needs. When
// `keepRoomCodes` is set (Test D "giữ mã bàn" mode) these are preserved while real credentials (accessToken /
// sessionId / cookie / sig) are STILL redacted by SECRET_KEY. Default OFF, so an ordinary capture stays fully redacted.
const KEEP_ROOM_KEY = /^hpwd$/i;
const REDACTED = '[redacted]';
const DEFAULT_MAX_FRAMES = 4000;
const DEFAULT_MAX_FRAME_CHARS = 65536;

function redactValue(v, keep) {
  if (Array.isArray(v)) return v.map((x) => redactValue(x, keep));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      const isKept = keep && KEEP_ROOM_KEY.test(k);
      out[k] = (SECRET_KEY.test(k) && !isKept) ? REDACTED : redactValue(v[k], keep);
    }
    return out;
  }
  return v;
}

// Redact one raw frame. Non-JSON frames are kept only as a length marker (they are not Phỏm protocol and
// could carry anything). `opts.keepRoomCodes` preserves the table-routing tokens (see KEEP_ROOM_KEY).
function redactFrame(raw, opts = {}) {
  const keep = !!opts.keepRoomCodes;
  const text = raw == null ? '' : String(raw);
  let json;
  try { json = JSON.parse(text.trim()); } catch { return { raw: null, note: `non-JSON frame (${text.length} chars)` }; }
  let clean = redactValue(json, keep);
  // Positional login token and the token-shaped cmd:100 identity must also be
  // removed, including when a diagnostic capture preserves room passwords.
  if (Array.isArray(clean) && clean[0] === 1 && typeof clean[1] === 'boolean' && clean.length > 3) clean[3] = REDACTED;
  if (Array.isArray(clean) && clean[0] === 5 && clean[1] && clean[1].cmd === 100 && clean[1].id === 1) {
    if ('uid' in clean[1]) clean[1].uid = REDACTED;
    if ('u' in clean[1]) clean[1].u = REDACTED;
  }
  // op 3 JOIN request: [3, zone, roomId, roomCode] — the room-code is positional, not keyed. It is the token
  // that routes a JOIN to a specific (private) table, so keepRoomCodes preserves it; otherwise it is redacted.
  if (Array.isArray(clean) && clean[0] === 3 && typeof clean[1] === 'string' && clean.length > 3) {
    clean = clean.slice(); clean[3] = (clean[3] === '' || keep) ? clean[3] : REDACTED;
  }
  return { raw: JSON.stringify(clean), note: null };
}

// Per-recording keyed references permit equality checks without exposing a reusable hash
// of a short password. The random HMAC key stays in memory and is never exported.
function roomEvidence(raw, direction, key) {
  let packet;
  try { packet = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(packet)) return [];
  const evidence = [];
  const add = (path, value, rid = null) => {
    const kind = value === null ? 'null' : typeof value;
    const item = { path, kind, rid };
    if (typeof value === 'string') {
      item.empty = value.length === 0;
      if (value && value !== REDACTED) item.ref = createHmac('sha256', key).update(value, 'utf8').digest('hex');
    }
    evidence.push(item);
  };
  if (direction === 'send' && packet[0] === 3 && typeof packet[1] === 'string') add('$[3]', packet[3], packet[2]);
  if (direction === 'recv' && packet[0] === 5) {
    const body = packet[1];
    if (body?.cmd === 202 && Object.hasOwn(body, 'hpwd')) add('$[1].hpwd', body.hpwd);
    if (body?.cmd === 300 && Array.isArray(body.rs)) body.rs.forEach((row, i) => {
      if (row && Object.hasOwn(row, 'hpwd')) add(`$[1].rs[${i}].hpwd`, row.hpwd, row.rid ?? null);
    });
  }
  return evidence;
}

// A one-line human summary of a frame, so the file reads as a story (who asked what, what came back).
function summarize(raw, direction) {
  const cls = classifyPhomFrame(raw);
  const arrow = direction === 'send' ? '→ GỬI' : '← NHẬN';
  const parts = [arrow, cls.type || 'UNKNOWN'];
  if (cls.op != null) parts.push(`op=${cls.op}`);
  if (cls.cmd != null) parts.push(`cmd=${cls.cmd}`);
  if (cls.type === 'JOIN_REQUEST' && cls.channel != null) parts.push(`room=${cls.channel}`);
  if (cls.type === 'JOIN_ACCEPTED') parts.push(`accepted=${cls.accepted}`);
  if (Array.isArray(cls.rs)) {
    parts.push(`rs=${cls.rs.length}`);
    parts.push(cls.rs.slice(0, 12).map((r) => `[rid ${r.rid} b ${r.b} ${r.uC}/${r.Mu}]`).join(' '));
  }
  if (Array.isArray(cls.ps)) parts.push(`ps=${cls.ps.length} b=${cls.b}`);
  if (cls.type === 'FIND_TABLE') parts.push(`b=${JSON.stringify(cls.b)} mB=${JSON.stringify(cls.mB)}`);
  return parts.join(' ');
}

function createFrameRecorder(opts = {}) {
  const maxFrames = opts.maxFrames != null ? Number(opts.maxFrames) : DEFAULT_MAX_FRAMES;
  const maxChars = opts.maxFrameChars != null ? Number(opts.maxFrameChars) : DEFAULT_MAX_FRAME_CHARS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let session = null; // { runIds:Set|null, label, startedAt, frames:[], dropped }

  return {
    isRecording() { return !!session; },
    status() { return session ? { recording: true, label: session.label, runIds: session.runIds ? [...session.runIds] : null, frames: session.frames.length, dropped: session.dropped, startedAt: session.startedAt } : { recording: false }; },

    // runIds: array of browser run ids to record, or null/empty for every browser. keepRoomCodes: preserve the
    // table-routing tokens (hpwd + positional JOIN room-code) for a private-table co-seat investigation.
    start({ runIds = null, label = null, keepRoomCodes = false } = {}) {
      const ids = Array.isArray(runIds) && runIds.length ? new Set(runIds.map(String)) : null;
      session = { evidenceKey: randomBytes(32), runIds: ids, label: label != null ? String(label) : null, keepRoomCodes: !!keepRoomCodes, startedAt: now(), frames: [], dropped: 0 };
      return this.status();
    },

    // Called from the capture hook for EVERY WebSocket frame; cheap when idle.
    record(runId, frame = {}) {
      if (!session) return false;
      if (session.runIds && !session.runIds.has(String(runId))) return false;
      if (session.frames.length >= maxFrames) { session.dropped += 1; return false; }
      const direction = frame.direction === 'send' ? 'send' : 'recv';
      const text = frame.raw == null ? '' : String(frame.raw);
      const clipped = text.length > maxChars;
      const { raw, note } = redactFrame(clipped ? text.slice(0, maxChars) : text, { keepRoomCodes: session.keepRoomCodes });
      session.frames.push({
        t: now() - session.startedAt, runId: String(runId), label: frame.label != null ? String(frame.label) : null,
        direction, url: frame.url || null,
        summary: raw ? summarize(raw, direction) : `${direction === 'send' ? '→ GỬI' : '← NHẬN'} ${note}`,
        raw, clipped,
        roomEvidence: clipped ? [] : roomEvidence(text, direction, session.evidenceKey),
      });
      return true;
    },

    // Ends the recording and returns everything captured (the caller writes it to a file).
    stop() {
      if (!session) return null;
      const s = session; session = null;
      const byType = {};
      for (const f of s.frames) { const k = (f.summary || '').split(' ').slice(0, 3).join(' '); byType[k] = (byType[k] || 0) + 1; }
      return {
        kind: 'PHOM_FRAME_CAPTURE', version: 1, label: s.label,
        startedAt: s.startedAt, durationMs: now() - s.startedAt,
        runIds: s.runIds ? [...s.runIds] : null,
        frameCount: s.frames.length, dropped: s.dropped, byType,
        frames: s.frames,
      };
    },
  };
}

module.exports = { createFrameRecorder, redactFrame, summarize, SECRET_KEY };
