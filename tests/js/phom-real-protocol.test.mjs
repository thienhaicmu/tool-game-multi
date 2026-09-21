// §53/§54 — FIND / JOIN against the REAL lobby protocol, as recorded by Test D (2026-09-19):
//   * the lobby list rs[] holds ONE STAKE CHANNEL per stake ([rid 139 b 100 14/4]) — never individual tables;
//   * JOIN [3,"Simms",139,""] → the SERVER picks the table; the TABLE_STATE carries no table id;
//   * a refusal is [3,false,100,-1,"Phòng đầy"] / [3,false,104,-1,"Phòng đã bị hủy"];
//   * LEAVE is acked [4,true,1,-1,0,""]; a JOIN sent while seated moves the player: [4,true,2,-1,0,""] then reseat.
// The sim reproduces exactly that, so these tests pin the behaviour the live game forces on the tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');

const UIDS = { B1: '1_1', B2: '1_2', B3: '1_3' };

class ChannelSim {
  // placement(id, n) → which table index the server seats browser `id` at on its n-th accepted JOIN (1-based),
  // or { refuse: 'Phòng đầy' } to refuse it. tables: [{ others: [uid,...] }]
  constructor({ tables, placement, stake = 100, rid = 139 }) {
    this.tables = tables.map((t) => ({ seats: (t.others || []).map((uid, i) => ({ uid, sit: i })) }));
    this.placement = placement; this.stake = stake; this.rid = rid;
    this.joins = {}; this.log = []; this.coord = null;
  }
  attach(c) { this.coord = c; }
  feed(id, v) { this.coord.ingest(id, { raw: JSON.stringify(v), direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  seatedAt(uid) { return this.tables.findIndex((t) => t.seats.some((s) => s.uid === uid)); }
  channelList() { return [5, { rs: [{ rid: this.rid, b: this.stake, uC: 14, Mu: 4, zn: 'Simms', gid: 8, rn: 'Phom' }], cmd: 300 }]; }
  table(i) { const t = this.tables[i]; return [5, { b: this.stake, ps: t.seats.map((s) => ({ uid: s.uid, sit: s.sit, dn: s.uid, r: false })), cmd: 202 }]; }
  unseat(uid) { for (const t of this.tables) t.seats = t.seats.filter((s) => s.uid !== uid); }
  sendFor(id) {
    return async (frame) => {
      const j = JSON.parse(frame); const uid = UIDS[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this.feed(id, this.channelList()); return { ok: true }; }
      if (j[0] === 3) {
        const wasSeated = this.seatedAt(uid) >= 0;
        this.log.push({ id, op: 'JOIN', wasSeated });
        if (wasSeated) { this.unseat(uid); this.feed(id, [4, true, 2, -1, 0, '']); } // server moves the player out
        const n = (this.joins[id] = (this.joins[id] || 0) + 1);
        const where = this.placement(id, n);
        if (where && where.refuse) { this.feed(id, [3, false, 100, -1, where.refuse]); return { ok: true }; }
        this.feed(id, [3, true, 0, -1, null]);
        const t = this.tables[where]; t.seats.push({ uid, sit: t.seats.length });
        this.feed(id, this.table(where));
        // everyone else at that table sees the newcomer's full table too (keeps the anchor's ps[] current)
        for (const other of Object.keys(UIDS)) if (other !== id && t.seats.some((s) => s.uid === UIDS[other])) this.feed(other, this.table(where));
        return { ok: true };
      }
      if (j[0] === 4) {
        this.log.push({ id, op: 'LEAVE' });
        const i = this.seatedAt(uid); this.unseat(uid);
        this.feed(id, [4, true, 1, -1, 0, '']);
        if (i >= 0) for (const other of Object.keys(UIDS)) if (other !== id && this.tables[i].seats.some((s) => s.uid === UIDS[other])) this.feed(other, this.table(i));
        return { ok: true };
      }
      return { ok: true };
    };
  }
}
function mk(opts) {
  const sim = new ChannelSim(opts);
  const coord = new HostTableCoordinator({ environmentAuthorized: true, delay: () => Promise.resolve(), findBudgetMs: 3000, findPollMs: 10, rerollCooldownMs: 0, joinRejectGraceMs: 20, leaveConfirmMs: 200,
    profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })) });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) { coord.ingest(id, { raw: `[5,{"uid":"${UIDS[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 }); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim };
}
const snapB = (coord, id) => coord.manualBrowserSnapshot().find((b) => b.profileId === id);
const noJoinWhileSeated = (sim) => assert.deepEqual(sim.log.filter((e) => e.op === 'JOIN' && e.wasSeated), [], 'the tool never sends JOIN while seated');

// ---------------- protocol layer ----------------
test('REAL-P1: the server refusal and the leave ack are classified with their codes', () => {
  const full = classifyPhomFrame('[3,false,100,-1,"Phòng đầy"]');
  assert.equal(full.type, 'JOIN_ACCEPTED'); assert.equal(full.accepted, false); assert.equal(full.resultCode, 100); assert.equal(full.resultMessage, 'Phòng đầy');
  const gone = classifyPhomFrame('[3,false,104,-1,"Phòng đã bị hủy"]');
  assert.equal(gone.resultCode, 104); assert.equal(gone.resultMessage, 'Phòng đã bị hủy');
  const ok = classifyPhomFrame('[3,true,0,-1,null]');
  assert.equal(ok.accepted, true); assert.equal(ok.resultMessage, null);
  const ack = classifyPhomFrame('[4,true,1,-1,0,""]');
  assert.equal(ack.type, 'LEAVE_ACK'); assert.equal(ack.accepted, true); assert.equal(ack.resultCode, 1);
  assert.equal(classifyPhomFrame('[4,"Simms",-1]').type, 'LEAVE_REQUEST');
});

test('REAL-P2: the context records join/leave answers and a leave ack drops the table at once', () => {
  const c = new PhomContext({});
  const f = (v) => c.observe({ raw: JSON.stringify(v), direction: 'recv', targetId: 'T', url: 'wss://x', now: 5 });
  f([5, { b: 100, ps: [{ uid: '1_1', sit: 0 }], cmd: 202 }]);
  assert.ok(c.tableState()); const seq = c.tableSeq();
  f([4, true, 1, -1, 0, '']);
  assert.equal(c.tableState(), null);
  assert.equal(c.lastLeaveAck().code, 1);
  f([3, false, 100, -1, 'Phòng đầy']);
  assert.deepEqual({ a: c.lastJoinAck().accepted, m: c.lastJoinAck().message }, { a: false, m: 'Phòng đầy' });
  f([5, { b: 100, ps: [{ uid: '1_1', sit: 0 }], cmd: 202 }]);
  assert.equal(c.tableSeq(), seq + 1);
});

// ---------------- bug 1: a misfit table is left and re-rolled ----------------
test('REAL-01: channel-only discovery cannot prove a physical RID and must not JOIN', async () => {
  const { coord, sim } = mk({ tables: [{ others: [] }], placement: () => 0 });
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 100, budgetMs: 20, pollMs: 5 });
  assert.equal(r.ok, false); assert.equal(coord.sharedRid(), null);
  assert.equal(sim.log.some((entry) => entry.op === 'JOIN'), false);
});

test('REAL-02: channel-only discovery cannot prove a physical RID and must not JOIN', async () => {
  const { coord, sim } = mk({ tables: [{ others: [] }], placement: () => 0 });
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 100, budgetMs: 20, pollMs: 5 });
  assert.equal(r.ok, false); assert.equal(coord.sharedRid(), null);
  assert.equal(sim.log.some((entry) => entry.op === 'JOIN'), false);
});

test('REAL-03: channel-only discovery cannot prove a physical RID and must not JOIN', async () => {
  const { coord, sim } = mk({ tables: [{ others: [] }], placement: () => 0 });
  const r = await coord.manualDiscoverTable('B1', { selectedStake: 100, budgetMs: 20, pollMs: 5 });
  assert.equal(r.ok, false); assert.equal(coord.sharedRid(), null);
  assert.equal(sim.log.some((entry) => entry.op === 'JOIN'), false);
});

test('REAL-04: manualJoinRoom reports the refusal reason instead of a timeout', async () => {
  const { coord } = mk({ tables: [{ others: [] }], placement: () => ({ refuse: 'Phòng đã bị hủy' }) });
  const t0 = Date.now();
  const r = await coord.manualJoinRoom('B2', 139, { timeoutMs: 5000 });
  assert.equal(r.ok, false); assert.equal(r.state, 'JOIN_REJECTED');
  assert.equal(r.error.code, 'PHOM_JOIN_REJECTED'); assert.match(r.error.message, /Phòng đã bị hủy/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(snapB(coord, 'B2').rid, null, 'a refused room is never shown as the browser\'s table');
});

// ---------------- bug 2: follower JOIN never re-JOINs while seated ----------------
test('REAL-05: a JOIN while seated is refused locally — it would get the player moved by the server', async () => {
  const { coord, sim } = mk({ tables: [{ others: [] }, { others: [] }], placement: (id, n) => n - 1 });
  assert.equal((await coord.manualJoinRoom('B2', 139)).ok, true);
  const r = await coord.manualJoinRoom('B2', 139);
  assert.equal(r.ok, false); assert.equal(r.error.code, 'PHOM_ALREADY_AT_TABLE');
  assert.equal(sim.joins.B2, 1, 'no second JOIN left the tool');
});

test('REAL-06: follower lands with the anchor → confirmed; no JOIN is ever sent while seated', async () => {
  const { coord, sim } = mk({ tables: [{ others: [] }], placement: () => 0 });
  const f = await coord.manualFindTable('B1', 139);
  assert.equal(f.ok, true);
  const r = await coord.manualJoinShared('B2', coord.sharedRid());
  assert.equal(r.ok, true); assert.equal(r.sameRoom, true);
  noJoinWhileSeated(sim);
});

test('REAL-07: follower seated at a DIFFERENT table leaves it before every retry, and does not stay there at the end', async () => {
  // Test D: the server seated the follower alone at a fresh table on every try.
  const { coord, sim } = mk({ tables: [{ others: [] }, { others: [] }, { others: [] }, { others: [] }], placement: (id, n) => (id === 'B1' ? 0 : n) });
  assert.equal((await coord.manualFindTable('B1', 139)).ok, true);
  const r = await coord.manualJoinShared('B2', 139, { maxRetries: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_FOLLOWER_ROOM_MISMATCH');
  assert.match(r.error.message, /không cho chọn bàn/);
  assert.equal(sim.joins.B2, 3, 'bounded: initial + 2 retries');
  noJoinWhileSeated(sim);
  assert.equal(sim.seatedAt('1_2'), -1, 'the wrong table was left');
  assert.equal(coord.sharedRid(), 139); assert.equal(coord.sharedRidOwner(), 'B1', 'the anchor is still the finder');
});

test('REAL-08: follower that lands with the anchor on a retry is confirmed', async () => {
  const { coord, sim } = mk({ tables: [{ others: [] }, { others: [] }], placement: (id, n) => (id === 'B1' ? 0 : (n === 1 ? 1 : 0)) });
  assert.equal((await coord.manualFindTable('B1', 139)).ok, true);
  const r = await coord.manualJoinShared('B2', 139, { maxRetries: 2 });
  assert.equal(r.ok, true); assert.equal(r.sameRoom, true); assert.equal(r.attempts, 2);
  noJoinWhileSeated(sim);
});

test('REAL-09: a follower already seated with the anchor is confirmed without sending anything', async () => {
  const { coord, sim } = mk({ tables: [{ others: [] }], placement: () => 0 });
  assert.equal((await coord.manualFindTable('B1', 139)).ok, true);
  assert.equal((await coord.manualJoinShared('B2', 139)).ok, true);
  const joins = sim.joins.B2;
  const again = await coord.manualJoinShared('B2', 139);
  assert.equal(again.ok, true); assert.equal(again.alreadySeated, true);
  assert.equal(sim.joins.B2, joins);
});

// ---------------- bug 3: a reload (F5 or ⟳) resets that browser's Phỏm state ----------------
test('REAL-10: a new top-level document resets the browser (header back to VÀO GAME), about:blank excluded', () => {
  const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /function onRunDocumentReplaced\(runId, url\)/);
  assert.match(main, /client\.Page\.frameNavigated\(\(p\) => \{ if \(p && p\.frame && !p\.frame\.parentId\) onRunDocumentReplaced\(run\.id, p\.frame\.url\); \}\);/);
  const body = main.slice(main.indexOf('function onRunDocumentReplaced('), main.indexOf('async function closeBrowserRun('));
  assert.match(body, /\^about:/);
  assert.match(body, /phomSessions\.resetBrowser\(rid\)/);
  assert.match(body, /delete headerLastPushed\[rid\]/);
  assert.equal(/headerEntering/.test(body), false, 'a VÀO GAME in flight is not cancelled by its own navigation');
});

test('REAL-11: after resetBrowser the browser is no longer in game or at a table', async () => {
  const { coord } = mk({ tables: [{ others: [] }], placement: () => 0 });
  coord.ingest('B1', { raw: JSON.stringify([5, { rs: [{ rid: 139, b: 100, uC: 14, Mu: 4, zn: 'Simms', gid: 8 }], cmd: 300 }]), direction: 'recv', targetId: 'B1', url: 'wss://sim', now: 2 });
  assert.equal((await coord.manualFindTable('B1', 139)).ok, true);
  coord.resetBrowser('B1');
  const b = snapB(coord, 'B1');
  assert.equal(b.rid, null); assert.equal(b.socketReady, false); assert.equal(b.channelCount || 0, 0);
  assert.equal(coord.sharedRid(), null);
});
