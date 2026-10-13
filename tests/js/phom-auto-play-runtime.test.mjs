import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAutoPlayFeature, humanPause, PAUSE_MS } = require('../../desktop/phom/features/auto-play.cjs');
import { replay } from '../../tools/phom-auto-play-replay.mjs';

const { decodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');
const cardOf = (label) => [...Array(52).keys()].find((x) => decodeCard(x).label === label);

// probeFor(rid) → what the page answers to the offered-buttons probe; actFor(press, n) → the press result
function fixture({ probeFor = null, actFor = null, offered = ['DANH'], ...extra } = {}) {
  let time = 0;
  const calls = [];
  const logs = [];
  const snap = { roundSeq: 1, roundPlayers: ['me', 'other'], nextOf: { me: 'other' },
    players: { me: { uid: 'me', currentCards: [35, 50], melds: [], discardedHistory: [], drawnHistory: [], sentCards: [] },
      other: { uid: 'other', currentCards: [], melds: [] } }, eats: [], observedDiscardEvents: [], ledger: [] };
  const timers = new Map();
  let timerId = 0;
  const feature = createAutoPlayFeature({ snapshot: () => snap, uidOf: () => 'me',
    clientFor: (rid) => ({ Runtime: { evaluate: async () => ({ result: { value: probeFor ? await probeFor(rid) : { ok: true, atTable: true, offered } } }) } }),
    act: async (rid, input, view) => { calls.push({ rid, ...input, view }); return actFor ? actFor(input, calls.length) : { ok: true }; },
    log: (ev, d) => logs.push({ ev, ...d }),
    now: () => time, setTimer: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimer: (id) => timers.delete(id),
    pauseMs: { DEFAULT: [10, 10] }, stallMs: 100, refuseMs: 100, ...extra });
  return { feature, snap, calls, logs, timers, time: (t) => { time = t; } };
}
// tick at each time in turn
const run = async (f, ...times) => { for (const t of times) { f.time(t); await f.feature.tick(); } };

test('a press stays in flight until the account\'s OWN history shows it; other table updates never confirm it', async () => {
  const f = fixture();
  f.feature.start('r');
  await run(f, 0, 20);
  assert.equal(f.calls.length, 1);
  f.snap.players.other.melds.push({ meid: 2, cards: [0, 4, 8] });
  await run(f, 40);
  assert.equal(f.calls.length, 1, 'not pressed again');
  assert.equal(f.feature.status().r.resuming, false);
  assert.ok(!f.logs.some((l) => l.ev === 'auto-play-confirmed'));
});

// Meta Game ede6239 — NEVER RUN OUT THE GAME'S CLOCK
test('the game still shows the pressed button after refuseMs → refused: Đánh tries another card; pressRetries refusals stop it (armed)', async () => {
  const f = fixture();
  f.feature.start('r');
  await run(f, 0, 20, 130, 150);
  assert.equal(f.calls.length, 2);
  assert.notDeepEqual(f.calls[1].cards, f.calls[0].cards, 'the refused card is not pressed again');
  assert.ok(f.logs.some((l) => l.ev === 'auto-play-refused' && l.action === 'DANH'));

  const g = fixture({ offered: ['BOC'] }); // a Bốc the game never takes
  g.feature.start('r');
  await run(g, 0, 20, 130, 150, 260, 280, 390);
  assert.equal(g.calls.length, 3, 'pressed again twice');
  assert.equal(g.feature.status().r.resuming, true, 'then stopped — armed to resume');
  assert.ok(g.logs.some((l) => l.ev === 'auto-play' && l.code === 'NOT_TAKEN'));
});

test('the button gone but the history silent for stallMs → the game\'s own hand counts for the rest of the round', async () => {
  let shown = { ok: true, atTable: true, offered: ['DANH'], hand: [35, 50] };
  const f = fixture({ probeFor: () => shown });
  f.feature.start('r');
  await run(f, 0, 20);
  assert.equal(f.calls.length, 1);
  shown = { ok: true, atTable: true, offered: [], hand: [35, 7] }; // the game took it; no frame ever showed it
  await run(f, 60, 130);
  assert.ok(f.logs.some((l) => l.ev === 'auto-play-unconfirmed'));
  assert.equal(f.feature.status().r.resuming, false, 'no stop');
  shown = { ok: true, atTable: true, offered: ['DANH'], hand: [35, 7] };
  await run(f, 200, 220);
  assert.equal(f.calls.length, 2);
  assert.ok([35, 7].includes(f.calls[1].cards[0]), 'chosen from the game\'s hand, not the stale 50');
  assert.equal(f.logs.filter((l) => l.ev === 'auto-play-decision').at(-1).hand, 'GAME');
});

test('a missed deal (the frames never showed the hand): Bốc anyway, then Đánh from the game\'s own hand', async () => {
  let shown = { ok: true, atTable: true, offered: ['BOC'], hand: [35, 50] };
  const f = fixture({ probeFor: () => shown });
  f.snap.players.me.currentCards = [];
  f.feature.start('r');
  await run(f, 0, 20);
  assert.equal(f.calls[0].action, 'BOC');
  f.snap.players.me.drawnHistory.push(9);
  shown = { ok: true, atTable: true, offered: ['DANH'], hand: [35, 50, 9] };
  await run(f, 40, 60, 80);
  assert.equal(f.calls[1].action, 'DANH');
  assert.ok([35, 50, 9].includes(f.calls[1].cards[0]));
  assert.ok(f.calls[1].view && f.calls[1].view !== f.snap, 'the press is checked against the picture it was chosen from');
});

test('"not in the hand" from the game → its own hand is used and the turn goes on; a page timeout waits like a press', async () => {
  const f = fixture({
    probeFor: () => ({ ok: true, atTable: true, offered: ['DANH'], hand: [35] }),
    actFor: (p, n) => (n === 1 ? { ok: false, error: { code: 'PHOM_PLAY_CARD_NOT_IN_HAND', message: 'Có lá đã chọn không còn trên tay' } } : { ok: true }),
  });
  f.snap.players.me.currentCards = [50, 51]; // the frames' hand is stale
  f.snap.ledger = [{ code: 50, status: 'CURRENT', ownerUid: 'me' }, { code: 51, status: 'CURRENT', ownerUid: 'me' }];
  f.feature.start('r');
  await run(f, 0, 20, 40, 60);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].cards, [35]);
  assert.equal(f.feature.status().r.resuming, false);

  const g = fixture({ actFor: (p, n) => (n === 1 ? { ok: false, error: { code: 'PHOM_PLAY_TIMEOUT', message: 'Trình duyệt không trả lời khi bấm DANH' } } : { ok: true }) });
  g.feature.start('r');
  await run(g, 0, 20);
  g.snap.players.me.discardedHistory.push(50); g.snap.players.me.currentCards = [35]; // it did go through
  await run(g, 40);
  assert.ok(g.logs.some((l) => l.ev === 'auto-play-confirmed' && l.action === 'DANH'));
  assert.equal(g.calls.length, 1, 'never pressed twice');
  assert.equal(g.feature.status().r.resuming, false);
});

test('HẠN LƯỢT: once the turn is turnForceMs old a wait becomes the step the buttons allow; from hurryMs the pause is short', async () => {
  const f = fixture({ pauseMs: { DEFAULT: [800, 800] }, fallbackMs: 1e9, waitStallMs: 1e9, turnForceMs: 1100, hurryMs: 1000, hurryPauseMs: 50 });
  const meld = ['5♥', '6♥', '7♥'].map(cardOf);
  f.snap.players.me.currentCards = [cardOf('8♥'), cardOf('K♣'), ...meld];
  f.snap.players.me.melds = [{ meid: 1, cards: meld }];
  f.snap.players.me.discardedHistory = [cardOf('2♠'), cardOf('3♠'), cardOf('4♠')];
  f.snap.ledger = [cardOf('8♥'), cardOf('K♣')].map((code) => ({ code, status: 'CURRENT', ownerUid: 'me' }));
  f.feature.start('r');
  await run(f, 0, 600, 1050);
  assert.equal(f.calls.length, 0, 'waiting for Gửi');
  await run(f, 1100, 1160);
  assert.equal(f.calls.length, 1, 'the turn ran long: Đánh after the short pause');
  assert.equal(f.calls[0].action, 'DANH');
  assert.equal(f.logs.find((e) => e.ev === 'auto-play-decision').fallback, true);
});

test('every account on its own clock: a browser answering in 300 ms never slows another (real timers)', async () => {
  let fast = 0;
  const f = fixture({
    tickMs: 10, now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
    probeFor: async (rid) => {
      if (rid === 'slow') { await new Promise((r) => setTimeout(r, 300)); return { ok: true, atTable: true, offered: [] }; }
      fast++;
      return { ok: true, atTable: true, offered: [] };
    },
  });
  f.feature.start('slow'); f.feature.start('fast');
  await new Promise((r) => setTimeout(r, 250));
  f.feature.stop('slow', null, 'USER'); f.feature.stop('fast', null, 'USER');
  assert.ok(fast >= 8, `the fast account was read ${fast} times in 250 ms`);
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

test('R1: each press waits a human pause by its button (user 2026-10-13): Đánh 1.5–4 s — random 0.5 → 2583 ms, logged', async () => {
  const f = fixture({ pauseMs: PAUSE_MS, random: () => 0.5 }); // x = 0.35 + 0 + (−ln 0.5)·0.12 = 0.4332 → 1500 + 0.4332·2500
  f.feature.start('r');
  await f.feature.tick();
  f.time(2580); await f.feature.tick();
  assert.equal(f.calls.length, 0);
  f.time(2590); await f.feature.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.logs.find((l) => l.ev === 'auto-play-decision').pauseMs, 2583);
});

test('R1: the human pause per button — the user\'s ranges, right-skewed, sometimes a long think, never outside the range', () => {
  assert.deepEqual([PAUSE_MS.BOC, PAUSE_MS.DANH, PAUSE_MS.HA], [[500, 1200], [1500, 4000], [2000, 5000]]);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; // deterministic
  for (const action of ['BOC', 'AN', 'DANH', 'HA', 'GUI', 'BAO_U']) {
    const [min, max] = PAUSE_MS[action];
    const xs = Array.from({ length: 4000 }, () => humanPause(action, rnd)).sort((a, b) => a - b);
    assert.ok(xs[0] >= min && xs[xs.length - 1] <= max, `${action} stays in ${min}–${max}`);
    const at = (q) => (xs[Math.floor(q * xs.length)] - min) / (max - min);
    assert.ok(at(0.5) > 0.3 && at(0.5) < 0.5, `${action}: the median sits in the lower middle (${at(0.5).toFixed(2)})`);
    assert.ok(at(0.97) > 0.75, `${action}: a long right tail / long thinks reach the top (${at(0.97).toFixed(2)})`);
    assert.ok(at(0.02) < 0.2, `${action}: some quick presses too (${at(0.02).toFixed(2)})`);
  }
  // Bốc is always quicker than the slowest Đánh, Hạ the slowest kind
  assert.ok(humanPause('BOC', () => 0.999) < humanPause('DANH', () => 0.001));
  assert.equal(humanPause('XYZ', () => 0.5, { DEFAULT: [10, 10] }), 10, 'a fixed range is that value');
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

test('VÒNG: while the loop runs there is no resume limit and no deadline; the wait grows 3 s → 10 s → 30 s → 1 min', async () => {
  const f = fixture({ unlimited: () => true });
  f.feature.start('r');
  let t = 0;
  const waits = [];
  for (let i = 0; i < 6; i++) {
    f.feature.documentReplaced({ run: { id: 'r' } });
    const since = t;
    while (f.feature.status().r.resuming) { t += 500; f.time(t); await f.feature.tick(); }
    waits.push(t - since);
  }
  assert.deepEqual(waits.map((w) => Math.round(w / 1000)), [3, 10, 30, 60, 60, 60]);
  assert.equal(f.feature.status().r.stats.resumed, 6);
  f.feature.documentReplaced({ run: { id: 'r' } });
  t += 10 * 60000; f.time(t); await f.feature.tick(); // not back for 10 min: still armed, then resumes once at the table
  assert.equal(f.feature.status().r.on, true);
});
