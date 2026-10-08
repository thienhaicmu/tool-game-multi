// BỐ CỤC — which quarter each window takes (user 2026-10-05): default P2 | P3 over P1 | Tool, user-chosen and saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wl = require('../../desktop/protocol/phom/window-layout.cjs');
const { arrangeClusterWindows } = require('../../desktop/protocol/phom/grid-layout.cjs');
const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
const arr = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], { gap: 8 });
const at = (r) => (r.x < 900 ? 'L' : 'R') + (r.y < 500 ? 'T' : 'B');

test('default layout: P2 top-left, P3 top-right, P1 bottom-left, Tool bottom-right; reserves behind the tool', () => {
  assert.deepEqual(wl.DEFAULT_LAYOUT, { A: 'BL', B: 'TL', C: 'TR', TOOL: 'BR' });
  const L = wl.DEFAULT_LAYOUT;
  assert.equal(at(wl.rectForItem('B', arr, L)), 'LT');
  assert.equal(at(wl.rectForItem('C', arr, L)), 'RT');
  assert.equal(at(wl.rectForItem('A', arr, L)), 'LB');
  assert.equal(at(wl.rectForItem('TOOL', arr, L)), 'RB');
  assert.deepEqual(wl.rectForItem('D', arr, L), wl.rectForItem('TOOL', arr, L));
});

test('placing an item swaps with the one already there — always one window per quarter; junk → default', () => {
  const l = wl.placeItem(wl.DEFAULT_LAYOUT, 'A', 'TL');           // P1 to top-left → P2 moves to bottom-left
  assert.deepEqual(l, { A: 'TL', B: 'BL', C: 'TR', TOOL: 'BR' });
  const t = wl.placeItem(l, 'TOOL', 'TL');                          // the tool top-left → P1 bottom-right
  assert.deepEqual(t, { A: 'BR', B: 'BL', C: 'TR', TOOL: 'TL' });
  assert.deepEqual(wl.normalizeLayout({ A: 'TL', B: 'TL', C: 'TR', TOOL: 'BR' }), wl.DEFAULT_LAYOUT, 'duplicate quarter');
  assert.deepEqual(wl.normalizeLayout(null), wl.DEFAULT_LAYOUT);
});

test('wiring: windows + tool follow the saved layout; IPC get/set saves and arranges; a Bố cục dialog in the footer', () => {
  const main = read('desktop/phom-main.cjs');
  // the window-frames feature places every window by the layout; its IPC is behaviour-tested in phom-window-lock.test.mjs
  assert.match(main, /rectForItem: \(item, layout\) => windowLayout\.rectForItem\(item, clusterFourWindowArrangement\(\), layout\),/);
  assert.match(main, /layout: \{ get: currentWindowLayout, set: setWindowLayout, defaults: windowLayout\.DEFAULT_LAYOUT \},/);
  const wf = read('desktop/phom/features/window-frames.cjs');
  assert.match(wf, /handle\('phom:layout-set', \(_e, cfg\) => \{ const l = layout\.set\(cfg && cfg\.layout\); arrange\(\); return \{ ok: true, layout: l \}; \}, \{ guarded: true \}\);/);
  assert.match(main, /path\.join\(phomRoot\(\), 'window-layout\.json'\)/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /iconButton\('layout', 'Đổi vị trí cửa sổ \(bấm 2 cửa sổ để đổi chỗ\)', \(\) => openLayoutDialog\(\)\)/);
  // click one window then another: they trade quarters and the windows move at once (no separate apply step)
  const dlg = ui.slice(ui.indexOf('async function openLayoutDialog('));
  assert.match(dlg, /next\[a\] = layout\[b\]; next\[b\] = layout\[a\];/);
  assert.match(dlg, /apply\(next, 'Đã đổi chỗ '/);
  assert.match(dlg, /api\.setLayout\(layout\)/);
});

test('MỨC CƯỢC is remembered: saved on every pick, applied when a session starts, kept in the picker before the server list', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /ipcMain\.handle\('phom:set-stake', guarded\(\(_e, cfg\) => \{ ensurePhomSessions\(\); saveStake\(cfg && cfg\.stake\);/);
  assert.match(main, /const saved = savedStake\(\); if \(r && r\.ok !== false && saved != null\) phomSessions\.setStake\(saved\);/);
  assert.match(main, /path\.join\(phomRoot\(\), 'stake\.json'\)/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /const st = await api\.getStake\(\); if \(st && st\.stake != null\) autoStake = String\(st\.stake\);/);
  assert.equal(/if \(autoStake && !stakes\.includes\(Number\(autoStake\)\)\) autoStake = '';/.test(ui), false, 'never dropped while the list is loading');
  assert.match(read('desktop/phom-preload.cjs'), /getStake: \(\) => ipcRenderer\.invoke\('phom:stake-get'\)/);
});

test('COMPACT short window (a quarter of 1366×768): bars shrink, LỌC BÀI | CÒN LẠI stay side by side, labels inline', () => {
  const css = read('ui-phom/phom-qa.css');
  const m = css.slice(css.indexOf('@media (max-height: 560px)'));
  assert.ok(m.length > 100, 'a compact block exists');
  assert.match(m, /\.topbar \{ height: 32px;/);
  assert.match(m, /\.safe-group, \.rem-sec \{ flex-direction: row;/);
  assert.match(m, /\.player\.reserve \.pc-state \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 760px\) and \(min-height: 561px\)/, 'stacking only on a tall narrow window');
});
