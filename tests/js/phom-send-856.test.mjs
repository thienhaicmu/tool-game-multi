// 3.2 ĐÁNH BÀI B1 — GỬI BÀI (856, game bundle: PhomCommand.GUI_BAI handled by guiBai(uid, aMs)) is PUBLIC: uid sent
// each aMs[].cs into the laid phỏm aMs[].meid. Before this the tool never read it, so laid phỏm on the table never
// grew and a sent card still counted as "unseen".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { createCardObserver, STATUS } = require('../../desktop/protocol/phom/phom-card-observer.cjs');
const { reduceHand, emptyHand } = require('../../desktop/protocol/phom/hand-reducer.cjs');

const frame = (o) => classifyPhomFrame(JSON.stringify([5, o]));
let clock = 1000;
const feed = (obs, cls, extra = {}) => obs.ingestFrame({ cls, now: clock++, ...extra });

test('856 is classified as the public SEND event and carries aMs', () => {
  const c = frame({ cmd: 856, uid: 'B', aMs: [{ cs: 22, meid: 7 }] });
  assert.equal(c.type, 'SEND');
  assert.equal(c.isHandEvent, true);
  assert.equal(c.isServerEvidence, true);
  assert.deepEqual(c.aMs, [{ cs: 22, meid: 7 }]);
});

test('a sent card joins the laid phỏm it was sent into, leaves the sender\'s hand, is out of the unseen pool', () => {
  const obs = createCardObserver();
  feed(obs, frame({ cmd: 850, cs: [22, 30, 31, 32, 40, 41, 42, 50, 51], tP: { uid: 'B' } }), { slot: 'B2', ownUid: 'B' });
  feed(obs, frame({ cmd: 854, uid: 'A', mes: [{ meid: 7, cs: [10, 14, 18] }] }), { slot: 'B2', ownUid: 'B' });
  feed(obs, frame({ cmd: 856, uid: 'B', aMs: [{ cs: 22, meid: 7 }] }), { slot: 'B2', ownUid: 'B' });
  const s = obs.getSnapshot();
  assert.deepEqual(s.players.A.melds[0].cards, [10, 14, 18, 22], 'the phỏm on the table grew');
  assert.equal(s.players.B.currentCards.includes(22), false, 'gone from the sender\'s hand');
  assert.deepEqual(s.players.B.sentCards, [22]);
  assert.equal(obs.getLedger().find((e) => e.code === 22).status, STATUS.MELDED);
  assert.equal(s.remaining.codes.includes(22), false);
  // the same push read on another of our sockets is not applied twice
  feed(obs, frame({ cmd: 856, uid: 'B', aMs: [{ cs: 22, meid: 7 }] }), { slot: 'B1', ownUid: 'C' });
  assert.deepEqual(obs.getSnapshot().players.A.melds[0].cards, [10, 14, 18, 22]);
  assert.deepEqual(obs.getSnapshot().players.B.sentCards, [22]);
});

test('a new deal starts with nothing sent', () => {
  const obs = createCardObserver();
  feed(obs, frame({ cmd: 850, cs: [22, 30, 31, 32, 40, 41, 42, 50, 51] }), { slot: 'B2', ownUid: 'B' });
  feed(obs, frame({ cmd: 854, uid: 'A', mes: [{ meid: 7, cs: [10, 14, 18] }] }), { slot: 'B2', ownUid: 'B' });
  feed(obs, frame({ cmd: 856, uid: 'B', aMs: [{ cs: 22, meid: 7 }] }), { slot: 'B2', ownUid: 'B' });
  obs.resetRound({ now: clock++, reason: 'TEST' });
  assert.deepEqual((obs.getSnapshot().players.B || { sentCards: [] }).sentCards, []);
});

test('hand reducer: the sender\'s own hand drops the sent card; another player\'s send changes nothing', () => {
  let h = emptyHand('P2', 'B');
  h = reduceHand(h, frame({ cmd: 850, cs: [22, 30, 31, 32, 40, 41, 42, 50, 51] }), { profileUid: 'B', seq: 1 });
  h = reduceHand(h, frame({ cmd: 856, uid: 'B', aMs: [{ cs: 22, meid: 7 }] }), { profileUid: 'B', seq: 2 });
  assert.equal(h.cardsRaw.includes(22), false);
  assert.equal(h.cardsRaw.length, 8);
  const before = h.cardsRaw.slice();
  h = reduceHand(h, frame({ cmd: 856, uid: 'X', aMs: [{ cs: 30, meid: 9 }] }), { profileUid: 'B', seq: 3 });
  assert.deepEqual(h.cardsRaw, before);
});
