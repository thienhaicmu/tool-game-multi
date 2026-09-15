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

// TEST 18 — C kick + outsider invalidation while rejoining => INVALID takes precedence (safe).
test('T18 outsider invalidation during C rejoin is reconciled to INVALID', () => {
  const coord = mkCoord(); seatAll(coord);
  const recC = coord.followers().find((f) => f.id === 'C'); recC.state = 'KICKED';
  // while C is (conceptually) rejoining, outsiders fill the table -> unrecoverable
  coord.ingest('A', frame(tableState(100, [[0, A], [1, B], [2, 'x2'], [3, 'x3']])));
  assert.equal(coord.reconcileSeated().verdict, 'INVALID');
});
