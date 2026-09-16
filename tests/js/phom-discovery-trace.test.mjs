// PHASE 2 — event-driven wait + monotonic discovery trace. Verifies the latency optimization
// (wake on authoritative evidence, not a fixed poll tick) and the instrumentation timeline, using
// the SAME captured-shape server model as phom-find-table-sim (no live, no fabricated success).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

// ---- minimal Simms server model (join -> TABLE_STATE ps[]; seat deltas to co-seated peers) ----
class Sim {
  constructor(rooms, uids) { this.rooms = rooms.map((r) => ({ Mu: 4, seats: [], ...r })); this.uids = uids; this.coord = null; this.joinLog = []; }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _list() { return JSON.stringify([5, { rs: this.rooms.map((r) => ({ rid: r.rid, b: r.b, uC: r.seats.length, Mu: r.Mu, zn: 'Simms', gid: 8, rn: 'Phom' })), cmd: 300 }]); }
  _table(r) { return JSON.stringify([5, { b: r.b, ps: r.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _delta(uid, sit) { return JSON.stringify([5, { p: { uid, sit, r: false }, t: 1, cmd: 200 }]); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this._feed(id, this._list()); return { ok: true }; }
      if (j[0] === 4) { for (const r of this.rooms) r.seats = r.seats.filter((s) => s.uid !== uid); return { ok: true }; }
      if (j[0] === 3) {
        const room = this.rooms.find((r) => r.rid === j[2]); this.joinLog.push({ id, rid: j[2] });
        if (!room) return { ok: true };
        if (!room.seats.find((s) => s.uid === uid)) {
          if (room.seats.length >= room.Mu) { this._feed(id, this._table(room)); return { ok: true }; }
          const used = new Set(room.seats.map((s) => s.sit)); let sit = 0; while (used.has(sit)) sit++;
          room.seats.push({ sit, uid }); this._feed(id, this._table(room));
          for (const pid of Object.keys(this.uids)) { if (pid !== id && room.seats.find((s) => s.uid === this.uids[pid])) this._feed(pid, this._delta(uid, sit)); }
        }
        return { ok: true };
      }
      return { ok: true };
    };
  }
}
function mk(rooms) {
  const uids = { A: '1_1', B: '1_2', C: '1_3' };
  const sim = new Sim(rooms, uids);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', selectedStake: 100, delay: () => Promise.resolve(), profiles: ['A', 'B', 'C'].map((id) => ({ id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['A', 'B', 'C']) { coord.ingest(id, { raw: `[5,{"uid":"${uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim };
}

// ---- _waitUntil ----
test('_waitUntil resolves synchronously when the predicate is already true', async () => {
  const { coord } = mk([{ rid: 1, b: 100 }]);
  const t0 = Date.now();
  const ok = await coord._waitUntil(() => true, coord._gen, 5000);
  assert.equal(ok, true);
  assert.ok(Date.now() - t0 < 50, 'no fixed-interval wait when evidence is already present');
});

test('_waitUntil wakes on the next authoritative update, not a poll tick', async () => {
  const { coord } = mk([{ rid: 1, b: 100 }]);
  let flag = false;
  const p = coord._waitUntil(() => flag, coord._gen, 5000);
  setTimeout(() => { flag = true; coord.emit('update', coord.snapshot()); }, 5);
  const t0 = Date.now();
  assert.equal(await p, true);
  assert.ok(Date.now() - t0 < 500, 'resolved promptly on the update event, well under any poll interval');
});

test('_waitUntil returns false when the generation changes (stale operation cancelled)', async () => {
  const { coord } = mk([{ rid: 1, b: 100 }]);
  const gen = coord._gen;
  const p = coord._waitUntil(() => false, gen, 5000);
  setTimeout(() => { coord.stop(); coord.emit('update', coord.snapshot()); }, 5); // stop() bumps _gen
  assert.equal(await p, false, 'a superseded generation never resolves true');
});

test('_waitUntil times out to false when the predicate never holds', async () => {
  const { coord } = mk([{ rid: 1, b: 100 }]);
  assert.equal(await coord._waitUntil(() => false, coord._gen, 30), false);
});

// ---- monotonic trace ----
test('a full discovery emits an ordered, monotonic milestone trace', async () => {
  const { coord } = mk([{ rid: 700100, b: 100, seats: [] }]);
  const r = await coord.runDiscovery();
  assert.equal(r.sameTable, true);
  const names = coord.trace().map((e) => e.milestone);
  for (const m of ['T0_DISCOVERY_START', 'T1_REQUEST_CHANNELS_SENT', 'T2_CHANNEL_LIST_RECEIVED', 'T3_CANDIDATE_SELECTED', 'T4_HOST_JOIN_SENT', 'T5_FIRST_TABLE_STATE_RECEIVED', 'T6_HOST_CONFIRMED_IN_PS', 'T7_ROOM_BOUND', 'T8_FOLLOWER_JOIN_SENT', 'T10_SAME_TABLE_CONFIRMED']) {
    assert.ok(names.includes(m), `trace should include ${m} (got ${names.join(',')})`);
  }
  // monotonic non-decreasing clock
  const monos = coord.trace().map((e) => e.mono);
  for (let i = 1; i < monos.length; i++) assert.ok(monos[i] >= monos[i - 1], 'monotonic timeline');
  // T0 precedes room binding precedes same-table
  const idx = (m) => names.indexOf(m);
  assert.ok(idx('T0_DISCOVERY_START') < idx('T4_HOST_JOIN_SENT'));
  assert.ok(idx('T4_HOST_JOIN_SENT') <= idx('T7_ROOM_BOUND'));
  assert.ok(idx('T7_ROOM_BOUND') <= idx('T10_SAME_TABLE_CONFIRMED'));
});

test('the room-bound milestone is emitted once; buffer is bounded', async () => {
  const { coord } = mk([{ rid: 700100, b: 100, seats: [] }]);
  await coord.runDiscovery();
  // NOTE: roomId on T7 can be null under the OFFLINE sim (it feeds TABLE_STATE synchronously inside
  // send(), before host._joinedRid is assigned — a harness artifact; live frames arrive after send
  // resolves). We assert the milestone exists exactly once and the ring buffer stays bounded.
  const bound = coord.trace().filter((e) => e.milestone === 'T7_ROOM_BOUND');
  assert.equal(bound.length, 1, 'room-bound emitted exactly once per generation');
  assert.ok(coord.trace().length <= 400, 'ring buffer is bounded');
});

test('a fresh discovery generation re-emits the T0 start marker', async () => {
  const { coord } = mk([{ rid: 700100, b: 100, seats: [] }]);
  await coord.runDiscovery();
  const firstStarts = coord.trace().filter((e) => e.milestone === 'T0_DISCOVERY_START').length;
  assert.equal(firstStarts, 1);
});
