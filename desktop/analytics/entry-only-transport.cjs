'use strict';

// ---------------------------------------------------------------------------
// EntryOnlyTransport — the SEALED wire seam for Aviator Analytics recovery.
//
// This is the ONLY code in the Analytics graph that can put a frame on the
// game WebSocket, and it can emit EXACTLY ONE frame: the fixed Aviator ENTER
// request. It is a CAPABILITY BOUNDARY, not a UI hint:
//
//   - sendEntry(ctx) takes NO payload / cmd / JSON / method argument. The caller
//     cannot influence what goes on the wire.
//   - The enter frame is baked, as a literal, into the injected page hook AND
//     into this module. There is no code path that accepts BET (100002),
//     CASHOUT (100003), an arbitrary cmd, or an arbitrary payload.
//   - It deliberately does NOT install the generic __wsoSendFrame(url, data)
//     hook that Control's WsReplay uses (that one relays ARBITRARY data). The
//     injected surface here exposes only __avEnterAviator(), a zero-argument
//     fixed-frame sender.
//
// A raw CDP debugger is of course omnipotent; the boundary this module enforces
// is that no Analytics-reachable API (runtime method / IPC / preload) ever
// constructs or forwards anything but this one fixed frame.
// ---------------------------------------------------------------------------

// The exact, already-observed website enter request. DO NOT add sid/aid/eid/odd/
// bet/cashout or any field that was not part of the authoritative captured frame.
const ENTER_ENVELOPE = ['6', 'MiniGame', 'aviatorPlugin', { cmd: 100000 }];
const ENTER_FRAME = JSON.stringify(ENTER_ENVELOPE); // ["6","MiniGame","aviatorPlugin",{"cmd":100000}]

// Injected page/worker hook. Tracks live sockets (wrapping send, like WsReplay) and
// exposes ONLY g.__avEnterAviator(urlPart) — a sender whose payload is the baked
// ENTER_FRAME literal. There is intentionally no arbitrary-data entry point here.
const ENTRY_HOOK = `(() => {
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : this;
    if (!g) return;
    if (g.__avEnterVersion >= 1) return; g.__avEnterVersion = 1;
    var WS = g.__wsoNativeWebSocket || g.WebSocket; if (!WS || !WS.prototype || !WS.prototype.send) return;
    try { g.__wsoNativeWebSocket = WS; } catch (e) {}
    var socks = g.__wsoSocks = g.__wsoSocks || [];
    var track = function (ws) { try { if (ws && socks.indexOf(ws) === -1) socks.push(ws); } catch (e) {} return ws; };
    var nativeSend = WS.prototype.send;
    var wrapped = function (data) { track(this); return nativeSend.apply(this, arguments); };
    try { Object.defineProperty(wrapped, 'name', { value: 'send' }); } catch (e) {}
    try { wrapped.toString = function () { return nativeSend.toString(); }; } catch (e) {}
    try { WS.prototype.send = wrapped; } catch (e) { try { WS.prototype.send = nativeSend; } catch (e2) {} return; }
    // ENTRY-ONLY: the single frame this surface can ever emit, baked as a literal.
    var FRAME = ${JSON.stringify(ENTER_FRAME)};
    g.__avEnterAviator = function (urlPart) {
      try {
        for (var i = socks.length - 1; i >= 0; i--) {
          var ws = socks[i];
          if (!ws || ws.readyState !== 1) continue;
          if (urlPart && String(ws.url || '').indexOf(urlPart) === -1) continue;
          ws.send(FRAME); return true;
        }
      } catch (e) {}
      return false;
    };
  } catch (e) {}
})();`;

class EntryOnlyTransport {
  // resolveClient(targetId) -> a CRI-compatible CDP client for that target (or null).
  constructor({ resolveClient } = {}) {
    this._resolveClient = typeof resolveClient === 'function' ? resolveClient : () => null;
  }

  async _inject(client, sessionId) {
    try {
      try { await client.Page.addScriptToEvaluateOnNewDocument({ source: ENTRY_HOOK }, sessionId); } catch { /* survives-nav best-effort */ }
      await client.Runtime.evaluate({ expression: ENTRY_HOOK, includeCommandLineAPI: false }, sessionId);
    } catch { /* no DOM (worker) / detached — ignore; evaluate below still runs */ }
  }

  // sendEntry(ctx) — emit the fixed Aviator enter frame through the game's OWN live
  // socket, in the frame's own target/session. ctx: { targetId, cdpSessionId?, host? }.
  // NO payload argument exists by design.
  async sendEntry(ctx) {
    if (!ctx || !ctx.targetId) return { error: { code: 'ANALYTICS_ENTRY_NO_SOCKET', message: 'No owning game WebSocket bound for this browser yet.' } };
    const client = this._resolveClient(ctx.targetId);
    if (!client) return { error: { code: 'ANALYTICS_ENTRY_NO_CLIENT', message: 'Target connection is gone' } };
    const sessionId = ctx.cdpSessionId || undefined;
    await this._inject(client, sessionId);
    const host = JSON.stringify(String(ctx.host || ''));
    // Host-matched first, then any open socket in this session — NEVER arbitrary data.
    const expr = `globalThis.__avEnterAviator && (globalThis.__avEnterAviator(${host}) || globalThis.__avEnterAviator(''))`;
    try {
      const res = await client.Runtime.evaluate({ expression: expr, returnByValue: true }, sessionId);
      if (res && res.result && res.result.value === true) return { ok: true };
      return { error: { code: 'ANALYTICS_ENTRY_SEND_FAILED', message: 'No tracked open WebSocket in this session to carry the enter request.' } };
    } catch (e) {
      return { error: { code: 'ANALYTICS_ENTRY_SEND_FAILED', message: String(e && e.message || e) } };
    }
  }
}

module.exports = { EntryOnlyTransport, ENTER_ENVELOPE, ENTER_FRAME, ENTRY_HOOK };
