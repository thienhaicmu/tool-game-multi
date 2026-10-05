// The Phỏm control screen, rebuilt after the reference tool (2026-09-21) with the CARDS first: a one-line status
// (số bàn · key · cược · cùng bàn), one line of three account chips, LỌC BÀI + remaining cards taking the free
// height, and the controls at the BOTTOM (Tiền · ☐ TỰ ĐỘNG · BÀN KHÁC · THOÁT BÀN TẤT CẢ · XẾP CỬA SỔ · ĐÓNG TẤT CẢ).
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

test('layout order: status line · note · one card per account · controls at the bottom', () => {
  const rc = fn('renderControl');
  const order = ['statusLine()', 'playerGrid()', 'controlFooter()'].map((x) => rc.indexOf(x));
  assert.ok(order.every((i) => i >= 0), 'all regions are rendered');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  for (const label of ["'Số bàn'", "'Cược'"]) assert.ok(fn('statusLine').includes(label), label);
  assert.ok(fn('coSeatStat').includes("'Cùng bàn'"));
});

test('bottom controls: Mức cược + Tự động switch + Bàn khác · Thoát bàn tất cả · Xếp cửa sổ · Ghi WS · Đóng tất cả', () => {
  const f = fn('controlFooter');
  for (const label of ["'Mức cược'", "type: 'checkbox'", "'Tự động'", "'Bàn khác'", "'Thoát bàn tất cả'", "'Xếp lại 3 cửa sổ game'", 'openFrameCapture()', "'Đóng tất cả'"]) assert.ok(f.includes(label), label);
  assert.match(fn('autoStakes'), /betOptions/);
});

test('TỰ ĐỘNG checkbox → phom:auto-set (on/off); BÀN KHÁC → new-table', () => {
  assert.match(fn('onAutoToggle'), /api\.setAuto\(on, creator, autoStake \? Number\(autoStake\) : null\)/);
  assert.match(fn('onNewTable'), /api\.newTable\(/);
  assert.match(preload, /setAuto: \(on, browserId, stake\) => ipcRenderer\.invoke\('phom:auto-set'/);
  assert.match(main, /'phom:auto-set'[\s\S]*?phomSessions\.setAuto\(/);
  assert.equal(/phom:group-auto|groupAuto/.test(main + preload + js), false, 'the old always-on auto entry is gone');
});

test('player cards: three, slot A/B/C → P1/P2/P3, with role, state in words, ready and lifecycle', () => {
  assert.match(fn('playerGrid'), /SLOTS\.forEach\(\(slot, i\) => grid\.appendChild\(playerCard\(i \+ 1, slot, assign\[slot\]\.runId\)\)\)/);
  const card = fn('playerCard');
  assert.match(card, /const role = ROLE_VIEW\[b\.groupRole\];/);
  assert.match(card, /b\.isTableHost/);
  const st = fn('slotState');
  assert.match(st, /'Bị đá → ReJoin'/);
  assert.match(st, /'Bị đá'/);
  assert.match(st, /'Trong bàn · đã sẵn sàng'/);
  assert.match(card, /manualEnterGame\(runId\)/);
  assert.match(card, /iconButton\('refresh'/);
  assert.match(card, /iconButton\('power'/);
  assert.match(css, /\.players \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('roles read like the flow: KEY · SẴN SÀNG (joined first) · CHƯA SS (joined later)', () => {
  assert.match(js, /KEY: \['KEY'/);
  assert.match(js, /READY: \['SẴN SÀNG'/);
  assert.match(js, /NOT_READY: \['CHƯA SS'/);
});

test('LỌC BÀI: each account card carries its own analysis, re-run on every card snapshot', () => {
  const safe = fn('safeCardsFor');
  assert.match(safe, /Lọc bài/);
  assert.match(safe, /'Lượt sau: ' \+ playerLabel\(a\.nextPlayerLabel\)/);
  assert.match(safe, /'Chưa có bài'/);
  for (const label of ["'Nên đánh'", "'Có thể'", "'Chưa rõ'"]) assert.ok(js.includes(label), label);
  // user 2026-10-05: the playable groups only — "Đừng đánh" and "Phỏm" are not listed
  assert.equal(/\['riskyCards'|\['ownMeldCards'/.test(js), false);
  assert.match(fn('applyUiSnapshot'), /safeBySlot = snap\.analyses \|\| \{\};/);
  assert.match(js, /api\.onUi\(\(snap\) => \{ applyUiSnapshot\(snap\);/);
  assert.match(fn('refreshManual'), /api\.uiSnapshot\(\)/);
  assert.match(css, /\.safe \{[^}]*overflow-y: auto/);
});

test('a renderer reload with the browsers still open re-binds the slots (cards never read Chưa mở)', () => {
  assert.match(fn('showWorkspace'), /if \(uiState === UI\.CONTROL\) \{[\s\S]*?bindSlotsFromCluster\(\);[\s\S]*?await refreshManual\(\);/);
  assert.match(fn('bindSlotsFromCluster'), /assign\[s\]\.runId = p\.profileId;/);
});

// Header state honesty (bug from the live bar, 2026-09-21): a browser that holds a group role but is NOT sitting at
// the table used to read "ĐÃ VÀO GAME" with a solid role chip; a browser whose frames stopped arriving read
// "CHƯA VÀO GAME" although its game was running.
test('bar: a role without a seat reads NGOÀI BÀN · bấm ReJoin; seated reads SS <rid>', () => {
  const gh = require('../../desktop/protocol/phom/game-header.cjs');
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', groupRole: 'KEY', sharedRid: 3803041, betOptions: [100] });
  assert.match(s.statusLabel, /NGOÀI BÀN · SS 3803041/);
  assert.match(s.statusLabel, /bấm ReJoin/);
  assert.equal(s.inTable, false); assert.equal(s.canRejoin, true);
  const seated = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINED', rid: 3803041, groupRole: 'KEY', seatedAtTable: true });
  assert.equal(seated.statusLabel, 'SS 3803041', 'a public table has no password to show');
  assert.equal(seated.inTable, true);
  // the role is written in the line under the bar (reference tool layout), next to ID Bàn / Số người
  assert.match(gh.bootScript({}), /var ROLE = \{ KEY:'KEY', READY:'SẴN SÀNG', NOT_READY:'CHƯA SS' \};/);
});

test('bar: frames stopped arriving → MẤT DỮ LIỆU + TẢI LẠI (never a false CHƯA VÀO GAME), and the tool re-hooks', () => {
  const gh = require('../../desktop/protocol/phom/game-header.cjs');
  const s = gh.deriveHeaderState({ opened: true, inGame: false, dataStale: true, staleSec: 45 });
  assert.match(s.statusLabel, /MẤT DỮ LIỆU 45s · TẢI LẠI/);
  assert.equal(s.primary.action, 'RELOAD');
  assert.equal(s.canAct, false, 'no table actions while the tool is blind');
  // main: the freshness comes from the coordinator's lastFrameAt, and a stale run gets its capture re-installed
  assert.match(main, /dataStale: !!\(opened && b\.lastFrameAt != null && \(nowMs\(\) - Number\(b\.lastFrameAt\)\) > HEADER_STALE_MS\)/);
  assert.match(main, /function maybeRehookCapture\(browsers\)/);
  assert.match(main, /maybeRehookCapture\(browsers\);/);
  assert.match(main, /attachCapture\(sess\.client, \{ cdpTargetId: t \}\)/);
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  assert.match(coord, /lastFrameAt: c\.lastFrameAt\b/);
});

test('group events reach the screen as one plain-Vietnamese line (never a raw code)', () => {
  // table-group.cjs → session manager → main → the note line
  assert.match(read('desktop/protocol/phom/table-group.cjs'), /this\.emit\('notice', \{ event: name/);
  assert.match(read('desktop/protocol/phom/host-session-manager.cjs'), /group\.on\('notice', \(n\) => this\.emit\('notice', n\)\)/);
  assert.match(main, /phomSessions\.on\('notice', \(n\) => send\('phom:notice', n\)\)/);
  assert.match(preload, /onNotice: \(cb\) => ipcRenderer\.on\('phom:notice'/);
  const t = fn('noticeText');
  for (const ev of ['KEY_SEATED', 'TABLE_FOUND', 'JOINED', 'READY_SENT', 'FOURTH_READY', 'KICKED', 'TABLE_LOST', 'GROUP_DISSOLVED']) assert.ok(t.includes(ev), ev);
  // the 4th player readied: three bell strikes in the tool window, then the line says who does what
  assert.match(read('ui-phom/phom-qa.js'), /if \(n && n\.event === 'FOURTH_READY'\) ringBell\(3\);/);
  assert.match(fn('ringBell'), /createOscillator/);
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

test('PROFILE: ⚡ DÁN PROXY is reachable again — one line per proxy, mapped by profile order, all-or-nothing', () => {
  // The bulk import existed but nothing rendered it any more; three accounts normally mean three proxies.
  assert.match(fn('profileTablePanel'), /onclick: openBulkProxy \}, '⚡ Dán proxy'/);
  const dlg = fn('openBulkProxy');
  assert.match(dlg, /BP\.parse\(bulkProxyText\)/);
  assert.match(dlg, /BP\.mapToProfiles\(parsed\.proxies, profilesX\.map\(\(p\) => p\.id\)\)/);
  assert.match(dlg, /api\.profileSetProxy\(m\.profileId, m\.proxy\)/); // the existing IPC, no new storage
  assert.equal(/password|m\.proxy\.pass/.test(dlg.replace('PASSWORD', '')), false, 'a password is never echoed back');
});

test('the background poll only runs for the screen that is visible', () => {
  assert.match(fn('startEntryPolling'), /uiState !== UI\.CONTROL \|\| activeTab !== 'PHOM' \|\| document\.hidden/);
});
