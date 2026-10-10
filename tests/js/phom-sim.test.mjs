import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRound, RULES } = require('../../tools/phom-sim/engine.cjs');
const { simulate, report } = require('../../tools/phom-sim/sim.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');

const SUIT = { '♠': 0, '♣': 1, '♦': 2, '♥': 3 };
const RANK = { A: 0, J: 10, Q: 11, K: 12 };
const c = (t) => { const s = t.slice(-1); const r = t.slice(0, -1); return encodeCard(Object.prototype.hasOwnProperty.call(RANK, r) ? RANK[r] : Number(r) - 1, SUIT[s]); };
const cs = (t) => t.split(/\s+/).filter(Boolean).map(c);

// a fixed deck: the first player gets 10, the others 9 each, then the draw pile
function deckOf(hands, pile) {
  const used = new Set(hands.flat().concat(pile));
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((x) => !used.has(x));
  return hands.flat().concat(pile, rest);
}

test('deal: the first player has 10 cards, the others 9, the first player discards first', () => {
  const r = createRound({ uids: ['A', 'B', 'C', 'D'], rng: () => 0.5 });
  assert.deepEqual(r.deal.map((d) => d.cards.length), [10, 9, 9, 9]);
  assert.equal(r.current(), 'A');
  assert.deepEqual(r.offered('A').filter((x) => x !== 'BAO_U'), ['DANH']);
  assert.deepEqual(r.offered('B'), []);
});

test('only the next player may eat, and only a card that makes a phỏm', () => {
  const a = cs('9♦ K♠ K♣ 2♠ 3♣ 5♦ 7♥ J♣ Q♦ 4♥');
  const b = cs('8♦ 10♦ 2♥ 4♠ 6♣ 9♠ J♥ Q♠ A♦');
  const r = createRound({ uids: ['A', 'B'], deck: deckOf([a, b], []) });
  assert.ok(r.apply('A', { action: 'DANH', cards: [c('9♦')] }).ok);
  assert.deepEqual(r.offered('B'), ['BOC', 'AN']);
  const res = r.apply('B', { action: 'AN' });
  assert.ok(res.ok);
  assert.equal(res.events[0].type, 'EAT');
  assert.equal(r.apply('B', { action: 'DANH', cards: [c('9♦')] }).error.code, 'EATEN_CARD');
  assert.equal(r.apply('B', { action: 'DANH', cards: [c('8♦')] }).error.code, 'BREAKS_EATEN');
  assert.ok(r.apply('B', { action: 'DANH', cards: [c('Q♠')] }).ok);
  assert.deepEqual(r.offered('A'), ['BOC']); // Q♠ makes nothing for A
});

test('a round where nobody lays: everyone móm, no ranking payment, the table sums to zero', () => {
  const r = createRound({ uids: ['A', 'B', 'C', 'D'], rng: (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })() });
  let guard = 0;
  while (!r.done && guard++ < 500) {
    const u = r.current(); const off = r.offered(u);
    if (off.includes('BOC')) { r.apply(u, { action: 'BOC' }); continue; }
    // never lays: everyone ends móm unless the deal held an ù
    if (off.includes('BAO_U')) { r.apply(u, { action: 'BAO_U' }); continue; }
    if (!r.inHand(u).some((x) => r.apply(u, { action: 'DANH', cards: [x] }).ok)) throw new Error('stuck');
  }
  const out = r.result();
  assert.ok(out);
  assert.equal(Object.values(out.net).reduce((s, n) => s + n, 0), 0);
  if (out.kind === 'POINTS') { assert.equal(out.mom.length, 4); assert.equal(out.winner, null); }
});

test('scoring: a móm pays 4 to the winner', () => {
  // A lays on its last turn, B never does; scripted so the outcome is known
  const a = cs('2♠ 2♣ 2♦ K♠ Q♣ J♦ 9♥ 8♣ 7♠ 5♦');
  const b = cs('3♠ 3♣ 3♦ K♥ Q♦ 10♣ 9♠ 6♣ 4♥');
  const pile = cs('A♠ A♣ A♦ A♥ 4♠ 4♣ 4♦');
  const r = createRound({ uids: ['A', 'B'], deck: deckOf([a, b], pile) });
  const play = (u, x) => assert.ok(r.apply(u, { action: 'DANH', cards: [c(x)] }).ok, u + ' ' + x);
  const draw = (u) => assert.ok(r.apply(u, { action: 'BOC' }).ok);
  play('A', 'K♠'); draw('B'); play('B', 'K♥');
  draw('A'); play('A', 'Q♣'); draw('B'); play('B', 'Q♦');
  draw('A'); play('A', 'J♦'); draw('B'); play('B', '10♣');
  draw('A'); assert.ok(r.apply('A', { action: 'HA', cards: cs('2♠ 2♣ 2♦') }).ok); play('A', '9♥');
  draw('B'); play('B', '9♠'); // B never lays: móm
  const out = r.result();
  assert.equal(out.winner, 'A');
  assert.deepEqual(out.mom, ['B']);
  assert.equal(out.net.B, -RULES.mom);
});

test('Ù: offered once 9 cards are in phỏm, pays 5 from each', () => {
  const a = cs('2♠ 2♣ 2♦ 5♥ 6♥ 7♥ 9♣ 10♣ J♣ K♦');
  const b = cs('3♠ 4♠ 8♦ 9♦ Q♥ Q♠ A♣ A♦ 6♠');
  const r = createRound({ uids: ['A', 'B'], deck: deckOf([a, b], []) });
  assert.ok(r.offered('A').includes('BAO_U'));
  r.apply('A', { action: 'BAO_U' });
  const out = r.result();
  assert.equal(out.kind, 'U');
  assert.equal(out.net.A, RULES.u);
  assert.equal(out.net.B, -RULES.u);
});

test('the simulator plays whole rounds with the real chooser; net sums to zero and it is reproducible', () => {
  const one = report(simulate({ rounds: 3, seed: 11, seats: 'TTTL' }));
  const two = report(simulate({ rounds: 3, seed: 11, seats: 'TTTL' }));
  assert.equal(one.rounds, 3);
  assert.deepEqual(one.players.map((p) => p.net.mean), two.players.map((p) => p.net.mean));
  assert.ok(Math.abs(one.players.reduce((s, p) => s + p.net.mean, 0)) < 1e-9);
});

const NO_RANK = { ...RULES, rank: [0, 0, 0, 0], mom: 0 }; // isolate the eat / ù payments

test('ăn chốt: eating the discarder\'s 4th card pays 4', () => {
  const a = cs('2♠ 2♣ 2♦ K♠ Q♣ J♦ 9♥ 8♣ 5♥ 7♦');
  const b = cs('3♠ 3♣ 3♦ K♥ Q♦ 10♣ 7♠ 7♣ 4♥');
  const r = createRound({ uids: ['A', 'B'], deck: deckOf([a, b], cs('A♠ A♣ A♦ A♥ J♠ 5♣')), rules: NO_RANK });
  const play = (u, x) => assert.ok(r.apply(u, { action: 'DANH', cards: [c(x)] }).ok, u + ' ' + x);
  const draw = (u) => assert.ok(r.apply(u, { action: 'BOC' }).ok);
  play('A', 'K♠'); draw('B'); play('B', 'K♥');
  draw('A'); play('A', 'Q♣'); draw('B'); play('B', 'Q♦');
  draw('A'); play('A', 'J♦'); draw('B'); play('B', '10♣');
  draw('A'); play('A', '7♦');
  assert.ok(r.apply('B', { action: 'AN' }).ok);
  assert.ok(r.apply('B', { action: 'HA', cards: cs('7♠ 7♣ 7♦ 3♠ 3♣ 3♦') }).ok);
  play('B', '4♥');
  const out = r.result();
  assert.equal(out.eats[0].chot, true);
  assert.equal(out.net.A, -RULES.eatChot);
});

test('đền: an ù after eating 3 cards of the previous player — that player pays for the whole table', () => {
  const a = cs('5♦ 9♥ K♣ 3♠ 4♥ 6♣ 8♦ 10♠ Q♥ A♣');
  const b = cs('5♠ 5♣ 9♠ 9♣ K♠ K♦ 2♥ 7♣ J♠');
  const cc = cs('4♠ 6♦ 8♥ 10♦ Q♣ A♥ J♦ 3♣ K♥');
  const r = createRound({ uids: ['A', 'B', 'C'], deck: deckOf([a, b, cc], cs('7♠ J♥ 2♦ 3♦')), rules: NO_RANK });
  const play = (u, x) => assert.ok(r.apply(u, { action: 'DANH', cards: [c(x)] }).ok, u + ' ' + x);
  const draw = (u) => assert.ok(r.apply(u, { action: 'BOC' }).ok, u + ' BOC');
  const eat = (u) => assert.ok(r.apply(u, { action: 'AN' }).ok, u + ' AN');
  play('A', '5♦'); eat('B'); play('B', '2♥'); draw('C'); play('C', 'Q♣');
  draw('A'); play('A', '9♥'); eat('B'); play('B', '7♣'); draw('C'); play('C', 'J♦');
  draw('A'); play('A', 'K♣'); eat('B');
  assert.ok(r.offered('B').includes('BAO_U'));
  assert.ok(r.apply('B', { action: 'BAO_U' }).ok);
  const out = r.result();
  assert.equal(out.kind, 'U');
  assert.equal(out.den, 'A');
  assert.equal(out.net.C, 0);
  assert.equal(out.net.A, -(3 * RULES.eat + 2 * RULES.u));
  assert.equal(out.net.B, 3 * RULES.eat + 2 * RULES.u);
});
