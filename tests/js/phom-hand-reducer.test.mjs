import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reduceHand, emptyHand, SYNC } = require('../../desktop/protocol/phom/hand-reducer.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');

const A = '1_A';
const deal = (cs, tp) => classifyPhomFrame(JSON.stringify([5, { cs, cmd: 850, tP: { uid: tp } }]));
const draw = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 852 }]));
const play = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 851 }]));
const meld = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 854 }]));
const end = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 853 }]));

// §22.H — DEAL initialises 9 cards, starts a new round, resets prior cards.
test('DEAL: own hand gets 9 cards + new round boundary', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  assert.equal(h.cardCount, 9);
  assert.equal(h.syncState, SYNC.LIVE);
  assert.equal(h.authoritative, true);
  assert.equal(h.roundSeq, 1);
  assert.equal(h.decodedCards[0].label, 'J♠');
  // a second deal starts a fresh round and discards the old hand
  h = reduceHand(h, deal([0, 1, 2, 3, 4, 5, 6, 7, 8], A), { profileUid: A, seq: 10 });
  assert.equal(h.roundSeq, 2);
  assert.equal(h.cardCount, 9);
  assert.deepEqual(h.cardsRaw, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

// §22.I — DRAW for own uid with sAC becomes the authoritative 10-card hand + sMs saved.
test('DRAW: own sAC replaces hand (count 10) and stores sMs', () => {
  let h = emptyHand('P1', '1_644555813');
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], '1_644555813'), { profileUid: '1_644555813', seq: 1 });
  h = reduceHand(h, draw({ cs: 20, uid: '1_644555813', sAC: [10, 14, 18, 27, 31, 35, 13, 15, 20, 34], sMs: [10, 14, 18, 27, 31, 35] }), { profileUid: '1_644555813', seq: 2 });
  assert.equal(h.cardCount, 10);
  assert.deepEqual(h.cardsRaw, [10, 14, 18, 27, 31, 35, 13, 15, 20, 34]);
  assert.deepEqual(h.serverMelds, [10, 14, 18, 27, 31, 35]);
  assert.equal(h.lastDrawn, 20);
  assert.equal(h.syncState, SYNC.LIVE);
});

// §22.I — a DRAW addressed to ANOTHER uid does not mutate this profile's hidden hand.
test('DRAW for another uid does not change own cards', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  const before = h.cardsRaw.slice();
  h = reduceHand(h, draw({ cs: 20, uid: '1_OTHER', sAC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }), { profileUid: A, seq: 2 });
  assert.deepEqual(h.cardsRaw, before);
  assert.equal(h.cardCount, 9);
});

// §22.J — PLAY: public discard + turn; own discard removes exactly one occurrence.
test('PLAY: own discard removes one card + updates turn', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([38, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  h = reduceHand(h, play({ fP: { uid: A, dCs: 38 }, tP: { uid: 'B' } }), { profileUid: A, seq: 2 });
  assert.equal(h.cardCount, 8);
  assert.equal(h.cardsRaw.includes(38), false);
  assert.equal(h.lastDiscarded, 38);
  assert.equal(h.currentTurnUid, 'B');
  assert.deepEqual(h.discardedCards, [38]);
});

// §22.J — discarding a card not in hand => DESYNCED, never fabricates.
test('PLAY: own discard of a missing card marks DESYNCED', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  h = reduceHand(h, play({ fP: { uid: A, dCs: 51 }, tP: { uid: 'B' } }), { profileUid: A, seq: 2 });
  assert.equal(h.syncState, SYNC.DESYNCED);
  assert.equal(h.lastError, 'PHOM_HAND_DESYNCED');
  assert.equal(h.cardCount, 9); // unchanged, no phantom removal
});

// §22.J — another player's discard only updates public turn/discard, not own hand.
test('PLAY by another player updates turn only', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  h = reduceHand(h, play({ fP: { uid: 'B', dCs: 10 }, tP: { uid: 'C' } }), { profileUid: A, seq: 2 });
  assert.equal(h.cardCount, 9);
  assert.equal(h.currentTurnUid, 'C');
  assert.equal(h.lastDiscarded, 10);
});

// §22.K — MELD attaches public melds for own uid, without dropping hidden cards.
test('MELD: own public meld recorded, hidden hand untouched', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([10, 14, 18, 44, 48, 3, 2, 6, 8], A), { profileUid: A, seq: 1 });
  h = reduceHand(h, meld({ uid: A, mes: [{ meid: 1, cs: [10, 14, 18] }] }), { profileUid: A, seq: 2 });
  assert.equal(h.publicMelds.length, 1);
  assert.deepEqual(h.publicMelds[0].cards, [10, 14, 18]);
  assert.equal(h.cardCount, 9); // meld visibility != removal from hand
});

// §22.L — ROUND_END: final snapshot for own profile + ENDED, no leak into next round.
test('ROUND_END: final snapshot + ENDED, next DEAL is clean', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  h = reduceHand(h, end({ uid: A, sAC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], sMs: [0, 1, 2], fP: { uid: A, lm: -50 } }), { profileUid: A, seq: 2 });
  assert.equal(h.syncState, SYNC.ENDED);
  assert.equal(h.cardCount, 10);
  assert.deepEqual(h.serverMelds, [0, 1, 2]);
  assert.equal(h.resultDelta, -50);
  // new round wipes the old snapshot
  h = reduceHand(h, deal([12, 13, 14, 15, 16, 17, 18, 19, 20], A), { profileUid: A, seq: 3 });
  assert.equal(h.syncState, SYNC.LIVE);
  assert.equal(h.cardCount, 9);
  assert.equal(h.resultDelta, null);
  assert.deepEqual(h.serverMelds, []);
});

// §22.M — duplicate frame does not double-apply; out-of-order (older seq) ignored.
test('duplicate / out-of-order frames are ignored via seq guard', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([38, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 5 });
  const discard = play({ fP: { uid: A, dCs: 38 }, tP: { uid: 'B' } });
  h = reduceHand(h, discard, { profileUid: A, seq: 6 });
  assert.equal(h.cardCount, 8);
  // exact duplicate (same seq) — must NOT remove again
  h = reduceHand(h, discard, { profileUid: A, seq: 6 });
  assert.equal(h.cardCount, 8);
  // late frame from earlier in the round — ignored
  h = reduceHand(h, play({ fP: { uid: A, dCs: 44 }, tP: { uid: 'C' } }), { profileUid: A, seq: 4 });
  assert.equal(h.cardCount, 8);
  assert.equal(h.cardsRaw.includes(44), true);
});

// §22.M — UNKNOWN events never mutate the hand.
test('UNKNOWN events do not mutate the hand', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  const before = { ...h };
  h = reduceHand(h, classifyPhomFrame(JSON.stringify([5, { cmd: 999999 }])), { profileUid: A, seq: 2 });
  assert.deepEqual(h.cardsRaw, before.cardsRaw);
  assert.equal(h.syncState, SYNC.LIVE);
});

// §14/§22.M — disconnect turns a LIVE hand STALE (never keeps showing LIVE).
test('CONTROL DISCONNECT flips LIVE -> STALE', () => {
  let h = emptyHand('P1', A);
  h = reduceHand(h, deal([40, 44, 48, 3, 2, 6, 8, 27, 42], A), { profileUid: A, seq: 1 });
  h = reduceHand(h, { type: 'CONTROL', control: 'DISCONNECT' }, { profileUid: A });
  assert.equal(h.syncState, SYNC.STALE);
});
