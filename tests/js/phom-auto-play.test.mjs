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

test('outside next player uses normal rules for every combination of strategy switches', () => {
  const s = strategySnap({ mine: cs('9♦ K♥ 2♠ 2♣ 2♦'), next: cs('8♦ 10♦') });
  const normal = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B']);
  for (const lowMoney of [false, true]) for (const twoPhomCaU of [false, true]) {
    const step = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B'], { strategy: { lowMoney, twoPhomCaU } });
    assert.deepEqual(step, normal);
  }
});

test('take evaluation uses only own hand and public information', () => {
  const s = strategySnap({ mine: cs('8♦ 10♦ 2♠ 2♣ 2♦ 5♥ 6♥ 7♥ K♠'), next: cs('3♠ 4♠') });
  const before = autoPlay.takeEvaluation(s, 'B', c('9♦'));
  assert.equal(before.take, true);
  assert.equal(before.taken, 0);
  s.players.C.currentCards = cs('A♥ K♥ Q♥');
  assert.deepEqual(autoPlay.takeEvaluation(s, 'B', c('9♦')), before);
});

test('take evaluation rejects putting two eaten cards in one meld', () => {
  const s = strategySnap({ mine: cs('8♦ 10♦ K♠'), next: [], eats: [{ eaterUid: 'B', card: c('8♦') }] });
  assert.equal(autoPlay.takeEvaluation(s, 'B', c('9♦')).take, false);
});

test('third-eat protection is exact for a tool member and public-only for an outsider (always on, user 2026-10-10)', () => {
  const s = strategySnap({ mine: cs('9♦ K♥'), next: cs('8♦ 10♦'),
    eats: [{ eaterUid: 'C', card: c('3♠') }, { eaterUid: 'C', card: c('4♠') }] });
  const protectedStep = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B', 'C']);
  assert.deepEqual(protectedStep.cards, [c('K♥')]);
  // as an outsider C's hand is hidden: neither card is proven safe → it still plays, and says so
  const outside = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B']);
  assert.match(outside.why, /chặn ăn lần 3 · không có lá tránh ăn hợp lệ/);
});

test('low-money comparison ignores outsiders but requires every in-tool balance', () => {
  const s = strategySnap({ mine: cs('9♦ K♥'), next: cs('8♦ 10♦'), money: { A: 1, B: 1000, C: 10 } });
  const ctx = { toolUids: ['B', 'C'] };
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: true }, ctx).code, c('9♦'));
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: true }, { ...ctx, moneyByUid: { B: null, C: 10 } }), null);
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: true }, { ...ctx, moneyByUid: { B: 1000, C: 0 } }).code, c('9♦'));
});

test('when no ca-u completion can be fed, selection falls back to low-money feeding', () => {
  const s = strategySnap({ mine: cs('2♥ K♠'), next: cs('2♠ 2♣ 2♦ 5♥ 6♥ 7♥ 8♦ 10♦') });
  const choice = autoPlay.strategyDiscard(s, 'B', { lowMoney: true, twoPhomCaU: true }, { toolUids: ['A', 'B', 'C'] });
  assert.equal(choice.code, c('2♥'));
  assert.match(choice.why, /ít tiền/);
});

test('final discard also protects the next tool member from a third eat', () => {
  const s = strategySnap({ mine: cs('9♦ K♥'), next: cs('8♦ 10♦'),
    eats: [{ eaterUid: 'C', card: c('3♠') }, { eaterUid: 'C', card: c('4♠') }] });
  s.players.B.discardedHistory = [0, 1, 2];
  const step = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B', 'C']);
  assert.deepEqual(step.cards, [c('K♥')]);
});

test('strategy switches normalize independently and default to third-eat protection', () => {
  assert.deepEqual(autoPlay.normalizeStrategy(), { lowMoney: false, twoPhomCaU: true, blockThirdEat: true }); // cạ ù on by default (2026-10-10)
  assert.equal(autoPlay.normalizeStrategy({ twoPhomCaU: false }).twoPhomCaU, false);
  assert.deepEqual(autoPlay.normalizeStrategy({ lowMoney: true, twoPhomCaU: true, blockThirdEat: false }),
    { lowMoney: true, twoPhomCaU: true, blockThirdEat: true });
});

test('low-money feeding switches off, rejects a richer next player, and preserves existing melds', () => {
  const s = strategySnap({ mine: cs('9♦ K♥ 2♠ 2♣ 2♦'), next: cs('8♦ 10♦ A♠ A♣') });
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: false }), null);
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: true }, { toolUids: ['A', 'B', 'C'], moneyByUid: { A: 1, B: 1000, C: 10 } }), null);
  const meldOnly = strategySnap({ mine: cs('8♦ 9♦ 10♦ K♥'), next: cs('9♠ 9♣') });
  assert.equal(autoPlay.strategyDiscard(meldOnly, 'B', { lowMoney: true }, { toolUids: ['A', 'B', 'C'] }), null);
});

test('third-eat protection cannot be disabled by legacy settings', () => {
  const s = strategySnap({ mine: cs('9♦ K♥'), next: cs('8♦ 10♦'),
    eats: [{ eaterUid: 'C', card: c('3♠') }, { eaterUid: 'C', card: c('4♠') }] });
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: true, blockThirdEat: true }), null);
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: true, blockThirdEat: false }, { toolUids: ['A', 'B', 'C'] }), null);
});

test('two-meld preference requires two melds and an available completion card', () => {
  const s = strategySnap({ mine: cs('9♦ K♥'), next: cs('2♠ 2♣ 2♦ 5♥ 6♥ 7♥ 8♦ 10♦') });
  assert.equal(autoPlay.strategyDiscard(s, 'B', { twoPhomCaU: false }), null);
  s.ledger.push({ code: c('9♦'), status: 'DISCARDED', ownerUid: 'A' });
  assert.equal(autoPlay.caUInfo(s, 'C').ok, false);
  s.players.C.currentCards = cs('2♠ 2♣ 2♦ 8♦ 10♦');
  assert.equal(autoPlay.caUInfo(s, 'C').ok, false);
});

test('two-meld preference cannot bypass third-eat protection', () => {
  const s = strategySnap({ mine: cs('9♦ K♥'), next: cs('2♠ 2♣ 2♦ 5♥ 6♥ 7♥ 8♦ 10♦'),
    eats: [{ eaterUid: 'C', card: c('2♠') }, { eaterUid: 'C', card: c('5♥') }] });
  assert.equal(autoPlay.strategyDiscard(s, 'B', { twoPhomCaU: true }, { toolUids: ['A', 'B', 'C'] }), null);
});

test('third-eat protection also covers an outsider next player: only a card proven safe from the public view', () => {
  // C is outside the tool (its hand is hidden) and has eaten twice; 9♦ could still be eaten (8♦ 10♦ are unseen),
  // K♥ cannot (the other three kings are public)
  const s = strategySnap({ mine: cs('9♦ K♥ 2♥'), next: [],
    eats: [{ eaterUid: 'C', card: c('3♠') }, { eaterUid: 'C', card: c('4♠') }] });
  for (const k of cs('K♠ K♣ K♦ A♥ 3♥ 4♥')) s.ledger.push({ code: k, status: 'DISCARDED', ownerUid: 'A' });
  const step = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B']);
  assert.deepEqual(step.cards, [c('K♥')]);
  assert.match(step.why, /chặn ăn lần 3/);
});

test('third-eat protection reports unavoidable feeding without stalling', () => {
  const s = strategySnap({ mine: cs('9♦'), next: cs('8♦ 10♦'),
    eats: [{ eaterUid: 'C', card: c('3♠') }, { eaterUid: 'C', card: c('4♠') }] });
  const step = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B', 'C'], { strategy: { blockThirdEat: true } });
  assert.deepEqual(step.cards, [c('9♦')]);
  assert.match(step.why, /không có lá tránh/);
});

test('a third meld with two unrelated loose cards is not ca-u', () => {
  const s = strategySnap({ mine: cs('9♦'), next: cs('2♠ 2♣ 2♦ 5♥ 6♥ 7♥ 8♦ 10♦ K♠ Q♣') });
  assert.equal(autoPlay.caUInfo(s, 'C').ok, false);
  const help = require('../../desktop/protocol/phom/phom-play-help.cjs');
  assert.ok(help.bestArrangement(s.players.C.currentCards.concat(c('9♦'))).loose.includes(c('K♠')));
});

test('null balances never become zero-money targets', () => {
  const s = strategySnap({ mine: cs('9♦'), next: cs('8♦ 10♦'), money: { A: 500, B: 1000, C: null } });
  assert.equal(autoPlay.strategyDiscard(s, 'B', { lowMoney: true }, { toolUids: ['A', 'B', 'C'] }), null);
});

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
  assert.equal(autoPlay.strategyDiscard(twice, 'B', { lowMoney: true, blockThirdEat: true }, { toolUids: ['A', 'B', 'C'], moneyByUid: { A: 500, B: 1000, C: 10 } }), null);
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

test('the round\'s last discard ignores safety: the next player has played its 4 turns, so the costliest card goes', () => {
  const s = strategySnap({ mine: cs('K♥ 2♠ 5♣'), next: [] });
  for (const k of cs('2♣ 2♦ 2♥ A♠ 3♠')) s.ledger.push({ code: k, status: 'DISCARDED', ownerUid: 'A' });
  s.players.B.discardedHistory = [0, 1, 2].map((card) => ({ card }));
  const before = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B']);
  assert.deepEqual(before.cards, [c('2♠')]); // C still plays after B: the proven-safe card
  s.players.C.discardedHistory = [4, 5, 6, 7].map((card) => ({ card }));
  const last = autoPlay.nextStep(s, 'B', ['DANH'], new Set(), ['A', 'B']);
  assert.deepEqual(last.cards, [c('K♥')]);
});
