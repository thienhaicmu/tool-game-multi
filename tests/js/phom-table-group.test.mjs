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
    ready: new Set(), round: false,
    isReady(id) { return this.ready.has(id); },
    isTableHost: () => false,
    tableHostUid: () => null,
    roundRunning() { return this.round; },
    async leaveTable(id) { this.sent.push({ at: this.clock, id, cmd: 'LEAVE' }); this.seats.delete(id); return { ok: true }; },
    async setAutoReadyPref(id, on) { this.sent.push({ at: this.clock, id, cmd: 'PREF', on }); return { ok: true }; },
    async sendTableReady(id) { this.sent.push({ at: this.clock, id, cmd: 'READY' }); this.ready.add(id); return { ok: true }; },
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
  const group = createTableGroup({ coord, random: opts.random || rnd, sleep: (ms) => { coord.clock += ms; return Promise.resolve(); }, now: () => coord.clock, rejoinDelayMs: 0, replacePollMs: 1, replaceWaitMs: opts.replaceWaitMs });
  return { coord, group };
}
// the kick → rejoin runs on its own timer (outside the queue): let it fire
const tick = () => new Promise((r) => setTimeout(r, 3));
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

test('QUEUE (TỰ ĐỘNG): two operations asked for at once run one after another, never interleaved', async () => {
  const { coord, group } = mk();
  group._auto = true;
  const a = group.findTable('B1', { stake: 100 });
  const b = group.joinTable('B2', 3700000);
  await Promise.all([a, b]);
  const order = coord.sent.map((e) => e.id + ':' + e.cmd);
  assert.deepEqual(order.slice(0, 2), ['B1:PREF', 'B1:FIND'], 'the search finishes before the join starts');
  assert.ok(order.indexOf('B2:JOIN') > order.indexOf('B1:FIND'));
});

test('MANUAL clicks are independent per account: one account\'s long Dò Key never makes another account\'s Vào wait', async () => {
  const { coord, group } = mk({ scanHangs: ['B3'] });
  await group.findTable('B2', { stake: 100 });
  const slow = group.scanTable('B3');            // B3 busy for a long time…
  const r = await group.joinTable('B1', 3700000); // …B1's Vào still goes now
  assert.equal(r.ok, true);
  assert.ok(cmds(coord, 'JOIN').some((e) => e.id === 'B1'));
  group.cancelSearch('B3'); await slow;
});

test('SCENARIO (manual): Dò Key → KEY; the 1st to sit = SẴN SÀNG, the 2nd = CHƯA SS + ReJoin; SẴN SÀNG readies once CHƯA SS sits', async () => {
  const { coord, group } = mk();
  const created = await group.findTable('B2', { stake: 500 });       // any account can be the KEY
  assert.equal(created.ok, true);
  assert.equal(group.roleOf('B2'), ROLE.KEY);
  assert.equal(group.rid(), null, 'no số bàn until Tạo finds it');
  const first = await group.scanTable('B1');                         // Tạo: finds the KEY's table, sits first
  assert.equal(first.ok, true, JSON.stringify(first.error || first));
  assert.equal(first.role, ROLE.READY, '1st to sit at the KEY = SẴN SÀNG');
  assert.equal(cmds(coord, 'SCAN')[0].keyUid, 'uid-B2'); assert.equal(cmds(coord, 'SCAN')[0].stake, 500);
  assert.equal(group.rid(), coord.keyRid, 'the số bàn — in every SS box');
  assert.equal(coord.seatedRid('B2'), coord.keyRid, 'the KEY adopts it');
  assert.equal(cmds(coord, 'READY').length, 0, 'not ready yet: alone with the KEY the host would owe a start');
  const second = await group.scanTable('B3');                        // số bàn known → Tạo is simply Vào
  assert.equal(second.role, ROLE.NOT_READY, '2nd to sit = CHƯA SẴN SÀNG');
  assert.equal(group.rejoinOn('B3'), false, 'manual: ReJoin stays off until its button is pressed (or TỰ ĐỘNG is ticked)');
  assert.deepEqual(cmds(coord, 'JOIN').map((e) => [e.id, e.rid, e.expectUid]), [['B3', coord.keyRid, 'uid-B2']]);
  assert.deepEqual(cmds(coord, 'READY').map((e) => e.id), ['B1'], 'SẴN SÀNG readied once CHƯA SS sat down');
  assert.ok(coord.sent.findIndex((e) => e.cmd === 'READY') > coord.sent.findIndex((e) => e.id === 'B3' && e.cmd === 'JOIN'));
  assert.ok(cmds(coord, 'PREF').every((e) => e.on === false), 'auto-ready always off, like the reference tool');
});

test('T2a: Tạo without a KEY, or on the KEY itself, is refused before anything is sent', async () => {
  const { coord, group } = mk();
  assert.equal((await group.scanTable('B1')).error.code, 'PHOM_NO_KEY');
  await group.findTable('B2', { stake: 100 });
  assert.equal((await group.scanTable('B2')).error.code, 'PHOM_KEY_CANNOT_SCAN');
  assert.equal(cmds(coord, 'SCAN').length, 0);
});

test('T2a: a failed Tạo takes no role — the next one to sit is SẴN SÀNG', async () => {
  const { group } = mk({ scanFails: { B1: { code: 'PHOM_NO_KEY_TABLE', message: 'nope' } } });
  await group.findTable('B2', { stake: 100 });
  const failed = await group.scanTable('B1');
  assert.equal(failed.ok, false);
  assert.equal(group.roleOf('B1'), null);
  const next = await group.scanTable('B3');
  assert.equal(next.role, ROLE.READY);
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
  await group.scanTable('B1');                 // SẴN SÀNG
  await group.joinTable('B3', group.rid());    // CHƯA SS, ReJoin on
  const rid = group.rid();
  coord.seats.delete('B1');
  coord.fire('kicked', { id: 'B1', message: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B1').length, 0, 'manual: SẴN SÀNG is not rejoined');
  coord.seats.delete('B3');
  coord.fire('kicked', { id: 'B3', message: 'Bạn bị kick vì không sẵn sàng' });
  await tick();
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length, 1, 'manual, ReJoin not pressed: CHƯA SS is only reported');
  assert.ok(notices.includes('KICKED'));
  await group.rejoin('B3');                                        // the user presses ReJoin: back now, and after every kick
  coord.seats.delete('B3');
  coord.fire('kicked', { id: 'B3', message: 'Bạn bị kick vì không sẵn sàng' });
  await tick();
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length, 3, 'manual + ReJoin pressed: comes straight back');
  await group.setAuto(true, { creatorId: 'B2', stake: 100 });   // A2: keeps the group, brings B1 back
  const before = cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length;
  for (let i = 0; i < 8; i++) {                                    // more than any per-minute cap would allow
    coord.seats.delete('B3');
    coord.fire('kicked', { id: 'B3', message: 'x' });
    coord.fire('kicked', { id: 'B3', message: 'x' });              // a duplicate report queues ONE rejoin
    await tick();
  }
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B3' && e.rid === rid).length, before + 8, 'back after every kick');
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
  await tick();
  assert.equal(joins(), n + 1, 'back by itself');
  const off = await group.rejoin('B3');
  assert.equal(off.rejoinOn, false);
  coord.seats.delete('B3'); coord.fire('kicked', { id: 'B3', message: 'x' });
  await tick();
  assert.equal(joins(), n + 1, 'off: only reported');
});

test('T2a side by side: two browsers run Tạo at once; the first to find the KEY sits (SẴN SÀNG), the other stops and joins (CHƯA SS)', async () => {
  const { coord, group } = mk({ scanHangs: ['B3'] });
  await group.findTable('B2', { stake: 100 });
  const slow = group.scanTable('B3');           // still searching…
  const fast = await group.scanTable('B1');     // …while this one finds the KEY (not queued behind B3)
  assert.equal(fast.role, ROLE.READY);
  const r3 = await slow;
  assert.equal(r3.cancelled, true, 'B3 stopped scanning');
  await group.leave('B9');                      // drains the queued join
  assert.ok(cmds(coord, 'CANCEL').some((e) => e.id === 'B3'));
  assert.deepEqual(cmds(coord, 'JOIN').map((e) => [e.id, e.rid]), [['B3', coord.keyRid]], 'and joined the số bàn B1 found');
  assert.equal(group.roleOf('B3'), ROLE.NOT_READY);
  assert.deepEqual(cmds(coord, 'READY').map((e) => e.id), ['B1']);
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
  assert.deepEqual(res.roles, { B1: 'KEY', B2: 'READY', B3: 'NOT_READY' });
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

// user 2026-10-06: manual stays manual — only what the user presses; TỰ ĐỘNG searches again
test('A4 vs T7: a lost table is replaced when auto is on, and only reported when it is off', async () => {
  const gone = { code: 'PHOM_JOIN_REJECTED', message: 'Phòng không tồn tại', serverCode: 102 };
  const manual = mk({ joinFails: { B3: gone } });
  await manual.group.findTable('B2', { stake: 100 });
  await manual.group.scanTable('B1');
  const notices = []; manual.group.on('notice', (n) => notices.push(n.event));
  await manual.group.joinTable('B3', manual.group.rid());
  assert.ok(notices.includes('TABLE_LOST'));
  assert.equal(manual.group.active(), false, 'manual: the group is dissolved, no new table is taken');
  assert.equal(cmds(manual.coord, 'FIND').length, 1, 'manual: no Dò Key by itself');

  const auto = mk();
  await auto.group.setAuto(true, { creatorId: 'B2', stake: 100 });
  const rid = auto.group.snapshot().rid;
  auto.coord.seats.delete('B1');
  Object.assign(auto.coord, { joinTable: async function (id, r) { this.sent.push({ at: this.clock, id, cmd: 'JOIN', rid: r }); if (r === rid) return { ok: false, error: gone }; this.seats.set(id, r); return { ok: true, rid: r }; } });
  auto.coord.fire('kicked', { id: 'B1', message: 'x' });
  await tick();
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
  coord.seats.delete('B2');                       // the SẴN SÀNG member
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

test('ROUND: after each round SẴN SÀNG readies again (auto-ready stays off); never during a round', async () => {
  const { coord, group } = mk();
  await group.setAuto(true, { creatorId: 'B1', stake: 100 });
  assert.deepEqual(cmds(coord, 'READY').map((e) => e.id), ['B2']);
  coord.round = true; coord.ready.clear();             // a round is dealt
  coord.fire('roundEnd', {}); await group.leave('B9');
  assert.equal(cmds(coord, 'READY').length, 1, 'not while a round runs');
  coord.round = false;                                  // the round is over
  coord.fire('roundEnd', {}); await group.leave('B9');
  assert.deepEqual(cmds(coord, 'READY').map((e) => e.id), ['B2', 'B2'], 'ready again for the next round');
});

test('BELL: the 4th player readies at the group table → one FOURTH_READY notice (bell) per player per round', async () => {
  const { coord, group } = mk();
  const bells = []; group.on('notice', (n) => { if (n.event === 'FOURTH_READY') bells.push(n); });
  await group.setAuto(true, { creatorId: 'B1', stake: 100 });
  // the three browsers each see it
  for (const id of ['B1', 'B2', 'B3']) coord.fire('strangerReady', { id, uid: 'x_9', name: 'nguoila' });
  assert.equal(bells.length, 1);
  assert.deepEqual([bells[0].name, bells[0].notReadyId, bells[0].keyId], ['nguoila', 'B3', 'B1'], 'who readies by hand, who starts');
  coord.fire('roundEnd', {}); await group.leave('B9');
  coord.fire('strangerReady', { id: 'B1', uid: 'x_9', name: 'nguoila' });
  assert.equal(bells.length, 2, 'rings again next round');
  coord.seats.delete('B2');
  coord.fire('strangerReady', { id: 'B2', uid: 'x_8', name: 'khac' });
  assert.equal(bells.length, 2, 'only at the group table');
});

// ---- FAST REJOIN (P3 CHƯA SẴN SÀNG is kicked every ~10s) ---------------------------------------------------------
test('REJOIN fast path: a kicked CHƯA SS member is back at once — no queue, no pacing, no duplicate 363', async () => {
  const { coord, group } = mk();
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');                 // SẴN SÀNG
  await group.joinTable('B3', group.rid());    // CHƯA SS
  await group.rejoin('B3');                    // ReJoin pressed
  const clockAtKick = coord.clock;
  const sentAtKick = coord.sent.length;
  coord.seats.delete('B3');
  coord.fire('kicked', { id: 'B3', message: 'Bạn bị kick vì không sẵn sàng' });
  await tick();
  const after = coord.sent.slice(sentAtKick);
  assert.equal(after[0].cmd, 'JOIN', 'the first command after the kick is the join itself');
  assert.equal(after[0].id, 'B3'); assert.equal(after[0].rid, group.rid());
  assert.equal(after[0].at, clockAtKick, 'no pacing before the rejoin');
  assert.equal(after.filter((e) => e.cmd === 'PREF').length, 0, '363 is not sent again (the coordinator sends it after every join)');
  assert.equal(group.roleOf('B3'), ROLE.NOT_READY, 'keeps its role');
});

test('REJOIN fast path is cancelled by Thoát bàn tất cả (timers cleared)', async () => {
  const group = createTableGroup({ coord: fakeCoord(), sleep: () => Promise.resolve(), random: () => 0.5, rejoinDelayMs: 20 });
  const coord = group._coord;
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');
  await group.joinTable('B3', group.rid());
  const n = cmds(coord, 'JOIN').length;
  coord.seats.delete('B3'); coord.fire('kicked', { id: 'B3', message: 'x' });
  await group.leaveAll();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cmds(coord, 'JOIN').length, n, 'no rejoin after leaving all');
});

// ---- THAY ACC — the procedure --------------------------------------------------------------------------------------
test('THAY ACC: the new browser takes the SAME role (+ReJoin) and sits at the group table once it is in the game', async () => {
  const { coord, group } = mk({ ids: ['B1', 'B2', 'B3', 'B4'] });
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');                 // SẴN SÀNG
  await group.joinTable('B3', group.rid());    // CHƯA SS
  await group.rejoin('B3');                    // its ReJoin is on — it moves with the seat
  const rid = group.rid();
  let inGame = false;
  coord.browserReady = (id) => id !== 'B4' || inGame;
  const notices = []; group.on('notice', (n) => notices.push(n));
  coord.seats.delete('B3');
  const r = group.replaceMember('B3', 'B4');
  assert.equal(r.moved, true); assert.equal(r.role, ROLE.NOT_READY);
  assert.equal(group.roleOf('B4'), ROLE.NOT_READY); assert.equal(group.roleOf('B3'), null);
  assert.equal(group.rejoinOn('B4'), true, 'CHƯA SS keeps its ReJoin');
  await tick();
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B4').length, 0, 'waits while the new browser is not in the game');
  inGame = true;
  await tick(); await group.leave('B9');
  const j = cmds(coord, 'JOIN').filter((e) => e.id === 'B4');
  assert.equal(j.length, 1); assert.equal(j[0].rid, rid);
  assert.ok(notices.some((n) => n.event === 'MEMBER_REPLACED' && n.from === 'B3' && n.id === 'B4'));
  assert.ok(notices.some((n) => n.event === 'JOINED' && n.id === 'B4' && n.role === ROLE.NOT_READY));
});

test('THAY ACC before the số bàn is known: the new browser runs TẠO instead of VÀO', async () => {
  const { coord, group } = mk({ ids: ['B1', 'B2', 'B3', 'B4'] });
  await group.findTable('B2', { stake: 100 });
  group._group.roles.set('B1', ROLE.READY);    // a member that has not found the table yet
  group.replaceMember('B1', 'B4');
  await tick(); await group.leave('B9');
  assert.equal(cmds(coord, 'SCAN').filter((e) => e.id === 'B4').length, 1);
});

test('THAY ACC of the KEY: manual → group dissolved; TỰ ĐỘNG → the new browser forms a new group', async () => {
  const m = mk({ ids: ['B1', 'B2', 'B3', 'B4'] });
  await m.group.findTable('B2', { stake: 100 });
  const res = m.group.replaceMember('B2', 'B4');
  assert.equal(res.dissolved, true); assert.equal(res.reform, false);
  assert.equal(m.group.active(), false);

  const a = mk({ ids: ['B1', 'B4', 'B3'] });
  await a.group.setAuto(true, { creatorId: 'B1', stake: 100 });
  const finds = cmds(a.coord, 'FIND').length;
  const r2 = a.group.replaceMember('B1', 'B4');
  assert.equal(r2.reform, true);
  await tick(); await a.group.leave('B9');
  assert.equal(cmds(a.coord, 'FIND').length, finds + 1);
  assert.equal(cmds(a.coord, 'FIND').at(-1).id, 'B4', 'the replacement is the new KEY');
  assert.equal(a.group.autoActive(), true);
});

test('THAY ACC: gives up (notice) when the new browser never gets into the game', async () => {
  const { coord, group } = mk({ ids: ['B1', 'B2', 'B3', 'B4'], replaceWaitMs: 0 });
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');
  coord.browserReady = (id) => id !== 'B4';
  const notices = []; group.on('notice', (n) => notices.push(n.event));
  group.replaceMember('B1', 'B4');
  coord.clock += 10;
  await tick();
  assert.ok(notices.includes('REPLACE_TIMEOUT'));
});

// ---- GĐ3 — control rules ---------------------------------------------------------------------------------------
test('ONE operation per account: a second request for a busy account is refused with what it is doing; Thoát never is', async () => {
  const { coord, group } = mk({ scanHangs: ['B3'] });
  await group.findTable('B2', { stake: 100 });
  const scanning = group.scanTable('B3');
  await tick();
  assert.equal(group.actingOf('B3'), 'SCAN');
  const again = await group.joinTable('B3', 123);
  assert.equal(again.busy, true); assert.equal(again.error.code, 'PHOM_ACC_BUSY');
  assert.match(again.error.message, /Tạo/);
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length, 0, 'nothing sent for the refused request');
  group.cancelSearch('B3');
  await scanning;
  assert.equal(group.actingOf('B3'), null, 'free again once it ended');
  assert.equal((await group.leave('B3')).ok !== undefined, true, 'Thoát is always accepted');
});

test('rule D2: Dò Key never replaces a group with members silently — the 2nd press (force) does', async () => {
  const { coord, group } = mk();
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');
  coord.seats.delete('B2');                          // the KEY is not seated any more
  const first = await group.findTable('B3', { stake: 100 });
  assert.equal(first.ok, false); assert.equal(first.needsConfirm, true); assert.equal(first.error.code, 'PHOM_GROUP_EXISTS');
  assert.equal(group.roleOf('B1'), ROLE.READY, 'the old group is untouched');
  const second = await group.findTable('B3', { stake: 100, force: true });
  assert.equal(second.ok, true);
  assert.equal(group.roleOf('B3'), ROLE.KEY);
  assert.equal(group.roleOf('B1'), null, 'a new group');
});

test('rule D2: while the KEY is seated, Dò Key on another account is refused even with force (no split over 2 tables)', async () => {
  const { group } = mk();
  await group.findTable('B2', { stake: 100 });
  const r = await group.findTable('B3', { stake: 100, force: true });
  assert.equal(r.error.code, 'PHOM_KEY_EXISTS');
});

test('a fast rejoin never overlaps a request the user is running on that account', async () => {
  const { coord, group } = mk({ scanHangs: [] });
  await group.findTable('B2', { stake: 100 });
  await group.scanTable('B1');
  await group.joinTable('B3', group.rid());
  await group.rejoin('B3');
  group._acting.set('B3', 'JOIN');                   // the user's own Vào is in flight
  const n = cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length;
  coord.seats.delete('B3'); coord.fire('kicked', { id: 'B3', message: 'x' });
  await tick();
  assert.equal(cmds(coord, 'JOIN').filter((e) => e.id === 'B3').length, n, 'no second join on top of it');
});

// ---- T8 — FULL TABLE: 4 players → CHƯA SS readies, then the KEY starts once everyone but the host is ready ---------
function fullTable() {
  const m = mk();
  const c = m.coord;
  c.players = 3; c.othersAllReady = false; c.strangerIsReady = false;
  c.tablePlayerCount = () => c.players;
  c.othersReady = () => c.othersAllReady;
  c.strangerReady = () => c.strangerIsReady;
  c.isTableHost = (id) => id === 'B2';
  c.sendTableStart = async (id) => { c.sent.push({ at: c.clock, id, cmd: 'START' }); return { ok: true }; };
  return m;
}
async function formed(m) {
  await m.group.findTable('B2', { stake: 100 });
  await m.group.scanTable('B1');              // SẴN SÀNG
  await m.group.joinTable('B3', m.group.rid()); // CHƯA SS
}

test('T8 (user rule 2026-10-05): CHƯA SS waits until a STRANGER is ready, then readies 1–2 s later; then the KEY starts AT ONCE', async () => {
  const m = fullTable(); await formed(m);
  const readyBefore = cmds(m.coord, 'READY').length;
  m.coord.fire('seats', {}); await m.group.leave('B9');
  assert.equal(cmds(m.coord, 'READY').length, readyBefore, '3 players: no extra ready');
  assert.equal(cmds(m.coord, 'START').length, 0);
  m.coord.players = 4;                              // a stranger sat down…
  m.coord.fire('seats', {}); await m.group.leave('B9');
  assert.equal(cmds(m.coord, 'READY').filter((e) => e.id === 'B3').length, 0, '…but is not ready yet → CHƯA SS keeps waiting');
  m.coord.strangerIsReady = true;                   // …the stranger readies
  const t0 = m.coord.clock;
  m.coord.fire('seats', {}); await tick();
  const r3 = cmds(m.coord, 'READY').find((e) => e.id === 'B3');
  assert.ok(r3, 'the CHƯA SS member readied');
  assert.ok(r3.at - t0 >= 1000 && r3.at - t0 <= 2000, 'after a random 1–2 s (' + (r3.at - t0) + ' ms)');
  m.coord.fire('seats', {}); await m.group.leave('B9');
  assert.equal(cmds(m.coord, 'START').length, 0, 'the stranger is not ready yet → the KEY waits');
  m.coord.othersAllReady = true;
  const tReady = m.coord.clock;
  m.coord.fire('seats', {}); m.coord.fire('seats', {}); await m.group.leave('B9');
  const starts = cmds(m.coord, 'START');
  assert.equal(starts[0] && starts[0].at, tReady, 'the KEY starts at once — no pause (user 2026-10-06)');
  assert.equal(starts.length, 1, 'started once');
  assert.equal(starts[0].id, 'B2', 'by the KEY (host)');
});

test('T8: never while a round runs; asks again after the round ends', async () => {
  const m = fullTable(); await formed(m);
  m.coord.players = 4; m.coord.othersAllReady = true; m.coord.ready.add('B3');
  m.coord.round = true;
  m.coord.fire('seats', {}); await m.group.leave('B9');
  assert.equal(cmds(m.coord, 'START').length, 0, 'a round is running');
  m.coord.round = false;
  m.coord.fire('seats', {}); await m.group.leave('B9');
  assert.equal(cmds(m.coord, 'START').length, 1);
  m.coord.fire('roundEnd', {}); await m.group.leave('B9');
  m.coord.fire('seats', {}); await m.group.leave('B9');
  assert.equal(cmds(m.coord, 'START').length, 2, 'the next round starts again');
});

test('rule D2 (live 2026-10-05): after a round everyone is out → another account\'s Dò Key just forms a new group, no confirm', async () => {
  const { coord, group } = mk();
  await group.findTable('B1', { stake: 100 });
  await group.scanTable('B2');
  await group.joinTable('B3', group.rid());
  for (const id of ['B1', 'B2', 'B3']) coord.seats.delete(id); // played, everyone left
  const r = await group.findTable('B2', { stake: 100 });
  assert.equal(r.ok, true, 'no "bấm lần nữa" when nobody of the old group sits at its table');
  assert.equal(group.roleOf('B2'), ROLE.KEY);
  assert.equal(group.roleOf('B1'), null);
});

// live coseat (3): a player who left / was kicked / sat down again is NOT ready any more (a stale ready kept the
// rejoining account from being readied); the group's decisions and every READY seen reach coseat.jsonl
test('wiring: stale ready dropped on t:2 / kick / fresh join; group log + READY_SEEN go to coseat.jsonl', async () => {
  const { readFileSync } = await import('node:fs');
  const coord = readFileSync(new URL('../../desktop/protocol/phom/host-table-coordinator.cjs', import.meta.url), 'utf8');
  assert.match(coord, /if \(cls\.t === 2 && cls\.seat && cls\.seat\.uid != null\) this\._unready\(cls\.seat\.uid\);/);
  assert.match(coord, /if \(rec\.ctx\.uid\(\) != null\) this\._unready\(rec\.ctx\.uid\(\)\);\s*this\.emit\('kicked'/);
  assert.match(coord, /cls\.accepted === true && meta\.direction !== 'send' && rec\.ctx\.uid\(\) != null\) this\._unready/);
  assert.match(coord, /this\._log\('READY_SEEN'/);
  const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /else if \(l && l\.tag === 'PHOM-GROUP'\) log\.file\(\{ at: Date\.now\(\), \.\.\.l \}\)/);
});

// user rule 2026-10-05: the stranger leaves while CHƯA SS waits its 1–2 s, or before the KEY's start goes out
function heldSleep(m) {
  const held = [];
  const group = createTableGroup({ coord: m.coord, random: () => 0.5, now: () => m.coord.clock, sleep: (ms) => new Promise((r) => held.push({ ms, r })) });
  return { group, held, releaseAll: async () => { while (held.length) { held.shift().r(); await tick(); } } };
}
test('T8: the stranger leaves during CHƯA SS\'s 1–2 s → it does NOT ready (stays waiting)', async () => {
  const m = fullTable(); m.coord.listeners = {};
  const h = heldSleep(m); const g = h.group;
  const logs = []; g._log = (ev, d) => logs.push({ ev, ...d });
  const run = (async () => { await g.findTable('B2', { stake: 100 }); await g.scanTable('B1'); await g.joinTable('B3', g.rid()); })();
  while (!g.rid() || !m.coord.isSeated('B3')) { await h.releaseAll(); await tick(); }
  await run; await h.releaseAll();
  m.coord.players = 4; m.coord.strangerIsReady = true;
  m.coord.fire('seats', {}); await tick();
  assert.ok(logs.some((l) => l.ev === 'FULL_READY_SCHEDULED'), 'the 1–2 s wait started');
  m.coord.players = 3; m.coord.strangerIsReady = false;  // …the stranger left
  await h.releaseAll();
  assert.equal(cmds(m.coord, 'READY').filter((e) => e.id === 'B3').length, 0);
  assert.ok(logs.some((l) => l.ev === 'FULL_READY_SKIPPED' && l.reason === 'STRANGER_GONE'));
});
test('T8: the stranger leaves before the KEY\'s start goes out → no start (never a round of our three alone)', async () => {
  const m = fullTable(); m.coord.listeners = {};
  const h = heldSleep(m); const g = h.group;
  const run = (async () => { await g.findTable('B2', { stake: 100 }); await g.scanTable('B1'); await g.joinTable('B3', g.rid()); })();
  while (!g.rid() || !m.coord.isSeated('B3')) { await h.releaseAll(); await tick(); }
  await run; await h.releaseAll();
  m.coord.players = 4; m.coord.strangerIsReady = true; m.coord.othersAllReady = true; m.coord.ready.add('B3');
  let free; g._enqueue('LONG', () => new Promise((r) => { free = r; }));   // something else holds the queue
  m.coord.fire('seats', {}); await tick();               // START queued behind it (it has no pause of its own any more)
  m.coord.players = 3;                                   // …the stranger left
  free({ ok: true }); await tick(); await h.releaseAll();
  assert.equal(cmds(m.coord, 'START').length, 0);
});

test('B5: the start is refused once → tried again once (conditions checked again)', async () => {
  const m = fullTable(); await formed(m);
  let calls = 0;
  m.coord.sendTableStart = async (id) => { calls++; m.coord.sent.push({ at: m.coord.clock, id, cmd: 'START' }); return calls === 1 ? { ok: false, error: { code: 'X' } } : { ok: true }; };
  m.coord.players = 4; m.coord.strangerIsReady = true; m.coord.othersAllReady = true; m.coord.ready.add('B3');
  m.coord.fire('seats', {});
  for (let i = 0; i < 10 && calls < 2; i++) await tick();
  assert.equal(calls, 2, 'one retry');
  m.coord.fire('seats', {}); await tick(); await tick();
  assert.equal(calls, 2, 'no more after the success');
});
