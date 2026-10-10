// VÒNG TỰ ĐÁNH (desktop/phom/features/loop.cjs): one switch, a closed loop that never stops by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoopFeature } = require('../../desktop/phom/features/loop.cjs');

function fixture({ stake = 100, slots, reserves = [], licensed = true } = {}) {
  let time = 1000;
  const calls = [];
  const facts = { formed: false, auto: false, busy: null, recreating: false, keySeated: false, roundRunning: false, players: 0, strangerSeated: false, strangerReady: false };
  const state = { licensed, auto: false, ap: {} };
  const slotList = slots || [{ slot: 'A', runId: 'r1', state: 'OPEN', money: 1000 }, { slot: 'B', runId: 'r2', state: 'OPEN', money: 1000 }, { slot: 'C', runId: 'r3', state: 'OPEN', money: 1000 }];
  const group = {
    autoActive: () => state.auto,
    setAuto: (on, opts) => { calls.push(['setAuto', on, opts]); state.auto = on; return { ok: true }; },
    selectedStake: () => stake,
    loopFacts: () => ({ ...facts }),
    regroupNow: (reason) => { calls.push(['regroup', reason]); return { ok: true }; },
    leaveAll: () => { calls.push(['leaveAll']); state.auto = false; facts.formed = false; facts.keySeated = false; },
  };
  const autoPlay = {
    start: (rid) => { calls.push(['apStart', rid]); state.ap[rid] = { on: true }; return { ok: true }; },
    stop: (rid, m, code) => { calls.push(['apStop', rid, code]); state.ap[rid] = { on: false }; return { ok: true }; },
    status: () => state.ap,
  };
  const bells = [];
  const loop = createLoopFeature({
    licensed: () => state.licensed, group, autoPlay, slots: () => slotList, reserves: () => reserves,
    swapSlot: async (slot, reserve) => { calls.push(['swap', slot, reserve]); return { ok: true }; },
    reopenSlot: async (slot) => { calls.push(['reopen', slot]); return { ok: true }; },
    bell: (m) => bells.push(m), now: () => time, setTimer: () => 0, clearTimer: () => {},
  });
  const at = async (t) => { time = t; await loop.tick(); };
  const count = (name) => calls.filter((c) => c[0] === name).length;
  return { loop, facts, state, calls, bells, at, count, slotList };
}
const MIN = 60000;

test('one switch: Tự đánh on for every playing account, TỰ ĐỘNG on with the stake; refused without a stake', async () => {
  const f = fixture();
  assert.equal(f.loop.start().ok, true);
  await f.at(2000);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'apStart').map((c) => c[1]), ['r1', 'r2', 'r3']);
  assert.deepEqual(f.calls.find((c) => c[0] === 'setAuto'), ['setAuto', true, { stake: 100 }]);
  const g = fixture({ stake: null });
  assert.equal(g.loop.start().ok, false);
});

test('TỰ ĐỘNG going off is switched on again, slower each time (3 s → 10 s → 30 s → 1 min), never left off', async () => {
  const f = fixture();
  f.loop.start(); await f.at(1000);          // first setAuto
  f.state.auto = false; await f.at(2000);    // < 3 s later: waits
  assert.equal(f.count('setAuto'), 1);
  await f.at(4100); assert.equal(f.count('setAuto'), 2);
  f.state.auto = false; await f.at(10000); assert.equal(f.count('setAuto'), 2);
  await f.at(14200); assert.equal(f.count('setAuto'), 3);
});

test('no stranger ready for 3 min → the group searches again; after 3 such tables → rest 5 min (leave all, bell), then on again', async () => {
  const f = fixture();
  f.loop.start(); await f.at(1000);
  Object.assign(f.facts, { formed: true, keySeated: true, players: 3 });
  let t = 2000;
  for (let i = 1; i <= 3; i++) {
    await f.at(t); t += 3 * MIN + 1; await f.at(t);
    assert.equal(f.count('regroup'), i);
    t += 1000;
  }
  await f.at(t); t += 3 * MIN + 1; await f.at(t);
  assert.equal(f.count('leaveAll'), 1);
  assert.equal(f.bells.length, 1);
  assert.equal(f.loop.status().resting, true);
  await f.at(t + 4 * MIN); assert.equal(f.count('setAuto'), 1, 'resting');
  await f.at(t + 5 * MIN + 10); assert.equal(f.count('setAuto'), 2, 'back on after the rest');
  assert.equal(f.loop.status().on, true);
});

test('a stranger seated but never ready counts as no stranger; a round resets every counter', async () => {
  const f = fixture();
  f.loop.start(); await f.at(1000);
  Object.assign(f.facts, { formed: true, keySeated: true, players: 4, strangerSeated: true, strangerReady: false });
  await f.at(2000); await f.at(2000 + 3 * MIN + 1);
  assert.equal(f.count('regroup'), 1);
  f.facts.roundRunning = true; await f.at(4 * MIN);
  assert.equal(f.loop.status().stats.rounds, 1);
  assert.match(f.loop.status().message, /Đang đánh/);
});

test('stuck 5 min (searching, a ready stranger but no round) → everyone leaves and it starts again', async () => {
  const f = fixture();
  f.loop.start(); await f.at(1000);
  Object.assign(f.facts, { formed: true, keySeated: true, players: 4, strangerSeated: true, strangerReady: true });
  await f.at(2000); await f.at(2000 + 5 * MIN);
  assert.equal(f.count('leaveAll'), 1);
  assert.equal(f.loop.status().on, true);
});

test('a CRASHED browser reopens (after the grace for main\'s own reserve swap); closed by the user with no reserve → left out', async () => {
  const f = fixture({ slots: [{ slot: 'A', runId: 'r1', state: 'CRASHED' }, { slot: 'B', runId: 'r2', state: 'CLOSED_BY_USER' }, { slot: 'C', runId: 'r3', state: 'OPEN', money: 1000 }] });
  f.loop.start(); await f.at(1000);
  assert.equal(f.count('reopen'), 0, 'grace');
  await f.at(12000);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'reopen'), [['reopen', 'A']]);
  await f.at(13000); assert.equal(f.count('reopen'), 1, 'backoff');
  assert.equal(f.count('swap'), 0);
});

test('closed by the user → an open reserve takes the slot (after the grace for the swap main does itself)', async () => {
  const f = fixture({ slots: [{ slot: 'A', runId: 'r1', state: 'CLOSED_BY_USER' }, { slot: 'B', runId: 'r2', state: 'OPEN', money: 1000 }, { slot: 'C', runId: 'r3', state: 'OPEN', money: 1000 }],
    reserves: [{ reserve: 'D', runId: 'r4', state: 'OPEN', money: 900 }] });
  f.loop.start(); await f.at(1000);
  assert.equal(f.count('swap'), 0, 'grace');
  await f.at(12000);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'swap'), [['swap', 'A', 'D']]);
  assert.equal(f.count('reopen'), 0);
});

test('no money for the stake → a reserve with money takes the slot, but never in the middle of a round', async () => {
  const f = fixture({ slots: [{ slot: 'A', runId: 'r1', state: 'OPEN', money: 1000 }, { slot: 'B', runId: 'r2', state: 'OPEN', money: 50 }, { slot: 'C', runId: 'r3', state: 'OPEN', money: 1000 }],
    reserves: [{ reserve: 'D', runId: 'r4', state: 'OPEN', money: 20 }, { reserve: 'E', runId: 'r5', state: 'OPEN', money: 900 }] });
  f.facts.roundRunning = true;
  f.loop.start(); await f.at(1000);
  assert.equal(f.count('swap'), 0, 'mid-round');
  f.facts.roundRunning = false; await f.at(2000);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'swap'), [['swap', 'B', 'E']], 'D has no money either');
});

test('it stops only when switched off or the key loses the right — Tự đánh + TỰ ĐỘNG off, seats kept', async () => {
  const f = fixture();
  f.loop.start(); await f.at(1000);
  f.loop.stop(null, 'USER');
  assert.deepEqual(f.calls.filter((c) => c[0] === 'apStop').map((c) => c[2]), ['USER', 'USER', 'USER']);
  assert.deepEqual(f.calls.at(-1), ['setAuto', false, undefined]);
  assert.equal(f.count('leaveAll'), 0);
  const g = fixture();
  g.loop.start(); await g.at(1000);
  g.state.licensed = false; await g.at(3000);
  assert.equal(g.loop.status().on, false);
  assert.match(g.loop.status().message, /quyền Tự đánh/);
  assert.equal(g.loop.start().ok, false);
});

test('wiring: main builds the loop over TỰ ĐỘNG + Tự đánh (unlimited while on), one IPC, the UI shows one switch and no hand buttons', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /unlimited: \(\) => !!\(_loopFeature && _loopFeature\.active\(\)\)/);
  assert.match(main, /_loopFeature = createLoopFeature\(\{/);
  assert.match(main, /reopenSlot: \(slot\) => replaceSlot\(slot, null\)/);
  assert.match(main, /_loopFeature\.registerIpc\(/);
  assert.match(main, /loop: _loopFeature \? _loopFeature\.status\(\) : null/);
  assert.match(read('desktop/phom-preload.cjs'), /setLoop: \(on\) => ipcRenderer\.invoke\('phom:loop', \{ on: !!on \}\)/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /onchange: \(e\) => onLoopToggle\(e\.target\.checked\)/);
  for (const gone of ["btn('BOC'", "btn('DANH'", "btn('HA'", "btn('GUI'", "btn('BAO_U'", 'function autoPlaySwitch', "id: 'phq-auto',"]) assert.ok(!ui.includes(gone), gone + ' is gone from the UI');
  assert.match(ui, /await stopLoop\(\); \/\/ the loop would reopen them/);
  // user 2026-10-10: Nuôi ít tiền + cạ ù sit in the bottom bar next to TỰ ĐÁNH (not hidden)
  const footer = ui.slice(ui.indexOf('function controlFooter'), ui.indexOf('function autoStakes'));
  assert.match(footer, /strategyControls\(\)/);
  assert.match(ui, /item\('lowMoney', 'Nuôi ít tiền'/);
  assert.match(ui, /item\('twoPhomCaU', 'Ưu tiên 2 phỏm \+ cạ ù'/);
});
