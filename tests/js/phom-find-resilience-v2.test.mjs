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
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), findBudgetMs: 40, findPollMs: 10, profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })) });
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

// ================= PHASE 6.3.7 — LIVE DISCOVERY CORRECTNESS (FIND-LIVE) =================
// A user FIND is a LIVE discovery: fresh table-list evidence, whole-rs[] evaluation, blacklist a RID that
// fails to JOIN and re-discover a different real table, and a precise reason when nothing qualifies.

test('FIND-LIVE-01: fresh CMD 300 → a qualifying candidate → FIND_SUCCESS', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [] }]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.rid, 700);
  assert.ok(sim.channelReqs >= 1, 'a fresh CMD 300 was requested (empty cache)');
});

test('FIND-LIVE-02: a STALE cache never hides the live list — a user FIND forces a fresh CMD 300', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [] }]);
  coord.ingest('B1', { raw: sim._channelList(), direction: 'recv', targetId: 'B1', url: 'wss://sim', now: 1 }); // ancient cache
  const before = sim.channelReqs;
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 100 });
  assert.equal(r.ok, true);
  assert.ok(sim.channelReqs > before, 'stale cache → a fresh CMD 300 was sent');
});

test('FIND-LIVE-02b: a FRESH cache is reused (no redundant CMD 300)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [] }]);
  coord.ingest('B1', { raw: sim._channelList(), direction: 'recv', targetId: 'B1', url: 'wss://sim', now: Date.now() });
  const before = sim.channelReqs;
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 100, cacheFreshMs: 60000 });
  assert.equal(r.ok, true);
  assert.equal(sim.channelReqs, before, 'fresh cache reused → no new CMD 300');
});

test('FIND-LIVE-03: among many rows, pick the one valid candidate (wrong stake / not-enough-slots skipped)', async () => {
  const { coord } = mk([
    { rid: 700, b: 999, seats: [] },                                          // wrong stake
    { rid: 701, b: 500, seats: [{ sit: 0, uid: 'x' }, { sit: 1, uid: 'y' }] }, // freeSlots 2 < 3
    { rid: 702, b: 500, seats: [] },                                          // valid
  ]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.rid, 702);
});

test('FIND-LIVE-04/05: a JOIN failure blacklists the RID and re-discovers a DIFFERENT real table', async () => {
  const { coord, sim } = mk([
    { rid: 700, b: 500, seats: [], failJoins: { B1: 1 } }, // ps[] never lands own uid once → JOIN_FAILED
    { rid: 701, b: 500, seats: [] },                       // the real table
  ]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 1, timeoutMs: 60, budgetMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.rid, 701, 'joined the SECOND table after the first failed');
  assert.equal(sim.attemptsFor(700, 'B1'), 1, 'the failed RID was tried once and never retried (blacklisted)');
});

test('FIND-LIVE-10: a JOIN that never lands own uid in ps[] is NOT success', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B1: 99 } }]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r.ok, false); // own uid never in ps[] → never FIND_SUCCESS
});

test('FIND-LIVE: NO_TABLE carries a precise, debuggable reason', async () => {
  const wrongStake = mk([{ rid: 700, b: 999, seats: [] }]);
  const r1 = await wrongStake.coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'NO_MATCHING_STAKE');

  const full = mk([{ rid: 700, b: 500, seats: [{ sit: 0, uid: 'x' }, { sit: 1, uid: 'y' }] }]); // freeSlots 2 < 3
  const r2 = await full.coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'NOT_ENOUGH_FREE_SLOTS');
});

// ================= BLACKLIST SCOPE (FIND-BL) — a blacklist must not outlive its discovery run =================
// The RID blacklist exists so the bounded re-anchor loop never re-picks the room that just proved bad. A
// coordinator-wide set was never cleared in the manual flow, so every transient capacity race permanently hid
// one more real table from all three browsers — after a few TÌM BÀN clicks the lobby looked empty.
test('FIND-BL-01: a NEW FIND is not blinded by the previous FIND blacklist', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }]); // fills to 3 on P1 join → invalid
  const r1 = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r1.ok, false, 'the capacity race invalidates the only table');

  sim.rooms[0].seats.length = 0; // the fillers left: the SAME table is empty and joinable again
  const r2 = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r2.ok, true, 'a fresh FIND starts from the full server list, not a session-long blacklist');
  assert.equal(r2.rid, 700);
});

test('FIND-BL-02: one browser failed FIND does not hide that table from another browser', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }]);
  const r1 = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r1.ok, false);

  sim.rooms[0].seats.length = 0;
  const r2 = await coord.manualDiscoverTable('B2', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r2.ok, true, 'the blacklist is per discovery run, never shared across browsers');
  assert.equal(r2.rid, 700);
});

test('FIND-BL-03: within ONE run the blacklist still applies (no re-pick of the failed RID)', async () => {
  // Unchanged 6.3.5 behaviour: 700 invalidates on join, the recovery pass must move to 701.
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], injectOnJoin: 2 }, { rid: 701, b: 500, seats: [] }]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 1, timeoutMs: 60, budgetMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.rid, 701);
  assert.equal(sim.attemptsFor(700, 'B1'), 1, 'the invalidated RID was never re-picked inside the same run');
});

// ================= FAILURE REASON REACHES THE USER (FIND-MSG) =================
// `reason` is the field that makes a FIND failure diagnosable, but the header (⚠ tooltip) and the Tool's
// errText only render error.message — so the reason has to be in the message too.
test('FIND-MSG-01: the NO_EMPTY_TABLE message names the reason and how many tables were examined', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [{ sit: 0, uid: 'x' }, { sit: 1, uid: 'y' }] }]); // free 2 < 3
  // The budget must be MANY poll windows wide: this test asserts the search re-asked the server, and with a
  // budget only a few polls wide a loaded CI box can spend the whole budget inside the first wait.
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60, budgetMs: 400, pollMs: 20 });
  assert.equal(r.reason, 'NOT_ENOUGH_FREE_SLOTS');
  assert.match(r.error.message, /mức cược 500/);
  assert.match(r.error.message, /3 ghế trống/);
  assert.match(r.error.message, /xét 1 bàn/);
  // §32 — it also says how hard it looked, so "tìm không ra bàn" can be told apart from "hỏi đúng 1 lần"
  assert.match(r.error.message, /đã hỏi máy chủ \d+ lần/);
  assert.ok(r.attempts >= 2, `a persistent search re-asks the server (attempts=${r.attempts})`);
});

test('FIND-MSG-02: a lobby holding only stake BUCKETS reports ONLY_STAKE_BUCKETS, not NO_MATCHING_STAKE', async () => {
  // A stake bucket reports uC >> Mu; it is not a joinable table. Reporting it as "no table at this stake"
  // pointed diagnosis at the stake instead of the lobby.
  const bucket = { rid: 140, b: 500, Mu: 4, seats: Array.from({ length: 70 }, (_, i) => ({ sit: i, uid: 'x' + i })) };
  const { coord } = mk([bucket]);
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ONLY_STAKE_BUCKETS');
  assert.match(r.error.message, /nhóm cược/);
});

// ================= SHARED ANCHOR (FIND-ANC) — who the same-room proof compares against =================
// The shipped default is NO finder chosen. The header publishes the RID of whichever browser actually
// joined, so the coordinator must prove co-seating against THAT browser — not against the first profile.
test('FIND-ANC-01: with no finder chosen, the anchor is the browser that actually joined', async () => {
  const { coord } = mk([{ rid: 555, b: 500, seats: [] }]);
  assert.equal(coord.finderId(), null, 'the shipped default: no finder chosen');
  const f = await coord.manualDiscoverTable('B2', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(f.ok, true);
  assert.equal(coord._anchor().id, 'B2', 'not B1 (the first profile), which is still in the lobby');
});

test('FIND-ANC-02: a follower joining the published RID is confirmed, not reported as ROOM_MISMATCH', async () => {
  const { coord } = mk([{ rid: 555, b: 500, seats: [] }]);
  const f = await coord.manualDiscoverTable('B2', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  // what phom-main's headerSharedRid publishes to the other browsers
  const shared = coord.manualBrowserSnapshot().find((b) => b.manualState === 'JOINED' && b.rid != null && b.anchorValid !== false).rid;
  assert.equal(shared, f.rid);

  const j = await coord.manualJoinShared('B3', shared, { timeoutMs: 60 });
  assert.equal(j.ok, true);
  assert.equal(j.sameRoom, true);
  assert.equal(snapB(coord, 'B3').manualState, 'JOINED');
});

test('FIND-ANC-03: a browser whose follower JOIN failed never becomes the anchor', async () => {
  const { coord } = mk([{ rid: 555, b: 500, seats: [] }, { rid: 556, b: 500, seats: [], failJoins: { B3: 99 } }]);
  const f = await coord.manualDiscoverTable('B2', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(f.ok, true);
  const bad = await coord.manualJoinShared('B3', 556, { timeoutMs: 40, maxRetries: 0 });
  assert.equal(bad.ok, false);
  assert.equal(coord._anchor().id, 'B2', 'a stale _joinedRid on an errored browser must not win the anchor');
});

test('FIND-ANC-04: when no browser holds a room there is no anchor uid to prove against', async () => {
  const { coord } = mk([{ rid: 555, b: 500, seats: [] }]);
  assert.equal(coord._anchorUid(), null, 'never the first profile uid while it sits in the lobby');
  const f = await coord.manualDiscoverTable('B2', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(f.ok, true);
  assert.equal(coord._anchorUid(), '1_2');
  await coord.manualLeave('B2');
  assert.equal(coord._anchorUid(), null, 'the anchor left → fall back to the follower own ps[] evidence');
});

// ================= REJOIN TARGET (FIND-RJ) =================
test('FIND-RJ-01: REJOIN returns to a room actually joined, never one that only failed', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [], failJoins: { B1: 99 } }, { rid: 701, b: 500, seats: [] }]);
  const bad = await coord.manualJoinRoom('B1', 700, { timeoutMs: 40 });
  assert.equal(bad.ok, false, 'never seated at 700');
  const good = await coord.manualJoinRoom('B1', 701, { timeoutMs: 60 });
  assert.equal(good.ok, true);
  await coord.manualLeave('B1');
  assert.equal(snapB(coord, 'B1').lastRid, 701, 'the failed RID never became the REJOIN fallback');

  const again = await coord.manualRejoin('B1', { timeoutMs: 60 });
  assert.equal(again.ok, true);
  assert.equal(again.rid, 701);
  assert.ok(sim.attemptsFor(701, 'B1') >= 2);
});

test('FIND-ANC-05: a follower error names the browser that really holds the room, not always "Player 1"', async () => {
  const { coord } = mk([{ rid: 555, b: 500, seats: [] }, { rid: 556, b: 500, seats: [] }]);
  const f = await coord.manualDiscoverTable('B2', { selectedStake: 500, maxRecovery: 0, timeoutMs: 60 });
  assert.equal(f.ok, true);
  const stale = await coord.manualJoinShared('B3', 556, { timeoutMs: 60, maxRetries: 0 }); // anchor is at 555
  assert.equal(stale.ok, false);
  assert.equal(stale.ridChanged, true);
  assert.match(stale.error.message, /Player 2/, 'B2 is the anchor — the message must say so');
  assert.doesNotMatch(stale.error.message, /Player 1/);
});

// ================= PERSISTENT FIND (FIND-P) — one click keeps looking =================
// Asking the server once and giving up was why a user saw "không tìm thấy bàn" while a table freed up two
// seconds later. One click now re-asks until its budget runs out, and stops the moment a table qualifies.
test('FIND-P-01: a table that appears AFTER the first CMD 300 is still found', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [{ sit: 0, uid: 'a' }, { sit: 1, uid: 'b' }] }]); // free 2 < 3
  setTimeout(() => { sim.rooms[0].seats.length = 0; }, 40); // two players stand up mid-search
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, budgetMs: 400, pollMs: 20 });
  assert.equal(r.ok, true, 'the search was still running when the table freed up');
  assert.equal(r.rid, 700);
  assert.ok(sim.channelReqs >= 2, `re-asked the server (${sim.channelReqs} times)`);
});

test('FIND-P-02: the search is bounded by its budget, never a while(true)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 999, seats: [] }]); // never a table at the chosen stake
  const t0 = Date.now();
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, budgetMs: 300, pollMs: 15 });
  const ms = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.ok(ms >= 300, `spent its budget (${ms}ms)`);
  assert.ok(ms < 3000, `stopped at the budget instead of running on (${ms}ms)`);
  assert.ok(sim.channelReqs >= 3, `polled repeatedly (${sim.channelReqs} requests)`);
});

test('FIND-P-03: a successful find returns immediately — the budget is a ceiling, not a delay', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  const t0 = Date.now();
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, budgetMs: 2000, pollMs: 500 });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 300, 'an available table is joined at once');
});

test('FIND-P-04: the budget caps the WHOLE operation, including join retries', async () => {
  const full = (rid) => ({ rid, b: 500, seats: [], failJoins: { B1: 99 } }); // each join burns a full timeoutMs
  const { coord } = mk([full(700), full(701), full(702)]);
  const t0 = Date.now();
  await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 2, timeoutMs: 100, budgetMs: 120, pollMs: 40 });
  const ms = Date.now() - t0;
  assert.ok(ms < 600, `re-anchor passes stop once the budget is gone (${ms}ms)`);
});

// ================= CANCEL (FIND-C) — the way out of a long search =================
test('FIND-C-01: HỦY stops an in-flight search and leaves the browser usable', async () => {
  const { coord } = mk([{ rid: 700, b: 999, seats: [] }]); // nothing will ever qualify → a long search
  const p = coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, budgetMs: 3000, pollMs: 10 });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(snapB(coord, 'B1').searching, true, 'the search is running');

  const c = await coord.cancelFind('B1');
  assert.equal(c.ok, true);
  assert.equal(c.cancelled, true);

  const r = await p;
  assert.equal(r.ok, false, 'the cancelled search never reports success');
  const b = snapB(coord, 'B1');
  assert.equal(b.searching, false);
  assert.equal(b.manualState, 'READY', 'the browser is back in the lobby, ready to search again');
  assert.equal(b.lastError, null, 'a user-initiated cancel is not an error');
});

test('FIND-C-02: after HỦY a new search starts cleanly (the single-flight flag was released)', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 999, seats: [] }]);
  const p = coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, budgetMs: 3000, pollMs: 10 });
  await new Promise((res) => setTimeout(res, 50));
  await coord.cancelFind('B1');
  await p;

  sim.rooms.push({ rid: 701, b: 500, Mu: 4, injectOnJoin: 0, failJoins: {}, seats: [] }); // a real table shows up
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0 });
  assert.equal(r.ok, true, 'never PHOM_FIND_IN_FLIGHT — the cancelled run released the flag');
  assert.equal(r.rid, 701);
});

test('FIND-C-03: HỦY on a browser that is not searching is a typed no-op', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  const c = await coord.cancelFind('B1');
  assert.equal(c.ok, false);
  assert.equal(c.error.code, 'PHOM_FIND_NOT_RUNNING');
});

test('FIND-C-04: the snapshot reports live progress so the header can show it', async () => {
  const { coord } = mk([{ rid: 700, b: 999, seats: [] }]);
  const p = coord.manualDiscoverTable('B1', { selectedStake: 500, maxRecovery: 0, budgetMs: 3000, pollMs: 10 });
  await new Promise((res) => setTimeout(res, 70));
  const b = snapB(coord, 'B1');
  assert.equal(b.searching, true);
  assert.ok(b.searchAttempt >= 2, `attempt counter advances (${b.searchAttempt})`);
  assert.equal(typeof b.searchElapsedSec, 'number');
  assert.equal(b.searchBudgetSec, 3);
  await coord.cancelFind('B1');
  await p;
  assert.equal(snapB(coord, 'B1').searchAttempt, 0, 'progress is cleared once the search ends');
});
