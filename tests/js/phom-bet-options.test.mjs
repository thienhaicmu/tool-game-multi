// PHASE 6.2.3 — REAL bet options after game entry + stake-filtered discovery. Bet options are the DISTINCT
// server stakes (rs[].b) from a browser's own channel list (never hard-coded). The finder chooses one; the
// discovery filters candidates by candidate.b === selectedStake, joins the table's real rid, confirms ps[].
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

class DiscoverySim {
  constructor(rooms) { this.rooms = rooms.map((r) => ({ Mu: 4, ...r, seats: (r.seats || []).map((s) => ({ ...s })) })); this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' }; this.coord = null; this.joinLog = []; }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _channelList() { const rs = this.rooms.map((r) => ({ rid: r.rid, b: r.b, uC: r.seats.length, Mu: r.Mu, zn: 'Simms', gid: 8, rn: 'Phom' })); return JSON.stringify([5, { rs, cmd: 300 }]); }
  _table(r) { return JSON.stringify([5, { b: r.b, ps: r.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _room(rid) { return this.rooms.find((r) => r.rid === rid); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this._feed(id, this._channelList()); return { ok: true }; }
      if (j[0] === 3) { this.joinLog.push({ id, rid: j[2] }); const room = this._room(j[2]); if (room && !room.seats.find((s) => s.uid === uid) && room.seats.length < room.Mu) { room.seats.push({ uid, sit: room.seats.length }); this._feed(id, this._table(room)); } return { ok: true }; }
      return { ok: true };
    };
  }
}
function mk(rooms, feedChannels = true) {
  const sim = new DiscoverySim(rooms);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), findBudgetMs: 40, findPollMs: 10, profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) { coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  // seed each browser's channel list (as if it had entered the game + received rs[])
  if (feedChannels) for (const id of ['B1', 'B2', 'B3']) sim._feed(id, sim._channelList());
  return { coord, sim };
}

// three real stakes advertised by the server; two empty tables at 500 and 1000, one full at 200
const ROOMS = [
  { rid: 700100, b: 500, Mu: 4, seats: [] },
  { rid: 700200, b: 1000, Mu: 4, seats: [] },
  { rid: 700300, b: 200, Mu: 4, seats: [{ sit: 0, uid: 'a' }, { sit: 1, uid: 'b' }, { sit: 2, uid: 'c' }, { sit: 3, uid: 'd' }] },
  { rid: 700400, b: 100, Mu: 4, seats: Array.from({ length: 60 }, (_, i) => ({ sit: i, uid: 'x' + i })) }, // bucket
];

// 3/4 — bet options are the DISTINCT server stakes from the browser's own channel list (not hard-coded)
test('bet options are the distinct SERVER stakes from the channel list (per browser)', () => {
  const { coord } = mk(ROOMS);
  const b1 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1');
  assert.deepEqual(b1.betOptions, [100, 200, 500, 1000], 'distinct server stakes, sorted');
});

// 1 — before a browser has a channel list, bet options are empty (no fallback list)
test('no channel list yet => empty bet options (no hard-coded fallback)', () => {
  const { coord } = mk(ROOMS, false); // do not seed channels
  const b1 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1');
  assert.deepEqual(b1.betOptions, []);
});

// 11/14/15/16 — discovery filters by the chosen stake; rid+stake come from the matching table
test('discovery selects a table whose b === selectedStake; rid+stake come from that table', async () => {
  const { coord, sim } = mk(ROOMS);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.rid, 700200, 'the empty 1000 table, not the 500 one');
  assert.equal(r.stake, 1000, 'stake is the table b (=== selected)');
  assert.ok(sim.joinLog.some((j) => j.rid === 700200), 'joined the matching table rid');
  assert.equal(sim.joinLog.some((j) => j.rid === 700100), false, 'never joined the other-stake table');
});

test('a different chosen stake selects a different table', async () => {
  const { coord } = mk(ROOMS);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500 });
  assert.equal(r.rid, 700100);
  assert.equal(r.stake, 500);
});

// 12/13 — full table at the chosen stake is rejected (no auto-switch to another stake, §7/§17)
test('chosen stake has only a FULL table => PHOM_NO_EMPTY_TABLE (never auto-switches stake)', async () => {
  const { coord, sim } = mk(ROOMS);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 200, timeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_EMPTY_TABLE');
  assert.equal(sim.joinLog.length, 0, 'no join attempted; no fallback to a different stake');
});

// 9/JOIN — JOIN uses candidate.rid (a room code), never the stake value
test('JOIN uses the table rid, not the stake value', async () => {
  const { coord, sim } = mk(ROOMS);
  await coord.manualDiscoverTable('B1', { selectedStake: 500 });
  assert.ok(sim.joinLog.every((j) => j.rid !== 500), 'never joined using the stake as a room code');
  assert.ok(sim.joinLog.some((j) => j.rid === 700100));
});

// stake not among the advertised options => no table, typed failure (never invents one)
test('a stake with no advertised table => PHOM_NO_EMPTY_TABLE', async () => {
  const { coord } = mk(ROOMS);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 999999, timeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_EMPTY_TABLE');
});
