// Four defects found reviewing the TÌM BÀN surface, each with the behaviour that must not come back:
//   PROBE-*   the game-memory probe's hit() tested a shape the probe no longer returns, so it never matched:
//             the 800k-object walk ran in every frame and the result kept was the outer page's, not the game's.
//   FLAG-*    manualDiscoverTable's finally cleared the single-flight flag unconditionally, so a superseded run
//             unwinding late released the flag (and blanked the progress) of the FIND that had replaced it.
//   CHAN-*    a seat taken through the stake CHANNEL (rid 139) was published and LABELLED as a "SS" (số bàn).
//             The id is genuinely joinable — the followers JOINing it inside the server's fill-room window is
//             how the group co-seats (see REAL-06) — so it must keep being published; what was wrong is calling
//             it a số bàn, and the Tool joining the followers one at a time so the ~1.3s window had closed.
//   NOISE-*   _pickManualCandidate runs inside the FIND poll's predicate — i.e. on every WS frame — and emitted
//             one ungated trace/IPC message PER REJECTED ROW every time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');

const MAIN = readFileSync('desktop/phom-main.cjs', 'utf8');

// A sim whose lobby exposes a stake CHANNEL (uC > Mu, the row a player clicks) plus optional real tables.
// Joining the channel seats you at `seatsAt`, exactly as the live server does.
class Sim {
  constructor(rooms) {
    this.rooms = rooms.map((r) => ({ Mu: 4, ...r, seats: (r.seats || []).map((s) => ({ ...s })) }));
    this.uids = { B1: '1_1', B2: '1_2', B3: '1_3' };
    this.coord = null; this.channelReqs = 0;
  }
  attach(c) { this.coord = c; }
  _feed(id, raw) { this.coord.ingest(id, { raw, direction: 'recv', targetId: id, url: 'wss://sim', now: Date.now() }); }
  _channelList() {
    const rs = this.rooms.filter((r) => !r.hidden).map((r) => ({ rid: r.rid, b: r.b, uC: r.uC != null ? r.uC : r.seats.length, Mu: r.Mu, zn: 'Simms', gid: 8, rn: 'Phom' }));
    return JSON.stringify([5, { rs, cmd: 300 }]);
  }
  _table(r) { return JSON.stringify([5, { b: r.b, ps: r.seats.map((s) => ({ uid: s.uid, sit: s.sit, r: false })), cmd: 202 }]); }
  _room(rid) { return this.rooms.find((r) => r.rid === rid); }
  sendFor(id) {
    return async (frame) => {
      let j; try { j = JSON.parse(frame); } catch { return { ok: true }; }
      const uid = this.uids[id];
      if (j[0] === 6 && j[3] && j[3].cmd === 300) { this.channelReqs++; this._feed(id, this._channelList()); return { ok: true }; }
      if (j[0] === 3) {
        let room = this._room(j[2]); if (!room) return { ok: true };
        if (room.seatsAt != null) room = this._room(room.seatsAt); // the stake channel seats you at a real table
        if (!room.seats.find((s) => s.uid === uid) && room.seats.length < room.Mu) room.seats.push({ uid, sit: room.seats.length });
        this._feed(id, this._table(room)); return { ok: true };
      }
      if (j[0] === 4) { for (const r of this.rooms) r.seats = r.seats.filter((s) => s.uid !== uid); this._feed(id, this._channelList()); return { ok: true }; }
      return { ok: true };
    };
  }
}
function mk(rooms, opts = {}) {
  const sim = new Sim(rooms);
  const coord = new HostTableCoordinator({
    environmentAuthorized: true, delay: () => Promise.resolve(),
    findBudgetMs: 60, findPollMs: 10, rerollCooldownMs: 0, joinRejectGraceMs: 10, leaveConfirmMs: 40,
    profiles: ['B1', 'B2', 'B3'].map((id) => ({ id, displayName: id, send: sim.sendFor(id) })), ...opts,
  });
  sim.attach(coord);
  for (const id of ['B1', 'B2', 'B3']) {
    coord.ingest(id, { raw: `[5,{"uid":"${sim.uids[id]}","As":{"gold":1},"cmd":100,"id":0}]`, direction: 'recv', targetId: id, url: 'wss://sim', now: 1 });
    coord.setIdentity(id, { aid: '1' });
  }
  return { coord, sim };
}

// ===================== PROBE: hit() must match what the probe returns =====================

test('PROBE-01: hit() tests the fields GAME_ROOM_PROBE actually returns', () => {
  const probeStart = MAIN.indexOf('const GAME_ROOM_PROBE');
  const probeSrc = MAIN.slice(probeStart, MAIN.indexOf('const _probeCtx', probeStart));
  // The declared output object is the contract hit() has to match.
  const decl = /var out=\{([^}]*)\}/.exec(probeSrc);
  assert.ok(decl, 'the probe must declare its output object');
  const fields = decl[1].split(',').map((kv) => kv.split(':')[0].trim());
  assert.ok(fields.includes('both') && fields.includes('hits'), `probe returns ${fields.join('/')}`);

  const hitLine = /const hit = \(x\) => [^\n]*/.exec(MAIN)[0];
  for (const f of ['both', 'hits']) assert.ok(hitLine.includes('x.' + f), `hit() must test x.${f}`);
  // The old shape must be gone, and the fields every context returns must never count as a hit.
  for (const dead of ['x.lists', 'x.cur']) assert.ok(!hitLine.includes(dead), `hit() still tests the stale ${dead}`);
  for (const always of ['x.globals', 'x.scanned']) assert.ok(!hitLine.includes(always), `${always} comes back from every frame and cannot be a hit`);
});

test('PROBE-02: the fallback keeps the most informative context, not the first one', () => {
  assert.ok(/const score = \(x\) =>/.test(MAIN), 'a scoring function must rank the non-hit results');
  assert.ok(!/best = best \|\| parsed/.test(MAIN), 'first-wins would keep the cross-origin outer page');
  assert.ok(/score\(parsed\) > score\(best\)/.test(MAIN), 'the best-scoring context must win');
  // Reproduce the scorer and check it prefers a game-frame walk over an empty outer-page one.
  const score = (x) => (x ? ((x.both ? x.both.length : 0) * 1e6) + ((x.hits ? x.hits.length : 0) * 1e3) + Math.min(x.scanned || 0, 999) : -1);
  const outerPage = { globals: ['a'], hits: [], both: [], scanned: 12 };
  const gameFrame = { globals: ['cc'], hits: [{ path: 'w.cc.room' }], both: [], scanned: 400000 };
  assert.ok(score(gameFrame) > score(outerPage));
  assert.ok(score(outerPage) > score(null));
});

// ===================== FLAG: single-flight ownership =====================

test('FLAG-01: a superseded FIND unwinding late does not release the NEW search flag', async () => {
  const { coord } = mk([{ rid: 139, b: 500, uC: 99, Mu: 4, seatsAt: 700 }, { rid: 700, b: 500, seats: [] }]);
  const rec = coord._rec('B1');
  const first = coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 60, pollMs: 10, minSeats: 3 });
  assert.equal(rec._discovering, true);
  await coord.cancelFind('B1');                 // HỦY clears the flag itself
  assert.equal(rec._discovering, false);
  // The user immediately starts a new search while the cancelled one is still unwinding.
  const second = coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 60, pollMs: 10, minSeats: 3 });
  assert.equal(rec._discovering, true, 'the new search owns the flag');
  const newStartedAt = rec._searchStartedAt;
  await first;                                   // the OLD run finishes and runs its finally
  assert.equal(rec._discovering, true, 'the superseded run must not release the new search flag');
  assert.equal(rec._searchStartedAt, newStartedAt, 'nor blank the new search progress clock');
  await second;
});

test('FLAG-02: the owning run still releases the flag normally', async () => {
  const { coord } = mk([{ rid: 700, b: 500, seats: [] }]);
  const rec = coord._rec('B1');
  await coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 60, pollMs: 10, minSeats: 3 });
  assert.equal(rec._discovering, false);
  assert.equal(rec._searchStartedAt, null);
});

// ===================== CHAN: a stake-channel seat is not a shareable room =====================

test('CHAN-01: a stake-channel seat IS still published (the followers join that id) but flagged as a channel', async () => {
  // Only the stake bucket exists (uC 99 > Mu 4) — no real table row to take, so the fallback is the channel.
  const { coord } = mk([{ rid: 139, b: 500, uC: 99, Mu: 4, seatsAt: 700 }, { rid: 700, b: 500, seats: [], hidden: true }]);
  const res = await coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 80, pollMs: 10, minSeats: 1, stakeFallbackAfterMs: 0 });
  assert.equal(res.ok, true, 'the browser IS seated — the seat is kept');
  assert.equal(res.viaStakeChannel, true);
  // It must stay published: REAL-06 proves a follower JOINing this same id lands with the anchor.
  assert.equal(coord.sharedRid(), 139);
  assert.equal(coord.sharedRidOwner(), 'B1');
  assert.equal(coord.sharedRidIsChannel(), true, 'but it is a CHANNEL id, not a 7-digit số bàn');
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'B1').joinedViaChannel, true);
  assert.equal(coord._rec('B1').lastError, null, 'a channel seat is not an error state');
});

test('CHAN-02: a FIND that lands on a REAL table row is published as a số bàn', async () => {
  const { coord } = mk([{ rid: 139, b: 500, uC: 99, Mu: 4, seatsAt: 700 }, { rid: 700, b: 500, seats: [] }]);
  const res = await coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 60, pollMs: 10, minSeats: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.viaStakeChannel, false);
  assert.equal(coord.sharedRid(), 700);
  assert.equal(coord.sharedRidIsChannel(), false);
});

test('CHAN-03: the channel flag is re-decided by every join, so it can never go stale', async () => {
  const { coord } = mk([{ rid: 139, b: 500, uC: 99, Mu: 4, seatsAt: 700 }, { rid: 700, b: 500, seats: [], hidden: true }]);
  await coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 80, pollMs: 10, minSeats: 1, stakeFallbackAfterMs: 0 });
  assert.equal(coord._rec('B1')._joinedViaChannel, true);
  await coord.manualLeave('B1');
  await coord.manualJoinRoom('B1', 700, { timeoutMs: 60 }); // a plain JOIN of a real rid
  assert.equal(coord._rec('B1')._joinedViaChannel, false, 'the next join clears it');
  assert.equal(coord.sharedRidIsChannel(), false);
});

test('CHAN-04: the header calls a channel id KÊNH, never SS', () => {
  const { deriveHeaderState } = require('../../desktop/protocol/phom/game-header.cjs');
  const base = { account: 'a', opened: true, inGame: true, manualState: 'JOINED', rid: 139, sharedRid: 139 };
  assert.match(deriveHeaderState({ ...base, joinedViaChannel: true }).statusLabel, /^KÊNH 139/);
  assert.match(deriveHeaderState({ ...base, rid: 1234567, sharedRid: 1234567 }).statusLabel, /^SS 1234567/);
});

test('CHAN-05: the Tool fires the follower JOINs in PARALLEL so the fill-room window is not missed', () => {
  const ui = readFileSync('ui-phom/phom-qa.js', 'utf8');
  const fn = ui.slice(ui.indexOf('async function runFindTable'), ui.indexOf('// Advance the happy path'));
  assert.ok(/Promise\.all\(followerIds\.map\(/.test(fn), 'the followers must be joined at once');
  assert.ok(!/for \(const runId of followerIds\)[\s\S]{0,120}await api\.manualJoinShared/.test(fn),
    'a sequential await loop spends up to 8s per follower — the ~1.3s grouping window closes before the second');
});

// ===================== NOISE: no per-frame reject storm =====================

test('NOISE-01: an unchanged server picture is logged once, not once per WS frame', async () => {
  // Real tables at the stake, none with enough free seats → every poll rejects the same rows.
  const { coord, sim } = mk([{ rid: 701, b: 500, seats: [{ uid: 'x1', sit: 0 }, { uid: 'x2', sit: 1 }, { uid: 'x3', sit: 2 }] }]);
  let rejectLogs = 0;
  coord.on('log', (l) => { if (l && l.event === 'TABLE_REJECT') rejectLogs++; });
  const find = coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 120, pollMs: 15, minSeats: 3, noStakeFallback: true });
  // Ordinary game traffic on another browser: each frame emits 'update' and re-runs the FIND predicate.
  for (let i = 0; i < 40; i++) sim._feed('B2', JSON.stringify([5, { cmd: 202, b: 500, ps: [{ uid: '1_2', sit: 0, r: false }] }]));
  await find;
  assert.ok(rejectLogs > 0, 'the diagnosis itself must still be produced');
  // The lobby row never changes, so ONE entry is the whole truth. Before the fix this sim produced 12 — and a
  // sim is gentle: in production it is one per rejected row per frame of three live browsers, for up to 300s.
  assert.ok(rejectLogs <= 3, `one entry per DISTINCT picture expected, got ${rejectLogs} across 40 extra frames`);
});

test('NOISE-02: a fresh FIND always logs its first evaluation', async () => {
  const { coord } = mk([{ rid: 701, b: 500, seats: [{ uid: 'x1', sit: 0 }, { uid: 'x2', sit: 1 }, { uid: 'x3', sit: 2 }] }]);
  const count = () => { let n = 0; const h = (l) => { if (l && l.event === 'TABLE_REJECT') n++; }; coord.on('log', h); return { done: () => { coord.off('log', h); return n; } }; }
  const a = count();
  await coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 40, pollMs: 10, minSeats: 3, noStakeFallback: true });
  assert.ok(a.done() > 0);
  const b = count();
  await coord.manualDiscoverTable('B1', { selectedStake: 500, budgetMs: 40, pollMs: 10, minSeats: 3, noStakeFallback: true });
  assert.ok(b.done() > 0, 'the second search must not be silenced by the first search signature');
});

test('NOISE-03: the always-on wire log batches instead of blocking per frame', () => {
  const fn = MAIN.slice(MAIN.indexOf('function appendCoseatLog'), MAIN.indexOf('// §ws-inspect'));
  assert.ok(!/appendFileSync/.test(fn), 'appendCoseatLog must not write synchronously per entry');
  assert.ok(/_coseatQueue\.push/.test(fn) && /setTimeout\(_coseatFlush/.test(fn), 'it must queue + schedule a flush');
  assert.ok(/COSEAT_MAX_QUEUE/.test(fn), 'a burst must flush rather than grow unbounded');
  // The queue has to reach disk on the paths that read it and on shutdown.
  assert.ok(/_coseatFlush\(\); \/\/ §ws-log — the newest frames/.test(MAIN), 'exportWsLog must flush first');
  assert.ok(/will-quit[\s\S]{0,120}_coseatFlush\(\)/.test(MAIN), 'the last batch must be flushed on quit');
  // Rotation + archive-on-start behaviour moved with it, not away.
  const flush = MAIN.slice(MAIN.indexOf('function _coseatFlush'), MAIN.indexOf('function appendCoseatLog'));
  assert.ok(/_archiveCoseat\(dir, 'start'\)/.test(flush) && /_archiveCoseat\(dir, 'rotate'\)/.test(flush));
});
