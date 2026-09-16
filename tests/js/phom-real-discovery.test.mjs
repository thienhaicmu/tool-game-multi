// PHASE 6.2.1 — REAL table discovery. manualDiscoverTable requests the authoritative channel list
// (server rs[]), picks a QUALIFYING EMPTY table, JOINs its real RID, and confirms from ps[]. The RID and
// STAKE come from the SELECTED SERVER TABLE — never user-entered, never invented. Full tables are rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

// Server model: on CMD 300 the server returns a channel list rs[] (rooms with rid/b(stake)/Mu/uC); on
// JOIN(rid) it seats the joiner and pushes TABLE_STATE ps[]. `rooms` are the advertised tables.
class DiscoverySim {
  constructor(rooms) { this.rooms = rooms.map((r) => ({ Mu: 4, ...r, seats: (r.seats || []).map((s) => ({ ...s })) })); this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' }; this.coord = null; this.joinLog = []; this.channelReqs = 0; }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _channelList() { const rs = this.rooms.map((r) => ({ rid: r.rid, b: r.b, uC: r.seats.length, Mu: r.Mu, zn: 'Simms', gid: 8, rn: 'Phom' })); return JSON.stringify([5, { rs, cmd: 300 }]); }
  _table(r) { return JSON.stringify([5, { b: r.b, ps: r.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _delta(uid, sit) { return JSON.stringify([5, { p: { uid, sit, r: false }, t: 1, cmd: 200 }]); }
  _room(rid) { return this.rooms.find((r) => r.rid === rid); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this.channelReqs++; this._feed(id, this._channelList()); return { ok: true }; }
      if (j[0] === 3) {
        this.joinLog.push({ id, rid: j[2] }); const room = this._room(j[2]); if (!room) return { ok: true };
        if (!room.seats.find((s) => s.uid === uid) && room.seats.length < room.Mu) {
          const sit = room.seats.length; room.seats.push({ uid, sit }); this._feed(id, this._table(room));
          for (const pid of Object.keys(this.uids)) { if (pid !== id && room.seats.find((s) => s.uid === this.uids[pid])) this._feed(pid, this._delta(uid, sit)); }
        } else if (room.seats.length >= room.Mu) { this._feed(id, this._table(room)); }
        return { ok: true };
      }
      if (j[0] === 4) { for (const r of this.rooms) r.seats = r.seats.filter((s) => s.uid !== uid); return { ok: true }; }
      return { ok: true };
    };
  }
}
function mk(rooms) {
  const sim = new DiscoverySim(rooms);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) { coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim };
}

// The list mixes a bucket (uC >> Mu), a FULL table (4/4), and a real empty table with a specific stake.
const MIXED = [
  { rid: 140, b: 100, Mu: 4, seats: Array.from({ length: 70 }, (_, i) => ({ sit: i, uid: 'x' + i })) }, // bucket
  { rid: 141, b: 200, Mu: 4, seats: [{ sit: 0, uid: 'a' }, { sit: 1, uid: 'b' }, { sit: 2, uid: 'c' }, { sit: 3, uid: 'd' }] }, // FULL 4/4
  { rid: 700100, b: 500, Mu: 4, seats: [] }, // real empty table, stake 500
];

test('real discovery: requests the channel list, selects a qualifying EMPTY table, joins its real RID', async () => {
  const { coord, sim } = mk(MIXED);
  const r = await coord.manualDiscoverTable('B1');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'FOUND');
  assert.equal(r.rid, 700100, 'the real empty table');
  assert.ok(sim.channelReqs >= 1, 'requested the authoritative channel list (CMD 300)');
  assert.ok(sim.joinLog.some((j) => j.id === 'B1' && j.rid === 700100), 'joined the discovered RID');
});

test('STAKE comes from the SELECTED SERVER TABLE (b), never user-entered', async () => {
  const { coord } = mk(MIXED);
  const r = await coord.manualDiscoverTable('B1');
  assert.equal(r.stake, 500, 'stake is the discovered table\'s own bet value');
});

test('FULL table (4/4) and the stake BUCKET are rejected; the emptiest real table wins', async () => {
  const { coord, sim } = mk(MIXED);
  await coord.manualDiscoverTable('B1');
  const joined = sim.joinLog.filter((j) => j.id === 'B1').map((j) => j.rid);
  assert.equal(joined.includes(141), false, 'never joined the full 4/4 table');
  assert.equal(joined.includes(140), false, 'never joined the bucket');
});

test('authoritative JOIN confirmation: own uid in own ps[] (not just the send)', async () => {
  const { coord } = mk(MIXED);
  const r = await coord.manualDiscoverTable('B1');
  assert.equal(r.ok, true);
  assert.ok(r.membership.includes('1_1'), 'B1 present in the authoritative membership');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1').manualState, 'JOINED');
});

test('no qualifying empty table => PHOM_NO_EMPTY_TABLE (typed; not a fake success)', async () => {
  const FULL_ONLY = [
    { rid: 141, b: 200, Mu: 4, seats: [{ sit: 0, uid: 'a' }, { sit: 1, uid: 'b' }, { sit: 2, uid: 'c' }, { sit: 3, uid: 'd' }] },
    { rid: 142, b: 300, Mu: 4, seats: [{ sit: 0, uid: 'e' }, { sit: 1, uid: 'f' }, { sit: 2, uid: 'g' }] }, // only 1 free, need 3
  ];
  const { coord } = mk(FULL_ONLY);
  const r = await coord.manualDiscoverTable('B1', { timeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_EMPTY_TABLE');
});

test('discovery takes NO stake argument (the user never selects the stake)', () => {
  const { coord } = mk(MIXED);
  // signature: manualDiscoverTable(profileId, opts = {}) — profileId is the only required arg (opts is
  // defaulted, so .length === 1). It has FEWER required args than manualFindTable(profileId, channel).
  assert.equal(coord.manualDiscoverTable.length, 1, 'manualDiscoverTable(profileId, opts={}) — no stake param');
  assert.ok(coord.manualFindTable.length > coord.manualDiscoverTable.length, 'discovery drops the channel/stake arg');
});

test('discovered RID+stake become the shared room for B2/B3 (no second discovery)', async () => {
  const { coord } = mk(MIXED);
  const first = await coord.manualDiscoverTable('B1');
  // B2/B3 JOIN the discovered RID directly (renderer routes JOIN_SHARED -> manualJoinRoom); no re-discovery
  const r2 = await coord.manualJoinRoom('B2', first.rid);
  const r3 = await coord.manualJoinRoom('B3', first.rid);
  assert.equal(r2.ok, true); assert.equal(r2.rid, 700100);
  assert.equal(r3.ok, true);
  assert.ok(r3.membership.includes('1_1') && r3.membership.includes('1_2') && r3.membership.includes('1_3'));
});
