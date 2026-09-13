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

test('exactly one primary open-cluster CTA in Setup', () => {
  const ctaClass = (js.match(/cta-open/g) || []).length;
  assert.ok(ctaClass >= 1, 'cta-open class used');
  assert.equal((js.match(/'MỞ 3 TRÌNH DUYỆT'/g) || []).length, 1, 'single open-cluster CTA label');
});

test('Setup renders the Quick 3-proxy panel and its actions', () => {
  assert.match(js, /THIẾT LẬP NHANH 3 PROXY/);
  assert.match(js, /ÁP DỤNG 3 PROXY/);
  assert.match(js, /TEST TẤT CẢ/);
  assert.match(js, /qp-proto/);
  assert.match(js, /qp-text/);
  assert.match(js, /renderQuickProxy\(r\)/);
});

test('preload exposes proxyQuickApply and the renderer calls it', () => {
  assert.match(preload, /proxyQuickApply:/);
  assert.match(preload, /phom:proxy-quick-apply/);
  assert.match(js, /api\.proxyQuickApply\(/);
});

test('HOST/action controls appear in Control mode, NOT in Setup', () => {
  const setupStart = js.indexOf('function renderSetup(r) {');
  const setupEnd = js.indexOf('// ---- cluster profiles');
  assert.ok(setupStart > 0 && setupEnd > setupStart, 'located renderSetup body');
  const setupBody = js.slice(setupStart, setupEnd);
  // no live/host controls leak into Setup
  assert.equal(/HOST tìm bàn|ReJoin bị kick|Rời tất cả|BA TAY BÀI/.test(setupBody), false);
  // but they exist in the Control renderer
  const controlStart = js.indexOf('function renderControl(r) {');
  const controlBody = js.slice(controlStart, controlStart + 4000);
  assert.match(controlBody, /HOST tìm bàn/);
  assert.match(controlBody, /Dừng cụm/);
});

test('the quick-proxy textarea is cleared after apply (no lingering credentials in the DOM)', () => {
  assert.match(js, /\$\('qp-text'\)\.value = ''/);
});

test('the proxy edit modal never populates an existing password field', () => {
  // password input has no value bound from stored config (placeholder only)
  assert.match(js, /id:\s*'px-pass',\s*type:\s*'password'/);
  assert.equal(/id:\s*'px-pass'[^)]*value:/.test(js), false);
});
