// PHASE 6.3.3.2 — CARD OBSERVATION ENGINE unit tests. Drives the observer with REAL classified frames
// (classifyPhomFrame over the exact wire shapes proven in the audit: DEAL 850 cs[], PLAY 851 fP.dCs,
// DRAW 852 uid/sAC, MELD 854 mes[], TABLE_STATE ps[]). No fabricated fields. Covers §23 tests 1–16.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCardObserver, STATUS, CAPABILITIES, normalizeCards } = require('../../desktop/protocol/phom/phom-card-observer.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');

// wire-frame builders mirroring the live-captured shapes (see phom-frame-classify.test.mjs)
const dealFrame = (cs, tp) => classifyPhomFrame(JSON.stringify([5, { cs, cmd: 850, tP: tp ? { uid: tp } : undefined }]));
const drawFrame = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 852 }]));
const playFrame = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 851 }]));
const meldFrame = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 854 }]));
const tableStateFrame = (ps, b) => classifyPhomFrame(JSON.stringify([5, { ps, b, cmd: 0 }]));

let clock = 1000;
const feed = (obs, cls, extra = {}) => obs.ingestFrame({ cls, now: clock++, ...extra });

// ---- Test 1 — new observer empty state ----
test('1. a new observer starts empty (no players, no cards out, full deck remaining)', () => {
  const obs = createCardObserver({ runId: 'R1' });
  const s = obs.getSnapshot();
  assert.deepEqual(s.players, {});
  assert.equal(s.roundSeq, 0);
  assert.equal(s.roundActive, false);
  assert.equal(s.discardPile.length, 0);
  assert.equal(s.remaining.count, 52);
  assert.equal(s.remaining.knownOutCount, 0);
  assert.equal(s.roundId, null);                 // no server round id (UNSUPPORTED)
  assert.equal(s.capabilities.otherPlayerHand, false);
});

// ---- Test 2 — player binding (B1/B2/B3 → UID) ----
test('2. a browser SLOT binds to its AUTHORITATIVE own uid (never the browser index)', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 4, 8, 12, 16, 20, 24, 28, 32], 'uidA'), { slot: 'B2', ownUid: 'uidA' });
  const s = obs.getSnapshot();
  assert.equal(s.slotBinding.B2, 'uidA');
  assert.equal(s.players.uidA.controlled, true);
  assert.equal(s.players.uidA.slot, 'B2');
});

// ---- Test 3 — current cards update (own hand) ----
test('3. DEAL sets the socket owner currentCards (own hand) with source', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 4, 8, 12, 16, 20, 24, 28, 32]), { slot: 'B1', ownUid: 'A' });
  const p = obs.getPlayer('A');
  assert.equal(p.currentCards.length, 9);
  assert.equal(p.currentCardsSource, 'DEAL');
  assert.deepEqual(p.currentCards, [0, 4, 8, 12, 16, 20, 24, 28, 32]);
});

// ---- Test 4 — draw event (own authoritative full hand + drawn card) ----
test('4. own DRAW (sAC) replaces the hand and records the drawn card; a public draw exposes NO card', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 4, 8, 12, 16, 20, 24, 28, 32]), { slot: 'B1', ownUid: 'A' });
  feed(obs, drawFrame({ uid: 'A', cs: 40, sAC: [0, 4, 8, 12, 16, 20, 24, 28, 32, 40] }), { slot: 'B1', ownUid: 'A' });
  const p = obs.getPlayer('A');
  assert.equal(p.currentCards.length, 10);
  assert.equal(p.drawnHistory.length, 1);
  assert.equal(p.drawnHistory[0].card, 40);
  assert.equal(p.drawnHistory[0].source, 'DRAW_OWN');
  // a PUBLIC draw by another player: fact only, no card fabricated
  feed(obs, drawFrame({ uid: 'X', cs: 7 }), { slot: 'B1', ownUid: 'A' });
  assert.equal(obs.getPlayer('X'), null, 'no card evidence → no fabricated draw for the other player');
});

// ---- Test 5 — single discard (public) ----
test('5. PLAY records a single public discard for the acting uid', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 4, 8, 12, 16, 20, 24, 28, 32]), { slot: 'B1', ownUid: 'A' });
  feed(obs, playFrame({ fP: { uid: 'A', dCs: 8 }, tP: { uid: 'B' } }), { slot: 'B1', ownUid: 'A' });
  const p = obs.getPlayer('A');
  assert.equal(p.discardedHistory.length, 1);
  assert.equal(p.discardedHistory[0].card, 8);
  const s = obs.getSnapshot();
  assert.deepEqual(s.discardPile, [8]);
  assert.equal(s.ledger.find((e) => e.code === 8).status, STATUS.DISCARDED);
  // discarded card left the owner's hand
  assert.equal(obs.getPlayer('A').currentCards.includes(8), false);
});

// ---- Test 6 — multiple-card discard ----
test('6. PLAY supports a MULTI-card discard (dCs array)', () => {
  const obs = createCardObserver();
  feed(obs, playFrame({ fP: { uid: 'B', dCs: [10, 14, 18] }, tP: { uid: 'C' } }), { slot: 'B2', ownUid: 'A' });
  const p = obs.getPlayer('B');
  assert.equal(p.discardedHistory.length, 3);
  assert.deepEqual(p.discardedHistory.map((d) => d.card).sort((a, b) => a - b), [10, 14, 18]);
  const ev = obs.getAllObservedDiscards();
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].cards, [10, 14, 18]);
});

// ---- Test 7 — duplicate WS state does not duplicate a discard ----
test('7. the SAME discard echoed on all 3 browser sockets is recorded ONCE (dedup)', () => {
  const obs = createCardObserver();
  const f = () => playFrame({ fP: { uid: 'A', dCs: 8 }, tP: { uid: 'B' } });
  feed(obs, f(), { slot: 'B1', ownUid: 'A' }); // echo on B1
  feed(obs, f(), { slot: 'B2', ownUid: 'B' }); // echo on B2
  feed(obs, f(), { slot: 'B3', ownUid: 'C' }); // echo on B3
  const p = obs.getPlayer('A');
  assert.equal(p.discardedHistory.length, 1, 'one discard, not three');
  assert.deepEqual(obs.getSnapshot().discardPile, [8]);
});

// ---- Test 8 — same card in repeated state does not duplicate ----
test('8. re-applying the same authoritative hand does not duplicate cards (idempotent)', () => {
  const obs = createCardObserver();
  const deal = dealFrame([0, 4, 8, 12, 16, 20, 24, 28, 32]);
  feed(obs, deal, { slot: 'B1', ownUid: 'A' });
  feed(obs, deal, { slot: 'B1', ownUid: 'A' });
  feed(obs, deal, { slot: 'B1', ownUid: 'A' });
  assert.equal(obs.getPlayer('A').currentCards.length, 9);
  assert.equal(obs.getSnapshot().remaining.count, 43); // 52 − 9, no double count
});

// ---- Test 9 — multiple players ----
test('9. three controlled browsers track three SEPARATE hands (never merged)', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8]), { slot: 'B1', ownUid: 'A' });
  feed(obs, dealFrame([9, 10, 11, 12, 13, 14, 15, 16, 17]), { slot: 'B2', ownUid: 'B' });
  feed(obs, dealFrame([18, 19, 20, 21, 22, 23, 24, 25, 26]), { slot: 'B3', ownUid: 'C' });
  assert.equal(obs.getPlayer('A').currentCards.length, 9);
  assert.equal(obs.getPlayer('B').currentCards.length, 9);
  assert.equal(obs.getPlayer('C').currentCards.length, 9);
  // hands stay distinct — no A∪B∪C merge into one
  assert.notDeepEqual(obs.getPlayer('A').currentCards, obs.getPlayer('B').currentCards);
  assert.equal(obs.getSnapshot().remaining.count, 52 - 27);
});

// ---- Test 10 — other player discard ----
test('10. a discard by a NON-controlled player (no open browser) is still observed', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8]), { slot: 'B1', ownUid: 'A' });
  feed(obs, playFrame({ fP: { uid: 'P4', dCs: 51 }, tP: { uid: 'A' } }), { slot: 'B1', ownUid: 'A' });
  const p4 = obs.getPlayer('P4');
  assert.ok(p4, 'other player tracked');
  assert.equal(p4.controlled, false);
  assert.equal(p4.discardedHistory[0].card, 51);
});

// ---- Test 11 — new round resets all card state ----
test('11. a new round (ROUND_END → DEAL) clears every card of the previous round but keeps identity', () => {
  const obs = createCardObserver();
  feed(obs, tableStateFrame([{ sit: 0, uid: 'A', dn: 'Alice' }], 100));
  feed(obs, dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8]), { slot: 'B1', ownUid: 'A' });
  feed(obs, playFrame({ fP: { uid: 'A', dCs: 0 }, tP: { uid: 'B' } }), { slot: 'B1', ownUid: 'A' });
  const r1 = obs.getSnapshot();
  assert.equal(r1.roundSeq, 1);
  assert.equal(r1.discardPile.length, 1);
  // round ends, then a fresh deal begins round 2
  feed(obs, classifyPhomFrame(JSON.stringify([5, { cmd: 853, sAC: [0, 1, 2, 3, 4, 5, 6, 7, 8], fP: { uid: 'A', lm: -3 } }])), { slot: 'B1', ownUid: 'A' });
  feed(obs, dealFrame([20, 21, 22, 23, 24, 25, 26, 27, 28]), { slot: 'B1', ownUid: 'A' });
  const r2 = obs.getSnapshot();
  assert.equal(r2.roundSeq, 2);
  assert.equal(r2.discardPile.length, 0, 'previous round discards cleared');
  assert.deepEqual(r2.players.A.currentCards, [20, 21, 22, 23, 24, 25, 26, 27, 28], 'fresh hand');
  assert.equal(r2.players.A.name, 'Alice', 'identity (name) preserved across the round');
  assert.equal(r2.slotBinding.B1, 'A', 'slot binding preserved across the round');
});

// ---- Test 12 — remaining-card calculation ----
test('12. remaining = 52 − every card proven out (hands + discards + melds), no double count', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8]), { slot: 'B1', ownUid: 'A' });       // 9 CURRENT
  feed(obs, playFrame({ fP: { uid: 'P4', dCs: 40 }, tP: { uid: 'A' } }), { slot: 'B1', ownUid: 'A' }); // +1 DISCARDED
  feed(obs, meldFrame({ uid: 'P5', mes: [{ meid: 1, cs: [45, 46, 47] }] }), { slot: 'B1', ownUid: 'A' }); // +3 MELDED
  const r = obs.getRemainingCards();
  assert.equal(r.knownOutCount, 13);
  assert.equal(r.count, 52 - 13);
  assert.equal(r.codes.includes(0), false); // held
  assert.equal(r.codes.includes(40), false); // discarded
  assert.equal(r.codes.includes(45), false); // melded
  assert.equal(r.codes.includes(50), true);  // truly unseen → remaining
});

// ---- Test 13 — known vs unknown card ----
test('13. an unseen card is NOT force-counted as used; a card cannot hold two authoritative statuses', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8]), { slot: 'B1', ownUid: 'A' });
  const ledger = obs.getSnapshot().ledger;
  assert.equal(ledger.find((e) => e.code === 30), undefined, 'unseen card has no ledger entry (unknown)');
  // a card that was CURRENT then discarded ends as DISCARDED only (terminal wins; never both)
  feed(obs, playFrame({ fP: { uid: 'A', dCs: 3 }, tP: { uid: 'B' } }), { slot: 'B1', ownUid: 'A' });
  const entries = obs.getSnapshot().ledger.filter((e) => e.code === 3);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, STATUS.DISCARDED);
});

// ---- Test 14 — snapshot immutability ----
test('14. getSnapshot returns a deep-cloned, frozen structure (mutation cannot corrupt the observer)', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8]), { slot: 'B1', ownUid: 'A' });
  const s = obs.getSnapshot();
  assert.throws(() => { s.discardPile.push(99); }, 'snapshot is frozen');
  assert.throws(() => { s.players.A.currentCards.push(99); }, 'nested arrays frozen');
  // the live observer is unaffected regardless
  assert.equal(obs.getSnapshot().players.A.currentCards.length, 9);
});

// ---- Test 15 — B1/B2/B3 → UID mapping ----
test('15. slotBinding maps B1/B2/B3 to the three authoritative uids (identity, not index)', () => {
  const obs = createCardObserver();
  feed(obs, drawFrame({ uid: 'uidA', cs: 0, sAC: [0, 1, 2, 3, 4, 5, 6, 7, 8] }), { slot: 'B1', ownUid: 'uidA' });
  feed(obs, drawFrame({ uid: 'uidB', cs: 9, sAC: [9, 10, 11, 12, 13, 14, 15, 16, 17] }), { slot: 'B2', ownUid: 'uidB' });
  feed(obs, drawFrame({ uid: 'uidC', cs: 18, sAC: [18, 19, 20, 21, 22, 23, 24, 25, 26] }), { slot: 'B3', ownUid: 'uidC' });
  assert.deepEqual(obs.getSnapshot().slotBinding, { B1: 'uidA', B2: 'uidB', B3: 'uidC' });
});

// ---- Test 16 — meld handling (protocol fixture EXISTS: MELD 854 mes[]) ----
test('16. MELD (854) is parsed and stored per owner uid (protocol proves it — supported)', () => {
  assert.equal(CAPABILITIES.meld, true);
  const obs = createCardObserver();
  feed(obs, meldFrame({ uid: 'A', mes: [{ meid: 1, cs: [10, 14, 18] }] }), { slot: 'B1', ownUid: 'A' });
  const p = obs.getPlayer('A');
  assert.equal(p.melds.length, 1);
  assert.equal(p.melds[0].meid, 1);
  assert.deepEqual(p.melds[0].cards, [10, 14, 18]);
  // dedup: the same public meld echoed on another socket is not duplicated
  feed(obs, meldFrame({ uid: 'A', mes: [{ meid: 1, cs: [10, 14, 18] }] }), { slot: 'B2', ownUid: 'B' });
  assert.equal(obs.getPlayer('A').melds.length, 1);
});

// ---- capabilities + analysis angle (§8/§19/§20) ----
test('17. capabilities declare exactly what the protocol proves; other-player hand is UNSUPPORTED', () => {
  assert.equal(CAPABILITIES.discard, true);
  assert.equal(CAPABILITIES.otherPlayers, true);
  assert.equal(CAPABILITIES.otherPlayerHand, false);
  assert.equal(CAPABILITIES.serverRoundId, false);
});

test('18. the analysis angle selects ONE player and never merges the three hands (§20)', () => {
  const obs = createCardObserver();
  feed(obs, dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8]), { slot: 'B1', ownUid: 'A' });
  feed(obs, dealFrame([9, 10, 11, 12, 13, 14, 15, 16, 17]), { slot: 'B2', ownUid: 'B' });
  obs.setAnalysisPlayer('B');
  const s = obs.getSnapshot();
  assert.equal(s.selectedAnalysisPlayer, 'B');
  // players remain distinct entries — there is no combined/merged hand anywhere in the snapshot
  assert.equal(Object.keys(s.players).length, 2);
  assert.equal(s.players.A.currentCards.length, 9);
  assert.equal(s.players.B.currentCards.length, 9);
});

// ---- normalization (§11) ----
test('19. normalizeCards accepts number|array and rejects invalid codes (no coercion of garbage)', () => {
  assert.deepEqual(normalizeCards(8), [8]);
  assert.deepEqual(normalizeCards([10, 14, 18]), [10, 14, 18]);
  assert.deepEqual(normalizeCards([10, 99, -1, 'x', 3.5, 18]), [10, 18]);
  assert.deepEqual(normalizeCards(null), []);
  assert.deepEqual(normalizeCards(52), []); // out of [0,51]
});

// ---- mid-round attach (no DEAL seen) still homes public evidence into round 1 ----
test('20. attaching mid-round (public discard before any DEAL) opens round 1 and records it', () => {
  const obs = createCardObserver();
  feed(obs, playFrame({ fP: { uid: 'X', dCs: 20 }, tP: { uid: 'A' } }), { slot: 'B1', ownUid: 'A' });
  const s = obs.getSnapshot();
  assert.equal(s.roundSeq, 1);
  assert.equal(s.discardPile[0], 20);
});
