import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhomOfflineSimulator, EAT } = require('../../desktop/protocol/phom/offline-simulator.cjs');
const { BASIC_ROUND, OWNER, OPP, listDatasets, getDataset } = require('../../desktop/protocol/phom/offline-sample-datasets.cjs');

const OFFLINE = { sourceKind: 'REDACTED_REPLAY', networkEnabled: false, liveRunCount: 0 };

function sim(extra = {}) {
  return new PhomOfflineSimulator({ events: BASIC_ROUND, simulatedOwnerUid: OWNER, sourceKind: 'REDACTED_REPLAY', context: {}, ...extra });
}

// ---------------------------------------------------------------------------
// §7 — hard offline boundary, enforced in the DOMAIN (this engine), not the UI.
// ---------------------------------------------------------------------------
test('refuses to construct/step in any live context (PHOM_ANALYZER_OFFLINE_ONLY)', () => {
  for (const ctx of [
    { networkEnabled: true },
    { liveRunCount: 1 },
    { liveSessionId: 'S1' },
    { endpoint: 'wss://x' },
    { clusterActive: true },
  ]) {
    const s = new PhomOfflineSimulator({ events: BASIC_ROUND, simulatedOwnerUid: OWNER, sourceKind: 'REDACTED_REPLAY', context: ctx });
    assert.equal(s.ok(), false, `should refuse for ${JSON.stringify(ctx)}`);
    assert.equal(s.blockedResult().error.code, 'PHOM_ANALYZER_OFFLINE_ONLY');
    // stepping also refuses
    const r = s.next();
    assert.equal(r.error.code, 'PHOM_ANALYZER_OFFLINE_ONLY');
  }
});

test('rejects a disallowed source kind', () => {
  const s = new PhomOfflineSimulator({ events: BASIC_ROUND, simulatedOwnerUid: OWNER, sourceKind: 'LIVE_CAPTURE' });
  assert.equal(s.ok(), false);
  assert.equal(s.blockedResult().error.code, 'PHOM_ANALYZER_OFFLINE_ONLY');
});

test('accepts each allowed source kind', () => {
  for (const sourceKind of ['TEST_FIXTURE', 'REDACTED_REPLAY', 'LOCAL_SIMULATOR']) {
    const s = new PhomOfflineSimulator({ events: BASIC_ROUND, simulatedOwnerUid: OWNER, sourceKind });
    assert.equal(s.ok(), true, sourceKind);
  }
});

// ---------------------------------------------------------------------------
// §8 — event-by-event update: a NEW snapshot after EVERY event (not only at end).
// ---------------------------------------------------------------------------
test('publishes a distinct, monotonic snapshot after every single event', () => {
  const s = sim();
  assert.equal(s.total(), BASIC_ROUND.length);
  const seen = [];
  let snap = s.snapshot();
  assert.equal(snap.counters.currentEvent, 0);
  for (let i = 1; i <= s.total(); i++) {
    snap = s.next();
    assert.equal(snap.counters.currentEvent, i, `cursor after event ${i}`);
    assert.equal(snap.counters.totalEvents, BASIC_ROUND.length);
    seen.push(snap);
  }
  // Each step produced its own frozen object (no shared mutation).
  assert.ok(Object.isFrozen(seen[0]));
  for (let i = 1; i < seen.length; i++) assert.notStrictEqual(seen[i], seen[i - 1]);
  // Cannot advance past the end.
  const atEnd = s.next();
  assert.equal(atEnd.counters.currentEvent, BASIC_ROUND.length);
});

// ---------------------------------------------------------------------------
// §9 — protocol/rule requirements per command.
// ---------------------------------------------------------------------------
test('850 DEAL initializes authoritative owner hand and a fresh round', () => {
  const s = sim();
  s.reset();
  const snap = s.next(); // apply event 1 (DEAL)
  assert.equal(snap.authoritative, true);
  assert.equal(snap.counters.authoritativeHandCount, 9);
  assert.equal(snap.hand.count, 9);
  assert.equal(snap.roundIdentity, 'R1');
  assert.equal(snap.lastCommand, 850);
  // two ready runs at deal (4-5-6♠, J-Q-K♠)
  assert.equal(snap.counters.derivedMeldCount, 2);
});

test('852 DRAW applies authoritative sAC and stores/validates sMs', () => {
  const s = sim();
  s.stepTo(2); // DEAL + DRAW
  const snap = s.snapshot();
  assert.equal(snap.lastCommand, 852);
  assert.equal(snap.counters.authoritativeHandCount, 10); // 9 + drawn A♦
  assert.equal(snap.hand.cards.includes(2), true);
  // server melds: AAA set + 4-5-6♠ run + J-Q-K♠ run = 3
  assert.equal(snap.counters.serverMeldCount, 3);
  assert.equal(snap.counters.derivedMeldCount, 3);
  // unique meld-card count must NOT double count (9 distinct cards across 3 melds)
  assert.equal(snap.counters.uniqueMeldCardCount, 9);
  // combination count = server(3) + derived(3)
  assert.equal(snap.counters.meldCombinationCount, 6);
});

test('851 PLAY by opponent yields an EATABLE public discard from owner perspective', () => {
  const s = sim();
  s.stepTo(3); // DEAL, DRAW, opponent discards 7♠(24)
  const snap = s.snapshot();
  assert.equal(snap.lastCommand, 851);
  assert.equal(snap.publicDiscards.length, 1);
  assert.equal(snap.eatCandidates.length, 1);
  assert.equal(snap.eatCandidates[0].card, 24);
  assert.equal(snap.eatCandidates[0].status, EAT.EATABLE);
  assert.equal(snap.counters.eatableCount, 1);
  assert.equal(snap.counters.notEatableCount, 0);
});

test('851 PLAY by owner removes exactly one card and is not an eat candidate', () => {
  const s = sim();
  const before = s.stepTo(3).hand.count;
  const snap = s.stepTo(4); // owner discards 2♣(5)
  assert.equal(snap.hand.count, before - 1);
  assert.equal(snap.hand.cards.includes(5), false);
  // owner's own discard is never listed as an eat candidate
  assert.equal(snap.eatCandidates.some((c) => c.card === 5), false);
});

test('851 owner discard of a card NOT in hand => DESYNCED, never fabricates', () => {
  const events = [
    { seq: 1, frame: [5, { cmd: 850, cs: [0, 1, 12, 16, 20, 40, 44, 48, 5], tP: { uid: OWNER } }] },
    { seq: 2, frame: [5, { cmd: 851, fP: { uid: OWNER, dCs: 51 }, tP: { uid: OPP } }] }, // 51 (K♥) not in hand
  ];
  const s = new PhomOfflineSimulator({ events, simulatedOwnerUid: OWNER, sourceKind: 'TEST_FIXTURE' });
  const snap = s.end();
  assert.equal(snap.syncState, 'DESYNCED');
  assert.ok(snap.consistency.warnings.includes('HAND_DESYNCED'));
  assert.ok(snap.counters.consistencyErrorCount >= 1);
  // hand size unchanged (no fabrication / no phantom removal)
  assert.equal(snap.hand.count, 9);
});

test('854 MELD updates only the public meld, never the full hand', () => {
  const s = sim();
  const beforeCount = s.stepTo(4).hand.count;
  const snap = s.stepTo(5); // owner lays 4-5-6♠ publicly
  assert.equal(snap.lastCommand, 854);
  assert.equal(snap.publicMelds.length, 1);
  assert.deepEqual([...snap.publicMelds[0].cards].sort((a, b) => a - b), [12, 16, 20]);
  // hand count unchanged by a public meld (visibility, not removal)
  assert.equal(snap.hand.count, beforeCount);
});

test('853 ROUND_END freezes the round; a later DEAL resets without bleed', () => {
  const s = sim();
  const snap = s.end();
  assert.equal(snap.syncState, 'ENDED');
  assert.equal(snap.lastCommand, 853);
  // Add a fresh DEAL after the round and ensure the new round starts clean.
  const events = [...BASIC_ROUND, { seq: 7, frame: [5, { cmd: 850, cs: [3, 7, 11, 15, 19, 23, 27, 31, 35], tP: { uid: OWNER } }] }];
  const s2 = new PhomOfflineSimulator({ events, simulatedOwnerUid: OWNER, sourceKind: 'REDACTED_REPLAY' });
  const after = s2.end();
  assert.equal(after.roundIdentity, 'R2');
  assert.equal(after.publicDiscards.length, 0); // pile reset on new DEAL
  assert.equal(after.publicMelds.length, 0);
  assert.equal(after.hand.count, 9);
});

// ---------------------------------------------------------------------------
// §8.4 — duplicate / out-of-order events must not mutate state incorrectly.
// ---------------------------------------------------------------------------
test('duplicate and out-of-order events are ignored (dedup by seq)', () => {
  const events = [
    { seq: 1, frame: [5, { cmd: 850, cs: [0, 1, 12, 16, 20, 40, 44, 48, 5], tP: { uid: OWNER } }] },
    { seq: 2, frame: [5, { cmd: 851, fP: { uid: OWNER, dCs: 5 }, tP: { uid: OPP } }] },
    { seq: 2, frame: [5, { cmd: 851, fP: { uid: OWNER, dCs: 0 }, tP: { uid: OPP } }] }, // duplicate seq — ignored
    { seq: 1, frame: [5, { cmd: 851, fP: { uid: OWNER, dCs: 1 }, tP: { uid: OPP } }] }, // late/out-of-order — ignored
  ];
  const s = new PhomOfflineSimulator({ events, simulatedOwnerUid: OWNER, sourceKind: 'TEST_FIXTURE' });
  const snap = s.end();
  // Only the first discard (5) applied; 0 and 1 remain in hand.
  assert.equal(snap.hand.cards.includes(5), false);
  assert.equal(snap.hand.cards.includes(0), true);
  assert.equal(snap.hand.cards.includes(1), true);
  assert.equal(snap.hand.count, 8);
  const dupEntries = snap.timeline.filter((t) => t.duplicateOrLate);
  assert.equal(dupEntries.length, 2);
});

// ---------------------------------------------------------------------------
// §8 — determinism: previous()/stepTo land on EXACTLY forward-played state.
// ---------------------------------------------------------------------------
test('replay is deterministic — previous() equals forward recompute', () => {
  const a = sim();
  const forward = [];
  a.reset();
  for (let i = 1; i <= a.total(); i++) forward.push(JSON.stringify(a.next()));
  // walk backwards and compare against forward snapshots
  for (let i = a.total() - 1; i >= 1; i--) {
    const back = JSON.stringify(a.previous());
    assert.equal(back, forward[i - 1], `previous to ${i} matches forward`);
  }
  // a fresh instance stepping straight to N equals forward[N-1]
  const b = sim();
  assert.equal(JSON.stringify(b.stepTo(3)), forward[2]);
});

// ---------------------------------------------------------------------------
// §10 — NEVER conclude NOT_EATABLE when the hand is not authoritative => UNKNOWN.
// ---------------------------------------------------------------------------
test('eat candidates are UNKNOWN when owner hand is not authoritative', () => {
  // A public opponent discard with NO prior DEAL/DRAW for the owner.
  const events = [
    { seq: 1, frame: [5, { cmd: 851, fP: { uid: OPP, dCs: 24 }, tP: { uid: OWNER } }] },
  ];
  const s = new PhomOfflineSimulator({ events, simulatedOwnerUid: OWNER, sourceKind: 'REDACTED_REPLAY' });
  const snap = s.end();
  assert.equal(snap.authoritative, false);
  assert.equal(snap.counters.authoritativeHandCount, 0);
  assert.equal(snap.eatCandidates.length, 1);
  assert.equal(snap.eatCandidates[0].status, EAT.UNKNOWN);
  assert.equal(snap.counters.unknownCount, 1);
  assert.equal(snap.counters.notEatableCount, 0);
});

test('unique meld-card count never double counts a shared card', () => {
  // Hand with a 4-card run (4-5-6-7♠) so multiple ≥3 combinations overlap on cards.
  const events = [
    { seq: 1, frame: [5, { cmd: 850, cs: [12, 16, 20, 24, 0, 4, 8, 40, 44], tP: { uid: OWNER } }] },
  ];
  const s = new PhomOfflineSimulator({ events, simulatedOwnerUid: OWNER, sourceKind: 'TEST_FIXTURE' });
  const snap = s.end();
  // derived: run 4-5-6-7♠ (4 cards). unique cards across derived melds = 4, not 8.
  const derivedCardCount = snap.derivedMelds.reduce((n, m) => n + m.cards.length, 0);
  assert.ok(snap.counters.uniqueMeldCardCount <= derivedCardCount);
  const distinct = new Set(snap.derivedMelds.flatMap((m) => m.cards));
  assert.equal(snap.counters.uniqueMeldCardCount, distinct.size);
});

// ---------------------------------------------------------------------------
// §7/§17 — HARD boundary: no live modules are reachable from this engine.
// ---------------------------------------------------------------------------
test('offline engine imports NO live/browser/network modules', () => {
  const __filename = fileURLToPath(import.meta.url);
  const dir = dirname(__filename);
  const src = readFileSync(resolve(dir, '../../desktop/protocol/phom/offline-simulator.cjs'), 'utf8');
  const forbidden = ['cdp', 'browser-run', 'websocket', 'ws-', 'proxy', 'coordinator', 'launcher', 'puppeteer', 'net.connect', 'http', 'electron'];
  for (const bad of forbidden) {
    // only look at require() targets
    const re = new RegExp(`require\\(['"][^'"]*${bad}[^'"]*['"]\\)`, 'i');
    assert.equal(re.test(src), false, `must not require anything matching "${bad}"`);
  }
});

// §19/§26 — ROW 1 "cards not forming a phỏm" is the engine-computed complement of the
// union of derived melds (never recomputed/hard-coded in the renderer).
test('cardsNotInMeld is the exact complement of the union of derived meld cards', () => {
  // hand: AAA set (0,1,2) + 4-5-6♠ run (12,16,20) + two loose cards 2♣(5), K♥(51).
  const events = [{ seq: 1, frame: [5, { cmd: 850, cs: [0, 1, 2, 12, 16, 20, 5, 51, 40], tP: { uid: OWNER } }] }];
  const s = new PhomOfflineSimulator({ events, simulatedOwnerUid: OWNER, sourceKind: 'TEST_FIXTURE' });
  const snap = s.end();
  const meldUnion = new Set(snap.derivedMelds.flatMap((m) => m.cards));
  // complement = hand cards not in any derived meld
  const expected = snap.hand.cards.filter((c) => !meldUnion.has(c)).sort((a, b) => a - b);
  assert.deepEqual([...snap.cardsNotInMeld], expected);
  // 40 (J♠) is loose here (no J run/set), 5 and 51 loose; 0,1,2,12,16,20 are in melds.
  assert.equal(snap.cardsNotInMeld.includes(5), true);
  assert.equal(snap.cardsNotInMeld.includes(51), true);
  assert.equal(snap.cardsNotInMeld.includes(0), false);
});

test('cardsNotInMeld changes when the fixture hand changes (engine-driven, not hard-coded)', () => {
  const handA = new PhomOfflineSimulator({ events: [{ seq: 1, frame: [5, { cmd: 850, cs: [0, 1, 2, 12, 16, 20, 5, 51, 40], tP: { uid: OWNER } }] }], simulatedOwnerUid: OWNER, sourceKind: 'TEST_FIXTURE' }).end();
  // a hand with NO melds at all => every card is "not forming a phỏm".
  const handB = new PhomOfflineSimulator({ events: [{ seq: 1, frame: [5, { cmd: 850, cs: [0, 5, 10, 15, 20, 25, 30, 35, 40], tP: { uid: OWNER } }] }], simulatedOwnerUid: OWNER, sourceKind: 'TEST_FIXTURE' }).end();
  assert.notDeepEqual([...handA.cardsNotInMeld], [...handB.cardsNotInMeld]);
  assert.equal(handB.cardsNotInMeld.length, handB.hand.count, 'no melds => all cards loose');
  assert.equal(handB.derivedMelds.length, 0);
});

test('cardsNotInMeld is empty (UNKNOWN) when the hand is not authoritative', () => {
  // a public opponent discard with no DEAL/DRAW for the owner => not authoritative.
  const s = new PhomOfflineSimulator({ events: [{ seq: 1, frame: [5, { cmd: 851, fP: { uid: OPP, dCs: 24 }, tP: { uid: OWNER } }] }], simulatedOwnerUid: OWNER, sourceKind: 'REDACTED_REPLAY' });
  const snap = s.end();
  assert.equal(snap.authoritative, false);
  assert.deepEqual([...snap.cardsNotInMeld], []);
});

test('bundled sample datasets are all offline-allowed and replayable', () => {
  const list = listDatasets();
  assert.ok(list.length >= 1);
  for (const meta of list) {
    const ds = getDataset(meta.id);
    const s = new PhomOfflineSimulator({ events: ds.events, simulatedOwnerUid: ds.simulatedOwnerUid, sourceKind: ds.sourceKind });
    assert.equal(s.ok(), true, meta.id);
    const snap = s.end();
    assert.equal(snap.counters.currentEvent, ds.events.length);
    assert.equal(snap.networkLocked, true);
    assert.equal(snap.browserConnected, false);
  }
});
