import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostTableCoordinator, SESSION, PSTATE } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { buildJoinFrame, buildReadyFrame } = require('../../desktop/protocol/phom/phom-wire.cjs');

// §3/§23 — the SAME role model must work for HOST=A, HOST=B and HOST=C. Nothing may be
// hard-coded to slot A being HOST or slot C being the waiting follower. Follower order is
// deterministic by slot order (A -> B -> C) after removing the HOST.
const UID = { A: '1_AAA', B: '1_BBB', C: '1_CCC', D: '1_DDD' };
const EXPECTED_FOLLOWERS = { A: ['B', 'C'], B: ['A', 'C'], C: ['A', 'B'] };

function makeSession(host) {
  const sent = { A: [], B: [], C: [] };
  const profiles = ['A', 'B', 'C'].map((id) => ({ id, displayName: 'P' + id, proxyRef: 'px-' + id, uid: UID[id], send: async (payload) => { sent[id].push(payload); return { ok: true }; } }));
  let t = 1000;
  const coord = new HostTableCoordinator({ profiles, hostId: host, selectedStake: 1000, environmentAuthorized: true, now: () => (t += 1), maxRejoinAttempts: 2, rejoinCooldownMs: 0, kickDebounce: 2 });
  ['A', 'B', 'C'].forEach((id) => coord.setIdentity(id, { aid: 'aid-' + id }));
  const channelList = (id, rid = 139, b = 1000, uC = 0) => coord.ingest(id, { raw: JSON.stringify([5, { rs: [{ rid, rn: 'Phom#1', gid: 8, b, mM: 10000, Mu: 4, uC, hpwd: false, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId: 'T-' + id, url: 'wss://x.hytsocesk.com/websocket' });
  const table = (id, uids, seq, opts = {}) => coord.ingest(id, { raw: JSON.stringify([5, { b: 1000, ps: uids.map((uid, i) => ({ sit: i + 1, uid, r: opts.ready ? !!opts.ready[uid] : false })) }]), direction: 'recv', seq, targetId: 'T-' + id, url: 'wss://x.hytsocesk.com/websocket' });
  return { coord, sent, channelList, table };
}

for (const host of ['A', 'B', 'C']) {
  const [f1, f2] = EXPECTED_FOLLOWERS[host];
  const allIds = ['A', 'B', 'C'];
  const allUids = allIds.map((id) => UID[id]);

  test(`HOST=${host}: roles resolve dynamically (host=${host}, follower1=${f1}, follower2=${f2})`, async () => {
    const { coord, sent, channelList, table } = makeSession(host);
    channelList(host, 139, 1000);
    const acq = await coord.acquireHost();
    assert.equal(acq.ok, true);
    // ONLY the host searched/joined; followers silent.
    assert.ok(sent[host].includes(buildJoinFrame(139)), `${host} joined`);
    assert.equal(sent[f1].length + sent[f2].length, 0, 'followers do not join during host search');
    table(host, [UID[host]], 2); // server seats host alone
    assert.equal(coord.state(), SESSION.HOST_ACQUIRED);
    const id = coord.hostTableIdentity();
    assert.equal(id.hostUid, UID[host]);
    assert.equal(id.channelRid, 139);
    // follower order is deterministic by slot after removing the host.
    const rp0 = coord.readyPolicy();
    const followerIds = [...rp0.desired.keys()].filter((k) => k !== host);
    assert.deepEqual(followerIds, [f1, f2], `follower order for HOST=${host}`);
  });

  test(`HOST=${host}: followers join the host rid => SAME_TABLE`, async () => {
    const { coord, sent, channelList, table } = makeSession(host);
    channelList(host, 139, 1000); await coord.acquireHost(); table(host, [UID[host]], 2);
    const jf = await coord.joinFollowers();
    assert.equal(jf.ok, true);
    for (const fid of [f1, f2]) assert.ok(sent[fid].includes(buildJoinFrame(139)), `${fid} joined host rid`);
    for (const id of allIds) table(id, allUids, 3);
    assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
  });

  test(`HOST=${host}: 3 controlled => host + follower1 READY, follower2 WAITING`, async () => {
    const { coord, sent, channelList, table } = makeSession(host);
    channelList(host, 139, 1000); await coord.acquireHost(); table(host, [UID[host]], 2);
    await coord.joinFollowers();
    for (const id of allIds) table(id, allUids, 3);
    const rp = coord.readyPolicy();
    assert.equal(rp.desired.get(host), true, 'host ready');
    assert.equal(rp.desired.get(f1), true, 'follower1 ready');
    assert.equal(rp.desired.get(f2), false, 'follower2 waits for the 4th');
    await coord.applyReady();
    assert.ok(sent[host].includes(buildReadyFrame()));
    assert.ok(sent[f1].includes(buildReadyFrame()));
    assert.equal(sent[f2].includes(buildReadyFrame()), false, 'follower2 not readied');
  });

  test(`HOST=${host}: 4 players => all three controlled READY; 4th leaving reconciles`, async () => {
    const { coord, sent, channelList, table } = makeSession(host);
    channelList(host, 139, 1000); await coord.acquireHost(); table(host, [UID[host]], 2);
    await coord.joinFollowers();
    const four = [...allUids, UID.D];
    for (const id of allIds) table(id, four, 3);
    assert.equal(coord.readyPolicy().desired.get(f2), true, 'follower2 ready with a 4th present');
    await coord.applyReady();
    assert.ok(sent[f2].includes(buildReadyFrame()));
    const f2SentBefore = sent[f2].length;
    // 4th leaves before round start -> follower2 reconciles back to not-desired-ready.
    for (const id of allIds) table(id, allUids, 4);
    assert.equal(coord.readyPolicy().desired.get(f2), false, 'follower2 reconciled to waiting');
    // §14 — reconcile is a passive typed-state change: NO fabricated unset-ready frame,
    // no raw payload is sent (there is no unready frame in the protocol we proved).
    assert.equal(sent[f2].length, f2SentBefore, 'no frame sent to follower2 on reconcile');
  });

  test(`HOST=${host}: follower1 kicked => ONLY follower1 rejoins; host + follower2 untouched`, async () => {
    const { coord, sent, channelList, table } = makeSession(host);
    channelList(host, 139, 1000); await coord.acquireHost(); table(host, [UID[host]], 2);
    await coord.joinFollowers();
    for (const id of allIds) table(id, allUids, 3);
    const hostJoins = sent[host].filter((x) => x === buildJoinFrame(139)).length;
    const f2Joins = sent[f2].filter((x) => x === buildJoinFrame(139)).length;
    // host sees follower1 vanish across the debounce window.
    const without = allUids.filter((u) => u !== UID[f1]);
    table(host, without, 4); table(host, without, 5);
    assert.equal(coord.snapshot().profiles.find((p) => p.id === f1).state, PSTATE.KICKED);
    const rj = await coord.rejoinFollower(f1);
    assert.equal(rj.ok, true);
    // host + follower2 were never re-joined.
    assert.equal(sent[host].filter((x) => x === buildJoinFrame(139)).length, hostJoins);
    assert.equal(sent[f2].filter((x) => x === buildJoinFrame(139)).length, f2Joins);
  });

  test(`HOST=${host}: host loss stops orchestration (no follower promotion)`, async () => {
    const { coord, channelList, table } = makeSession(host);
    channelList(host, 139, 1000); await coord.acquireHost(); table(host, [UID[host]], 2);
    await coord.joinFollowers();
    for (const id of allIds) table(id, allUids, 3);
    // host uid disappears from the host's own authoritative view.
    const withoutHost = allUids.filter((u) => u !== UID[host]);
    table(host, withoutHost, 4); table(host, withoutHost, 5);
    const snap = coord.snapshot();
    // the HOST is still the same profile — never promoted to a follower.
    assert.equal(snap.profiles.find((p) => p.id === host).role, 'HOST');
    for (const fid of [f1, f2]) assert.equal(snap.profiles.find((p) => p.id === fid).role, 'FOLLOWER');
    assert.ok([SESSION.HOST_LOST, SESSION.HOST_TABLE_LOST].includes(coord.state()), `host loss state, got ${coord.state()}`);
  });
}
