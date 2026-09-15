// PHOM FIND-TABLE OFFLINE SIMULATION — develop/verify the room-pick + host-first flow WITHOUT a live
// app, by modelling the Simms server from the CAPTURED request/response shapes this session:
//   client cmd:300  -> server CHANNEL_LIST rs[]  (rooms: rid/b/uC/Mu)
//   client JOIN [3,"Simms",rid,""] -> [3,true,…] + TABLE_STATE(that room's ps[]) + cmd:200 SEAT_UPDATE
//   client LEAVE [4,"Simms",-1] -> seat removed
// The real HostTableCoordinator is driven through this model; every assertion is deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

// ---- server model (from captured frame shapes) ----
class PhomServerSim {
  constructor({ rooms, uids }) {
    // room: { rid, b, Mu, seats:[{sit,uid}] }  (initial seats = uncontrolled outsiders)
    this.rooms = rooms.map((r) => ({ rid: r.rid, b: r.b, Mu: r.Mu != null ? r.Mu : 4, rn: r.rn || 'Phom', reportedUC: r.reportedUC, seats: (r.seats || []).slice() }));
    this.uids = uids; // { A, B, C } -> game uids
    this.coord = null;
    this.joinLog = [];
  }
  attach(coord) { this.coord = coord; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  // rs[] reports uC. A room may advertise a STALE uC (reportedUC) that is LOWER than the real
  // occupancy — modelling the live 139 race where the list says "empty" but the table is full.
  _channelList() { const rs = this.rooms.map((r) => ({ rid: r.rid, b: r.b, uC: (r.reportedUC != null ? r.reportedUC : r.seats.length), Mu: r.Mu, zn: 'Simms', gid: 8, rn: r.rn })); return JSON.stringify([5, { rs, cmd: 300 }]); }
  _tableState(room) { const ps = room.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })); return JSON.stringify([5, { b: room.b, ps, cmd: 202 }]); }
  _seatDelta(uid, sit) { return JSON.stringify([5, { p: { uid, sit, r: false }, t: 1, cmd: 200 }]); }
  _room(rid) { return this.rooms.find((r) => r.rid === rid); }
  // the per-profile send seam handed to the coordinator
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const op = j[0], uid = this.uids[id];
      if (op === 6 && j[3] && j[3].cmd === 300) { this._feed(id, this._channelList()); return { ok: true }; }
      if (op === 4) { for (const r of this.rooms) r.seats = r.seats.filter((s) => s.uid !== uid); return { ok: true }; }
      if (op === 3) {
        const room = this._room(j[2]); this.joinLog.push({ id, rid: j[2] });
        if (!room) return { ok: true }; // unknown rid -> server ignores
        const seated = room.seats.find((s) => s.uid === uid);
        if (!seated) {
          if (room.seats.length >= room.Mu) { this._feed(id, this._tableState(room)); return { ok: true }; } // full: joiner sees a full table it is NOT in
          const used = new Set(room.seats.map((s) => s.sit)); let sit = 0; while (used.has(sit)) sit++;
          room.seats.push({ sit, uid });
          this._feed(id, this._tableState(room)); // joiner gets full snapshot (includes itself)
          for (const pid of Object.keys(this.uids)) { if (pid === id) continue; if (room.seats.find((s) => s.uid === this.uids[pid])) this._feed(pid, this._seatDelta(uid, sit)); }
        }
        return { ok: true };
      }
      return { ok: true };
    };
  }
}

function selfId(uid) { return `[5,{"uid":"${uid}","u":"${uid}","As":{"gold":100},"dn":"n","cmd":100,"id":0}]`; }

function mkSession(rooms) {
  const uids = { A: '1_1', B: '1_2', C: '1_3' };
  const sim = new PhomServerSim({ rooms, uids });
  const coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', selectedStake: 100, delay: () => Promise.resolve(),
    profiles: ['A', 'B', 'C'].map((id) => ({ id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['A', 'B', 'C']) { coord.ingest(id, { raw: selfId(uids[id]), direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim, uids };
}

// The stake channel list mixes a BUCKET (uC >> Mu) + FULL rooms + one genuinely EMPTY room.
const MIXED = [
  { rid: 139, b: 100, Mu: 4, rn: 'Phom#1', seats: [{ sit: 0, uid: 'x' }, { sit: 1, uid: 'y' }, { sit: 2, uid: 'z' }, { sit: 3, uid: 'w' }] }, // full room
  { rid: 141, b: 100, Mu: 4, rn: 'Phom#2', seats: Array.from({ length: 73 }, (_, i) => ({ sit: i, uid: 'b' + i })) }, // bucket (uC=73 >> Mu)
  { rid: 700100, b: 100, Mu: 4, rn: 'Phom', seats: [] }, // EMPTY table
  { rid: 700200, b: 100, Mu: 4, rn: 'Phom', seats: [{ sit: 0, uid: 'o1' }, { sit: 1, uid: 'o2' }] }, // 2 free (not enough for 3)
];

test('room-pick chooses a REAL empty table (>=3 free seats), never the full/bucket entry', () => {
  const { coord, sim } = mkSession(MIXED);
  // seed the host channel list (as cmd:300 would)
  coord.ingest('A', { raw: sim._channelList(), direction: 'recv', targetId: 'A', url: 'wss://sim', now: 2 });
  const pick = coord._pickStakeChannel(coord.host());
  assert.equal(pick.rid, 700100, 'must pick the empty 4-seat table, not 139(full)/141(bucket)/700200(only 2 free)');
});

test('full discovery over the model reaches SAME_TABLE at the empty room', async () => {
  const { coord, sim } = mkSession(MIXED);
  const r = await coord.runDiscovery();
  assert.equal(r.ok, true);
  assert.equal(r.sameTable, true, JSON.stringify(coord.verifySameTable()));
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
  // A/B/C all joined the SAME room rid, and it is the empty one (700100)
  const rids = new Set(sim.joinLog.map((j) => j.rid));
  assert.ok(rids.has(700100));
  assert.deepEqual(coord.host().ctx.tableState().uids, ['1_1', '1_2', '1_3'].sort());
});

test('when only full rooms/buckets exist, host search does NOT falsely succeed', async () => {
  const FULL_ONLY = [
    { rid: 139, b: 100, Mu: 4, rn: 'Phom#1', seats: [{ sit: 0, uid: 'a' }, { sit: 1, uid: 'b' }, { sit: 2, uid: 'c' }, { sit: 3, uid: 'd' }] },
    { rid: 141, b: 100, Mu: 4, rn: 'Phom#2', seats: Array.from({ length: 50 }, (_, i) => ({ sit: i, uid: 'q' + i })) },
  ];
  const { coord } = mkSession(FULL_ONLY);
  const r = await coord.runDiscovery();
  assert.equal(r.ok, false);
  assert.notEqual(coord.verifySameTable().result, 'SAME_TABLE');
});

// The live 139 problem: the channel list advertises a room as empty (stale uC) but it is actually
// full. The host must join, see from ps[] it can't fit A+B+C, ABANDON that rid, and find a real
// empty room — reaching SAME_TABLE instead of looping on the stale entry.
test('stale-uC race: host abandons a falsely-empty room and finds a real one => SAME_TABLE', async () => {
  const ROOMS = [
    { rid: 139, b: 100, Mu: 4, rn: 'Phom#1', reportedUC: 0, seats: [{ sit: 0, uid: 'a' }, { sit: 1, uid: 'b' }, { sit: 2, uid: 'c' }, { sit: 3, uid: 'd' }] }, // list says empty, really full
    { rid: 700400, b: 100, Mu: 4, rn: 'Phom', seats: [] }, // real empty
  ];
  const { coord, sim } = mkSession(ROOMS);
  const r = await coord.runDiscovery();
  assert.equal(r.sameTable, true, JSON.stringify(coord.verifySameTable()));
  // it tried 139 first (stale-empty), abandoned it, then joined the real empty room
  const rids = sim.joinLog.map((j) => j.rid);
  assert.ok(rids.includes(139), 'attempted the falsely-empty room');
  assert.ok(rids.includes(700400), 'recovered onto the real empty room');
  assert.deepEqual(coord.host().ctx.tableState().uids, ['1_1', '1_2', '1_3'].sort());
});

test('a room with exactly 3 free seats (1 outsider) is acceptable and yields SAME_TABLE + an outsider', async () => {
  const ROOMS = [
    { rid: 139, b: 100, Mu: 4, rn: 'Phom#2', seats: Array.from({ length: 60 }, (_, i) => ({ sit: i, uid: 'b' + i })) }, // bucket
    { rid: 700300, b: 100, Mu: 4, rn: 'Phom', seats: [{ sit: 0, uid: '1_outsider' }] }, // 3 free
  ];
  const { coord } = mkSession(ROOMS);
  const r = await coord.runDiscovery();
  assert.equal(r.sameTable, true, JSON.stringify(coord.verifySameTable()));
  assert.ok(coord.host().ctx.tableState().uids.includes('1_outsider'), 'the outsider stays; A/B/C join alongside');
});
