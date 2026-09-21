// The Phỏm control screen, rebuilt after the reference tool (2026-09-21) with the CARDS first: a one-line status
// (số bàn · key · cược · cùng bàn), one line of three account chips, LỌC BÀI + remaining cards taking the free
// height, and the controls at the BOTTOM (Tiền · ☐ TỰ ĐỘNG · ĐỔI KEY · THOÁT BÀN TẤT CẢ · XẾP CỬA SỔ · ĐÓNG TẤT CẢ).
// Nothing automatic runs unless TỰ ĐỘNG is ticked. Source-level assertions (no DOM in CI); behaviour is covered by
// phom-create-table.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const css = read('ui-phom/phom-qa.css');
const preload = read('desktop/phom-preload.cjs');
const main = read('desktop/phom-main.cjs');
function fn(name) { const s = js.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = js.slice(s + 1); const m = rest.indexOf('\n  function '); return rest.slice(0, m > 0 ? m : 4000); }

test('layout order: status line · account chips · cards · controls at the bottom', () => {
  const rc = fn('renderControl');
  const order = ['compactHeader()', 'compactBrowserRow()', 'renderCardWorkspace()', 'controlFooter()'].map((x) => rc.indexOf(x));
  assert.ok(order.every((i) => i >= 0), 'all four regions are rendered');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  for (const label of ['SỐ BÀN ', 'KEY ', 'CƯỢC ']) assert.ok(fn('compactHeader').includes(label), label);
});

test('bottom controls: Tiền + TỰ ĐỘNG checkbox + the reference-tool action set; Tiền is the server stakes', () => {
  const f = fn('controlFooter');
  for (const label of ["'Tiền'", "type: 'checkbox'", ' TỰ ĐỘNG', 'ĐỔI KEY', 'THOÁT BÀN TẤT CẢ', 'XẾP CỬA SỔ', 'ĐÓNG TẤT CẢ']) assert.ok(f.includes(label), label);
  assert.match(fn('autoStakes'), /betOptions/);
  assert.equal(fn('compactHeader').includes('GHI WS'), false, 'Ghi WS lives in ⋯, not on the main screen');
});

test('TỰ ĐỘNG checkbox → phom:auto-set (on/off); ĐỔI KEY → change-key', () => {
  assert.match(fn('onAutoToggle'), /api\.setAuto\(on, creator, autoStake \? Number\(autoStake\) : null\)/);
  assert.match(fn('onChangeKey'), /api\.changeKey\(/);
  assert.match(preload, /setAuto: \(on, browserId, stake\) => ipcRenderer\.invoke\('phom:auto-set'/);
  assert.match(main, /'phom:auto-set'[\s\S]*?phomSessions\.setAuto\(/);
  assert.equal(/phom:group-auto|groupAuto/.test(main + preload + js), false, 'the old always-on auto entry is gone');
});

test('account chips: one line of three, slot A/B/C → B1/B2/B3, with role, state, ready and lifecycle', () => {
  assert.match(fn('compactBrowserRow'), /SLOTS\.forEach\(\(slot, i\) => row\.appendChild\(compactBrowserCell\(i \+ 1, slot, assign\[slot\]\.runId\)\)\)/);
  const cell = fn('compactBrowserCell');
  assert.match(cell, /roleChip\(b\.groupRole, b\.isTableHost\)/);
  assert.match(cell, /BỊ ĐÁ → REJOIN/);
  assert.match(cell, /'BỊ ĐÁ'/);
  assert.match(cell, /manualEnterGame\(runId\)/);
  assert.match(cell, /iconButton\('refresh'/);
  assert.match(cell, /iconButton\('power'/);
  assert.match(css, /\.acc-chips \{[^}]*display: flex/);
});

test('roles read like the flow: KEY · SẴN SÀNG (joined first) · CHƯA SS (joined later)', () => {
  assert.match(js, /KEY: \['KEY'/);
  assert.match(js, /READY: \['SẴN SÀNG'/);
  assert.match(js, /NOT_READY: \['CHƯA SS'/);
});

test('LỌC BÀI shows all three accounts at once, gets the larger share, and re-runs on every card snapshot', () => {
  const safe = fn('renderSafeCards');
  assert.match(safe, /LỌC BÀI/);
  assert.match(safe, /\['B1', 'B2', 'B3'\]\.forEach/);
  const col = fn('safeColumn');
  for (const label of ['NÊN ĐÁNH', 'CÓ THỂ AN TOÀN', 'ĐỪNG ĐÁNH — người sau ăn được', 'TRONG PHỎM — giữ lại', 'Chưa có bài']) assert.ok(col.includes(label), label);
  // the analyses arrive with the single ui snapshot (built in main, memoised); every push applies it as-is
  assert.match(fn('applyUiSnapshot'), /safeBySlot = snap\.analyses \|\| \{\};/);
  assert.match(js, /api\.onUi\(\(snap\) => \{ applyUiSnapshot\(snap\);/);
  assert.match(fn('refreshManual'), /api\.uiSnapshot\(\)/);
  assert.match(css, /\.card-workspace \.safe-cards \{ flex: 3 1 0; \}/);
});

test('a renderer reload with the browsers still open re-binds the slots (chips never read CHƯA MỞ)', () => {
  assert.match(fn('showWorkspace'), /if \(uiState === UI\.CONTROL\) \{[\s\S]*?assign\[s\]\.runId = p\.profileId;[\s\S]*?await refreshManual\(\);/);
});

// Header state honesty (bug from the live bar, 2026-09-21): a browser that holds a group role but is NOT sitting at
// the table used to read "ĐÃ VÀO GAME" with a solid role chip; a browser whose frames stopped arriving read
// "CHƯA VÀO GAME" although its game was running.
test('bar: a role without a seat reads NGOÀI BÀN and offers VÀO LẠI BÀN (role chip dimmed)', () => {
  const gh = require('../../desktop/protocol/phom/game-header.cjs');
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', groupRole: 'KEY', sharedRid: 3803041, betOptions: [100] });
  assert.match(s.statusLabel, /NGOÀI BÀN · SS 3803041/);
  assert.equal(s.primary.action, 'REJOIN');
  assert.equal(s.seatedAtTable, false);
  const seated = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINED', rid: 3803041, groupRole: 'KEY', seatedAtTable: true, roomCode: '482913' });
  assert.match(seated.statusLabel, /SS 3803041 · KEY 482913/);
  assert.equal(seated.seatedAtTable, true);
  assert.match(gh.bootScript({}), /state\.seatedAtTable \? R\[1\] : '#374151'/);
});

test('bar: frames stopped arriving → MẤT DỮ LIỆU + TẢI LẠI (never a false CHƯA VÀO GAME), and the tool re-hooks', () => {
  const gh = require('../../desktop/protocol/phom/game-header.cjs');
  const s = gh.deriveHeaderState({ opened: true, inGame: false, dataStale: true, staleSec: 45 });
  assert.match(s.statusLabel, /MẤT DỮ LIỆU 45s · TẢI LẠI/);
  assert.equal(s.primary.action, 'RELOAD');
  assert.equal(s.canCreate, false, 'no table actions while the tool is blind');
  // main: the freshness comes from the coordinator's lastFrameAt, and a stale run gets its capture re-installed
  assert.match(main, /dataStale: !!\(opened && b\.lastFrameAt != null && \(nowMs\(\) - Number\(b\.lastFrameAt\)\) > HEADER_STALE_MS\)/);
  assert.match(main, /function maybeRehookCapture\(browsers\)/);
  assert.match(main, /maybeRehookCapture\(browsers\);/);
  assert.match(main, /attachCapture\(sess\.client, \{ cdpTargetId: t \}\)/);
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  assert.match(coord, /lastFrameAt: c\.lastFrameAt != null \? c\.lastFrameAt : null,/);
});

test('group events reach the screen as one plain-Vietnamese line (never a raw code)', () => {
  // table-group.cjs → session manager → main → the note line
  assert.match(read('desktop/protocol/phom/table-group.cjs'), /this\.emit\('notice', \{ event: name/);
  assert.match(read('desktop/protocol/phom/host-session-manager.cjs'), /group\.on\('notice', \(n\) => this\.emit\('notice', n\)\)/);
  assert.match(main, /phomSessions\.on\('notice', \(n\) => send\('phom:notice', n\)\)/);
  assert.match(preload, /onNotice: \(cb\) => ipcRenderer\.on\('phom:notice'/);
  const t = fn('noticeText');
  for (const ev of ['GROUP_CREATED', 'JOINED', 'KICKED', 'TABLE_LOST', 'REJOIN_EXHAUSTED', 'GROUP_DISSOLVED']) assert.ok(t.includes(ev), ev);
  assert.match(t, /default: return '';/); // an unknown event is never shown as a code
});

test('a background update repaints at most once per frame, and not at all when nothing shown changed', () => {
  const bg = fn('bgRender');
  assert.match(bg, /requestAnimationFrame/);
  assert.match(bg, /if \(key === _bgKey\) return;/);
  assert.match(bg, /if \(document\.hidden\) return;/);
  const key = fn('renderKey');
  for (const part of ['manualBrowsers.map', 'safeBySlot[sl]', 'manualGroup']) assert.ok(key.includes(part), part);
});
