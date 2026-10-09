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
  return { run: (action, cards = []) => vm.runInContext(buildPlayActionScript({ action, cards }), ctx), calls, selected };
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

test('picked cards are selected with the hand\'s own method, then the game\'s button runs (Đánh one, Hạ / Gửi many)', () => {
  const p = page();
  assert.equal(p.run('DANH', [17]).ok, true);
  assert.deepEqual(p.calls, [['select', [17]], ['onBtnDanhBai']]);
  const ha = page({ offered: ['btnHaPhom'] });
  assert.equal(ha.run('HA', [5, 17, 40]).ok, true);
  assert.deepEqual(ha.calls, [['select', [5, 17, 40]], ['onBtnHaPhom']]);
  const gone = page();
  const r = gone.run('DANH', [33]);
  assert.deepEqual([r.ok, r.code], [false, 'PHOM_PLAY_CARD_NOT_IN_HAND']);
  assert.equal(gone.calls.length, 0, 'nothing selected, nothing pressed');
  const own = page();
  assert.equal(own.run('DANH').ok, true, 'none picked → the game\'s own selection');
  assert.deepEqual(own.calls, [['onBtnDanhBai']]);
});

test('validation: unknown action, cards where none are taken, too many / bad / repeated cards', () => {
  assert.equal(validatePlayAction({ action: 'NOPE' }).error.code, 'PHOM_PLAY_UNKNOWN');
  assert.equal(validatePlayAction({ action: 'BOC', cards: [3] }).error.code, 'PHOM_PLAY_NO_CARD');
  assert.equal(validatePlayAction({ action: 'DANH', cards: [3, 4] }).error.code, 'PHOM_PLAY_TOO_MANY');
  assert.equal(validatePlayAction({ action: 'HA', cards: [52] }).error.code, 'PHOM_PLAY_BAD_CARD');
  assert.equal(validatePlayAction({ action: 'GUI', cards: [7, 7] }).error.code, 'PHOM_PLAY_BAD_CARD');
  assert.deepEqual(validatePlayAction({ action: 'danh', cards: ['7'] }), { ok: true, action: 'DANH', cards: [7] });
  assert.deepEqual(validatePlayAction({ action: 'ha' }), { ok: true, action: 'HA', cards: [] });
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
  assert.deepEqual(logs, [['play-action', { runId: 'BR-1', action: 'BOC', cards: 0, ok: true, code: 'PHOM_PLAY_PRESSED' }]]);
  const ipc = {};
  f.registerIpc((ch, fn, opts) => { ipc[ch] = { fn, guarded: !!(opts && opts.guarded) }; }, { enabled: false });
  assert.equal(ipc['phom:play-action'].guarded, true, 'needs the license like every action');
  assert.equal((await ipc['phom:play-action'].fn(null, { runId: 'BR-1', action: 'BOC' })).error.code, 'PHOM_FEATURE_OFF');
});

test('wiring: main builds the feature, the preload bridges it; ĐÁNH BÀI is its own tab (LỌC BÀI stays read-only)', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /createPlayActionsFeature\(\{ clientFor: runClientFor, log: headerLog \}\)/);
  assert.match(read('desktop/phom-preload.cjs'), /playAction: \(runId, action, cards\) => ipcRenderer\.invoke\('phom:play-action', \{ runId, action, cards: Array\.isArray\(cards\) \? cards : \[\] \}\)/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /tab\('SETUP', 'Profile'\), tab\('PHOM', 'Phỏm'\), tab\('PLAY', 'Đánh bài'\)/);
  assert.match(ui, /else if \(activeTab === 'PLAY'\) renderPlay\(content\);/);
  const bar = ui.slice(ui.indexOf('function playBar('), ui.indexOf('async function onPlayAction('));
  for (const a of ['BOC', 'AN', 'DANH', 'HA', 'GUI']) assert.match(bar, new RegExp("btn\\('" + a + "', "), a);
  const lb = ui.slice(ui.indexOf('function safeCardsFor('), ui.indexOf('// ================= ĐÁNH BÀI tab'));
  assert.equal(/playBar|playPick|onclick/.test(lb), false, 'no buttons / picking inside LỌC BÀI');
  const play = ui.slice(ui.indexOf('function renderPlay('), ui.indexOf('function playBar('));
  assert.match(play, /el\('section', \{ class: 'play-panel' \}, tabs, body, runId \? playBar\(runId, picked\) : null\)/, 'the bar is a row of its own, under the hand');
  const css = read('ui-phom/phom-qa.css');
  assert.match(css, /\.play-body \{ flex: 1 1 auto; min-height: 0; overflow: auto;/);
  assert.match(css, /\.play-bar \{ flex: 0 0 auto;/);
});

test('ĐÁNH BÀI: the hand comes from the card snapshot of that slot, sorted, phỏm cards marked', () => {
  const ui = read('ui-phom/phom-qa.js');
  const src = ui.slice(ui.indexOf('function handOf('), ui.indexOf('function renderPlay('));
  const handOf = new Function('cardsSnap', src + '\nreturn handOf;');
  const snap = { slotBinding: { B2: 'u2' }, players: { u2: { currentCardsView: [{ code: 30 }, { code: 4 }, { code: 17 }], serverMeldCards: [4, 17], melds: [] } } };
  const h = handOf(snap)('B2');
  assert.deepEqual(h.cards.map((c) => c.code), [4, 17, 30]);
  assert.deepEqual([...h.meld], [4, 17]);
  assert.equal(handOf(snap)('B1'), null);
});
