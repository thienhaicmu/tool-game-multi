import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhomCoordinator, buildChannelListFrame, buildJoinFrame, buildReadyFrame } = require('../../desktop/protocol/phom/phom-coordinator.cjs');

// ---------------------------------------------------------------------------
// §23 MOCK END-TO-END PROOF — three fake BrowserRuns drive a full Phỏm QA
// session WITHOUT any live server. Each profile has its OWN proxy/uid/target and
// send seam; a fake server pushes frames back through coordinator.ingest().
// ---------------------------------------------------------------------------

const UID = { P1: '1_AAA111', P2: '1_BBB222', P3: '1_CCC333' };
const SET = [UID.P1, UID.P2, UID.P3];

test('§23 mock end-to-end: 3 profiles -> same table -> ready -> per-profile hands', async () => {
  // 1-2. Three fake runs, each with its own profile/proxy/uid/target + send seam.
  const sent = { P1: [], P2: [], P3: [] };
  const profiles = ['P1', 'P2', 'P3'].map((id, i) => ({
    id, displayName: `P${i + 1}`, proxyRef: `proxy-${id}`, uid: UID[id],
    send: async (payload) => { sent[id].push(payload); return { ok: true }; },
  }));
  let clock = 0;
  const coord = new PhomCoordinator({ profiles, environmentAuthorized: true, now: () => (clock += 1), joinWindowMs: 500, sessionId: 'PHOM-E2E' });

  const target = (id) => `T-${id}`;
  const url = 'wss://gw.hytsocesk.com/websocket';
  // fake server -> a specific profile's own socket
  const push = (id, obj, seq) => coord.ingest(id, { raw: JSON.stringify([5, obj]), direction: 'recv', seq, targetId: target(id), url });

  // Bind each socket + learn aid from the client's own channel-list echo path.
  for (const id of ['P1', 'P2', 'P3']) {
    coord.ingest(id, { raw: JSON.stringify([5, { rs: [{ rid: 139, rn: 'Phom#1', gid: 8, b: 1000, mM: 10000, Mu: 4, uC: 12, hpwd: false, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId: target(id), url });
    coord.setIdentity(id, { aid: `aid-${id}` });
  }

  // 3. Each profile has the channel list.
  const snap0 = coord.snapshot();
  assert.equal(snap0.profiles.every((p) => p.channels.length === 1), true);

  // 4. Coordinator selects the SAME channel code + requests channels (own seams).
  const chRes = await coord.requestChannels();
  assert.equal(chRes.ok, true);
  for (const id of ['P1', 'P2', 'P3']) assert.ok(sent[id].includes(buildChannelListFrame(`aid-${id}`)));
  coord.selectChannel(139);

  // 5. Three join frames dispatched through the correct sessions.
  const joinRes = await coord.joinTogether();
  assert.equal(joinRes.results.length, 3);
  for (const id of ['P1', 'P2', 'P3']) assert.ok(sent[id].includes(buildJoinFrame(139)));

  // 6. Fake server fills the table sequentially: all three land in the same player set.
  push('P1', { b: 1000, ps: SET.map((uid, i) => ({ sit: i + 1, dn: `n${i}`, uid, r: false })) }, 2);
  push('P2', { b: 1000, ps: SET.map((uid, i) => ({ sit: i + 1, dn: `n${i}`, uid, r: false })) }, 2);
  push('P3', { b: 1000, ps: SET.map((uid, i) => ({ sit: i + 1, dn: `n${i}`, uid, r: false })) }, 2);

  // 7. SAME_TABLE confirmed from authoritative table state.
  const verdict = coord.verifyTable();
  assert.equal(verdict.result, 'SAME_TABLE');
  assert.equal(coord.snapshot().sameTable, true);

  // 8. Ready all three, then server confirms 3/3.
  const readyRes = await coord.readyAll();
  assert.equal(readyRes.ok, true);
  for (const id of ['P1', 'P2', 'P3']) assert.ok(sent[id].includes(buildReadyFrame()));
  const readyAll = { [UID.P1]: true, [UID.P2]: true, [UID.P3]: true };
  push('P1', { b: 1000, ps: SET.map((uid, i) => ({ sit: i + 1, uid, r: readyAll[uid] })) }, 3);
  push('P2', { b: 1000, ps: SET.map((uid, i) => ({ sit: i + 1, uid, r: readyAll[uid] })) }, 3);
  push('P3', { b: 1000, ps: SET.map((uid, i) => ({ sit: i + 1, uid, r: readyAll[uid] })) }, 3);
  assert.equal(coord.snapshot().readyCount, 3);

  // 9. Fake server deals three DIFFERENT hands (each to its own session).
  push('P1', { cs: [40, 44, 48, 3, 2, 6, 8, 27, 42], cmd: 850, tP: { uid: UID.P1 } }, 4);
  push('P2', { cs: [0, 1, 2, 4, 5, 9, 13, 17, 21], cmd: 850, tP: { uid: UID.P1 } }, 4);
  push('P3', { cs: [7, 11, 19, 23, 29, 33, 37, 41, 45], cmd: 850, tP: { uid: UID.P1 } }, 4);

  // 10. UI hands snapshot shows three rows, each owned by the right profile.
  let hands = coord.handsSnapshot();
  assert.equal(hands.length, 3);
  const byId = Object.fromEntries(hands.map((h) => [h.profileId, h]));
  assert.equal(byId.P1.cardCount, 9);
  assert.equal(byId.P1.decoded[0].label, 'J♠');
  assert.equal(byId.P2.decoded[0].label, 'A♠');
  assert.notDeepEqual(byId.P1.cards, byId.P2.cards);
  assert.notDeepEqual(byId.P2.cards, byId.P3.cards);

  // 11-12. DRAW for P2 only -> only P2 changes.
  const p1Before = byId.P1.cards.slice();
  const p3Before = byId.P3.cards.slice();
  push('P2', { cs: 20, uid: UID.P2, sAC: [0, 1, 2, 4, 5, 9, 13, 17, 21, 20], sMs: [0, 1, 2], cmd: 852 }, 5);
  hands = coord.handsSnapshot();
  const b2 = Object.fromEntries(hands.map((h) => [h.profileId, h]));
  assert.equal(b2.P2.cardCount, 10);
  assert.deepEqual(b2.P2.serverMelds, [0, 1, 2]);
  assert.deepEqual(b2.P1.cards, p1Before); // unchanged
  assert.deepEqual(b2.P3.cards, p3Before); // unchanged

  // 13-14. P2 discards -> public discard + turn move to P3, P2 hand shrinks by one.
  push('P2', { fP: { uid: UID.P2, dCs: 20 }, cmd: 851, tP: { uid: UID.P3 } }, 6);
  // the public discard/turn is visible to all seated profiles too
  push('P1', { fP: { uid: UID.P2, dCs: 20 }, cmd: 851, tP: { uid: UID.P3 } }, 6);
  hands = coord.handsSnapshot();
  const b3 = Object.fromEntries(hands.map((h) => [h.profileId, h]));
  assert.equal(b3.P2.cardCount, 9);
  assert.equal(b3.P2.lastDiscarded, 20);
  assert.equal(b3.P1.currentTurnUid, b3.P2.currentTurnUid); // both saw turn -> P3

  // 15-16. P2 lays a public meld.
  push('P2', { uid: UID.P2, mes: [{ meid: 1, cs: [0, 1, 2] }], cmd: 854 }, 7);
  hands = coord.handsSnapshot();
  const b4 = Object.fromEntries(hands.map((h) => [h.profileId, h]));
  assert.equal(b4.P2.publicMelds.length, 1);
  assert.deepEqual(b4.P2.publicMelds[0].cards, [0, 1, 2]);

  // 17-18. Round ends.
  push('P1', { uid: UID.P1, sAC: [40, 44, 48, 3, 2, 6, 8, 27, 42], sMs: [], fP: { uid: UID.P1, lm: -30 }, cmd: 853 }, 8);
  push('P2', { uid: UID.P2, sAC: [1, 5, 9, 13, 17, 21, 4, 0, 2], sMs: [0, 1, 2], fP: { uid: UID.P2, lm: 60 }, cmd: 853 }, 8);
  push('P3', { uid: UID.P3, sAC: [7, 11, 19, 23, 29, 33, 37, 41, 45], sMs: [], fP: { uid: UID.P3, lm: -30 }, cmd: 853 }, 8);
  hands = coord.handsSnapshot();
  const b5 = Object.fromEntries(hands.map((h) => [h.profileId, h]));
  assert.equal(b5.P1.syncState, 'ENDED');
  assert.equal(b5.P2.resultDelta, 60);
  assert.equal(coord.state(), 'ROUND_ENDED');

  // 19. No credentials in the evidence snapshot (no dn / no proxy password anywhere).
  const evidence = JSON.stringify(coord.snapshot());
  assert.equal(/"dn"/.test(evidence), false, 'display names must not leak into snapshot');
  assert.equal(/password/i.test(evidence), false, 'no password field in snapshot');
});
