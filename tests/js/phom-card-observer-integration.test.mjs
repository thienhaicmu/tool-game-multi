// PHASE 6.3.3.2 — CARD OBSERVER ↔ HostTableCoordinator integration. The observer is fed from the SAME
// ingest() path the coordinator already uses (no second WS listener / no second CDP connection). Verifies
// slot→uid binding from the authoritative ctx.uid(), a 'cards' emit per hand/table frame, cross-socket
// dedup of the echoed public discard, and the deep-cloned snapshot shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

function coordinator() {
  return new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, send: async () => ({ ok: true }) })) });
}
const ident = (id) => `[5,{"uid":"1_${id}","As":{"gold":1},"cmd":100,"id":0}]`;
const deal = (cards) => JSON.stringify([5, { cs: cards, cmd: 850 }]);
const play = (uid, dCs, tp) => JSON.stringify([5, { fP: { uid, dCs }, tP: { uid: tp }, cmd: 851 }]);
const ing = (coord, id, raw, now) => coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://s', now });

test('coordinator exposes cardObserverSnapshot() fed by the shared ingest path', () => {
  const coord = coordinator();
  assert.equal(typeof coord.cardObserverSnapshot, 'function');
  for (const id of ['B1', 'B2', 'B3']) ing(coord, id, ident(id), 1);
  ing(coord, 'B1', deal([0, 1, 2, 3, 4, 5, 6, 7, 8]), 2);
  const snap = coord.cardObserverSnapshot();
  // slot B1 bound to its authoritative own uid (learned from cmd:100 id:0), NOT the browser index
  assert.equal(snap.slotBinding.B1, '1_B1');
  assert.equal(snap.players['1_B1'].currentCards.length, 9);
  assert.equal(snap.remaining.count, 52 - 9);
});

test("a 'cards' event is emitted for every hand/table frame the coordinator ingests", () => {
  const coord = coordinator();
  for (const id of ['B1', 'B2', 'B3']) ing(coord, id, ident(id), 1);
  let cardsEvents = 0; let last = null;
  coord.on('cards', (c) => { cardsEvents += 1; last = c; });
  ing(coord, 'B1', deal([0, 1, 2, 3, 4, 5, 6, 7, 8]), 2);
  assert.ok(cardsEvents >= 1, 'cards emitted on a DEAL frame');
  assert.equal(last.players['1_B1'].currentCards.length, 9);
});

test('a public discard echoed on all three browser sockets is deduped to ONE at the coordinator', () => {
  const coord = coordinator();
  for (const id of ['B1', 'B2', 'B3']) ing(coord, id, ident(id), 1);
  ing(coord, 'B1', deal([0, 1, 2, 3, 4, 5, 6, 7, 8]), 2);
  // '1_B1' discards code 8 — the SAME PLAY frame is observed on B1, B2 and B3's sockets
  ing(coord, 'B1', play('1_B1', 8, '1_B2'), 3);
  ing(coord, 'B2', play('1_B1', 8, '1_B2'), 4);
  ing(coord, 'B3', play('1_B1', 8, '1_B2'), 5);
  const snap = coord.cardObserverSnapshot();
  assert.equal(snap.players['1_B1'].discardedHistory.length, 1, 'one discard, not three echoes');
  assert.deepEqual(snap.discardPile, [8]);
});

test('a non-controlled player discard is observed even though no 4th browser is open', () => {
  const coord = coordinator();
  for (const id of ['B1', 'B2', 'B3']) ing(coord, id, ident(id), 1);
  ing(coord, 'B1', play('OTHER_9', 51, '1_B1'), 2);
  const snap = coord.cardObserverSnapshot();
  assert.ok(snap.players.OTHER_9, 'other player tracked from the public discard');
  assert.equal(snap.players.OTHER_9.controlled, false);
  assert.equal(snap.players.OTHER_9.discardedHistory[0].card, 51);
});

test('the coordinator card snapshot is deep-cloned/frozen (does not leak internal state)', () => {
  const coord = coordinator();
  for (const id of ['B1', 'B2', 'B3']) ing(coord, id, ident(id), 1);
  ing(coord, 'B1', deal([0, 1, 2, 3, 4, 5, 6, 7, 8]), 2);
  const snap = coord.cardObserverSnapshot();
  assert.throws(() => { snap.discardPile.push(1); });
  // a second snapshot is an independent object
  assert.notEqual(coord.cardObserverSnapshot(), snap);
});
