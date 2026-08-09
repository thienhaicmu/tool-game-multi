import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker, classifyFrame, CMD, ROUND_STATE } = require('../../desktop/protocol/aviator.cjs');

// ---------------------------------------------------------------------------
// §5 / §26 — protocol classifier recognises exactly the observed commands.
// ---------------------------------------------------------------------------
test('classifier recognises the confirmed Aviator commands', () => {
  assert.equal(classifyFrame('{"cmd":100005,"iOE":true,"sid":2986908}').type, 'ROUND_OPEN');
  assert.equal(classifyFrame('{"cmd":100006,"sid":1}').type, 'ROUND_LOCK');
  assert.equal(classifyFrame('{"cmd":100007,"sid":1,"odd":1.87}').type, 'ROUND_END');
  assert.equal(classifyFrame('[5,{"cmd":100008,"sid":1}]').type, 'ROUND_OPEN');
  assert.equal(classifyFrame('{"cmd":100009,"odd":1.55,"sid":1}').type, 'ODD_UPDATE');
  assert.equal(classifyFrame('{"cmd":100002,"b":5000,"sid":1,"aid":1,"eid":1}').type, 'BET');
  assert.equal(classifyFrame('{"cmd":100003,"sid":1,"aid":1,"eid":1}').type, 'CASHOUT');
  assert.equal(classifyFrame('{"cmd":100000}').type, 'ENTER');
  assert.equal(classifyFrame('{"cmd":100001}').type, 'ENTER');
});

test('unknown commands stay UNKNOWN and are not dropped', () => {
  const c = classifyFrame('{"cmd":999999,"x":1}');
  assert.equal(c.type, 'UNKNOWN');
  assert.equal(c.known, false);
  assert.equal(c.cmd, 999999);
});

test('malformed / binary / non-object frames classify safely', () => {
  assert.equal(classifyFrame('not json').type, 'UNKNOWN');
  assert.equal(classifyFrame('[1,2,3]').type, 'UNKNOWN');
  assert.equal(classifyFrame('').type, 'UNKNOWN');
  assert.equal(classifyFrame(null).type, 'UNKNOWN');
});

test('classifier extracts only fields the protocol carries', () => {
  const c = classifyFrame('{"eid":1,"b":5000,"wm":7750,"cmd":100003,"aid":1,"odd":1.55}');
  assert.equal(c.wm, 7750); assert.equal(c.odd, 1.55); assert.equal(c.b, 5000); assert.equal(c.aid, 1); assert.equal(c.eid, 1);
  const bet = classifyFrame('{"cmd":100002,"b":5000,"sid":1,"aid":1,"eid":1}');
  assert.equal(bet.wm, undefined, 'no invented wm on bet');
  assert.equal(bet.odd, undefined, 'no invented odd on bet');
});

test('classifier unwraps Aviator plugin frames carried in arrays', () => {
  const bet = classifyFrame('["6","MiniGame","aviatorPlugin",{"cmd":100002,"b":5000,"sid":2986797,"aid":1,"eid":1}]');
  assert.equal(bet.type, 'BET');
  assert.equal(bet.sid, 2986797);
  assert.equal(bet.aid, 1);
  assert.equal(bet.eid, 1);
  const ack = classifyFrame('[5,{"eid":1,"b":5000,"wm":7750,"cmd":100003,"aid":1,"odd":1.55}]');
  assert.equal(ack.type, 'CASHOUT');
  assert.equal(ack.wm, 7750);
  assert.equal(ack.odd, 1.55);
});

test('classifier surfaces login agentId from framed MiniGame arrays', () => {
  const login = classifyFrame('42[1,"MiniGame","","",{"agentId":"1","accessToken":"redacted","reconnect":false}]');
  assert.equal(login.type, 'UNKNOWN');
  assert.equal(login.agentId, '1');
  assert.equal(login.wirePrefix, '42');
});

// ---------------------------------------------------------------------------
// §4 / §26 — round state transitions come ONLY from server frames.
// ---------------------------------------------------------------------------
test('round state machine: OPEN -> LOCKED -> RUNNING -> ENDED', () => {
  const t = new RoundTracker();
  t.observe({ direction: 'recv', raw: '{"cmd":100005,"iOE":true,"sid":2986908}' });
  assert.equal(t.currentRound().sid, 2986908);
  assert.equal(t.currentRound().state, ROUND_STATE.OPEN);

  t.observe({ direction: 'recv', raw: '{"cmd":100006,"sid":2986908}' });
  assert.equal(t.currentRound().state, ROUND_STATE.LOCKED);

  t.observe({ direction: 'recv', raw: '{"cmd":100009,"sid":2986908,"odd":1.55}' });
  assert.equal(t.currentRound().state, ROUND_STATE.RUNNING);
  assert.equal(t.currentRound().lastOdd, 1.55);

  t.observe({ direction: 'recv', raw: '{"cmd":100007,"sid":2986908,"odd":1.87}' });
  assert.equal(t.currentRound().state, ROUND_STATE.ENDED);
  assert.equal(t.currentRound().lastOdd, 1.87);
});

test('round snapshot 100008 can establish the current Aviator round', () => {
  const t = new RoundTracker();
  t.observe({ direction: 'recv', raw: '[5,{"cmd":100008,"sid":2989861,"tB":182000}]' });
  assert.equal(t.currentRound().sid, 2989861);
  assert.equal(t.currentRound().state, ROUND_STATE.OPEN);
});

// ---------------------------------------------------------------------------
// §2 / §26 — MANDATORY: current sid comes from cmd:100005, never arithmetic.
// ---------------------------------------------------------------------------
test('SID source: server 100005 is authoritative, not previousSid+1', () => {
  const t = new RoundTracker();
  t.observe({ direction: 'recv', raw: '{"cmd":100005,"sid":2986802}' });
  assert.equal(t.currentRound().sid, 2986802);
  // Next round jumps by +49; a predictor would have said 2986803. We must follow
  // the server-published sid exactly.
  t.observe({ direction: 'recv', raw: '{"cmd":100005,"sid":2986851}' });
  assert.equal(t.currentRound().sid, 2986851);
  assert.notEqual(t.currentRound().sid, 2986803);
});

test('SID history records deltas as diagnostics only', () => {
  const t = new RoundTracker();
  for (const sid of [2986797, 2986802, 2986851, 2986908]) t.observe({ direction: 'recv', raw: `{"cmd":100005,"sid":${sid}}` });
  const h = t.sidHistory();
  assert.deepEqual(h.map((x) => x.sid), [2986797, 2986802, 2986851, 2986908]);
  assert.deepEqual(h.map((x) => x.delta), [null, 5, 49, 57]);
});

test('client (send) frames never drive round state', () => {
  const t = new RoundTracker();
  t.observe({ direction: 'recv', raw: '{"cmd":100005,"sid":10}' });
  // A client bet/cashout carrying a sid must not change the tracked round.
  t.observe({ direction: 'send', raw: '{"cmd":100002,"b":5000,"sid":999,"aid":1,"eid":1}' });
  assert.equal(t.currentRound().sid, 10);
  assert.equal(t.currentRound().state, ROUND_STATE.OPEN);
});

// ---------------------------------------------------------------------------
// §12 — ActionTrace: client frame -> server ack correlation.
// ---------------------------------------------------------------------------
test('ActionTrace pairs a sent bet with its server ack by cmd+eid', () => {
  const t = new RoundTracker();
  t.observe({ direction: 'recv', raw: '{"cmd":100005,"sid":10}' });
  t.observe({ direction: 'send', raw: '{"cmd":100002,"b":5000,"sid":10,"aid":1,"eid":1}' });
  t.observe({ direction: 'recv', raw: '{"eid":1,"b":5000,"cmd":100002}' });
  const traces = t.actionTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].cmd, CMD.BET);
  assert.ok(traces[0].ack, 'ack correlated');
  assert.equal(traces[0].ack.b, 5000);
});

test('socket context is captured from known frames for the send seam', () => {
  const t = new RoundTracker();
  t.observe({ targetId: 'T1', cdpSessionId: 'S1', url: 'wss://game.host/ws', direction: 'recv', raw: '{"cmd":100005,"sid":10}' });
  const ctx = t.socketContext('T1');
  assert.equal(ctx.targetId, 'T1');
  assert.equal(ctx.host, 'game.host');
  assert.equal(ctx.cdpSessionId, 'S1');
});

test('socket context remembers Socket.IO prefix from login frames', () => {
  const t = new RoundTracker();
  t.observe({ targetId: 'T1', cdpSessionId: 'S1', url: 'wss://game.host/socket.io', direction: 'send', raw: '42[1,"MiniGame","","",{"agentId":"1","accessToken":"redacted","reconnect":false}]' });
  const ctx = t.socketContext('T1');
  assert.equal(ctx.wirePrefix, '42');
});
