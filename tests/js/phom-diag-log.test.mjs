// GĐ1 — diagnostics for the live failures of 2026-10-03 (acc 3 refused 166 "Phòng đầy" at a 2-player table; the KEY
// kicked "Bạn thoát vì không bắt đầu"): the coseat log must carry the table's limits, every seat's money and the
// server's own refusal / kick frame — and still never a secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

function mk() {
  const logs = [];
  const coord = new HostTableCoordinator({ profiles: [{ id: 'A', uid: '1_100', send: async () => ({ ok: true }) }], environmentAuthorized: true, now: () => 1 });
  coord.on('log', (l) => logs.push(l));
  const feed = (frame) => coord.ingest('A', { raw: JSON.stringify(frame), direction: 'recv', seq: 1 });
  return { coord, logs, feed };
}

test('TABLE_DIAG carries stake, max players (Mu), game state, lock and each seat\'s money', () => {
  const { logs, feed } = mk();
  feed([5, { b: 100, Mu: 4, gS: 0, hpwd: false, ps: [{ uid: '1_100', dn: 'baycao1002', m: 5000, sit: 0, C: true, r: false }], cmd: 202 }]);
  const d = logs.find((l) => l.event === 'TABLE_DIAG');
  assert.ok(d, 'logged');
  assert.equal(d.stake, 100); assert.equal(d.maxPlayers, 4); assert.equal(d.gameState, 0); assert.equal(d.locked, false);
  assert.equal(d.seats[0].money, 5000);
});

test('a refused join keeps the server frame + the account money; an accepted one does not', () => {
  const { logs, feed } = mk();
  feed([3, false, 166, 8163100, 'Phòng đầy']);
  const no = logs.find((l) => l.event === 'JOIN_ACK');
  assert.equal(no.accepted, false);
  assert.equal(no.serverFrame, '[3,false,166,8163100,"Phòng đầy"]');
  assert.ok('money' in no);
  feed([3, true, 0, -1, null]);
  const yes = logs.filter((l) => l.event === 'JOIN_ACK').at(-1);
  assert.equal(yes.accepted, true);
  assert.equal('serverFrame' in yes, false);
});

test('a kick keeps the server frame and whether the kicked browser was the host', () => {
  const { logs, feed } = mk();
  feed([5, { b: 100, Mu: 4, ps: [{ uid: '1_100', dn: 'k', sit: 0, C: true }], cmd: 202 }]);
  feed([4, true, 2, -1, 2, 'Bạn thoát vì không bắt đầu']);
  const k = logs.find((l) => l.event === 'KICKED');
  assert.ok(k);
  assert.match(k.serverFrame, /không bắt đầu/);
  assert.equal(k.host, true, 'it was the host (read before the kick cleared the table)');
});

test('a frame that could hold a secret is never copied into the log', () => {
  const { logs, feed } = mk();
  feed([3, false, 103, 1, 'Sai mật khẩu', { token: 'abc' }]);
  const no = logs.find((l) => l.event === 'JOIN_ACK');
  assert.equal(no.serverFrame, null);
});

test('T8 facts: player count, everyone-but-host ready, and only the HOST may start', async () => {
  const sent = [];
  const coord = new HostTableCoordinator({ profiles: [{ id: 'A', uid: '1_100', send: async (f) => { sent.push(f); return { ok: true }; } }], environmentAuthorized: true, now: () => 1 });
  const feed = (frame) => coord.ingest('A', { raw: JSON.stringify(frame), direction: 'recv', seq: 1, targetId: 'T' });
  feed([5, { b: 100, ps: [{ uid: '1_100', sit: 0, C: true }, { uid: '1_2', sit: 1, r: true }, { uid: '1_3', sit: 2, r: true }, { uid: '1_9', sit: 3, r: false }], cmd: 202 }]);
  assert.equal(coord.tablePlayerCount('A'), 4);
  assert.equal(coord.othersReady('A'), false, 'the stranger (1_9) is not ready');
  feed([5, { uid: '1_9', cmd: 5 }]);
  assert.equal(coord.othersReady('A'), true);
  assert.equal(coord.isTableHost('A'), true);
  const r = await coord.sendTableStart('A');
  assert.equal(r.ok !== false, true);
  const coord2 = new HostTableCoordinator({ profiles: [{ id: 'B', uid: '1_2', send: async () => ({ ok: true }) }], environmentAuthorized: true, now: () => 1 });
  coord2.ingest('B', { raw: JSON.stringify([5, { b: 100, ps: [{ uid: '1_100', sit: 0, C: true }, { uid: '1_2', sit: 1 }], cmd: 202 }]), direction: 'recv', seq: 1, targetId: 'T' });
  assert.equal((await coord2.sendTableStart('B')).error.code, 'PHOM_NOT_HOST');
});

test('strangerReady: true only when a player who is NOT one of ours is ready at this browser table', () => {
  const coord = new HostTableCoordinator({ profiles: [{ id: 'A', uid: '1_100', send: async () => ({ ok: true }) }, { id: 'B', uid: '1_2', send: async () => ({ ok: true }) }], environmentAuthorized: true, now: () => 1 });
  coord.setIdentity('B', { uid: '1_2' });
  const feed = (frame) => coord.ingest('A', { raw: JSON.stringify(frame), direction: 'recv', seq: 1, targetId: 'T' });
  feed([5, { b: 100, ps: [{ uid: '1_100', sit: 0, C: true }, { uid: '1_2', sit: 1, r: true }, { uid: '1_9', sit: 2, r: false }], cmd: 202 }]);
  assert.equal(coord.strangerReady('A'), false, 'our own B is ready, the stranger is not');
  feed([5, { uid: '1_9', cmd: 5 }]);
  assert.equal(coord.strangerReady('A'), true);
});
