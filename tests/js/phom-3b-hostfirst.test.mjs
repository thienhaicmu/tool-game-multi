// PHASE 3B FINAL — host-first valid-table discovery + B/C follow + kick rejoin + invalid-table
// restart. Deterministic regression over the authoritative rules: membership/validity come ONLY
// from TABLE_STATE.ps[] (never JOIN ACK / rs[].uC); A is the sole host; B/C only follow; an invalid
// table forces leave+restart; a recoverable missing follower triggers rejoin; STOP cancels; a single
// orchestrator runs. Numbers map to the task's TEST 1..18.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator, SESSION, ROLE } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

const A = '1_644555813', B = '1_644555903', C = '1_644556017', D = '1_700000000';
const selfId = (uid) => `[5,{"uid":"${uid}","u":"${uid}","As":{"gold":100},"dn":"n","cmd":100,"id":0}]`;
const tableState = (b, seats) => `[5,{"b":${b},"ps":[${seats.map(([sit, uid]) => `{"uid":"${uid}","dn":"n","r":false,"m":100,"sit":${sit}}`).join(',')}],"cmd":202}]`;
const immediate = () => Promise.resolve();

function mkCoord(extra = {}) {
  const send = async () => ({ ok: true });
  return new HostTableCoordinator({
    environmentAuthorized: true, hostId: 'A', delay: immediate,
    profiles: [{ id: 'A', send }, { id: 'B', send }, { id: 'C', send }],
    ...extra,
  });
}
function ident(coord) { coord.ingest('A', frame(selfId(A))); coord.ingest('B', frame(selfId(B))); coord.ingest('C', frame(selfId(C))); }
function frame(raw) { return { raw, direction: 'recv', targetId: 't', url: 'wss://x', now: Date.now() }; }
// seat host at a validated candidate + bring all three to the same table
function seatAll(coord) {
  ident(coord);
  coord.ingest('A', frame(tableState(100, [[0, A]])));           // host own-join snapshot
  coord.ingest('A', frame(`[5,{"p":{"uid":"${B}","sit":1,"r":false},"t":1,"cmd":200}]`));
  coord.ingest('A', frame(`[5,{"p":{"uid":"${C}","sit":2,"r":false},"t":1,"cmd":200}]`));
  coord.ingest('B', frame(tableState(100, [[0, A], [1, B], [2, C]])));
  coord.ingest('C', frame(tableState(100, [[0, A], [1, B], [2, C]])));
}

// TEST 1 — A joins, A present in ps[] => candidate valid.
test('T1 host candidate valid when A appears in authoritative ps[]', () => {
  const coord = mkCoord(); ident(coord);
  coord.ingest('A', frame(tableState(100, [[0, A]])));
  const v = coord.validateHostCandidate();
  assert.equal(v.valid, true);
  assert.equal(v.freeSeats, 3);
});

// TEST 2 — JOIN ACK succeeds but A NOT in ps[] => NOT acquired.
test('T2 JOIN ACK without A in ps[] is NOT membership', () => {
  const coord = mkCoord(); ident(coord);
  coord.ingest('A', frame(tableState(100, [[0, '1_999999999']]))); // someone else, not A
  const v = coord.validateHostCandidate();
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'HOST_NOT_IN_PS');
});

// TEST 3 — candidate invalid (no room for B+C) => invalid (host must leave + research).
test('T3 candidate invalid when table cannot seat A+B+C', () => {
  const coord = mkCoord(); ident(coord);
  coord.ingest('A', frame(tableState(100, [[0, A], [1, 'x1'], [2, 'x2'], [3, 'x3']]))); // full, 0 free
  const v = coord.validateHostCandidate();
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'INSUFFICIENT_CAPACITY');
});

// TEST 4 — A/B/C all in ps[] => SAME_TABLE.
test('T4 A+B+C authoritative => SAME_TABLE', () => {
  const coord = mkCoord(); seatAll(coord);
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
});

// TEST 5 — C disappears from ps[] but table still valid => C_REJOIN required.
test('T5 C disappearance (table still valid) => C_REJOIN', () => {
  const coord = mkCoord(); seatAll(coord);
  coord.ingest('A', frame(tableState(100, [[0, A], [1, B]])));  // host now sees only A,B
  const rc = coord.reconcileSeated();
  assert.equal(rc.verdict, 'C_REJOIN');
  assert.deepEqual(rc.missing, [C]);
});

// TEST 6 — C rejoins => SAME_TABLE restored.
test('T6 C rejoin restores SAME_TABLE', () => {
  const coord = mkCoord(); seatAll(coord);
  coord.ingest('A', frame(tableState(100, [[0, A], [1, B]])));
  coord.ingest('A', frame(`[5,{"p":{"uid":"${C}","sit":2,"r":false},"t":1,"cmd":200}]`)); // C back
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
});

// TEST 7 — outsider D present, table still valid => still SAME_TABLE (D uncontrolled).
test('T7 outsider D does not break SAME_TABLE', () => {
  const coord = mkCoord(); ident(coord);
  const four = [[0, A], [1, B], [2, C], [3, D]];
  coord.ingest('A', frame(tableState(100, four)));
  coord.ingest('B', frame(tableState(100, four)));
  coord.ingest('C', frame(tableState(100, four)));
  const v = coord.verifySameTable();
  assert.equal(v.result, 'SAME_TABLE');
  assert.equal(coord.reconcileSeated().verdict, 'SAME_TABLE');
});

// TEST 8 — outsider composition makes the table unrecoverable => INVALID (all leave).
test('T8 outsiders make table invalid => INVALID', () => {
  const coord = mkCoord(); seatAll(coord);
  // B and C gone, seats filled by outsiders -> cannot re-seat controlled
  coord.ingest('A', frame(tableState(100, [[0, A], [1, 'x1'], [2, 'x2'], [3, 'x3']])));
  const rc = coord.reconcileSeated();
  assert.equal(rc.verdict, 'INVALID');
});

// TEST 9 — A disappears => HOST_LOST, no promotion of B/C.
test('T9 host loss never promotes a follower', () => {
  const coord = mkCoord(); seatAll(coord);
  coord.markDisconnected('A');
  assert.equal(coord.state(), SESSION.HOST_LOST);
  assert.equal(coord.host().id, 'A');
  assert.equal(coord.followers().every((f) => f.role === ROLE.FOLLOWER), true);
});

// TEST 10 — STOP => no new host search.
test('T10 STOP blocks host search / discovery', async () => {
  const coord = mkCoord({ maxHostSearchAttempts: 1 }); ident(coord);
  coord.stop();
  const r = await coord.runDiscovery();
  assert.equal(r.ok, false);
  assert.ok(r.error && /UNAUTHORIZED|CANCELLED|stopped/i.test(r.error.message));
});

// TEST 11 — STOP => followers cannot join.
test('T11 STOP blocks follower join', async () => {
  const coord = mkCoord(); seatAll(coord); coord.stop();
  const r = await coord.joinFollowers();
  assert.equal(r.ok, false);
});

// TEST 12 — STOP => C rejoin cancelled.
test('T12 STOP cancels C rejoin', async () => {
  const coord = mkCoord(); seatAll(coord); coord.stop();
  const r = await coord.rejoinFollower('C');
  assert.equal(r.ok, false);
});

// TEST 13 — Run discovery twice => single orchestrator.
test('T13 only one discovery orchestrator runs', async () => {
  const coord = mkCoord({ maxHostSearchAttempts: 1, selectedStake: 100 });
  const p1 = coord.runDiscovery();
  const r2 = await coord.runDiscovery();
  assert.equal(r2.already, true);
  await p1;
});

// TEST 14 — reordered ps[] across profiles => same fingerprint => SAME_TABLE.
test('T14 reordered ps[] yields identical fingerprint', () => {
  const coord = mkCoord(); ident(coord);
  coord.ingest('A', frame(tableState(100, [[0, A], [1, B], [2, C]])));
  coord.ingest('B', frame(tableState(100, [[2, C], [0, A], [1, B]])));
  coord.ingest('C', frame(tableState(100, [[1, B], [2, C], [0, A]])));
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
});

// TEST 15 — seat collision => not SAME_TABLE / candidate invalid.
test('T15 seat collision is rejected', () => {
  const coord = mkCoord(); ident(coord);
  // A's view puts A and B both at seat 0
  coord.ingest('A', frame(tableState(100, [[0, A], [0, B]])));
  const v = coord.validateHostCandidate();
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'SEAT_CONFLICT');
});

// TEST 16 — duplicate C rejoin trigger => only one active (cooldown).
test('T16 duplicate C rejoin is de-duplicated by cooldown', async () => {
  let t = 1000; const coord = mkCoord({ now: () => t, rejoinCooldownMs: 5000 });
  seatAll(coord);
  // host must be seated for a rejoin to be attempted; force C kicked
  coord.host().confirmedInTable = true; coord.host()._joinedRid = 139;
  const recC = coord.followers().find((f) => f.id === 'C'); recC.state = 'KICKED'; recC.confirmedInTable = true;
  const r1 = await coord.rejoinFollower('C');
  const r2 = await coord.rejoinFollower('C'); // immediate second attempt => must NOT start a 2nd JOIN
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  // de-duplicated: either already rejoining (noop) or cooldown — never a second concurrent JOIN
  assert.ok(r2.noop === true || (r2.error && /COOLDOWN/.test(r2.error.code)));
});

// TEST 17 — invalid candidate then valid candidate.
test('T17 abandon invalid candidate, then accept a valid one', () => {
  const coord = mkCoord(); ident(coord);
  coord.ingest('A', frame(tableState(100, [[0, A], [1, 'x1'], [2, 'x2'], [3, 'x3']]))); // full -> invalid
  assert.equal(coord.validateHostCandidate().valid, false);
  // host leaves + joins a fresh empty candidate
  const host = coord.host(); host.ctx.reset();
  coord.ingest('A', frame(tableState(100, [[0, A]])));
  assert.equal(coord.validateHostCandidate().valid, true);
});

// CASE 1 end-to-end — runDiscovery seats A (empty room), then B, then C sequentially, each confirmed
// in the authoritative ps[], reaching SAME_TABLE. A server simulator answers each JOIN with the right
// TABLE_STATE / SEAT_UPDATE frames (host learns later joiners via cmd:200 deltas).
test('CASE1 e2e discovery: A -> B -> C sequential => SAME_TABLE', async () => {
  const UID = { A: '1_1', B: '1_2', C: '1_3' }, SIT = { A: 0, B: 1, C: 2 };
  const table = { seats: [] };
  let coord;
  const feed = (id, raw) => coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://x', now: Date.now() });
  const chan = () => '[5,{"rs":[{"rid":500,"b":100,"uC":0,"zn":"Simms","gid":8,"Mu":4}],"cmd":300,"aid":"1"}]';
  const tState = (seats) => `[5,{"b":100,"ps":[${seats.map((s) => `{"uid":"${s.uid}","sit":${s.sit},"r":false}`).join(',')}],"cmd":202}]`;
  const delta = (uid, sit) => `[5,{"p":{"uid":"${uid}","sit":${sit},"r":false},"t":1,"cmd":200}]`;
  const mkSend = (id) => async (fr) => {
    let j; try { j = JSON.parse(fr); } catch { return { ok: true }; }
    if (j[0] === 6 && j[3] && j[3].cmd === 300) { feed(id, chan()); return { ok: true }; }
    if (j[0] === 4) { table.seats = table.seats.filter((s) => s.uid !== UID[id]); return { ok: true }; }
    if (j[0] === 3) {
      if (!table.seats.find((s) => s.uid === UID[id])) table.seats.push({ sit: SIT[id], uid: UID[id] });
      for (const pid of ['A', 'B', 'C']) { if (pid === id) feed(pid, tState(table.seats)); else if (table.seats.find((s) => s.uid === UID[pid])) feed(pid, delta(UID[id], SIT[id])); }
      return { ok: true };
    }
    return { ok: true };
  };
  coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', selectedStake: 100, delay: () => Promise.resolve(), profiles: [{ id: 'A', send: mkSend('A') }, { id: 'B', send: mkSend('B') }, { id: 'C', send: mkSend('C') }] });
  for (const id of ['A', 'B', 'C']) { feed(id, selfId(UID[id])); coord.setIdentity(id, { aid: '1' }); }
  const r = await coord.runDiscovery();
  assert.equal(r.ok, true);
  assert.equal(r.sameTable, true, JSON.stringify(coord.verifySameTable()));
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
  // host learned B and C via SEAT_UPDATE deltas (sequential follow)
  assert.deepEqual(coord.host().ctx.tableState().uids, [UID.A, UID.B, UID.C].sort());
});

// A + one follower on a FULL table (no seat for the third) => INVALID: both/all leave, A re-searches.
test('A + one follower with a full table (no room for the third) => INVALID (all out)', () => {
  const coord = mkCoord(); ident(coord);
  // A(0), B(1) plus two outsiders fill seats 2 and 3 -> C can never be seated here
  coord.ingest('A', frame(tableState(100, [[0, A], [1, B], [2, '1_x1'], [3, '1_x2']])));
  coord._hostTableIdentity = { channelRid: 500, selectedStake: 100 };
  const rc = coord.reconcileSeated();
  assert.equal(rc.verdict, 'INVALID', JSON.stringify(rc));
});

// LOBBY RESET — returning to the Phỏm lobby (CHANNEL_LIST arrives) clears stale table state so a
// fresh TÌM BÀN starts clean (no sticky BÀN / SAME_TABLE / MISMATCH / HOST_LOST).
test('lobby reset: CHANNEL_LIST after leaving clears stale table state', () => {
  const coord = mkCoord(); ident(coord);
  coord.ingest('A', frame(tableState(100, [[0, A], [1, B], [2, C]])));
  coord.ingest('B', frame(tableState(100, [[0, A], [1, B], [2, C]])));
  coord.ingest('C', frame(tableState(100, [[0, A], [1, B], [2, C]])));
  coord._hostTableIdentity = { channelRid: 500, selectedStake: 100 }; // simulate an acquired table
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
  const chan = '[5,{"rs":[{"rid":500,"b":100,"uC":0,"zn":"Simms","gid":8}],"cmd":300}]';
  coord.ingest('A', frame(chan)); coord.ingest('B', frame(chan)); coord.ingest('C', frame(chan));
  assert.equal(coord.state(), SESSION.LOBBY_WAITING);
  assert.equal(coord.hostTableIdentity(), null);
  assert.notEqual(coord.verifySameTable().result, 'SAME_TABLE');
});

// TEST 18 — C kick + outsider invalidation while rejoining => INVALID takes precedence (safe).
test('T18 outsider invalidation during C rejoin is reconciled to INVALID', () => {
  const coord = mkCoord(); seatAll(coord);
  const recC = coord.followers().find((f) => f.id === 'C'); recC.state = 'KICKED';
  // while C is (conceptually) rejoining, outsiders fill the table -> unrecoverable
  coord.ingest('A', frame(tableState(100, [[0, A], [1, B], [2, 'x2'], [3, 'x3']])));
  assert.equal(coord.reconcileSeated().verdict, 'INVALID');
});
