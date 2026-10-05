// LỌC BÀI "an toàn nhưng vẫn bị ăn" (user 2026-10-05, round-…-3.json / round-…-4.json): 853 is an EAT (cs = the eaten
// card, fP.uid = the eater, fP.puid = the discarder), 855 is the round end. The tool read 853 as the round end, so a
// round without an eat never closed: the next deal was merged into it, the old discards still counted as "out", and a
// card a stranger could eat was shown as "Nên đánh". Also the turn order is the DEAL's lpi[] (28/28 plays in the
// captures), so the next player is known from the deal, never carried over from another seating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCardObserver } = require('../../desktop/protocol/phom/phom-card-observer.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { createSafeCardAnalyzer } = require('../../desktop/protocol/phom/phom-safe-card-analyzer.cjs');
const { createRoundJournal } = require('../../desktop/protocol/phom/round-journal.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');

const K = (s) => encodeCard(12, s); const Q = (s) => encodeCard(11, s); const J = (s) => encodeCard(10, s);
const f = (o) => classifyPhomFrame(JSON.stringify([5, o]));
let clk = 1;
const feed = (obs, o, slot = 'B1', ownUid = 'A') => obs.ingestFrame({ slot, ownUid, cls: f(o), now: clk++ });
const filler = (from) => Array.from({ length: 8 }, (_, i) => encodeCard(1 + ((from + i) % 9), (from + i) % 4)); // 2..10, never J/Q/K

test('a new DEAL after a round with NO eat (no 855 seen) opens a new round: old discards never make a card "safe"', () => {
  const obs = createCardObserver();
  // round 1: K and Q of the other suits are discarded — they block every meld with K of suit 0
  feed(obs, { cs: [K(0), ...filler(0)], lpi: ['A', 'B', 'S'], cmd: 850, tP: { uid: 'A' } });
  for (const [who, card, next] of [['A', K(1), 'B'], ['B', K(2), 'S'], ['S', Q(0), 'A'], ['A', K(3), 'B'], ['B', J(0), 'S']]) feed(obs, { fP: { uid: who, dCs: card }, tP: { uid: next }, cmd: 851 });
  const a = createSafeCardAnalyzer();
  const r1 = a.analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'A' });
  assert.ok(r1.safeCards.some((c) => c.code === K(0)), 'in round 1 K(0) really is blocked');
  // NO 855 arrives; round 2 is dealt to A again with K(0) — the stranger S plays right after A
  feed(obs, { cs: [K(0), ...filler(3)], lpi: ['B', 'A', 'S'], cmd: 850, tP: { uid: 'B' } });
  const snap = obs.getSnapshot();
  assert.equal(snap.roundSeq, 2, 'a second deal to the same hand is a new round');
  assert.equal(snap.discardPile.length, 0);
  assert.equal(snap.ledger.some((e) => e.status === 'DISCARDED'), false, 'no discard of round 1 survives');
  const r2 = a.analyze({ snapshot: snap, targetPlayerUid: 'A' });
  assert.equal(r2.nextPlayerUid, 'S', 'next player from the new deal lpi');
  assert.equal(r2.safeCards.some((c) => c.code === K(0)), false, 'K(0) is NOT "Nên đánh" — a stranger can eat it');
});

test('853 EAT is not the round end: the card leaves the pile, belongs to the eater, the eater plays next', () => {
  const obs = createCardObserver();
  feed(obs, { cs: filler(0).concat([K(0)]), lpi: ['A', 'S'], cmd: 850, tP: { uid: 'A' } });
  feed(obs, { fP: { uid: 'A', dCs: K(0) }, tP: { uid: 'S' }, cmd: 851 });
  feed(obs, { cs: K(0), ic: false, fP: { uid: 'S', lm: -100, puid: 'A' }, cmd: 853 });
  const s = obs.getSnapshot();
  assert.equal(s.roundActive, true, 'an eat does not end the round');
  assert.equal(s.roundSeq, 1);
  assert.deepEqual(s.discardPile, [], 'the eaten card left the pile');
  assert.equal(s.ledger.find((e) => e.code === K(0)).status, 'EATEN');
  assert.equal(s.currentTurnUid, 'S');
  assert.deepEqual(s.eats.map((e) => [e.card, e.eaterUid, e.fromUid]), [[K(0), 'S', 'A']]);
  // 855 ends it; the next deal opens round 2
  feed(obs, { ps: [{ uid: 'A', cs: [], mX: -100 }], fP: { uid: 'S' }, cmd: 855 });
  assert.equal(obs.getSnapshot().roundActive, false);
  feed(obs, { cs: filler(2), lpi: ['A', 'S'], cmd: 850, tP: { uid: 'A' } });
  assert.equal(obs.getSnapshot().roundSeq, 2);
  assert.deepEqual(obs.getSnapshot().eats, []);
});

test('our own eat: the new hand comes with the 853, and the eaten card is never offered as a discard', () => {
  const obs = createCardObserver();
  const hand = [K(1), K(2), ...filler(0).slice(0, 7)];
  feed(obs, { cs: hand, lpi: ['S', 'A'], cmd: 850, tP: { uid: 'S' } });
  feed(obs, { fP: { uid: 'S', dCs: K(0) }, tP: { uid: 'A' }, cmd: 851 }, 'B1', 'A');
  feed(obs, { cs: K(0), sAC: [...hand, K(0)], sMs: [K(0), K(1), K(2)], fP: { uid: 'A', lm: 100, puid: 'S' }, cmd: 853 }, 'B1', 'A');
  const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'A' });
  const offered = [...r.safeCards, ...r.likelySafeCards, ...r.unknownCards, ...r.riskyCards].map((c) => c.code);
  assert.equal(offered.includes(K(0)), false);
  assert.ok(r.ownMeldCards.some((c) => c.code === K(0)), 'shown as part of its phỏm');
});

test('the turn order of the deal replaces an order learned at another seating (it used to stay until the first play)', () => {
  const obs = createCardObserver();
  feed(obs, { cs: filler(0), lpi: ['A', 'B', 'C'], cmd: 850, tP: { uid: 'A' } });
  feed(obs, { fP: { uid: 'A', dCs: filler(0)[0] }, tP: { uid: 'B' }, cmd: 851 });
  feed(obs, { ps: [], cmd: 855 });
  feed(obs, { cs: filler(4), lpi: ['A', 'S', 'B', 'C'], cmd: 850, tP: { uid: 'S' } });
  assert.deepEqual(obs.getSnapshot().nextOf, { A: 'S', S: 'B', B: 'C', C: 'A' });
});

test('the round journal lists every eat with the verdict LỌC BÀI of the discarder last showed for that card', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-eat-'));
  let t = 0; const j = createRoundJournal({ dir, now: () => (t += 10) });
  const card = (code, label) => ({ code, label });
  const base = { roundSeq: 1, roundActive: true, startedAt: 0, slotBinding: { B1: 'A' }, players: { A: { uid: 'A', name: 'acc', controlled: true, currentCardsView: [] }, S: { uid: 'S', name: 'la', controlled: false } } };
  const an = { status: 'OK', nextPlayerLabel: 'la', recommendedCode: 51, safeCards: [card(51, 'K♥')], likelySafeCards: [], unknownCards: [], riskyCards: [], ownMeldCards: [] };
  j.observe({ ...base, currentTurnUid: 'A', discardPileView: [] }, { B1: an });
  j.observe({ ...base, currentTurnUid: 'S', discardPileView: [], eats: [{ card: 51, eaterUid: 'S', fromUid: 'A', view: card(51, 'K♥') }] }, { B1: { ...an, safeCards: [], recommendedCode: null } });
  j.observe({ ...base, roundActive: false, discardPileView: [], eats: [{ card: 51, eaterUid: 'S', fromUid: 'A', view: card(51, 'K♥') }] }, {});
  const round = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.deepEqual(round.eats.map((e) => [e.card, e.eater, e.from, e.fromSlot, e.verdict]), [['K♥', 'la', 'Player 1', 'B1', 'safe']]);
});

test('wiring: 853 → EAT and 855 → ROUND_END for the coordinator (an eat no longer stops "round running")', () => {
  const cls = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
  assert.equal(cls.CMD.EAT, 853);
  assert.equal(cls.CMD.ROUND_END, 855);
  const coord = readFileSync(new URL('../../desktop/protocol/phom/host-table-coordinator.cjs', import.meta.url), 'utf8');
  assert.equal(/case 'EAT'/.test(coord), false, 'the coordinator keeps the round running through an eat');
});
