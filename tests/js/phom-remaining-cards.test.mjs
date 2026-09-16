// PHASE 6 — Screen 2 REMAINING CARDS: allKnownCards (default full 52-deck) minus every card held by
// Browser 1 + Browser 2 + Browser 3. NOT "player 4". Pure, dedup-safe, round-reset by recomputation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { remainingCardCodes, remainingCardsView, fullDeck } = require('../../desktop/protocol/phom/remaining-cards.cjs');
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

// 26 — no browser cards => remaining = all known (full deck)
test('no browser cards => remaining is the full 52-card deck', () => {
  const r = remainingCardCodes([[], [], []]);
  assert.equal(r.length, 52);
  assert.deepEqual(r, fullDeck());
});

// 27 — exclude Browser 1
test('excludes Browser 1 cards', () => {
  const r = remainingCardCodes([[0, 1, 2], [], []]);
  assert.equal(r.length, 49);
  for (const c of [0, 1, 2]) assert.ok(!r.includes(c));
});

// 28 — exclude Browser 1 + 2
test('excludes Browser 1 and Browser 2 cards', () => {
  const r = remainingCardCodes([[0, 1], [10, 11], []]);
  assert.equal(r.length, 48);
  for (const c of [0, 1, 10, 11]) assert.ok(!r.includes(c));
});

// 29 — exclude all three
test('excludes all three browsers', () => {
  const b1 = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const b2 = [9, 10, 11, 12, 13, 14, 15, 16, 17];
  const b3 = [18, 19, 20, 21, 22, 23, 24, 25, 26];
  const r = remainingCardCodes([b1, b2, b3]);
  assert.equal(r.length, 52 - 27);
  for (const c of [...b1, ...b2, ...b3]) assert.ok(!r.includes(c));
});

// 30 — duplicate cards across/within browsers never produce duplicates in remaining
test('duplicate cards do not create duplicates in remaining', () => {
  const r = remainingCardsView([[0, 0, 1], [1, 2], [2, 2]]);
  const set = new Set(r.codes);
  assert.equal(set.size, r.codes.length, 'no duplicates');
  assert.equal(r.count, 52 - 3, 'only 0,1,2 excluded once each');
});

// 31/26 — a custom known set (e.g. cards seen so far) is respected
test('respects a custom knownCards set (not the full deck)', () => {
  const r = remainingCardCodes([[5]], { knownCards: [5, 6, 7, 8] });
  assert.deepEqual(r, [6, 7, 8]);
});

// invalid codes are ignored (never decoded as garbage)
test('invalid card codes are ignored, valid remainder still decodes', () => {
  const r = remainingCardsView([[-1, 99, 3.5, 0]], {});
  assert.ok(!r.codes.includes(0) === false ? true : true); // 0 excluded
  assert.ok(!r.codes.includes(0), '0 excluded');
  assert.equal(r.count, 51);
  assert.ok(r.cards.every((c) => c.label && c.rank && c.suit), 'remainder decodes cleanly');
});

// decoded view carries label/rank/suit/color and a count
test('view provides decoded label/rank/suit/color + count', () => {
  const r = remainingCardsView([[], [], []]);
  assert.equal(r.count, 52);
  assert.equal(r.cards.length, 52);
  assert.ok(r.cards.every((c) => typeof c.label === 'string' && (c.color === 'red' || c.color === 'black')));
});

// 33/34/35 + 27 — coordinator.remainingCards reads each browser's CURRENT hand (dealt cards excluded)
test('coordinator.remainingCards excludes each browser\'s dealt hand; new deal recomputes', () => {
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, send: async () => ({ ok: true }) })) });
  // bind sockets + own uid so DEAL frames reduce into the owning browser's hand
  for (const id of ['B1', 'B2', 'B3']) coord.ingest(id, { raw: `[5,{"uid":"1_${id}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://s', now: 1 });
  // no hands yet => full deck
  assert.equal(coord.remainingCards().count, 52);
  // DEAL 9 cards to B1 (cmd:850 cs[]) — its own authoritative hand
  const deal = (cards) => JSON.stringify([5, { cs: cards, cmd: 850 }]);
  coord.ingest('B1', { raw: deal([0, 1, 2, 3, 4, 5, 6, 7, 8]), direction: 'recv', targetId: 'B1', url: 'wss://s', now: 2 });
  let rem = coord.remainingCards();
  assert.equal(rem.count, 52 - 9, 'B1 hand excluded');
  for (const c of [0, 1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(!rem.codes.includes(c));
  // DEAL to B2 as well
  coord.ingest('B2', { raw: deal([9, 10, 11, 12, 13, 14, 15, 16, 17]), direction: 'recv', targetId: 'B2', url: 'wss://s', now: 3 });
  rem = coord.remainingCards();
  assert.equal(rem.count, 52 - 18, 'B1 + B2 hands excluded');
  // a NEW deal replaces B1's hand (no stale carry): recomputation uses the current hand only
  coord.ingest('B1', { raw: deal([40, 41, 42, 43, 44, 45, 46, 47, 48]), direction: 'recv', targetId: 'B1', url: 'wss://s', now: 4 });
  rem = coord.remainingCards();
  // old B1 cards 0..8 are back in the remaining set; new 40..48 excluded
  assert.ok(rem.codes.includes(0), 'stale B1 card returned to remaining after new deal');
  assert.ok(!rem.codes.includes(40), 'new B1 card excluded');
});
