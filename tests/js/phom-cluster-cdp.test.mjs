import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhomClusterCdpManager, SLOTS } = require('../../desktop/protocol/phom/phom-cluster-cdp-manager.cjs');
const dp = require('../../desktop/browser-run/device-profile.cjs');

function devices() {
  return {
    A: dp.normalizeDeviceProfile({ presetId: 'android-pixel5-landscape' }).device,
    B: dp.normalizeDeviceProfile({ presetId: 'android-galaxy-s20-landscape' }).device,
    C: dp.normalizeDeviceProfile({ presetId: 'android-generic-412-landscape' }).device,
  };
}

// Build a manager over MOCK owners: each slot gets its OWN client object + run info.
function makeManager(opts = {}) {
  const dev = devices();
  const clients = { A: { id: 'client-A', Emulation: {} }, B: { id: 'client-B', Emulation: {} }, C: { id: 'client-C', Emulation: {} } };
  const runIdBySlot = { A: 'BR-A', B: 'BR-B', C: 'BR-C' };
  const slotByRun = { 'BR-A': 'A', 'BR-B': 'B', 'BR-C': 'C' };
  const applied = { A: [], B: [], C: [] };
  const opened = [];
  const closed = [];
  const mgr = new PhomClusterCdpManager({
    now: (() => { let t = 0; return () => (t += 1); })(),
    openProfile: async (slot) => { if (opts.failOpen === slot) return { ok: false, error: { code: 'PHOM_CHROMIUM_LAUNCH_FAILED' } }; opened.push(slot); return { ok: true, runId: runIdBySlot[slot] }; },
    getRunClient: (runId) => clients[slotByRun[runId]] || null,
    applyDeviceToClient: async (client, device) => { const slot = Object.keys(clients).find((s) => clients[s] === client); applied[slot].push(device.id); return { applied: ['setDeviceMetricsOverride', 'setTouchEmulationEnabled'], unsupported: [] }; },
    testProxy: async (ref) => ({ state: 'PASS', observedIp: '203.0.113.' + ref.slice(-1) }),
    closeRun: async (runId) => { closed.push(runId); },
    getRunInfo: (runId) => ({ pid: 1000 + runId.charCodeAt(3), port: 9300 + runId.charCodeAt(3), userDataDir: `D:/ud/${runId}` }),
    hostSession: opts.hostSession || null,
  });
  return { mgr, dev, clients, applied, opened, closed, runIdBySlot };
}

function baseCluster(mgr, dev) {
  return mgr.createCluster({ hostSlot: 'A', selectedStake: 1000, profiles: [
    { slot: 'A', proxyRef: 'px-A', device: dev.A }, { slot: 'B', proxyRef: 'px-B', device: dev.B }, { slot: 'C', proxyRef: 'px-C', device: dev.C },
  ] });
}

// §7/§17.B — one manager, three runs, three DISTINCT clients, no cross-route.
test('cluster owns three distinct CDP clients (no shared client)', async () => {
  const { mgr, dev, clients } = makeManager();
  baseCluster(mgr, dev);
  await mgr.openCluster();
  const conn = mgr.connectClusterCdp();
  assert.equal(conn.ok, true);
  assert.equal(conn.connected, 3);
  // distinct client objects
  assert.equal(new Set([clients.A, clients.B, clients.C]).size, 3);
});

test('a shared client is flagged (never silently accepted)', async () => {
  const { mgr, dev } = makeManager();
  // rewire getRunClient to return the SAME client for all -> must flag
  const shared = { id: 'shared', Emulation: {} };
  mgr._getRunClient = () => shared;
  baseCluster(mgr, dev);
  await mgr.openCluster();
  mgr.connectClusterCdp();
  const snap = mgr.getClusterSnapshot();
  assert.ok(snap.errors.some((e) => e.code === 'PHOM_CLUSTER_SHARED_CLIENT'));
});

// §13/§17.D — openCluster PARTIAL when a profile fails to open.
test('openCluster is PARTIAL if one process fails (not full success)', async () => {
  const { mgr, dev } = makeManager({ failOpen: 'C' });
  baseCluster(mgr, dev);
  const res = await mgr.openCluster();
  assert.equal(res.ok, false);
  assert.equal(res.opened, 2);
  assert.equal(mgr.getClusterSnapshot().profiles.C.error.code, 'PHOM_CHROMIUM_LAUNCH_FAILED');
});

// §12/§13/§17.E — applyClusterDevices routes each device to its OWN client; no copy.
test('applyClusterDevices fans out per-client; each device to its own client only', async () => {
  const { mgr, dev, applied } = makeManager();
  baseCluster(mgr, dev);
  await mgr.openCluster();
  const res = await mgr.applyClusterDevices();
  assert.equal(res.ok, true);
  assert.deepEqual(applied.A, [dev.A.id]);
  assert.deepEqual(applied.B, [dev.B.id]);
  assert.deepEqual(applied.C, [dev.C.id]);
  // no cross-contamination
  assert.notEqual(dev.A.id, dev.B.id);
});

test('applyClusterDevices PARTIAL when one client is missing (no fake full success)', async () => {
  const { mgr, dev } = makeManager();
  baseCluster(mgr, dev);
  await mgr.openCluster();
  const orig = mgr._getRunClient.bind(mgr);
  mgr._getRunClient = (runId) => (runId === 'BR-C' ? null : orig(runId));
  const res = await mgr.applyClusterDevices();
  assert.equal(res.ok, false);
  assert.equal(res.applied, 2);
});

// §8 — proxy fan-out per profile.
test('testClusterProxies fans out; 3/3 PASS => ok', async () => {
  const { mgr, dev } = makeManager();
  baseCluster(mgr, dev);
  const res = await mgr.testClusterProxies();
  assert.equal(res.ok, true);
  assert.equal(res.pass, 3);
});

// §9/§17.C — event envelope validation + isolation.
test('event envelope rejects wrong-cluster / wrong-profile / duplicate / out-of-order', async () => {
  const routed = [];
  const hostSession = { active: () => true, routeFrame: (run) => { routed.push(run.id); return null; }, snapshot: () => null, stop() {}, startSession: () => ({ ok: true }) };
  const { mgr, dev } = makeManager({ hostSession });
  baseCluster(mgr, dev);
  await mgr.openCluster();
  assert.equal(mgr.ingestEvent('BR-Z', { seq: 1 }).accepted, false); // wrong profile
  assert.equal(mgr.ingestEvent('BR-A', { seq: 1, clusterSessionId: 'OTHER' }).accepted, false); // stale cluster
  assert.equal(mgr.ingestEvent('BR-A', { seq: 5, raw: 'x' }).accepted, true);
  assert.equal(mgr.ingestEvent('BR-A', { seq: 5, raw: 'x' }).accepted, false); // duplicate seq
  assert.equal(mgr.ingestEvent('BR-A', { seq: 3, raw: 'y' }).accepted, false); // out of order
  assert.equal(mgr.ingestEvent('BR-A', { seq: 6, raw: 'z' }).accepted, true);
  // only BR-A routed, and the envelope carries the cluster/profile identity
  assert.deepEqual([...new Set(routed)], ['BR-A']);
  const env = mgr.ingestEvent('BR-B', { seq: 1, raw: 'b', targetId: 'T-B' }).envelope;
  assert.equal(env.slot, 'B');
  assert.equal(env.clusterSessionId, mgr.clusterSessionId());
});

// §13/§17.D — stopCluster tears down ONLY owned runs, idempotent.
test('stopCluster closes only owned runs and is idempotent', async () => {
  const { mgr, dev, closed } = makeManager();
  baseCluster(mgr, dev);
  await mgr.openCluster();
  const r1 = await mgr.stopCluster();
  assert.deepEqual(closed.sort(), ['BR-A', 'BR-B', 'BR-C']);
  const r2 = await mgr.stopCluster();
  assert.equal(r2.alreadyStopped, true);
  assert.equal(closed.length, 3); // no double close
});

// §10 — snapshot carries pid/port/userDataDir and NO secrets.
test('snapshot exposes pid/port/userDataDir and never a secret', async () => {
  const { mgr, dev } = makeManager();
  baseCluster(mgr, dev);
  await mgr.openCluster(); mgr.connectClusterCdp(); await mgr.testClusterProxies();
  const snap = mgr.getClusterSnapshot();
  for (const s of SLOTS) { assert.ok(snap.profiles[s].pid > 0); assert.ok(snap.profiles[s].cdpPort > 0); assert.match(snap.profiles[s].userDataDir, /BR-/); }
  assert.equal(/password|token|cookie|secret|authorization/i.test(JSON.stringify(snap)), false);
});
