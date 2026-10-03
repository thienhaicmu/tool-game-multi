// TẠO (capture 2026-10-02): the game client answers the tool's 313 by joining the named table itself,
// [3,"Simms",rid,""] — at a stranger's table, where it auto-readies and the round starts ("dò vào auto sẵn sàng nên
// đánh luôn"). The reference tool rewrites that very frame to the U+200B password so the server refuses it (103).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WS_HOOK } = require('../../desktop/cdp/ws-replay.cjs');
const { rewriteOutgoing, armExpression } = require('../../desktop/protocol/phom/phom-probe-guard.cjs');
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

const ZW = '​';

test('rule: only the game\'s own empty-password table join, only while armed', () => {
  assert.equal(rewriteOutgoing('[3,"Simms",7907065,""]', 2000, 1000), JSON.stringify([3, 'Simms', 7907065, ZW]));
  assert.equal(rewriteOutgoing('[3,"Simms",7907065,""]', 1000, 2000), '[3,"Simms",7907065,""]', 'not armed → untouched');
  for (const f of ['[3,"Simms",145,"",true]', '[8,"Simms",7907065,"",8]', '[4,"Simms",-1]', '[5,"Simms",-1,{"cmd":5}]', '[3,"Simms",7907065,"abc"]']) {
    assert.equal(rewriteOutgoing(f, 2000, 1000), f, f + ' is never touched');
  }
});

test('in the page: WS_HOOK + the armed guard put the U+200B join on the wire instead of the game\'s', () => {
  const wire = [];
  class FakeWS { constructor(url) { this.url = url; this.readyState = 1; } send(d) { wire.push(d); } }
  const ctx = vm.createContext({ WebSocket: FakeWS, Date });
  ctx.globalThis = ctx;
  vm.runInContext(WS_HOOK, ctx);
  const ws = vm.runInContext('new WebSocket("wss://x/websocket")', ctx);
  ws.send('[3,"Simms",7907065,""]');                         // not armed yet: the game's join goes out as is
  assert.equal(vm.runInContext(armExpression(), ctx), true);
  assert.equal(vm.runInContext(armExpression(), ctx), true);  // re-arming installs nothing twice
  ws.send('[6,"Simms","channelPlugin",{"cmd":313,"gid":8,"aid":1,"b":20000}]');
  ws.send('[3,"Simms",7881577,""]');                         // the game answering the 313
  ws.send('[3,"Simms",145,"",true]');                         // Dò Key's quick-play: untouched
  assert.deepEqual(wire, ['[3,"Simms",7907065,""]', '[6,"Simms","channelPlugin",{"cmd":313,"gid":8,"aid":1,"b":20000}]', JSON.stringify([3, 'Simms', 7881577, ZW]), '[3,"Simms",145,"",true]']);
  assert.equal(JSON.parse(wire[2])[3], ZW);
  vm.runInContext('globalThis.__phomProbeArm = 0', ctx);      // window over → the page is itself again
  ws.send('[3,"Simms",7881577,""]');
  assert.equal(wire.at(-1), '[3,"Simms",7881577,""]');
});

test('TẠO arms the guard on the browser\'s own socket before EVERY 313', async () => {
  const sent = [];
  const coord = new HostTableCoordinator({
    now: Date.now, environmentAuthorized: () => true, sessionId: 't',
    profiles: [{ id: 'B1', uid: '1_1', send: async (f) => { sent.push(f); return { ok: true }; }, armProbe: async (ctx) => { sent.push('ARM:' + ctx.targetId); return { ok: true }; } }],
  });
  const feed = (raw) => coord.ingest('B1', { raw, direction: 'recv', targetId: 'T1', url: 'wss://sim', now: Date.now() });
  feed('[5,{"uid":"1_1","As":{"gold":1},"cmd":100,"id":0}]');
  feed(JSON.stringify([5, { rs: [{ rid: 145, gid: 8, b: 20000, Mu: 4, uC: 3, zn: 'Simms' }] }]));
  const run = coord.scanForKeyTable('B1', { stake: 20000, keyUid: '1_9', budgetMs: 0, timeoutMs: 30, pace: async () => true });
  const res = await run;
  assert.equal(res.ok, false);
  const ask = sent.findIndex((f) => /"cmd":313/.test(f));
  assert.ok(ask > 0 && sent[ask - 1] === 'ARM:T1', JSON.stringify(sent));
  coord.stop();
});
