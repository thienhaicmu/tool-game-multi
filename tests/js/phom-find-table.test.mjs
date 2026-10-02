// §find — TÌM BÀN via the game's own QUICK_PLAY (CMD 307 with the stake), the SỐ BÀN list, §room-key.
//
// Protocol source: the game client's code cache (2026-09-21 / 2026-10-02) —
//   requestquickPlay(gid)        → [6,"Simms","channelPlugin",{cmd:307,aid:1,gid,inc:false}]
//   requestquickPlayBet(gid,b)   → [6,"Simms","channelPlugin",{cmd:307,aid:1,gid,b,inc:false}]
//   reply [5,{ri:{rid,b,sid,Mu,gid,pwd},cmd:307|313}] → onReceiveQuickPlay → the client itself sends
//        requestJoinRoom(rid,sid,pwd) = [3,"Simms",rid,pwd]
//   nothing suitable: no ri, {mgs:"Không tìm thấy phòng thích hợp!"}
// The tool never sends CREATE_TABLE (308): a Phỏm table cannot be created without a password (the live server
// dropped three 308s sent with pwd:"", capture 2026-09-21T11-57) and a table with a password is one no other
// player can enter from the lobby — see docs/phom-kich-ban.md §5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { buildQuickPlayFrame } = require('../../desktop/protocol/phom/phom-wire.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');
const { createTableGroup } = require('../../desktop/protocol/phom/table-group.cjs');
// The group flow (docs/phom-kich-ban.md) runs unpaced here; its pacing/queueing rules are phom-table-group.test.mjs.
const groupFor = (coord) => createTableGroup({ coord, paceMinMs: 0, paceMaxMs: 0, sleep: () => Promise.resolve() });

// Server sim for QUICK_PLAY. The lobby holds PUBLIC tables (no password); a 307 is answered with a table that still
// has a free seat, else with the server's own "nothing suitable" message. `gameAutoJoin` = the game client answers
// the reply with its own JOIN (the real client does). `strangers` pre-seats other players at the table it hands out.
class QuickPlaySim {
  constructor({ gameAutoJoin = true, hpwd = '', strangers = 0, refusals = 0, neverFound = false, pwd = '' } = {}) {
    this.gameAutoJoin = gameAutoJoin; this.hpwd = hpwd; this.strangers = strangers;
    this.refusals = refusals; this.neverFound = neverFound; this.pwd = pwd;
    this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' };
    this.rooms = new Map(); this.nextRid = 3700000;
    this.sent = { B1: [], B2: [], B3: [] }; this.coord = null; this.asks = 0; this.lastGiven = null;
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
  // The table a 307 hands out: an existing public table of this stake with a free seat, else a fresh one. Like the
  // real matchmaker it spreads players out — the table handed out last time is only repeated when it is the only one.
  pick(stake) {
    const candidates = [...this.rooms.values()].filter((r) => r.b === stake && !r.key && r.seats.length < r.Mu);
    const spread = candidates.find((r) => r.rid !== this.lastGiven) || candidates[0];
    if (spread) { this.lastGiven = spread.rid; return spread; }
    const rid = this.nextRid++;
    const room = { rid, b: stake, Mu: 4, key: this.pwd, seats: [] };
    for (let i = 0; i < this.strangers; i++) room.seats.push('stranger_' + rid + '_' + i);
    this.rooms.set(rid, room); this.lastGiven = rid;
    return room;
  }
  sendFor(id) {
    return async (frame) => {
      const j = JSON.parse(frame); this.sent[id].push(j);
      if (j[0] === 6 && j[3] && j[3].cmd === 307) {
        this.asks++;
        if (this.neverFound || this.asks <= this.refusals) { this.feed(id, JSON.stringify([5, { mgs: 'Không tìm thấy phòng thích hợp!', cmd: 307 }])); return { ok: true }; }
        const room = this.pick(Number(j[3].b));
        this.feed(id, JSON.stringify([5, { ri: { rid: room.rid, b: room.b, sid: 1, Mu: room.Mu, gid: 8, pwd: room.key }, cmd: 307 }]));
        if (this.gameAutoJoin) {
          // the GAME client's own JOIN — seen by the tool only as an outgoing frame on the capture stream
          this.feed(id, JSON.stringify([3, 'Simms', room.rid, room.key]), 'send');
          this.join(id, room.rid, room.key);
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
  const sim = new QuickPlaySim(simOpts);
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, delay: () => Promise.resolve(), createAutoJoinMs: 40,
    findBudgetMs: 120, rerollCooldownMs: 0, joinRejectGraceMs: 10, leaveConfirmMs: 40,
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
const asks = (sim, id) => sim.sent[id].filter((f) => f[0] === 6 && f[3] && f[3].cmd === 307);

test('FIND-00: the 307 frame is exactly the game client shape, and the reply gives the real số bàn', async () => {
  assert.deepEqual(JSON.parse(buildQuickPlayFrame({ stake: 20000 })), [6, 'Simms', 'channelPlugin', { cmd: 307, aid: 1, gid: 8, inc: false, b: 20000 }]);
  assert.deepEqual(JSON.parse(buildQuickPlayFrame()), [6, 'Simms', 'channelPlugin', { cmd: 307, aid: 1, gid: 8, inc: false }]);
  const { coord, sim } = mk();
  const r = await groupFor(coord).findTable('B1', { stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rid, 3700000);
  const ext = sim.sent.B1.filter((f) => f[0] === 6 && f[3].cmd !== 363).map((f) => f[3]); // 363 = the role's auto-ready preference
  assert.deepEqual(ext, [{ cmd: 307, aid: 1, gid: 8, inc: false, b: 20000 }], 'one ask, nothing else — no 311, no 308');
});

test('FIND-00b: the tool NEVER creates a private table (no 308 on the wire, no generated key)', async () => {
  const { coord, sim } = mk();
  const r = await groupFor(coord).findTable('B1', { stake: 100 });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const id of ['B1', 'B2', 'B3']) assert.equal(sim.sent[id].some((f) => f[0] === 6 && f[3] && f[3].cmd === 308), false, id + ' sent a CREATE_TABLE');
  assert.equal(r.roomKey, '', 'a public table has no password, so none is invented');
  assert.deepEqual(joins(sim, 'B1').map((f) => f[3]), [], 'the game client did the JOIN itself');
});

test('FIND-01: the 307/313 reply is classified with the số bàn + the password a JOIN must carry', () => {
  const ok = classifyPhomFrame('[5,{"ri":{"rid":3109174,"b":20000,"sid":1,"Mu":4,"gid":8,"pwd":""},"cmd":307}]');
  assert.equal(ok.type, 'ROOM_ASSIGNED'); assert.equal(ok.ok, true); assert.equal(ok.rid, 3109174); assert.equal(ok.stake, 20000);
  assert.equal(ok.password, ''); assert.equal(ok.hasPassword, false);
  const bet = classifyPhomFrame('[5,{"ri":{"rid":4001794,"b":100,"sid":1,"Mu":4,"gid":8,"pwd":"482913"},"cmd":313}]');
  assert.equal(bet.type, 'ROOM_ASSIGNED'); assert.equal(bet.rid, 4001794); assert.equal(bet.password, '482913'); assert.equal(bet.hasPassword, true);
  const no = classifyPhomFrame('[5,{"mgs":"Không tìm thấy phòng thích hợp!","cmd":307}]');
  assert.equal(no.type, 'ROOM_ASSIGNED'); assert.equal(no.ok, false); assert.equal(no.message, 'Không tìm thấy phòng thích hợp!');
  assert.equal(classifyPhomFrame(buildQuickPlayFrame({ stake: 100 })).type, 'QUICK_PLAY_REQUEST');
  // the game's own CREATE_TABLE reply reads the same way (one handler in the game client), so a table the USER
  // created by hand in the web is still understood.
  assert.equal(classifyPhomFrame('[5,{"ri":{"rid":5,"b":100,"sid":1,"Mu":4,"gid":8,"pwd":"1"},"cmd":308}]').type, 'ROOM_ASSIGNED');
});

test('FIND-02: the game joins the assigned table by itself → the tool sends NO second JOIN, and holds a real SS', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true });
  const r = await coord.findPublicTable('B1', { stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(joins(sim, 'B1').length, 0, 'a tool JOIN on top of the game JOIN would get the player moved');
  const b1 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1');
  assert.equal(b1.manualState, 'JOINED'); assert.equal(b1.rid, r.rid); assert.equal(b1.joinedViaChannel, false);
  assert.equal(coord.sharedRid(), r.rid);
});

test('FIND-03: the game did not join → the tool JOINs the assigned rid itself with the password the server gave', async () => {
  const { coord, sim } = mk({ gameAutoJoin: false, pwd: '' });
  const r = await coord.findPublicTable('B1', { stake: 500 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(joins(sim, 'B1'), [[3, 'Simms', r.rid, '']]);
});

test('FIND-04: "Không tìm thấy phòng thích hợp" is retried (paced) until a table appears', async () => {
  const { coord, sim } = mk({ refusals: 2 });
  const r = await coord.findPublicTable('B1', { stake: 100 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(asks(sim, 'B1').length, 3, 'two refusals then the table');
});

test('FIND-05: no table for the whole budget → ONE typed error naming the stake and the server reason', async () => {
  const { coord, sim } = mk({ neverFound: true });
  const r = await coord.findPublicTable('B1', { stake: 100, budgetMs: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_PUBLIC_TABLE');
  assert.match(r.error.message, /Không tìm thấy bàn chờ cược 100 sau 3 phút/);
  assert.match(r.error.message, /Không tìm thấy phòng thích hợp/);
  assert.ok(asks(sim, 'B1').length >= 2, 'it kept asking while the budget lasted');
});

test('FIND-06: a table that cannot hold the rest of the group is left again and another is taken', async () => {
  const { coord, sim } = mk({ strangers: 3 }); // 3 strangers at a 4-seat table → room for one of ours only
  const r = await coord.findPublicTable('B1', { stake: 100, seatsNeeded: 2, budgetMs: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_PUBLIC_TABLE');
  assert.match(r.error.message, /không còn đủ 2 chỗ/);
  assert.ok(sim.sent.B1.some((f) => f[0] === 4), 'it left the table that was too full');
  // ... and with room for the group it is accepted, reporting what it found.
  const b = mk({ strangers: 1 });
  const ok = await b.coord.findPublicTable('B1', { stake: 100, seatsNeeded: 2 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.seatsTaken, 2); assert.equal(ok.capacity, 4);
});

test('FIND-07: no stake → typed error, nothing sent', async () => {
  const { coord, sim } = mk();
  const r = await coord.findPublicTable('B1', {});
  assert.equal(r.error.code, 'PHOM_INVALID_STAKE'); assert.equal(sim.sent.B1.length, 0);
});

test('GATHER-01: find + gather seats all three at the SAME số bàn, followers join with the server password', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true, hpwd: 'server-room-code' });
  const r = await groupFor(coord).setAuto(true, { creatorId: 'B2', stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const room = sim.rooms.get(r.rid);
  assert.deepEqual([...room.seats].sort(), ['1_1', '1_2', '1_3']);
  for (const id of ['B1', 'B3']) {
    const js = joins(sim, id);
    assert.ok(js.length >= 1);
    for (const f of js) { assert.equal(f[2], r.rid, 'follower joins the số bàn the server named'); assert.equal(f[3], '', 'a public table is joined with an empty password — never the table hpwd'); }
  }
  assert.equal(asks(sim, 'B1').length, 0, 'only the KEY browser asks for a table'); assert.equal(asks(sim, 'B3').length, 0);
});

test('GATHER-02: a browser still seated elsewhere leaves first, then joins the group table', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true });
  // B3 is sitting at an old table.
  sim.rooms.set(3600000, { rid: 3600000, b: 999, Mu: 4, seats: [] });
  await coord.manualJoinRoom('B3', 3600000, { timeoutMs: 60 });
  const r = await groupFor(coord).setAuto(true, { creatorId: 'B1', stake: 100 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.ok(sim.sent.B3.some((f) => f[0] === 4), 'B3 left its old table');
  assert.deepEqual(sim.rooms.get(3600000).seats, []);
  assert.ok(sim.rooms.get(r.rid).seats.includes('1_3'));
});

test('ROOM-KEY: a locked table is joined with the password the SERVER gave, and an unknown table with none', async () => {
  const { coord, sim } = mk({ gameAutoJoin: true, hpwd: 'anchor-hpwd', pwd: '482913' });
  const group = groupFor(coord);
  const c = await group.findTable('B1', { stake: 100 });
  assert.equal(c.roomKey, '482913', 'the password comes from ri.pwd — never generated here');
  const j = await group.joinTable('B2', c.rid);
  assert.equal(j.ok, true, JSON.stringify(j));
  await group.rejoin('B3');
  for (const id of ['B2', 'B3']) for (const f of joins(sim, id)) { assert.equal(f[3], c.roomKey); assert.notEqual(f[3], 'anchor-hpwd'); }
  assert.equal(coord.roomKeyFor(1234567), '', 'a table that is not the group table gets the empty code');
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

// §group — the standard flow: the finder = KEY, next = READY, last = NOT_READY; a kicked member rejoins.
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
  const sim = withGroupFlow(new QuickPlaySim({ gameAutoJoin: true }));
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, delay: () => Promise.resolve(), createAutoJoinMs: 40, kickRejoinMs: 0,
    findBudgetMs: 120, rerollCooldownMs: 0, joinRejectGraceMs: 10, leaveConfirmMs: 40,
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
  assert.equal(sim.readyFrames.includes('B2'), false, 'the KEY never sends cmd 5 (for a host that would be BẮT ĐẦU)');
});

test('A3 (live sim): with TỰ ĐỘNG on, a member the server removes rejoins the SAME số bàn and keeps its role', async () => {
  const { sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  const joinsBefore = joins(sim, 'B3').length;
  sim.kick('B3', 'Bạn thoát vì không sẵn sàng');
  await tick();
  const js = joins(sim, 'B3');
  assert.equal(js.length, joinsBefore + 1);
  assert.deepEqual(js.at(-1), [3, 'Simms', r.rid, '']);
  assert.ok(sim.rooms.get(r.rid).seats.includes(sim.uids.B3));
  assert.equal(sim.pref.B3, false, 'still NOT_READY after the rejoin');
});

test('A4 (live sim): the table is gone when a kicked member rejoins → the group re-forms at another table', async () => {
  const { sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  sim.kick('B1', 'x'); sim.kick('B3', 'x'); sim.kick('B2', 'x');
  sim.rooms.delete(r.rid);
  for (let i = 0; i < 20 && !(group.snapshot() && group.snapshot().rid !== r.rid); i++) await tick();
  const g = group.snapshot();
  assert.ok(g && g.rid !== r.rid, 'another table');
  await tick();
  assert.deepEqual([...sim.rooms.get(g.rid).seats].sort(), ['1_1', '1_2', '1_3']);
});

test('A5 (live sim): BÀN KHÁC leaves this table, asks for a different one, and re-forms the group there', async () => {
  const { sim, group } = mkGroup();
  const a = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  // A second public table exists at this stake, so "another table" is really another one.
  sim.rooms.set(3800000, { rid: 3800000, b: 100, Mu: 4, key: '', seats: [] });
  const b = await group.newTable();
  assert.equal(b.ok, true, JSON.stringify(b.error || b));
  assert.notEqual(b.rid, a.rid, 'the table it was told to leave is not handed back');
  assert.deepEqual([...sim.rooms.get(b.rid).seats].sort(), ['1_1', '1_2', '1_3'], 'the whole group moved');
  assert.deepEqual(sim.rooms.get(a.rid).seats, [], 'and nobody is left behind');
  assert.equal(group.snapshot().members.find((m) => m.role === 'KEY').id, 'B2', 'the finder stays KEY');
  await group.leaveAll();
  assert.equal(group.active(), false);
});

test('A5b (live sim): when the server has no other table, BÀN KHÁC keeps this one instead of looping forever', async () => {
  const { sim, group } = mkGroup();
  const a = await group.setAuto(true, { creatorId: 'B2', stake: 100 });
  const asksBefore = sim.asks;
  const b = await group.newTable();
  assert.equal(b.ok, true, JSON.stringify(b.error || b));
  assert.equal(b.rid, a.rid, 'the only public table at this stake');
  assert.ok(sim.asks - asksBefore >= 2 && sim.asks - asksBefore <= 5, 'it asked again a few times, then settled');
  assert.deepEqual([...sim.rooms.get(b.rid).seats].sort(), ['1_1', '1_2', '1_3']);
});

// Manual flow (header): TÌM BÀN on one browser only; the others press VÀO — first joiner READY, the next NOT_READY.
test('T1+T2 (live sim): TÌM BÀN acts on THIS browser only (KEY); VÀO order decides READY then NOT_READY', async () => {
  const { sim, group } = mkGroup();
  const c = await group.findTable('B3', { stake: 100 });
  assert.equal(c.ok, true, JSON.stringify(c.error || c));
  assert.equal(c.role, 'KEY');
  assert.equal(joins(sim, 'B1').length + joins(sim, 'B2').length, 0, 'nobody else is pulled in');
  const first = await group.joinTable('B1', c.rid);
  assert.equal(first.ok, true, JSON.stringify(first.error || first));
  assert.equal(first.role, 'READY');
  assert.deepEqual(joins(sim, 'B1').at(-1), [3, 'Simms', c.rid, ''], 'VÀO uses the số bàn the server named');
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
  const c = await group.findTable('B3', { stake: 100 });
  await group.joinTable('B1', c.rid);
  const before = joins(sim, 'B1').length;
  sim.kick('B1', 'Bạn thoát vì không sẵn sàng');
  await tick();
  assert.equal(joins(sim, 'B1').length, before, 'no automatic rejoin');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1').manualState, 'KICKED');
  const back = await group.rejoin('B1');
  assert.equal(back.ok, true, JSON.stringify(back.error || back));
  assert.deepEqual(joins(sim, 'B1').at(-1), [3, 'Simms', c.rid, '']);
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
