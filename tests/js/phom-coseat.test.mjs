// §co-seat — VÀO (op 8, no password ever) and the proof that browsers really sit together: the KEY's uid in the
// joiner's own ps[] (joinTable expectUid) and every browser's ps[] for the cluster verdict (coSeatStatus).
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
      if (j[0] === 8 || j[0] === 3) { // the tool's VÀO is op 8 (join this exact table)
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
const join = (coord, id, rid, opts = {}) => coord.joinTable(id, rid, { timeoutMs: 60, ...opts });

// ===================== no password, ever =====================

test('NOPWD: VÀO always sends the empty password (op 8) — one attempt, the refusal reported as it is', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, key: 'LIVEKEY1', seats: [] }]);
  const res = await join(coord, 'B2', 700);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_JOIN_REJECTED');
  assert.match(res.error.message, /Sai mật khẩu phòng/);
  assert.deepEqual(sim.keysSeen.B2, [''], 'one JOIN, empty password — never a guessed key, never a retry loop');
});

// ===================== same-room proof (expectUid = the KEY) =====================

test('SAME-01: seated at a DIFFERENT table than the KEY is NOT a success — and that table is left again', async () => {
  const { coord, sim } = mk([
    { rid: 700, b: 500, seats: [], seatElsewhere: 800, divert: ['B2'] }, // B2 asks for 700 → the server seats it at 800
    { rid: 800, b: 500, seats: [] },
  ]);
  assert.equal((await join(coord, 'B1', 700)).ok, true);
  const res = await join(coord, 'B2', 700, { expectUid: '1_1' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_NOT_KEY_TABLE');
  assert.equal(sim._room(800).seats.find((x) => x.uid === '1_2'), undefined, 'B2 left the wrong table');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B2').rid, null);
});

test('SAME-02: at the table of the KEY → ok, JOINED', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  await join(coord, 'B1', 700);
  const res = await join(coord, 'B2', 700, { expectUid: '1_1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B2').manualState, 'JOINED');
});

test('SAME-03: a browser seated elsewhere leaves first — a JOIN is never sent while seated', async () => {
  const { coord, sim } = mk([{ rid: 700, b: 500, seats: [] }, { rid: 800, b: 500, seats: [] }]);
  await join(coord, 'B2', 800);
  const res = await join(coord, 'B2', 700);
  assert.equal(res.ok, true);
  assert.equal(sim._room(800).seats.length, 0);
});

// ===================== the cluster verdict (coSeatStatus) =====================

test('VERIFY-01: nobody seated → IDLE', () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  assert.equal(coord.coSeatStatus().result, 'IDLE');
});

test('VERIFY-02: all three in the same ps[] → SAME_TABLE', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  for (const id of ['B1', 'B2', 'B3']) await join(coord, id, 700);
  const st = coord.coSeatStatus();
  assert.equal(st.ok, true); assert.equal(st.result, 'SAME_TABLE');
  assert.equal(st.seatedCount, 3); assert.equal(st.browserCount, 3); assert.equal(st.playerCount, 3);
});

test('VERIFY-03: only two seated → PARTIAL_JOIN, never a green "đủ 3"', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  await join(coord, 'B1', 700); await join(coord, 'B2', 700);
  const st = coord.coSeatStatus();
  assert.equal(st.ok, false); assert.equal(st.result, 'PARTIAL_JOIN'); assert.equal(st.seatedCount, 2);
});

test('VERIFY-04: three browsers each at a DIFFERENT table is NOT "đủ 3 cùng bàn"', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }, { rid: 800, b: 500, seats: [] }, { rid: 900, b: 500, seats: [] }]);
  await join(coord, 'B1', 700); await join(coord, 'B2', 800); await join(coord, 'B3', 900);
  for (const id of ['B1', 'B2', 'B3']) assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === id).manualState, 'JOINED');
  const st = coord.coSeatStatus();
  assert.equal(st.ok, false, 'three separate tables must never read as co-seated');
  assert.equal(st.result, 'TABLE_MISMATCH');
});
