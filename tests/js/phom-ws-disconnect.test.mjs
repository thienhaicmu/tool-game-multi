import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostTableCoordinator, SESSION, PSTATE } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { HostSessionManager } = require('../../desktop/protocol/phom/host-session-manager.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');

// PH-2 — a bare game-WebSocket close must flip the authoritative snapshot immediately, but ONLY
// when the closed socket is the profile's bound game socket (never an unrelated socket sharing the
// page target). These tests cover the pure seam the CDP `websocket-closed` event routes through.

const UID = { A: '1_AAA', B: '1_BBB', C: '1_CCC' };
const GAME_URL = 'wss://x.hytsocesk.com/websocket';

function makeSession(opts = {}) {
  const sent = { A: [], B: [], C: [] };
  const profiles = ['A', 'B', 'C'].map((id) => ({ id, displayName: 'P' + id, uid: UID[id], send: async (p) => { sent[id].push(p); return { ok: true }; } }));
  let t = 1000;
  const coord = new HostTableCoordinator({ profiles, hostId: opts.host || 'A', selectedStake: 1000, environmentAuthorized: true, now: () => (t += 1) });
  // Bind each profile's game socket + channel list (this is what makes it "in the Phỏm lobby").
  const channelList = (id, targetId = 'T-' + id, url = GAME_URL) => coord.ingest(id, { raw: JSON.stringify([5, { rs: [{ rid: 139, rn: 'Phom#1', gid: 8, b: 1000, mM: 10000, Mu: 4, uC: 0, hpwd: false, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId, url });
  return { coord, sent, channelList };
}

// ---- PhomContext.socketMatches (the guard) ----
test('socketMatches: true only for the bound target+host; false for a different socket', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  assert.equal(ctx.socketMatches({ targetId: 'T-A', url: GAME_URL }), false, 'no bound socket yet -> false');
  // Bind a socket from a server-evidence frame.
  ctx.observe({ raw: JSON.stringify([5, { rs: [] }]), direction: 'recv', targetId: 'T-A', url: GAME_URL });
  assert.equal(ctx.socketMatches({ targetId: 'T-A', url: GAME_URL }), true, 'same target + host matches');
  assert.equal(ctx.socketMatches({ targetId: 'T-A' }), true, 'same target, url omitted, still matches');
  assert.equal(ctx.socketMatches({ targetId: 'T-OTHER', url: GAME_URL }), false, 'different target does not match');
  assert.equal(ctx.socketMatches({ targetId: 'T-A', url: 'wss://analytics.example.com/telemetry' }), false, 'different host does not match');
});

// ---- coordinator.markSocketClosed ----
test('markSocketClosed on the HOST game socket -> HOST_LOST + disconnected', () => {
  const { coord } = makeSession();
  coord.ingest('A', { raw: JSON.stringify([5, { rs: [{ rid: 139, gid: 8, b: 1000, Mu: 4, uC: 0, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId: 'T-A', url: GAME_URL });
  const before = coord.snapshot().profiles.find((p) => p.id === 'A');
  assert.equal(before.connected, true, 'host is connected after a server frame');
  const flipped = coord.markSocketClosed('A', { targetId: 'T-A', url: GAME_URL });
  assert.equal(flipped, true, 'a matching close is applied');
  assert.equal(coord.state(), SESSION.HOST_LOST, 'host socket loss -> HOST_LOST');
  const after = coord.snapshot().profiles.find((p) => p.id === 'A');
  assert.equal(after.connected, false, 'host is now disconnected in the authoritative snapshot');
});

test('markSocketClosed ignores an unrelated socket (different target/host)', () => {
  const { coord } = makeSession();
  coord.ingest('A', { raw: JSON.stringify([5, { rs: [{ rid: 139, gid: 8, b: 1000, Mu: 4, uC: 0, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId: 'T-A', url: GAME_URL });
  const stateBefore = coord.state();
  assert.equal(coord.markSocketClosed('A', { targetId: 'T-A', url: 'wss://analytics.example.com/telemetry' }), false, 'different host is not the game socket');
  assert.equal(coord.markSocketClosed('A', { targetId: 'T-OTHER', url: GAME_URL }), false, 'different target is not our socket');
  assert.equal(coord.snapshot().profiles.find((p) => p.id === 'A').connected, true, 'still connected');
  assert.equal(coord.state(), stateBefore, 'unrelated closes never change state');
});

test('markSocketClosed on an unknown profile returns false safely', () => {
  const { coord } = makeSession();
  assert.equal(coord.markSocketClosed('ZZ', { targetId: 'T-A', url: GAME_URL }), false);
});

test('markSocketClosed emits an update snapshot (renderer gets pushed immediately)', () => {
  const { coord } = makeSession();
  coord.ingest('A', { raw: JSON.stringify([5, { rs: [{ rid: 139, gid: 8, b: 1000, Mu: 4, uC: 0, zn: 'Simms' }] }]), direction: 'recv', seq: 1, targetId: 'T-A', url: GAME_URL });
  let updates = 0;
  coord.on('update', () => { updates += 1; });
  coord.markSocketClosed('A', { targetId: 'T-A', url: GAME_URL });
  assert.ok(updates >= 1, 'an authoritative update is emitted so the UI updates at once');
});

// ---- HostSessionManager.routeSocketClosed (the main-process seam) ----
test('routeSocketClosed only affects a run inside the active session', () => {
  const sends = {};
  const mgr = new HostSessionManager({ wsReplay: { sendProtocol: async () => ({ ok: true }) }, authorized: () => true, featureEnabled: () => true, resolveProfileMeta: (id) => ({ uid: UID[id] || null }) });
  const started = mgr.startSession({ runIds: ['A', 'B', 'C'], hostId: 'A' });
  assert.equal(started.ok, true);
  // Bind A's game socket.
  mgr.routeFrame({ id: 'A' }, { isWebSocket: true, wsDirection: 'recv', seq: 1, targetId: 'T-A', url: GAME_URL, body: { raw: JSON.stringify([5, { rs: [{ rid: 139, gid: 8, b: 1000, Mu: 4, uC: 0, zn: 'Simms' }] }]) } });
  assert.equal(mgr.routeSocketClosed('NOT-IN-SESSION', { targetId: 'T-A', url: GAME_URL }), false, 'unknown run ignored');
  assert.equal(mgr.routeSocketClosed('A', { targetId: 'T-A', url: GAME_URL }), true, 'A game socket close is applied');
  assert.equal(mgr.snapshot().profiles.find((p) => p.id === 'A').connected, false);
  void sends;
});
