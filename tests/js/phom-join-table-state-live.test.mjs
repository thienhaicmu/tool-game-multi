// PHASE 3A regression: stake -> JOIN -> server ack -> TABLE_STATE chain, asserted against the
// REAL frames captured live from a logged-in Phỏm browser (slot A, game_id vgcg_8 / zone Simms).
// Evidence (redacted): client join, server ack, and the server table-state pushed on sitting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');

// --- REAL captured frames -----------------------------------------------------------------
const JOIN  = '[3,"Simms",139,""]';                 // client: select stake 100 + sit -> join code 139
const ACK   = '[3,true,0,-1,null]';                 // server: join accepted
const TABLE = '[5,{"b":100,"tfeg":4000,"ps":[{"a":"Avatar20","sCs":[],"pS":0,"C":true,"rmC":0,"dn":"baycao1002","pid":0,"m":21062,"uid":"1_644555813","r":false,"As":{"gold":21062,"guaranteedGold":0},"dCs":[],"pi":false,"id":0,"sit":0}],"tft":20000,"hpwd":false}]';
const SELF  = '[5,{"cmd":100,"uid":"1_644555813","u":"1_644555813","dn":"baycao1002","As":{"gold":21062}}]';

test('client JOIN is a request carrying the room-join code, NOT server evidence', () => {
  const c = classifyPhomFrame(JOIN);
  assert.equal(c.type, 'JOIN_REQUEST');
  assert.equal(c.op, 3);
  assert.equal(c.channel, 139);
  assert.equal(c.isServerEvidence, false, 'a sent JOIN must never bind the socket / prove membership');
});

test('server join-ack is distinguished from the client request (JOIN_ACCEPTED), still not evidence', () => {
  const c = classifyPhomFrame(ACK);
  assert.equal(c.type, 'JOIN_ACCEPTED');
  assert.equal(c.accepted, true);
  assert.equal(c.isServerEvidence, false, 'the ack alone is not proof of table membership — TABLE_STATE is');
});

test('join code (139) is not any lobby stake-bucket rid seen in CHANNEL_LIST (channel-code != rid)', () => {
  // rs[] entries from the same live session carried rid 141/142/320872; the join code is 139.
  const observedRids = [141, 142, 320872];
  const joinCode = classifyPhomFrame(JOIN).channel;
  assert.ok(!observedRids.includes(joinCode), 'the JOIN room-join code must differ from the lobby rids');
});

test('server TABLE_STATE is authoritative evidence and exposes b + ps[] with sit/uid', () => {
  const c = classifyPhomFrame(TABLE);
  assert.equal(c.type, 'TABLE_STATE');
  assert.equal(c.isServerEvidence, true);
  assert.equal(c.b, 100, 'stake b echoes the selected stake');
  assert.equal(c.ps.length, 1);
  assert.equal(c.ps[0].sit, 0, 'server-assigned seat index');
  assert.equal(c.ps[0].uid, '1_644555813', 'seat carries the player uid');
});

test('context derives stake/seat/players/count from the real chain; membership proof is TABLE_STATE', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  // JOIN (sent) must NOT bind the socket by itself.
  ctx.observe({ raw: JOIN, direction: 'send', targetId: 't1', url: 'wss://x', now: Date.now() });
  assert.equal(ctx.get().socketReady, false, 'sent JOIN alone does not make the context in-table');
  // Own identity then the authoritative table push.
  ctx.observe({ raw: SELF, direction: 'recv', targetId: 't1', url: 'wss://x', now: Date.now() });
  ctx.observe({ raw: TABLE, direction: 'recv', targetId: 't1', url: 'wss://x', now: Date.now() });
  const g = ctx.get();
  assert.equal(g.socketReady, true);
  assert.equal(g.uid, '1_644555813');
  assert.equal(g.selectedStake, 100);
  assert.equal(g.ownSeat, 0);
  assert.equal(g.playerCount, 1);
  assert.equal(g.players.length, 1);
  assert.equal(g.players[0].uid, '1_644555813');
  // No server table id exists in the protocol -> identity is the player-set fingerprint.
  assert.equal(g.physicalTableIdentity.type, 'PLAYER_SET_FINGERPRINT');
  assert.equal(g.physicalTableIdentity.value, '1_644555813');
});
