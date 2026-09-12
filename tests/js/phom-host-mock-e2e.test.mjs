import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostTableCoordinator, SESSION, PSTATE } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { buildJoinFrame, buildReadyFrame } = require('../../desktop/protocol/phom/phom-coordinator.cjs');
const { resolveDevBypass } = require('../../desktop/licensing/dev-bypass.cjs');
const { createLicenseLedger, SYNC } = require('../../desktop/licensing/license-ledger.cjs');

const UID = { A: '1_HOSTA', B: '1_FOLB', C: '1_FOLC', D: '1_PLYD' };

// §27 full mock proof — three fake BrowserRuns, dev bypass, ledger NOT_CONFIGURED,
// HOST acquires an empty table, followers join, ready policy, 4th joins, kick+rejoin,
// gameplay routing — all WITHOUT any live network / credentials / gameplay actions.
test('§27 HOST/FOLLOWER controlled-table mock end-to-end', async () => {
  // 4. license development bypass (explicit, dev context only)
  const bypass = resolveDevBypass({ isPackaged: false, env: { PHOM_DEV_LICENSE_BYPASS: '1', NODE_ENV: 'development' } });
  assert.equal(bypass.allowed, true);
  // 5. Google ledger NOT_CONFIGURED (no network)
  const ledger = createLicenseLedger({ env: {}, clientFactory: null });
  assert.equal((await ledger.healthCheck()).status, SYNC.NOT_CONFIGURED);

  // 1-3. three fake runs, each own profile + proxy + uid + send seam
  const sent = { A: [], B: [], C: [] };
  const profiles = ['A', 'B', 'C'].map((id) => ({ id, displayName: 'P' + id, proxyRef: 'proxy-' + id, uid: UID[id], send: async (p) => { sent[id].push(p); return { ok: true }; } }));
  let clock = 0;
  const coord = new HostTableCoordinator({ profiles, environmentAuthorized: true, now: () => (clock += 1), maxRejoinAttempts: 3, rejoinCooldownMs: 0, kickDebounce: 2, sessionId: 'PHOM-HOST-E2E' });
  ['A', 'B', 'C'].forEach((id) => coord.setIdentity(id, { aid: 'aid-' + id }));
  const url = 'wss://gw.hytsocesk.com/websocket';
  const push = (id, obj, seq) => coord.ingest(id, { raw: JSON.stringify([5, obj]), direction: 'recv', seq, targetId: 'T-' + id, url });
  const table = (id, uids, seq, ready) => push(id, { b: 1000, ps: uids.map((u, i) => ({ sit: i + 1, uid: u, r: ready ? !!ready[u] : false })) }, seq);

  // 6-7. choose A as HOST, stake 1000
  coord.setHost('A');
  coord.selectStake(1000);

  // 8. host receives the channel list
  push('A', { rs: [{ rid: 141, rn: 'Phom#2', gid: 8, b: 1000, mM: 10000, Mu: 4, uC: 0, hpwd: false, zn: 'Simms' }] }, 1);

  // 9-10. HOST finds an (empty) stake table and joins; followers do NOT join yet
  const acq = await coord.acquireHost();
  assert.equal(acq.ok, true);
  assert.ok(sent.A.includes(buildJoinFrame(141)));
  assert.equal(sent.B.length, 0);
  assert.equal(sent.C.length, 0);

  // 11-12. server confirms ps[] contains only A -> HostTableIdentity
  table('A', [UID.A], 2);
  assert.equal(coord.state(), SESSION.HOST_ACQUIRED);
  assert.equal(coord.hostTableIdentity().hostUid, UID.A);

  // 13-14. B/C leave old table + join A's table
  const jf = await coord.joinFollowers();
  assert.equal(jf.ok, true);
  assert.ok(sent.B.includes(buildJoinFrame(141)) && sent.C.includes(buildJoinFrame(141)));

  // 15-16. three states each contain A/B/C -> SAME_TABLE
  const three = [UID.A, UID.B, UID.C];
  table('A', three, 3); table('B', three, 3); table('C', three, 3);
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');

  // 17-19. A ready, B ready, C NOT ready (waiting for the 4th)
  const ready1 = await coord.applyReady();
  assert.equal(ready1.ok, true);
  assert.ok(sent.A.includes(buildReadyFrame()) && sent.B.includes(buildReadyFrame()));
  assert.equal(sent.C.includes(buildReadyFrame()), false);
  const rmap3 = { [UID.A]: true, [UID.B]: true, [UID.C]: false };
  table('A', three, 4, rmap3); table('B', three, 4, rmap3); table('C', three, 4, rmap3);
  assert.equal(coord.snapshot().controlledReadyCount, 2);

  // 20-23. authorized 4th (D) joins -> player count 4 -> C readies -> 3/3 controlled ready
  const four = [UID.A, UID.B, UID.C, UID.D];
  table('A', four, 5); table('B', four, 5); table('C', four, 5);
  assert.equal(coord.readyPolicy().desired.get('C'), true);
  await coord.applyReady();
  assert.ok(sent.C.includes(buildReadyFrame()));
  const rmap4 = { [UID.A]: true, [UID.B]: true, [UID.C]: true, [UID.D]: false };
  table('A', four, 6, rmap4); table('B', four, 6, rmap4); table('C', four, 6, rmap4);
  assert.equal(coord.snapshot().controlledReadyCount, 3);

  // 24. cmd 850 deals three independent hands (own sessions)
  push('A', { cs: [40, 44, 48, 3, 2, 6, 8, 27, 42], cmd: 850, tP: { uid: UID.A } }, 7);
  push('B', { cs: [0, 1, 2, 4, 5, 9, 13, 17, 21], cmd: 850, tP: { uid: UID.A } }, 7);
  push('C', { cs: [7, 11, 19, 23, 29, 33, 37, 41, 45], cmd: 850, tP: { uid: UID.A } }, 7);
  let hands = Object.fromEntries(coord.handsSnapshot().map((h) => [h.profileId, h]));
  assert.equal(hands.A.decoded[0].label, 'J♠');
  assert.notDeepEqual(hands.A.cards, hands.B.cards);

  // 29. gameplay frames route to the right profile (round is running)
  push('B', { cs: 20, uid: UID.B, sAC: [0, 1, 2, 4, 5, 9, 13, 17, 21, 20], sMs: [0, 1, 2], cmd: 852 }, 8);
  hands = Object.fromEntries(coord.handsSnapshot().map((h) => [h.profileId, h]));
  assert.equal(hands.B.cardCount, 10);
  assert.equal(hands.A.cardCount, 9); // unchanged
  // round ends so a rejoin is not deferred
  push('A', { uid: UID.A, sAC: [40, 44, 48, 3, 2, 6, 8, 27, 42], sMs: [], fP: { uid: UID.A, lm: -30 }, cmd: 853 }, 9);
  push('B', { uid: UID.B, sAC: [0, 1, 2, 4, 5, 9, 13, 17, 20], sMs: [], fP: { uid: UID.B, lm: 60 }, cmd: 853 }, 9);
  push('C', { uid: UID.C, sAC: [7, 11, 19, 23, 29, 33, 37, 41, 45], sMs: [], fP: { uid: UID.C, lm: -30 }, cmd: 853 }, 9);

  // 25-27. B gets kicked (uid vanishes from host authoritative view, debounced) -> only B rejoins
  const kicked = [UID.A, UID.C, UID.D];
  table('A', kicked, 10); table('A', kicked, 11);
  assert.equal(coord.snapshot().profiles.find((p) => p.id === 'B').state, PSTATE.KICKED);
  const beforeA = sent.A.length, beforeC = sent.C.length;
  const rj = await coord.rejoinFollower('B');
  assert.equal(rj.ok, true);
  assert.ok(sent.B.includes(buildJoinFrame(141)));
  assert.equal(sent.A.length, beforeA, 'HOST not touched by follower rejoin');
  assert.equal(sent.C.length, beforeC, 'other follower not touched');

  // 28. B returns and ready policy is restorable
  table('A', four, 12); table('B', four, 12); table('C', four, 12);
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');

  // 30-32. no credentials / no live network / no gameplay actions in the evidence
  const evidence = JSON.stringify(coord.snapshot());
  assert.equal(/proxy-[ABC]/.test(evidence), true); // proxyRef present (reference only)
  assert.equal(/password|"dn"|BEGIN|credential/i.test(evidence), false);
});

// §19/§27 — HOST kicked: HOST_LOST, no follower promotion, HOST_TABLE_LOST if unrecoverable.
test('§27 HOST kick scenario: HOST_LOST, no promotion', async () => {
  const sent = { A: [], B: [], C: [] };
  const profiles = ['A', 'B', 'C'].map((id) => ({ id, displayName: 'P' + id, uid: UID[id], send: async (p) => { sent[id].push(p); return { ok: true }; } }));
  let clock = 0;
  const coord = new HostTableCoordinator({ profiles, hostId: 'A', selectedStake: 1000, environmentAuthorized: true, now: () => (clock += 1), kickDebounce: 2 });
  ['A', 'B', 'C'].forEach((id) => coord.setIdentity(id, { aid: 'aid-' + id }));
  const url = 'wss://x/y';
  const table = (id, uids, seq) => coord.ingest(id, { raw: JSON.stringify([5, { b: 1000, ps: uids.map((u, i) => ({ sit: i + 1, uid: u, r: false })) }]), direction: 'recv', seq, targetId: 'T-' + id, url });
  coord.ingest('A', { raw: JSON.stringify([5, { rs: [{ rid: 141, gid: 8, b: 1000, Mu: 4, uC: 0, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId: 'T-A', url });
  await coord.acquireHost();
  table('A', [UID.A], 2);
  await coord.joinFollowers();
  const three = [UID.A, UID.B, UID.C];
  table('A', three, 3); table('B', three, 3); table('C', three, 3);
  // host vanishes from its OWN authoritative view twice -> HOST_LOST
  table('A', [UID.B, UID.C], 4); table('A', [UID.B, UID.C], 5);
  assert.equal(coord.state(), SESSION.HOST_LOST);
  assert.equal(coord.snapshot().hostId, 'A', 'host role never reassigned to a follower');
  // recover targets the SAME rid (never a different table)
  const rec = await coord.recoverHost();
  assert.ok(sent.A.filter((f) => f === buildJoinFrame(141)).length >= 2);
});
