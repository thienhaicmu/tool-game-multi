// LỌC BÀI must only see the GROUP's table (code review 2026-10-06, "lọc bài thi thoảng lỗi"): every card frame of P1–P3
// used to reach the observer whatever table that browser sat at. Live evidence it happens: coseat (3) 19:31:51 — B1
// (vietanhcoo) was seated by the game itself at a stranger's RUNNING table (stake 100, gS=4) while the group waited;
// Dò Key / Tạo pass through running tables too. Frames of another table then polluted the group's round: its discards
// counted as "out" (false "Nên đánh"), its DEAL replaced the turn order, its 855 ended our round mid-game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCardObserver } = require('../../desktop/protocol/phom/phom-card-observer.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { createSafeCardAnalyzer } = require('../../desktop/protocol/phom/phom-safe-card-analyzer.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');

const K = (s) => encodeCard(12, s); const Q = (s) => encodeCard(11, s);
let clk = 1;
const f = (o) => classifyPhomFrame(JSON.stringify([5, o]));
const feed = (obs, o, slot, ownUid) => obs.ingestFrame({ slot, ownUid, cls: f(o), now: clk++ });
const filler = (from) => Array.from({ length: 8 }, (_, i) => encodeCard(1 + ((from + i) % 9), (from + i) % 4));

// our round: B1=A (holds K♠-like K(0)), B2=B, two strangers S1,S2; turn order A → S1 → B → S2. B3 (uid C) is NOT in it.
function ourRound() {
  const obs = createCardObserver();
  const lpi = ['A', 'S1', 'B', 'S2'];
  feed(obs, { cs: [K(0), ...filler(0)], lpi, cmd: 850, tP: { uid: 'A' } }, 'B1', 'A');
  feed(obs, { cs: filler(3), lpi, cmd: 850, tP: { uid: 'A' } }, 'B2', 'B');
  feed(obs, { ps: [{ uid: 'C', sit: 0 }], cmd: 202 }, 'B3', 'C');   // B3 bound, elsewhere
  return obs;
}

test('a discard / eat / meld at ANOTHER table (B3 sitting there) never counts at the group\'s table', () => {
  const obs = ourRound();
  const a = createSafeCardAnalyzer();
  const before = a.analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'A' });
  assert.equal(before.safeCards.some((c) => c.code === K(0)), false, 'K(0) is not safe: a stranger plays after A');
  // the other table, seen by B3: X and Y discard the K's and Q that would block every meld with K(0)
  feed(obs, { fP: { uid: 'X', dCs: K(1) }, tP: { uid: 'Y' }, cmd: 851 }, 'B3', 'C');
  feed(obs, { fP: { uid: 'Y', dCs: K(2) }, tP: { uid: 'X' }, cmd: 851 }, 'B3', 'C');
  feed(obs, { fP: { uid: 'X', dCs: K(3) }, tP: { uid: 'Y' }, cmd: 851 }, 'B3', 'C');
  feed(obs, { fP: { uid: 'Y', dCs: Q(0) }, tP: { uid: 'X' }, cmd: 851 }, 'B3', 'C');
  feed(obs, { cs: Q(0), fP: { uid: 'X', puid: 'Y' }, cmd: 853 }, 'B3', 'C');
  feed(obs, { uid: 'X', mes: [{ meid: 1, cs: [encodeCard(10, 0), encodeCard(9, 0), encodeCard(8, 0)] }], cmd: 854 }, 'B3', 'C');
  const s = obs.getSnapshot();
  assert.deepEqual(s.discardPile, [], 'nothing of that table in our pile');
  assert.equal(s.ledger.some((e) => [K(1), K(2), K(3), Q(0)].includes(e.code)), false);
  assert.equal(s.currentTurnUid, 'A', 'our turn pointer untouched');
  const after = a.analyze({ snapshot: s, targetPlayerUid: 'A' });
  assert.equal(after.safeCards.some((c) => c.code === K(0)), false, 'K(0) still NOT "Nên đánh"');
});

test('a DEAL / round end at another table never replaces our turn order or ends our round', () => {
  const obs = ourRound();
  const order = obs.getSnapshot().nextOf;
  assert.deepEqual(order, { A: 'S1', S1: 'B', B: 'S2', S2: 'A' });
  feed(obs, { cs: filler(5), lpi: ['C', 'X', 'Y'], cmd: 850, tP: { uid: 'X' } }, 'B3', 'C');   // B3 dealt at the other table
  const s = obs.getSnapshot();
  assert.deepEqual(s.nextOf, order, 'turn order of OUR round kept');
  assert.deepEqual(s.roundPlayers, ['A', 'S1', 'B', 'S2']);
  assert.equal(s.roundSeq, 1, 'no new round');
  feed(obs, { ps: [{ uid: 'C', cs: [] }, { uid: 'X', cs: [] }, { uid: 'Y', cs: [] }], fP: { uid: 'X' }, cmd: 855 }, 'B3', 'C');
  assert.equal(obs.getSnapshot().roundActive, true, 'their round end is not ours');
});

test('our own round still works: its frames, its eat, its end, and the next round', () => {
  const obs = ourRound();
  feed(obs, { fP: { uid: 'A', dCs: filler(0)[0] }, tP: { uid: 'S1' }, cmd: 851 }, 'B1', 'A');
  feed(obs, { cs: filler(0)[0], fP: { uid: 'S1', puid: 'A' }, cmd: 853 }, 'B2', 'B');
  assert.equal(obs.getSnapshot().eats.length, 1);
  feed(obs, { ps: [{ uid: 'A', cs: [] }, { uid: 'B', cs: [] }], fP: { uid: 'S1' }, cmd: 855 }, 'B1', 'A');
  assert.equal(obs.getSnapshot().roundActive, false);
  feed(obs, { cs: filler(6), lpi: ['B', 'A', 'S1'], cmd: 850, tP: { uid: 'B' } }, 'B1', 'A');
  assert.equal(obs.getSnapshot().roundSeq, 2);
  assert.deepEqual(obs.getSnapshot().roundPlayers, ['B', 'A', 'S1']);
});
