'use strict';

const {
  ENTER_ENVELOPE, ENTER_FRAME, LOBBY_ENVELOPE, LOBBY_FRAME,
  isValidDescriptor, runEnterAviatorViaSite,
} = require('../protocol/aviator-entry-descriptor.cjs');

// ---------------------------------------------------------------------------
// EntryOnlyTransport — the SEALED entry seam for Aviator Analytics recovery.
//
// This is the ONLY code in the Analytics graph that can trigger game entry, and it can perform
// EXACTLY ONE operation: RESOLVE-BEFORE-INVOKE the site's OWN authenticated minigame-open routine.
// It is a CAPABILITY BOUNDARY, not a UI hint:
//
//   - sendEntry(ctx, descriptor) takes NO payload / cmd / JSON / node / path / component / URL / body
//     / fn name / coordinate argument. The caller cannot influence what runs.
//   - The sealed op resolves the Aviator Cocos scene node (by the LEARNED gameId == node name) and,
//     only if every read-only check passes, fires the node's OWN wired cc.Button click. The site's
//     own handlers then perform the authenticated game-act (its own X-FG-ID/X-TOKEN) + lobby 10002 +
//     aviator 100000. Analytics transmits NO frame and issues NO fetch itself.
//   - There is no code path that emits BET (100002), CASHOUT (100003), an arbitrary cmd, an arbitrary
//     payload, an arbitrary fetch(url, body), or an arbitrary function/module name. gameId is the only
//     input and it is validated + learned from genuine site traffic (never renderer/IPC-supplied).
//
// A raw CDP debugger is of course omnipotent; the boundary this module enforces is that no
// Analytics-reachable API (runtime method / IPC / preload) ever constructs or forwards anything
// but this one sealed ENTER operation.
// ---------------------------------------------------------------------------

class EntryOnlyTransport {
  // resolveClient(targetId) -> a CRI-compatible CDP client for that target (or null).
  constructor({ resolveClient } = {}) {
    this._resolveClient = typeof resolveClient === 'function' ? resolveClient : () => null;
  }

  // sendEntry(ctx, descriptor, onDiag) — RESOLVE-BEFORE-INVOKE the site's own entry through the
  // game's OWN CDP session. ctx: { targetId, cdpSessionId?, host? }. descriptor: the run's LEARNED,
  // validated { gameActUrl, gameId } (never caller-supplied). onDiag receives non-secret resolve
  // facts only. NO payload argument exists. SEND != ENTERED: invocation does not confirm entry —
  // the gate confirms only on fresh authoritative SERVER Aviator evidence after the attempt boundary.
  async sendEntry(ctx, descriptor, onDiag) {
    if (!ctx || !ctx.targetId) return { error: { code: 'ANALYTICS_ENTRY_NO_SOCKET', message: 'No owning game WebSocket bound for this browser yet.' } };
    if (!isValidDescriptor(descriptor)) return { error: { code: 'ANALYTICS_ENTRY_NO_DESCRIPTOR', message: 'No validated Aviator game id learned yet — enter Aviator once so it can be observed.' } };
    const client = this._resolveClient(ctx.targetId);
    if (!client) return { error: { code: 'ANALYTICS_ENTRY_NO_CLIENT', message: 'Target connection is gone' } };
    const res = await runEnterAviatorViaSite(client, ctx.cdpSessionId || undefined, descriptor, onDiag);
    if (res && res.ok === true) return { ok: true };
    return { error: (res && res.error) || { code: 'ANALYTICS_ENTRY_SEND_FAILED', message: 'Site entry failed' } };
  }
}

module.exports = { EntryOnlyTransport, ENTER_ENVELOPE, ENTER_FRAME, LOBBY_ENVELOPE, LOBBY_FRAME };
