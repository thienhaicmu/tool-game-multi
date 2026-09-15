// PHASE 3B regression from REAL live evidence (branch fix/phom-browser-persistence-live-monitor).
// Captured live from A/B/C on stake 100: (1) SELF_IDENTITY arrives in two forms — authoritative
// game id (id:0, "<aid>_<n>") and a session token (id:1) — sometimes token-first; (2) a later
// joiner appears to an early joiner as a single-seat delta cmd:200 [5,{p:{...},t:1}]. Both must be
// handled or SAME_TABLE is a false negative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

// Real uids captured live.
const A = '1_644555813', C = '1_644556017', B = '1_644555903';
const selfId = (uid, id) => `[5,{"uid":"${uid}","a":"Avatar20","As":{"gold":20062},"u":"${uid}","dn":"n","cmd":100,"id":${id}}]`;
const tokenId = '[5,{"uid":"lEO7NA3V","a":"Avatar20","As":{"gold":20062,"guarranteed_gold":0,"time":1789434768116},"u":"lEO7NA3V","dn":"n","cmd":100,"id":1}]';
const seatDelta = (uid, sit) => `[5,{"p":{"uid":"${uid}","a":"Avatar20","r":false,"As":{"gold":100},"dn":"n","pid":0,"id":0,"m":100,"sit":${sit}},"t":1,"cmd":200}]`;
const tableState = (b, seats) => `[5,{"b":${b},"tfeg":4000,"ps":[${seats.map(([sit, uid]) => `{"uid":"${uid}","dn":"n","r":false,"m":100,"sit":${sit}}`).join(',')}],"tft":20000,"cmd":202}]`;
const obs = (ctx, raw, now) => ctx.observe({ raw, direction: 'recv', targetId: 't1', url: 'wss://x', now });

test('cmd:200 single-seat JOIN delta classifies as SEAT_UPDATE (server evidence, present)', () => {
  const c = classifyPhomFrame(seatDelta(C, 1));
  assert.equal(c.type, 'SEAT_UPDATE');
  assert.equal(c.isServerEvidence, true);
  assert.equal(c.present, true);
  assert.equal(c.seat.uid, C);
  assert.equal(c.seat.sit, 1);
});

test('SELF_IDENTITY surfaces identityId (0 authoritative, 1 token)', () => {
  assert.equal(classifyPhomFrame(selfId(A, 0)).identityId, 0);
  assert.equal(classifyPhomFrame(tokenId).identityId, 1);
});

test('token identity is a gate fallback; the AUTHORITATIVE game uid overrides it', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  obs(ctx, tokenId, 1);           // id:1 token arrives first -> fallback so the READY gate can pass
  assert.equal(ctx.get().uid, 'lEO7NA3V', 'token binds as fallback (gate needs a uid pre-table)');
  obs(ctx, selfId(A, 0), 2);      // id:0 authoritative arrives -> must override the token
  assert.equal(ctx.get().uid, A, 'authoritative game uid overrides the token and matches ps[] form');
  obs(ctx, tokenId, 3);           // a later token must NOT downgrade the authoritative uid
  assert.equal(ctx.get().uid, A);
});

test('an injected/login uid is overridden by the authoritative game identity', () => {
  const ctx = new PhomContext({ profileId: 'A', uid: 'login-token-xyz' });
  assert.equal(ctx.get().uid, 'login-token-xyz');
  obs(ctx, selfId(A, 0), 1);
  assert.equal(ctx.get().uid, A);
});

test('seat delta folds a later joiner into an early joiner table state (playerCount grows)', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  obs(ctx, selfId(A, 0), 1);
  obs(ctx, tableState(100, [[0, A]]), 2);          // own join snapshot: alone
  assert.equal(ctx.get().playerCount, 1);
  obs(ctx, seatDelta(C, 1), 3);                     // C sits -> delta
  obs(ctx, seatDelta(B, 2), 4);                     // B sits -> delta
  const g = ctx.get();
  assert.equal(g.playerCount, 3);
  assert.deepEqual(g.tableState.uids, [A, C, B].sort());
  assert.equal(g.ownSeat, 0);
});

test('seat re-occupation is bounded by seat index (does not inflate past capacity)', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  obs(ctx, selfId(A, 0), 1);
  obs(ctx, tableState(100, [[0, A], [1, C], [2, B]]), 2);   // full 3-seat base
  assert.equal(ctx.get().playerCount, 3);
  obs(ctx, seatDelta('1_999999999', 3), 3);                 // outsider takes seat 3
  assert.equal(ctx.get().playerCount, 4);
  obs(ctx, seatDelta('1_888888888', 3), 4);                 // seat 3 churns to a new outsider
  const g = ctx.get();
  assert.equal(g.playerCount, 4, 'seat 3 replacement must not push count to 5');
  assert.ok(!g.tableState.uids.includes('1_999999999'), 'prior seat-3 occupant replaced');
  assert.ok(g.tableState.uids.includes('1_888888888'));
});

test('seat delta before any full snapshot is ignored (no stake to anchor)', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  obs(ctx, selfId(A, 0), 1);
  obs(ctx, seatDelta(C, 1), 2);
  assert.equal(ctx.get().tableState, null);
});

// End-to-end: mirror the live co-location where each browser cached a different-age full snapshot
// and learned the rest via cmd:200 deltas. Before folding => not SAME_TABLE; after => SAME_TABLE.
test('HostTableCoordinator: deltas converge divergent per-profile views to SAME_TABLE', () => {
  const send = async () => ({ ok: true });
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, hostId: 'A',
    profiles: [{ id: 'A', send }, { id: 'B', send }, { id: 'C', send }],
  });
  const ing = (id, raw, now) => coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://x', now });
  // identities (authoritative id:0)
  ing('A', selfId(A, 0), 1); ing('B', selfId(B, 0), 1); ing('C', selfId(C, 0), 1);
  // own-join snapshots at DIFFERENT ages (A first/alone, C mid, B last/full)
  ing('A', tableState(100, [[0, A]]), 2);
  ing('C', tableState(100, [[0, A], [1, C]]), 3);
  ing('B', tableState(100, [[0, A], [1, C], [2, B]]), 4);
  // before deltas: A and C have stale sets -> not same table
  assert.notEqual(coord.verifySameTable().result, 'SAME_TABLE');
  // deltas: A learns C then B; C learns B
  ing('A', seatDelta(C, 1), 5); ing('A', seatDelta(B, 2), 6);
  ing('C', seatDelta(B, 2), 6);
  const v = coord.verifySameTable();
  assert.equal(v.result, 'SAME_TABLE', JSON.stringify(v));
  assert.equal(v.playerCount, 3);
});
