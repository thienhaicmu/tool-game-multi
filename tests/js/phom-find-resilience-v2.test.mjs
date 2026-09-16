// PHASE 6.3.5 — FIND RESILIENCE V2. Post-anchor capacity verification (freeSlots >= 2 after P1 is seated),
// bounded generation-safe P1 re-anchor, and bounded single-flight follower same-RID retry with authoritative
// same-room proof. P2/P3 NEVER discover. Driven by the REAL coordinator + a deterministic server sim that can
// (a) inject fillers when P1 seats (capacity race) and (b) reject a follower's first N joins (transient fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

class Sim {
  constructor(rooms) {
    this.rooms = rooms.map((r) => ({ Mu: 4, injectOnJoin: 0, failJoins: {}, ...r, seats: (r.seats || []).map((s) => ({ ...s })) }));
    this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' }; this.coord = null; this.channelReqs = 0; this.joinAttempts = {};
  }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _channelList() { const rs = this.rooms.map((r) => ({ rid: r.rid, b: r.b, uC: r.seats.length, Mu: r.Mu, zn: 'Simms', gid: 8, rn: 'Phom' })); return JSON.stringify([5, { rs, cmd: 300 }]); }
  _table(r) { return JSON.stringify([5, { b: r.b, ps: r.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _room(rid) { return this.rooms.find((r) => r.rid === rid); }
  attemptsFor(rid, id) { return this.joinAttempts[`${rid}:${id}`] || 0; }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this.channelReqs++; this._feed(id, this._channelList()); return { ok: true }; }
      if (j[0] === 3) {
        const rid = j[2]; const room = this._room(rid); if (!room) return { ok: true };
        const key = `${rid}:${id}`; this.joinAttempts[key] = (this.joinAttempts[key] || 0) + 1;
        const fail = (room.failJoins && room.failJoins[id]) || 0;
        if (this.joinAttempts[key] <= fail) { this._feed(id, this._table(room)); return { ok: true }; } // transient: ps[] WITHOUT us
        if (id === 'B1' && room.injectOnJoin && !room._injected) { room._injected = true; for (let i = 0; i < room.injectOnJoin; i++) room.seats.push({ sit: room.seats.length, uid: 'inj' + room.seats.length }); }
        if (!room.seats.find((s) => s.uid === uid) && room.seats.length < room.Mu) room.seats.push({ uid, sit: room.seats.length });
        this._feed(id, this._table(room)); return { ok: true };
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
const snapB = (coord, id) => coord.manualBrowserSnapshot().find((b) => b.profileId === id);

// ================= POST-ANCHOR CAPACITY (RES-01..05) =================
test('RES-01: P1 anchor with 3 free slots after seating → VALID', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]); // Mu4 empty → after P1: freeAfter=3
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 });
  assert.equal(r.ok, true); assert.equal(r.anchorValid, true); assert.equal(r.freeAfter, 3);
});
test('RES-02: P1 anchor with exactly 2 free slots after seating → VALID', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [{ sit: 0, uid: 'x' }] }]); // uC1 → after P1: freeAfter=2
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 });
  assert.equal(r.ok, true); assert.equal(r.freeAfter, 2); assert.equal(r.anchorValid, true);
});
test('RES-03: P1 anchor with only 1 free slot after seating → INVALID (bounded, exhausted)', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }]); // after P1: 3 seated → freeAfter=1
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 });
  assert.equal(r.ok, false); assert.equal(r.resilienceExhausted, true);
  assert.equal(r.error.code, 'PHOM_FIND_RESILIENCE_EXHAUSTED');
});
test('RES-04: P1 anchor with 0 free slots after seating → INVALID', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 3 }]); // after P1: 4 seated → freeAfter=0
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 });
  assert.equal(r.ok, false); assert.equal(r.resilienceExhausted, true);
});
test('RES-05: an invalid anchor does NOT publish a shared RID (anchorValid false / no rid)', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }]);
  await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 });
  const b1 = snapB(coord, 'B1');
  assert.notEqual(b1.manualState, 'JOINED', 'an invalid anchor is not left in JOINED');
  assert.equal(b1.rid, null, 'no RID is left for followers to pick up');
});

// ================= BOUNDED RE-ANCHOR (RES-06/07/08) =================
test('RES-06/07: an invalid anchor triggers a bounded re-FIND that lands a NEW valid RID', async () => {
  // Room 700 is the emptiest (picked first) but fills on P1 join → invalid; Room 701 is valid.
  const { coord } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }, { rid: 701, b: 500, seats: [{ sit: 0, uid: 'x' }] }]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.rid, 701, 're-anchored to the second, valid table');
  assert.equal(r.anchorValid, true);
});
test('RES-08: the invalidated old RID is blacklisted and P1 now holds the NEW rid (old cannot overwrite)', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }, { rid: 701, b: 500, seats: [{ sit: 0, uid: 'x' }] }]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 1 });
  assert.equal(snapB(coord, 'B1').rid, 701);
  assert.notEqual(r.rid, 700);
});

// ================= FOLLOWER RETRY (RES-09..16) =================
async function anchor(coord, sim) { const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 }); assert.equal(r.ok, true); return r.rid; }
test('RES-09/10: P2 first same-RID JOIN fails, retry succeeds and is confirmed from ps[]', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B2: 1 } }]);
  const rid = await anchor(coord, sim);
  const r = await coord.manualJoinShared('B2', rid, { maxRetries: 2, timeoutMs: 120 });
  assert.equal(r.ok, true); assert.equal(r.sameRoom, true); assert.ok(r.attempts >= 2);
});
test('RES-11/12: P3 first same-RID JOIN fails, retry succeeds and is confirmed', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B3: 1 } }]);
  const rid = await anchor(coord, sim);
  await coord.manualJoinShared('B2', rid, { maxRetries: 2, timeoutMs: 120 });
  const r = await coord.manualJoinShared('B3', rid, { maxRetries: 2, timeoutMs: 120 });
  assert.equal(r.ok, true); assert.equal(r.sameRoom, true);
});
test('RES-13/14/19/20: a follower whose retries are exhausted → FOLLOWER_ERROR and NEVER discovers', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B2: 99 } }]); // always rejects B2
  const rid = await anchor(coord, sim);
  const before = sim.channelReqs;
  const r = await coord.manualJoinShared('B2', rid, { maxRetries: 2, timeoutMs: 60 });
  assert.equal(r.ok, false); assert.equal(r.retriesExhausted, true);
  assert.equal(snapB(coord, 'B2').manualState, 'FOLLOWER_ERROR');
  assert.equal(sim.channelReqs, before, 'a follower never sends CMD 300 / never becomes a finder');
});
test('RES-15: a syntactically invalid RID is rejected immediately with no pointless retries', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [] }]);
  const r = await coord.manualJoinShared('B2', 'not-a-rid', { maxRetries: 2, timeoutMs: 60 });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'PHOM_INVALID_RID');
  assert.equal(sim.attemptsFor(700, 'B2'), 0, 'no join attempts for an invalid rid');
});
test('RES-16: a dead session cancels the follower retry cleanly', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B2: 99 } }]);
  const rid = await anchor(coord, sim);
  coord.stop();
  const r = await coord.manualJoinShared('B2', rid, { maxRetries: 3, timeoutMs: 60 });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'PHOM_OPERATION_CANCELLED');
});

// ================= CANCELLATION / RACE (RES-17/18/25/26/27) =================
test('RES-17: a browser disconnect mid-retry cancels the follower retry (superseded)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B2: 99 } }]);
  const rid = await anchor(coord, sim);
  const p = coord.manualJoinShared('B2', rid, { maxRetries: 5, timeoutMs: 120 });
  coord.markDisconnected('B2'); // dead socket bumps the follower generation
  const r = await p;
  assert.equal(r.ok, false); assert.ok(r.superseded || (r.error && r.error.code === 'PHOM_OPERATION_CANCELLED'));
});
test('RES-18: when the anchor RID changes mid-retry, the old-RID retry is cancelled (ridChanged)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B2: 99 } }, { rid: 800, b: 500, seats: [] }]);
  const rid = await anchor(coord, sim); // P1 on 700
  const p = coord.manualJoinShared('B2', rid, { maxRetries: 9, timeoutMs: 80 });
  await coord.manualLeave('B1');
  await coord.manualJoinRoom('B1', 800, {}); // P1 re-anchors to 800
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(r.ridChanged || r.superseded, 'stale-RID retry is cancelled, not a parallel flow');
});
test('RES-25: concurrent follower JOINs of the SAME rid are single-flight (second → IN_FLIGHT)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B2: 1 } }]);
  const rid = await anchor(coord, sim);
  const p1 = coord.manualJoinShared('B2', rid, { maxRetries: 2, timeoutMs: 120 });
  const p2 = coord.manualJoinShared('B2', rid, { maxRetries: 2, timeoutMs: 120 });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok((r1.ok && r2.error && r2.error.code === 'PHOM_FOLLOW_IN_FLIGHT') || (r2.ok && r1.error && r1.error.code === 'PHOM_FOLLOW_IN_FLIGHT'));
});
test('RES-26: concurrent P1 discovery is single-flight even under recovery (only one re-FIND)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }, { rid: 701, b: 500, seats: [{ sit: 0, uid: 'x' }] }]);
  const p1 = coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 1 });
  const p2 = coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 1 });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok((r1.ok && r2.error && r2.error.code === 'PHOM_FIND_IN_FLIGHT') || (r2.ok && r1.error && r1.error.code === 'PHOM_FIND_IN_FLIGHT'));
});
test('RES-27: a permanently-failing follower JOIN terminates (bounded, never loops forever)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B2: 99 } }]);
  const rid = await anchor(coord, sim);
  const r = await coord.manualJoinShared('B2', rid, { maxRetries: 2, timeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(sim.attemptsFor(700, 'B2'), 3, 'exactly maxRetries+1 (=3) attempts — bounded');
});

// ================= SAME-ROOM PROOF (RES-21/22/23/24) =================
test('RES-21/22: same-room proof P1+P2 then P1+P2+P3 from authoritative ps[]', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [] }]);
  const rid = await anchor(coord, sim);
  const b = await coord.manualJoinShared('B2', rid, { timeoutMs: 120 });
  assert.ok(b.membership.includes('1_1') && b.membership.includes('1_2'));
  const c = await coord.manualJoinShared('B3', rid, { timeoutMs: 120 });
  assert.ok(c.membership.includes('1_1') && c.membership.includes('1_2') && c.membership.includes('1_3'));
});
test('RES-23: capacity race — qualifies at discovery but fills on JOIN → invalid, not published (maxRecovery 0)', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [{ sit: 0, uid: 'x' }], injectOnJoin: 1 }]); // uC1 qualifies; +inject+P1 → 3
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 });
  assert.equal(r.ok, false);
  assert.equal(snapB(coord, 'B1').rid, null);
});
test('RES-24: capacity change right after P1 JOIN is caught by the authoritative post-anchor check', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }, { rid: 701, b: 500, seats: [{ sit: 0, uid: 'y' }] }]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 1 });
  assert.equal(r.ok, true); assert.equal(r.rid, 701); // recovered to a table that survives the check
});

// ================= SAFETY (RES-28/29/30) — source scan =================
test('RES-28/29/30: the V2 resilience code emits NO game command / no restart / no CDP click', () => {
  const coord = readFileSync(new URL('../../desktop/protocol/phom/host-table-coordinator.cjs', import.meta.url), 'utf8');
  const region = coord.slice(coord.indexOf('async manualDiscoverTable('), coord.indexOf('// REJOIN ONE browser'));
  for (const forbidden of ['buildPlayFrame', 'buildDrawFrame', 'buildMeldFrame', 'buildReadyFrame', 'Input.dispatch', '.click(', 'closeRun', 'restart', 'reopen']) {
    assert.equal(region.includes(forbidden), false, `resilience code must not reference ${forbidden}`);
  }
  // the JOIN + LEAVE wire frames are the existing ones (no new protocol)
  assert.match(coord, /buildJoinFrame\(r\)/);
  assert.match(coord, /buildLeaveFrame\(\)/);
});
