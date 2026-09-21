// §key-refresh / §same-room — the two rules the reference-tool video (IMG_3777) made explicit for the
// co-seat JOIN-by-số-bàn path (manualJoinByCode):
//
//   §key-refresh — "Sai mật khẩu phòng" must NOT be answered by replaying the same key. A refused key is
//                  never re-sent; the anchor's LIVE room code (its own ps[].hpwd) is re-read every attempt,
//                  so a rotated key is picked up mid-retry; when every known key has been refused the retry
//                  STOPS with a typed error instead of hammering the server for minutes.
//   §same-room   — success is own uid ∈ ps[] AND the anchor's uid in that SAME authoritative table state.
//                  "Seated somewhere" is not a co-seat: a mismatch leaves the wrong table.
//
// Plus §room-locked: the FIND qualifier must skip rs[] rows flagged hpwd===true (a password-protected room
// whose key the finder cannot possibly hold), instead of joining, being refused and re-rolling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

// A server sim where a room has a KEY: a JOIN carrying the wrong key is REFUSED with the real server message
// ([3,false,<code>,-1,"Sai mật khẩu phòng"]); the right key seats you. `key` may be rotated mid-test.
class KeySim {
  constructor(rooms) {
    this.rooms = rooms.map((r) => ({ Mu: 4, ...r, seats: (r.seats || []).map((s) => ({ ...s })) }));
    this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' };
    this.coord = null; this.keysSeen = { B1: [], B2: [], B3: [] };
  }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _channelList() {
    const rs = this.rooms.map((r) => ({ rid: r.rid, b: r.b, uC: r.uC != null ? r.uC : r.seats.length, Mu: r.Mu, zn: 'Simms', gid: 8, rn: 'Phom', hpwd: r.key ? true : false }));
    return JSON.stringify([5, { rs, cmd: 300 }]);
  }
  // hpwd is a STRING here: inside a table the server hands out the room's actual code.
  _table(r) { return JSON.stringify([5, { b: r.b, hpwd: r.key || '', ps: r.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _room(rid) { return this.rooms.find((r) => r.rid === rid); }
  // The real server pushes a room's TABLE_STATE to EVERY member, not just the browser that just joined — which
  // is what makes "all three see each other in their own ps[]" (verifySameTable) provable at all.
  _broadcast(room) { for (const [bid, uid] of Object.entries(this.uids)) if (room.seats.find((s) => s.uid === uid)) this._feed(bid, this._table(room)); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this._feed(id, this._channelList()); return { ok: true }; }
      if (j[0] === 3) {
        const rid = j[2]; const sentKey = j[3] != null ? String(j[3]) : '';
        const room = this._room(rid); if (!room) return { ok: true };
        this.keysSeen[id].push(sentKey);
        if (room.key && sentKey !== room.key) { this._feed(id, JSON.stringify([3, false, 102, -1, 'Sai mật khẩu phòng'])); return { ok: true }; }
        // The server seats THIS browser at a DIFFERENT table (no co-seat). `divert` names who gets moved, so
        // the anchor can genuinely sit at the target room while the follower is scattered elsewhere.
        if (room.seatElsewhere && (!room.divert || room.divert.includes(id))) {
          const other = this._room(room.seatElsewhere);
          if (!other.seats.find((s) => s.uid === uid)) other.seats.push({ uid, sit: other.seats.length });
          this._broadcast(other); return { ok: true };
        }
        if (!room.seats.find((s) => s.uid === uid) && room.seats.length < room.Mu) room.seats.push({ uid, sit: room.seats.length });
        this._broadcast(room); return { ok: true };
      }
      if (j[0] === 4) {
        const left = this.rooms.filter((r) => r.seats.find((s) => s.uid === uid));
        for (const r of this.rooms) r.seats = r.seats.filter((s) => s.uid !== uid);
        for (const r of left) this._broadcast(r);      // the people still at the table see the seat free up
        this._feed(id, '[4,true,1,-1,0,""]');
        this._feed(id, this._channelList());           // discovery metadata, not exit evidence
        return { ok: true };
      }
      return { ok: true };
    };
  }
}
function mk(rooms) {
  const sim = new KeySim(rooms);
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, delay: () => Promise.resolve(),
    findBudgetMs: 60, findPollMs: 10, rerollCooldownMs: 0, joinRejectGraceMs: 10, leaveConfirmMs: 40,
    profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })),
  });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) {
    coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 });
    coord.setIdentity(id, { aid: '1' });
  }
  return { coord, sim };
}
// Seat B1 (the anchor) at `rid` so _anchorRoomCode()/_anchorUid() have something authoritative to read.
async function seatAnchor(coord, rid, key) {
  const r = await coord.manualJoinRoom('B1', rid, { roomCode: key || '', timeoutMs: 60 });
  assert.equal(r.ok, true, 'anchor must be seated for the test to mean anything');
  coord.setFinder('B1');
  return r;
}

// ===================== §key-refresh =====================

test('KEY-01: a refused key is NEVER re-sent, and the anchor table code is never lifted as a password', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, key: 'LIVEKEY1', seats: [] }]);
  await seatAnchor(coord, 700, 'LIVEKEY1');
  // B2 is told to use a STALE key. It must be tried once, refused, and never sent again.
  const res = await coord.manualJoinByCode('B2', 700, 'STALEKEY', { timeoutMs: 60 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_ROOM_KEY_REJECTED');
  const sent = sim.keysSeen.B2;
  assert.deepEqual(sent, ['STALEKEY', ''], 'the typed key once, then the empty code — nothing else');
  assert.equal(sent.includes('LIVEKEY1'), false, '§no-password: the anchor ps[].hpwd is never sent');
});

test('KEY-02: every known key refused → stops with PHOM_ROOM_KEY_REJECTED, not 40 attempts', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, key: 'SECRET', seats: [] }, { rid: 701, b: 500, seats: [] }]);
  // The anchor is seated at a DIFFERENT, open room, so its live code is not 700's key: nothing we know can work.
  await seatAnchor(coord, 701, '');
  const res = await coord.manualJoinByCode('B2', 700, 'WRONG', { timeoutMs: 60 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_ROOM_KEY_REJECTED');
  // pinned 'WRONG' + the public '' — two distinct keys, so at most two JOINs. Never a 41-attempt hammer.
  assert.ok(sim.keysSeen.B2.length <= 2, `expected <= 2 join attempts, got ${sim.keysSeen.B2.length}`);
  assert.equal(new Set(sim.keysSeen.B2).size, sim.keysSeen.B2.length, 'no key is ever repeated');
});

test('KEY-03: an OPEN table is joined with the empty code even when the anchor table state carries a code', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [] }]);
  await seatAnchor(coord, 700, '');
  sim._feed('B1', JSON.stringify([5, { b: 500, hpwd: 'TABLE-CODE', ps: sim._room(700).seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]));
  const res = await coord.manualJoinByCode('B2', 700, null, { timeoutMs: 60 });
  assert.equal(res.ok, true);
  assert.deepEqual(sim.keysSeen.B2, [''], '§no-password');
});

test('KEY-04: the default retry ceiling is bounded (6), not the old 40', async () => {
  const src = require('node:fs').readFileSync('desktop/protocol/phom/host-table-coordinator.cjs', 'utf8');
  assert.match(src, /const MAX_JOIN_BY_CODE_RETRIES = 6;/);
  assert.doesNotMatch(src, /opts\.maxRetries != null \? opts\.maxRetries : 40/, 'no hard-coded 40 left');
  const main = require('node:fs').readFileSync('desktop/phom-main.cjs', 'utf8');
  assert.doesNotMatch(main, /manualJoinByCode\([^)]*maxRetries: 40/, 'the auto co-seat call must not override it with 40');
});

// ===================== §same-room proof =====================

test('SAME-01: seated at a DIFFERENT table than the anchor is NOT a success', async () => {
  const { coord } = mk([
    { rid: 700, b: 500, seats: [], seatElsewhere: 800, divert: ['B2'] }, // B2 JOINs 700 → the server seats it at 800
    { rid: 800, b: 500, seats: [] },
  ]);
  await seatAnchor(coord, 700, ''); // the anchor really is at 700; only B2 gets scattered
  const res = await coord.manualJoinByCode('B2', 700, null, { timeoutMs: 60 });
  assert.equal(res.ok, false, 'B2 landed at 800 while the anchor is at 700 → not a co-seat');
  assert.equal(res.error.code, 'PHOM_FOLLOWER_ROOM_MISMATCH');
});

test('SAME-02: a room mismatch LEAVES the wrong table instead of reporting JOINED', async () => {
  const { coord, sim } = mk([
    { rid: 700, b: 500, seats: [], seatElsewhere: 800, divert: ['B2'] },
    { rid: 800, b: 500, seats: [] },
  ]);
  await seatAnchor(coord, 700, '');
  await coord.manualJoinByCode('B2', 700, null, { timeoutMs: 60 });
  const b2 = coord.manualBrowserSnapshot().find((b) => b.profileId === 'B2');
  assert.equal(b2.manualState, 'FOLLOWER_ERROR');
  assert.equal(b2.rid, null, 'the wrong table must not be left dangling as B2 rid');
  assert.equal(sim._room(800).seats.find((s) => s.uid === '1_2'), undefined, 'B2 must have left the wrong table');
});

test('SAME-03: co-seated with the anchor → ok with sameRoom proof', async () => {
  const { coord } = mk([{ rid: 700, b: 500, key: 'K', seats: [] }]);
  await seatAnchor(coord, 700, 'K');
  const res = await coord.manualJoinByCode('B2', 700, 'K', { timeoutMs: 60 });
  assert.equal(res.ok, true);
  assert.equal(res.sameRoom, true);
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B2').manualState, 'JOINED');
});

// ===================== §room-locked (the FIND qualifier) =====================

test('VERIFY-01: the manual flow (no setHost) reaches a real verdict, not PHOM_TABLE_IDENTITY_MISSING', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  // Nobody holds a room yet → there is genuinely no reference browser.
  assert.equal(coord.verifySameTable().result, 'PHOM_TABLE_IDENTITY_MISSING');
  await seatAnchor(coord, 700, '');
  // The anchor now holds the room. setHost was NEVER called — the old code stayed IDENTITY_MISSING forever here.
  assert.notEqual(coord.verifySameTable().result, 'PHOM_TABLE_IDENTITY_MISSING');
});

test('VERIFY-02: all three in the same ps[] → SAME_TABLE and coSeatStatus().ok', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  await seatAnchor(coord, 700, '');
  await coord.manualJoinByCode('B2', 700, null, { timeoutMs: 60 });
  await coord.manualJoinByCode('B3', 700, null, { timeoutMs: 60 });
  assert.equal(coord.verifySameTable().result, 'SAME_TABLE');
  const st = coord.coSeatStatus();
  assert.equal(st.ok, true);
  assert.equal(st.rid, 700);
  assert.equal(st.seatedCount, 3);
  assert.equal(st.browserCount, 3);
});

test('VERIFY-03: only two seated → PARTIAL_JOIN, never a green "đủ 3"', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  await seatAnchor(coord, 700, '');
  await coord.manualJoinByCode('B2', 700, null, { timeoutMs: 60 });
  const st = coord.coSeatStatus();
  assert.equal(st.ok, false);
  assert.equal(st.result, 'PARTIAL_JOIN');
  assert.equal(st.seatedCount, 2);
});

test('VERIFY-04: three browsers each seated at a DIFFERENT table is NOT "đủ 3 cùng bàn"', async () => {
  const { coord } = mk([
    { rid: 700, b: 500, seats: [] },
    { rid: 800, b: 500, seats: [] },
    { rid: 900, b: 500, seats: [] },
  ]);
  await seatAnchor(coord, 700, '');
  await coord.manualJoinRoom('B2', 800, { timeoutMs: 60 });
  await coord.manualJoinRoom('B3', 900, { timeoutMs: 60 });
  // Every browser reports JOINED on its own — the exact state a per-browser badge would call a success.
  for (const id of ['B1', 'B2', 'B3']) assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === id).manualState, 'JOINED');
  const st = coord.coSeatStatus();
  assert.equal(st.ok, false, 'three separate tables must never read as co-seated');
  assert.equal(st.result, 'TABLE_MISMATCH');
});

test('VERIFY-05: the legacy host/follower flow keeps using setHost unchanged', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  coord.setHost('B2');
  await coord.manualJoinRoom('B2', 700, { timeoutMs: 60 });
  // B2 is the host; the reference uid must be B2's, not the anchor-by-default first profile.
  const v = coord.verifySameTable();
  assert.equal(v.result, 'PARTIAL_JOIN', 'B1/B3 have no table state yet');
  await coord.manualJoinRoom('B1', 700, { timeoutMs: 60 });
  await coord.manualJoinRoom('B3', 700, { timeoutMs: 60 });
  const v2 = coord.verifySameTable();
  assert.equal(v2.result, 'SAME_TABLE');
  assert.equal(v2.hostUid, '1_2', 'the explicit host stays the reference');
});
