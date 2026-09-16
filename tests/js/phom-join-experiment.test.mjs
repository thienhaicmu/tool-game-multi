// PHASE 3 · PART B — observe-only native-JOIN experiment. Drives the REAL HostTableCoordinator
// against a modelled Simms server that MATCHMAKES native joins ([3,"Simms",<stake>,""], no room id)
// into rooms of a given capacity — so we can verify the observation + classification logic (SAME /
// PARTIAL / DIFFERENT) and the J0..J6 milestone trace WITHOUT a live server. No room is ever forced;
// B/C send the same native stake join as A and the server decides seating (§13/§22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

// Matchmaking model: every native join to a channel goes to the current fill-room for that channel;
// when a room reaches `capacity`, a new room opens. Joiner gets a full ps[] snapshot; already-seated
// peers get a cmd:200 seat delta (so early joiners converge to the same fingerprint) — exactly the
// live fold path the coordinator relies on.
class MatchmakingSim {
  constructor(capacity) { this.capacity = capacity; this.rooms = []; this.uids = { A: '1_1', B: '1_2', C: '1_3' }; this.coord = null; this.joinLog = []; this._rid = 700000; }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _table(room) { return JSON.stringify([5, { b: 100, ps: room.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _delta(uid, sit) { return JSON.stringify([5, { p: { uid, sit, r: false }, t: 1, cmd: 200 }]); }
  _fillRoom() { let r = this.rooms[this.rooms.length - 1]; if (!r || r.seats.length >= this.capacity) { r = { rid: ++this._rid, seats: [] }; this.rooms.push(r); } return r; }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 3) { // native join [3,"Simms",<stake>,""]
        this.joinLog.push({ id, channel: j[2] });
        const room = this._fillRoom();
        const sit = room.seats.length; room.seats.push({ uid, sit });
        this._feed(id, this._table(room)); // joiner: full ps[]
        for (const pid of Object.keys(this.uids)) { if (pid !== id && room.seats.find((s) => s.uid === this.uids[pid])) this._feed(pid, this._delta(uid, sit)); }
        return { ok: true };
      }
      return { ok: true };
    };
  }
}
function mk(capacity) {
  const sim = new MatchmakingSim(capacity);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', selectedStake: 100, delay: () => Promise.resolve(), profiles: ['A', 'B', 'C'].map((id) => ({ id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['A', 'B', 'C']) { coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim };
}

test('capacity>=3: server seats A/B/C together => ALL_THREE_SAME (observed, not forced)', async () => {
  const { coord, sim } = mk(4);
  const r = await coord.runJoinExperiment(100);
  assert.equal(r.ok, true);
  assert.equal(r.allThreeSame, true);
  assert.equal(r.classification, 'ALL_THREE_SAME');
  assert.ok(r.aTable && r.aTable === r.bTable && r.bTable === r.cTable, 'identical final fingerprints');
  // NEVER forced a room: every join carried the STAKE channel (100), never A's rid.
  assert.ok(sim.joinLog.every((j) => j.channel === 100), 'all native stake joins, no room id forced');
  assert.equal(sim.joinLog.length, 3, 'exactly one native join per profile');
});

test('capacity 1: server splits them => ALL_DIFFERENT', async () => {
  const { coord } = mk(1);
  const r = await coord.runJoinExperiment(100);
  assert.equal(r.allThreeSame, false);
  assert.equal(r.classification, 'ALL_DIFFERENT');
  assert.equal(r.aBSame, false); assert.equal(r.aCSame, false); assert.equal(r.bCSame, false);
  assert.ok(r.aTable && r.bTable && r.cTable && r.aTable !== r.bTable && r.bTable !== r.cTable);
});

test('capacity 2: A+B together, C elsewhere => PARTIAL_SAME', async () => {
  const { coord } = mk(2);
  const r = await coord.runJoinExperiment(100);
  assert.equal(r.classification, 'PARTIAL_SAME');
  assert.equal(r.aBSame, true, 'A and B matchmade together');
  assert.equal(r.aCSame, false); assert.equal(r.bCSame, false);
});

test('emits the J0..J6 experiment milestones in order (host confirmed before B before C)', async () => {
  const { coord } = mk(4);
  await coord.runJoinExperiment(100);
  const names = coord.trace().map((e) => e.milestone);
  for (const m of ['JX0_EXPERIMENT_START', 'J0_HOST_JOIN_SENT', 'J1_HOST_PS_CONFIRMED', 'J2_B_JOIN_SENT', 'J3_B_PS_CONFIRMED', 'J4_C_JOIN_SENT', 'J5_C_PS_CONFIRMED', 'J6_RESULT']) {
    assert.ok(names.includes(m), `missing ${m} (got ${names.join(',')})`);
  }
  const idx = (m) => names.indexOf(m);
  assert.ok(idx('J1_HOST_PS_CONFIRMED') < idx('J2_B_JOIN_SENT'), 'host confirmed before B joins');
  assert.ok(idx('J3_B_PS_CONFIRMED') < idx('J4_C_JOIN_SENT'), 'B confirmed before C joins');
  assert.ok(idx('J5_C_PS_CONFIRMED') < idx('J6_RESULT'), 'C confirmed before the result');
});

test('records per-profile join→ps timing and seat, never forcing a shared room', async () => {
  const { coord } = mk(4);
  const r = await coord.runJoinExperiment(100);
  assert.equal(r.observed.length, 3);
  for (const o of r.observed) { assert.equal(o.seated, true); assert.ok(o.joinToPsMs != null && o.joinToPsMs >= 0, 'monotonic join→ps delta captured'); assert.ok(o.seat != null); }
  assert.equal(r.observed[0].label, 'HOST');
});

test('the experiment bumps the generation (single orchestrator) and is stop-cancellable', async () => {
  const { coord } = mk(4);
  const before = coord._gen;
  await coord.runJoinExperiment(100);
  assert.ok(coord._gen > before, 'experiment is its own generation (cancels any running discovery)');
  // After stop(), a further experiment is refused (guard) — no stale run.
  coord.stop();
  const r = await coord.runJoinExperiment(100);
  assert.equal(r.ok, false);
});

test('missing stake/channel is refused typed (no default room guess)', async () => {
  const sim = new MatchmakingSim(4);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', delay: () => Promise.resolve(), profiles: ['A', 'B', 'C'].map((id) => ({ id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['A', 'B', 'C']) { coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); }
  const r = await coord.runJoinExperiment(null);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_STAKE_SELECTED');
});
