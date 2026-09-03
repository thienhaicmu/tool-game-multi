// WU9 — Smart Protocol Form: pure payload-builder + context-aware validation.
// UI-only, no engine/IPC. Loaded as a browser global (window.ProtocolForm) AND as
// a Node module for unit tests. It builds requests so the developer never has to
// remember the protocol; SID/aid/eid come from the Protocol Context, not the user.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node tests
  if (root) root.ProtocolForm = api;                                          // browser
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const CMD = { bet: 100002, cashout: 100003 };

  // Command schema — declares which fields a command needs. Drives the dynamic form.
  const SCHEMA = {
    bet: { cmd: CMD.bet, userFields: ['amount'], auto: ['sid', 'aid', 'eid'] },
    cashout: { cmd: CMD.cashout, userFields: [], auto: ['sid', 'aid', 'eid'] },
  };

  const SCENARIOS = ['normal', 'stale', 'amount', 'duplicate', 'manual'];

  function toNum(v) {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }

  /**
   * buildPayload(state) — pure. state fields:
   *   command 'bet'|'cashout', scenario, amount, sid (from context), aid, eid,
   *   staleSid (for stale scenario), rawText (for manual scenario).
   * Returns { payload, manual?, parseError? }.
   */
  function buildPayload(state) {
    if (state.scenario === 'manual') {
      try { return { payload: JSON.parse(state.rawText), manual: true }; }
      catch { return { payload: null, manual: true, parseError: true }; }
    }
    const aid = state.aid == null ? 1 : toNum(state.aid);
    const eid = state.eid == null ? 1 : toNum(state.eid);
    const sid = state.scenario === 'stale' ? toNum(state.staleSid) : state.sid;
    if (state.command === 'cashout') {
      // Cashout carries NO amount and NO odd — the server returns odd/wm.
      return { payload: { cmd: CMD.cashout, sid, aid, eid } };
    }
    // bet
    return { payload: { cmd: CMD.bet, b: toNum(state.amount), sid, aid, eid } };
  }

  /**
   * validate(state, ctx) — context-aware, human-readable. ctx: { hasSid }.
   * Returns { canSend, level:'ok|info|warn|block', message, negative, expect, allowMismatch }.
   */
  function validate(state, ctx) {
    const base = { canSend: true, level: 'ok', message: '', negative: false, expect: null, allowMismatch: false };

    if (state.scenario === 'manual') {
      const built = buildPayload(state);
      if (!built.payload || built.parseError || built.payload.cmd == null) return { ...base, canSend: false, level: 'block', message: 'Manual payload must be valid JSON containing a numeric "cmd".' };
      return { ...base, level: 'warn', message: 'Manual payload — you own every field. Server validation expected.', negative: true, expect: null };
    }

    if (state.scenario === 'stale') {
      if (state.staleSid == null || String(state.staleSid).trim() === '') return { ...base, canSend: false, level: 'block', message: 'Enter a SID to send as stale-round validation.' };
      return { ...base, level: 'warn', message: 'Manual SID enabled — sending a stale round on purpose. The server should reject it.', negative: true, expect: 'reject', allowMismatch: true };
    }

    if (!ctx || !ctx.hasSid) return { ...base, canSend: false, level: 'block', message: 'Waiting for the current server round (cmd:100005).' };

    if (state.command === 'cashout') {
      if (state.scenario === 'amount') return { ...base, canSend: false, level: 'info', message: 'Invalid-amount validation applies to Bet only.' };
      if (state.scenario === 'duplicate') return { ...base, level: 'warn', message: 'Sends the same cashout twice to check replay / idempotency protection.', negative: true, expect: 'reject' };
      return { ...base, level: 'info', message: 'SID comes from the current server round. No input needed.' };
    }

    // bet
    if (state.scenario === 'amount') {
      if (state.amount == null || String(state.amount).trim() === '') return { ...base, canSend: false, level: 'block', message: 'Enter the invalid amount you want to validate.' };
      return { ...base, level: 'warn', message: 'Validation mode: the server is expected to reject this amount.', negative: true, expect: 'reject' };
    }
    const amt = toNum(state.amount);
    if (!(typeof amt === 'number' && amt > 0)) return { ...base, canSend: false, level: 'block', message: 'Amount must be greater than 0.' };
    if (state.scenario === 'duplicate') return { ...base, level: 'warn', message: 'Sends the same bet twice to check replay / idempotency protection.', negative: true, expect: 'reject' };
    return { ...base, level: 'ok', message: 'SID comes from the current server round. Override disabled.', negative: false, expect: null };
  }

  // Which fields the dynamic form should render for a command + scenario.
  function fieldsFor(command, scenario) {
    if (scenario === 'manual') return { raw: true, amount: false, staleSid: false, note: null };
    const out = { raw: false, amount: false, staleSid: false, note: null };
    if (scenario === 'stale') out.staleSid = true;
    if (command === 'bet') out.amount = true;                 // bet always needs an amount
    if (command === 'cashout') {
      if (scenario === 'amount') out.note = 'Invalid-amount validation applies to Bet only.';
      else if (scenario === 'duplicate') out.note = 'Sends the same cashout twice.';
      else if (scenario === 'normal') out.note = 'No input needed — SID/aid/eid come from context.';
    }
    return out;
  }

  return { CMD, SCHEMA, SCENARIOS, toNum, buildPayload, validate, fieldsFor };
});
