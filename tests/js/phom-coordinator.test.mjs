import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhomCoordinator, SESSION, PROFILE, buildJoinFrame } = require('../../desktop/protocol/phom/phom-coordinator.cjs');

const UIDS = { P1: '1_A', P2: '1_B', P3: '1_C' };

// Build a coordinator whose per-profile send just records the frames it was asked
// to transmit (each through its OWN seam — never a shared socket).
function makeSession(opts = {}) {
  const sent = { P1: [], P2: [], P3: [] };
  const profiles = ['P1', 'P2', 'P3'].map((id, i) => ({
    id,
    displayName: `Profile ${i + 1}`,
    proxyRef: `proxy-${id}`,
    uid: UIDS[id],
    send: async (payload) => { sent[id].push(payload); return { ok: true }; },
  }));
  let now = 1000;
  const coord = new PhomCoordinator({ profiles, environmentAuthorized: opts.authorized !== false, now: () => (now += 1), joinWindowMs: 500, maxRejoinAttempts: 2, rejoinCooldownMs: 0 });
  // First recv frame binds each socket + learns identity path.
  const bind = (id) => coord.ingest(id, { raw: JSON.stringify([5, { b: 1000, ps: [] }]), direction: 'recv', seq: 0, targetId: `T-${id}`, cdpSessionId: null, url: 'wss://x.hytsocesk.com/websocket' });
  return { coord, sent, bind };
}

// Push an authoritative table-state to a profile with a given player set.
function tableState(uids, opts = {}) {
  const ps = uids.map((uid, i) => ({ sit: opts.seat ? opts.seat[uid] : i + 1, dn: `name_${uid}`, uid, m: 0, r: opts.ready ? !!opts.ready[uid] : false }));
  return JSON.stringify([5, { b: opts.b != null ? opts.b : 1000, ps }]);
}
function pushTable(coord, id, uids, seq, opts) {
  coord.ingest(id, { raw: tableState(uids, opts), direction: 'recv', seq, targetId: `T-${id}`, url: 'wss://x.hytsocesk.com/websocket' });
}

// §22.C — profile isolation: a frame for one profile never touches the others.
test('profile isolation: frames + identity + proxy are per-profile', () => {
  const { coord } = makeSession();
  const all = ['1_A', '1_B', '1_C'];
  pushTable(coord, 'P1', all, 1);
  const snap = coord.snapshot();
  const p1 = snap.profiles.find((p) => p.id === 'P1');
  const p2 = snap.profiles.find((p) => p.id === 'P2');
  assert.equal(p1.playerCount, 3);
  assert.equal(p2.playerCount, 0); // untouched
  assert.equal(p1.proxyRef, 'proxy-P1');
  assert.equal(p2.proxyRef, 'proxy-P2');
  assert.notEqual(p1.proxyRef, p2.proxyRef);
});

// §22.D — join concurrency: same channel code dispatched to each profile's own send.
test('join concurrency: same channel via each own send, within window, not success-on-send', async () => {
  const { coord, sent, bind } = makeSession();
  ['P1', 'P2', 'P3'].forEach(bind);
  coord.selectChannel(139);
  const res = await coord.joinTogether();
  assert.equal(res.results.length, 3);
  assert.equal(res.withinWindow, true);
  for (const id of ['P1', 'P2', 'P3']) {
    assert.ok(sent[id].includes(buildJoinFrame(139)), `${id} must send the join frame`);
  }
  // No table state yet -> verifyTable is not SAME_TABLE just because we sent.
  assert.notEqual(coord.verifyTable().result, 'SAME_TABLE');
  assert.notEqual(coord.state(), SESSION.SAME_TABLE);
});

// §22.E — same-table verification from authoritative table state (never uC).
test('same-table verification: consistent player set => SAME_TABLE', () => {
  const { coord } = makeSession();
  const all = ['1_A', '1_B', '1_C'];
  pushTable(coord, 'P1', all, 1);
  pushTable(coord, 'P2', all, 1);
  pushTable(coord, 'P3', all, 1);
  const v = coord.verifyTable();
  assert.equal(v.result, 'SAME_TABLE');
  assert.equal(v.hasOutsider, false);
  assert.equal(coord.snapshot().sameTable, true);
});

test('same-table: divergent player set => TABLE_MISMATCH', () => {
  const { coord } = makeSession();
  pushTable(coord, 'P1', ['1_A', '1_B', '1_C'], 1);
  pushTable(coord, 'P2', ['1_A', '1_B', '1_C'], 1);
  pushTable(coord, 'P3', ['1_A', '1_B', '1_X'], 1); // different set
  assert.equal(coord.verifyTable().result, 'TABLE_MISMATCH');
});

test('same-table: seat conflict => TABLE_MISMATCH', () => {
  const { coord } = makeSession();
  const all = ['1_A', '1_B', '1_C'];
  pushTable(coord, 'P1', all, 1, { seat: { '1_A': 1, '1_B': 2, '1_C': 3 } });
  pushTable(coord, 'P2', all, 1, { seat: { '1_A': 1, '1_B': 2, '1_C': 3 } });
  pushTable(coord, 'P3', all, 1, { seat: { '1_A': 2, '1_B': 1, '1_C': 3 } }); // A/B swapped
  assert.equal(coord.verifyTable().result, 'TABLE_MISMATCH');
});

test('same-table: missing one profile => PARTIAL_JOIN', () => {
  const { coord } = makeSession();
  pushTable(coord, 'P1', ['1_A', '1_B', '1_C'], 1);
  pushTable(coord, 'P2', ['1_A', '1_B', '1_C'], 1);
  // P3 never gets a table state
  assert.equal(coord.verifyTable().result, 'PARTIAL_JOIN');
});

test('same-table: outsider (real 4th player) flagged but still SAME_TABLE', () => {
  const { coord } = makeSession();
  const set = ['1_A', '1_B', '1_C', '1_OUT'];
  pushTable(coord, 'P1', set, 1);
  pushTable(coord, 'P2', set, 1);
  pushTable(coord, 'P3', set, 1);
  const v = coord.verifyTable();
  assert.equal(v.result, 'SAME_TABLE');
  assert.equal(v.hasOutsider, true);
});

// §22.F — ReJoin only the mismatched profile; bounded attempts; stop cancels.
test('rejoin: only mismatched profile rejoins; correct ones untouched', async () => {
  const { coord, sent } = makeSession();
  coord.selectChannel(139);
  pushTable(coord, 'P1', ['1_A', '1_B', '1_C'], 1);
  pushTable(coord, 'P2', ['1_A', '1_B', '1_C'], 1);
  pushTable(coord, 'P3', ['1_X', '1_Y', '1_Z'], 1); // wrong table
  const before2 = sent.P2.length;
  const res = await coord.rejoinMismatched();
  assert.ok(sent.P3.includes(buildJoinFrame(139)), 'P3 should rejoin');
  assert.equal(sent.P2.length, before2, 'P2 (correct) must not be touched');
  const p3res = res.results.find((r) => r.id === 'P3');
  assert.equal(p3res.attempt, 1);
});

test('rejoin: bounded by maxRejoinAttempts then PHOM_REJOIN_EXHAUSTED', async () => {
  const { coord } = makeSession();
  coord.selectChannel(139);
  pushTable(coord, 'P1', ['1_A', '1_B', '1_C'], 1);
  pushTable(coord, 'P2', ['1_A', '1_B', '1_C'], 1);
  pushTable(coord, 'P3', ['1_X', '1_Y', '1_Z'], 1);
  await coord.rejoinMismatched(); // attempt 1
  await coord.rejoinMismatched(); // attempt 2 (max=2)
  const res = await coord.rejoinMismatched(); // exhausted
  const p3 = res.results.find((r) => r.id === 'P3');
  assert.equal(p3.error.code, 'PHOM_REJOIN_EXHAUSTED');
});

test('stop cancels active orchestration', async () => {
  const { coord } = makeSession();
  coord.selectChannel(139);
  coord.stop();
  const res = await coord.joinTogether();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_OPERATION_CANCELLED');
});

// §22.G — Ready only after SAME_TABLE; ps[].r updates count; 2/3 != 3/3.
test('ready: blocked unless SAME_TABLE', async () => {
  const { coord } = makeSession();
  pushTable(coord, 'P1', ['1_A', '1_B', '1_C'], 1); // only one view
  const res = await coord.readyAll();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_TABLE_MISMATCH');
});

test('ready: sends to all three after SAME_TABLE; readyCount from ps[].r', async () => {
  const { coord, sent } = makeSession();
  const all = ['1_A', '1_B', '1_C'];
  pushTable(coord, 'P1', all, 1);
  pushTable(coord, 'P2', all, 1);
  pushTable(coord, 'P3', all, 1);
  const res = await coord.readyAll();
  assert.equal(res.ok, true);
  for (const id of ['P1', 'P2', 'P3']) assert.equal(sent[id].length, 1);
  // server confirms only 2/3 ready => snapshot must NOT report 3/3
  const readyMap = { '1_A': true, '1_B': true, '1_C': false };
  pushTable(coord, 'P1', all, 2, { ready: readyMap });
  pushTable(coord, 'P2', all, 2, { ready: readyMap });
  pushTable(coord, 'P3', all, 2, { ready: readyMap });
  assert.equal(coord.snapshot().readyCount, 2);
  assert.notEqual(coord.state(), SESSION.READY);
});

// §19 — unauthorized environment: active orchestration refused, passive still works.
test('unauthorized environment refuses active orchestration', async () => {
  const { coord } = makeSession({ authorized: false });
  const res = await coord.joinTogether(139);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_UNAUTHORIZED_ENVIRONMENT');
  // passive ingest still updates state
  pushTable(coord, 'P1', ['1_A', '1_B', '1_C'], 1);
  assert.equal(coord.snapshot().profiles.find((p) => p.id === 'P1').playerCount, 3);
});
