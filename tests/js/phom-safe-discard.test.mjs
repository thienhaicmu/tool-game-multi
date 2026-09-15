// PHOM SAFE-DISCARD / OPPONENT-THREAT analysis. From the cards WE control (1..3 hands) + public
// cards, exclude them from the 52-card deck to get the unknown pool, then classify each of our cards
// as SAFE or DANGEROUS to discard and list every card an opponent could kết-phỏm with. Pure logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../../desktop/protocol/phom/offline-analyzer.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');
const C = (rank, suit) => encodeCard(rank, suit); // rank label + suit symbol -> code
const CTX = { sourceKind: 'TEST_FIXTURE', networkEnabled: false };

test('opponentEatThreats: SET when >=2 same-rank remain in the pool', () => {
  const five_s = C('5', '♠');
  const pool = new Set([C('5', '♣'), C('5', '♦')]);
  const t = A.opponentEatThreats(five_s, pool);
  assert.equal(t.some((x) => x.type === 'SET'), true);
});

test('opponentEatThreats: RUN when a same-suit consecutive pair is in the pool', () => {
  const five_s = C('5', '♠');
  const pool = new Set([C('4', '♠'), C('6', '♠')]); // 4♠5♠6♠
  const t = A.opponentEatThreats(five_s, pool);
  assert.equal(t.some((x) => x.type === 'RUN'), true);
});

test('opponentEatThreats: empty pool => no threat (safe)', () => {
  assert.deepEqual(A.opponentEatThreats(C('5', '♠'), new Set()), []);
});

test('analyzeSafeDiscards: a card whose every completion is already known is SAFE', () => {
  // We consider discarding 5♠. Block ALL threats by making every enabling card KNOWN (ours/public):
  //  SET: the other three 5s;  RUN: 3♠4♠ , 4♠6♠ , 6♠7♠ (all neighbours of 5♠).
  const five_s = C('5', '♠');
  const known = [C('5', '♣'), C('5', '♦'), C('5', '♥'), C('3', '♠'), C('4', '♠'), C('6', '♠'), C('7', '♠')];
  const r = A.analyzeSafeDiscards({ controlledHands: [[five_s]], publicCards: known }, CTX);
  assert.equal(r.ok, true);
  assert.ok(r.SAFE_DISCARDS.includes(five_s), '5♠ has no possible opponent phỏm => SAFE');
  assert.equal(r.DANGEROUS_DISCARDS.includes(five_s), false);
});

test('analyzeSafeDiscards: a card the opponent could set-eat is DANGEROUS', () => {
  const five_s = C('5', '♠');
  // Only ourselves hold 5♠; the other three 5s are UNKNOWN => opponent could hold 2 => SET threat.
  const r = A.analyzeSafeDiscards({ controlledHands: [[five_s]], publicCards: [] }, CTX);
  assert.ok(r.DANGEROUS_DISCARDS.includes(five_s));
  const cand = r.candidates.find((c) => c.card === five_s);
  assert.equal(cand.safe, false);
  assert.ok(cand.threats.some((t) => t.type === 'SET'));
});

test('analyzeSafeDiscards: more controlled hands shrink the unknown pool (tighter safety)', () => {
  const one = A.analyzeSafeDiscards({ controlledHands: [[C('5', '♠')]] }, CTX);
  const three = A.analyzeSafeDiscards({ controlledHands: [[C('5', '♠')], [C('9', '♦')], [C('K', '♣')]] }, CTX);
  assert.ok(three.UNKNOWN_COUNT < one.UNKNOWN_COUNT);
  assert.equal(three.controlledCount, 3);
});

test('analyzeSafeDiscards: a card that extends a laid PUBLIC meld is DANGEROUS', () => {
  const six_h = C('6', '♥');
  // public RUN 7♥8♥9♥ — discarding 6♥ extends it.
  const r = A.analyzeSafeDiscards({ controlledHands: [[six_h]], publicMelds: [[C('7', '♥'), C('8', '♥'), C('9', '♥')]] }, CTX);
  const cand = r.candidates.find((c) => c.card === six_h);
  assert.equal(cand.safe, false);
  assert.ok(cand.threats.some((t) => String(t.type).startsWith('EXTEND')));
});

test('analyzeSafeDiscards: OPPONENT_PHOM_CARDS lists deck cards the opponent could meld with', () => {
  const r = A.analyzeSafeDiscards({ controlledHands: [[C('5', '♠')]] }, CTX);
  assert.ok(Array.isArray(r.OPPONENT_PHOM_CARDS) && r.OPPONENT_PHOM_CARDS.length > 0);
});
