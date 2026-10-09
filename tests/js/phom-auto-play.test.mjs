import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const autoPlay = require('../../desktop/protocol/phom/phom-auto-play.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');

const card = (rank, suit) => rank * 4 + suit;
const H = 3;
const D = 2;
const SUIT = { '♠': 0, '♣': 1, '♦': 2, '♥': 3 };
const RANK = { A: 0, J: 10, Q: 11, K: 12 };
const c = (text) => {
  const s = text.slice(-1);
  const r = text.slice(0, -1);
  return encodeCard(Object.prototype.hasOwnProperty.call(RANK, r) ? RANK[r] : Number(r) - 1, SUIT[s]);
};
const cs = (text) => text.split(/\s+/).filter(Boolean).map(c);

function strategySnap({ mine, next, eats = [], money = { A: 500, B: 1000, C: 10 } }) {
  return {
    roundSeq: 1,
    roundPlayers: ['A', 'B', 'C'],
    nextOf: { A: 'B', B: 'C', C: 'A' },
    slotBinding: { B1: 'A', B2: 'B', B3: 'C' },
    players: {
      A: { uid: 'A', currentCards: [], melds: [], discardedHistory: [], sentCards: [], money: money.A },
      B: { uid: 'B', currentCards: mine, melds: [], discardedHistory: [{ card: c('A♠') }], sentCards: [], money: money.B },
      C: { uid: 'C', currentCards: next, melds: [], discardedHistory: [], sentCards: [], money: money.C },
    },
    ledger: mine.map((code) => ({ code, status: 'HAND', ownerUid: 'B' })).concat(next.map((code) => ({ code, status: 'HAND', ownerUid: 'C' }))),
    observedDiscardEvents: [],
    eats,
  };
}

test('Tự đánh keeps running when the round includes a player outside the tool', () => {
  const snap = {
    roundSeq: 1,
    roundPlayers: ['me', 'stranger'],
    slotBinding: { B1: 'me', B2: null, B3: null },
    players: {
      me: { uid: 'me', currentCards: [0, 4, 8], melds: [], discardedHistory: [], sentCards: [] },
      stranger: { uid: 'stranger', currentCards: [], melds: [], discardedHistory: [], sentCards: [] },
    },
    observedDiscardEvents: [],
    eats: [],
  };

  assert.deepEqual(autoPlay.tableGuard(snap, ['me']), { ok: true });

  const step = autoPlay.nextStep(snap, 'me', ['BOC'], new Set(), ['me']);
  assert.equal(step.action, 'BOC');
  assert.equal(step.stop, undefined);
  assert.notEqual(step.code, 'AUTO_STRANGER');
});

test('Tự đánh can act from an observed hand even when roundPlayers is missing', () => {
  const snap = {
    roundSeq: 1,
    roundPlayers: [],
    slotBinding: { B1: 'me' },
    players: {
      me: { uid: 'me', currentCards: [0, 4, 8], melds: [], discardedHistory: [], sentCards: [] },
    },
    observedDiscardEvents: [],
    eats: [],
  };

  assert.deepEqual(autoPlay.tableGuard(snap, [], 'me'), { ok: true });
  assert.equal(autoPlay.nextStep(snap, 'me', ['BOC'], new Set(), []).action, 'BOC');
});

test('Tự đánh presses Ù when the game offers it even if the card snapshot is stale', () => {
  const step = autoPlay.nextStep({ roundPlayers: [], players: {} }, 'me', ['BAO_U'], new Set(), []);
  assert.deepEqual(step, { action: 'BAO_U', cards: [], why: 'Ù' });
});

test('Tự đánh waits for Gửi before Đánh when sendable cards remain after hạ', () => {
  const run = [card(2, H), card(3, H), card(4, H)]; // 3♥ 4♥ 5♥
  const sendable = card(5, H); // 6♥
  const discard = card(8, D); // 9♦
  const snap = {
    roundSeq: 1,
    roundPlayers: ['me', 'next'],
    nextOf: { me: 'next', next: 'me' },
    slotBinding: { B1: 'me' },
    players: {
      me: { uid: 'me', currentCards: [sendable, discard], melds: [{ meid: 1, cards: [0, 4, 8] }], discardedHistory: [{ card: 12 }, { card: 16 }, { card: 20 }], sentCards: [] },
      next: { uid: 'next', currentCards: [], melds: [{ meid: 9, cards: run }], discardedHistory: [], sentCards: [] },
    },
    ledger: run.map((code) => ({ code, status: 'MELDED', ownerUid: 'next' })),
    observedDiscardEvents: [],
    eats: [],
  };

  const wait = autoPlay.nextStep(snap, 'me', ['DANH'], new Set(), []);
  assert.deepEqual(wait, { wait: true, why: 'Chờ game hiện nút Gửi' });

  const send = autoPlay.nextStep(snap, 'me', ['DANH', 'GUI'], new Set(), []);
  assert.equal(send.action, 'GUI');
  assert.deepEqual(send.cards, [sendable]);
});

test('Tự đánh strategic discard can feed the lowest-money next account, but not the third eat', () => {
  const s = strategySnap({
    mine: cs('9♦ K♥ 2♠ 2♣ 2♦'),
    next: cs('8♦ 10♦ A♠ A♣'),
  });
  const step = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B', 'C'], {
    strategy: { lowMoney: true, blockThirdEat: true },
    moneyByUid: { A: 500, B: 1000, C: 10 },
  });
  assert.equal(step.action, 'DANH');
  assert.deepEqual(step.cards, [c('9♦')]);
  assert.match(step.why, /ít tiền/);

  const twice = strategySnap({
    mine: cs('9♦ K♥ 2♠ 2♣ 2♦'),
    next: cs('8♦ 10♦ A♠ A♣'),
    eats: [
      { card: c('3♠'), eaterUid: 'C', fromUid: 'B' },
      { card: c('4♠'), eaterUid: 'C', fromUid: 'B' },
    ],
  });
  assert.equal(autoPlay.strategyDiscard(twice, 'B', { lowMoney: true, blockThirdEat: true }, { moneyByUid: { A: 500, B: 1000, C: 10 } }), null);
});

test('Tự đánh strategic discard prioritizes a next account with 2 phỏm and cạ ù', () => {
  const s = strategySnap({
    mine: cs('9♦ K♥ Q♣ J♠'),
    next: cs('2♠ 2♣ 2♦ 5♥ 6♥ 7♥ 8♦ 10♦'),
  });
  const ca = autoPlay.caUInfo(s, 'C');
  assert.equal(ca.ok, true);
  assert.ok(ca.need.includes(c('9♦')));

  const step = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B', 'C'], {
    strategy: { lowMoney: false, twoPhomCaU: true, blockThirdEat: true },
  });
  assert.equal(step.action, 'DANH');
  assert.deepEqual(step.cards, [c('9♦')]);
  assert.match(step.why, /2 phỏm/);
});
