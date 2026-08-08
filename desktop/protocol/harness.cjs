'use strict';

const EventEmitter = require('node:events');
const { randomUUID } = require('node:crypto');
const { CODES } = require('../cdp/errors.cjs');
const { classifyFrame, CMD } = require('./aviator.cjs');
const { environmentGuardEnabled } = require('./environment-gate.cjs');

// Test-environment safety gate (WU7 §3). Request control activates ONLY when the
// target host matches an explicit QA/staging allowlist. Defaults are local-only;
// operators extend via OBSERVATORY_TEST_HOSTS. Patterns:
//   exact host  "localhost"          -> host === pattern
//   suffix      "*.staging.acme.io"  -> host ends with ".staging.acme.io"
//   keyword     "staging"            -> host contains "staging" (no dot in pattern)
const DEFAULT_ALLOWLIST = ['localhost', '127.0.0.1', '::1', '[::1]'];

function normalizeAllowlist(list) {
  return (Array.isArray(list) ? list : String(list || '').split(','))
    .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host, patterns) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return patterns.some((p) => {
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)); // "*.x" -> endsWith ".x"
    if (p.includes('.') || p.includes(':')) return h === p; // exact host
    return h.includes(p); // bare keyword -> substring (e.g. "staging", "qa", "test")
  });
}

// Result of an ack-correlation attempt (WU7 §13).
const RESULT = Object.freeze({ ACK: 'ACK', REJECTED: 'REJECTED', TIMEOUT: 'TIMEOUT', ERROR: 'ERROR' });
const VERDICT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

// A server frame counts as an explicit rejection only if it carries an error
// signal — never merely because the client controlled a field (WU7 §18).
function isRejectFrame(cls) {
  const j = cls && cls.json;
  if (!j || typeof j !== 'object') return false;
  if (j.err || j.error) return true;
  if (j.ok === false || j.success === false) return true;
  if (typeof j.code === 'number' && j.code !== 0 && j.cmd == null) return true;
  return false;
}

/**
 * ProtocolHarness — authorized QA sender for observed Aviator WebSocket flows.
 * OBSERVE -> BUILD -> MODIFY -> SEND (in an authorized session) -> RECORD ack/error
 * -> VERIFY server validation. It never predicts rounds, never automates wagering,
 * and only sends through the page's own authenticated socket via the `send` seam.
 *
 * Execution records are append-only evidence (WU7 §13). The in-flight record is
 * completed once with its response; prior records are never rewritten.
 *
 * Events: 'execution' (created / completed).
 */
class ProtocolHarness extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._round = deps.roundTracker;
    this._send = deps.send || (async () => ({ ok: false, error: { code: CODES.TEST_SESSION_UNAVAILABLE, message: 'No send seam configured' } }));
    this._getTargetUrl = deps.getTargetUrl || (() => '');
    this._allowlist = normalizeAllowlist(deps.allowlist && deps.allowlist.length ? deps.allowlist : DEFAULT_ALLOWLIST);
    this._environmentGuard = deps.environmentGuard == null ? environmentGuardEnabled() : deps.environmentGuard !== false;
    this._ackTimeoutMs = Number(deps.ackTimeoutMs || 8000);
    this._executions = [];      // append-only ProtocolTestExecution[]
    this._byId = new Map();
    this._waiters = [];         // pending ack correlations
    this._seq = 0;
    if (this._round && this._round.on) this._round.on('frame', (ev) => this._onFrame(ev));
  }

  allowlist() { return this._allowlist.slice(); }
  executions() { return this._executions.map((e) => ({ ...e })); }
  getExecution(id) { const e = this._byId.get(id); return e ? { ...e } : undefined; }

  // WU7 §3 — environment gate. Returns the visible enabled/disabled state.
  environmentFor(targetId) {
    const url = String(this._getTargetUrl(targetId) || '');
    let host = '';
    try { host = url ? new URL(url).hostname.toLowerCase() : ''; } catch { host = ''; }
    const matched = hostAllowed(host, this._allowlist);
    const allowed = !this._environmentGuard || matched;
    return { targetId: targetId != null ? String(targetId) : null, host, url, allowed, matched, guardEnabled: this._environmentGuard, requiresConfirmation: !this._environmentGuard && !matched, name: allowed ? host : null, label: allowed ? (this._environmentGuard ? 'TEST CONTROL — ENABLED' : 'ENVIRONMENT GUARD OFF') : 'CONTROL_DISABLED_FOR_TARGET' };
  }

  // WU7 §6 — templates for confirmed commands only, seeded with the CURRENT
  // server sid. Cashout deliberately carries NO `odd` field (WU7 §9).
  buildTemplate(command, overrides = {}) {
    const round = this._round && this._round.currentRound ? this._round.currentRound() : null;
    const sid = overrides.sid !== undefined ? overrides.sid : (round ? round.sid : null);
    const cmd = String(command).toLowerCase();
    if (cmd === 'bet') return { cmd: CMD.BET, b: overrides.b !== undefined ? overrides.b : 5000, sid, aid: overrides.aid !== undefined ? overrides.aid : 1, eid: overrides.eid !== undefined ? overrides.eid : 1 };
    if (cmd === 'cashout') return { cmd: CMD.CASHOUT, sid, aid: overrides.aid !== undefined ? overrides.aid : 1, eid: overrides.eid !== undefined ? overrides.eid : 1 };
    return null;
  }

  // WU7 §7 — never send from a guessed sid without an explicit negative-test flag.
  checkSid(draftSid) {
    const round = this._round && this._round.currentRound ? this._round.currentRound() : null;
    const current = round ? round.sid : null;
    const match = current != null && draftSid != null && String(current) === String(draftSid);
    return { current, draft: draftSid, match, warning: (!match && current != null) ? CODES.STALE_OR_MANUAL_SID : null };
  }

  /**
   * execute(opts) — build (if needed), validate, send and correlate a single test.
   * opts: {
   *   targetId, command?, payload? (object|json string), source?, negative?,
   *   expect? ('accept'|'reject'|null), allowMismatch?
   * }
   */
  async execute(opts = {}) {
    const targetId = opts.targetId != null ? String(opts.targetId) : null;
    const source = opts.source || (opts.negative ? 'NEGATIVE_TEST' : (opts.command && opts.payload == null ? 'TEMPLATE' : 'MANUAL'));
    const env = this.environmentFor(targetId);
    const warnings = [];

    // 1) Environment safety gate.
    if (!env.allowed) return this._fail({ targetId, source, environment: env, error: { code: CODES.CONTROL_DISABLED_FOR_TARGET, message: `Target host "${env.host || '(unknown)'}" is not in the QA/staging allowlist` }, warnings });

    // 2) Resolve the payload (explicit object/string, or a template).
    let payload = opts.payload;
    if (payload == null && opts.command) payload = this.buildTemplate(opts.command, opts.overrides || {});
    let obj;
    if (payload && typeof payload === 'object') obj = payload;
    else { try { obj = JSON.parse(String(payload)); } catch { return this._fail({ targetId, source, environment: env, error: { code: CODES.INVALID_TEST_REQUEST, message: 'Payload is not valid JSON' }, warnings }); } }
    if (!obj || typeof obj !== 'object' || obj.cmd == null) return this._fail({ targetId, source, environment: env, error: { code: CODES.INVALID_TEST_REQUEST, message: 'Payload must be a JSON object with a numeric cmd' }, warnings });

    const command = Number(obj.cmd);
    const sid = obj.sid != null ? obj.sid : null;
    const eid = obj.eid != null ? obj.eid : null;
    const negative = Boolean(opts.negative);

    // 3) SID binding check (WU7 §7). A mismatch is only permitted for an explicit
    // negative test; otherwise we refuse rather than send from a guessed sid.
    const sidCheck = this.checkSid(sid);
    if (sidCheck.warning) {
      warnings.push({ code: sidCheck.warning, current: sidCheck.current, draft: sidCheck.draft });
      if (!negative && !opts.allowMismatch) {
        return this._fail({ targetId, source, environment: env, command, sid, requestPayload: obj, error: { code: CODES.STALE_OR_MANUAL_SID, message: `Draft sid ${sid} != current server sid ${sidCheck.current}. Enable "Send as negative test" to send anyway.` }, warnings });
      }
    }

    // 4) Build the append-only record and emit it as pending.
    const rec = {
      id: 'ptx_' + randomUUID(), seq: this._seq++, targetId, source,
      command, sid, eid, requestPayload: obj, requestJson: stableJson(obj),
      environment: { host: env.host, name: env.name },
      negative, expect: opts.expect || (negative ? 'reject' : null),
      sentAt: new Date().toISOString(), sentMonotonic: Date.now(),
      responsePayload: null, responseAt: null, latencyMs: null,
      result: null, verdict: null, warnings, error: null,
    };
    this._executions.push(rec);
    this._byId.set(rec.id, rec);
    this.emit('execution', { ...rec });

    // 5) Send through the page's own authenticated socket (the safe seam).
    const ctx = this._round && this._round.socketContext ? this._round.socketContext(targetId) : null;
    if (!ctx) return this._complete(rec, RESULT.ERROR, null, { code: CODES.TEST_SESSION_UNAVAILABLE, message: 'No live game WebSocket observed for this target yet — interact with the app so the socket sends at least one frame.' });

    let sendRes;
    try { sendRes = await this._send(ctx, rec.requestJson); }
    catch (e) { sendRes = { ok: false, error: { code: CODES.PROTOCOL_SEND_FAILED, message: String(e && e.message || e) } }; }
    if (!sendRes || !sendRes.ok) return this._complete(rec, RESULT.ERROR, null, (sendRes && sendRes.error) || { code: CODES.PROTOCOL_SEND_FAILED, message: 'Send failed' });

    // 6) Correlate the server ack (WU7 §14): same cmd (+ eid when present), on the
    // recv stream, within the timeout window. Never by full payload equality.
    const ack = await this._awaitAck({ cmd: command, eid, since: rec.sentMonotonic });
    if (!ack) return this._complete(rec, RESULT.TIMEOUT, null, null);
    const result = isRejectFrame(ack.cls) ? RESULT.REJECTED : RESULT.ACK;
    return this._complete(rec, result, ack.cls, null);
  }

  _fail(partial) {
    const rec = {
      id: 'ptx_' + randomUUID(), seq: this._seq++, targetId: partial.targetId || null,
      source: partial.source || 'MANUAL', command: partial.command != null ? partial.command : null,
      sid: partial.sid != null ? partial.sid : null, eid: null,
      requestPayload: partial.requestPayload || null, requestJson: partial.requestPayload ? stableJson(partial.requestPayload) : null,
      environment: partial.environment ? { host: partial.environment.host, name: partial.environment.name } : null,
      negative: false, expect: null,
      sentAt: new Date().toISOString(), sentMonotonic: Date.now(),
      responsePayload: null, responseAt: null, latencyMs: null,
      result: RESULT.ERROR, verdict: VERDICT.INCONCLUSIVE,
      warnings: partial.warnings || [], error: partial.error || null,
    };
    this._executions.push(rec);
    this._byId.set(rec.id, rec);
    this.emit('execution', { ...rec });
    return { ...rec };
  }

  _complete(rec, result, ackCls, error) {
    rec.result = result;
    rec.error = error || null;
    if (ackCls) {
      rec.responsePayload = { cmd: ackCls.cmd, b: ackCls.b, wm: ackCls.wm, odd: ackCls.odd, aid: ackCls.aid, eid: ackCls.eid, raw: ackCls.raw };
      rec.responseAt = new Date().toISOString();
      rec.latencyMs = Math.max(0, Date.now() - rec.sentMonotonic);
    }
    rec.verdict = verdictFor(rec.expect, result);
    this.emit('execution', { ...rec });
    return { ...rec };
  }

  _awaitAck({ cmd, eid, since }) {
    return new Promise((resolve) => {
      const waiter = { cmd, eid, since, resolve, done: false };
      const timer = setTimeout(() => { if (!waiter.done) { waiter.done = true; this._removeWaiter(waiter); resolve(null); } }, this._ackTimeoutMs);
      if (timer.unref) timer.unref();
      waiter.timer = timer;
      this._waiters.push(waiter);
    });
  }

  _removeWaiter(w) { const i = this._waiters.indexOf(w); if (i >= 0) this._waiters.splice(i, 1); }

  _onFrame(ev) {
    if (!ev || ev.direction !== 'recv') return;
    const cls = classifyFrame(ev.raw);
    if (cls.cmd == null) return;
    for (const w of this._waiters) {
      if (w.done) continue;
      if (w.cmd !== cls.cmd) continue;
      if (w.eid != null && cls.eid != null && String(w.eid) !== String(cls.eid)) continue;
      if (ev.at != null && ev.at < w.since) continue;
      w.done = true; clearTimeout(w.timer); this._removeWaiter(w);
      w.resolve({ cls, at: ev.at });
      return;
    }
  }
}

function verdictFor(expect, result) {
  if (expect === 'reject') {
    if (result === RESULT.ACK) return VERDICT.FAIL;         // server accepted what it should reject
    if (result === RESULT.REJECTED) return VERDICT.PASS;    // server correctly rejected
    return VERDICT.INCONCLUSIVE;                            // no correlated response
  }
  if (expect === 'accept') {
    if (result === RESULT.ACK) return VERDICT.PASS;
    if (result === RESULT.REJECTED) return VERDICT.FAIL;
    return VERDICT.INCONCLUSIVE;
  }
  return VERDICT.INCONCLUSIVE; // free-form send: evidence only, no auto-verdict
}

// Deterministic JSON so the same draft serializes identically across sends.
function stableJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

module.exports = { ProtocolHarness, hostAllowed, normalizeAllowlist, isRejectFrame, verdictFor, DEFAULT_ALLOWLIST, RESULT, VERDICT };
