import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WS_HOOK } = require('../../desktop/cdp/ws-replay.cjs');

function createPageContext() {
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 1;
      this.sent = [];
    }

    send(data) {
      this.sent.push(data);
    }
  }

  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  const context = { window: { WebSocket: FakeWebSocket } };
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
