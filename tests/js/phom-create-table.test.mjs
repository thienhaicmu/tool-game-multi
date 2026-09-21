// §create — TẠO BÀN via the game's own flow (CMD 311 → CMD 308 with a room key), the SỐ BÀN list, §room-key.
//
// Protocol source: the game client's code cache (2026-09-21) —
//   requestcreateRoom(gid,b,Mu,pwd) → [6,"Simms","channelPlugin",{cmd:308,aid:1,gid,b,Mu,iJ:true,inc:false,pwd}]
//   reply [5,{ri:{rid,b,sid,Mu,gid,pwd},cmd:308}] → the client itself sends [3,"Simms",ri.rid,ri.pwd]
//   refusal: no ri, {mgs:"…"}
//   clicking an unlocked table row → joinRoom(rid,0,"")  (empty room code)
//   Phỏm: the TẠO BÀN popup refuses an empty password, and the live server dropped three 308s sent with pwd:""
//   (capture 2026-09-21T11-57) — the sim below does the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { buildCreateTableFrame } = require('../../desktop/protocol/phom/phom-wire.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');
const { createTableGroup } = require('../../desktop/protocol/phom/table-group.cjs');
// The group flow (docs/phom-kich-ban.md) runs unpaced here; its pacing/queueing rules are phom-table-group.test.mjs.
const groupFor = (coord) => createTableGroup({ coord, paceMinMs: 0, paceMaxMs: 0, sleep: () => Promise.resolve() });

// Server sim. `gameAutoJoin` = the game client answers a 308 reply with its own JOIN (the real client does).
class CreateSim {
  constructor({ gameAutoJoin = true, refuse = null, hpwd = '', stakes = [100, 500, 20000], answer311 = true } = {}) {
    this.gameAutoJoin = gameAutoJoin; this.refuse = refuse; this.hpwd = hpwd; this.stakes = stakes; this.answer311 = answer311;
    this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' };
    this.rooms = new Map(); this.nextRid = 3700000;
    this.sent = { B1: [], B2: [], B3: [] }; this.coord = null;
  }
  attach(c) { this.coord = c; }
  feed(id, raw, direction = 'recv') { this.coord.ingest(id, { raw, direction, targetId: id, url: 'wss://sim', now: Date.now() }); }
  table(room) { return JSON.stringify([5, { b: room.b, hpwd: this.hpwd, ps: room.seats.map((uid, sit) => ({ uid, sit, r: false })), cmd: 202 }]); }
  broadcast(room) { for (const [bid, uid] of Object.entries(this.uids)) if (room.seats.includes(uid)) this.feed(bid, this.table(room)); }
  join(id, rid, key = '') {
    const room = this.rooms.get(rid); const uid = this.uids[id];
    if (!room) { this.feed(id, JSON.stringify([3, false, 102, rid, 'Phòng không tồn tại'])); return; }
    if (room.key && key !== room.key) { this.feed(id, JSON.stringify([3, false, 103, rid, 'Sai mật khẩu phòng'])); return; }
    if (!room.seats.includes(uid)) room.seats.push(uid);
    this.feed(id, '[3,true,0,-1,null]');
    this.broadcast(room);
  }
  sendFor(id) {
    return async (frame) => {
      const j = JSON.parse(frame); this.sent[id].push(j);
      if (j[0] === 6 && j[3] && j[3].cmd === 311) { if (this.answer311) this.feed(id, JSON.stringify([5, { b: this.stakes, mB: 0, cmd: 311 }])); return { ok: true }; }
      if (j[0] === 6 && j[3] && j[3].cmd === 308) {
        if (!j[3].pwd) return { ok: true }; // the live server silently drops a Phỏm create without a password
        if (this.refuse) { this.feed(id, JSON.stringify([5, { mgs: this.refuse, cmd: 308 }])); return { ok: true }; }
        const rid = this.nextRid++; this.rooms.set(rid, { rid, b: j[3].b, Mu: j[3].Mu, key: j[3].pwd, seats: [] });
        this.feed(id, JSON.stringify([5, { ri: { rid, b: j[3].b, sid: 1, Mu: j[3].Mu, gid: 8, pwd: j[3].pwd }, cmd: 308 }]));
        if (this.gameAutoJoin) {
          // the GAME client's own JOIN — seen by the tool only as an outgoing frame on the capture stream
          const joinRaw = JSON.stringify([3, 'Simms', rid, j[3].pwd]);
          this.feed(id, joinRaw, 'send');
          this.join(id, rid, j[3].pwd);
        }
        return { ok: true };
      }
      if (j[0] === 3) { this.join(id, j[2], j[3]); return { ok: true }; }
      if (j[0] === 4) {
        for (const room of this.rooms.values()) { const had = room.seats.includes(this.uids[id]); room.seats = room.seats.filter((u) => u !== this.uids[id]); if (had) this.broadcast(room); }
        this.feed(id, '[4,true,1,-1,0,""]'); return { ok: true };
      }
      return { ok: true };
    };
  }
}
function mk(simOpts) {
  const sim = new CreateSim(simOpts);
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, delay: () => Promise.resolve(), createAutoJoinMs: 40, createOptionsMs: 40,
    findBudgetMs: 60, findPollMs: 10, rerollCooldownMs: 0, joinRejectGraceMs: 10, leaveConfirmMs: 40,
    profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })),
  });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) {
    sim.feed(id, `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`);
    sim.feed(id, JSON.stringify([5, { rs: [{ rid: 139, b: 100, uC: 20, Mu: 4, zn: 'Simms', gid: 8, rn: 'Phom#0' }], cmd: 300 }]));
    coord.setIdentity(id, { aid: '1' });
  }
  return { coord, sim };
}
const joins = (sim, id) => sim.sent[id].filter((f) => f[0] === 3);

test('CREATE-00: 311 then 308 — exactly the game client frames, the 308 carrying a generated 6-digit key', async () => {
  assert.deepEqual(JSON.parse(buildCreateTableFrame({ stake: 20000, password: '123456' })), [6, 'Simms', 'channelPlugin', { cmd: 308, aid: 1, gid: 8, b: 20000, Mu: 4, iJ: true, inc: false, pwd: '123456' }]);
  const { coord, sim } = mk();
  const r = await groupFor(coord).createTable('B1', { stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ext = sim.sent.B1.filter((f) => f[0] === 6 && f[3].cmd !== 363).map((f) => f[3]); // 363 = the role's auto-ready preference
  assert.deepEqual(ext[0], { cmd: 311, gid: 8, aid: 1 });
  assert.equal(ext[1].cmd, 308); assert.match(ext[1].pwd, /^\d{6}$/);
  assert.equal(r.roomKey, ext[1].pwd);
  assert.equal(coord.manualBrowserSnapshot()[0].roomKey, r.roomKey, 'the bar can show SS + KEY');
});

test('CREATE-06: a stake the 311 reply does not allow fails before any 308; an empty list = not enough gold', async () => {
  const a = mk({ stakes: [100, 500] });
  const r = await a.coord.createTable('B1', { stake: 20000 });
  assert.equal(r.error.code, 'PHOM_CREATE_STAKE_NOT_ALLOWED'); assert.deepEqual(r.allowedStakes, [100, 500]);
  assert.equal(a.sim.sent.B1.some((f) => f[3] && f[3].cmd === 308), false);
  const b = mk({ stakes: [] });
  assert.equal((await b.coord.createTable('B1', { stake: 100 })).error.code, 'PHOM_CREATE_NO_GOLD');
});

test('CREATE-07: no 311 reply → the 308 is still sent (the options step never blocks a create)', async () => {
  const { coord } = mk({ answer311: false });
  const r = await coord.createTable('B1', { stake: 500 });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('CREATE-01: the 308 reply is classified with the new số bàn; a refusal carries the server reason', () => {
  const ok = classifyPhomFrame('[5,{"ri":{"rid":3109174,"b":20000,"sid":1,"Mu":4,"gid":8,"pwd":""},"cmd":308}]');
  assert.equal(ok.type, 'CREATE_TABLE_RESULT'); assert.equal(ok.ok, true); assert.equal(ok.rid, 3109174); assert.equal(ok.stake, 20000);
  const no = classifyPhomFrame('[5,{"mgs":"Bạn không đủ tiền","cmd":308}]');
  assert.equal(no.type, 'CREATE_TABLE_RESULT'); assert.equal(no.ok, false); assert.equal(no.message, 'Bạn không đủ tiền');
  assert.equal(classifyPhomFrame(buildCreateTableFrame({ stake: 100 })).type, 'CREATE_TABLE_REQUEST');
});

test('CREATE-02: the game joins its new table by itself → the tool sends NO second JOIN, and holds a real SS', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true });
  const r = await coord.createTable('B1', { stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rid, 3700000);
  assert.equal(joins(sim, 'B1').length, 0, 'a tool JOIN on top of the game JOIN would get the player moved');
  const b1 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1');
  assert.equal(b1.manualState, 'JOINED'); assert.equal(b1.rid, 3700000); assert.equal(b1.joinedViaChannel, false);
  assert.equal(coord.sharedRid(), 3700000);
});

test('CREATE-03: the game did not join → the tool JOINs the created rid itself with the table key', async () => {
  const { coord, sim } = mk({ gameAutoJoin: false });
  const r = await coord.createTable('B1', { stake: 500 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(joins(sim, 'B1'), [[3, 'Simms', 3700000, r.roomKey]]);
});

test('CREATE-04: a refused create fails fast with the server message', async () => {
  const { coord } = mk({ refuse: 'Bạn không đủ tiền tạo bàn chơi!', stakes: [5000000] });
  const r = await coord.createTable('B1', { stake: 5000000 });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'PHOM_CREATE_REJECTED'); assert.match(r.error.message, /không đủ tiền/);
});

test('CREATE-05: no stake → typed error, nothing sent', async () => {
  const { coord, sim } = mk();
  const r = await coord.createTable('B1', {});
  assert.equal(r.error.code, 'PHOM_INVALID_STAKE'); assert.equal(sim.sent.B1.length, 0);
});

test('GATHER-01: create + gather seats all three at the SAME số bàn, followers join with the created key', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true, hpwd: 'server-room-code' });
  const r = await groupFor(coord).setAuto(true, { creatorId: 'B2', stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const room = sim.rooms.get(r.rid);
  assert.deepEqual([...room.seats].sort(), ['1_1', '1_2', '1_3']);
  for (const id of ['B1', 'B3']) {
    const js = joins(sim, id);
    assert.ok(js.length >= 1);
    for (const f of js) { assert.equal(f[2], r.rid, 'follower joins the created số bàn'); assert.equal(f[3], r.roomKey, 'the key the tool created — never the table hpwd'); }
  }
});

test('GATHER-02: a browser still seated elsewhere leaves first, then joins the new table', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true });
  // B3 is sitting at an old table.
  sim.rooms.set(3600000, { rid: 3600000, b: 100, Mu: 4, seats: [] });
  await coord.manualJoinRoom('B3', 3600000, { timeoutMs: 60 });
  const r = await groupFor(coord).setAuto(true, { creatorId: 'B1', stake: 100 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.ok(sim.sent.B3.some((f) => f[0] === 4), 'B3 left its old table');
  assert.deepEqual(sim.rooms.get(3600000).seats, []);
  assert.ok(sim.rooms.get(r.rid).seats.includes('1_3'));
});

test('ROOM-KEY: a join / rejoin of the group table sends the created key — never the anchor table hpwd', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true, hpwd: 'anchor-hpwd' });
  const group = groupFor(coord);
  const c = await group.createTable('B1', { stake: 100 });
  const j = await group.joinTable('B2', c.rid);
  assert.equal(j.ok, true, JSON.stringify(j));
  await group.rejoin('B3');
  for (const id of ['B2', 'B3']) for (const f of joins(sim, id)) { assert.equal(f[3], c.roomKey); assert.notEqual(f[3], 'anchor-hpwd'); }
  assert.equal(coord.roomKeyFor(1234567), '', 'a table the tool did not create gets the empty code');
  assert.equal(joins(sim, 'B2').every((f) => f[3] !== 'anchor-hpwd'), true);
});

test('ROOM-LIST: the full số bàn list survives the 14-channel CMD 300 replies that follow it', () => {
  const ctx = new PhomContext({ profileId: 'B1' });
  const meta = { direction: 'recv', targetId: 'B1', url: 'wss://sim' };
  const tables = [{ rid: 3673500, b: 100, uC: 1, Mu: 4, zn: 'Simms', gid: 8, rn: 'Phom' }, { rid: 3538594, b: 10000, uC: 3, Mu: 4, zn: 'Simms', gid: 8, rn: 'Phom' }, { rid: 139, b: 100, uC: 20, Mu: 4, zn: 'Simms', gid: 8, rn: 'Phom#0' }];
  ctx.observe({ ...meta, raw: JSON.stringify([5, { rs: tables, cmd: 300 }]), now: 1000 });
  ctx.observe({ ...meta, raw: JSON.stringify([5, { rs: [tables[2]], cmd: 300 }]), now: 2000 });
  assert.deepEqual(ctx.roomList().map((r) => r.rid), [3673500, 3538594], 'stake channel 139 is not a số bàn');
  assert.equal(ctx.roomListAt(), 1000);
  assert.deepEqual(ctx.channels().map((r) => r.rid), [139]);
});

// §group — the standard flow: creator = KEY, next = READY, last = NOT_READY; a kicked member rejoins with the key.
// The sim models the account AUTO-READY preference (CMD 363 aRd): a client whose preference is on readies by itself
// on join (live capture 2026-09-21T12-06), so NOT_READY must have it switched off before it sits down.
function withGroupFlow(sim) {
  sim.pref = {}; sim.readyFrames = []; sim.order = [];
  const baseTable = sim.table.bind(sim);
  sim.table = (room) => { const j = JSON.parse(baseTable(room)); j[1].ps.forEach((p, i) => { p.C = i === 0; }); return JSON.stringify(j); };
  const baseJoin = sim.join.bind(sim);
  sim.join = (id, rid, key) => {
    baseJoin(id, rid, key);
    const room = sim.rooms.get(rid); const uid = sim.uids[id];
    sim.order.push(['join', id]);
    if (sim.pref[id] && room && room.seats.indexOf(uid) > 0) sim.readyBroadcast(room, uid);
  };
  sim.readyBroadcast = (room, uid) => { for (const [bid, u] of Object.entries(sim.uids)) if (room.seats.includes(u)) sim.feed(bid, JSON.stringify([5, { uid, cmd: 5 }])); };
  const baseSend = sim.sendFor.bind(sim);
  sim.sendFor = (id) => { const inner = baseSend(id); return async (frame) => {
    const j = JSON.parse(frame);
    if (j[0] === 6 && j[3] && j[3].cmd === 363) { sim.pref[id] = j[3].aRd === 'true'; sim.order.push(['pref', id, j[3].aRd]); return { ok: true }; }
    if (j[0] === 5 && j[3] && j[3].cmd === 5) { sim.readyFrames.push(id); const room = sim.rooms.get(j[2]); if (room) sim.readyBroadcast(room, sim.uids[id]); return { ok: true }; }
    return inner(frame);
  }; };
  sim.kick = (id, msg) => {
    for (const room of sim.rooms.values()) { if (room.seats.includes(sim.uids[id])) { room.seats = room.seats.filter((u) => u !== sim.uids[id]); sim.broadcast(room); } }
    sim.feed(id, JSON.stringify([4, true, 2, -1, 1, msg]));
  };
  return sim;
}
function mkGroup() {
  const sim = withGroupFlow(new CreateSim({ gameAutoJoin: true }));
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, delay: () => Promise.resolve(), createAutoJoinMs: 40, createOptionsMs: 40, kickRejoinMs: 0,
    findBudgetMs: 60, findPollMs: 10, rerollCooldownMs: 0, joinRejectGraceMs: 10, leaveConfirmMs: 40,
    profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })),
  });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) { sim.feed(id, `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`); coord.setIdentity(id, { aid: '1' }); }
  return { coord, sim, group: groupFor(coord) };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test('READY/HOST pushes are classified; the client ready frame is not mistaken for a READY push', () => {
  assert.deepEqual((({ type, uid }) => ({ type, uid }))(classifyPhomFrame('[5,{"uid":"1_644556017","dn":"baycao1004","cmd":5}]')), { type: 'USER_READY', uid: '1_644556017' });
  assert.equal(classifyPhomFrame('[5,{"uid":"1_644556017","dn":"baycao1004","cmd":203}]').type, 'HOST_CHANGED');
  assert.notEqual(classifyPhomFrame('[5,"Simms",3752077,{"cmd":5}]').type, 'USER_READY');
  const kick = classifyPhomFrame('[4,true,2,-1,1,"Bạn thoát vì không bắt đầu"]');
  assert.equal(kick.resultCode, 2); assert.equal(kick.resultMessage, 'Bạn thoát vì không bắt đầu');
});

test('A1 (live sim): KEY / READY / NOT_READY — preferences set BEFORE joining, only READY is ready, the host never starts', async () => {
  const { sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.deepEqual(r.roles, { B2: 'KEY', B1: 'READY', B3: 'NOT_READY' });
  for (const id of ['B1', 'B3']) {
    const prefAt = sim.order.findIndex((e) => e[0] === 'pref' && e[1] === id);
    const joinAt = sim.order.findIndex((e) => e[0] === 'join' && e[1] === id);
    assert.ok(prefAt >= 0 && prefAt < joinAt, `${id}: auto-ready preference must be set before it sits down`);
  }
  assert.equal(sim.pref.B2, false); assert.equal(sim.pref.B1, true); assert.equal(sim.pref.B3, false);
  const by = Object.fromEntries(group.snapshot().members.map((m) => [m.id, m]));
  assert.equal(by.B1.ready, true); assert.equal(by.B3.ready, false); assert.equal(by.B2.ready, false);
  assert.equal(sim.readyFrames.includes('B2'), false, 'the KEY/host never sends cmd 5 (that would be BẮT ĐẦU)');
});

test('A3 (live sim): with TỰ ĐỘNG on, a member the server removes rejoins the SAME số bàn with the key and its role', async () => {
  const { sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  const joinsBefore = joins(sim, 'B3').length;
  sim.kick('B3', 'Bạn thoát vì không sẵn sàng');
  await tick();
  const js = joins(sim, 'B3');
  assert.equal(js.length, joinsBefore + 1);
  assert.deepEqual(js.at(-1), [3, 'Simms', r.rid, r.roomKey]);
  assert.ok(sim.rooms.get(r.rid).seats.includes(sim.uids.B3));
  assert.equal(sim.pref.B3, false, 'still NOT_READY after the rejoin');
});

test('A4 (live sim): the table is gone when a kicked member rejoins → the group re-forms at a new table', async () => {
  const { sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  sim.kick('B1', 'x'); sim.kick('B3', 'x'); sim.kick('B2', 'x');
  sim.rooms.delete(r.rid);
  for (let i = 0; i < 20 && !(group.snapshot() && group.snapshot().rid !== r.rid); i++) await tick();
  const g = group.snapshot();
  assert.ok(g && g.rid !== r.rid, 'a new table');
  await tick();
  assert.deepEqual([...sim.rooms.get(g.rid).seats].sort(), ['1_1', '1_2', '1_3']);
});

test('A5 (live sim): ĐỔI KEY re-forms the group at a fresh table with a fresh key; THOÁT BÀN TẤT CẢ ends it', async () => {
  const { group } = mkGroup();
  const a = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  const b = await group.changeKey();
  assert.equal(b.ok, true, JSON.stringify(b.error || b));
  assert.notEqual(b.rid, a.rid); assert.notEqual(b.roomKey, a.roomKey);
  assert.equal(group.snapshot().members.find((m) => m.role === 'KEY').id, 'B2', 'the creator stays KEY');
  await group.leaveAll();
  assert.equal(group.active(), false);
});

// Manual flow (header): TẠO on one browser only; the others press VÀO — first joiner READY, the next NOT_READY.
test('T1+T2 (live sim): TẠO creates for THIS browser only (KEY); VÀO order decides READY then NOT_READY', async () => {
  const { sim, group } = mkGroup();
  const c = await group.createTable('B3', { stake: 100 });
  assert.equal(c.ok, true, JSON.stringify(c.error || c));
  assert.equal(c.role, 'KEY');
  assert.equal(joins(sim, 'B1').length + joins(sim, 'B2').length, 0, 'nobody else is pulled in');
  const first = await group.joinTable('B1', c.rid);
  assert.equal(first.ok, true, JSON.stringify(first.error || first));
  assert.equal(first.role, 'READY');
  assert.deepEqual(joins(sim, 'B1').at(-1), [3, 'Simms', c.rid, c.roomKey], 'VÀO uses the table key');
  const second = await group.joinTable('B2', c.rid);
  assert.equal(second.role, 'NOT_READY');
  const prefAt = sim.order.findIndex((e) => e[0] === 'pref' && e[1] === 'B2');
  const joinAt = sim.order.findIndex((e) => e[0] === 'join' && e[1] === 'B2');
  assert.ok(prefAt >= 0 && prefAt < joinAt && sim.pref.B2 === false, 'NOT_READY switches auto-ready off before sitting');
  const by = Object.fromEntries(group.snapshot().members.map((m) => [m.id, m]));
  assert.equal(by.B1.ready, true); assert.equal(by.B2.ready, false); assert.equal(by.B3.role, 'KEY');
});

test('T6 (live sim): TỰ ĐỘNG off → a kicked member is NOT rejoined automatically (state KICKED, user presses ReJoin)', async () => {
  const { coord, sim, group } = mkGroup();
  const c = await group.createTable('B3', { stake: 100 });
  await group.joinTable('B1', c.rid);
  const before = joins(sim, 'B1').length;
  sim.kick('B1', 'Bạn thoát vì không sẵn sàng');
  await tick();
  assert.equal(joins(sim, 'B1').length, before, 'no automatic rejoin');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1').manualState, 'KICKED');
  const back = await group.rejoin('B1');
  assert.equal(back.ok, true, JSON.stringify(back.error || back));
  assert.deepEqual(joins(sim, 'B1').at(-1), [3, 'Simms', c.rid, c.roomKey]);
});

test('A1/A6 (live sim): TỰ ĐỘNG needs a stake; OFF stops rejoining; THOÁT BÀN TẤT CẢ turns it off', async () => {
  const { sim, group } = mkGroup();
  const bad = await group.setAuto(true, { creatorId: 'B1' });
  assert.equal(bad.ok, false); assert.equal(group.autoActive(), false);
  const on = await group.setAuto(true, { creatorId: 'B1', stake: 100 });
  assert.equal(on.ok, true, JSON.stringify(on.error || on)); assert.equal(group.autoActive(), true);
  assert.deepEqual(on.roles, { B1: 'KEY', B2: 'READY', B3: 'NOT_READY' });
  await group.setAuto(false);
  const before = joins(sim, 'B3').length;
  sim.kick('B3', 'x'); await tick();
  assert.equal(joins(sim, 'B3').length, before);
  await group.setAuto(true); // group exists → only brings the missing member back
  assert.equal(joins(sim, 'B3').length, before + 1);
  await group.leaveAll();
  assert.equal(group.autoActive(), false);
});
