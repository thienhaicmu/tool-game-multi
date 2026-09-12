import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhomSessionManager } = require('../../desktop/protocol/phom/phom-session-manager.cjs');
const { buildJoinFrame } = require('../../desktop/protocol/phom/phom-coordinator.cjs');

function makeManager({ authorized = true } = {}) {
  const sends = []; // { ctx, payload }
  const wsReplay = { sendProtocol: async (ctx, payload) => { sends.push({ ctx, payload }); return { ok: true }; } };
  const mgr = new PhomSessionManager({
    wsReplay,
    authorized: () => authorized,
    featureEnabled: () => true,
    now: (() => { let t = 0; return () => (t += 1); })(),
    resolveProfileMeta: (runId) => ({ displayName: `Run ${runId}`, proxyRef: `proxy-${runId}`, uid: `1_${runId}` }),
  });
  return { mgr, sends };
}

const wsFrame = (runId, raw, seq) => ({ id: `${runId}#${seq}`, isWebSocket: true, wsDirection: 'recv', seq, targetId: `T-${runId}`, cdpSessionId: null, url: 'wss://x.hytsocesk.com/websocket', body: { raw } });
const tableRaw = (uids) => JSON.stringify([5, { b: 1000, ps: uids.map((uid, i) => ({ sit: i + 1, uid, r: false })) }]);

test('startSession requires exactly three distinct runs', () => {
  const { mgr } = makeManager();
  assert.equal(mgr.startSession({ runIds: ['A', 'B'] }).ok, false);
  assert.equal(mgr.startSession({ runIds: ['A', 'A', 'B'] }).ok, false);
  assert.equal(mgr.startSession({ runIds: ['A', 'B', 'C'] }).ok, true);
  assert.deepEqual(mgr.activeRunIds().sort(), ['A', 'B', 'C']);
});

test('routeFrame maps run -> profile and never leaks to a non-session run', () => {
  const { mgr } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'] });
  const all = ['1_A', '1_B', '1_C'];
  mgr.routeFrame({ id: 'A' }, wsFrame('A', tableRaw(all), 1));
  // a frame from a run NOT in the session is ignored
  mgr.routeFrame({ id: 'Z' }, wsFrame('Z', tableRaw(all), 1));
  const snap = mgr.snapshot();
  assert.equal(snap.profiles.find((p) => p.id === 'A').playerCount, 3);
  assert.equal(snap.profiles.find((p) => p.id === 'B').playerCount, 0);
});

test('send seam routes through wsReplay with the learned per-profile socket ctx', async () => {
  const { mgr, sends } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'] });
  // observe one server frame per run so each profile learns its own socket ctx.
  for (const id of ['A', 'B', 'C']) mgr.routeFrame({ id }, wsFrame(id, tableRaw(['1_A', '1_B', '1_C']), 1));
  mgr.selectChannel(139);
  const res = await mgr.joinTogether();
  assert.equal(res.ok, true);
  // exactly one join per profile, each with its OWN target ctx (never shared)
  const joinSends = sends.filter((s) => s.payload === buildJoinFrame(139));
  assert.equal(joinSends.length, 3);
  const targets = new Set(joinSends.map((s) => s.ctx.targetId));
  assert.deepEqual([...targets].sort(), ['T-A', 'T-B', 'T-C']);
});

test('unauthorized environment blocks active orchestration', async () => {
  const { mgr } = makeManager({ authorized: false });
  mgr.startSession({ runIds: ['A', 'B', 'C'] });
  const res = await mgr.joinTogether(139);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_UNAUTHORIZED_ENVIRONMENT');
});

test('routeDisconnect marks only the affected profile', () => {
  const { mgr } = makeManager();
  mgr.startSession({ runIds: ['A', 'B', 'C'] });
  for (const id of ['A', 'B', 'C']) mgr.routeFrame({ id }, wsFrame(id, tableRaw(['1_A', '1_B', '1_C']), 1));
  mgr.routeDisconnect('B');
  const snap = mgr.snapshot();
  assert.equal(snap.profiles.find((p) => p.id === 'B').state, 'DISCONNECTED');
  assert.notEqual(snap.profiles.find((p) => p.id === 'A').state, 'DISCONNECTED');
});
