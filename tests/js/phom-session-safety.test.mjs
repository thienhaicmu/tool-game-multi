import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');
const { FindLock } = require('../../desktop/protocol/phom/find-lock.cjs');
const { redactFrame } = require('../../desktop/protocol/phom/frame-recorder.cjs');
const { redactDiagnostic } = require('../../desktop/protocol/phom/diagnostic-redaction.cjs');

const list = [5, { cmd: 300, rs: [{ rid: 700, b: 1000, uC: 0, Mu: 4, gid: 8, zn: 'Simms' }] }];
const table = (...uids) => [5, { cmd: 202, b: 1000, ps: uids.map((uid, sit) => ({ uid, sit, r: false })) }];
function setup(send = async () => ({ ok: true })) {
  const sent = []; let coord;
  coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', leaveConfirmMs: 15, joinRejectGraceMs: 1,
    profiles: ['A', 'B', 'C'].map((id) => ({ id, uid: id, send: async (raw) => { sent.push({ id, packet: JSON.parse(raw) }); return send(id, JSON.parse(raw), coord); } })) });
  for (const id of ['A', 'B', 'C']) { feed(coord, id, [5, { cmd: 100, id: 0, uid: id, As: {} }]); coord.setIdentity(id, { aid: 1 }); }
  return { coord, sent };
}
function feed(coord, id, packet) { coord.ingest(id, { raw: JSON.stringify(packet), direction: 'recv', targetId: id, url: 'wss://fixture', now: Date.now() }); }

test('a late channel list cannot erase membership; LEAVE_ACK can', () => {
  const ctx = new PhomContext({ uid: 'A' });
  const observe = (packet) => ctx.observe({ raw: JSON.stringify(packet), direction: 'recv', targetId: 'A', url: 'wss://fixture' });
  observe(table('A')); observe(list);
  assert.equal(ctx.seat(), 0);
  observe([4, true, 1, -1, 0, '']); assert.equal(ctx.tableState(), null);
});

test('simultaneous FIND across two browsers is rejected before a second send', async () => {
  let started; const sentFirst = new Promise((r) => { started = r; });
  const { coord, sent } = setup(async () => { started(); return { ok: true }; });
  const first = coord.manualDiscoverTable('A', { selectedStake: 1000, budgetMs: 1000 });
  await sentFirst;
  const second = await coord.manualDiscoverTable('B', { selectedStake: 1000 });
  assert.equal(second.error.code, 'FIND_ALREADY_RUNNING');
  assert.equal(sent.filter((s) => s.id === 'B').length, 0);
  coord.stop(); await first;
  assert.equal(coord.snapshot().findLock, null);
});

test('cancelled lease cannot release its replacement', () => {
  const lock = new FindLock(); const a = lock.acquire('A', 'session'); lock.cancel();
  const b = lock.acquire('B', 'session'); lock.release(a);
  assert.equal(lock.snapshot().ownerBrowserId, 'B'); lock.release(b); assert.equal(lock.snapshot(), null);
});

test('LEAVE timeout preserves observed membership and blocks a subsequent JOIN', async () => {
  const { coord, sent } = setup(); feed(coord, 'B', table('B'));
  const result = await coord.manualLeave('B', { leaveTimeoutMs: 5 });
  assert.equal(result.state, 'LEAVE_UNCONFIRMED');
  assert.equal(coord._rec('B').ctx.seat(), 0);
  const join = await coord.manualJoinRoom('B', 700);
  assert.equal(join.error.code, 'PHOM_ALREADY_AT_TABLE');
  assert.equal(sent.some((s) => s.packet[0] === 3), false);
});

test('JOIN_SHARED cannot continue after an unconfirmed LEAVE', async () => {
  const { coord, sent } = setup();
  feed(coord, 'A', table('A')); Object.assign(coord._rec('A'), { manualState: 'JOINED', _joinedRid: 700, _joinedRidValidated: true });
  feed(coord, 'B', table('B'));
  const result = await coord.manualJoinShared('B', 700);
  assert.equal(result.error.code, 'PHOM_LEAVE_NOT_CONFIRMED');
  assert.equal(sent.some((s) => s.packet[0] === 3), false);
});

test('STOP while JOIN send awaits cannot publish a room from its late completion', async () => {
  let release; const { coord } = setup(() => new Promise((r) => { release = r; }));
  const joining = coord.manualJoinRoom('A', 700); coord.stop();
  feed(coord, 'A', table('A')); release({ ok: true });
  assert.equal((await joining).ok, false); assert.equal(coord.sharedRid(), null);
});

test('LEAVE ALL still works after STOP and awaits server acknowledgement', async () => {
  const { coord } = setup(async (id, packet, c) => { if (packet[0] === 4) feed(c, id, [4, true, 1, -1, 0, '']); return { ok: true }; });
  feed(coord, 'A', table('A')); coord.stop();
  const result = await coord.leaveAll(); assert.equal(result.ok, true); assert.equal(coord._rec('A').ctx.tableState(), null);
});

test('group qualification cannot be weakened by minSeats or partial fallback options', async () => {
  const { coord, sent } = setup();
  feed(coord, 'A', [5, { cmd: 300, rs: [{ rid: 700, b: 1000, uC: 3, Mu: 4, gid: 8, zn: 'Simms' }] }]);
  const result = await coord.manualDiscoverTable('A', { selectedStake: 1000, need: 3, minSeats: 1, rerollUntilFit: false, budgetMs: 15, pollMs: 5 });
  assert.equal(result.ok, false); assert.equal(coord.sharedRid(), null);
  assert.equal(sent.some((s) => s.packet[0] === 3), false);
});

test('log subscribers cannot receive auth tokens, room codes, binary previews or probe values', () => {
  const { coord } = setup(); const logs = []; coord.on('log', (e) => logs.push(e));
  feed(coord, 'A', [1, true, 1, 'SECRET_LOGIN', 'Simms']);
  feed(coord, 'A', [5, { cmd: 202, b: 1000, hpwd: 'SECRET_ROOM', ps: [{ uid: 'A', sit: 0 }] }]);
  const json = JSON.stringify(logs);
  assert.equal(json.includes('SECRET_'), false);
  assert.equal(JSON.stringify(redactDiagnostic({ result: { arbitrary: 'SECRET_PROBE' }, hex: 'SECRET_HEX', roomCode: 'SECRET_ROOM' })).includes('SECRET_'), false);
});

test('frame recorder redacts positional login and token-identity fields', () => {
  assert.equal(redactFrame('[1,true,1,"SECRET_LOGIN","Simms"]').raw.includes('SECRET_LOGIN'), false);
  assert.equal(redactFrame('[5,{"cmd":100,"id":1,"uid":"SECRET_ID","As":{}}]').raw.includes('SECRET_ID'), false);
});

test('login token is never reused as a room password', () => {
  const { coord } = setup(); feed(coord, 'A', table('A'));
  Object.assign(coord._rec('A'), { manualState: 'JOINED', _joinedRid: 700, _joinedRidValidated: true, _sessionToken: 'SECRET_LOGIN' });
  assert.equal(coord._anchorRoomCode(), null);
});

test('READY never sends after STOP during the first send, and the third account remains waiting', async () => {
  const { coord, sent } = setup(async (_id, packet, c) => { if (packet[3]?.cmd === 363) c.stop(); return { ok: true }; });
  for (const id of ['A', 'B', 'C']) feed(coord, id, table('A', 'B', 'C', 'outsider'));
  assert.equal(coord.readyPolicy().desired.get('C'), false);
  assert.equal((await coord.applyReady()).ok, false);
  assert.equal(sent.filter((s) => s.packet[3]?.cmd === 363).length, 1);
});

test('one backend intent joins A then B then C and readies exactly two after membership proof', async () => {
  const members = [];
  const { coord, sent } = setup(async (id, packet, c) => {
    if (packet[3]?.cmd === 300) feed(c, id, list);
    if (packet[0] === 3) {
      members.push(id);
      for (const member of members) feed(c, member, table(...members));
    }
    return { ok: true };
  });
  const result = await coord.findAndJoinGroup('A', { selectedStake: 1000, timeoutMs: 50 });
  assert.equal(result.ok, true); assert.equal(result.sameTable, true);
  assert.deepEqual(sent.filter((s) => s.packet[0] === 3).map((s) => s.id), ['A', 'B', 'C']);
  assert.deepEqual(sent.filter((s) => s.packet[3]?.cmd === 363).map((s) => s.id), ['A', 'B']);
  assert.equal(coord.snapshot().findLock, null);
});

test('an outsider taking the last slot during follower JOIN makes the group leave', async () => {
  const members = [];
  const { coord, sent } = setup(async (id, packet, c) => {
    if (packet[3]?.cmd === 300) feed(c, id, list);
    if (packet[0] === 3) {
      members.push(id);
      const players = id === 'B' ? [...members, 'X', 'Y'] : members;
      for (const member of members) feed(c, member, table(...players));
    }
    if (packet[0] === 4) feed(c, id, [4, true, 1, -1, 0, '']);
    return { ok: true };
  });
  const result = await coord.findAndJoinGroup('A', { selectedStake: 1000, timeoutMs: 50 });
  assert.equal(result.error.code, 'GROUP_NO_LONGER_FITS');
  assert.equal(result.cleanup.ok, true);
  assert.equal(sent.some((s) => s.id === 'C' && s.packet[0] === 3), false);
  assert.equal(sent.some((s) => s.packet[3]?.cmd === 363), false);
  assert.equal(coord.sharedRid(), null);
});

test('STOP while first follower send is pending prevents a JOIN from the remaining browser', async () => {
  const members = [];
  const { coord, sent } = setup(async (id, packet, c) => {
    if (packet[3]?.cmd === 300) feed(c, id, list);
    if (packet[0] === 3) {
      members.push(id); for (const member of members) feed(c, member, table(...members));
      if (id === 'B') c.stop();
    }
    return { ok: true };
  });
  const result = await coord.findAndJoinGroup('A', { selectedStake: 1000, timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(sent.some((s) => s.id === 'C' && s.packet[0] === 3), false);
  assert.equal(sent.some((s) => s.packet[3]?.cmd === 363), false);
});

for (const method of ['manualJoinShared', 'manualJoinByCode']) {
  test(`${method} stops retrying a room rejected as nonexistent (capture code 102)`, async () => {
    const { coord, sent } = setup(async (id, packet, c) => {
      if (packet[0] === 3) feed(c, id, [3, false, 102, 3588738, 'Phòng không tồn tại']);
      return { ok: true };
    });
    feed(coord, 'A', table('A'));
    Object.assign(coord._rec('A'), { manualState: 'JOINED', _joinedRid: 3588738, _joinedRidValidated: true });
    const result = await coord[method]('B', 3588738, { maxRetries: 3, joinTimeoutMs: 30 });
    assert.equal(result.ok, false);
    assert.equal(result.error.serverCode, 102);
    assert.equal(sent.filter(x => x.packet[0] === 3).length, 1);
  });
}

test('JOIN_SHARED automatically uses the current response hpwd, never a user supplied override', async () => {
  const { coord, sent } = setup(async (id, packet, c) => {
    if (packet[0] === 3) feed(c, id, table('A', 'B'));
    return { ok: true };
  });
  const state = table('A'); state[1].hpwd = 'server-assigned-room-code';
  feed(coord, 'A', state);
  Object.assign(coord._rec('A'), { manualState: 'JOINED', _joinedRid: 700, _joinedRidValidated: true });
  const result = await coord.manualJoinShared('B', 700, { roomCode: 'obsolete-manual-code' });
  assert.equal(result.ok, true);
  assert.equal(sent.find(x => x.packet[0] === 3).packet[3], 'server-assigned-room-code');
  assert.equal(JSON.stringify(coord.snapshot()).includes('server-assigned-room-code'), false);
});

test('changing table releases all old seats before finding and joins the entire group to a different RID', async () => {
  const members = [];
  const { coord, sent } = setup(async (id, packet, c) => {
    if (packet[0] === 4) feed(c, id, [4, true, 1, -1, 0, '']);
    if (packet[3]?.cmd === 300) feed(c, id, [5, { cmd: 300, rs: [list[1].rs[0], { ...list[1].rs[0], rid: 701 }] }]);
    if (packet[0] === 3) {
      members.push(id);
      for (const member of members) feed(c, member, table(...members));
    }
    return { ok: true };
  });
  for (const id of ['A', 'B', 'C']) {
    feed(coord, id, table('A', 'B', 'C'));
    Object.assign(coord._rec(id), { manualState: 'JOINED', _joinedRid: 700, _joinedRidValidated: true });
  }
  const result = await coord.findAndJoinGroup('A', { selectedStake: 1000, timeoutMs: 50 });
  assert.equal(result.ok, true);
  assert.deepEqual(sent.slice(0, 3).map(x => x.packet[0]), [4, 4, 4]);
  assert.deepEqual(sent.filter(x => x.packet[0] === 3).map(x => x.packet[2]), [701, 701, 701]);
});

test('changing table stops before discovery when an old seat cannot be released', async () => {
  const { coord, sent } = setup();
  feed(coord, 'A', table('A'));
  Object.assign(coord._rec('A'), { manualState: 'JOINED', _joinedRid: 700, _joinedRidValidated: true });
  const result = await coord.findAndJoinGroup('A', { selectedStake: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PHOM_LEAVE_NOT_CONFIRMED');
  assert.equal(sent.some(x => x.packet[0] === 3 || x.packet[3]?.cmd === 300), false);
});

test('Tao ban only selects empty tables, while normal discovery accepts enough free seats', () => {
  const { pickQualifiedCandidate } = require('../../desktop/protocol/phom/table-qualify.cjs');
  const rows = [{ ...list[1].rs[0], uC: 1 }, { ...list[1].rs[0], rid: 701, uC: 0 }];
  assert.equal(pickQualifiedCandidate(rows, { need: 3, selectedStake: 1000, emptyOnly: true }).candidate.rid, 701);
  assert.equal(pickQualifiedCandidate(rows.slice(0,1), { need: 3, selectedStake: 1000, emptyOnly: true }).candidate, null);
  assert.equal(pickQualifiedCandidate(rows.slice(0,1), { need: 3, selectedStake: 1000 }).candidate.rid, 700);
});
