// User 2026-10-06: "cứ thêm con dự bị vào không chơi cũng bị lỗi lọc sai của con số 1-2-3". Reproduced on the REAL
// coordinator: P1–P3 play (+ strangers); a reserve P4 joins the session (addProfile — warm, its own table / lobby).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { createSafeCardAnalyzer } = require('../../desktop/protocol/phom/phom-safe-card-analyzer.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');

const UID = { R1: '1_1', R2: '1_2', R3: '1_3', R4: '1_4' };
function mk() {
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(),
    profiles: ['R1', 'R2', 'R3'].map((id) => ({ id, displayName: id, send: async () => ({ ok: true }) })) });
  const feed = (id, o, dir = 'recv') => coord.ingest(id, { raw: JSON.stringify(o), direction: dir, targetId: 't-' + id, url: 'wss://sim', now: Date.now() });
  for (const id of ['R1', 'R2', 'R3']) { feed(id, [5, { uid: UID[id], As: { gold: 1 }, cmd: 100, id: 0 }]); coord.setIdentity(id, { aid: '1' }); }
  return { coord, feed };
}
const hand = (k) => Array.from({ length: 9 }, (_, i) => encodeCard((k * 3 + i) % 13, (k + i) % 4));
const analyses = (coord) => {
  const snap = coord.cardObserverSnapshot();
  const out = {};
  for (const sl of ['B1', 'B2', 'B3']) { const u = snap.slotBinding[sl]; if (u) { const a = createSafeCardAnalyzer().analyze({ snapshot: snap, targetPlayerUid: u }); out[sl] = { uid: u, status: a.status, next: a.nextPlayerUid, cards: a.targetCards.map((c) => c.code + c.classification).join(',') }; } }
  return { slotBinding: { ...snap.slotBinding }, out, roundSeq: snap.roundSeq, pile: snap.discardPile.slice() };
};

function playOurRound(coord, feed) {
  const lpi = [UID.R1, 's_1', UID.R2, UID.R3];
  feed('R1', [5, { ps: [UID.R1, 's_1', UID.R2, UID.R3].map((uid, sit) => ({ uid, sit, C: sit === 0 })), cmd: 202 }]);
  feed('R2', [5, { ps: [UID.R1, 's_1', UID.R2, UID.R3].map((uid, sit) => ({ uid, sit, C: sit === 0 })), cmd: 202 }]);
  feed('R3', [5, { ps: [UID.R1, 's_1', UID.R2, UID.R3].map((uid, sit) => ({ uid, sit, C: sit === 0 })), cmd: 202 }]);
  feed('R1', [5, { cs: hand(0), lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  feed('R2', [5, { cs: hand(1), lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  feed('R3', [5, { cs: hand(2), lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  for (const id of ['R1', 'R2', 'R3']) feed(id, [5, { fP: { uid: UID.R1, dCs: hand(0)[0] }, tP: { uid: 's_1' }, cmd: 851 }]);
}

test('a reserve added to the session (not playing) never changes LỌC BÀI of P1/P2/P3', () => {
  const base = mk(); playOurRound(base.coord, base.feed);
  const expected = analyses(base.coord);

  const { coord, feed } = mk();
  playOurRound(coord, feed);
  assert.equal(coord.addProfile({ id: 'R4', displayName: 'R4', send: async () => ({ ok: true }) }), true);
  feed('R4', [5, { uid: UID.R4, As: { gold: 1 }, cmd: 100, id: 0 }]);
  // the reserve plays at ANOTHER table: its seats, its deal, its draws and discards
  feed('R4', [5, { ps: [UID.R4, 'x', 'y'].map((uid, sit) => ({ uid, sit, C: sit === 0 })), cmd: 202 }]);
  feed('R4', [5, { cs: hand(3), lpi: [UID.R4, 'x', 'y'], cmd: 850, tP: { uid: UID.R4 } }]);
  feed('R4', [5, { fP: { uid: 'x', dCs: hand(1)[2] }, tP: { uid: 'y' }, cmd: 851 }]);
  feed('R4', [5, { cs: hand(2)[3], uid: UID.R4, sAC: hand(3).concat([hand(2)[3]]), sMs: [], cmd: 852 }]);
  feed('R4', [5, { ps: [{ uid: UID.R4, cs: [] }, { uid: 'x', cs: [] }], fP: { uid: 'x' }, cmd: 855 }]);
  const got = analyses(coord);
  assert.deepEqual(got.slotBinding, expected.slotBinding, 'P1/P2/P3 still bound to their own accounts');
  assert.deepEqual(got.out, expected.out, 'every P1/P2/P3 verdict unchanged');
  assert.deepEqual(got.pile, expected.pile);
  assert.equal(coord.cardObserverSnapshot().roundActive, true);
});

// ĐỔI mid-round: the swapped-out account still plays this round (it is at the table, dealt). Its hand is KNOWN to us —
// it stopped being "ours" for the controls, not for the cards: a card it can eat must never become "Nên đánh".
test('after ĐỔI, the account that moved out keeps its KNOWN hand for the verdicts of the others (no false "Nên đánh")', () => {
  const { coord, feed } = mk();
  // turn order: R1 → R2 → s_1 → R3; R2 (P2) holds K(1)+K(2) — it can eat K(0) from R1
  const lpi = [UID.R1, UID.R2, 's_1', UID.R3];
  const K = (s) => encodeCard(12, s);
  const r1 = [K(0), ...hand(5).filter((c) => Math.floor(c / 4) !== 12)].slice(0, 9);
  const r2 = [K(1), K(2), ...hand(6).filter((c) => Math.floor(c / 4) !== 12)].slice(0, 9);
  for (const id of ['R1', 'R2', 'R3']) feed(id, [5, { ps: lpi.map((uid, sit) => ({ uid, sit, C: sit === 0 })), cmd: 202 }]);
  feed('R1', [5, { cs: r1, lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  feed('R2', [5, { cs: r2, lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  feed('R3', [5, { cs: hand(7), lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  const verdict = () => {
    const snap = coord.cardObserverSnapshot();
    const a = createSafeCardAnalyzer().analyze({ snapshot: snap, targetPlayerUid: UID.R1 });
    return a.targetCards.find((c) => c.code === K(0)).classification;
  };
  assert.equal(verdict(), 'RISKY', 'before: P2 can eat it');
  // P4 joins and is swapped into P2's place; R2 stays at the table for this round
  coord.addProfile({ id: 'R4', displayName: 'R4', send: async () => ({ ok: true }) });
  feed('R4', [5, { uid: UID.R4, As: { gold: 1 }, cmd: 100, id: 0 }]);
  assert.equal(coord.swapProfiles('R2', 'R4'), true);
  assert.equal(verdict(), 'RISKY', 'after ĐỔI: still RISKY — we saw that hand');
});

// The SAME deal delivered twice (a capture attached twice — the cluster re-connects every browser when a reserve is
// reopened, a stale hook is re-installed) is one deal. Since 3.1.21 a 2nd DEAL to one hand means "new round" — a
// duplicate used to wipe the round (the other accounts' hands, every discard) in the middle of the deal.
test('the SAME deal delivered twice never starts a new round; a DIFFERENT deal to the same hand still does', () => {
  const { coord, feed } = mk();
  const lpi = [UID.R1, 's_1', UID.R2, UID.R3];
  feed('R1', [5, { cs: hand(0), lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  feed('R2', [5, { cs: hand(1), lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  feed('R3', [5, { cs: hand(2), lpi, cmd: 850, tP: { uid: UID.R1 } }]);
  feed('R1', [5, { fP: { uid: UID.R1, dCs: hand(0)[0] }, tP: { uid: 's_1' }, cmd: 851 }]);
  const before = coord.cardObserverSnapshot();
  feed('R2', [5, { cs: hand(1), lpi, cmd: 850, tP: { uid: UID.R1 } }]);          // duplicate delivery
  const after = coord.cardObserverSnapshot();
  assert.equal(after.roundSeq, before.roundSeq, 'same round');
  assert.deepEqual(after.discardPile, before.discardPile);
  assert.deepEqual(after.players[UID.R3].currentCards, before.players[UID.R3].currentCards, 'the other hands kept');
  feed('R2', [5, { cs: hand(4), lpi, cmd: 850, tP: { uid: UID.R2 } }]);          // a real new deal (855 missed)
  assert.equal(coord.cardObserverSnapshot().roundSeq, before.roundSeq + 1);
});
