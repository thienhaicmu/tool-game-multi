import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// §10 / §13 / §17.E — light theme + setup-first structure. These are source-level
// assertions (no DOM runtime in CI): the renderer wiring and CSS tokens must reflect a
// light, setup-first, single-CTA tool with the Quick Proxy panel and NO browser
// placeholders / per-slot open buttons.

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const css = read('ui-phom/phom-qa.css');
const js = read('ui-phom/phom-qa.js');
const preload = read('desktop/phom-preload.cjs');

test('CSS is light: color-scheme light, no dark root, light bg token', () => {
  assert.match(css, /color-scheme:\s*light/);
  assert.equal(/color-scheme:\s*dark/.test(css), false);
  assert.match(css, /--bg:\s*#e|--bg:\s*#f/i); // very light background token
  // no leftover dark app background
  assert.equal(/background:\s*#0b0f1a/.test(css), false);
});

test('CSS defines the standard status token colors (success/warning/error/primary)', () => {
  for (const t of ['--primary', '--success', '--warning', '--error']) assert.match(css, new RegExp(t.replace('--', '--') + ':'));
});

test('no 2×2 browser placeholder cells in CSS or JS', () => {
  assert.equal(/\.grid2x2|\.cell-body|\.cell\.control/.test(css), false);
  assert.equal(/grid2x2/.test(js), false);
});

test('exactly one primary RUN GAME CTA in Setup (Screen 1)', () => {
  const ctaClass = (js.match(/cta-open/g) || []).length;
  assert.equal(ctaClass, 1, 'single cta-open button');
  assert.match(js, /RUN GAME — MỞ 3 TRÌNH DUYỆT/, 'RUN GAME CTA label');
});

test('Screen 1 has a single shared LINK GAME input (not three URLs) + HOST on the same row', () => {
  assert.match(js, /phq-gameurl/);
  assert.equal((js.match(/id: 'phq-gameurl'/g) || []).length, 1, 'exactly one game URL input');
  // Cluster + HOST + shared Link live in the CẤU HÌNH CHUNG panel; no per-slot URLs.
  assert.match(js, /function panelGeneral\(\)/);
  assert.match(js, /CẤU HÌNH CHUNG/);
  assert.match(js, /s1-host/);
  assert.equal(/LINK GAME \(DÙNG CHUNG A\/B\/C\)/.test(js), false, 'old tall LINK GAME section removed');
});

test('Setup renders the Quick 3-proxy panel as 3 labeled rows (no A=/B=/C= prefix)', () => {
  assert.match(js, /THIẾT LẬP NHANH 3 PROXY/);
  assert.match(js, /ÁP DỤNG 3 PROXY/);
  assert.match(js, /TEST TẤT CẢ/);
  assert.match(js, /qp-proto-/);   // per-slot protocol selector
  assert.match(js, /qp-in-/);      // per-slot input
  assert.match(js, /function panelQuickProxy\(\)/);
  // placeholder is a plain host|port form — NO A=/B=/C= prefix requested from the user.
  assert.match(js, /không cần A= B= C=/);
  assert.match(js, /host\|port\|user\|password/);
});

test('Screen 1 is a TWO-COLUMN grid: left = general + assigned devices/proxy, right = quick proxy + RUN GAME', () => {
  // CSS grid with two columns (1fr / 0.95fr) — NOT a single full-width column.
  assert.match(css, /\.setup\s*\{[^}]*display:\s*grid/);
  assert.match(css, /grid-template-columns:\s*1fr\s+0\.95fr/);
  // left column has EXACTLY the two panels; right has quick-proxy + footer.
  assert.match(js, /function panelAssigned\(\)/);
  assert.match(js, /THIẾT BỊ VÀ PROXY ĐÃ GÁN/);
  assert.match(js, /left\.appendChild\(panelGeneral\(\)\)/);
  assert.match(js, /left\.appendChild\(panelAssigned\(\)\)/);
  assert.match(js, /right\.appendChild\(panelQuickProxy\(\)\)/);
  assert.match(js, /right\.appendChild\(footerRunGame\(\)\)/);
});

test('Screen 1 assigned rows are DISPLAY-only (no duplicate proxy selector/Test in each profile)', () => {
  assert.match(js, /function assignedRow\(slot\)/);
  const rowStart = js.indexOf('function assignedRow(slot) {');
  const rowBody = js.slice(rowStart, rowStart + 1200);
  assert.equal(/proxySelector\(slot\)/.test(rowBody), false, 'no proxy <select> inside the assigned row');
  assert.equal(/testProxy\(slot\)/.test(rowBody), false, 'no per-row Test button (Quick Proxy is the config place)');
  assert.match(rowBody, /ar-px/);      // shows the ASSIGNED proxy (redacted) as text
  // Proxy is OPTIONAL: a slot with no proxy shows a neutral DIRECT badge, NOT an error.
  assert.match(rowBody, /'DIRECT'/);
  assert.equal(/NO_PROXY/.test(js), false, 'no NO_PROXY error state anywhere (proxy is optional)');
  // no per-profile "open game" button anywhere.
  assert.equal(/Mở game/.test(js), false);
});

test('Screen 1 has exactly ONE ⋯ menu (cluster management) and no stray unlabeled menus', () => {
  // one cluster-management menu in panelGeneral; assigned rows carry no ⋯ proxy menu now.
  assert.match(js, /Tạo cụm/); assert.match(js, /Sửa cụm/); assert.match(js, /Nhân bản/); assert.match(js, /Xóa cụm/);
  const genStart = js.indexOf('function panelGeneral() {');
  const genBody = js.slice(genStart, js.indexOf('function panelAssigned'));
  assert.equal((genBody.match(/qa-more-menu/g) || []).length, 1, 'exactly one management menu in the general panel');
});

// BROWSER LIFETIME INDEPENDENCE — DỪNG stops orchestration only (never closes browsers);
// only the explicit ĐÓNG 3 TRÌNH DUYỆT closes them; RUN GAME waits for login.
test('DỪNG is orchestration-only; browser close is a separate explicit action', () => {
  // DỪNG button calls stopOrchestration (NOT clusterStop/closeBrowsers).
  assert.match(js, /onclick:\s*stopOrchestration\s*}[^]*?'DỪNG'/);
  assert.match(js, /function stopOrchestration\(\)/);
  const stopOrch = js.slice(js.indexOf('async function stopOrchestration()'), js.indexOf('async function closeBrowsers()'));
  assert.match(stopOrch, /api\.orchestrationStop\(\)/);
  assert.equal(/api\.closeBrowsers|api\.clusterStop|closeRun/.test(stopOrch), false, 'DỪNG must not close browsers');
  // the explicit close action exists and is confirmed.
  assert.match(js, /function closeBrowsers\(\)/);
  assert.match(js, /ĐÓNG 3 TRÌNH DUYỆT/);
  assert.match(js, /window\.confirm\(/);
  // WAITING_FOR_LOGIN gate: awaitingLogin + ĐÃ LOGIN — TIẾP TỤC, and TÌM BÀN gated on it.
  assert.match(js, /awaitingLogin\s*=\s*true/);
  assert.match(js, /ĐÃ LOGIN — TIẾP TỤC/);
  assert.match(js, /function ctaEnabled\(\)[^]*!awaitingLogin/);
});

// PROXY OPTIONAL (§4/§5): neither RUN GAME (setupReady) nor TÌM BÀN (ctaEnabled) may be
// gated on a proxy. RUN GAME requires cluster profile + gameUrl + device only.
test('RUN GAME + TÌM BÀN are NOT proxy-gated (proxy is optional)', () => {
  const setup = js.slice(js.indexOf('function setupReady()'), js.indexOf('function setupReason()'));
  assert.equal(/proxyRef|proxiesReady|testState/.test(setup), false, 'setupReady must not require a proxy');
  assert.match(setup, /selectedClusterProfileId/);
  assert.match(setup, /gameUrl/);
  assert.match(setup, /device/);
  const cta = js.slice(js.indexOf('function ctaEnabled()'), js.indexOf('function ctaReason'));
  assert.equal(/proxiesReady|proxyRef|testState/.test(cta), false, 'ctaEnabled must not require a proxy');
  assert.equal(/function proxiesReady/.test(js), false, 'the proxy-required gate helper is gone');
  // applying quick proxies uses the partial (optional) path.
  assert.match(js, /partial:\s*true/);
});

test('preload exposes proxyQuickApply and the renderer calls it', () => {
  assert.match(preload, /proxyQuickApply:/);
  assert.match(preload, /phom:proxy-quick-apply/);
  assert.match(js, /api\.proxyQuickApply\(/);
});

test('Screen 2 is a minimal command toolbar + LIVE QA MONITOR (no manual flow buttons)', () => {
  const setupStart = js.indexOf('function renderSetup(r) {');
  const setupEnd = js.indexOf('// ---- cluster profiles');
  assert.ok(setupStart > 0 && setupEnd > setupStart, 'located renderSetup body');
  const setupBody = js.slice(setupStart, setupEnd);
  assert.equal(/HOST tìm bàn|ReJoin bị kick|Rời tất cả|BA TAY BÀI/.test(setupBody), false);
  // Screen 2 command toolbar has only TÌM BÀN (+stake) / Focus / ⋯ / DỪNG.
  assert.match(js, /function commandToolbar\(s\)/);
  assert.match(js, /TÌM BÀN · CHỌN CƯỢC/);
  assert.match(js, />⋯</.test(js) ? /⋯/ : /'⋯'/);
  assert.match(js, /'DỪNG'/);
  // the LIVE QA MONITOR (D simulated, fixture/replay) is the main region.
  assert.match(js, /LIVE QA MONITOR/);
  assert.match(js, /D — MÔ PHỎNG · FIXTURE\/REPLAY/);
  assert.match(js, /function liveMonitor\(/);
  // the old per-step manual buttons are GONE from the Control renderer (auto flow now).
  const controlStart = js.indexOf('function renderControl(r) {');
  const controlBody = js.slice(controlStart, controlStart + 600);
  assert.equal(/HOST tìm bàn|Follower vào bàn|'Sẵn sàng'|ReJoin bị kick/.test(controlBody), false);
});

test('the quick-proxy inputs are cleared after apply (no lingering credentials in the DOM)', () => {
  assert.match(js, /\$\('qp-in-' \+ s\)/);
  assert.match(js, /el2\.value = ''/);
});

test('stake modal shows a friendly loading message, not a raw typed code, in the focused UI', () => {
  assert.match(js, /Đang chờ danh sách mức cược từ game/);
  // the typed code is only a tiny advanced hint (class ft-code), never the main text.
  assert.match(js, /class: 'ft-code'/);
  // stake list is polled from the authoritative channel seam (no hard-coded stakes).
  assert.match(js, /api\.stakeChannels\(\)/);
});

test('LIVE QA MONITOR ROW 1 uses the engine cardsNotInMeld (renderer never recomputes)', () => {
  assert.match(js, /snap\.cardsNotInMeld/);
  // renderer must NOT rebuild the complement from hand.cards itself.
  assert.equal(/snap\.hand\.cards\.filter\(\(c\) => !meldCards/.test(js), false);
});

test('Screen 1 has NO stake input (stake is chosen only at Find Table)', () => {
  const setupStart = js.indexOf('function renderSetup(r) {');
  const setupEnd = js.indexOf('// ---- Quick 3-proxy');
  const setupArea = js.slice(setupStart, setupEnd > setupStart ? setupEnd : setupStart + 4000);
  assert.equal(/phq-setstake|phq-stake|Mức cược/.test(js.slice(js.indexOf('function renderGameLink'), js.indexOf('function renderGameLink') + 1200)), false, 'no stake input in the game-link section');
  // stake only appears in the Find-Table modal (openFindTable).
  assert.match(js, /function openFindTable\(/);
  assert.match(js, /TÌM BÀN TRỐNG/);
  assert.match(js, /ft-stake/);
});

test('the proxy edit modal never populates an existing password field', () => {
  // password input has no value bound from stored config (placeholder only)
  assert.match(js, /id:\s*'px-pass',\s*type:\s*'password'/);
  assert.equal(/id:\s*'px-pass'[^)]*value:/.test(js), false);
});
