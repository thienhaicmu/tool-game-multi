// ẨN DANH switch — the page script (an-danh.cjs) run in a vm against a fake Cocos runtime shaped like the game's
// own JS (GameConfigManager.getInstance().isAnDanh + table controllers with isGameAnDanhCheck), plus wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const ad = require('../../desktop/protocol/phom/an-danh.cjs');

function fakeGame() {
  const cfg = { isAnDanh: true };
  const calls = [];
  const table = { setGameId: (real) => calls.push(['setGameId', real]) };
  const ctrl = { isGameAnDanh: true, isGameAnDanhCheck: true, cardGameTableController: table, showHideuserAnDanh4: (v) => calls.push(['fake4', v]) };
  const scene = { _components: [], children: [{ _components: [{ other: 1 }, ctrl], children: [] }] };
  const timers = [];
  const ctx = {
    __require: (name) => { if (name !== 'GameConfigManager') throw new Error('no ' + name); return { default: { getInstance: () => cfg } }; },
    cc: { director: { getScene: () => scene } },
    setInterval: (fn) => { timers.push(fn); return timers.length; },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, cfg, ctrl, calls, tick: () => timers.forEach((f) => f()), timers };
}
const run = (g, on) => vm.runInContext(ad.buildAnDanhScript(on), g.ctx);

test('OFF forces the config flag false and un-hides the live table (real id, no fake 4th player)', () => {
  const g = fakeGame();
  const r = run(g, false);
  assert.deepEqual({ ...r }, { want: false, managers: 1, changed: 1, controllers: 1 });
  assert.equal(g.cfg.isAnDanh, false);
  assert.equal(g.ctrl.isGameAnDanh, false);
  assert.equal(g.ctrl.isGameAnDanhCheck, false);
  assert.deepEqual(g.calls, [['fake4', false], ['setGameId', true]]);
});

test('the game re-setting the flag (config load) is overwritten again by the keep-alive loop', () => {
  const g = fakeGame();
  run(g, false);
  g.cfg.isAnDanh = true;
  g.tick();
  assert.equal(g.cfg.isAnDanh, false);
});

test('ON sets the config flag only — a live hand is never flipped into anonymous mode', () => {
  const g = fakeGame();
  run(g, false);
  g.ctrl.isGameAnDanhCheck = false;
  const r = run(g, true);
  assert.equal(r.controllers, 0);
  assert.equal(g.cfg.isAnDanh, true);
  assert.equal(g.ctrl.isGameAnDanhCheck, false);
  assert.equal(g.timers.length, 1, 'installed once per document');
});

test('before the game bundle loads (no __require / cc) the script is a no-op that keeps trying', () => {
  const ctx = { setInterval: () => 1 }; ctx.globalThis = ctx; vm.createContext(ctx);
  const r = vm.runInContext(ad.buildAnDanhScript(false), ctx);
  assert.deepEqual({ ...r }, { want: false, managers: 0, changed: 0, controllers: 0 });
});

test('applyAnDanh replaces the new-document script so a reload gets the current value', async () => {
  const added = [], removed = [], evals = [];
  let n = 0;
  const client = {
    Page: { addScriptToEvaluateOnNewDocument: async ({ source }) => { added.push(source); return { identifier: 'id' + (++n) }; }, removeScriptToEvaluateOnNewDocument: async ({ identifier }) => { removed.push(identifier); } },
    Runtime: { evaluate: async ({ expression }) => { evals.push(expression); return { result: { value: { want: true } } }; } },
  };
  assert.equal((await ad.applyAnDanh(client, false)).ok, true);
  await ad.applyAnDanh(client, true);
  assert.equal(added.length, 2);
  assert.deepEqual(removed, ['id1']);
  assert.match(added[1], /want: true/);
  assert.equal(evals.length, 2);
});

test('wiring: main defaults OFF, applies on attach, IPC get/set; preload + tool switch', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /let anDanhOn = false/);
  assert.match(main, /anDanh\.applyAnDanh\(client, anDanhOn\)/);
  assert.match(main, /'phom:an-danh-set'/);
  assert.match(main, /'phom:an-danh-get'/);
  const pre = read('desktop/phom-preload.cjs');
  assert.match(pre, /setAnDanh:/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /id: 'phq-andanh'/);
  assert.match(ui, /let anDanhOn = false/);
});
