// §43 — TWO models track each controlled browser's own hand from the SAME frame stream:
//   hand-reducer   (per browser, dedup by capture seq)      → the per-browser card cells
//   card-observer  (table-wide, dedup by evidence key)       → the safe-card analyzer + remaining cards
// They must never disagree about what a browser holds, or the screen would show one hand while the
// analysis reasons about another. This drives the REAL coordinator (which feeds both) through a full round
// and compares the two after every frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

const UID = { B1: '1_1', B2: '1_2', B3: '1_3' };

function mk() {
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: async () => ({ ok: true }) })) });
  let seq = 1;
  const feed = (id, obj) => coord.ingest(id, { raw: JSON.stringify([5, obj]), direction: 'recv', targetId: id, url: 'wss://sim', seq: seq++, now: seq });
  for (const id of ['B1', 'B2', 'B3']) { feed(id, { uid: UID[id], As: { gold: 1 }, cmd: 100, id: 0 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, feed };
}

const sorted = (a) => (a || []).slice().sort((x, y) => x - y);
function assertAgree(coord, step) {
  const hands = coord.handsSnapshot();
  const obs = coord.cardObserverSnapshot();
  for (const id of ['B1', 'B2', 'B3']) {
    const reducer = hands.find((h) => h.profileId === id);
    const observed = obs.players[UID[id]];
    const a = sorted(reducer && reducer.cards);
    const b = sorted(observed && observed.currentCards);
    assert.deepEqual(a, b, `${step}: ${id} — reducer ${JSON.stringify(a)} vs observer ${JSON.stringify(b)}`);
  }
}

test('the reducer and the observer agree on every browser\'s hand through a full round', () => {
  const { coord, feed } = mk();
  const all = ['B1', 'B2', 'B3'];
  const table = { b: 100, ps: [{ uid: UID.B1, sit: 0 }, { uid: UID.B2, sit: 1 }, { uid: UID.B3, sit: 2 }, { uid: 'x', sit: 3 }], cmd: 202 };
  for (const id of all) feed(id, table);
  assertAgree(coord, 'seated');

  feed('B1', { cs: [0, 4, 8, 13, 17, 21, 30, 40, 50, 51], cmd: 850 }); assertAgree(coord, 'B1 deal');
  feed('B2', { cs: [1, 5, 9, 14, 18, 22, 31, 41, 44], cmd: 850 });     assertAgree(coord, 'B2 deal');
  feed('B3', { cs: [2, 6, 10, 15, 19, 23, 32, 42, 45], cmd: 850 });    assertAgree(coord, 'B3 deal');

  // B1 discards 51; the PLAY is public, echoed on all three sockets
  for (const id of all) feed(id, { fP: { uid: UID.B1, dCs: 51 }, tP: { uid: UID.B2 }, cmd: 851 });
  assertAgree(coord, 'B1 discard (echoed x3)');

  // B2 draws 33: only B2's own socket carries the full hand
  feed('B2', { uid: UID.B2, cs: 33, sAC: [1, 5, 9, 14, 18, 22, 31, 33, 41, 44], sMs: [1, 5, 9], cmd: 852 });
  for (const id of ['B1', 'B3']) feed(id, { uid: UID.B2, cmd: 852 }); // public draw: no card exposed
  assertAgree(coord, 'B2 draw');

  for (const id of all) feed(id, { fP: { uid: UID.B2, dCs: 44 }, tP: { uid: UID.B3 }, cmd: 851 });
  assertAgree(coord, 'B2 discard');

  // B1 lays a public phỏm (A♠ 2♠ 3♠) — laid cards stay in the server hand in BOTH models
  for (const id of all) feed(id, { uid: UID.B1, mes: [{ meid: 1, cs: [0, 4, 8] }], cmd: 854 });
  assertAgree(coord, 'B1 meld');

  // round end: each browser receives its own final hand
  feed('B1', { uid: UID.B1, sAC: [0, 4, 8, 13, 17, 21, 30, 40, 50], sMs: [0, 4, 8], fP: { uid: UID.B1, lm: 0 }, cmd: 853 });
  assertAgree(coord, 'round end');
});

test('a duplicated / re-delivered frame is absorbed identically by both models', () => {
  const { coord, feed } = mk();
  feed('B1', { cs: [0, 4, 8, 13], cmd: 850 });
  const play = { fP: { uid: UID.B1, dCs: 13 }, tP: { uid: UID.B2 }, cmd: 851 };
  feed('B1', play); feed('B1', play); feed('B2', play); // echo + re-delivery
  assertAgree(coord, 'after duplicated discard');
  assert.deepEqual(sorted(coord.cardObserverSnapshot().players[UID.B1].currentCards), [0, 4, 8]);
});
