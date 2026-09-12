import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostSessionManager } = require('../../desktop/protocol/phom/host-session-manager.cjs');
const { buildJoinFrame } = require('../../desktop/protocol/phom/phom-coordinator.cjs');

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
const tableRaw = (uids) => JSON.stringify([5, { b: 1000, ps: uids.map((uid, i) => ({ sit: i + 1, uid, r: false })) }]);

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
