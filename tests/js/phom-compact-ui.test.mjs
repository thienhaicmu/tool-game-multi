// The Phỏm QA tool window (source-level assertions; no DOM runtime in CI). Redesign 2026-10-03: a top bar (brand ·
// Profile/Phỏm tabs · license), the PROFILE table, and the PHỎM tab = one status line + ONE CARD PER ACCOUNT that
// carries the account and its own Lọc Bài + a bottom bar. The offline QA tools (simulator, rule analyzer, replay
// monitor, debug dump) are gone from the window. Backend/protocol untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const css = read('ui-phom/phom-qa.css');
const main = read('desktop/phom-main.cjs');

function fn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const nextIdx = rest.indexOf('\n  function ');
  return rest.slice(0, nextIdx > 0 ? nextIdx : 4000);
}

test('PHỎM tab: status line · note · one card per account · bottom bar — nothing else', () => {
  const body = fn(js, 'renderControl');
  const order = ['statusLine()', "id: 'phq-note'", 'playerGrid()', 'controlFooter()'].map((x) => body.indexOf(x));
  assert.ok(order.every((i) => i >= 0), 'all four regions');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  assert.match(fn(js, 'playerGrid'), /SLOTS\.forEach\(\(slot, i\) => grid\.appendChild\(playerCard\(i \+ 1, slot, assign\[slot\]\.runId\)\)\)/);
});

test('the offline QA tools are gone from the window (simulator, rule analyzer, replay monitor, debug dump, ⋯ menu)', () => {
  for (const gone of ['openSimulator', 'openAnalyzer', 'renderLiveMonitorInto', 'renderReplayMonitorInto', 'qaMonitorPlay', 'toggleAdvancedDebug', 'moreMenuButton', 'clusterProfileCreate', 'entryPhase']) {
    assert.equal(js.includes(gone), false, gone);
  }
  for (const gone of ['.sim-', '.qa-mon-', '.mon-', '.adv-debug', '.qa-more']) assert.equal(css.includes(gone), false, gone);
});

test('the in-Chromium header owns VÀO GAME with a real ENTERING + failure state (deriveHeaderState)', () => {
  const gh = read('desktop/protocol/phom/game-header.cjs');
  assert.match(gh, /ENTER_GAME/);
  assert.match(gh, /entering[\s\S]*?ĐANG VÀO GAME/);
  assert.match(gh, /error:/);
  assert.match(main, /headerEntering/);
  assert.match(main, /if \(view\.inGame\) \{[\s\S]*?delete headerEntering\[rid\]/);
});

test('the header action router acts on ONE browser via the run-scoped coordinator API (no cross-browser)', () => {
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('function liveRunCount('));
  assert.match(r, /ENTER_GAME'[\s\S]*?startEnterGame\(rid,/);
  const enter = main.slice(main.indexOf('async function startEnterGame('), main.indexOf('function maybeAutoEnter('));
  assert.match(enter, /phomEnterGame\(rid\)/, 'one browser, the one the click came from');
  assert.match(r, /rejoinTable\(rid\)/);
  assert.match(r, /leaveTable\(rid\)/);
  assert.match(r, /findTable\(rid, \{ stake, force \}\)/); // force = the 2nd Dò Key within 5s (rule D2)
  assert.equal(/findAndJoinGroup|createTable/.test(r), false);
  assert.match(r, /joinTable\(rid, joinRid\)/);
});

test('the Tool is the 4th window of the deterministic cluster arrangement', () => {
  assert.match(main, /arrangeClusterWindows/);
  // each window's quarter comes from the user's layout (window-layout.cjs); a reserve sits where the tool is
  assert.match(main, /function windowRectForSlot[\s\S]*?windowLayout\.rectForItem\(item, clusterFourWindowArrangement\(\), currentWindowLayout\(\)\)/);
  assert.match(main, /control = windowLayout\.rectForItem\('TOOL', clusterFourWindowArrangement\(\), currentWindowLayout\(\)\)/);
});

test('status line: số bàn (click = copy) · cược · cùng bàn · còn lại N lá — the remaining-card list itself is not shown', () => {
  const s = fn(js, 'statusLine');
  assert.match(s, /'Số bàn'/);
  assert.match(s, /navigator\.clipboard\.writeText\(String\(rid\)\)/);
  assert.match(s, /'Cược'/);
  assert.match(s, /coSeatStat\(\)/);
  assert.match(s, /const rem = remainingCount\(\);/);
  assert.match(s, /'Còn lại'\), el\('b', null, rem \+ ' lá'\)/);
  assert.match(fn(js, 'remainingCount'), /remaining\.count/);
  assert.equal(/renderRemainingCards/.test(js), false);
});

test('renderer never writes document.title or injects game DOM (tool-side only)', () => {
  assert.equal(/document\.title\s*=/.test(js), false);
});

test('top bar: brand + [Profile][Phỏm] tabs + the license chip (days left + expiry from the signed status)', () => {
  const bar = fn(js, 'renderTabBar');
  assert.match(bar, /'Phỏm QA'/);
  assert.match(bar, /tab\('SETUP', 'Profile'\), tab\('PHOM', 'Phỏm'\)/);
  assert.match(bar, /licenseChip\(\)/);
  const chip = fn(js, 'licenseChip');
  assert.match(chip, /Còn \$\{days\} ngày · HSD/);
  assert.match(chip, /payload\.expiresAt/);
});

test('Profile table: P badge · name · agent · proxy · Game URL · Edit/Duplicate/Delete (no redundant status column)', () => {
  const table = fn(js, 'profileTablePanel');
  for (const h of ["'Profile'", "'Agent'", "'Proxy'", "'Game URL'"]) assert.ok(table.includes(h), h);
  assert.equal(/TRẠNG THÁI|'Chọn tất cả'|'Bỏ chọn tất cả'/.test(table), false, 'the tick boxes say it already');
  assert.match(table, /selectedProfileIds = allSel \? \[\] : profilesX\.slice\(0, 3\)\.map\(\(p\) => p\.id\)/, 'header box = all/none');
  const row = fn(js, 'profileRow');
  assert.match(row, /iconButton\('edit', 'Sửa profile'/);
  assert.match(row, /iconButton\('copy', 'Nhân bản profile', \(\) => duplicateProfileX\(p\.id\)\)/);
  assert.match(row, /iconButton\('trash', 'Xóa profile'/);
  assert.match(row, /'Thiếu Game URL'/);
  assert.match(fn(js, 'duplicateProfileX'), /api\.profileCreate\(/);
  assert.match(js, /id: 'pf-proxy'/);
  assert.match(js, /api\.profileSetProxy\(pid/);
});

test('Profile footer: browser engine · count · Mở trình duyệt (3–5 ticked, each with a Game URL)', () => {
  const f = fn(js, 'runGameFooter');
  assert.match(f, /api\.browserRuntimeSet/);
  assert.match(f, /const ready = n >= 3 && n <= 5 && !missingUrl;/);
  assert.match(f, /'Mở trình duyệt'/);
  assert.match(f, /Đã chọn \$\{n\} \/ 3/);
  assert.match(f, /3 chơi \+ \$\{n - 3\} dự bị/);
  assert.equal(/Môi trường|Window mode/.test(f), false, 'no decorative labels');
});

test('player card: P badge in its accent, account + ID + money, role, state IN WORDS, Vào game / ↻ / ⏻', () => {
  assert.match(js, /const ACCENT = \['#2563eb', '#16a34a', '#ea580c'\];/);
  const card = fn(js, 'playerCard');
  assert.match(card, /'--accent:' \+ ACCENT\[index - 1\]/);
  assert.match(card, /'P' \+ index/);
  assert.match(card, /'ID ' \+ b\.accountId/);
  assert.match(card, /money\(b\.money\)/);
  assert.match(card, /ROLE_VIEW\[b\.groupRole\]/);
  assert.match(card, /el\('span', \{ class: 'pc-label' \}, s\.label\)/, 'the state is written, not only a dot');
  assert.match(card, /manualEnterGame\(runId\)/);
  assert.match(card, /onReloadWeb\(runId\)/);
  assert.match(card, /onCloseBrowser\(runId\)/);
  assert.equal(/safeCardsFor/.test(card), false, 'LỌC BÀI is the tabbed panel, not inside the card');
  assert.match(fn(js, 'safePanel'), /safeCardsFor\(safeTab\)/);
  for (const st of ['Bị đá → ReJoin', "'Bị đá'", 'Đang Tạo (dò bàn KEY)…', 'Đang Dò Key…', 'Trong bàn', 'Ở sảnh Phỏm']) assert.ok(fn(js, 'slotState').includes(st), st);
});

// ================= quick bulk proxy import (by profile order) =================
test('index.html loads the bulk-proxy parser before the renderer', () => {
  const html = read('ui-phom/index.html');
  assert.match(html, /bulk-proxy\.js/);
  assert.ok(html.indexOf('bulk-proxy.js') < html.indexOf('phom-qa.js'));
});

test('the profile table shows a COMPACT proxy (TYPE host:port · auth) — never the password', () => {
  const at = js.indexOf('// proxy: TYPE host:port · auth');
  assert.ok(at > 0);
  const cellBlock = js.slice(at, at + 400);
  assert.match(cellBlock, /px\.protocol \? px\.protocol\.toUpperCase\(\)/);
  assert.match(cellBlock, /px\.endpoint/);
  assert.match(cellBlock, /px\.hasAuth \? ' · auth' : ''/);
  assert.equal(/password|passwordSecretRef/.test(cellBlock), false, 'the proxy cell never references a password');
});

test('every game window is a QUARTER of the screen: the 2×2 grid on the tool\'s monitor, whatever the monitor count', () => {
  assert.match(main, /function clusterFourWindowArrangement\(\) \{ return arrangeClusterWindows\(\[currentWorkArea\(\)\], \{ gap: 8 \}\); \}/);
  assert.equal(/allDisplayWorkAreas/.test(main), false, 'no per-monitor full-screen browsers any more');
  const { arrangeClusterWindows } = require('../../desktop/protocol/phom/grid-layout.cjs');
  const a = arrangeClusterWindows([{ x: 0, y: 0, width: 1920, height: 1040 }], { gap: 8 });
  assert.equal(a.placement, 'GRID_2x2');
  for (const i of [1, 2, 3]) { assert.ok(a.slots[i].width <= 960 && a.slots[i].height <= 520, 'slot ' + i + ' is a quarter'); }
  // XẾP CỬA SỔ moves the open browsers back into their quarter / behind the tool
  const r = main.slice(main.indexOf('function restoreLayout('), main.indexOf('function restoreLayout(') + 2400);
  assert.match(r, /moveRunWindow\(p\.profileId, windowRectForSlot\(s\)\)/);
  assert.match(r, /moveRunWindow\(p\.profileId, windowRectForSlot\(r\)\)/);
});
