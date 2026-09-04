'use strict';

// CDP has NO command to inject a WebSocket frame, so resending a captured frame
// means calling `.send()` on the page's own live socket. We install a tiny hook
// that tracks sockets as they are constructed, with a send-wrapper fallback for
// sockets that already existed before injection.
//
// The global is resolved via `globalThis` (NOT `window`) so the SAME hook works in a
// page, a cross-origin iframe AND a Web Worker. In a page/iframe globalThis === window,
// so this is byte-for-byte equivalent to the original there; the only new behaviour is
// that a game whose WebSocket lives in a Web Worker (common for Aviator-style games)
// finally gets a tracked socket, instead of failing with "No tracked open WebSocket".
const WS_HOOK = `(() => {
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : this;
    if (!g) return;
    if (g.__wsoWsVersion >= 2) return; g.__wsoWsVersion = 2; g.__wsoWs = 1;
    const WS = g.__wsoNativeWebSocket || g.WebSocket; if (!WS || !WS.prototype || !WS.prototype.send) return;
    try { g.__wsoNativeWebSocket = WS; } catch(e){}
    const socks = g.__wsoSocks = g.__wsoSocks || [];
    const track = function(ws){ try { if (ws && socks.indexOf(ws) === -1) socks.push(ws); } catch(e){} return ws; };
    const nativeSend = WS.prototype.send;
    const wrapped = function(data){ track(this); return nativeSend.apply(this, arguments); };
    // Stay invisible to games that sanity-check send(): keep name/length and make
    // toString report the native source. If anything about the swap fails, restore
    // the original so we can never break the page (which would hide the buttons).
    try { Object.defineProperty(wrapped, 'name', { value: 'send' }); } catch(e){}
    try { wrapped.toString = function(){ return nativeSend.toString(); }; } catch(e){}
    try { WS.prototype.send = wrapped; } catch(e){ try { WS.prototype.send = nativeSend; } catch(e2){} return; }
    try {
      const TrackedWebSocket = function(url, protocols){
        const ws = arguments.length > 1 ? new WS(url, protocols) : new WS(url);
        return track(ws);
      };
      try { Object.defineProperty(TrackedWebSocket, 'name', { value: 'WebSocket' }); } catch(e){}
      try { Object.setPrototypeOf(TrackedWebSocket, WS); } catch(e){}
      try { TrackedWebSocket.prototype = WS.prototype; } catch(e){}
      try { TrackedWebSocket.CONNECTING = WS.CONNECTING; TrackedWebSocket.OPEN = WS.OPEN; TrackedWebSocket.CLOSING = WS.CLOSING; TrackedWebSocket.CLOSED = WS.CLOSED; } catch(e){}
      try { TrackedWebSocket.toString = function(){ return WS.toString(); }; } catch(e){}
      g.WebSocket = TrackedWebSocket;
    } catch(e){}
    g.__wsoSendFrame = function(urlPart, data){
      try {
        for (let i = socks.length - 1; i >= 0; i--){
          const ws = socks[i];
          if (!ws || ws.readyState !== 1) continue;
          if (urlPart && String(ws.url || '').indexOf(urlPart) === -1) continue;
          ws.send(data); return true;
        }
      } catch(e){}
      return false;
    };
    g.__wsoSocketCount = function(urlPart){
      let n = 0;
      try {
        for (let i = socks.length - 1; i >= 0; i--){
          const ws = socks[i];
          if (!ws || ws.readyState !== 1) continue;
          if (urlPart && String(ws.url || '').indexOf(urlPart) === -1) continue;
          n++;
        }
      } catch(e){}
      return n;
    };
  } catch(e){}
})();`;

class WsReplay {
  constructor(deps = {}) {
    this._resolveClient = deps.resolveClient || (() => null);
    this._getCaptured = deps.getCaptured || (() => undefined);
  }

  // Inject the send-hook into a session (root when sessionId is undefined, or a
  // flattened child OOPIF iframe session where the game socket usually lives).
  async injectSession(client, sessionId) {
    try {
      try { await client.Page.addScriptToEvaluateOnNewDocument({ source: WS_HOOK }, sessionId); } catch { /* survives-nav best-effort */ }
      await client.Runtime.evaluate({ expression: WS_HOOK, includeCommandLineAPI: false }, sessionId);
    } catch { /* no DOM (worker) / detached — ignore */ }
  }

  // Resend a captured WebSocket frame with a (possibly edited) payload over the
  // page's real socket, in the frame's own target/session.
  async send(capturedId, payload) {
    const cap = this._getCaptured(capturedId);
    if (!cap) return { ok: false, error: { code: 'REQUEST_NOT_FOUND', message: 'Unknown captured request' } };
    if (!cap.isWebSocket) return { ok: false, error: { code: 'NOT_WEBSOCKET', message: 'Chỉ áp dụng cho WebSocket frame' } };
    const client = this._resolveClient(cap.targetId);
    if (!client) return { ok: false, error: { code: 'TARGET_CONTEXT_UNAVAILABLE', message: 'Kết nối tới target đã mất' } };
    let urlPart = '';
    try { urlPart = new URL(cap.url).host; } catch { /* opaque */ }
    const expr = `globalThis.__wsoSendFrame && globalThis.__wsoSendFrame(${JSON.stringify(urlPart)}, ${JSON.stringify(String(payload))})`;
    try {
      const res = await client.Runtime.evaluate({ expression: expr, returnByValue: true }, cap.cdpSessionId || undefined);
      const ok = res && res.result && res.result.value === true;
      if (ok) return { ok: true };
      return { ok: false, error: { code: 'WS_SEND_FAILED', message: 'Không tìm thấy WebSocket đang mở khớp trang. Hãy Reload game rồi thử lại (socket phải gửi ít nhất 1 frame để tool bám vào).' } };
    } catch (e) {
      return { ok: false, error: { code: 'WS_SEND_FAILED', message: String(e && e.message || e) } };
    }
  }

  // WU7 send seam: send an arbitrary QA payload through the page's OWN live socket,
  // bound to a specific target/session (never a second authenticated connection).
  // ctx: { targetId, cdpSessionId?, host? } — usually the RoundTracker socketContext.
  async sendRaw(ctx, payload) {
    if (!ctx || !ctx.targetId) return { ok: false, error: { code: 'TEST_SESSION_UNAVAILABLE', message: 'No target bound for send' } };
    const client = this._resolveClient(ctx.targetId);
    if (!client) return { ok: false, error: { code: 'TARGET_CONTEXT_UNAVAILABLE', message: 'Kết nối tới target đã mất' } };
    await this.injectSession(client, ctx.cdpSessionId || undefined);
    const urlPart = String(ctx.host || '');
    const data = JSON.stringify(String(payload));
    const expr = `globalThis.__wsoSendFrame && (globalThis.__wsoSendFrame(${JSON.stringify(urlPart)}, ${data}) || globalThis.__wsoSendFrame('', ${data}))`;
    try {
      const res = await client.Runtime.evaluate({ expression: expr, returnByValue: true }, ctx.cdpSessionId || undefined);
      if (res && res.result && res.result.value === true) return { ok: true };
      return { ok: false, error: { code: 'PROTOCOL_SEND_FAILED', message: 'Không tìm thấy WebSocket đang mở khớp trang. Hãy tương tác với app để socket gửi ≥1 frame rồi thử lại.' } };
    } catch (e) {
      return { ok: false, error: { code: 'PROTOCOL_SEND_FAILED', message: String(e && e.message || e) } };
    }
  }

  async sendProtocol(ctx, payload) {
    if (!ctx || !ctx.targetId) return { ok: false, error: { code: 'TEST_SESSION_UNAVAILABLE', message: 'No target bound for send' } };
    const client = this._resolveClient(ctx.targetId);
    if (!client) return { ok: false, error: { code: 'TARGET_CONTEXT_UNAVAILABLE', message: 'Target connection is gone' } };
    const sessionId = ctx.cdpSessionId || undefined;
    await this.injectSession(client, sessionId);
    const urlPart = String(ctx.host || '');
    const data = JSON.stringify(String(payload));
    const expr = `globalThis.__wsoSendFrame && (globalThis.__wsoSendFrame(${JSON.stringify(urlPart)}, ${data}) || globalThis.__wsoSendFrame('', ${data}))`;
    try {
      const res = await client.Runtime.evaluate({ expression: expr, returnByValue: true }, sessionId);
      if (res && res.result && res.result.value === true) return { ok: true };
      const countExpr = `globalThis.__wsoSocketCount ? {matched: globalThis.__wsoSocketCount(${JSON.stringify(urlPart)}), open: globalThis.__wsoSocketCount('')} : {matched: 0, open: 0}`;
      const countRes = await client.Runtime.evaluate({ expression: countExpr, returnByValue: true }, sessionId).catch(() => null);
      const counts = countRes && countRes.result && countRes.result.value || { matched: 0, open: 0 };
      return { ok: false, error: { code: 'PROTOCOL_SEND_FAILED', message: counts.open > 0 ? 'Cannot send through the tracked open WebSocket. Reload the game and try again.' : 'No tracked open WebSocket in this frame. Reload the game after opening the browser from the tool, log in again, then try bet/cashout.', context: { socketHost: urlPart, openSockets: counts.open || 0, matchedSockets: counts.matched || 0 } } };
    } catch (e) {
      return { ok: false, error: { code: 'PROTOCOL_SEND_FAILED', message: String(e && e.message || e) } };
    }
  }
}

module.exports = { WsReplay, WS_HOOK };
