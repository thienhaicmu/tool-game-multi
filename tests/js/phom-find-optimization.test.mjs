// PHASE 6.3.4 — FIND TABLE OPTIMIZATION. Covers FIND-01…25: Player-1-only discovery, single-flight + no
// duplicate CMD 300, generation/cancellation, qualification (stake + freeSlots>=3 + valid RID), authoritative
// ps[] success, actual-RID handoff, follower JOIN (P2/P3 never discover), and clean timeout/session-dead exit.
// Drives the REAL coordinator + pure header/cluster-state modules with a deterministic server sim (no GUI/live).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const gh = require('../../desktop/protocol/phom/game-header.cjs');
const { qualifyTable } = require('../../desktop/protocol/phom/table-qualify.cjs');
// The repo is type:module, so the .js UMD must be loaded as a classic <script> (vm) to grab its global —
// exactly as the renderer loads it (a .js require() would treat it as ESM and miss the UMD export).
const _mcsCtx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../ui-phom/manual-cluster-state.js', import.meta.url), 'utf8'), _mcsCtx);
const MCS = _mcsCtx.ManualClusterState;

// A deterministic server: CMD 300 → channel list rs[]; JOIN(rid) → seat + TABLE_STATE ps[]. Counts CMD 300s
// and join attempts so we can assert "no duplicate/late CMD 300". Rooms can be mutated to simulate slot loss.
class Sim {
  constructor(rooms) { this.rooms = rooms.map((r) => ({ Mu: 4, ...r, seats: (r.seats || []).map((s) => ({ ...s })) })); this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' }; this.coord = null; this.joinLog = []; this.channelReqs = 0; }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _channelList() { const rs = this.rooms.map((r) => ({ rid: r.rid, b: r.b, uC: r.seats.length, Mu: r.Mu, zn: 'Simms', gid: 8, rn: 'Phom' })); return JSON.stringify([5, { rs, cmd: 300 }]); }
  _table(r) { return JSON.stringify([5, { b: r.b, ps: r.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _room(rid) { return this.rooms.find((r) => r.rid === rid); }
  fill(rid, n) { const r = this._room(rid); for (let i = 0; i < n; i++) r.seats.push({ sit: r.seats.length, uid: 'filler' + r.seats.length }); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this.channelReqs++; this._feed(id, this._channelList()); return { ok: true }; }
      if (j[0] === 3) {
        this.joinLog.push({ id, rid: j[2] }); const room = this._room(j[2]); if (!room) return { ok: true };
        if (!room.seats.find((s) => s.uid === uid) && room.seats.length < room.Mu) { const sit = room.seats.length; room.seats.push({ uid, sit }); this._feed(id, this._table(room)); }
        else if (room.seats.length >= room.Mu) { this._feed(id, this._table(room)); } // FULL → ps[] without us
        return { ok: true };
      }
      if (j[0] === 4) { for (const r of this.rooms) r.seats = r.seats.filter((s) => s.uid !== uid); return { ok: true }; }
      return { ok: true };
    };
  }
}
function mk(rooms) {
  const sim = new Sim(rooms);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) { coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim };
}
const EMPTY500 = () => [{ rid: 700100, b: 500, Mu: 4, seats: [] }];

// ================= FIND-01/02/09/11/12 — P1 discovery happy path =================
test('FIND-01/09/11/12: P1 FIND with a selected stake → JOIN real RID, success from ps[], actual RID', async () => {
  const { coord, sim } = mk(EMPTY500());
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'FOUND');
  assert.equal(r.rid, 700100);           // FIND-12 — actual joined RID (never guessed)
  assert.equal(r.roomAnchor, 700100);
  assert.ok(sim.joinLog.some((j) => j.id === 'B1' && j.rid === 700100)); // FIND-09
  assert.ok(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1').uid); // FIND-11 own uid confirmed
});

test('FIND-02: no selected stake → FIND rejected (PHOM_NO_STAKE_SELECTED), no CMD 300', async () => {
  const { coord, sim } = mk(EMPTY500());
  const r = await coord.manualDiscoverTable('B1', {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_STAKE_SELECTED');
  assert.equal(sim.channelReqs, 0, 'no discovery request without a stake');
});

// ================= FIND-06/07/08 — qualification =================
test('FIND-06: a candidate with the wrong stake is rejected', () => {
  assert.equal(qualifyTable({ rid: 1, b: 200, Mu: 4, uC: 0, zn: 'Simms', gid: 8 }, { selectedStake: 500, zone: 'Simms', gid: 8 }).reason, 'STAKE_MISMATCH');
});
test('FIND-07: freeSlots < 3 (Mu-uC) is rejected (need room for P1+P2+P3)', () => {
  assert.equal(qualifyTable({ rid: 1, b: 500, Mu: 4, uC: 2, zn: 'Simms', gid: 8 }, { selectedStake: 500, need: 3 }).reason, 'NOT_ENOUGH_FREE_SLOTS');
  assert.equal(qualifyTable({ rid: 1, b: 500, Mu: 4, uC: 1, zn: 'Simms', gid: 8 }, { selectedStake: 500, need: 3 }).ok, true);
});
test('FIND-08: an invalid RID candidate is rejected', () => {
  assert.equal(qualifyTable({ rid: null, b: 500, Mu: 4, uC: 0 }, { selectedStake: 500 }).reason, 'INVALID_RID');
});
test('FIND-07b: discovery skips a table without 3 free seats and finds the empty one', async () => {
  const { coord } = mk([{ rid: 900, b: 500, Mu: 4, seats: [{ sit: 0, uid: 'x' }, { sit: 1, uid: 'y' }] }, { rid: 700100, b: 500, Mu: 4, seats: [] }]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500 });
  assert.equal(r.rid, 700100);
});

// ================= FIND-10 — JOIN sent but own UID not in ps[] → not success =================
test('FIND-10: joining a FULL table (own uid never enters ps[]) is NOT success (no hang)', async () => {
  const { coord } = mk([{ rid: 700100, b: 500, Mu: 4, seats: [] }]);
  // manualJoinRoom directly to a table the sim reports FULL → ps[] without us → JOIN_FAILED, typed.
  const full = mk([{ rid: 555, b: 500, Mu: 4, seats: [{ sit: 0, uid: 'a' }, { sit: 1, uid: 'b' }, { sit: 2, uid: 'c' }, { sit: 3, uid: 'd' }] }]);
  const r = await full.coord.manualJoinRoom('B1', 555, { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'JOIN_FAILED');
  assert.equal(r.error.code, 'PHOM_JOIN_NOT_CONFIRMED');
});

// ================= FIND-03/23/24 — single-flight + CMD 300 discipline =================
test('FIND-03/23: duplicate concurrent FIND is single-flight (one CMD 300, second returns IN_FLIGHT)', async () => {
  const { coord, sim } = mk(EMPTY500());
  const p1 = coord.manualDiscoverTable('B1', { selectedStake: 500 });
  const p2 = coord.manualDiscoverTable('B1', { selectedStake: 500 }); // fired while p1 in flight
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'PHOM_FIND_IN_FLIGHT');
  assert.equal(r1.ok, true);
  assert.equal(sim.channelReqs, 1, 'exactly ONE CMD 300 for the duplicate clicks');
});
test('FIND-24: with a fresh qualifying channel list already cached, FIND reuses it (no new CMD 300)', async () => {
  const { coord, sim } = mk(EMPTY500());
  // Pre-load the authoritative channel list as if a RECENT CMD 300 just populated it (fresh timestamp).
  // PHASE 6.3.7 — reuse is gated on freshness, so the cache must be recent for the reuse fast-path to apply.
  coord.ingest('B1', { raw: JSON.stringify([5, { rs: [{ rid: 700100, b: 500, uC: 0, Mu: 4, zn: 'Simms', gid: 8 }], cmd: 300 }]), direction: 'recv', targetId: 'B1', url: 'wss://sim', now: Date.now() });
  const before = sim.channelReqs;
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500 });
  assert.equal(r.ok, true);
  assert.equal(sim.channelReqs, before, 'reused the FRESH cached list — no redundant CMD 300');
});

// ================= FIND-13/22/25 — cancellation / generation / session dead =================
test('FIND-13/25: a leave/reset supersedes an in-flight FIND (stale result, new generation wins)', async () => {
  const { coord } = mk([]); // no rooms → discovery waits
  const p = coord.manualDiscoverTable('B1', { selectedStake: 500, timeoutMs: 2000 });
  coord.resetBrowser('B1'); // bumps _manualGen → cancels the in-flight find
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.result, 'STALE');
});
test('FIND-21: FIND with no qualifying table exits cleanly on timeout (typed, no hang)', async () => {
  const { coord } = mk([{ rid: 1, b: 200, Mu: 4, seats: [] }]); // only a wrong-stake table
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, timeoutMs: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_EMPTY_TABLE');
});
test('FIND-22: a stopped session cancels FIND cleanly', async () => {
  const { coord } = mk([]);
  coord.stop();
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, timeoutMs: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_OPERATION_CANCELLED');
});

// ================= FIND-15 — table loses slot before JOIN =================
test('FIND-15: a table that fills up before JOIN is not silently joined (typed JOIN_FAILED, no hang)', async () => {
  const { coord, sim } = mk(EMPTY500());
  sim.fill(700100, 4); // the table is now FULL by the time we JOIN its rid
  const r = await coord.manualJoinRoom('B1', 700100, { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'JOIN_FAILED');
});

// ================= FIND-16/17 — followers JOIN the shared RID =================
test('FIND-16/17: P2 then P3 JOIN the anchor RID and are confirmed from ps[]', async () => {
  const { coord } = mk(EMPTY500());
  const a = await coord.manualDiscoverTable('B1', { selectedStake: 500 });
  assert.equal(a.ok, true);
  const b = await coord.manualJoinRoom('B2', a.rid, {});
  const c = await coord.manualJoinRoom('B3', a.rid, {});
  assert.equal(b.ok, true); assert.equal(b.rid, a.rid);
  assert.equal(c.ok, true); assert.equal(c.rid, a.rid);
  // same-room proof from authoritative membership (not UI state)
  assert.ok(c.membership.includes('1_1') && c.membership.includes('1_2') && c.membership.includes('1_3'));
});

// ================= FIND-04/05/18/19/20 — Player 1 is the SOLE finder (header decision) =================
test('FIND-04/05: a FOLLOWER (isFinder:false) with no shared RID CANNOT FIND — it waits for the anchor', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', isFinder: false, betOptions: [100] });
  assert.equal(s.primary.action, 'WAIT_ANCHOR');
  assert.equal(s.primary.disabled, true);
  assert.notEqual(s.primary.action, 'FIND');
});
test('FIND-05b: Player 1 (isFinder:true / default) shows TÌM BÀN', () => {
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', isFinder: true, betOptions: [100] }).primary.action, 'FIND');
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', betOptions: [100] }).primary.action, 'FIND'); // default finder
});
test('FIND-18/19: a follower with a shared RID JOINs it (VÀO BÀN) — never a second discovery, even after a fail', () => {
  const joinShared = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', isFinder: false, sharedRid: 700100 });
  assert.equal(joinShared.primary.action, 'JOIN_SHARED');
  // after a failed follower join (manualState ERROR) the RID is still shared → retry VÀO BÀN, NOT FIND
  const afterFail = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'ERROR', isFinder: false, sharedRid: 700100 });
  assert.equal(afterFail.primary.action, 'JOIN_SHARED');
});
test('FIND-20: when the shared RID is gone, only Player 1 becomes the finder again (followers wait)', () => {
  // MCS.reconcile clears a shared RID once no browser is JOINED on it
  const cleared = MCS.reconcile({ searchingBrowserId: null, sharedRid: 700100, sharedRidOwner: 'B1', sharedStake: 500 }, [{ profileId: 'B1', manualState: 'LEFT', rid: null }]);
  assert.equal(cleared.sharedRid, null);
  // with no shared RID: P1 → FIND, P2/P3 → WAIT_ANCHOR
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', isFinder: true, betOptions: [100] }).primary.action, 'FIND');
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', isFinder: false, betOptions: [100] }).primary.action, 'WAIT_ANCHOR');
});

// ================= FIND-14 — old FIND cannot overwrite a newer shared RID =================
test('FIND-14: an old FIND result cannot overwrite an already-published shared RID', () => {
  let st = MCS.create();
  st = MCS.onFindResult(st, 'B1', { ok: true, rid: 700100, stake: 500 }); // P1 publishes the anchor
  assert.equal(st.sharedRid, 700100);
  st = MCS.onFindResult(st, 'B1', { ok: true, rid: 999999, stake: 500 }); // a stale/late result
  assert.equal(st.sharedRid, 700100, 'the first published anchor is authoritative — never overwritten');
});
test('FIND-03b: the cluster search lock blocks a second concurrent searcher (pure state)', () => {
  let st = MCS.create();
  const a = MCS.onFindStart(st, 'B1'); assert.equal(a.action, 'SEARCH'); st = a.state;
  const b = MCS.onFindStart(st, 'B2'); assert.equal(b.action, 'BLOCKED'); // another browser is searching
});
