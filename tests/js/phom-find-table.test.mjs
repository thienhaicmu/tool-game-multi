// §dò-key — the group's table, found the way the reference tool finds it.
//
// Protocol source: the reference tool's three browsers captured live and merged by time (2026-10-02 22:24 / 22:27 /
// 22:28, v.hitclub.guitars, Web Traffic Recorder):
//   DÒ KEY  [3,"Simms",145,"",true]          quick-play into the 20K channel → 202 ps[]; strangers → [4,"Simms",-1]
//                                             and again, until the account sits ALONE (C:true)
//   TẠO     [6,"Simms","channelPlugin",{cmd:313,gid:8,aid:1,b:20000}] → [5,{ri:{rid,uC,Mu,rn,hpwd},cmd:313}]
//           [3,"Simms",<rid>,"​"]       → [3,false,103,<rid>,"Sai mật khẩu phòng"]  (never seats anyone)
//           uC 1 → [8,"Simms",<rid>,"",8]   → [3,true,0,-1,null] + 202 with the KEY in ps[]
//   VÀO / ReJoin  [8,"Simms",<số bàn>,"",8]
//   kicked  [4,true,2,-1,2,"Bạn bị kick vì không sẵn sàng"] every ~10s for the NOT_READY account → op 8 again
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { buildQuickPlayFrame, buildJoinTableFrame, buildChannelQuickJoinFrame, buildProbeJoinFrame } = require('../../desktop/protocol/phom/phom-wire.cjs');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');
const { createTableGroup } = require('../../desktop/protocol/phom/table-group.cjs');
const { readFileSync } = require('node:fs');
const readMain = () => readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
// The group flow (docs/phom-kich-ban.md) runs unpaced here; its pacing/queueing rules are phom-table-group.test.mjs.
const groupFor = (coord) => createTableGroup({ coord, paceMinMs: 0, paceMaxMs: 0, sleep: () => Promise.resolve() });
const ZWSP = '​';
const CHANNELS = [{ rid: 139, b: 100 }, { rid: 145, b: 20000 }];

// Server sim. Rooms are public tables; seats[0] is the host. `strangersFirst` = how many channel quick-plays land at
// a table that already has strangers. `scan` = what each 313 names, in order: 'full' (3 strangers), 'channel' (the
// stake channel itself), 'lone' (one stranger), 'key' (the table the KEY sits at alone) — 'key' once the list ends,
// unless `keyNever`. `gameAutoJoin` = the game client answers every 313 with its own plain op-3 JOIN, which (worst
// case) seats the account there.
class Sim {
  constructor({ strangersFirst = 0, scan = ['full', 'channel', 'lone'], keyNever = false, gameAutoJoin = false, armedGame = false } = {}) {
    this.strangersFirst = strangersFirst; this.scan = scan.slice(); this.keyNever = keyNever; this.gameAutoJoin = gameAutoJoin; this.armedGame = armedGame;
    this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' };
    this.rooms = new Map(); this.nextRid = 7900000; this.special = {};
    this.sent = { B1: [], B2: [], B3: [] }; this.coord = null; this.asks = 0;
  }
  attach(c) { this.coord = c; }
  feed(id, raw, direction = 'recv') { this.coord.ingest(id, { raw, direction, targetId: id, url: 'wss://sim', now: Date.now() }); }
  ours(uid) { return Object.values(this.uids).includes(uid); }
  room(b, strangers) { const rid = this.nextRid++; const r = { rid, b, Mu: 4, seats: [] }; for (let i = 0; i < strangers; i++) r.seats.push(`s_${rid}_${i}`); this.rooms.set(rid, r); return r; }
  table(room) { return JSON.stringify([5, { b: room.b, hpwd: false, ps: room.seats.map((uid, sit) => ({ uid, sit, r: false, C: sit === 0 })), cmd: 202 }]); }
  broadcast(room) { for (const [bid, uid] of Object.entries(this.uids)) if (room.seats.includes(uid)) this.feed(bid, this.table(room)); }
  seat(id, room) { room.seats.push(this.uids[id]); this.feed(id, '[3,true,0,-1,null]'); this.broadcast(room); }
  unseat(id) { for (const room of this.rooms.values()) { if (room.seats.includes(this.uids[id])) { room.seats = room.seats.filter((u) => u !== this.uids[id]); this.broadcast(room); } } }
  keyRoom() { return [...this.rooms.values()].find((r) => r.seats.length === 1 && this.ours(r.seats[0])) || null; }
  kick(id, msg = 'Bạn bị kick vì không sẵn sàng') { this.unseat(id); this.feed(id, JSON.stringify([4, true, 2, -1, 2, msg])); }
  named(b) {
    const kind = this.scan.length ? this.scan.shift() : (this.keyNever ? 'full' : 'key');
    if (kind === 'channel') return { rid: CHANNELS.find((c) => c.b === b).rid, rn: 'Phom#6', uC: 3 };
    if (kind === 'key') { const r = this.keyRoom(); return r ? { rid: r.rid, rn: 'Phom', uC: r.seats.length } : null; }
    const r = this.special[kind] || (this.special[kind] = this.room(b, kind === 'full' ? 3 : 1));
    return { rid: r.rid, rn: 'Phom', uC: r.seats.length };
  }
  sendFor(id) {
    return async (frame) => {
      const j = JSON.parse(frame); this.sent[id].push(j);
      if (j[0] === 6 && j[3] && j[3].cmd === 313) {
        this.asks++;
        const n = this.named(Number(j[3].b));
        if (!n) { this.feed(id, JSON.stringify([5, { mgs: 'Không tìm thấy phòng thích hợp!', cmd: 313 }])); return { ok: true }; }
        this.feed(id, JSON.stringify([5, { ri: { rid: n.rid, rn: n.rn, b: Number(j[3].b), sid: 1, Mu: 4, uC: n.uC, hpwd: false, gid: 8 }, cmd: 313 }]));
        const room = this.rooms.get(n.rid);
        // the game's own join answering the 313, armed to the invisible password by the tool → refused 103
        if (this.armedGame && room) this.feed(id, JSON.stringify([3, false, 103, n.rid, 'Sai mật khẩu phòng']));
        if (this.gameAutoJoin && room) { this.feed(id, JSON.stringify([3, 'Simms', n.rid, '']), 'send'); if (room.seats.length < 4) this.seat(id, room); }
        return { ok: true };
      }
      if (j[0] === 3 && j[4] === true) { // DÒ KEY quick-play into a stake channel
        const b = CHANNELS.find((c) => c.rid === j[2]).b;
        const room = this.strangersFirst > 0 ? (this.strangersFirst--, this.room(b, 2)) : this.room(b, 0);
        this.seat(id, room); return { ok: true };
      }
      if (j[0] === 3 && j[3] === ZWSP) { this.feed(id, JSON.stringify([3, false, 103, j[2], 'Sai mật khẩu phòng'])); return { ok: true }; }
      if (j[0] === 8) {
        const room = this.rooms.get(j[2]);
        if (!room) { this.feed(id, JSON.stringify([3, false, 102, j[2], 'Phòng không tồn tại'])); return { ok: true }; }
        if (room.seats.length >= room.Mu) { this.feed(id, JSON.stringify([3, false, 100, -1, 'Phòng đầy'])); return { ok: true }; }
        this.seat(id, room); return { ok: true };
      }
      if (j[0] === 4) { this.unseat(id); this.feed(id, '[4,true,1,-1,0,""]'); return { ok: true }; }
      return { ok: true };
    };
  }
}
function mk(simOpts) {
  const sim = new Sim(simOpts);
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, delay: () => Promise.resolve(),
    findBudgetMs: 300, rerollCooldownMs: 0, joinRejectGraceMs: 10, leaveConfirmMs: 40, probeAckMs: 40,
    profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })),
  });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) {
    sim.feed(id, `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`);
    sim.feed(id, JSON.stringify([5, { rs: CHANNELS.map((c, i) => ({ rid: c.rid, b: c.b, uC: 20, Mu: 4, zn: 'Simms', gid: 8, rn: 'Phom#' + i })), cmd: 300 }]));
    coord.setIdentity(id, { aid: '1' });
  }
  return { coord, sim };
}
// The group flow on top of the sim, plus the account AUTO-READY preference (CMD 363): a client whose preference is on
// readies by itself when it sits down (live 2026-09-21T12-06), so NOT_READY must switch it off first.
function mkGroup(simOpts) {
  const { coord, sim } = mk(simOpts);
  sim.pref = {}; sim.readyFrames = []; sim.order = [];
  const baseSeat = sim.seat.bind(sim);
  sim.seat = (id, room) => { baseSeat(id, room); sim.order.push(['seat', id, room.rid]); if (sim.pref[id] && room.seats.indexOf(sim.uids[id]) > 0) sim.readyBroadcast(room, sim.uids[id]); };
  sim.readyBroadcast = (room, uid) => { for (const [bid, u] of Object.entries(sim.uids)) if (room.seats.includes(u)) sim.feed(bid, JSON.stringify([5, { uid, cmd: 5 }])); };
  const baseSend = sim.sendFor.bind(sim);
  for (const id of ['B1', 'B2', 'B3']) {
    const inner = baseSend(id);
    coord._rec(id).send = async (frame) => {
      const j = JSON.parse(frame);
      if (j[0] === 6 && j[3] && j[3].cmd === 363) { sim.sent[id].push(j); sim.pref[id] = j[3].aRd === 'true'; sim.order.push(['pref', id, j[3].aRd]); return { ok: true }; }
      if (j[0] === 5 && j[3] && j[3].cmd === 5) { sim.sent[id].push(j); sim.readyFrames.push(id); const room = j[2] === -1 ? [...sim.rooms.values()].find((r) => r.seats.includes(sim.uids[id])) : sim.rooms.get(j[2]); if (room) sim.readyBroadcast(room, sim.uids[id]); return { ok: true }; }
      return inner(frame);
    };
  }
  return { coord, sim, group: groupFor(coord) };
}
const op = (sim, id, n) => sim.sent[id].filter((f) => f[0] === n);
const asks = (sim, id) => sim.sent[id].filter((f) => f[0] === 6 && f[3] && f[3].cmd === 313);
const tick = () => new Promise((r) => setTimeout(r, 30));
const until = async (pred) => { for (let i = 0; i < 60 && !pred(); i++) await tick(); };

test('WIRE: the frames are exactly the reference tool\'s live frames', () => {
  assert.deepEqual(JSON.parse(buildJoinTableFrame(7907972)), [8, 'Simms', 7907972, '', 8]);
  assert.deepEqual(JSON.parse(buildChannelQuickJoinFrame(145)), [3, 'Simms', 145, '', true]);
  assert.deepEqual(JSON.parse(buildProbeJoinFrame(7907065)), [3, 'Simms', 7907065, '​']);
  assert.equal(buildProbeJoinFrame(7907065), '[3,"Simms",7907065,"​"]');
  assert.deepEqual(JSON.parse(buildQuickPlayFrame({ stake: 20000 })), [6, 'Simms', 'channelPlugin', { cmd: 313, gid: 8, aid: 1, b: 20000 }]);
  // verbatim from the capture
  const j8 = classifyPhomFrame('[8,"Simms",7907180,"",8]');
  assert.equal(j8.type, 'JOIN_REQUEST'); assert.equal(j8.channel, 7907180); assert.equal(j8.byTableId, true);
  const qp = classifyPhomFrame('[3,"Simms",145,"",true]');
  assert.equal(qp.type, 'JOIN_REQUEST'); assert.equal(qp.quickPlay, true);
  const refused = classifyPhomFrame('[3,false,103,7907065,"Sai mật khẩu phòng"]');
  assert.equal(refused.accepted, false); assert.equal(refused.resultCode, 103);
  const kick = classifyPhomFrame('[4,true,2,-1,2,"Bạn bị kick vì không sẵn sàng"]');
  assert.equal(kick.type, 'LEAVE_ACK'); assert.equal(kick.resultCode, 2); assert.equal(kick.resultMessage, 'Bạn bị kick vì không sẵn sàng');
  const named = classifyPhomFrame('[5,{"ri":{"mM":200000,"b":20000,"gid":8,"MMBI":0,"hpwd":false,"aG":"G","Mu":4,"ahp":false,"rid":7907972,"uC":1,"sid":1,"zn":"Simms","mMBI":0,"rn":"Phom","aid":1,"inc":false},"cmd":313}]');
  assert.equal(named.type, 'ROOM_ASSIGNED'); assert.equal(named.rid, 7907972); assert.equal(named.seated, 1); assert.equal(named.isTable, true);
  assert.equal(classifyPhomFrame('[5,{"ri":{"b":20000,"hpwd":false,"Mu":4,"rid":145,"uC":3,"rn":"Phom#6"},"cmd":313}]').isTable, false);
});

test('SEAT: a t:2 seat push drops that player from the table (live: the kicked NOT_READY account)', () => {
  const ctx = new PhomContext({ profileId: 'A', uid: '1_365473596' });
  const meta = { direction: 'recv', targetId: 'A', url: 'wss://sim' };
  ctx.observe({ ...meta, raw: '[5,{"b":20000,"ps":[{"uid":"1_365473596","sit":0,"C":true},{"uid":"1_642487221","sit":1}],"cmd":202}]' });
  ctx.observe({ ...meta, raw: '[5,{"p":{"uid":"1_321513416","a":"Avatar0","r":false,"dn":"thekiet2k4","id":0,"m":431503,"sit":2},"t":1,"cmd":200}]' });
  assert.equal(ctx.tableState().playerCount, 3);
  ctx.observe({ ...meta, raw: '[5,{"p":{"uid":"1_321513416","mT":false,"dn":"thekiet2k4","id":0},"t":2,"cmd":200}]' });
  assert.deepEqual(ctx.tableState().uids, ['1_365473596', '1_642487221']);
  ctx.observe({ ...meta, raw: '[5,{"p":{"uid":"1_365473596","id":0},"t":2,"cmd":200}]' }); // our own row never goes this way
  assert.ok(ctx.tableState().uids.includes('1_365473596'));
});

test('DÒ KEY: quick-plays into the stake channel, leaves strangers\' tables, stops when it sits ALONE', async () => {
  const { coord, sim } = mk({ strangersFirst: 2 });
  const r = await coord.findKeyTable('B1', { stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.channel, 145); assert.equal(r.attempts, 3);
  assert.deepEqual(op(sim, 'B1', 3), [[3, 'Simms', 145, '', true], [3, 'Simms', 145, '', true], [3, 'Simms', 145, '', true]]);
  assert.equal(op(sim, 'B1', 4).length, 2, 'left the two tables that had strangers');
  assert.equal(asks(sim, 'B1').length, 0, 'the KEY never asks 313');
  const room = sim.keyRoom();
  assert.deepEqual(room.seats, ['1_1'], 'alone = host of an empty table');
  const b1 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1');
  assert.equal(b1.manualState, 'JOINED'); assert.equal(b1.joinedViaChannel, true, 'no số bàn yet — shown as the channel');
});

test('DÒ KEY: no stake / no channel for the stake → typed error, nothing sent', async () => {
  const { coord, sim } = mk();
  assert.equal((await coord.findKeyTable('B1', {})).error.code, 'PHOM_INVALID_STAKE');
  assert.equal((await coord.findKeyTable('B1', { stake: 777 })).error.code, 'PHOM_NO_STAKE_CHANNEL');
  assert.equal(sim.sent.B1.length, 0);
});

test('TẠO: probes every named table with U+200B, sits only where ONE player is, keeps it only if that is the KEY', async () => {
  const { coord, sim } = mk({ scan: ['full', 'channel', 'lone'] });
  await coord.findKeyTable('B1', { stake: 20000 });
  const keyRid = sim.keyRoom().rid;
  const r = await coord.scanForKeyTable('B2', { stake: 20000, keyUid: '1_1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rid, keyRid, 'the số bàn is the KEY\'s table');
  assert.equal(asks(sim, 'B2').length, 4);
  // probes: one per named TABLE (the channel answer is not a table), each with the invisible password
  const probes = op(sim, 'B2', 3);
  assert.equal(probes.length, 3);
  for (const p of probes) assert.equal(p[3], ZWSP);
  // real joins: the lone stranger (left again) and the KEY's table
  assert.deepEqual(op(sim, 'B2', 8).map((f) => f[2]), [sim.special.lone.rid, keyRid]);
  for (const f of op(sim, 'B2', 8)) assert.deepEqual(f.slice(3), ['', 8]);
  assert.equal(op(sim, 'B2', 4).length, 1, 'left the stranger\'s table');
  assert.equal(sim.special.full.seats.includes('1_2'), false, 'never sat at the full table');
  assert.deepEqual(sim.rooms.get(keyRid).seats, ['1_1', '1_2']);
});

test('TẠO: the game client seating the account itself at a stranger\'s table is undone, and the search goes on', async () => {
  const { coord, sim } = mk({ scan: ['full'], gameAutoJoin: true });
  await coord.findKeyTable('B1', { stake: 20000 });
  const r = await coord.scanForKeyTable('B2', { stake: 20000, keyUid: '1_1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const keyTable = [...sim.rooms.values()].find((x) => x.seats[0] === '1_1');
  assert.equal(r.rid, keyTable.rid);
  assert.deepEqual(keyTable.seats, ['1_1', '1_2']);
  assert.equal(sim.special.full.seats.includes('1_2'), false, 'it did not stay at the strangers\' table');
  assert.ok(op(sim, 'B2', 4).length >= 1);
});

test('TẠO: no KEY table for the whole budget → one typed error; no KEY at all → refused at once', async () => {
  const { coord, sim } = mk({ keyNever: true, scan: [] });
  await coord.findKeyTable('B1', { stake: 20000 });
  const r = await coord.scanForKeyTable('B2', { stake: 20000, keyUid: '1_1', budgetMs: 80 });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'PHOM_NO_KEY_TABLE');
  assert.match(r.error.message, /cược 20000/);
  assert.ok(asks(sim, 'B2').length >= 2);
  assert.equal(op(sim, 'B2', 8).length, 0, 'full tables are never joined');
  const none = await coord.scanForKeyTable('B3', { stake: 20000 });
  assert.equal(none.error.code, 'PHOM_NO_KEY');
});

test('DỪNG: cancelSearch stops a running TẠO at its next step', async () => {
  const { coord, sim } = mk({ keyNever: true, scan: [] });
  coord._findBudgetMs = 60000;
  await coord.findKeyTable('B1', { stake: 20000 });
  const p = coord.scanForKeyTable('B2', { stake: 20000, keyUid: '1_1' });
  await until(() => asks(sim, 'B2').length >= 2);
  coord.cancelSearch('B2');
  const r = await p;
  assert.equal(r.cancelled, true);
  const b2 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B2');
  assert.notEqual(b2.manualState, 'SEARCHING'); assert.equal(b2.searchKind, null);
});

// ---- the group (docs/phom-kich-ban.md) on the sim ----

test('SCENARIO (manual, sim): Dò Key → KEY; Tạo finds the số bàn (1st = SẴN SÀNG); Vào joins it (2nd = CHƯA SS) with op 8; ready once both sit', async () => {
  const { coord, sim, group } = mkGroup({ scan: ['lone'] });
  group.setStake(20000);
  const k = await group.findTable('B3', {});             // the bar sends no stake: the tool's Tiền is used
  assert.equal(k.ok, true, JSON.stringify(k.error || k)); assert.equal(k.role, 'KEY');
  assert.equal(op(sim, 'B3', 3)[0][2], 145, 'the channel of the stake chosen in the tool (20000)');
  assert.equal(group.rid(), null, 'no số bàn yet');
  const s = await group.scanTable('B1');
  assert.equal(s.ok, true, JSON.stringify(s.error || s)); assert.equal(s.role, 'READY');
  assert.deepEqual(sim.readyFrames, [], 'not ready while alone with the KEY');
  const rid = [...sim.rooms.values()].find((r) => r.seats[0] === '1_3').rid;
  assert.equal(group.rid(), rid, 'the KEY\'s table is the group\'s số bàn');
  assert.equal(sim.special.lone.seats.includes('1_1'), false, 'the lone stranger\'s table was left');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B3').rid, rid, 'the KEY now shows the số bàn');
  const v = await group.joinTable('B2', rid);
  assert.equal(v.ok, true, JSON.stringify(v.error || v)); assert.equal(v.role, 'NOT_READY');
  assert.deepEqual(op(sim, 'B2', 8).at(-1), [8, 'Simms', rid, '', 8]);
  assert.deepEqual([...sim.rooms.get(rid).seats].sort(), ['1_1', '1_2', '1_3']);
  for (const id of ['B1', 'B2']) {
    const prefAt = sim.order.findIndex((e) => e[0] === 'pref' && e[1] === id);
    const seatAt = sim.order.findIndex((e) => e[0] === 'seat' && e[1] === id && e[2] === rid);
    assert.ok(prefAt >= 0 && prefAt < seatAt, `${id}: auto-ready preference set before it sits down`);
  }
  assert.deepEqual(sim.readyFrames, ['B1'], 'only SẴN SÀNG readies — once CHƯA SS sits; the KEY never sends cmd 5');
  assert.deepEqual(op(sim, 'B1', 5).at(-1), [5, 'Simms', -1, { cmd: 5 }]);
  assert.equal(sim.pref.B1, false); assert.equal(sim.pref.B2, false, 'auto-ready always off, like the reference tool');
});

test('A1 (auto): TỰ ĐỘNG forms KEY / SẴN SÀNG / CHƯA SS at ONE table, one browser after another', async () => {
  const { sim, group } = mkGroup({ strangersFirst: 1, scan: ['full', 'lone'] });
  const r = await group.setAuto(true, { creatorId: 'B2', stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.deepEqual(r.roles, { B2: 'KEY', B1: 'READY', B3: 'NOT_READY' });
  assert.deepEqual([...sim.rooms.get(r.rid).seats].sort(), ['1_1', '1_2', '1_3']);
  assert.equal(asks(sim, 'B3').length, 0, 'the third account joins the known số bàn — no search');
  assert.equal(sim.pref.B2, false); assert.equal(sim.pref.B1, false); assert.equal(sim.pref.B3, false);
  assert.deepEqual(sim.readyFrames, ['B1']);
});

test('A3 (auto): the NOT_READY account is kicked again and again — it comes back EVERY time (no per-minute cap)', async () => {
  const { sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B1', stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  for (let i = 0; i < 7; i++) {
    sim.kick('B3');
    await until(() => sim.rooms.get(r.rid).seats.includes('1_3'));
    assert.ok(sim.rooms.get(r.rid).seats.includes('1_3'), `kick ${i + 1}: back at the table`);
  }
  assert.ok(op(sim, 'B3', 8).filter((f) => f[2] === r.rid).length >= 7);
  assert.equal(sim.pref.B3, false, 'still CHƯA SS');
});

test('T6 + ReJoin toggle (manual): a kick is only reported, until ReJoin is switched on; pressing it again switches off', async () => {
  const { coord, sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B1', stake: 20000 });
  await group.setAuto(false);
  sim.kick('B2'); await tick(); await tick();
  assert.equal(sim.rooms.get(r.rid).seats.includes('1_2'), false, 'manual: SẴN SÀNG is not rejoined');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B2').manualState, 'KICKED');
  const on = await group.rejoin('B2');
  assert.equal(on.ok, true, JSON.stringify(on.error || on)); assert.equal(on.rejoinOn, true);
  sim.kick('B2');
  await until(() => sim.rooms.get(r.rid).seats.includes('1_2'));
  assert.ok(sim.rooms.get(r.rid).seats.includes('1_2'), 'ReJoin on: back by itself');
  const off = await group.rejoin('B2');
  assert.equal(off.rejoinOn, false);
  sim.kick('B2'); await tick(); await tick();
  assert.equal(sim.rooms.get(r.rid).seats.includes('1_2'), false, 'ReJoin off again');
});

test('A4 (auto): the table is gone when a kicked member comes back → the group is formed again at a new table', async () => {
  const { sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B1', stake: 20000 });
  for (const id of ['B1', 'B2', 'B3']) sim.unseat(id);
  sim.rooms.delete(r.rid);
  sim.feed('B3', JSON.stringify([4, true, 2, -1, 2, 'x']));
  await until(() => group.rid() != null && group.rid() !== r.rid && group.snapshot().members.every((m) => m.seated));
  const g = group.snapshot();
  assert.notEqual(g.rid, r.rid);
  assert.deepEqual([...sim.rooms.get(g.rid).seats].sort(), ['1_1', '1_2', '1_3']);
});

test('A5 (auto): BÀN KHÁC — the KEY runs Dò Key again and the whole group moves', async () => {
  const { sim, group } = mkGroup();
  const a = await group.setAuto(true, { creatorId: 'B2', stake: 20000 });
  const b = await group.newTable();
  assert.equal(b.ok, true, JSON.stringify(b.error || b));
  assert.notEqual(b.rid, a.rid);
  assert.deepEqual([...sim.rooms.get(b.rid).seats].sort(), ['1_1', '1_2', '1_3']);
  assert.deepEqual(sim.rooms.get(a.rid).seats, [], 'nobody left behind');
  assert.equal(group.snapshot().members.find((m) => m.role === 'KEY').id, 'B2');
  await group.leaveAll();
  assert.equal(group.active(), false);
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

test('LAG: another game\'s broadcasts on the shared socket cost nothing — no update, no log, no hands emit', () => {
  const { coord } = mk();
  let updates = 0, logs = 0, hands = 0;
  coord.on('update', () => updates++); coord.on('log', () => logs++); coord.on('hands', () => hands++);
  const meta = { direction: 'recv', targetId: 'B1', url: 'wss://sim', now: 1 };
  // verbatim from the capture (≈15 of these per second per browser)
  for (const raw of [
    '[5,{"errC":10005,"gid":10112,"cmd":10004}]',
    '[5,{"bs":{"b":[{"eid":1,"bc":35,"v":8473537}]},"gid":10110,"rmT":38999,"cmd":10003}]',
    '[5,{"d":{"cmd":2005,"sid":2635153,"md5":"1e93"},"cmd":1015}]',
    '[5,{"Js":[{"b":100000,"gid":206,"gn":"Trên Dưới","J":2694683,"aid":1}],"cmd":10000}]',
    '[5,{"mgs":"Trên Dưới %c nổ hũ %y","cmd":10,"params":["x","350.478"]}]',
  ]) coord.ingest('B1', { ...meta, raw });
  assert.deepEqual({ updates, logs, hands }, { updates: 0, logs: 0, hands: 0 });
  // a Phỏm frame still goes all the way through
  coord.ingest('B1', { ...meta, raw: '[5,{"b":20000,"ps":[{"uid":"1_1","sit":0,"C":true}],"cmd":202}]' });
  assert.ok(updates > 0 && hands > 0);
});

test('AUTO-ENTER: the login identity push (cmd 100) marks the browser logged in; a page reset clears it', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  const meta = { direction: 'recv', targetId: 'A', url: 'wss://sim' };
  assert.equal(ctx.loggedIn(), false);
  ctx.observe({ ...meta, raw: '[5,{"errC":10005,"gid":10112,"cmd":10004}]' });
  assert.equal(ctx.loggedIn(), false, 'lobby broadcasts are not a login');
  ctx.observe({ ...meta, raw: '[5,{"uid":"1_365473596","As":{"gold":453384},"dn":"gdufuud","cmd":100,"id":0}]' });
  assert.equal(ctx.loggedIn(), true);
  ctx.reset();
  assert.equal(ctx.loggedIn(), false, 'a reloaded page must log in again');
  const { coord, sim } = mk();
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1').loggedIn, true, 'surfaced to main');
  assert.ok(sim);
});

test('AUTO-ENTER (main): fires VÀO GAME once a browser is logged in and not in Phỏm, once per page, bounded', () => {
  const main = readMain();
  const fn = main.slice(main.indexOf('function maybeAutoEnter('), main.indexOf('// Per-browser RUNTIME status'));
  assert.match(fn, /if \(!b \|\| !b\.loggedIn \|\| !view\.opened \|\| view\.dataStale\) return;/);
  assert.match(fn, /if \(view\.inGame\) \{ if \(!st\.done\)/, 'reaching Phỏm ends it');
  assert.match(fn, /st\.tries >= AUTO_ENTER_MAX_TRIES/, 'bounded');
  assert.match(fn, /startEnterGame\(rid, \{ source: 'auto'/, 'the same path as the VÀO GAME button');
  assert.match(main, /resetAutoEnter\(rid\); \/\/ a new page = a new login/);
  assert.match(main, /maybeAutoEnter\(rid, view, browsers\.find/);
});

test('AUTO = MANUAL: TỰ ĐỘNG presses Dò Key → Tạo → Vào and switches ReJoin on for the seated members; unticking switches those off', async () => {
  const { coord, sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B1', stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // the same wire as by hand: B1 quick-plays the channel, B2 asks 313 + probes, B3 joins the số bàn with op 8
  assert.ok(op(sim, 'B1', 3).every((f) => f[4] === true));
  assert.ok(asks(sim, 'B2').length >= 1);
  assert.equal(asks(sim, 'B3').length, 0); assert.deepEqual(op(sim, 'B3', 8).at(-1), [8, 'Simms', r.rid, '', 8]);
  const on = Object.fromEntries(coord.manualBrowserSnapshot().map((b) => [b.profileId, group.rejoinOn(b.profileId)]));
  assert.deepEqual(on, { B1: false, B2: true, B3: true }, 'like pressing ReJoin on SẴN SÀNG and CHƯA SS');
  await group.setAuto(false);
  // ReJoin = its button OR the TỰ ĐỘNG checkbox (user rule 2026-10-03): unticked, every ReJoin TỰ ĐỘNG switched on goes off
  assert.equal(group.rejoinOn('B3'), false, 'CHƯA SS too — the user did not press its ReJoin');
  assert.equal(group.rejoinOn('B2'), false, 'the ReJoin TỰ ĐỘNG switched on goes off');
  // …but a ReJoin the USER switched on stays on
  await group.rejoin('B2'); // seated + was off → it is a "switch on + join"
  sim.kick('B2'); await until(() => sim.rooms.get(r.rid).seats.includes('1_2'));
  assert.ok(sim.rooms.get(r.rid).seats.includes('1_2'));
});

test('ACCOUNT: the login identity gives the account name + ID before it sits anywhere; the bar shows both', () => {
  const ctx = new PhomContext({ profileId: 'A' });
  ctx.observe({ direction: 'recv', targetId: 'A', url: 'wss://sim', raw: '[5,{"uid":"1_365473596","As":{"gold":453384},"dn":"gdufuud","cmd":100,"id":0}]' });
  assert.equal(ctx.displayName(), 'gdufuud');
  const { coord, sim } = mk();
  sim.feed('B1', '[5,{"uid":"1_1","As":{"gold":1},"dn":"gdufuud","cmd":100,"id":0}]');
  const b1 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1');
  assert.equal(b1.username, 'gdufuud', 'named from login, not only once seated');
  assert.equal(b1.accountId, '1');
  const gh = require('../../desktop/protocol/phom/game-header.cjs');
  const st = gh.deriveHeaderState({ opened: true, inGame: true, account: 'gdufuud', accountId: '365473596' });
  assert.equal(st.account, 'gdufuud'); assert.equal(st.accountId, '365473596');
  assert.match(gh.bootScript(), /var acc = hasAcc \? state\.account \+ \(state\.money != null \? '-' \+ state\.money : ''\) : '';/, 'name-money, like the reference tool');
  // on the strip: name · ID (money is in the yellow line and the tooltip)
  assert.match(gh.bootScript(), /nameEl\.textContent = hasAcc \? state\.account \+ \(state\.accountId \? ' · ID ' \+ state\.accountId : ''\) : '';/);
  assert.match(gh.bootScript(), /nameEl\.title = hasAcc \? acc \+/);
});

test('MONEY: the account money comes from the wallet push (cmd 317: gold + held) and, at a table, from its seat', () => {
  const ctx = new PhomContext({ profileId: 'A', uid: '1_365473596' });
  const meta = { direction: 'recv', targetId: 'A', url: 'wss://sim' };
  ctx.observe({ ...meta, raw: '[5,{"uid":"1_365473596","As":{"gold":453384},"dn":"gdufuud","cmd":100,"id":0}]' });
  assert.equal(ctx.money(), 453384);
  // verbatim from the capture: sitting down moves the money to guaranteed_gold — the total stays the same
  ctx.observe({ ...meta, raw: '[5,{"As":{"gold":0,"guaranteed_gold":453384,"time":1790954750990},"cmd":317}]' });
  assert.equal(ctx.money(), 453384);
  ctx.observe({ ...meta, raw: '[5,{"As":{"gold":428503,"guaranteed_gold":3000,"time":1790954970761},"cmd":317}]' });
  assert.equal(ctx.money(), 431503);
  assert.equal(classifyPhomFrame('[5,{"As":{"gold":0,"guaranteed_gold":1},"cmd":317}]').type, 'WALLET');
  const { coord, sim } = mk();
  sim.feed('B1', '[5,{"As":{"gold":1000,"guaranteed_gold":0},"cmd":317}]');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1').money, 1000);
});

test('READY: SẴN SÀNG is sent to the CURRENT room, exactly the reference tool frame [5,"Simms",-1,{cmd:5}]', () => {
  const { buildTableReadyFrame } = require('../../desktop/protocol/phom/phom-wire.cjs');
  assert.deepEqual(JSON.parse(buildTableReadyFrame()), [5, 'Simms', -1, { cmd: 5 }]);
});

test('PLAYERS: each browser lists who sits at its table — name, money, host, ready, and whether it is one of ours', async () => {
  const { coord, sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B1', stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  sim.rooms.get(r.rid).seats.push('stranger_x'); sim.broadcast(sim.rooms.get(r.rid));
  const b3 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B3');
  assert.equal(b3.players.length, 4);
  assert.deepEqual(b3.players.map((p) => p.ours), [true, true, true, false], 'our three + the stranger');
  assert.equal(b3.players[0].host, true, 'the KEY is the host');
  assert.equal(b3.players.filter((p) => p.self).length, 1);
});

test('BELL (sim): a stranger sits in seat 4 and presses ready → ONE FOURTH_READY (the tool window rings 3 times)', async () => {
  const { sim, group } = mkGroup();
  const bells = []; group.on('notice', (n) => { if (n.event === 'FOURTH_READY') bells.push(n); });
  const r = await group.setAuto(true, { creatorId: 'B1', stake: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const room = sim.rooms.get(r.rid);
  room.seats.push('stranger_4'); sim.broadcast(room);
  assert.equal(bells.length, 0, 'sitting down is not enough');
  sim.readyBroadcast(room, 'stranger_4');           // [5,{uid,cmd:5}] reaches all three browsers
  assert.equal(bells.length, 1, 'once, though three browsers saw it');
  assert.deepEqual([bells[0].notReadyId, bells[0].keyId], ['B3', 'B1'], 'the CHƯA SS account readies by hand, the KEY starts');
  sim.readyBroadcast(room, '1_2');                   // one of ours readying never rings
  assert.equal(bells.length, 1);
});

test('SS SYNC: the số bàn Tạo found is in the SS box of all three bars; the KEY never shows its channel there', async () => {
  const { coord, sim, group } = mkGroup();
  const r = await group.setAuto(true, { creatorId: 'B1', stake: 20000 });
  const gh = require('../../desktop/protocol/phom/game-header.cjs');
  for (const b of coord.manualBrowserSnapshot()) {
    const st = gh.deriveHeaderState({ opened: true, inGame: true, manualState: b.manualState, rid: b.rid, joinedViaChannel: b.joinedViaChannel, sharedRid: group.rid() });
    assert.equal(st.ssDefault, r.rid, b.profileId);
  }
  assert.ok(sim);
});

test('LỌC BÀI lives in the Phỏm QA tool (a tab per account) — never on the browser bars', () => {
  const gh = require('../../desktop/protocol/phom/game-header.cjs');
  const st = gh.deriveHeaderState({ opened: true, inGame: true, filter: { status: 'OK', safe: [] } });
  assert.equal('filter' in st, false, 'the bar state carries no card filter');
  assert.equal(/Lọc Bài|__filterOn|NÊN ĐÁNH/.test(gh.bootScript()), false, 'no Lọc Bài button or panel in the page');
  const main = readMain();
  assert.equal(/headerFilterFor|headerCardsContext/.test(main), false);
  // the tool window: the same analyzer, one analysis per browser slot B1..B3
  assert.match(main, /analyses\[slot\] = slotAnalyzers\[slot\]\.analyze\(\{ snapshot: cards, targetPlayerUid: uid \}\)/);
  const ui = require('fs').readFileSync(new URL('../../ui-phom/phom-qa.js', import.meta.url), 'utf8');
  assert.match(ui, /safeCardsFor\(safeTab\)/); // tab P<n> = browser n = analysis B<n>
  assert.match(ui, /\['B1', 'B2', 'B3'\]\.forEach\(\(sl, i\) => \{/);
  assert.match(ui, /const a = safeBySlot\[slot\];/);
});

// ---- TẠO fast path (2026-10-05 "Tạo is slow, it browses"): the table list broadcast after the KEY sat down -------
const listFrame = (rows) => JSON.stringify([5, { rs: rows.map((r) => ({ zn: 'Simms', gid: 8, rn: 'Phom', Mu: 4, hpwd: false, ...r })), cmd: 300 }]);

test('TẠO fast path: a table list received after the KEY sat → its one-player table (newest number) is joined directly, no 313', async () => {
  const { coord, sim } = mk({ scan: [] });
  const b = CHANNELS[0].b;
  const seatedAt = Date.now() - 5;
  const k = await coord.findKeyTable('B1', { stake: b });
  assert.equal(k.ok, true);
  const keyRoom = sim.keyRoom();
  const older = [sim.room(b, 1), sim.room(b, 1)];               // strangers alone at older (lower) numbers… created later here,
  for (const r of older) r.rid = keyRoom.rid - 10 - older.indexOf(r); // …so give them lower numbers explicitly
  for (const r of older) sim.rooms.set(r.rid, r);
  sim.feed('B2', listFrame([
    { rid: keyRoom.rid, b, uC: 1 }, { rid: older[0].rid, b, uC: 1 }, { rid: older[1].rid, b, uC: 1 },
    { rid: 7000001, b, uC: 3 }, { rid: 7000002, b: b * 10, uC: 1 }, { rid: 7000003, b, uC: 1, hpwd: true },
  ]));
  const r = await coord.scanForKeyTable('B2', { stake: b, keyUid: sim.uids.B1, keySeatedAt: seatedAt });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(r.rid, keyRoom.rid);
  assert.equal(sim.asks, 0, 'no 313 lottery needed');
  assert.deepEqual(sim.sent.B2.filter((j) => j[0] === 8).map((j) => j[2]), [keyRoom.rid], 'the newest one-player table first — the KEY\'s');
});

test('TẠO fast path: a list from BEFORE the KEY sat is ignored (its table cannot be in it) → the 313 search runs', async () => {
  const { coord, sim } = mk({ scan: [] });
  const b = CHANNELS[0].b;
  const lone = sim.room(b, 1);
  sim.feed('B2', listFrame([{ rid: lone.rid, b, uC: 1 }]));          // list arrives first…
  await new Promise((res) => setTimeout(res, 5));
  const seatedAt = Date.now();                                          // …then the KEY sits
  await coord.findKeyTable('B1', { stake: b });
  const r = await coord.scanForKeyTable('B2', { stake: b, keyUid: sim.uids.B1, keySeatedAt: seatedAt });
  assert.equal(r.ok, true);
  assert.ok(sim.asks >= 1, 'found through 313');
  assert.equal(sim.sent.B2.some((j) => j[0] === 8 && j[2] === lone.rid), false, 'the stale list row was never joined');
});

test('TẠO fast path: a stranger alone at the newest table is left at once, the next candidate is tried; tries are capped', async () => {
  const { coord, sim } = mk({ scan: [] });
  const b = CHANNELS[0].b;
  const seatedAt = Date.now() - 5;
  await coord.findKeyTable('B1', { stake: b });
  const keyRoom = sim.keyRoom();
  const stranger = sim.room(b, 1);                                       // newer number than the KEY's
  sim.feed('B2', listFrame([{ rid: stranger.rid, b, uC: 1 }, { rid: keyRoom.rid, b, uC: 1 }]));
  const r = await coord.scanForKeyTable('B2', { stake: b, keyUid: sim.uids.B1, keySeatedAt: seatedAt });
  assert.equal(r.ok, true);
  assert.equal(r.rid, keyRoom.rid);
  const joins = sim.sent.B2.filter((j) => j[0] === 8).map((j) => j[2]);
  assert.deepEqual(joins, [stranger.rid, keyRoom.rid]);
  assert.ok(sim.sent.B2.some((j) => j[0] === 4), 'left the stranger\'s table');
  const src = readFileSync(new URL('../../desktop/protocol/phom/host-table-coordinator.cjs', import.meta.url), 'utf8');
  assert.match(src, /const LIST_CANDIDATE_MAX = 6;/);
});

test('TẠO: the game client own (armed) join already proves the refusal → the tool sends NO second wrong-password probe', async () => {
  const { coord, sim } = mk({ scan: ['full', 'lone', 'full'], armedGame: true });
  const b = CHANNELS[0].b;
  await coord.findKeyTable('B1', { stake: b });
  const r = await coord.scanForKeyTable('B2', { stake: b, keyUid: sim.uids.B1 });
  assert.equal(r.ok, true);
  assert.equal(sim.sent.B2.filter((j) => j[0] === 3 && j[3] === ZWSP).length, 0, 'no extra probe from the tool');
});

// ---- live 2026-10-05: an account logged out after ~60 wrong-password joins a minute for 10 minutes ---------------
test('TẠO: the 313 lottery is capped — at most N asks a minute (all accounts together)', async () => {
  const { sim } = mk({ keyNever: true, armedGame: true });
  const coord = sim.coord;
  coord._lotteryPerMin = 5;
  const logs = []; coord.on('log', (l) => logs.push(l.event));
  const b = CHANNELS[0].b;
  await coord.findKeyTable('B1', { stake: b });
  await coord.scanForKeyTable('B2', { stake: b, keyUid: sim.uids.B1, budgetMs: 400 });
  assert.equal(logs.filter((e) => e === 'SCAN_SENT').length, 5, 'stopped asking at the cap');
  assert.ok(logs.includes('SCAN_THROTTLED'));
});

test('TẠO: ONE account runs the lottery at a time — the other waits (same IP), and takes over when it ends', async () => {
  const { sim } = mk({ keyNever: true, armedGame: true });
  const coord = sim.coord;
  const b = CHANNELS[0].b;
  await coord.findKeyTable('B1', { stake: b });
  const asksBy = (id) => sim.sent[id].filter((j) => j[0] === 6 && j[3] && j[3].cmd === 313).length;
  await Promise.all([
    coord.scanForKeyTable('B2', { stake: b, keyUid: sim.uids.B1, budgetMs: 250 }),
    coord.scanForKeyTable('B3', { stake: b, keyUid: sim.uids.B1, budgetMs: 250 }),
  ]);
  assert.ok(asksBy('B2') > 0);
  assert.equal(asksBy('B3'), 0, 'B3 never asked while B2 owned the lottery');
  assert.equal(coord._lottery.owner, null, 'released when the searches ended');
});

test('TẠO: while the KEY is not seated (kicked — its table is gone) nothing is asked; it resumes once the KEY sits again', async () => {
  const { sim } = mk({ scan: [] });
  const coord = sim.coord;
  const b = CHANNELS[0].b;
  await coord.findKeyTable('B1', { stake: b });
  sim.kick('B1', 'Bạn thoát vì không bắt đầu');                 // the KEY's table is gone
  const logs = []; coord.on('log', (l) => logs.push(l.event));
  let seatedAt = 0;
  const p = coord.scanForKeyTable('B2', { stake: b, keyUid: sim.uids.B1, budgetMs: 2000, keySeatedAt: () => seatedAt });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sim.asks, 0, 'no 313 while the KEY has no table');
  assert.ok(logs.includes('SCAN_WAIT_KEY'));
  seatedAt = Date.now();
  await coord.findKeyTable('B1', { stake: b });                  // the KEY sits again (a new table)
  const newKeyRoom = sim.keyRoom();
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.rid, newKeyRoom.rid, 'found the NEW table');
});

test('ROUND state is per table: a TẠO sitting at a stranger\'s running table never leaves the group "in a round"', () => {
  const { sim } = mk();
  const coord = sim.coord;
  sim.feed('B2', JSON.stringify([5, { b: 500, gS: 4, ps: [{ uid: 's1', sit: 0, C: true, r: true }, { uid: sim.uids.B2, sit: 1 }], cmd: 202 }]));
  assert.equal(coord.roundRunning('B2'), true, 'that stranger table is playing');
  sim.feed('B2', '[4,true,1,-1,0,""]');                              // left it
  assert.equal(coord.roundRunning('B2'), false);
  sim.feed('B1', JSON.stringify([5, { b: 500, gS: 1, ps: [{ uid: sim.uids.B1, sit: 0, C: true }], cmd: 202 }]));
  assert.equal(coord.roundRunning('B1'), false, 'the KEY waits alone: no round');
  assert.equal(coord.roundRunning(), false);
});
