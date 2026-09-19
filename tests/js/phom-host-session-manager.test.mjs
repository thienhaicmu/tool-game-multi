import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostSessionManager } = require('../../desktop/protocol/phom/host-session-manager.cjs');
const { buildJoinFrame, buildChannelListFrame } = require('../../desktop/protocol/phom/phom-coordinator.cjs');

function makeManager({ authorized = true } = {}) {
  const sends = [];
  const wsReplay = { sendProtocol: async (ctx, payload) => { sends.push({ ctx, payload }); return { ok: true }; } };
  const mgr = new HostSessionManager({
    wsReplay, authorized: () => authorized, featureEnabled: () => true,
    now: (() => { let t = 0; return () => (t += 1); })(),
    resolveProfileMeta: (runId) => ({ displayName: `Run ${runId}`, proxyRef: `proxy-${runId}`, uid: `1_${runId}` }),
  });
  return { mgr, sends };
}
const wsFrame = (runId, raw, seq) => ({ isWebSocket: true, wsDirection: 'recv', seq, targetId: `T-${runId}`, url: 'wss://x.hytsocesk.com/websocket', body: { raw } });
const channelRaw = (rid, b) => JSON.stringify([5, { rs: [{ rid, gid: 8, b, Mu: 4, uC: 0, zn: 'Simms' }] }]);
const channelsRaw = (rooms) => JSON.stringify([5, { rs: rooms.map(([rid, b, extra]) => ({ rid, gid: 8, b, Mu: 4, uC: 0, zn: 'Simms', ...(extra || {}) })) }]);
const tableRaw = (uids) => JSON.stringify([5, { b: 1000, ps: uids.map((uid, i) => ({ sit: i + 1, uid, r: false })) }]);

// §13/§25 — the stake dropdown is fed ONLY by an authoritative CHANNEL_LIST (rs[].b);
// there is no hard-coded fallback and no stale list. Until a real frame arrives the
// list is empty (UI shows loading + disabled confirm).
test('availableStakes is empty until a CHANNEL_LIST arrives, then distinct rs[].b', () => {
  const { mgr } = makeManager();
  assert.deepEqual(mgr.availableStakes(), [], 'no session -> empty');
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  assert.deepEqual(mgr.availableStakes(), [], 'no channel frame yet -> empty (loading)');
  // authoritative list with duplicate stake 1000 across two rooms + a 5000 room.
  mgr.routeFrame({ id: 'A' }, wsFrame('A', channelsRaw([[139, 1000], [140, 1000], [141, 5000]]), 1));
  assert.deepEqual(mgr.availableStakes(), [1000, 5000], 'distinct + sorted, no double-count, no hard-coded set');
});

test('availableStakes filters out other zone/game rooms', () => {
  const { mgr } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  const raw = JSON.stringify([5, { rs: [
    { rid: 1, gid: 8, b: 2000, zn: 'Simms' },      // ours
    { rid: 2, gid: 99, b: 3000, zn: 'Simms' },     // other game
    { rid: 3, gid: 8, b: 4000, zn: 'OtherZone' },  // other zone
  ] }]);
  mgr.routeFrame({ id: 'A' }, wsFrame('A', raw, 1));
  assert.deepEqual(mgr.availableStakes(), [2000], 'only our zone+game stakes surface');
});

test('requestChannels sends CMD 300 on each profile OWN socket once aid+socket known', async () => {
  const { mgr, sends } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  ['A', 'B', 'C'].forEach((id) => mgr.setIdentity(id, { aid: 'aid-' + id }));
  // bind each socket by observing one LOBBY frame per profile (requesting channels is a lobby action; a
  // lone-seat TABLE_STATE would make each profile SEATED, and seated browsers are never asked — §35)
  ['A', 'B', 'C'].forEach((id) => mgr.routeFrame({ id }, wsFrame(id, channelRaw(139, 1000), 1)));
  const res = await mgr.requestChannels();
  assert.equal(res.ok, true);
  for (const id of ['A', 'B', 'C']) {
    assert.ok(sends.some((x) => x.payload === buildChannelListFrame('aid-' + id) && x.ctx.targetId === `T-${id}`),
      `profile ${id} requested channels via its own socket`);
  }
});

// §35 — "tải lại mức cược" on ONE browser must not reach the others, and never a SEATED browser: PhomContext
// reads any CHANNEL_LIST as "back in the lobby", so asking a seated browser made it look like it left its table.
test('requestChannels can be scoped to ONE browser', async () => {
  const { mgr, sends } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  ['A', 'B', 'C'].forEach((id) => mgr.setIdentity(id, { aid: 'aid-' + id }));
  ['A', 'B', 'C'].forEach((id) => mgr.routeFrame({ id }, wsFrame(id, channelRaw(139, 1000), 1)));
  await mgr.requestChannels({ profileId: 'B' });
  const asked = sends.filter((x) => String(x.payload).includes('"cmd":300')).map((x) => x.ctx.targetId);
  assert.deepEqual(asked, ['T-B'], 'only the browser whose bets were reloaded');
});

test('requestChannels never asks a SEATED browser (its table state would be wiped)', async () => {
  const { mgr, sends } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  ['A', 'B', 'C'].forEach((id) => mgr.setIdentity(id, { aid: 'aid-' + id }));
  mgr.routeFrame({ id: 'A' }, wsFrame('A', tableRaw(['1_A']), 1));        // A is seated (own uid in ps[])
  ['B', 'C'].forEach((id) => mgr.routeFrame({ id }, wsFrame(id, channelRaw(139, 1000), 1)));
  const res = await mgr.requestChannels();
  const asked = sends.filter((x) => String(x.payload).includes('"cmd":300')).map((x) => x.ctx.targetId).sort();
  assert.deepEqual(asked, ['T-B', 'T-C'], 'the seated browser is skipped');
  const a = res.results.find((r) => r.id === 'A');
  assert.equal(a.skipped, true);
  assert.equal(a.reason, 'SEATED');
});

test('requestChannels reports typed not-ready when aid/socket missing (no throw, no fake success)', async () => {
  const { mgr } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  const res = await mgr.requestChannels();
  assert.equal(res.ok, false);
  assert.equal(res.results.length, 3);
  assert.ok(res.results.every((r) => r.ok === false && /PHOM_PROTOCOL_CONTEXT_MISSING|PHOM_SOCKET_NOT_FOUND/.test(r.error.code)));
});

test('unauthorized environment blocks requestChannels', async () => {
  const { mgr } = makeManager({ authorized: false });
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  ['A', 'B', 'C'].forEach((id) => mgr.setIdentity(id, { aid: 'aid-' + id }));
  ['A', 'B', 'C'].forEach((id) => mgr.routeFrame({ id }, wsFrame(id, tableRaw(['1_seed']), 1)));
  const res = await mgr.requestChannels();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_UNAUTHORIZED_ENVIRONMENT');
});

test('startSession requires 3 distinct runs and a valid host', () => {
  const { mgr } = makeManager();
  assert.equal(mgr.startSession({ runIds: ['A', 'B'], hostId: 'A' }).ok, false);
  assert.equal(mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'Z' }).ok, false);
  const ok = mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'B', selectedStake: 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.hostId, 'B');
});

test('host flow routes frames by run and drives host acquire -> follower join', async () => {
  const { mgr, sends } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A', selectedStake: 1000 });
  ['A', 'B', 'C'].forEach((id) => mgr.setIdentity(id, { aid: 'aid-' + id }));
  // host gets its channel list + binds its socket
  mgr.routeFrame({ id: 'A' }, wsFrame('A', channelRaw(139, 1000), 1));
  // followers bind sockets too (so their sends have a ctx)
  mgr.routeFrame({ id: 'B' }, wsFrame('B', tableRaw(['1_OLD']), 1));
  mgr.routeFrame({ id: 'C' }, wsFrame('C', tableRaw(['1_OLD']), 1));

  const acq = await mgr.acquireHost();
  assert.equal(acq.ok, true);
  assert.ok(sends.some((x) => x.payload === buildJoinFrame(139) && x.ctx.targetId === 'T-A'), 'host joined via its own socket');
  // confirm host seated
  mgr.routeFrame({ id: 'A' }, wsFrame('A', tableRaw(['1_A']), 2));
  const jf = await mgr.joinFollowers();
  assert.equal(jf.ok, true);
  // each follower joined via its OWN socket
  const joinTargets = sends.filter((x) => x.payload === buildJoinFrame(139)).map((x) => x.ctx.targetId).sort();
  assert.deepEqual([...new Set(joinTargets)], ['T-A', 'T-B', 'T-C']);
});

test('unauthorized environment blocks host acquisition', async () => {
  const { mgr } = makeManager({ authorized: false });
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A', selectedStake: 1000 });
  ['A', 'B', 'C'].forEach((id) => mgr.setIdentity(id, { aid: 'aid-' + id }));
  mgr.routeFrame({ id: 'A' }, wsFrame('A', channelRaw(139, 1000), 1));
  const res = await mgr.acquireHost();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_UNAUTHORIZED_ENVIRONMENT');
});

test('routeFrame ignores runs outside the session', () => {
  const { mgr } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A', selectedStake: 1000 });
  mgr.routeFrame({ id: 'Z' }, wsFrame('Z', tableRaw(['1_A', '1_B', '1_C']), 1));
  const snap = mgr.snapshot();
  assert.equal(snap.profiles.every((p) => p.playerCount === 0), true);
});
