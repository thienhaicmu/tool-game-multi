import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WS_HOOK } = require('../../desktop/cdp/ws-replay.cjs');

class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 1;
    this.sent = [];
  }
  send(data) { this.sent.push(data); }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

// A real browser PAGE: globalThis === window and WebSocket is a top-level global.
function createPageContext() {
  const context = { WebSocket: FakeWebSocket };
  context.window = context;      // window === globalThis, as in a real page
  vm.createContext(context);
  return context;
}

// A real Web WORKER: globalThis === self, there is NO `window`, and WebSocket is a
// top-level global. This is where Aviator-style games often open their socket.
function createWorkerContext() {
  const context = { WebSocket: FakeWebSocket };
  context.self = context;        // self === globalThis, no window
  vm.createContext(context);
  return context;
}

test('WS_HOOK tracks newly constructed sockets before the page sends', () => {
  const context = createPageContext();
  vm.runInContext(WS_HOOK, context);

  const ws = vm.runInContext("new window.WebSocket('wss://game.example/websocket')", context);
  const sent = vm.runInContext("window.__wsoSendFrame('game.example', 'bet-frame')", context);

  assert.equal(sent, true);
  assert.deepEqual(ws.sent, ['bet-frame']);
});

test('WS_HOOK still tracks sockets that existed before injection once they send', () => {
  const context = createPageContext();
  const existing = vm.runInContext("new window.WebSocket('wss://game.example/websocket')", context);

  vm.runInContext(WS_HOOK, context);
  existing.send('heartbeat');
  const sent = vm.runInContext("window.__wsoSendFrame('game.example', 'cashout-frame')", context);

  assert.equal(sent, true);
  assert.deepEqual(existing.sent, ['heartbeat', 'cashout-frame']);
});

// WU-D.3 (D3-001): the send-hook MUST work inside a Web Worker (no `window`), or a game
// that hosts its WebSocket in a worker fails with "No tracked open WebSocket in this
// frame" even though the passive observer sees frames.
test('WS_HOOK works in a Web Worker global (no window) — D3-001', () => {
  const context = createWorkerContext();
  assert.equal(context.window, undefined, 'worker context has no window');
  vm.runInContext(WS_HOOK, context);

  // Hook installed against the worker global.
  assert.equal(vm.runInContext('typeof self.__wsoSendFrame', context), 'function');
  const ws = vm.runInContext("new self.WebSocket('wss://game.example/ws')", context);
  const sent = vm.runInContext("self.__wsoSendFrame('game.example', 'bet-in-worker')", context);
  assert.equal(sent, true);
  assert.deepEqual(ws.sent, ['bet-in-worker']);
  assert.equal(vm.runInContext("self.__wsoSocketCount('game.example')", context), 1);
});

// Guard against silent regressions of the fix: the hook source resolves the global
// via globalThis/self (worker-safe), not a bare `window`.
test('WS_HOOK source is worker-safe (globalThis, not window-only)', () => {
  assert.ok(/globalThis/.test(WS_HOOK), 'hook resolves global via globalThis');
  assert.ok(/typeof self/.test(WS_HOOK), 'hook falls back to self for workers');
});
