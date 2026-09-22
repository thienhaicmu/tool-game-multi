// PHASE 6.2 — the compact final Tool UI (source-level assertions; no DOM runtime in CI). The main
// CONTROL screen is a low header (BÀN/CÒN LẠI) + a single row of Browser 1/2/3 controls with a VÀO GAME
// gate; no username, no Host/Follower, no legacy entry toolbars/monitor rendered on the main screen; the
// Tool is the 4th window of the deterministic layout. Backend/protocol untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const main = read('desktop/phom-main.cjs');

function fn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  // next top-level "  function " at the same indent
  const rest = src.slice(start + 1);
  const nextIdx = rest.indexOf('\n  function ');
  return rest.slice(0, nextIdx > 0 ? nextIdx : 4000);
}

test('renderControl renders the compact UI (header + compact browser row + card workspace), not legacy toolbars', () => {
  const body = fn(js, 'renderControl');
  assert.match(body, /compactHeader\(\)/);
  assert.match(body, /compactBrowserRow\(\)/);
  // PHASE 6.3.3 — cards live in a flex-growing workspace (LÁ BÀI AN TOÀN + CÒN LẠI), not a bare remaining list
  assert.match(body, /renderCardWorkspace\(\)/);
  const ws = fn(js, 'renderCardWorkspace');
  assert.match(ws, /renderSafeCards\(\)/);
  assert.match(ws, /renderRemainingCards\(\)/);
  assert.match(ws, /card-workspace/);
  // legacy host-first/entry toolbars + monitor are NOT called from the main screen
  assert.equal(/statusToolbar\(|commandToolbar\(|entryStatusBar\(|liveMonitor\(/.test(body), false, 'no legacy toolbars/monitor on the main screen');
});

// PHASE 6.3.2 — Screen 2 is READ-ONLY. The game action (VÀO GAME) + its ENTERING/failure states now live
// in the in-Chromium header (game-header.cjs); the Tool cell only mirrors ACCOUNT/RID/STATE/WS.
test('the in-Chromium header owns VÀO GAME with a real ENTERING + failure state (deriveHeaderState)', () => {
  const gh = read('desktop/protocol/phom/game-header.cjs');
  assert.match(gh, /ENTER_GAME/);
  assert.match(gh, /entering[\s\S]*?ĐANG VÀO GAME/); // busy ENTERING label
  assert.match(gh, /error:/); // failure surfaced back into the header
  // the main process tracks the transient entering flag + bounded evidence via slotInPhom-equivalent
  assert.match(main, /headerEntering/);
  assert.match(main, /if \(view\.inGame\) \{[\s\S]*?delete headerEntering\[rid\]/); // real in-game evidence clears ENTERING
});

test('the header action router acts on ONE browser via the run-scoped coordinator API (no cross-browser)', () => {
  // ENTER_GAME -> phomEnterGame(runId); FIND/JOIN/REJOIN/LEAVE -> the run-scoped manual* API, all keyed by
  // the single runId the click came from (never a leave-all / cross-browser action).
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('function liveRunCount('));
  assert.match(r, /ENTER_GAME'[\s\S]*?phomEnterGame\(rid\)/);
  assert.match(r, /FIND'[\s\S]*?findAndJoinGroup\(rid, \{ selectedStake/); // §co-seat — plus budget/poll/fallback opts
  // docs/phom-kich-ban.md — the table actions go through the session manager's group API, still run-scoped.
  assert.match(r, /rejoinTable\(rid\)/);
  assert.match(r, /leaveTable\(rid\)/);
  assert.match(r, /createTable\(rid, \{ stake \}\)/);
  assert.match(r, /joinTable\(rid, joinRid\)/);
});

test('the Tool is the 4th window of the deterministic cluster arrangement', () => {
  assert.match(main, /arrangeClusterWindows/);
  assert.match(main, /clusterFourWindowArrangement/);
  // browsers use .slots; the Tool window (restoreLayout) uses .tool
  assert.match(main, /clusterFourWindowArrangement\(\)[\s\S]*?arr\.slots\[slotIndex\]/);
  assert.match(main, /clusterFourWindowArrangement\(\);\s*control = arr && arr\.tool/);
});

test('remaining cards on the main screen are backend-provided and not "player 4"', () => {
  const body = fn(js, 'renderRemainingCards');
  assert.match(body, /CARDS REMAINING/);
  assert.match(body, /remaining\.cards/);
  assert.equal(/Player 4|Opponent|Người thứ 4/.test(body), false);
});

test('renderer never writes document.title or injects game DOM (tool-side only)', () => {
  assert.equal(/document\.title\s*=/.test(js), false);
});

// ================= PHASE 6.3.9 — TWO-WORKSPACE REDESIGN (Profile + Phỏm), source-level =================
const css = read('ui-phom/phom-qa.css');

test('header is one unified bar: brand + [PROFILE][PHỎM] tabs + a compact license chip (no License page)', () => {
  const bar = fn(js, 'renderTabBar');
  assert.match(bar, /tb-brand/);
  assert.match(bar, /♠ PHỎM QA/);
  assert.match(bar, /tab\('SETUP', 'PROFILE'\)/);
  assert.match(bar, /tab\('PHOM', 'PHỎM'\)/);
  assert.match(bar, /licenseChip\(\)/);
  const chip = fn(js, 'licenseChip');
  assert.match(chip, /Đã kích hoạt/);
  assert.match(chip, /Còn .* ngày · HSD:/);
  assert.match(chip, /expiresAt/); // derived from the real license status, not fabricated
});

test('Profile: table has a TRẠNG THÁI column + Edit/Duplicate/Delete; proxy is per-profile; CTA renamed', () => {
  const table = fn(js, 'profileTablePanel');
  assert.match(table, /'TRẠNG THÁI'/);
  const row = fn(js, 'profileRow');
  assert.match(row, /Sẵn sàng/);
  assert.match(row, /Chưa chọn/);
  assert.match(row, /iconButton\('edit'/);
  assert.match(row, /iconButton\('copy', 'Nhân bản profile', \(\) => duplicateProfileX/);
  assert.match(row, /iconButton\('trash'/);
  // Duplicate composes the existing create IPC (no new business logic / no new IPC)
  const dup = fn(js, 'duplicateProfileX');
  assert.match(dup, /api\.profileCreate\(/);
  // proxy moved into the Edit modal (reuses api.profileSetProxy) — the bulk panel is gone from the render
  assert.match(js, /id: 'pf-proxy'/);
  assert.match(js, /api\.profileSetProxy\(pid/);
  // the primary CTA is the mockup label
  assert.match(js, /MỞ TRÌNH DUYỆT ĐÃ CHỌN/);
});

test('Phỏm: the command toolbar + LIVE QA MONITOR are NOT in the workspace render (renderControl)', () => {
  const ctrl = fn(js, 'renderControl');
  assert.equal(/commandToolbar\(|liveMonitor\(|qaMonitor/.test(ctrl), false, 'no command toolbar / monitor in the Phỏm workspace');
  // renderControl is exactly: top line + status row + analysis(finder) selector + card workspace
  assert.match(ctrl, /compactHeader\(\)/);
  assert.match(ctrl, /compactBrowserRow\(\)/);
  assert.match(ctrl, /renderCardWorkspace\(\)/);
});

test('Profile: Select-All (header checkbox + Chọn/Bỏ chọn tất cả buttons + count) and no big runtime panel', () => {
  const table = fn(js, 'profileTablePanel');
  assert.match(table, /Chọn \/ bỏ chọn tất cả/);            // header checkbox toggles all
  assert.match(table, /'Chọn tất cả'/); assert.match(table, /'Bỏ chọn tất cả'/);
  assert.match(table, /Đã chọn: \$\{n\} \/ 3 profile/);
  assert.match(js, /function selectAllProfiles\(\) \{ selectedProfileIds = profilesX\.slice\(0, 3\)/);
  assert.match(js, /function clearAllProfiles\(\) \{ selectedProfileIds = \[\]/);
  // the big BROWSER RUNTIME panel is no longer rendered in the Profile page; the engine moved to the footer.
  const setup = fn(js, 'renderSetup');
  assert.equal(/browserRuntimePanel\(\)/.test(setup), false, 'no big runtime panel in the Profile render');
  const footer = fn(js, 'runGameFooter');
  assert.match(footer, /Môi trường:/); assert.match(footer, /Window mode:/);
  assert.match(footer, /api\.browserRuntimeSet/);           // the REAL runtime selector, now compact in the footer
});

test('Phỏm: player cards retain identity and lifecycle controls without a redundant disabled checkbox', () => {
  const cell = fn(js, 'compactBrowserCell');
  assert.doesNotMatch(cell, /class: 'bc-cb'/);
  assert.match(cell, /index === 1 \? '#2563eb' : index === 2 \? '#16a34a' : index === 3 \? '#ea580c'/); // B1/B2/B3 accents by index
  assert.match(cell, /'b-badge'[\s\S]*?'P' \+ index/); // badge shows P1/P2/P3
  assert.match(cell, /onReloadWeb\(runId\)/); assert.match(cell, /onCloseBrowser\(slot, runId\)/); // ↻ / ⏻ per cell
});

// ================= PHASE 6.3.10 — QUICK BULK PROXY IMPORT (by profile order) =================
test('index.html loads the bulk-proxy parser before the renderer', () => {
  const html = read('ui-phom/index.html');
  assert.match(html, /bulk-proxy\.js/);
  assert.ok(html.indexOf('bulk-proxy.js') < html.indexOf('phom-qa.js'));
});

test('SETUP omits quick proxy import while retaining the profile table', () => {
  const setup = fn(js, 'renderSetup');
  assert.doesNotMatch(setup, /bulkProxyQuickPanel\(\)|bulkProxyPanel\(\)/);
  assert.match(setup, /profileTablePanel\(\)/);
});

test('the per-row ⚡ Quick Proxy (Edit Profile) remains available alongside the bulk importer', () => {
  assert.match(js, /id: 'pf-proxy'/);            // per-profile proxy in the Edit modal
  assert.match(js, /api\.profileSetProxy\(pid/); // still wired
});

test('the profile table shows a COMPACT proxy (TYPE host:port · auth) — never the password', () => {
  assert.match(js, /px\.protocol \? px\.protocol\.toUpperCase\(\)/);
  assert.match(js, /px\.endpoint/);
  assert.match(js, /px\.hasAuth \? ' · auth' : ''/);
  // the proxy CELL block itself never references a password/secret (scoped to the cell, not the whole file).
  const at = js.indexOf('// PHASE 6.3.10 — compact proxy display');
  const cellBlock = js.slice(at, at + 500);
  assert.equal(/password|passwordSecretRef/.test(cellBlock), false, 'the proxy cell never references a password');
});
