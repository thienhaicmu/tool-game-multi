// ĐÁNH BÀI B2 — the help next to the play buttons (desktop/protocol/phom/phom-play-help.cjs). Only the account's OWN
// hand + public table facts; discard order every turn = chắc chắn không bị ăn → có thể không bị ăn → the rest, and
// only then the fewest points left (a safe card goes first even when it costs more).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('../../desktop/protocol/phom/phom-play-help.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');

const S = { '♠': 0, '♣': 1, '♦': 2, '♥': 3 };
const R = { A: 0, J: 10, Q: 11, K: 12 };
const c = (t) => encodeCard(R[t.slice(0, -1)] != null ? R[t.slice(0, -1)] : Number(t.slice(0, -1)) - 1, S[t.slice(-1)]);
const cs = (s) => s.split(' ').map(c);
const codes = (l) => l.map((x) => x.code);

// me = B (P2), plays before C; A plays before me. ledger: my hand CURRENT, public facts as given.
function snap({ mine, teammate = [], ledger = [], melds = {}, discards = [], eats = [] }) {
  const L = [...mine.map((code) => ({ code, status: 'CURRENT', ownerUid: 'B' })), ...teammate.map((code) => ({ code, status: 'CURRENT', ownerUid: 'C' })), ...ledger];
  const pl = (uid, seat, cards, extra = {}) => ({ uid, seat, slot: null, controlled: cards.length > 0, currentCards: cards, currentCardsSource: cards.length ? 'DRAW' : null, serverMeldCards: [], melds: melds[uid] || [], ...extra });
  return {
    roundPlayers: ['A', 'B', 'C'], nextOf: { A: 'B', B: 'C', C: 'A' }, slotBinding: { B2: 'B', B3: 'C' },
    players: { A: pl('A', 0, []), B: pl('B', 1, mine), C: pl('C', 2, teammate) },
    ledger: L, eats, observedDiscardEvents: discards,
  };
}

test('points + best phỏm split: the fewest loose points (A = 1 … K = 13), a card used in only one phỏm', () => {
  const b = H.bestArrangement(cs('3♠ 3♣ 3♦ 4♠ 5♠ K♥'));
  assert.equal(b.points, 19, 'run 3♠4♠5♠ leaves 3♣ 3♦ K♥ = 19; the set 3♠3♣3♦ would leave 4♠ 5♠ K♥ = 22');
  const s2 = H.bestArrangement(cs('7♠ 7♣ 7♦ 8♠ 9♠'));
  assert.equal(s2.points, 14, 'run 7♠8♠9♠ leaves 7♣ 7♦ = 14 (the set would leave 8♠ 9♠ = 17)');
  assert.equal(H.bestArrangement(cs('A♠ A♣ A♦ A♥')).points, 0);
});

test('discard order: a PROVEN safe card goes first even when a riskier card costs more points', () => {
  // K♥: all partners public (K♠ K♣ K♦ discarded, no run above K, Q♥ J♥ melded) → chắc chắn an toàn
  // 9♦ stays wide open (nothing public around it) and costs less
  const s = snap({
    mine: cs('K♥ 9♦ 2♠ 2♣ 2♦'),
    ledger: [...cs('K♠ K♣ K♦').map((code) => ({ code, status: 'DISCARDED', ownerUid: 'A' })), ...cs('Q♥ J♥').map((code) => ({ code, status: 'DISCARDED', ownerUid: 'A' }))],
  });
  const r = H.discardRanking(s, 'B');
  assert.equal(r.recommended.label, 'K♥');
  assert.equal(r.recommended.tier, H.TIER.SAFE);
  const nine = r.ranking.find((x) => x.label === '9♦');
  assert.equal(nine.tier, H.TIER.OTHER);
  assert.ok(r.ranking.indexOf(nine) > 0);
});

test('loose cards first (tier, then fewest points left); a card of a phỏm comes last, marked phá phỏm', () => {
  const s = snap({ mine: cs('Q♠ 9♥ 2♠ 2♣ 2♦') });
  const r = H.discardRanking(s, 'B');
  assert.deepEqual(r.ranking.slice(0, 2).map((x) => x.label), ['Q♠', '9♥'], 'same tier: Q (12) out leaves 9 points');
  assert.equal(r.recommended.pointsLeft, 9);
  assert.equal(r.points, 12 + 9);
  assert.deepEqual(r.ranking.slice(2).map((x) => x.breaksPhom), [true, true, true], '2♠ 2♣ 2♦ only after every loose card — even 2♦ that is proven safe');
});

test('KNOWLEDGE BOUNDARY: the teammate\'s hidden hand is never used — it is treated exactly like a stranger', () => {
  // C (our own account) plays after B and holds NOTHING that eats 9♦. With its hand known Lọc bài would call 9♦ safe;
  // here C's cards are unknown, so 9♦ is NOT proven safe.
  const s = snap({ mine: cs('9♦ 2♠ 2♣ 2♦'), teammate: cs('A♠ A♣ 5♥ 6♥ J♣') });
  const pv = H.publicView(s, 'B');
  assert.deepEqual(pv.players.C.currentCards, []);
  assert.equal(pv.ledger.some((e) => e.ownerUid === 'C' && e.status === 'CURRENT'), false);
  const r = H.discardRanking(s, 'B');
  assert.notEqual(r.ranking.find((x) => x.label === '9♦').tier, H.TIER.SAFE);
});

test('a card this account ATE must stay in a phỏm — never offered as a discard', () => {
  const s = snap({ mine: cs('5♠ 6♠ 7♠ K♥'), eats: [{ card: c('7♠'), eaterUid: 'B', fromUid: 'A' }] });
  assert.equal(H.discardRanking(s, 'B').ranking.some((x) => x.label === '7♠'), false);
});

test('HẠ plan: lay the split + discard after it — a safe discard first, then the fewest points', () => {
  const s = snap({
    mine: cs('2♠ 2♣ 2♦ 5♥ 6♥ 7♥ K♥ 9♦'),
    ledger: cs('K♠ K♣ K♦ Q♥ J♥').map((code) => ({ code, status: 'DISCARDED', ownerUid: 'A' })),
  });
  const p = H.haPlan(s, 'B');
  assert.equal(p.ok, true);
  assert.deepEqual(p.melds.map((m) => m.map((x) => x.label).join(' ')).sort(), ['2♠ 2♣ 2♦', '5♥ 6♥ 7♥']);
  assert.equal(p.discard.label, 'K♥', 'K♥ is proven safe — chosen over the cheaper 9♦');
  assert.equal(p.pointsLeft, 9);
});

test('ĂN: the card the previous player just discarded — does it make a phỏm with the hand', () => {
  const s = snap({ mine: cs('8♦ 10♦ 3♣ 3♠'), discards: [{ uid: 'A', cards: [c('9♦')], source: 'PLAY' }] });
  const t = H.takeInfo(s, 'B');
  assert.equal(t.ok, true); assert.equal(t.card.label, '9♦'); assert.equal(t.canTake, true);
  assert.deepEqual(t.meld.map((x) => x.label), ['8♦', '9♦', '10♦']);
  const no = H.takeInfo(snap({ mine: cs('2♠ 5♥'), discards: [{ uid: 'A', cards: [c('9♦')] }] }), 'B');
  assert.equal(no.canTake, false);
  // a discard by someone who does not play before me is not mine to eat
  assert.equal(H.takeInfo(snap({ mine: cs('8♦ 10♦'), discards: [{ uid: 'C', cards: [c('9♦')] }] }), 'B').ok, false);
  // already eaten
  assert.equal(H.takeInfo(snap({ mine: cs('8♦ 10♦'), discards: [{ uid: 'A', cards: [c('9♦')] }], eats: [{ card: c('9♦'), eaterUid: 'B' }] }), 'B').eaten, true);
});

test('GỬI: which hand cards fit which laid phỏm (a full 4-card set takes nothing more)', () => {
  const s = snap({ mine: cs('6♥ 2♦ 9♣'), melds: { A: [{ meid: 3, cards: cs('3♥ 4♥ 5♥') }, { meid: 4, cards: cs('9♠ 9♦ 9♥ 9♣') }], C: [{ meid: 8, cards: cs('2♠ 2♣ 2♥') }] } });
  const out = H.sendTargets(s, 'B');
  assert.deepEqual(out.map((x) => [x.label, x.into.map((m) => m.meid)]), [['6♥', [3]], ['2♦', [8]]]);
});

test('cards already laid on the table are not in the hand any more', () => {
  const s = snap({ mine: cs('2♠ 2♣ 2♦ K♥'), melds: { B: [{ meid: 1, cards: cs('2♠ 2♣ 2♦') }] } });
  assert.deepEqual(H.discardRanking(s, 'B').ranking.map((x) => x.label), ['K♥']);
});

// ---- user 2026-10-09: before the last turn keep a live CẠ (between safety and points); the last turn as before ----
const discardsOf = (n) => Array.from({ length: n }, (_, i) => ({ card: 40 + i }));
function withTurn(s, done) { return { ...s, players: { ...s.players, B: { ...s.players.B, discardedHistory: discardsOf(done) } } }; }

test('turn: counted from the account\'s own discards — after 3 the coming one is the LAST (hạ)', () => {
  const s = snap({ mine: cs('2♠ 5♥') });
  assert.deepEqual(H.turnInfo(withTurn(s, 0), 'B'), { turn: 1, last: false });
  assert.deepEqual(H.turnInfo(withTurn(s, 2), 'B'), { turn: 3, last: false });
  assert.deepEqual(H.turnInfo(withTurn(s, 3), 'B'), { turn: 4, last: true });
});

test('before the last turn: same safety → a card in NO live cạ goes first, even if it costs fewer points', () => {
  // Q♠ + J♠ = a live cạ (10♠ / K♠ may come); 9♦ is alone; all three equally unproven
  const s = withTurn(snap({ mine: cs('Q♠ J♠ 9♦ 2♣ 2♦ 2♥') }), 1);
  const r = H.discardRanking(s, 'B');
  assert.equal(r.turn.last, false);
  assert.equal(r.recommended.label, '9♦', 'the lone 9♦ goes; the cạ Q♠ J♠ is kept');
  assert.deepEqual(r.ranking.find((x) => x.label === 'Q♠').caWith, ['J♠']);
});

test('the LAST turn: no cạ step — safety, then the fewest points (as before)', () => {
  const s = withTurn(snap({ mine: cs('Q♠ J♠ 9♦ 2♣ 2♦ 2♥') }), 3);
  const r = H.discardRanking(s, 'B');
  assert.equal(r.turn.last, true);
  assert.equal(r.recommended.label, 'Q♠', 'Q (12) out leaves the fewest points');
});

test('safety still comes first: a proven-safe card in a cạ goes before an unproven lone card', () => {
  // K♥: every partner public except Q♥ (in my hand) → proven safe; K♥ + Q♥ would be a cạ but J♥ is out → dead cạ anyway
  const s = withTurn(snap({
    mine: cs('K♥ Q♥ 9♦ 2♣ 2♦ 2♥'),
    ledger: cs('K♠ K♣ K♦ J♥').map((code) => ({ code, status: 'DISCARDED', ownerUid: 'A' })),
  }), 1);
  const r = H.discardRanking(s, 'B');
  assert.equal(r.ranking[0].tier <= r.ranking.find((x) => x.label === '9♦').tier, true);
  assert.notEqual(r.recommended.label, '9♦');
});

test('a dead cạ (every card that would complete it is out) is not kept', () => {
  // 5♣ 6♣ needs 4♣ or 7♣ — both discarded → dead
  const dead = H.caPartners(c('5♣'), cs('5♣ 6♣'), new Set(cs('4♣ 7♣')));
  assert.deepEqual(dead, []);
  assert.deepEqual(H.caPartners(c('5♣'), cs('5♣ 6♣'), new Set(cs('4♣'))), [c('6♣')]);
  assert.deepEqual(H.caPartners(c('5♣'), cs('5♣ 7♣'), new Set()), [c('7♣')], 'a gap of 2 needs the middle card');
  assert.deepEqual(H.caPartners(c('5♣'), cs('5♣ 5♦'), new Set(cs('5♠ 5♥'))), [], 'a pair with both other suits out is dead');
});
