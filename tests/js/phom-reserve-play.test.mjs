// User 2026-10-09: "nếu acc dự bị thay thế 1 trong 3 acc thì có bị vấn đề gì không?" — the ĐÁNH BÀI tab after ĐỔI, on
// the REAL coordinator + card observer: P1–P3 play with a stranger, a reserve P4 is in the session, P1 ↔ P4 swap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const help = require('../../desktop/protocol/phom/phom-play-help.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');

const UID = { R1: '1_1', R2: '1_2', R3: '1_3', R4: '1_4' };
const S = 's_1';
const hand = (k) => Array.from({ length: 9 }, (_, i) => encodeCard((k * 3 + i) % 13, (k + i) % 4));
function mk() {
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(),
    profiles: ['R1', 'R2', 'R3'].map((id) => ({ id, displayName: id, send: async () => ({ ok: true }) })) });
  const feed = (id, o) => coord.ingest(id, { raw: JSON.stringify(o), direction: 'recv', targetId: 't-' + id, url: 'wss://sim', now: Date.now() });
  for (const id of ['R1', 'R2', 'R3']) { feed(id, [5, { uid: UID[id], As: { gold: 1 }, cmd: 100, id: 0 }]); coord.setIdentity(id, { aid: '1' }); }
  coord.addProfile({ id: 'R4', displayName: 'R4', send: async () => ({ ok: true }) });
  feed('R4', [5, { uid: UID.R4, As: { gold: 1 }, cmd: 100, id: 0 }]);
  return { coord, feed };
}
// one round at the table: seats, a deal to every playing browser (own hands), the first play
function round(coord, feed, seats, hands) {
  const lpi = seats.map((x) => UID[x] || x);
  const ours = seats.filter((x) => UID[x]);
  for (const id of ours) feed(id, [5, { ps: lpi.map((uid, sit) => ({ uid, sit, C: sit === 0 })), cmd: 202 }]);
  for (const id of ours) feed(id, [5, { cs: hands[id], lpi, cmd: 850, tP: { uid: lpi[0] } }]);
}
const endRound = (coord, feed, ids) => { for (const id of ids) feed(id, [5, { ps: [], fP: { uid: UID.R2 }, cmd: 855 }]); };

test('ĐỔI between rounds: P1 is the reserve\'s account in the next round — its own hand, turn order, ăn, lượt', () => {
  const { coord, feed } = mk();
  round(coord, feed, ['R1', S, 'R2', 'R3'], { R1: hand(0), R2: hand(1), R3: hand(2) });
  endRound(coord, feed, ['R1', 'R2', 'R3']);
  assert.equal(coord.swapProfiles('R1', 'R4'), true);
  assert.deepEqual(coord.playingIds(), ['R4', 'R2', 'R3']);
  // the next round: the reserve sits where P1 sat
  round(coord, feed, ['R4', S, 'R2', 'R3'], { R4: hand(3), R2: hand(1), R3: hand(2) });
  const snap = coord.cardObserverSnapshot();
  assert.equal(snap.slotBinding.B1, UID.R4, 'P1 = the reserve\'s account');
  assert.equal(snap.players[UID.R1].controlled, false, 'the old account is not ours any more');
  const h = help.playHelp(snap, UID.R4);
  assert.ok(h, 'the ĐÁNH BÀI tab of P1 has a hand');
  assert.deepEqual(h.ranking.map((x) => x.code).sort((a, b) => a - b), hand(3).slice().sort((a, b) => a - b), 'the reserve\'s own cards, nothing of the old P1');
  assert.deepEqual(h.turn, { turn: 1, last: false }, 'its turns count from 0');
  assert.equal(help.prevOf(snap, UID.R4), UID.R3, 'turn order from this round\'s deal (lpi), not the old one');
  assert.equal(coord.uidOf('R4'), UID.R4, 'the check before a press finds its account');
  // P3 discards → the swapped-in P1 may eat it
  for (const id of ['R4', 'R2', 'R3']) feed(id, [5, { fP: { uid: UID.R3, dCs: hand(2)[0] }, tP: { uid: UID.R4 }, cmd: 851 }]);
  const t = help.takeInfo(coord.cardObserverSnapshot(), UID.R4);
  assert.equal(t.ok, true); assert.equal(t.prevUid, UID.R3);
  // the other accounts' help never sees the reserve's cards (public view)
  const pv = help.publicView(coord.cardObserverSnapshot(), UID.R2);
  assert.deepEqual(pv.players[UID.R4].currentCards, []);
});

test('ĐỔI in the middle of a round: the new P1 waits for the next deal; the old account plays on as a stranger', () => {
  const { coord, feed } = mk();
  round(coord, feed, ['R1', S, 'R2', 'R3'], { R1: hand(0), R2: hand(1), R3: hand(2) });
  assert.equal(coord.swapProfiles('R1', 'R4'), true);
  const snap = coord.cardObserverSnapshot();
  assert.equal(help.playHelp(snap, UID.R4), null, 'not dealt into this round → the tab says "Chưa có bài"');
  // P2's help: the old P1 is now just another player — its hand is not used
  const h2 = help.playHelp(snap, UID.R2);
  assert.ok(h2);
  assert.deepEqual(help.publicView(snap, UID.R2).players[UID.R1].currentCards, []);
});
