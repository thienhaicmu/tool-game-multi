'use strict';

// CDP has NO command to inject a WebSocket frame, so resending a captured frame
// means calling `.send()` on the page's own live socket. We install a tiny hook
// that tracks sockets as they are constructed, with a send-wrapper fallback for
// sockets that already existed before injection.
const WS_HOOK = `(() => {
  try {
    if (window.__wsoWsVersion >= 2) return; window.__wsoWsVersion = 2; window.__wsoWs = 1;
    const WS = window.__wsoNativeWebSocket || window.WebSocket; if (!WS || !WS.prototype || !WS.prototype.send) return;
    try { window.__wsoNativeWebSocket = WS; } catch(e){}
    const socks = window.__wsoSocks = window.__wsoSocks || [];
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
      window.WebSocket = TrackedWebSocket;
    } catch(e){}
    window.__wsoSendFrame = function(urlPart, data){
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
    const expr = `window.__wsoSendFrame && window.__wsoSendFrame(${JSON.stringify(urlPart)}, ${JSON.stringify(String(payload))})`;
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
    const urlPart = String(ctx.host || '');
    const expr = `window.__wsoSendFrame && window.__wsoSendFrame(${JSON.stringify(urlPart)}, ${JSON.stringify(String(payload))})`;
    try {
      const res = await client.Runtime.evaluate({ expression: expr, returnByValue: true }, ctx.cdpSessionId || undefined);
      if (res && res.result && res.result.value === true) return { ok: true };
      return { ok: false, error: { code: 'PROTOCOL_SEND_FAILED', message: 'Không tìm thấy WebSocket đang mở khớp trang. Hãy tương tác với app để socket gửi ≥1 frame rồi thử lại.' } };
    } catch (e) {
      return { ok: false, error: { code: 'PROTOCOL_SEND_FAILED', message: String(e && e.message || e) } };
    }
  }
}

module.exports = { WsReplay, WS_HOOK };
