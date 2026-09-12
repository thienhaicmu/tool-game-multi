import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostTableCoordinator, SESSION, ROLE, PSTATE } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { buildJoinFrame, buildReadyFrame, buildChannelListFrame } = require('../../desktop/protocol/phom/phom-coordinator.cjs');

const UID = { A: '1_AAA', B: '1_BBB', C: '1_CCC', D: '1_DDD' };

function makeSession(opts = {}) {
  const sent = { A: [], B: [], C: [] };
  const profiles = ['A', 'B', 'C'].map((id) => ({ id, displayName: 'P' + id, proxyRef: 'px-' + id, uid: UID[id], send: async (payload) => { sent[id].push(payload); return { ok: true }; } }));
  let t = 1000;
  const coord = new HostTableCoordinator({ profiles, hostId: opts.host || 'A', selectedStake: 1000, environmentAuthorized: opts.authorized !== false, now: () => (t += 1), maxRejoinAttempts: 2, rejoinCooldownMs: 0, kickDebounce: 2 });
  // aid is learned from observed frames at runtime; inject it for the mock.
  ['A', 'B', 'C'].forEach((id) => coord.setIdentity(id, { aid: 'aid-' + id }));
  const channelList = (id, rid = 139, b = 1000, uC = 0) => coord.ingest(id, { raw: JSON.stringify([5, { rs: [{ rid, rn: 'Phom#1', gid: 8, b, mM: 10000, Mu: 4, uC, hpwd: false, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId: 'T-' + id, url: 'wss://x.hytsocesk.com/websocket' });
  const table = (id, uids, seq, opts2 = {}) => coord.ingest(id, { raw: JSON.stringify([5, { b: opts2.b != null ? opts2.b : 1000, ps: uids.map((uid, i) => ({ sit: i + 1, uid, r: opts2.ready ? !!opts2.ready[uid] : false })) }]), direction: 'recv', seq, targetId: 'T-' + id, url: 'wss://x.hytsocesk.com/websocket' });
  return { coord, sent, channelList, table };
}

// §12/§13 — only HOST searches; empty table (ps[] with host only) => HOST_ACQUIRED.
test('HOST acquires an empty table at the selected stake; followers do NOT join yet', async () => {
  const { coord, sent, channelList } = makeSession();
  channelList('A', 139, 1000);
  const res = await coord.acquireHost();
  assert.equal(res.ok, true);
  assert.equal(res.candidate.rid, 139);
  assert.ok(sent.A.includes(buildChannelListFrame('aid-A')), 'host requested the channel list');
  assert.ok(sent.A.includes(buildJoinFrame(139)), 'host joined the stake channel');
  assert.equal(sent.B.length, 0, 'followers must not join during host search');
  assert.equal(sent.C.length, 0);
});

// §12 — no channel for stake => PHOM_NO_TABLE_FOR_SELECTED_STAKE, no fallback.
test('no table for selected stake fails typed (no fallback stake)', async () => {
  const { coord, channelList } = makeSession();
  channelList('A', 139, 5000); // only a 5000 table, but we want 1000
  const res = await coord.acquireHost();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_NO_TABLE_FOR_SELECTED_STAKE');
});

// §12 — HOST_ACQUIRED only after authoritative table state contains hostUid.
test('HOST_ACQUIRED requires authoritative state (not join-sent)', async () => {
  const { coord, channelList, table } = makeSession();
  channelList('A', 139, 1000);
  await coord.acquireHost();
  assert.notEqual(coord.state(), SESSION.HOST_ACQUIRED); // only join sent so far
  table('A', [UID.A], 2); // server seats host alone
  assert.equal(coord.state(), SESSION.HOST_ACQUIRED);
  const identity = coord.hostTableIdentity();
  assert.equal(identity.hostUid, UID.A);
  assert.equal(identity.channelRid, 139);
  assert.equal(identity.selectedStake, 1000);
});

// §14/§15 — followers leave + join host table; SAME_TABLE from authoritative state.
test('followers join host table => SAME_TABLE', async () => {
  const { coord, sent, channelList, table } = makeSession();
  channelList('A', 139, 1000);
  await coord.acquireHost();
  table('A', [UID.A], 2);
  const jf = await coord.joinFollowers();
  assert.equal(jf.ok, true);
  for (const id of ['B', 'C']) assert.ok(sent[id].includes(buildJoinFrame(139)), id + ' joined host rid');
  // server now shows all three at the table (each session's own view)
  const all = [UID.A, UID.B, UID.C];
  table('A', all, 3); table('B', all, 3); table('C', all, 3);
  const v = coord.verifySameTable();
  assert.equal(v.result, 'SAME_TABLE');
  assert.equal(coord.snapshot().sameTable, true);
});

// §14 — a follower landing on a table WITHOUT hostUid is TABLE_MISMATCH (only it rejoins).
test('follower on wrong table => TABLE_MISMATCH', async () => {
  const { coord, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const all = [UID.A, UID.B, UID.C];
  table('A', all, 3); table('B', all, 3);
  table('C', [UID.C, '1_X', '1_Y'], 3); // C on a different table (no host)
  assert.equal(coord.verifySameTable().result, 'TABLE_MISMATCH');
});

// §16 — ready policy: 3 controlled => host + follower1 READY, follower2 NOT ready.
test('ready policy: 3 controlled => host + follower1 ready, follower2 not ready', async () => {
  const { coord, sent, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const all = [UID.A, UID.B, UID.C];
  table('A', all, 3); table('B', all, 3); table('C', all, 3);
  const rp = coord.readyPolicy();
  assert.equal(rp.desired.get('A'), true);   // host
  assert.equal(rp.desired.get('B'), true);   // follower1
  assert.equal(rp.desired.get('C'), false);  // follower2 waits for the 4th
  const res = await coord.applyReady();
  assert.equal(res.ok, true);
  assert.ok(sent.A.includes(buildReadyFrame()));
  assert.ok(sent.B.includes(buildReadyFrame()));
  assert.equal(sent.C.includes(buildReadyFrame()), false, 'follower2 must not be readied');
});

// §16 — with an authorized 4th present, all three controlled become ready.
test('ready policy: 4 players => all three controlled ready', async () => {
  const { coord, sent, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const four = [UID.A, UID.B, UID.C, UID.D];
  table('A', four, 3); table('B', four, 3); table('C', four, 3);
  const rp = coord.readyPolicy();
  assert.equal(rp.desired.get('C'), true, 'follower2 now ready with a 4th present');
  const res = await coord.applyReady();
  assert.equal(res.ok, true);
  assert.ok(sent.C.includes(buildReadyFrame()));
});

// §16 — never report ready-on-send: readyCount comes from ps[].r.
test('ready count comes from authoritative ps[].r, not on-send', async () => {
  const { coord, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const four = [UID.A, UID.B, UID.C, UID.D];
  table('A', four, 3); table('B', four, 3); table('C', four, 3);
  await coord.applyReady();
  assert.equal(coord.snapshot().readyCount, 0, 'no ready confirmed by server yet');
  const readyMap = { [UID.A]: true, [UID.B]: true, [UID.C]: false, [UID.D]: false };
  table('A', four, 4, { ready: readyMap }); table('B', four, 4, { ready: readyMap }); table('C', four, 4, { ready: readyMap });
  assert.equal(coord.snapshot().readyCount, 2);
});

// §17/§18 — follower kicked (uid disappears) => only it rejoins; host untouched.
test('follower kick detected (debounced) => targeted rejoin; host not touched', async () => {
  const { coord, sent, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const all = [UID.A, UID.B, UID.C];
  table('A', all, 3); table('B', all, 3); table('C', all, 3);
  const sentBBefore = sent.B.length;
  // host now sees B gone across two authoritative updates (debounce=2)
  table('A', [UID.A, UID.C], 4);
  table('A', [UID.A, UID.C], 5);
  assert.equal(coord.snapshot().profiles.find((p) => p.id === 'B').state, PSTATE.KICKED);
  const rj = await coord.rejoinFollower('B');
  assert.equal(rj.ok, true);
  assert.ok(sent.B.length > sentBBefore, 'B rejoined');
  // host + follower C were never asked to leave/join again
  assert.equal(sent.A.filter((f) => f === buildJoinFrame(139)).length, 1);
  assert.equal(sent.C.filter((f) => f === buildJoinFrame(139)).length, 1);
});

// §18 — rejoin bounded then exhausted.
test('follower rejoin is bounded (maxRejoinAttempts) then exhausted', async () => {
  const { coord, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const all = [UID.A, UID.B, UID.C];
  table('A', all, 3); table('B', all, 3); table('C', all, 3);
  const kick = () => { table('A', [UID.A, UID.C], coord._now ? undefined : undefined); };
  // force kicked state
  table('A', [UID.A, UID.C], 4); table('A', [UID.A, UID.C], 5);
  await coord.rejoinFollower('B'); // attempt 1
  coord._profiles.get('B').state = PSTATE.KICKED; // simulate kicked again
  await coord.rejoinFollower('B'); // attempt 2 (max=2)
  coord._profiles.get('B').state = PSTATE.KICKED;
  const r3 = await coord.rejoinFollower('B');
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, 'PHOM_REJOIN_EXHAUSTED');
});

// §18 — rejoin deferred while a round is running.
test('rejoin deferred during an active round', async () => {
  const { coord, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const all = [UID.A, UID.B, UID.C];
  table('A', all, 3); table('B', all, 3); table('C', all, 3);
  table('A', [UID.A, UID.C], 4); table('A', [UID.A, UID.C], 5);
  // a round starts
  coord.ingest('A', { raw: JSON.stringify([5, { cs: [0, 1, 2, 3, 4, 5, 6, 7, 8], cmd: 850, tP: { uid: UID.A } }]), direction: 'recv', seq: 6, targetId: 'T-A', url: 'wss://x/y' });
  const r = await coord.rejoinFollower('B');
  assert.equal(r.error.code, 'REJOIN_DEFERRED_ROUND_ACTIVE');
});

// §19 — HOST kicked => HOST_LOST; no follower promotion; recover targets the same table.
test('host kick => HOST_LOST, no follower promotion', async () => {
  const { coord, sent, channelList, table } = makeSession();
  channelList('A', 139, 1000); await coord.acquireHost(); table('A', [UID.A], 2);
  await coord.joinFollowers();
  const all = [UID.A, UID.B, UID.C];
  table('A', all, 3); table('B', all, 3); table('C', all, 3);
  // host disappears from its own authoritative view twice
  table('A', [UID.B, UID.C], 4); table('A', [UID.B, UID.C], 5);
  assert.equal(coord.state(), SESSION.HOST_LOST);
  // no follower got promoted to host
  assert.equal(coord.snapshot().hostId, 'A');
  const rec = await coord.recoverHost();
  assert.ok(sent.A.filter((f) => f === buildJoinFrame(139)).length >= 2, 'host rejoined same rid');
});

// §19 — unauthorized environment blocks active orchestration.
test('unauthorized environment blocks acquireHost', async () => {
  const { coord, channelList } = makeSession({ authorized: false });
  channelList('A', 139, 1000);
  const res = await coord.acquireHost();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_UNAUTHORIZED_ENVIRONMENT');
});
