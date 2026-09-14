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

test('Screen 1 has a single shared LINK GAME input (not three URLs)', () => {
  assert.match(js, /LINK GAME \(DÙNG CHUNG A\/B\/C\)/);
  assert.match(js, /phq-gameurl/);
  assert.equal((js.match(/phq-gameurl/g) || []).length >= 1, true);
  assert.match(js, /renderGameLink\(r\)/);
});

test('Setup renders the Quick 3-proxy panel as 3 labeled rows (no A=/B=/C= prefix)', () => {
  assert.match(js, /THIẾT LẬP NHANH 3 PROXY/);
  assert.match(js, /Áp dụng 3 proxy/);
  assert.match(js, /Test tất cả/);
  assert.match(js, /qp-proto-/);   // per-slot protocol selector
  assert.match(js, /qp-in-/);      // per-slot input
  assert.match(js, /renderQuickProxy\(r\)/);
  // placeholder is a plain host|port form — NO A=/B=/C= prefix requested from the user.
  assert.match(js, /không nhập A= B= C=/);
  assert.match(js, /host\|port\|user\|password/);
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
  // Screen 2 command toolbar has only TÌM BÀN / Focus / ⋯ / DỪNG.
  assert.match(js, /function commandToolbar\(s\)/);
  assert.match(js, /'TÌM BÀN'/);
  assert.match(js, />⋯</.test(js) ? /⋯/ : /'⋯'/);
  assert.match(js, /'DỪNG'/);
  // the QA RULE MONITOR (D simulated) is the main region.
  assert.match(js, /QA RULE MONITOR · D MÔ PHỎNG/);
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
