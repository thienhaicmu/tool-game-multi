// PHASE 6.3.3.3 — SAFE CARD ANALYZER. Drives the analyzer with REAL CardObserver snapshots (built from
// classified wire-frames) so it exercises the true pipeline: WS → CardObserver → snapshot → SafeCardAnalyzer.
// Read-only + deterministic; never fabricates certainty; UNKNOWN is never SAFE. Covers §26 tests 1–16 + §27/§28.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createCardObserver } = require('../../desktop/protocol/phom/phom-card-observer.cjs');
const { classifyPhomFrame, encodeCard } = ((r) => ({ ...r, encodeCard: require('../../desktop/protocol/phom/card-codec.cjs').encodeCard }))(require('../../desktop/protocol/phom/phom-frame-classify.cjs'));
const { createSafeCardAnalyzer, CLASS, STATUS } = require('../../desktop/protocol/phom/phom-safe-card-analyzer.cjs');

const identFrame = (id) => classifyPhomFrame(`[5,{"uid":"${id}","As":{"gold":1},"cmd":100,"id":0}]`);
const dealFrame = (cs) => classifyPhomFrame(JSON.stringify([5, { cs, cmd: 850 }]));
const playFrame = (uid, dCs, tp) => classifyPhomFrame(JSON.stringify([5, { fP: { uid, dCs }, tP: { uid: tp }, cmd: 851 }]));
const meldFrame = (uid, cs) => classifyPhomFrame(JSON.stringify([5, { uid, mes: [{ meid: 1, cs }], cmd: 854 }]));
const drawFrame = (o) => classifyPhomFrame(JSON.stringify([5, { ...o, cmd: 852 }]));

let clk = 1;
function observerWith(fn) {
  const obs = createCardObserver();
  // bind the three browser slots to their authoritative uids (uidA/uidB/uidC)
  obs.ingestFrame({ slot: 'B1', ownUid: 'uidA', cls: identFrame('uidA'), now: clk++ });
  obs.ingestFrame({ slot: 'B2', ownUid: 'uidB', cls: identFrame('uidB'), now: clk++ });
  obs.ingestFrame({ slot: 'B3', ownUid: 'uidC', cls: identFrame('uidC'), now: clk++ });
  fn((slot, ownUid, cls) => obs.ingestFrame({ slot, ownUid, cls, now: clk++ }));
  return obs;
}

// ---- Test 1 — empty snapshot ----
test('1. empty snapshot / no target → NO_TARGET, no fabricated cards', () => {
  const a = createSafeCardAnalyzer();
  const obs = createCardObserver();
  const r = a.analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: null });
  assert.equal(r.status, STATUS.NO_TARGET);
  assert.deepEqual(r.safeCards, []);
  assert.deepEqual(r.targetCards, []);
  assert.equal(a.analyze({ snapshot: null, targetPlayerUid: 'x' }).status, STATUS.NO_TARGET);
});

// ---- Tests 2/3/4 — target each of Player 1/2/3 ----
for (const [n, slot, uid, dealt] of [[1, 'B1', 'uidA', [0, 1, 2]], [2, 'B2', 'uidB', [20, 21, 22]], [3, 'B3', 'uidC', [40, 41, 42]]]) {
  test(`${n + 1}. target Player ${n} analyses ONLY that player's own hand`, () => {
    const obs = observerWith((feed) => {
      feed('B1', 'uidA', dealFrame([0, 1, 2]));
      feed('B2', 'uidB', dealFrame([20, 21, 22]));
      feed('B3', 'uidC', dealFrame([40, 41, 42]));
    });
    const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: uid });
    assert.equal(r.status, STATUS.OK);
    assert.equal(r.targetPlayerLabel, `Player ${n}`);
    assert.equal(r.targetSlot, slot);
    assert.deepEqual(r.targetCards.map((c) => c.code).sort((x, y) => x - y), dealt);
  });
}

// ---- Test 5 — exactly one target (switching target switches the hand) ----
test('5. exactly one target — switching the target switches which hand is analysed', () => {
  const obs = observerWith((feed) => { feed('B1', 'uidA', dealFrame([0, 1, 2])); feed('B2', 'uidB', dealFrame([20, 21, 22])); });
  const a = createSafeCardAnalyzer();
  assert.deepEqual(a.analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' }).targetCards.map((c) => c.code).sort((x, y) => x - y), [0, 1, 2]);
  assert.deepEqual(a.analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidB' }).targetCards.map((c) => c.code).sort((x, y) => x - y), [20, 21, 22]);
});

// ---- Test 6 — invalid target uid ----
test('6. an unknown target uid → TARGET_NOT_FOUND (never crashes, never fabricates a hand)', () => {
  const obs = observerWith((feed) => feed('B1', 'uidA', dealFrame([0, 1, 2])));
  const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'NOPE' });
  assert.equal(r.status, STATUS.TARGET_NOT_FOUND);
  assert.deepEqual(r.targetCards, []);
});

// ---- Test 7 — current cards used ONLY for the selected target ----
test('7. only the selected target current cards are analysed (others are context, not the hand)', () => {
  const obs = observerWith((feed) => { feed('B1', 'uidA', dealFrame([0, 1, 2])); feed('B2', 'uidB', dealFrame([20, 21, 22])); feed('B3', 'uidC', dealFrame([40, 41, 42])); });
  const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' });
  const codes = r.targetCards.map((c) => c.code);
  for (const other of [20, 21, 22, 40, 41, 42]) assert.equal(codes.includes(other), false);
});

// ---- Test 8 — P1/P2/P3 are NOT merged ----
test('8. the three hands are never merged into one target hand', () => {
  const obs = observerWith((feed) => { feed('B1', 'uidA', dealFrame([0, 1, 2, 3, 4, 5, 6, 7, 8])); feed('B2', 'uidB', dealFrame([9, 10, 11, 12, 13, 14, 15, 16, 17])); feed('B3', 'uidC', dealFrame([18, 19, 20, 21, 22, 23, 24, 25, 26])); });
  const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' });
  assert.equal(r.targetCards.length, 9, 'only Player 1 hand (9), not 27');
});

// A hand where K♠(48) can be PROVEN safe once its partners go public; 30 stays fully open (UNKNOWN).
function safeScenario(withPublic) {
  return observerWith((feed) => {
    feed('B1', 'uidA', dealFrame([48, 30]));
    if (withPublic === 'discard') { feed('B1', 'uidA', playFrame('OPP', 49, 'uidA')); feed('B1', 'uidA', playFrame('OPP', 50, 'uidA')); feed('B1', 'uidA', playFrame('OPP', 40, 'uidA')); }
    if (withPublic === 'meld') { feed('B1', 'uidA', meldFrame('OPP', [49, 50, 51])); }
  });
}

// ---- Test 9 — public discard affects analysis ----
test('9. public discards of the completing partners make a card provably SAFE (was UNKNOWN)', () => {
  const before = createSafeCardAnalyzer().analyze({ snapshot: safeScenario(null).getSnapshot(), targetPlayerUid: 'uidA' });
  assert.equal(before.targetCards.find((c) => c.code === 48).classification, CLASS.UNKNOWN, 'no public info → UNKNOWN');
  const after = createSafeCardAnalyzer().analyze({ snapshot: safeScenario('discard').getSnapshot(), targetPlayerUid: 'uidA' });
  const k = after.targetCards.find((c) => c.code === 48);
  assert.equal(k.classification, CLASS.SAFE);
  assert.ok(k.reasonCodes.includes('ALL_MELDS_BLOCKED') && k.reasonCodes.includes('PUBLIC_DISCARD_SIGNAL'));
});

// ---- Test 10 — public meld affects analysis ----
test('10. a public meld of the rank partners narrows the card to LIKELY_SAFE with a meld reason', () => {
  const after = createSafeCardAnalyzer().analyze({ snapshot: safeScenario('meld').getSnapshot(), targetPlayerUid: 'uidA' });
  const k = after.targetCards.find((c) => c.code === 48);
  assert.equal(k.classification, CLASS.LIKELY_SAFE);
  assert.ok(k.reasonCodes.includes('RANK_FAMILY_BLOCKED') && k.reasonCodes.includes('PUBLIC_MELD_SIGNAL'));
});

// ---- Test 11 — unknown hidden hand does not become known ----
test('11. a card whose partners are all unseen stays UNKNOWN (hidden hands never become known)', () => {
  const r = createSafeCardAnalyzer().analyze({ snapshot: safeScenario(null).getSnapshot(), targetPlayerUid: 'uidA' });
  assert.equal(r.targetCards.find((c) => c.code === 30).classification, CLASS.UNKNOWN);
  assert.equal(r.capabilities.otherPlayerHand, false);
});

// ---- Test 12 — unknown opponent draw does not become known ----
test('12. a public draw by another player exposes no card and does not change the analysis', () => {
  const obsA = safeScenario('discard');
  const before = createSafeCardAnalyzer().analyze({ snapshot: obsA.getSnapshot(), targetPlayerUid: 'uidA' });
  obsA.ingestFrame({ slot: 'B1', ownUid: 'uidA', cls: drawFrame({ uid: 'OPP', cs: 7 }), now: clk++ }); // public draw, no card
  const after = createSafeCardAnalyzer().analyze({ snapshot: obsA.getSnapshot(), targetPlayerUid: 'uidA' });
  assert.deepEqual(after.safeCards, before.safeCards);
  assert.equal(after.capabilities.otherPlayerDrawnCard, false);
});

// ---- Test 13 — remaining cards drive safety (ledger-based, from the observer) ----
test('13. safety is derived from the observer ledger/remaining (partners in remaining keep a card open)', () => {
  // only ONE of the two rank partners public → rank meld still open via the unseen one → not SAFE
  const obs = observerWith((feed) => { feed('B1', 'uidA', dealFrame([48])); feed('B1', 'uidA', playFrame('OPP', 49, 'uidA')); });
  const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' });
  assert.notEqual(r.targetCards.find((c) => c.code === 48).classification, CLASS.SAFE);
});

// ---- Test 14 — deterministic ----
test('14. same snapshot + same target → identical output (deterministic)', () => {
  const snap = safeScenario('discard').getSnapshot();
  const r1 = createSafeCardAnalyzer().analyze({ snapshot: snap, targetPlayerUid: 'uidA' });
  const r2 = createSafeCardAnalyzer().analyze({ snapshot: snap, targetPlayerUid: 'uidA' });
  assert.deepEqual(r1, r2);
});

// ---- Test 15 — new round clears old analysis ----
test('15. a new round clears the previous analysis (no stale safe cards carry over)', () => {
  const obs = safeScenario('discard');
  const a = createSafeCardAnalyzer();
  assert.ok(a.analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' }).safeCards.length >= 1);
  // round ends, new deal begins round 2 with a different hand
  obs.ingestFrame({ slot: 'B1', ownUid: 'uidA', cls: classifyPhomFrame(JSON.stringify([5, { cmd: 853, sAC: [48, 30], fP: { uid: 'uidA', lm: 0 } }])), now: clk++ });
  obs.ingestFrame({ slot: 'B1', ownUid: 'uidA', cls: dealFrame([12, 13]), now: clk++ });
  const r2 = a.analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' });
  assert.equal(r2.roundSeq, 2);
  assert.deepEqual(r2.targetCards.map((c) => c.code).sort((x, y) => x - y), [12, 13], 'fresh round hand only');
  assert.equal(r2.safeCards.find((c) => c.code === 48), undefined, 'previous safe card cleared');
  a.reset();
  assert.equal(a.getAnalysis(), null);
});

// ---- Test 16 — no analyzer output is a game command ----
test('16. the analyzer result is READ-ONLY — no action/command/click/play fields anywhere', () => {
  const r = createSafeCardAnalyzer().analyze({ snapshot: safeScenario('discard').getSnapshot(), targetPlayerUid: 'uidA' });
  const json = JSON.stringify(r);
  for (const forbidden of ['action', 'command', 'sendPlay', 'recommendedAction', 'click', 'discardCard']) {
    assert.equal(json.includes(`"${forbidden}"`), false, `result must not carry a ${forbidden} field`);
  }
});

// ---- §27 — UNKNOWN ≠ SAFE (mandatory) ----
test('17. a never-observed card is NEVER auto-classified SAFE (UNKNOWN ≠ SAFE)', () => {
  const obs = observerWith((feed) => feed('B1', 'uidA', dealFrame([30]))); // 30 with all partners unseen
  const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' });
  const c = r.targetCards.find((x) => x.code === 30);
  assert.equal(c.classification, CLASS.UNKNOWN);
  assert.equal(r.safeCards.length, 0, 'nothing is SAFE without proof');
});

// ---- known-eatable by a CONTROLLED opponent → RISKY (real, observed danger) ----
test('18. a card a controlled opponent can eat (known hand) is RISKY, not safe', () => {
  // uidB (Player 2) holds 49 and 50 → with target discard 48 they complete a K meld
  const obs = observerWith((feed) => { feed('B1', 'uidA', dealFrame([48])); feed('B2', 'uidB', dealFrame([49, 50, 5, 6])); });
  const r = createSafeCardAnalyzer().analyze({ snapshot: obs.getSnapshot(), targetPlayerUid: 'uidA' });
  const c = r.targetCards.find((x) => x.code === 48);
  assert.equal(c.classification, CLASS.RISKY);
  assert.ok(c.reasonCodes.includes('KNOWN_EATABLE_BY_CONTROLLED'));
  assert.equal(r.safeCards.find((x) => x.code === 48), undefined);
});

// ---- §28 — the analyzer module never touches the game-action pipeline ----
test('19. the analyzer source contains NO send / PLAY / CDP click / game command', () => {
  const src = readFileSync(new URL('../../desktop/protocol/phom/phom-safe-card-analyzer.cjs', import.meta.url), 'utf8');
  for (const forbidden of ['sendProtocol', 'buildPlayFrame', 'Input.dispatch', 'cmd:851', 'cmd: 851', '.click(', 'wsReplay', 'ipcMain']) {
    assert.equal(src.includes(forbidden), false, `analyzer must not reference ${forbidden}`);
  }
});
