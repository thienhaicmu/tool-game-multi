import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAutoPlayFeature } = require('../../desktop/phom/features/auto-play.cjs');
import { replay } from '../../tools/phom-auto-play-replay.mjs';

function fixture(extra = {}) {
  let time = 0;
  const calls = [];
  const snap = { roundSeq: 1, roundPlayers: ['me', 'other'], nextOf: { me: 'other' },
    players: { me: { uid: 'me', currentCards: [35, 50], melds: [], discardedHistory: [], drawnHistory: [], sentCards: [] },
      other: { uid: 'other', currentCards: [], melds: [] } }, eats: [], observedDiscardEvents: [], ledger: [] };
  const timers = new Map();
  let timerId = 0;
  const feature = createAutoPlayFeature({ snapshot: () => snap, uidOf: () => 'me',
    clientFor: () => ({ Runtime: { evaluate: async () => ({ result: { value: { ok: true, atTable: true, offered: ['DANH'] } } }) } }),
    act: async (rid, input) => { calls.push({ rid, ...input }); return { ok: true }; },
    now: () => time, setTimer: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimer: (id) => timers.delete(id),
    settleMs: 10, jitterMs: 0, stallMs: 100, ...extra });
  return { feature, snap, calls, timers, time: (t) => { time = t; } };
}

test('unrelated public updates never acknowledge or duplicate an in-flight discard', async () => {
  const f = fixture();
  f.feature.start('r');
  await f.feature.tick(); f.time(20); await f.feature.tick();
  assert.equal(f.calls.length, 1);
  f.snap.players.other.melds.push({ meid: 2, cards: [0, 4, 8] });
  f.time(40); await f.feature.tick();
  assert.equal(f.calls.length, 1);
  f.time(130); await f.feature.tick();
  // not confirmed: stopped and ARMED to resume (the switch stays on), no second press
  assert.equal(f.feature.status().r.resuming, true);
  assert.equal(f.calls.length, 1);
});

test('changed state restarts settling and stopping cancels a pending action', async () => {
  const f = fixture(); f.feature.start('r');
  await f.feature.tick();
  f.snap.players.other.melds.push({ meid: 2, cards: [0, 4, 8] });
  f.time(20); await f.feature.tick();
  assert.equal(f.calls.length, 0);
  f.feature.stop('r'); f.time(40); await f.feature.tick();
  assert.equal(f.calls.length, 0);
});

test('recorded decisions can be replayed without executing a game action', () => {
  const f = fixture();
  const { nextStep } = require('../../desktop/protocol/phom/phom-auto-play.cjs');
  const step = nextStep(f.snap, 'me', ['DANH']);
  const results = replay(['# session', JSON.stringify({ event: 'auto-play-decision', snapshot: f.snap,
    uid: 'me', offered: ['DANH'], step })]);
  assert.equal(results.length, 1);
  assert.equal(results[0].same, true);
  assert.equal(f.calls.length, 0);
});

test('a busy browser does not prevent ticks for another account', async () => {
  const f = fixture();
  let release;
  const hanging = new Promise((resolve) => { release = resolve; });
  let probes = 0;
  const feature = createAutoPlayFeature({ snapshot: () => f.snap, uidOf: () => 'me',
    clientFor: (rid) => ({ Runtime: { evaluate: () => rid === 'slow' ? hanging : Promise.resolve((probes++,
      { result: { value: { ok: true, atTable: true, offered: [] } } })) } }),
    act: async () => ({ ok: true }), setTimer: () => 1, clearTimer: () => {} });
  feature.start('slow'); feature.start('fast');
  const first = feature.tick();
  await new Promise(setImmediate);
  await feature.tick();
  assert.equal(probes, 2);
  release({ result: { value: { ok: true, atTable: true, offered: [] } } });
  await first; feature.stopAll();
});

test('R1: each press waits a human pause of settleMs + random·jitterMs (0.8–2.5 s by default)', async () => {
  const f = fixture({ settleMs: 800, jitterMs: 1700, random: () => 0.5 }); // 800 + 850
  f.feature.start('r');
  await f.feature.tick();
  f.time(1600); await f.feature.tick();
  assert.equal(f.calls.length, 0);
  f.time(1700); await f.feature.tick();
  assert.equal(f.calls.length, 1);
});

test('R3: a recoverable stop resumes once back at the table; the user switching off cancels it', async () => {
  const f = fixture({ resumeDelayMs: 50 });
  f.feature.start('r');
  f.feature.documentReplaced({ run: { id: 'r' } });
  assert.equal(f.feature.status().r.resuming, true);
  assert.equal(f.feature.status().r.on, true);
  f.time(10); await f.feature.tick();
  assert.equal(f.feature.status().r.resuming, true); // too soon after the stop
  f.time(60); await f.feature.tick();
  assert.equal(f.feature.status().r.resuming, false);
  assert.match(f.feature.status().r.message, /tự bật lại \(1\/3\)/);
  f.feature.documentReplaced({ run: { id: 'r' } });
  f.feature.stop('r', null, 'USER');
  assert.equal(f.feature.status().r, undefined);
});

test('R3: at most 3 resumes per 10 minutes, then off for good; the key losing its right is never resumed', async () => {
  const f = fixture({ resumeDelayMs: 0 });
  f.feature.start('r');
  for (let i = 1; i <= 3; i++) { f.feature.documentReplaced({ run: { id: 'r' } }); f.time(i); await f.feature.tick(); }
  assert.equal(f.feature.status().r.stats.resumed, 3);
  f.feature.documentReplaced({ run: { id: 'r' } });
  assert.equal(f.feature.status().r.on, false);
  assert.match(f.feature.status().r.message, /tắt hẳn/);
  let ok = true;
  const g = fixture({ resumeDelayMs: 0, licensed: () => ok });
  g.feature.start('r'); ok = false;
  await g.feature.tick();
  assert.equal(g.feature.status().r.on, false);
});

test('R3: not back at the table within resumeWaitMs → off for good', async () => {
  const f = fixture({ resumeDelayMs: 0, resumeWaitMs: 100 });
  f.feature.start('r');
  f.feature.stop('r', 'x', 'PROBE_STALL');
  f.time(150); await f.feature.tick();
  assert.equal(f.feature.status().r.on, false);
  assert.match(f.feature.status().r.message, /không về bàn/);
});

test('R4: presses and rounds are counted per account', async () => {
  const f = fixture();
  f.feature.start('r');
  await f.feature.tick(); f.time(20); await f.feature.tick();
  assert.deepEqual({ ...f.feature.status().r.stats, stops: 0 }, { rounds: 1, presses: 1, stops: 0, resumed: 0 });
});
