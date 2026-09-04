// WU-D.4 (D4-001): the bet/cashout send must work when the game's WebSocket lives in a
// Web Worker. D.3 made the injected HOOK worker-safe (globalThis), but ws-replay's
// send/count INVOCATION expressions still referenced `window.__wsoSendFrame` /
// `window.__wsoSocketCount` — and a Worker global has NO `window`, so every send threw
// ReferenceError and failed with "No tracked open WebSocket in this frame" even though a
// live worker socket existed. This test drives WsReplay.sendProtocol against a CDP client
// whose Runtime.evaluate executes in a real WORKER-like global (self/globalThis, no
// window). It FAILS on the old `window.`-based code and PASSES with the globalThis fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WsReplay, WS_HOOK } = require('../../desktop/cdp/ws-replay.cjs');

class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(data); }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;

// A CDP client whose Runtime.evaluate runs the expression inside a Web WORKER-like
// global: `self`/`globalThis` exist, `window` does NOT. injectSession's Page call is
// rejected (workers have no Page domain), exactly like the real runtime.
function makeWorkerClient() {
  const ctx = { WebSocket: FakeWebSocket };
  ctx.self = ctx;            // self === globalThis, and crucially NO `window`
  vm.createContext(ctx);
  // Hook is injected into the worker session, then the game socket is (re)created while
  // the hook is active — so the constructor-tracker registers it.
  vm.runInContext(WS_HOOK, ctx);
  vm.runInContext("var __sock = new self.WebSocket('wss://game.example/ws');", ctx);
  return {
    __ctx: ctx,
    Page: { addScriptToEvaluateOnNewDocument: async () => { throw new Error('no Page domain in worker'); } },
    Runtime: {
      evaluate: async ({ expression }) => {
        try { return { result: { value: vm.runInContext(expression, ctx) } }; }
        catch (e) { return { result: {}, exceptionDetails: { text: String(e && e.message || e) } }; }
      },
    },
  };
}

test('D4-001: sendProtocol reaches a worker-owned socket (no window in worker global)', async () => {
  const client = makeWorkerClient();
  const wsReplay = new WsReplay({ resolveClient: () => client });
  const ctx = { targetId: 'T1', cdpSessionId: 'worker-session-1', host: 'game.example' };

  const res = await wsReplay.sendProtocol(ctx, JSON.stringify({ cmd: 100002, b: 1000, sid: 'S1' }));
  assert.equal(res.ok, true, 'send must succeed through the worker socket');

  const sock = client.__ctx.__sock;
  assert.equal(sock.sent.length, 1, 'exactly one frame sent through the worker socket');
  assert.match(sock.sent[0], /"cmd":100002/, 'the BET payload was delivered to the socket');
});

test('D4-001: sendProtocol source uses globalThis (worker-safe), never bare window', () => {
  const src = require('node:fs').readFileSync(new URL('../../desktop/cdp/ws-replay.cjs', import.meta.url), 'utf8');
  // The send/count invocation expressions must not reference `window.__wso*`.
  assert.equal(/window\.__wso/.test(src), false, 'no window.__wso* invocation remains');
  assert.ok(/globalThis\.__wsoSendFrame/.test(src), 'send invocation uses globalThis');
  assert.ok(/globalThis\.__wsoSocketCount/.test(src), 'count invocation uses globalThis');
});
