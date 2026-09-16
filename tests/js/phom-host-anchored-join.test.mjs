// PHASE 4 — HOST ROOM ANCHOR test. Drives the REAL HostTableCoordinator against a modelled Simms
// server that seats a native join into the ROOM whose rid was requested ([3,"Simms",rid,""]) — i.e.
// the room-based JOIN path production already uses. Verifies: A native-joins, is confirmed in ps[],
// its room is bound from authoritative evidence, and B/C join THAT EXACT rid (never a fresh stake) and
// are confirmed co-seated. Offline only (no live). A `policy` lets a test redirect a follower to a
// DIFFERENT room to prove wrong-room detection; `dropJoin` models a join the server never seats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

class RoomSim {
  constructor({ policy, dropJoin, beforeSeat } = {}) {
    this.rooms = new Map(); this.uids = { A: '1_1', B: '1_2', C: '1_3' }; this.coord = null; this.joinLog = [];
    this.policy = policy || ((id, rid) => rid);           // actual rid the server seats this profile into
    this.dropJoin = dropJoin || new Set();                // ids whose join is logged but never seated
    this.beforeSeat = beforeSeat || (() => {});           // hook(sim, id) run right before seating (e.g. evict A)
  }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _room(rid) { if (!this.rooms.has(rid)) this.rooms.set(rid, { rid, seats: [] }); return this.rooms.get(rid); }
  _table(room) { return JSON.stringify([5, { b: 100, ps: room.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _delta(uid, sit) { return JSON.stringify([5, { p: { uid, sit, r: false }, t: 1, cmd: 200 }]); }
  evict(uid) { for (const r of this.rooms.values()) r.seats = r.seats.filter((s) => s.uid !== uid); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 3) {
        const requested = j[2]; const actual = this.policy(id, requested); this.joinLog.push({ id, requested, actual });
        if (this.dropJoin.has(id)) return { ok: true }; // server accepts but never seats (no ps[])
        this.beforeSeat(this, id);
        const room = this._room(actual);
        if (!room.seats.find((s) => s.uid === uid)) {
          const sit = room.seats.length; room.seats.push({ uid, sit });
          this._feed(id, this._table(room));
          for (const pid of Object.keys(this.uids)) { if (pid !== id && room.seats.find((s) => s.uid === this.uids[pid])) this._feed(pid, this._delta(uid, sit)); }
        }
        return { ok: true };
      }
      if (j[0] === 4) { this.evict(uid); return { ok: true }; }
      return { ok: true };
    };
  }
}
function mk(simOpts) {
  const sim = new RoomSim(simOpts);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', selectedStake: 100, delay: () => Promise.resolve(), profiles: ['A', 'B', 'C'].map((id) => ({ id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['A', 'B', 'C']) { coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim };
}
const ROOM = 700100;

// Test 1 — A → room → B/C use it => HOST_ANCHORED_SAME_ROOM (B/C request A's rid, not a fresh stake)
test('happy path: HOST_ANCHORED_SAME_ROOM; B/C join A\'s exact room id', async () => {
  const { coord, sim } = mk();
  const r = await coord.runHostAnchoredJoin(ROOM);
  assert.equal(r.ok, true);
  assert.equal(r.result, 'HOST_ANCHORED_SAME_ROOM');
  assert.equal(r.roomId, ROOM);
  assert.deepEqual(r.members, ['A', 'B', 'C']);
  // B and C requested A's room id (not an independent stake matchmake)
  const reqByFollower = sim.joinLog.filter((j) => j.id !== 'A').map((j) => j.requested);
  assert.deepEqual(reqByFollower, [ROOM, ROOM], 'B and C both joined the HOST room id');
  assert.equal(sim.joinLog[0].id, 'A', 'A joined first');
});

// Test 2 — A not confirmed => B/C MUST NOT JOIN
test('A never confirmed in ps[] => TIMEOUT(HOST_CONFIRM); B/C never sent', async () => {
  const { coord, sim } = mk({ dropJoin: new Set(['A']) });
  const r = await coord.runHostAnchoredJoin(ROOM, { perStageTimeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.result, 'TIMEOUT');
  assert.equal(r.timeoutStage, 'HOST_CONFIRM');
  assert.deepEqual(sim.joinLog.map((j) => j.id), ['A'], 'only A attempted; B/C never joined');
});

// Test 3 — no room id => HOST_ROOM_ID_NOT_FOUND (white-box on the extraction guard)
test('_extractHostRoom: HOST_ROOM_ID_NOT_FOUND when not seated or no join rid', () => {
  const { coord } = mk();
  const host = coord.host();
  // not seated at all
  assert.equal(coord._extractHostRoom(host).error.code, 'HOST_ROOM_ID_NOT_FOUND');
  // seated in ps[] but no join rid recorded
  coord.ingest('A', { raw: `[5,{"b":100,"ps":[{"uid":"1_1","sit":0}],"cmd":202}]`, direction: 'recv', targetId: 'A', url: 'wss://sim', now: 2 });
  host._joinedRid = null;
  const ex = coord._extractHostRoom(host);
  assert.equal(ex.ok, false);
  assert.equal(ex.error.code, 'HOST_ROOM_ID_NOT_FOUND');
});

// Test 4 — B joins the host room id but the server seats it elsewhere => B_JOIN_WRONG_ROOM
test('B redirected to a different room => B_JOIN_WRONG_ROOM; C never sent', async () => {
  const { coord, sim } = mk({ policy: (id, rid) => (id === 'B' ? 700999 : rid) });
  const r = await coord.runHostAnchoredJoin(ROOM);
  assert.equal(r.ok, false);
  assert.equal(r.result, 'B_JOIN_WRONG_ROOM');
  assert.equal(sim.joinLog.some((j) => j.id === 'C'), false, 'C must not continue after B wrong-room');
});

// Test 5 — C joins the host room id but is seated elsewhere => C_JOIN_WRONG_ROOM
test('C redirected to a different room => C_JOIN_WRONG_ROOM', async () => {
  const { coord } = mk({ policy: (id, rid) => (id === 'C' ? 700999 : rid) });
  const r = await coord.runHostAnchoredJoin(ROOM);
  assert.equal(r.ok, false);
  assert.equal(r.result, 'C_JOIN_WRONG_ROOM');
});

// Test 6/8 — stale generation guard: a room from generation N is never used by generation N+1
test('generation guard: a follower step from a superseded generation aborts STALE_GENERATION', async () => {
  const { coord, sim } = mk();
  const oldGen = coord._gen;           // capture, then a competing op bumps the generation
  coord._gen++;                        // simulate a new operation superseding this one
  const res = await coord._anchorFollower(coord.followers()[0], ROOM, oldGen, 1000, 'B', 'J3', 'J4', coord.host(), []);
  assert.equal(res.ok, false);
  assert.equal(res.result, 'STALE_GENERATION');
  assert.equal(sim.joinLog.length, 0, 'the stale follower never sent a join');
});

// Test 7 — stop during host confirmation => CANCELLED; B/C never join
test('stop() during host confirmation => CANCELLED; B/C never join', async () => {
  const { coord, sim } = mk({ dropJoin: new Set(['A']) }); // A pends (never seated)
  const p = coord.runHostAnchoredJoin(ROOM, { perStageTimeoutMs: 5000 });
  coord.stop(); // bumps generation + sets stopped; the pending host wait resolves via 'update'
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.result, 'CANCELLED');
  assert.deepEqual(sim.joinLog.map((j) => j.id), ['A'], 'only A attempted before stop; no B/C');
});

// Test 9 — B fails to seat => C must not continue automatically
test('B never seated (timeout) => B_NOT_CONFIRMED_IN_PS; C never sent', async () => {
  const { coord, sim } = mk({ dropJoin: new Set(['B']) });
  const r = await coord.runHostAnchoredJoin(ROOM, { perStageTimeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.result, 'B_NOT_CONFIRMED_IN_PS');
  assert.equal(r.timeoutStage, 'B_SAME_ROOM');
  assert.equal(sim.joinLog.some((j) => j.id === 'C'), false, 'C did not continue after B failed');
});

// Test 11 — A authoritatively leaves (A gets an A-less TABLE_STATE) before B confirms => ROOM_CHANGED
test('A authoritatively leaves before B confirms => ROOM_CHANGED (never false success)', async () => {
  // When B joins, push A an authoritative A-less table (A kicked/left) and evict A from the room.
  const { coord } = mk({ beforeSeat: (sim, id) => { if (id === 'B') { sim.evict('1_1'); sim._feed('A', JSON.stringify([5, { b: 100, ps: [], cmd: 202 }])); } } });
  const r = await coord.runHostAnchoredJoin(ROOM);
  assert.equal(r.ok, false);
  assert.equal(r.result, 'ROOM_CHANGED');
});

// Test 10 — B ends up in a room that does not contain A (A's view never updated) => a failure, never success
test('B seated in a room without A => failure (not a false success)', async () => {
  const { coord } = mk({ beforeSeat: (sim, id) => { if (id === 'B') sim.evict('1_1'); } });
  const r = await coord.runHostAnchoredJoin(ROOM);
  assert.equal(r.ok, false);
  assert.notEqual(r.result, 'HOST_ANCHORED_SAME_ROOM');
  assert.ok(['B_JOIN_WRONG_ROOM', 'ROOM_CHANGED'].includes(r.result), `honest failure, got ${r.result}`);
});

// Trace — J0..J7 milestones present and correctly ordered on the happy path
test('emits J0..J7 host-anchor milestones in order', async () => {
  const { coord } = mk();
  await coord.runHostAnchoredJoin(ROOM);
  const names = coord.trace().map((e) => e.milestone);
  const want = ['J0_HOST_JOIN_SENT', 'J1_HOST_CONFIRMED', 'J2_HOST_ROOM_BOUND', 'J3_B_JOIN_SENT', 'J4_B_SAME_ROOM_CONFIRMED', 'J5_C_JOIN_SENT', 'J6_C_SAME_ROOM_CONFIRMED', 'J7_FINAL_CLUSTER_CONFIRMED'];
  for (const m of want) assert.ok(names.includes(m), `missing ${m} (got ${names.join(',')})`);
  const idxs = want.map((m) => names.indexOf(m));
  for (let i = 1; i < idxs.length; i++) assert.ok(idxs[i] > idxs[i - 1], `${want[i]} must come after ${want[i - 1]}`);
});

// Guard — missing channel/stake is refused typed (no default room guess)
test('missing channel => HOST_JOIN_FAILED / PHOM_NO_STAKE_SELECTED (no room guess)', async () => {
  const sim = new RoomSim();
  const coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', delay: () => Promise.resolve(), profiles: ['A', 'B', 'C'].map((id) => ({ id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['A', 'B', 'C']) coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 });
  const r = await coord.runHostAnchoredJoin(null);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_STAKE_SELECTED');
});

// Production flow is untouched: the discovery entry points still exist and are separate.
test('production discovery methods remain present and separate from the experiment', () => {
  const { coord } = mk();
  for (const m of ['runDiscovery', 'acquireHost', 'joinFollowers', 'applyReady', 'verifySameTable']) {
    assert.equal(typeof coord[m], 'function', `production method ${m} still present`);
  }
});
