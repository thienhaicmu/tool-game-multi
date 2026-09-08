'use strict';

// ---------------------------------------------------------------------------
// Aviator ENTER handshake — the sealed, LIVE-PROVEN lobby→Aviator entry sequence.
//
// Live acceptance proved that a bare `aviatorPlugin cmd100000` from a real LOBBY does
// NOT re-enter the game (no authoritative server round frames return). The full observed
// SUCCESSFUL entry is a three-step handshake, in order:
//
//   1. POST <game-act>  body {"game_id": "<id>"}   (authenticated browser context)
//   2. WS  ["6","MiniGame","lobbyPlugin",  {"cmd":10002}]
//   3. WS  ["6","MiniGame","aviatorPlugin",{"cmd":100000}]
//   → fresh authoritative SERVER Aviator round frames → ACTIVE
//
// This module is the ONE place that knows that sequence. It is a CAPABILITY BOUNDARY,
// not a convenience API:
//   - The two WS frames are baked literals. No caller can substitute BET (100002),
//     CASHOUT (100003), an arbitrary cmd or an arbitrary payload.
//   - The game-act URL + game_id are NEVER caller-supplied. They are LEARNED from genuine
//     website traffic (parseGameActDescriptor) and validated (isValidDescriptor) before use.
//     game_id must match a strict shape; anything else is rejected → fail safe.
//   - buildEnterAviatorHook bakes the validated descriptor into a ZERO-ARGUMENT page global
//     `__avEnterAviator()`. The page/renderer surface can only trigger THIS one handshake;
//     it cannot pass a url, body, frame or cmd. There is no generic fetch/send/replay here.
//
// game_id lifecycle (see the runtimes): learned per-BrowserRun from the site's own game-act
// POST, kept in memory on the run, refreshed by any later genuine game-act, never persisted,
// never accepted from a renderer/IPC caller, and gone when the run closes. If none has been
// learned yet, entry fails safely rather than inventing one.
// ---------------------------------------------------------------------------

// Fixed WS envelopes — exactly as observed on the wire. DO NOT add sid/aid/eid/b/odd.
const LOBBY_ENVELOPE = ['6', 'MiniGame', 'lobbyPlugin', { cmd: 10002 }];
const ENTER_ENVELOPE = ['6', 'MiniGame', 'aviatorPlugin', { cmd: 100000 }];
const LOBBY_FRAME = JSON.stringify(LOBBY_ENVELOPE);   // ["6","MiniGame","lobbyPlugin",{"cmd":10002}]
const ENTER_FRAME = JSON.stringify(ENTER_ENVELOPE);   // ["6","MiniGame","aviatorPlugin",{"cmd":100000}]

// The observed game-act endpoint path. We match by path suffix (host/version may differ per
// deployment); the descriptor retains the full learned URL so we never guess the host.
const GAME_ACT_PATH = '/game-act';
// game_id is an opaque short product token (observed: "vgmn_221"). Strict shape so a learned
// descriptor can never smuggle a URL, script or arbitrary body through the game_id field.
const GAME_ID_RE = /^[A-Za-z0-9_]{1,40}$/;

function isGameActUrl(url) {
  try { return new URL(String(url)).pathname.endsWith(GAME_ACT_PATH); } catch { return false; }
}

// Learn the minimal validated entry descriptor from a genuine website game-act POST.
// Returns { gameActUrl, gameId } or null. Retains ONLY those two fields — nothing else
// from the request (no headers, no cookies, no auth) is kept.
function parseGameActDescriptor(url, rawBody) {
  if (!isGameActUrl(url)) return null;
  let gameId = null;
  try {
    const b = JSON.parse(String(rawBody == null ? '' : rawBody));
    if (b && typeof b.game_id === 'string') gameId = b.game_id;
  } catch { return null; }
  if (!gameId || !GAME_ID_RE.test(gameId)) return null;
  return { gameActUrl: String(url), gameId };
}

function isValidDescriptor(d) {
  return !!(d && typeof d.gameActUrl === 'string' && isGameActUrl(d.gameActUrl)
    && typeof d.gameId === 'string' && GAME_ID_RE.test(d.gameId));
}

// Build the SEALED, zero-argument page hook that bakes THIS validated descriptor + the two
// fixed WS frames. It installs `globalThis.__avEnterAviator()` which performs the ordered
// handshake and resolves to { ok:true } | { ok:false, step, status? }. Callers cannot pass a
// url/body/frame — those are literals inside the closure.
function buildEnterAviatorHook(descriptor, wsHost) {
  if (!isValidDescriptor(descriptor)) throw new Error('invalid entry descriptor');
  const URL_ = JSON.stringify(descriptor.gameActUrl);
  const BODY_ = JSON.stringify(JSON.stringify({ game_id: descriptor.gameId }));
  const HOST_ = JSON.stringify(String(wsHost || ''));
  const F1 = JSON.stringify(LOBBY_FRAME);
  const F2 = JSON.stringify(ENTER_FRAME);
  return `(() => {
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : this;
    if (!g) return;
    var WS = g.__wsoNativeWebSocket || g.WebSocket;
    if (WS && WS.prototype && WS.prototype.send && !g.__avEnterHooked) {
      g.__avEnterHooked = 1;
      try { g.__wsoNativeWebSocket = WS; } catch (e) {}
      var socks = g.__wsoSocks = g.__wsoSocks || [];
      var track = function (ws) { try { if (ws && socks.indexOf(ws) === -1) socks.push(ws); } catch (e) {} return ws; };
      var nativeSend = WS.prototype.send;
      var wrapped = function (data) { track(this); return nativeSend.apply(this, arguments); };
      try { Object.defineProperty(wrapped, 'name', { value: 'send' }); } catch (e) {}
      try { wrapped.toString = function () { return nativeSend.toString(); }; } catch (e) {}
      try { WS.prototype.send = wrapped; } catch (e) { try { WS.prototype.send = nativeSend; } catch (e2) {} }
    }
    var socks2 = g.__wsoSocks = g.__wsoSocks || [];
    var GAME_ACT_URL = ${URL_}, GAME_ACT_BODY = ${BODY_}, WS_HOST = ${HOST_}, FRAME_LOBBY = ${F1}, FRAME_ENTER = ${F2};
    var sendFrame = function (frame) {
      try { for (var i = socks2.length - 1; i >= 0; i--) { var ws = socks2[i]; if (!ws || ws.readyState !== 1) continue; if (WS_HOST && String(ws.url || '').indexOf(WS_HOST) === -1) continue; ws.send(frame); return true; } } catch (e) {}
      try { for (var j = socks2.length - 1; j >= 0; j--) { var w2 = socks2[j]; if (!w2 || w2.readyState !== 1) continue; w2.send(frame); return true; } } catch (e) {}
      return false;
    };
    // Zero-argument sealed handshake. No url/body/frame/cmd parameter is accepted from callers.
    g.__avEnterAviator = function () {
      return (async function () {
        try {
          var r = await fetch(GAME_ACT_URL, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: GAME_ACT_BODY });
          if (!r || !r.ok) return { ok: false, step: 'game-act', status: r ? r.status : 0 };
        } catch (e) { return { ok: false, step: 'game-act', error: String(e && e.message || e) }; }
        if (!sendFrame(FRAME_LOBBY)) return { ok: false, step: 'lobby-10002' };
        if (!sendFrame(FRAME_ENTER)) return { ok: false, step: 'enter-100000' };
        return { ok: true };
      })();
    };
  } catch (e) {}
})();`;
}

// Execute the sealed handshake through a target's OWN CDP client (page-authenticated context).
// client: a CRI-compatible client with .Runtime.evaluate / .Page. sessionId: flattened child
// session (or undefined for root). Returns { ok:true } | { error:{ code, message, step?, status? } }.
// Sending is NOT entry: the caller (entry gate) confirms only on fresh authoritative server
// evidence that arrived AFTER the attempt boundary (SENT != ENTERED).
async function runEnterAviatorHandshake(client, sessionId, descriptor, wsHost) {
  if (!client || !client.Runtime || typeof client.Runtime.evaluate !== 'function') {
    return { error: { code: 'ENTER_NO_CLIENT', message: 'Target connection is gone' } };
  }
  if (!isValidDescriptor(descriptor)) {
    return { error: { code: 'ENTER_NO_DESCRIPTOR', message: 'No validated Aviator game-act descriptor learned yet — enter Aviator once so it can be observed.' } };
  }
  let hook;
  try { hook = buildEnterAviatorHook(descriptor, wsHost); } catch (e) { return { error: { code: 'ENTER_NO_DESCRIPTOR', message: String(e && e.message || e) } }; }
  try { await client.Runtime.evaluate({ expression: hook, includeCommandLineAPI: false }, sessionId); } catch { /* worker/detached — the call below still reports */ }
  const expr = "globalThis.__avEnterAviator ? globalThis.__avEnterAviator() : ({ ok:false, step:'no-hook' })";
  try {
    const res = await client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    const v = res && res.result && res.result.value;
    if (v && v.ok === true) return { ok: true };
    return { error: { code: 'ENTER_HANDSHAKE_FAILED', message: 'Entry handshake did not complete', step: v && v.step, status: v && v.status } };
  } catch (e) {
    return { error: { code: 'ENTER_HANDSHAKE_FAILED', message: String(e && e.message || e) } };
  }
}

module.exports = {
  LOBBY_ENVELOPE, ENTER_ENVELOPE, LOBBY_FRAME, ENTER_FRAME,
  GAME_ACT_PATH, GAME_ID_RE, isGameActUrl,
  parseGameActDescriptor, isValidDescriptor, buildEnterAviatorHook, runEnterAviatorHandshake,
};
