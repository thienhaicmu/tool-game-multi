import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const codec = require('../../desktop/protocol/phom/card-codec.cjs');
const { decodeCard, encodeCard, formatCard, isValidCardCode, decodeCards, sortCardCodes, RANKS, SUITS } = codec;

// §13/§22.A — every code 0..51 decodes, round-trips, and has correct rank/suit/color.
test('all 52 codes decode + round-trip + correct rank/suit/color', () => {
  const seen = new Set();
  for (let code = 0; code <= 51; code++) {
    assert.equal(isValidCardCode(code), true, `code ${code} should be valid`);
    const d = decodeCard(code);
    const rankIndex = Math.floor(code / 4);
    const suitIndex = code % 4;
    assert.equal(d.rankIndex, rankIndex);
    assert.equal(d.suitIndex, suitIndex);
    assert.equal(d.rank, RANKS[rankIndex]);
    assert.equal(d.suit, SUITS[suitIndex].symbol);
    assert.equal(d.color, SUITS[suitIndex].color);
    // red for ♦(2)/♥(3), black for ♠(0)/♣(1)
    assert.equal(d.color, (suitIndex >= 2) ? 'red' : 'black');
    // round-trip both by index and by label/symbol
    assert.equal(encodeCard(rankIndex, suitIndex), code);
    assert.equal(encodeCard(d.rank, d.suit), code);
    assert.equal(formatCard(code), d.label);
    assert.equal(seen.has(d.label), false, `label ${d.label} must be unique`);
    seen.add(d.label);
  }
  assert.equal(seen.size, 52);
});

// §13/§22.A — canonical fixture must decode 9/9 exactly.
test('canonical fixture [40,44,48,3,2,6,8,27,42] decodes exactly', () => {
  const fixture = [40, 44, 48, 3, 2, 6, 8, 27, 42];
  const labels = decodeCards(fixture).map((d) => d.label);
  assert.deepEqual(labels, ['J♠', 'Q♠', 'K♠', 'A♥', 'A♦', '2♦', '3♠', '7♥', 'J♦']);
});

// §13 spot checks called out in the spec.
test('spec spot-check codes', () => {
  assert.equal(formatCard(0), 'A♠');
  assert.equal(formatCard(1), 'A♣');
  assert.equal(formatCard(2), 'A♦');
  assert.equal(formatCard(3), 'A♥');
  assert.equal(formatCard(38), '10♦');
  assert.equal(formatCard(40), 'J♠');
  assert.equal(formatCard(44), 'Q♠');
  assert.equal(formatCard(48), 'K♠');
});

// §13/§22.A — invalid inputs must fail typed (never silently coerce).
test('invalid card codes throw PHOM_INVALID_CARD_CODE', () => {
  for (const bad of [-1, 52, 100, NaN, Infinity, -Infinity, 3.5, '5', 'A♠', null, undefined, {}, []]) {
    assert.equal(isValidCardCode(bad), false, `${String(bad)} must be invalid`);
    assert.throws(() => decodeCard(bad), (e) => e.code === 'PHOM_INVALID_CARD_CODE', `decodeCard(${String(bad)})`);
  }
});

test('encodeCard rejects out-of-range rank/suit', () => {
  assert.throws(() => encodeCard(13, 0), (e) => e.code === 'PHOM_INVALID_CARD_CODE');
  assert.throws(() => encodeCard(0, 4), (e) => e.code === 'PHOM_INVALID_CARD_CODE');
  assert.throws(() => encodeCard('X', 0), (e) => e.code === 'PHOM_INVALID_CARD_CODE');
});

test('sortCardCodes orders by rank then suit and does not mutate input', () => {
  const input = [48, 2, 40, 3];
  const sorted = sortCardCodes(input);
  assert.deepEqual(input, [48, 2, 40, 3]); // unchanged
  // A♦(2), A♥(3), J♠(40), K♠(48)
  assert.deepEqual(sorted, [2, 3, 40, 48]);
});
