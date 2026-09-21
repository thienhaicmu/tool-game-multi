// docs/phom-kich-ban.md — the group flow itself: pacing (0.8–2.5s before every command), one operation at a time,
// and MANUAL vs AUTO (manual only does what was pressed; auto rejoins and re-creates). Driven against a FAKE
// coordinator so every step is observable and the test is deterministic; the protocol level is covered by
// phom-create-table.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTableGroup, ROLE, PACE_MIN_MS, PACE_MAX_MS } = require('../../desktop/protocol/phom/table-group.cjs');

// A coordinator stand-in: records every command with the virtual time it was sent at.
function fakeCoord({ ids = ['B1', 'B2', 'B3'], joinFails = {}, createFails = false } = {}) {
  const c = {
    clock: 0, sent: [], seats: new Map(), rid: 3700000, keyResolver: null, listeners: {},
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev, payload) { for (const fn of (this.listeners[ev] || [])) fn(payload); },
    setRoomKeyResolver(fn) { this.keyResolver = fn; },
    profileIds: () => ids,
    browserReady: () => true,
    uidOf: (id) => 'uid-' + id,
    isSeated(id) { return this.seats.has(id); },
    seatedRid(id) { return this.seats.has(id) ? this.seats.get(id) : null; },
    lastRidOf(id) { return this.seats.get(id) ?? null; },
    isReady: () => false,
    isTableHost: () => false,
    tableHostUid: () => null,
    roundRunning: () => false,
    setHost() {}, setFinder() {},
    async leaveTable(id) { this.sent.push({ at: this.clock, id, cmd: 'LEAVE' }); this.seats.delete(id); return { ok: true }; },
    async setAutoReadyPref(id, on) { this.sent.push({ at: this.clock, id, cmd: 'PREF', on }); return { ok: true }; },
    async sendTableReady(id, rid) { this.sent.push({ at: this.clock, id, cmd: 'READY', rid }); return { ok: true }; },
    async createTable(id, opts) {
      if (opts && typeof opts.pace === 'function') await opts.pace();
      this.sent.push({ at: this.clock, id, cmd: 'CREATE', stake: opts.stake });
      if (createFails) return { ok: false, error: { code: 'PHOM_CREATE_REJECTED', message: 'no' } };
      const rid = this.rid++; this.seats.set(id, rid);
      return { ok: true, rid, roomKey: '123456' };
    },
    async manualJoinByCode(id, rid, key) {
      this.sent.push({ at: this.clock, id, cmd: 'JOIN', rid, key: key || '' });
      const fail = joinFails[id];
      if (fail) { delete joinFails[id]; return { ok: false, error: fail }; }
      this.seats.set(id, rid); return { ok: true, rid };
    },
  };
  return c;
}
// Virtual clock: sleep only advances `coord.clock`, so a test runs instantly but the pacing stays measurable.
function mk(opts = {}) {
  const coord = fakeCoord(opts);
  const rnd = () => 0.5;
  const group = createTableGroup({ coord, random: opts.random || rnd, sleep: (ms) => { coord.clock += ms; return Promise.resolve(); }, now: () => coord.clock });
  return { coord, group };
}
const cmds = (coord, cmd) => coord.sent.filter((e) => e.cmd === cmd);

test('PACE: every command waits a random 0.8–2.5s first; nothing is ever sent back-to-back', async () => {
  const { coord, group } = mk({ random: () => 0 });          // shortest allowed wait
  await group.setAuto(true, { creatorId: 'B1', stake: 100 });
  assert.ok(coord.sent.length >= 6, 'create + two joins at least');
  let prev = 0;
  for (const e of coord.sent) { assert.ok(e.at - prev >= PACE_MIN_MS, `${e.cmd} waited ${e.at - prev}ms`); prev = e.at; }
  const { coord: c2, group: g2 } = mk({ random: () => 1 });   // longest allowed wait
  await g2.setAuto(true, { creatorId: 'B1', stake: 100 });
  let p2 = 0;
  // CREATE is two commands on the wire (311 then 308), so it carries two waits.
  for (const e of c2.sent) { const cap = e.cmd === 'CREATE' ? 2 * PACE_MAX_MS : PACE_MAX_MS; assert.ok(e.at - p2 <= cap, `${e.cmd} waited ${e.at - p2}ms`); p2 = e.at; }
});

test('QUEUE: two operations asked for at once run one after another, never interleaved', async () => {
  const { coord, group } = mk();
  const a = group.createTable('B1', { stake: 100 });
  const b = group.joinTable('B2', 3700000);
  await Promise.all([a, b]);
  const order = coord.sent.map((e) => e.id + ':' + e.cmd);
  assert.deepEqual(order.slice(0, 2), ['B1:PREF', 'B1:CREATE'], 'the create finishes before the join starts');
  assert.ok(order.indexOf('B2:JOIN') > order.indexOf('B1:CREATE'));
});

test('T1 + T2: manual create makes KEY; the join order decides READY then NOT_READY', async () => {
  const { coord, group } = mk();
  const created = await group.createTable('B2', { stake: 500 });
  assert.equal(created.ok, true);
  assert.equal(group.roleOf('B2'), ROLE.KEY);
  assert.deepEqual(cmds(coord, 'PREF').map((e) => [e.id, e.on]), [['B2', false]], 'KEY never auto-readies');
  const first = await group.joinTable('B1', created.rid);
  assert.equal(first.role, ROLE.READY);
  const second = await group.joinTable('B3', created.rid);
  assert.equal(second.role, ROLE.NOT_READY);
  // the preference is always set BEFORE that browser's JOIN, and only READY sends a ready frame
  for (const id of ['B1', 'B3']) {
    const pref = coord.sent.findIndex((e) => e.id === id && e.cmd === 'PREF');
    const join = coord.sent.findIndex((e) => e.id === id && e.cmd === 'JOIN');
    assert.ok(pref >= 0 && pref < join, id);
  }
  assert.deepEqual(cmds(coord, 'READY').map((e) => e.id), ['B1']);
  assert.deepEqual(cmds(coord, 'JOIN').map((e) => e.key), ['123456', '123456'], 'joins carry the table key');
});

test('T2: a failed join gives the role back to the next browser', async () => {
  const { group } = mk({ joinFails: { B1: { code: 'PHOM_JOIN_REJECTED', message: 'nope' } } });
  const created = await group.createTable('B2', { stake: 100 });
  const failed = await group.joinTable('B1', created.rid);
  assert.equal(failed.ok, false);
  assert.equal(group.roleOf('B1'), null);
  const next = await group.joinTable('B3', created.rid);
  assert.equal(next.role, ROLE.READY, 'the free READY role goes to the next joiner');
});

test('T5: leaving frees a READY / NOT_READY role but the KEY keeps its own', async () => {
  const { group } = mk();
  const created = await group.createTable('B2', { stake: 100 });
  await group.joinTable('B1', created.rid);
  await group.leave('B1');
  assert.equal(group.roleOf('B1'), null);
  await group.leave('B2');
  assert.equal(group.roleOf('B2'), ROLE.KEY);
});

test('T6 vs A3: a kick is only REPORTED in manual mode, and rejoined (paced) when TỰ ĐỘNG is on', async () => {
  const { coord, group } = mk();
  const notices = []; group.on('notice', (n) => notices.push(n.event));
  const created = await group.createTable('B2', { stake: 100 });
  await group.joinTable('B1', created.rid);
  coord.seats.delete('B1');
  coord.fire('kicked', { id: 'B1', message: 'Bạn thoát vì không sẵn sàng' });
  await new Promise((r) => setImmediate(r));
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B1').length, 1, 'manual: no rejoin');
  assert.ok(notices.includes('KICKED'));
  await group.setAuto(true, { creatorId: 'B2', stake: 100 });   // A2: keeps the group, brings B1/B3 back
  const before = cmds(coord, 'JOIN').filter((e) => e.id === 'B1').length;
  coord.seats.delete('B1');
  coord.fire('kicked', { id: 'B1', message: 'x' });
  await new Promise((r) => setTimeout(r, 0));
  await group.joinTable('B3', created.rid); // drains the queue (the rejoin is ahead of it)
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B1').length, before + 1, 'auto: rejoined once');
});

test('A1: TỰ ĐỘNG forms the group — leave, create, then join one browser at a time', async () => {
  const { coord, group } = mk();
  coord.seats.set('B1', 111); coord.seats.set('B2', 222);
  const res = await group.setAuto(true, { creatorId: 'B1', stake: 1000 });
  assert.equal(res.ok, true, JSON.stringify(res.error || res));
  assert.deepEqual(res.roles, { B1: 'KEY', B2: 'READY', B3: 'NOT_READY' });
  const seq = coord.sent.map((e) => e.id + ':' + e.cmd);
  assert.deepEqual(seq.slice(0, 2), ['B1:LEAVE', 'B2:LEAVE'], 'old seats are released first');
  assert.ok(seq.indexOf('B2:JOIN') < seq.indexOf('B3:JOIN'), 'joins are sequential, never together');
});

test('A1: TỰ ĐỘNG without a stake (and with no group) refuses and turns itself back off', async () => {
  const { group } = mk();
  const res = await group.setAuto(true, { creatorId: 'B1' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_INVALID_STAKE');
  assert.equal(group.autoActive(), false);
});

test('A4 vs T7: a lost table is re-created when auto is on, and only reported when it is off', async () => {
  const gone = { code: 'PHOM_JOIN_REJECTED', message: 'Phòng không tồn tại', serverCode: 102 };
  const manual = mk({ joinFails: { B1: gone } });
  const created = await manual.group.createTable('B2', { stake: 100 });
  const notices = []; manual.group.on('notice', (n) => notices.push(n.event));
  await manual.group.joinTable('B1', created.rid);
  assert.ok(notices.includes('TABLE_LOST'));
  assert.equal(manual.group.active(), false, 'manual: the group is dissolved, nothing re-created');

  const auto = mk();
  await auto.group.setAuto(true, { creatorId: 'B2', stake: 100 });
  const rid = auto.group.snapshot().rid;
  auto.coord.seats.delete('B1');
  Object.assign(auto.coord, { manualJoinByCode: async function (id, r, key) { this.sent.push({ at: this.clock, id, cmd: 'JOIN', rid: r, key: key || '' }); if (r === rid) return { ok: false, error: gone }; this.seats.set(id, r); return { ok: true, rid: r }; } });
  auto.coord.fire('kicked', { id: 'B1', message: 'x' });
  await new Promise((r) => setTimeout(r, 0));
  await auto.group.joinTable('B3', 999999); // drain
  assert.notEqual(auto.group.snapshot().rid, rid, 'auto: a new table was created');
});

test('A6: unticking TỰ ĐỘNG cancels what is queued and stops rejoining; seats stay as they are', async () => {
  const { coord, group } = mk();
  await group.setAuto(true, { creatorId: 'B1', stake: 100 });
  const seatedBefore = coord.seats.size;
  await group.setAuto(false);
  assert.equal(group.autoActive(), false);
  assert.equal(coord.seats.size, seatedBefore, 'nobody was moved');
  const before = cmds(coord, 'JOIN').length;
  coord.seats.delete('B2');
  coord.fire('kicked', { id: 'B2', message: 'x' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cmds(coord, 'JOIN').length, before, 'no automatic rejoin any more');
  assert.ok(group.active(), 'the group itself is kept for manual play');
});

test('THOÁT BÀN TẤT CẢ: auto off, everyone leaves (paced), the group is dissolved', async () => {
  const { coord, group } = mk();
  await group.setAuto(true, { creatorId: 'B1', stake: 100 });
  const leavesBefore = cmds(coord, 'LEAVE').length;
  await group.leaveAll();
  assert.equal(group.autoActive(), false);
  assert.equal(group.active(), false);
  assert.equal(cmds(coord, 'LEAVE').length, leavesBefore + 3);
});

test('STAKE: one stake for the session — set in the tool, reused by a bar TẠO that sends none', async () => {
  const { coord, group } = mk();
  const none = await group.createTable('B1', {});           // no stake anywhere yet
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'PHOM_INVALID_STAKE');
  assert.match(none.error.message, /tool Phỏm/);
  group.setStake(500);
  assert.equal(group.stake(), 500);
  const made = await group.createTable('B1', {});           // the bar sends no stake → the tool's is used
  assert.equal(made.ok, true, JSON.stringify(made.error || made));
  assert.equal(cmds(coord, 'CREATE').at(-1).stake, 500);
  assert.equal(group.snapshot().selectedStake, 500);
  // TỰ ĐỘNG with no stake argument uses the same session stake
  const auto = await group.setAuto(true, { creatorId: 'B2' });
  assert.equal(auto.ok, true, JSON.stringify(auto.error || auto));
  assert.equal(cmds(coord, 'CREATE').at(-1).stake, 500);
});
