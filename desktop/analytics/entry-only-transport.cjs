'use strict';

const {
  ENTER_ENVELOPE, ENTER_FRAME, LOBBY_ENVELOPE, LOBBY_FRAME,
  isValidDescriptor, runEnterAviatorHandshake,
} = require('../protocol/aviator-entry-descriptor.cjs');

// ---------------------------------------------------------------------------
// EntryOnlyTransport — the SEALED wire seam for Aviator Analytics recovery.
//
// This is the ONLY code in the Analytics graph that can put frames on the game
// WebSocket, and it can perform EXACTLY ONE operation: the fixed, LIVE-PROVEN
// lobby→Aviator ENTER handshake. It is a CAPABILITY BOUNDARY, not a UI hint:
//
//   - sendEntry(ctx, descriptor) takes NO payload / cmd / JSON / method / URL / body
//     argument. The caller cannot influence what goes on the wire.
//   - The handshake = game-act POST → lobbyPlugin 10002 → aviatorPlugin 100000. The two
//     WS frames are baked literals; the game-act URL + game_id come ONLY from `descriptor`,
//     which the runtime LEARNED from genuine website traffic and which is validated before
//     use. A renderer/IPC caller can never supply a descriptor (see analytics-runtime).
//   - The whole handshake is baked into a ZERO-ARGUMENT page global __avEnterAviator() by the
//     shared seam. There is no code path that emits BET (100002), CASHOUT (100003), an arbitrary
//     cmd, an arbitrary payload, or an arbitrary fetch(url, body).
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

  // sendEntry(ctx, descriptor) — run the ONE sealed ENTER handshake through the game's OWN
  // authenticated page context. ctx: { targetId, cdpSessionId?, host? }. descriptor: the run's
  // LEARNED, validated { gameActUrl, gameId } (never caller-supplied). NO payload argument exists.
  // SEND != ENTERED: a successful send does not confirm entry — the gate confirms only on fresh
  // authoritative SERVER Aviator evidence after the attempt boundary.
  async sendEntry(ctx, descriptor) {
    if (!ctx || !ctx.targetId) return { error: { code: 'ANALYTICS_ENTRY_NO_SOCKET', message: 'No owning game WebSocket bound for this browser yet.' } };
    if (!isValidDescriptor(descriptor)) return { error: { code: 'ANALYTICS_ENTRY_NO_DESCRIPTOR', message: 'No validated Aviator game-act descriptor learned yet — enter Aviator once so it can be observed.' } };
    const client = this._resolveClient(ctx.targetId);
    if (!client) return { error: { code: 'ANALYTICS_ENTRY_NO_CLIENT', message: 'Target connection is gone' } };
    const res = await runEnterAviatorHandshake(client, ctx.cdpSessionId || undefined, descriptor, ctx.host);
    if (res && res.ok === true) return { ok: true };
    return { error: (res && res.error) || { code: 'ANALYTICS_ENTRY_SEND_FAILED', message: 'Entry handshake failed' } };
  }
}

module.exports = { EntryOnlyTransport, ENTER_ENVELOPE, ENTER_FRAME, LOBBY_ENVELOPE, LOBBY_FRAME };
