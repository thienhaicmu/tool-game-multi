// PHASE 6 — MANUAL per-browser table control (no host/follower role). Each browser is driven
// independently: FIND / JOIN by RID / REJOIN / LEAVE, confirmed from that browser's OWN ps[]. Uses the
// same captured-shape room-based server model. Offline only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

class RoomSim {
  constructor({ policy, dropJoin } = {}) {
    this.rooms = new Map(); this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' }; this.dn = { B1: 'Nguyễn Văn A', B2: 'Nguyễn Văn B', B3: 'Nguyễn Văn C' };
    this.coord = null; this.joinLog = []; this.leaveLog = []; this.policy = policy || ((id, rid) => rid); this.dropJoin = dropJoin || new Set();
  }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _room(rid) { if (!this.rooms.has(rid)) this.rooms.set(rid, { rid, seats: [] }); return this.rooms.get(rid); }
  _table(room) { return JSON.stringify([5, { b: 100, ps: room.seats.map((s) => ({ uid: s.uid, sit: s.sit, dn: s.dn, r: false })), cmd: 202 }]); }
  _delta(uid, sit, dn) { return JSON.stringify([5, { p: { uid, sit, dn, r: false }, t: 1, cmd: 200 }]); }
  _idOf(uid) { return Object.keys(this.uids).find((k) => this.uids[k] === uid); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id], dn = this.dn[id];
      if (j[0] === 3) {
        const requested = j[2]; const actual = this.policy(id, requested); this.joinLog.push({ id, requested, actual });
        if (this.dropJoin.has(id)) return { ok: true };
        const room = this._room(actual);
        if (!room.seats.find((s) => s.uid === uid)) {
          const sit = room.seats.length; room.seats.push({ uid, sit, dn }); this._feed(id, this._table(room));
          for (const pid of Object.keys(this.uids)) { if (pid !== id && room.seats.find((s) => s.uid === this.uids[pid])) this._feed(pid, this._delta(uid, sit, dn)); }
        }
        return { ok: true };
      }
      if (j[0] === 4) { this.leaveLog.push({ id }); for (const r of this.rooms.values()) r.seats = r.seats.filter((s) => s.uid !== uid); return { ok: true }; }
      return { ok: true };
    };
  }
}
function mk(simOpts) {
  const sim = new RoomSim(simOpts);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, selectedStake: 100, delay: () => Promise.resolve(), profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) { coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim };
}

// 1/2/3 — any browser can FIND first (no host role)
test('any browser can FIND a table first and gets its own RID', async () => {
  const { coord } = mk();
  const r2 = await coord.manualFindTable('B2', 139);
  assert.equal(r2.ok, true);
  assert.equal(r2.state, 'FOUND');
  assert.equal(r2.roomAnchor, 139);
  assert.equal(r2.rid, 139);
  // no host was assigned; B1/B3 untouched
  const snap = coord.manualBrowserSnapshot();
  assert.equal(snap.find((b) => b.profileId === 'B2').manualState, 'JOINED');
  assert.equal(snap.find((b) => b.profileId === 'B1').rid, null);
});

// 4/5 — another browser joins the FIRST browser's RID
test('B1 and B3 JOIN the RID that B2 found => all three co-seated', async () => {
  const { coord, sim } = mk();
  const found = await coord.manualFindTable('B2', 139);
  const rid = found.rid;
  const r1 = await coord.manualJoinRoom('B1', rid);
  const r3 = await coord.manualJoinRoom('B3', rid);
  assert.equal(r1.ok, true); assert.equal(r1.state, 'JOINED');
  assert.equal(r3.ok, true);
  // B1 and B3 requested B2's exact RID (never a fresh stake matchmake)
  assert.deepEqual(sim.joinLog.filter((j) => j.id !== 'B2').map((j) => j.requested), [rid, rid]);
  assert.ok(r3.membership.includes('1_1') && r3.membership.includes('1_2') && r3.membership.includes('1_3'));
});

// 6 — leave one browser does not affect the others
test('B2 LEAVE only affects B2; B1/B3 keep their state', async () => {
  const { coord, sim } = mk();
  const f = await coord.manualFindTable('B1', 139);
  await coord.manualJoinRoom('B2', f.rid);
  await coord.manualJoinRoom('B3', f.rid);
  const before = coord.manualBrowserSnapshot();
  assert.equal(before.find((b) => b.profileId === 'B3').manualState, 'JOINED');
  const lv = await coord.manualLeave('B2');
  assert.equal(lv.ok, true); assert.equal(lv.state, 'LEFT');
  assert.deepEqual(sim.leaveLog, [{ id: 'B2' }], 'only B2 left');
  const after = coord.manualBrowserSnapshot();
  assert.equal(after.find((b) => b.profileId === 'B2').manualState, 'LEFT');
  assert.equal(after.find((b) => b.profileId === 'B2').rid, null);
  assert.equal(after.find((b) => b.profileId === 'B1').manualState, 'JOINED', 'B1 untouched');
  assert.equal(after.find((b) => b.profileId === 'B3').manualState, 'JOINED', 'B3 untouched');
});

// 7/8/9 — rejoin uses the browser's OWN last RID
test('REJOIN uses the browser\'s own last RID (never a fresh find)', async () => {
  const { coord, sim } = mk();
  const f = await coord.manualFindTable('B1', 139);
  await coord.manualLeave('B1');
  const rj = await coord.manualRejoin('B1');
  assert.equal(rj.ok, true); assert.equal(rj.rid, f.rid);
  // last join in the log for B1 targeted its own prior RID
  const b1joins = sim.joinLog.filter((j) => j.id === 'B1');
  assert.equal(b1joins[b1joins.length - 1].requested, f.rid);
});

// 10 — join empty RID rejected
test('JOIN with an empty/invalid RID is rejected typed', async () => {
  const { coord } = mk();
  const r = await coord.manualJoinRoom('B1', '');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_INVALID_RID');
});

// 11 — rejoin with no known RID rejected
test('REJOIN with no known RID is rejected typed', async () => {
  const { coord } = mk();
  const r = await coord.manualRejoin('B3');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_REJOIN_NO_RID');
});

// 12 — a browser-specific failure does not affect other browsers
test('B2 join failure is isolated; B1/B3 remain usable', async () => {
  const { coord } = mk({ dropJoin: new Set(['B2']) });
  const r2 = await coord.manualFindTable('B2', 139, { timeoutMs: 30 });
  assert.equal(r2.ok, false);
  assert.equal(r2.state, 'JOIN_FAILED');
  // B1 still works
  const r1 = await coord.manualFindTable('B1', 139);
  assert.equal(r1.ok, true);
  const snap = coord.manualBrowserSnapshot();
  assert.equal(snap.find((b) => b.profileId === 'B2').manualState, 'ERROR');
  assert.equal(snap.find((b) => b.profileId === 'B1').manualState, 'JOINED');
});

// independence of the per-browser generation: leaving B2 mid-join does not cancel B1
test('per-browser generation: one browser\'s LEAVE does not cancel another\'s join', async () => {
  const { coord } = mk();
  const f = await coord.manualFindTable('B1', 139);
  const pj = coord.manualJoinRoom('B3', f.rid); // in flight (resolves synchronously here)
  await coord.manualLeave('B2');
  const r3 = await pj;
  assert.equal(r3.ok, true, 'B3 join unaffected by B2 leave');
});

// username — authoritative dn from own seat in ps[]
test('username is the logged-in display name from ps[]; USER_UNKNOWN before seating', async () => {
  const { coord } = mk();
  let snap = coord.manualBrowserSnapshot();
  assert.equal(snap.find((b) => b.profileId === 'B1').username, 'USER_UNKNOWN', 'unknown before join');
  await coord.manualFindTable('B1', 139);
  snap = coord.manualBrowserSnapshot();
  assert.equal(snap.find((b) => b.profileId === 'B1').username, 'Nguyễn Văn A', 'real dn once seated');
  // stable Browser 1/2/3 ordering
  assert.deepEqual(snap.map((b) => b.browserIndex), [1, 2, 3]);
});

// production host coordinator methods remain intact (not removed for the manual UI)
test('production discovery/host methods are preserved alongside the manual API', () => {
  const { coord } = mk();
  for (const m of ['runDiscovery', 'acquireHost', 'runHostAnchoredJoin', 'verifySameTable']) assert.equal(typeof coord[m], 'function');
  for (const m of ['manualFindTable', 'manualJoinRoom', 'manualRejoin', 'manualLeave', 'manualBrowserSnapshot', 'remainingCards']) assert.equal(typeof coord[m], 'function');
});
