// docs/phom-kich-ban.md — the group flow itself: pacing (0.8–2.5s before every command), one operation at a time,
// and MANUAL vs AUTO (manual only does what was pressed; auto rejoins and takes another table). Driven against a
// FAKE coordinator so every step is observable and the test is deterministic; the protocol level is covered by
// phom-find-table.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTableGroup, ROLE, PACE_MIN_MS, PACE_MAX_MS } = require('../../desktop/protocol/phom/table-group.cjs');

// A coordinator stand-in: records every command with the virtual time it was sent at.
function fakeCoord({ ids = ['B1', 'B2', 'B3'], joinFails = {}, scanFails = {}, scanHangs = [], findFails = false } = {}) {
  const c = {
    clock: 0, sent: [], seats: new Map(), rid: 3700000, listeners: {},
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev, payload) { for (const fn of (this.listeners[ev] || [])) fn(payload); },
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
    async leaveTable(id) { this.sent.push({ at: this.clock, id, cmd: 'LEAVE' }); this.seats.delete(id); return { ok: true }; },
    async setAutoReadyPref(id, on) { this.sent.push({ at: this.clock, id, cmd: 'PREF', on }); return { ok: true }; },
    async sendTableReady(id, rid) { this.sent.push({ at: this.clock, id, cmd: 'READY', rid }); return { ok: true }; },
    // DÒ KEY: seated alone at a fresh table whose số bàn nobody knows yet (shown under the stake channel)
    async findKeyTable(id, opts) {
      if (opts && typeof opts.pace === 'function') await opts.pace();
      this.sent.push({ at: this.clock, id, cmd: 'FIND', stake: opts.stake });
      if (findFails) return { ok: false, error: { code: 'PHOM_NO_KEY_TABLE', message: 'no' } };
      this.keyRid = this.rid++; this.seats.set(id, 145);
      return { ok: true, channel: 145 };
    },
    // TẠO: lands at the KEY's table and reports its số bàn
    async scanForKeyTable(id, opts) {
      if (opts && typeof opts.pace === 'function') await opts.pace();
      this.sent.push({ at: this.clock, id, cmd: 'SCAN', stake: opts.stake, keyUid: opts.keyUid });
      const fail = scanFails[id];
      if (fail) { delete scanFails[id]; return { ok: false, error: fail }; }
      if (scanHangs.includes(id)) return new Promise((resolve) => { this.hanging[id] = resolve; });
      this.seats.set(id, this.keyRid);
      return { ok: true, rid: this.keyRid, found: true };
    },
    adoptTableRid(id, rid) { this.seats.set(id, rid); return true; },
    hanging: {},
    cancelSearch(id) { this.sent.push({ at: this.clock, id, cmd: 'CANCEL' }); const r = this.hanging[id]; if (r) { delete this.hanging[id]; r({ ok: false, cancelled: true }); } return { ok: true }; },
    async joinTable(id, rid, opts = {}) {
      this.sent.push({ at: this.clock, id, cmd: 'JOIN', rid, expectUid: opts.expectUid || null });
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
  assert.ok(coord.sent.length >= 6, 'find + two joins at least');
  let prev = 0;
  for (const e of coord.sent) { assert.ok(e.at - prev >= PACE_MIN_MS, `${e.cmd} waited ${e.at - prev}ms`); prev = e.at; }
  const { coord: c2, group: g2 } = mk({ random: () => 1 });   // longest allowed wait
  await g2.setAuto(true, { creatorId: 'B1', stake: 100 });
  let p2 = 0;
  for (const e of c2.sent) { assert.ok(e.at - p2 <= PACE_MAX_MS, `${e.cmd} waited ${e.at - p2}ms`); p2 = e.at; }
});

test('QUEUE: two operations asked for at once run one after another, never interleaved', async () => {
  const { coord, group } = mk();
  const a = group.findTable('B1', { stake: 100 });
  const b = group.joinTable('B2', 3700000);
  await Promise.all([a, b]);
  const order = coord.sent.map((e) => e.id + ':' + e.cmd);
  assert.deepEqual(order.slice(0, 2), ['B1:PREF', 'B1:FIND'], 'the search finishes before the join starts');
  assert.ok(order.indexOf('B2:JOIN') > order.indexOf('B1:FIND'));
});

test('T1 + T2a + T2: Dò Key makes KEY; Tạo finds the số bàn (CHƯA SS, ReJoin on); Vào joins it (SẴN SÀNG)', async () => {
  const { coord, group } = mk();
  const created = await group.findTable('B2', { stake: 500 });
  assert.equal(created.ok, true);
  assert.equal(group.roleOf('B2'), ROLE.KEY);
  assert.equal(group.rid(), null, 'no số bàn until Tạo finds it');
  assert.deepEqual(cmds(coord, 'PREF').map((e) => [e.id, e.on]), [['B2', false]], 'KEY never auto-readies');
  const first = await group.scanTable('B1');
  assert.equal(first.ok, true, JSON.stringify(first.error || first));
  assert.equal(first.role, ROLE.NOT_READY, 'the first to join the KEY is never ready — the host would owe a start');
  assert.equal(group.rejoinOn('B1'), true, 'and its ReJoin is on: it is kicked every ~10s by design');
  assert.equal(cmds(coord, 'SCAN')[0].keyUid, 'uid-B2', 'Tạo looks for the uid of the KEY');
  assert.equal(cmds(coord, 'SCAN')[0].stake, 500, 'at the stake the KEY sat at');
  assert.equal(group.rid(), coord.keyRid);
  assert.equal(coord.seatedRid('B2'), coord.keyRid, 'the KEY adopts the số bàn');
  const second = await group.scanTable('B3'); // số bàn known → Tạo is simply Vào
  assert.equal(second.role, ROLE.READY);
  assert.equal(cmds(coord, 'SCAN').length, 1);
  assert.deepEqual(cmds(coord, 'JOIN').map((e) => [e.id, e.rid, e.expectUid]), [['B3', coord.keyRid, 'uid-B2']], 'VÀO at the group table checks the KEY is there');
  for (const [id, cmd] of [['B1', 'SCAN'], ['B3', 'JOIN']]) {
    const pref = coord.sent.findIndex((e) => e.id === id && e.cmd === 'PREF');
    const sit = coord.sent.findIndex((e) => e.id === id && e.cmd === cmd);
    assert.ok(pref >= 0 && pref < sit, id);
  }
  assert.deepEqual(cmds(coord, 'READY').map((e) => e.id), ['B3']);
  assert.equal(cmds(coord, 'PREF').find((e) => e.id === 'B1').on, false, 'searching never auto-readies');
});

test('T2a: Tạo without a KEY, or on the KEY itself, is refused before anything is sent', async () => {
  const { coord, group } = mk();
  assert.equal((await group.scanTable('B1')).error.code, 'PHOM_NO_KEY');
  await group.findTable('B2', { stake: 100 });
  assert.equal((await group.scanTable('B2')).error.code, 'PHOM_KEY_CANNOT_SCAN');
  assert.equal(cmds(coord, 'SCAN').length, 0);
});

test('T2a: a failed Tạo takes no role — the next one to find the KEY is CHƯA SS', async () => {
  const { group } = mk({ scanFails: { B1: { code: 'PHOM_NO_KEY_TABLE', message: 'nope' } } });
  await group.findTable('B2', { stake: 100 });
  const failed = await group.scanTable('B1');
  assert.equal(failed.ok, false);
  assert.equal(group.roleOf('B1'), null);
  const next = await group.scanTable('B3');
  assert.equal(next.role, ROLE.NOT_READY);
});

test('T5: leaving frees a READY / NOT_READY role but the KEY keeps its own', async () => {
  const { group } = mk();
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');
  await group.leave('B1');
  assert.equal(group.roleOf('B1'), null);
  await group.leave('B2');
  assert.equal(group.roleOf('B2'), ROLE.KEY);
});

test('T6 vs A3: manual — the SẴN SÀNG member is only REPORTED when kicked, the CHƯA SS one comes back; TỰ ĐỘNG brings back every time', async () => {
  const { coord, group } = mk();
  const notices = []; group.on('notice', (n) => notices.push(n.event));
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');                 // CHƯA SS, ReJoin on
  await group.joinTable('B3', group.rid());    // SẴN SÀNG
  const rid = group.rid();
  coord.seats.delete('B3');
  coord.fire('kicked', { id: 'B3', message: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length, 1, 'manual: SẴN SÀNG is not rejoined');
  coord.seats.delete('B1');
  coord.fire('kicked', { id: 'B1', message: 'Bạn bị kick vì không sẵn sàng' });
  await group.leave('B9');
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B1').length, 1, 'manual: CHƯA SS comes straight back');
  assert.ok(notices.includes('KICKED'));
  await group.setAuto(true, { creatorId: 'B2', stake: 100 });   // A2: keeps the group, brings B1/B3 back
  const before = cmds(coord, 'JOIN').filter((e) => e.id === 'B1').length;
  for (let i = 0; i < 8; i++) {                                    // more than any per-minute cap would allow
    coord.seats.delete('B1');
    coord.fire('kicked', { id: 'B1', message: 'x' });
    coord.fire('kicked', { id: 'B1', message: 'x' });              // a duplicate report queues ONE rejoin
    await group.leave('B9');                                      // drains the queue (the rejoin is ahead of it)
  }
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B1' && e.rid === rid).length, before + 8, 'auto: back after every kick');
  assert.equal(notices.includes('REJOIN_EXHAUSTED'), false);
});

test('ReJoin toggle: ON brings the browser back after a kick even with TỰ ĐỘNG off; pressing it again switches OFF', async () => {
  const { coord, group } = mk();
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');
  coord.seats.delete('B3');
  const on = await group.rejoin('B3');
  assert.equal(on.ok, true); assert.equal(on.rejoinOn, true); assert.equal(group.rejoinOn('B3'), true);
  const joins = () => cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length;
  const n = joins();
  coord.seats.delete('B3'); coord.fire('kicked', { id: 'B3', message: 'x' });
  await group.leave('B9');
  assert.equal(joins(), n + 1, 'back by itself');
  const off = await group.rejoin('B3');
  assert.equal(off.rejoinOn, false);
  coord.seats.delete('B3'); coord.fire('kicked', { id: 'B3', message: 'x' });
  await group.leave('B9');
  assert.equal(joins(), n + 1, 'off: only reported');
});

test('T2a side by side: two browsers run Tạo at once; the first to find the KEY sits (CHƯA SS), the other stops and joins (SẴN SÀNG)', async () => {
  const { coord, group } = mk({ scanHangs: ['B3'] });
  await group.findTable('B2', { stake: 100 });
  const slow = group.scanTable('B3');           // still searching…
  const fast = await group.scanTable('B1');     // …while this one finds the KEY (not queued behind B3)
  assert.equal(fast.role, ROLE.NOT_READY);
  const r3 = await slow;
  assert.equal(r3.cancelled, true, 'B3 stopped scanning');
  await group.leave('B9');                      // drains the queued join
  assert.ok(cmds(coord, 'CANCEL').some((e) => e.id === 'B3'));
  assert.deepEqual(cmds(coord, 'JOIN').map((e) => [e.id, e.rid]), [['B3', coord.keyRid]], 'and joined the số bàn B1 found');
  assert.equal(group.roleOf('B3'), ROLE.READY);
  assert.equal(cmds(coord, 'SCAN').length, 2, 'both were scanning at the same time');
});

test('T1: a second Dò Key while the KEY sits is refused — it would split the accounts over two tables', async () => {
  const { coord, group } = mk();
  await group.findTable('B1', { stake: 100 });
  const r = await group.findTable('B2', { stake: 100 });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'PHOM_KEY_EXISTS'); assert.match(r.error.message, /P1/);
  assert.equal(cmds(coord, 'FIND').length, 1);
  assert.equal(group.roleOf('B1'), ROLE.KEY);
});

test('A1: TỰ ĐỘNG forms the group — leave, Dò Key, Tạo, then Vào — one browser at a time', async () => {
  const { coord, group } = mk();
  coord.seats.set('B1', 111); coord.seats.set('B2', 222);
  const res = await group.setAuto(true, { creatorId: 'B1', stake: 1000 });
  assert.equal(res.ok, true, JSON.stringify(res.error || res));
  assert.deepEqual(res.roles, { B1: 'KEY', B2: 'NOT_READY', B3: 'READY' });
  const seq = coord.sent.map((e) => e.id + ':' + e.cmd);
  assert.deepEqual(seq.slice(0, 2), ['B1:LEAVE', 'B2:LEAVE'], 'old seats are released first');
  assert.ok(seq.indexOf('B1:FIND') < seq.indexOf('B2:SCAN') && seq.indexOf('B2:SCAN') < seq.indexOf('B3:JOIN'), 'Dò Key → Tạo → Vào');
  assert.equal(res.rid, coord.keyRid);
});

test('A1: TỰ ĐỘNG without a stake (and with no group) refuses and turns itself back off', async () => {
  const { group } = mk();
  const res = await group.setAuto(true, { creatorId: 'B1' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_INVALID_STAKE');
  assert.equal(group.autoActive(), false);
});

test('A4 vs T7: a lost table is replaced when auto is on, and only reported when it is off', async () => {
  const gone = { code: 'PHOM_JOIN_REJECTED', message: 'Phòng không tồn tại', serverCode: 102 };
  const manual = mk({ joinFails: { B3: gone } });
  await manual.group.findTable('B2', { stake: 100 });
  await manual.group.scanTable('B1');
  const notices = []; manual.group.on('notice', (n) => notices.push(n.event));
  await manual.group.joinTable('B3', manual.group.rid());
  assert.ok(notices.includes('TABLE_LOST'));
  assert.equal(manual.group.active(), false, 'manual: the group is dissolved, no new table is taken');

  const auto = mk();
  await auto.group.setAuto(true, { creatorId: 'B2', stake: 100 });
  const rid = auto.group.snapshot().rid;
  auto.coord.seats.delete('B1');
  Object.assign(auto.coord, { joinTable: async function (id, r) { this.sent.push({ at: this.clock, id, cmd: 'JOIN', rid: r }); if (r === rid) return { ok: false, error: gone }; this.seats.set(id, r); return { ok: true, rid: r }; } });
  auto.coord.fire('kicked', { id: 'B1', message: 'x' });
  await new Promise((r) => setTimeout(r, 0));
  await auto.group.joinTable('B3', 999999); // drain
  assert.notEqual(auto.group.snapshot().rid, rid, 'auto: another table was taken');
  assert.equal(cmds(auto.coord, 'FIND').length, 2, 'by a fresh Dò Key');
  assert.equal(cmds(auto.coord, 'FIND').at(-1).id, 'B2', 'with the same KEY browser');
});

test('A6: unticking TỰ ĐỘNG cancels what is queued and stops rejoining; seats stay as they are', async () => {
  const { coord, group } = mk();
  await group.setAuto(true, { creatorId: 'B1', stake: 100 });
  const seatedBefore = coord.seats.size;
  await group.setAuto(false);
  assert.equal(group.autoActive(), false);
  assert.equal(coord.seats.size, seatedBefore, 'nobody was moved');
  const before = cmds(coord, 'JOIN').length;
  coord.seats.delete('B3');                       // the SẴN SÀNG member
  coord.fire('kicked', { id: 'B3', message: 'x' });
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

test('STAKE: one stake for the session — set in the tool, reused by a bar TÌM BÀN that sends none', async () => {
  const { coord, group } = mk();
  const none = await group.findTable('B1', {});            // no stake anywhere yet
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'PHOM_INVALID_STAKE');
  assert.match(none.error.message, /tool Phỏm/);
  group.setStake(500);
  assert.equal(group.stake(), 500);
  const made = await group.findTable('B1', {});            // the bar sends no stake → the tool's is used
  assert.equal(made.ok, true, JSON.stringify(made.error || made));
  assert.equal(cmds(coord, 'FIND').at(-1).stake, 500);
  assert.equal(group.snapshot().selectedStake, 500);
  // TỰ ĐỘNG with no stake argument uses the same session stake
  const auto = await group.setAuto(true, { creatorId: 'B2' });
  assert.equal(auto.ok, true, JSON.stringify(auto.error || auto));
  assert.equal(cmds(coord, 'FIND').at(-1).stake, 500);
});
