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

const { classifyPhomFrame } = require('./phom-frame-classify.cjs');

const SECRET_KEY = /pass|pwd|token|sess|secret|auth|cookie|sig/i;
const REDACTED = '[redacted]';
const DEFAULT_MAX_FRAMES = 4000;
const DEFAULT_MAX_FRAME_CHARS = 65536;

function redactValue(v) {
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = SECRET_KEY.test(k) ? REDACTED : redactValue(v[k]);
    return out;
  }
  return v;
}

// Redact one raw frame. Non-JSON frames are kept only as a length marker (they are not Phỏm protocol and
// could carry anything).
function redactFrame(raw) {
  const text = raw == null ? '' : String(raw);
  let json;
  try { json = JSON.parse(text.trim()); } catch { return { raw: null, note: `non-JSON frame (${text.length} chars)` }; }
  let clean = redactValue(json);
  // op 3 JOIN request: [3, zone, roomId, password] — the password is positional, not keyed
  if (Array.isArray(clean) && clean[0] === 3 && typeof clean[1] === 'string' && clean.length > 3) {
    clean = clean.slice(); clean[3] = clean[3] === '' ? '' : REDACTED;
  }
  return { raw: JSON.stringify(clean), note: null };
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

    // runIds: array of browser run ids to record, or null/empty for every browser.
    start({ runIds = null, label = null } = {}) {
      const ids = Array.isArray(runIds) && runIds.length ? new Set(runIds.map(String)) : null;
      session = { runIds: ids, label: label != null ? String(label) : null, startedAt: now(), frames: [], dropped: 0 };
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
      const { raw, note } = redactFrame(clipped ? text.slice(0, maxChars) : text);
      session.frames.push({
        t: now() - session.startedAt, runId: String(runId), label: frame.label != null ? String(frame.label) : null,
        direction, url: frame.url || null,
        summary: raw ? summarize(raw, direction) : `${direction === 'send' ? '→ GỬI' : '← NHẬN'} ${note}`,
        raw, clipped,
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
