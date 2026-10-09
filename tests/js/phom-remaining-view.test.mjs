// CÒN LẠI inside every account tab (right of its LỌC BÀI): the unseen cards (card observer: 52 − our hands − discards
// − laid melds), BIG, sorted small → big, grouped into possible phỏm — SETS (3–4 same rank) in purple frames, RUNS (3+
// consecutive same suit) in blue frames, then LẺ — and highlighted the same way in the plain order view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ui = ['ui-kit', 'ui-cards', 'ui-notices', 'phom-qa'].map((n) => readFileSync(new URL('../../ui-phom/' + n + '.js', import.meta.url), 'utf8')).join('\n').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../../ui-phom/phom-qa.css', import.meta.url), 'utf8');
const grab = (name) => ui.slice(ui.indexOf('function ' + name + '('), ui.indexOf('\n  }\n', ui.indexOf('function ' + name + '(')) + 4);
const groupByPhom = new Function(
  'const rankOfCode = (code) => Math.floor(Number(code) / 4); const suitOfCode = (code) => Number(code) % 4;\n' + grab('groupByPhom') + '\nreturn groupByPhom;')();
const c = (code) => ({ code });
const codes = (gs) => gs.map((g) => g.map((x) => x.code));

test('sets = 3+ cards of one rank; runs = 3+ consecutive ranks of one suit; the rest is loose — each small → big', () => {
  // A♠ A♣ A♦ (0,1,2) · 3♣ 4♣ 5♣ 6♣ (9,13,17,21) · 9♦ (34) · K♥ (51)
  const g = groupByPhom([0, 1, 2, 9, 13, 17, 21, 34, 51].map(c));
  assert.deepEqual(codes(g.sets), [[0, 1, 2]]);
  assert.deepEqual(codes(g.runs), [[9, 13, 17, 21]]);
  assert.deepEqual(g.loose.map((x) => x.code), [34, 51]);
});

test('a gap breaks a run; two of a rank is not a set; a card can be in a set AND a run', () => {
  const g = groupByPhom([9, 13, 21, 25, 29, 4, 6].map(c)); // 3♣ 4♣ _ 6♣ 7♣ 8♣ · 2♠ 2♦
  assert.deepEqual(codes(g.runs), [[21, 25, 29]]);
  assert.equal(g.sets.length, 0);
  const both = groupByPhom([16, 17, 18, 13, 21].map(c)); // 5♠ 5♣ 5♦ + 4♣ 6♣
  assert.deepEqual(codes(both.sets), [[16, 17, 18]]);
  assert.deepEqual(codes(both.runs), [[13, 17, 21]]);
  assert.deepEqual(both.loose, []);
});

test('wiring: inside each account tab (no separate tab), big cards, Theo phỏm / Thứ tự, phỏm frames + highlight', () => {
  assert.match(grab('safePanel'), /el\('div', \{ class: 'safe-split' \}, safeCardsFor\(safeTab\), remainingPanel\(unseenCards\(\), remMode, setRemMode\)\)/);
  assert.equal(/'REM'|rem-tab/.test(ui), false, 'no separate CÒN LẠI tab');
  assert.match(grab('unseenCards'), /if \(!obs \|\| !obs\.knownOutCount/, 'nothing before a round was seen');
  assert.match(grab('unseenCards'), /sort\(\(a, b\) => a\.code - b\.code\)/, 'small → big');
  const rp = grab('remainingPanel');
  assert.match(rp, /seg\('PHOM', 'Theo phỏm'/); assert.match(rp, /seg\('ORDER', 'Thứ tự'/);
  assert.match(rp, /function remainingPanel\(cards, mode, onMode\)/, 'pure (ui-cards.js): the mode comes in');
  assert.match(rp, /class: 'phom-box pb-' \+ kind/, 'each phỏm in its own frame');
  assert.match(rp, /const kindOf = \(c\) =>/, 'the order view highlights phỏm cards too');
  for (const k of ['.pb-set', '.pb-run', '.card-face.big.k-set', '.card-face.big.k-run', '.card-face.big.k-loose']) assert.ok(css.includes(k), k);
  assert.match(css, /\.card-face\.big \{ width: 44px; height: 60px;/);
});

test('remaining after the three hands counts the PLAYING browsers only (a reserve sits elsewhere)', () => {
  const coord = readFileSync(new URL('../../desktop/protocol/phom/host-table-coordinator.cjs', import.meta.url), 'utf8');
  assert.match(coord, /remainingCards\(opts = \{\}\) \{[\s\S]*?\.slice\(0, 3\)\.map\(\(rec\)/);
});

// 3.2 phase 4b — the tool window's pure parts load before phom-qa.js and export on window.PhomUI
test('ui split: index.html loads ui-kit → ui-cards → ui-notices before phom-qa.js; each part exports what phom-qa imports', () => {
  const html = readFileSync(new URL('../../ui-phom/index.html', import.meta.url), 'utf8');
  const order = ['ui-kit.js', 'ui-cards.js', 'ui-notices.js', 'phom-qa.js'].map((f) => html.indexOf('<script src="' + f + '">'));
  assert.ok(order.every((i) => i > 0)); assert.deepEqual([...order].sort((a, b) => a - b), order);
  const read = (f) => readFileSync(new URL('../../ui-phom/' + f, import.meta.url), 'utf8');
  assert.match(read('ui-kit.js'), /Object\.assign\(UI, \{ el, \$, icon, iconButton, playerLabel, money, errText, note, noteText, openDialog, ringBell \}\);/);
  assert.match(read('ui-cards.js'), /Object\.assign\(UI, \{ groupByPhom, bigCard, remainingPanel \}\);/);
  assert.match(read('ui-notices.js'), /Object\.assign\(UI, \{ ROLE_VIEW, roleLabel, noticeText \}\);/);
  const qa = read('phom-qa.js');
  assert.match(qa, /const \{ el, \$, icon, iconButton, playerLabel, money, errText, note, noteText, openDialog, ringBell \} = window\.PhomUI;/);
  assert.match(qa, /const noticeText = \(n\) => noticeLine\(n, playerLabelOf\);/);
});

test('ui split: the notice lines run for real (pure) — who the line is about comes from the screen', () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  for (const f of ['ui-kit.js', 'ui-notices.js']) vm.runInContext(readFileSync(new URL('../../ui-phom/' + f, import.meta.url), 'utf8'), ctx);
  const line = ctx.window.PhomUI.noticeText({ event: 'KEY_SEATED', id: 'BR-1' }, () => 'P2');
  assert.equal(line, 'P2 là KEY (chủ bàn) — các acc khác bấm Tạo / Vào.');
  assert.equal(ctx.window.PhomUI.noticeText({ event: 'NOPE' }, () => 'P1'), '');
});
