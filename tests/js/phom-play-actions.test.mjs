// 3.2 phase 5 — Bốc / Ăn / Đánh / Hạ / Gửi pressed from the tool: the game's OWN button handler (PhomController.onBtn…),
// only while the game offers that button; one click = one action; the tool never sends a play frame or picks a move.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ACTIONS, validatePlayAction, buildPlayActionScript } = require('../../desktop/protocol/phom/play-actions.cjs');
const { createPlayActionsFeature } = require('../../desktop/phom/features/play-actions.cjs');
const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

// a fake Cocos page: one PhomController with its buttons + hand (the shapes read from the game bundle 2026-10-09)
function page({ atTable = true, offered = ['btnRutBai', 'btnDanhBai'], interactable = true, hand = [5, 17, 40] } = {}) {
  const calls = [];
  const selected = [];
  const Button = function Button() {};
  const btn = (name) => ({ activeInHierarchy: offered.includes(name), getComponent: (T) => (T === Button ? { interactable } : null) });
  const ctrl = {
    myCardSet: { getListCardID: () => hand.slice(), setListCardSelected: (l) => { selected.push(...l); calls.push(['select', [...l]]); } }, // [...l]: a test-realm array
  };
  for (const a of Object.values(ACTIONS)) { ctrl[a.btn] = btn(a.btn); ctrl[a.handler] = () => calls.push([a.handler]); }
  const cc = { Button, director: { getScene: () => ({ getComponentInChildren: (n) => (atTable && n === 'PhomController' ? ctrl : null) }) } };
  const ctx = vm.createContext({ window: { cc } });
  return { run: (action, card = null) => vm.runInContext(buildPlayActionScript({ action, card }), ctx), calls, selected };
}

test('the five actions map to the game\'s own buttons and handlers', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, [v.btn, v.handler]])), {
    BOC: ['btnRutBai', 'onBtnRutBai'], AN: ['btnAnBai', 'onBtnAnBai'], DANH: ['btnDanhBai', 'onBtnDanhBai'], HA: ['btnHaPhom', 'onBtnHaPhom'], GUI: ['btnGuiBai', 'onBtnGuiBai'],
  });
});

test('pressed ONLY while the game offers the button; otherwise refused and nothing runs', () => {
  const p = page({ offered: ['btnRutBai'] });
  assert.equal(p.run('BOC').ok, true);
  assert.deepEqual(p.calls, [['onBtnRutBai']]);
  const r = p.run('AN');
  assert.deepEqual([r.ok, r.code], [false, 'PHOM_PLAY_NOT_OFFERED']);
  assert.match(r.message, /Game chưa cho Ăn/);
  assert.equal(p.calls.length, 1, 'the Ăn handler never ran');
  const off = page({ offered: ['btnRutBai'], interactable: false });
  assert.equal(off.run('BOC').code, 'PHOM_PLAY_NOT_OFFERED', 'a shown but disabled button is not offered either');
  assert.equal(off.calls.length, 0);
});

test('not at a Phỏm table (lobby / login scene) → refused', () => {
  const p = page({ atTable: false });
  assert.equal(p.run('BOC').code, 'PHOM_PLAY_NOT_AT_TABLE');
  const bare = vm.createContext({ window: {} });
  assert.equal(vm.runInContext(buildPlayActionScript({ action: 'BOC' }), bare).code, 'PHOM_PLAY_NOT_AT_TABLE');
});

test('Đánh with a card from the tool: that card is selected with the hand\'s own method, then the game\'s Đánh runs', () => {
  const p = page();
  assert.equal(p.run('DANH', 17).ok, true);
  assert.deepEqual(p.calls, [['select', [17]], ['onBtnDanhBai']]);
  const gone = page();
  const r = gone.run('DANH', 33);
  assert.deepEqual([r.ok, r.code], [false, 'PHOM_PLAY_CARD_NOT_IN_HAND']);
  assert.equal(gone.calls.length, 0);
  const own = page();
  assert.equal(own.run('DANH').ok, true, 'no card from the tool → the game\'s own selection');
  assert.deepEqual(own.calls, [['onBtnDanhBai']]);
});

test('validation: unknown action, a card where none is taken, a card that is not a card', () => {
  assert.equal(validatePlayAction({ action: 'NOPE' }).error.code, 'PHOM_PLAY_UNKNOWN');
  assert.equal(validatePlayAction({ action: 'BOC', card: 3 }).error.code, 'PHOM_PLAY_NO_CARD');
  assert.equal(validatePlayAction({ action: 'DANH', card: 52 }).error.code, 'PHOM_PLAY_BAD_CARD');
  assert.deepEqual(validatePlayAction({ action: 'danh', card: '7' }), { ok: true, action: 'DANH', card: 7 });
});

test('the page script never sends anything itself and never chooses a card', () => {
  for (const a of Object.keys(ACTIONS)) {
    const src = buildPlayActionScript({ action: a });
    assert.equal(/sendData|WebSocket|\.send\(|requestPlayCard|requestDrawCard|getCardSelected|recommended/.test(src), false, a);
  }
});

test('feature: one action in flight per browser; no client / feature off refused; every press logged', async () => {
  let release;
  const logs = [];
  const client = { Runtime: { evaluate: () => new Promise((r) => { release = () => r({ result: { value: { ok: true, code: 'PHOM_PLAY_PRESSED' } } }); }) } };
  const f = createPlayActionsFeature({ clientFor: (rid) => (rid === 'BR-1' ? client : null), log: (e, d) => logs.push([e, d]) });
  const first = f.act('BR-1', { action: 'BOC' });
  assert.equal((await f.act('BR-1', { action: 'BOC' })).error.code, 'PHOM_PLAY_BUSY', 'a double click sends once');
  release();
  assert.deepEqual(await first, { ok: true, action: 'BOC' });
  assert.equal((await f.act('BR-2', { action: 'BOC' })).error.code, 'PHOM_PLAY_NO_CLIENT');
  assert.deepEqual(logs, [['play-action', { runId: 'BR-1', action: 'BOC', card: null, ok: true, code: 'PHOM_PLAY_PRESSED' }]]);
  const ipc = {};
  f.registerIpc((ch, fn, opts) => { ipc[ch] = { fn, guarded: !!(opts && opts.guarded) }; }, { enabled: false });
  assert.equal(ipc['phom:play-action'].guarded, true, 'needs the license like every action');
  assert.equal((await ipc['phom:play-action'].fn(null, { runId: 'BR-1', action: 'BOC' })).error.code, 'PHOM_FEATURE_OFF');
});

test('wiring: main builds the feature, the preload bridges it, each account tab has the five buttons + card pick', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /createPlayActionsFeature\(\{ clientFor: runClientFor, log: headerLog \}\)/);
  assert.match(read('desktop/phom-preload.cjs'), /playAction: \(runId, action, card\) => ipcRenderer\.invoke\('phom:play-action', \{ runId, action, card: card == null \? null : card \}\)/);
  const ui = read('ui-phom/phom-qa.js');
  const bar = ui.slice(ui.indexOf('function playBar('), ui.indexOf('async function onPlayAction('));
  for (const [a, label] of [['BOC', 'Bốc'], ['AN', 'Ăn'], ['DANH', null], ['HA', 'Hạ'], ['GUI', 'Gửi']]) assert.match(bar, new RegExp("btn\\('" + a + "', " + (label ? "'" + label + "'" : '')), a);
  assert.match(ui, /if \(runId\) box\.appendChild\(playBar\(runId, a\)\);/);
  assert.match(ui, /onclick: runId \? \(\) => \{ playPick = picked \?/);
  assert.ok(read('ui-phom/phom-qa.css').includes('.card-face.picked'));
});
