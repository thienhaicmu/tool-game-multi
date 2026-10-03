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

test('CSS defines the standard status token colors (good/warn/bad/primary)', () => {
  for (const t of ['--primary', '--good', '--warn', '--bad']) assert.match(css, new RegExp(t + ':'));
});

test('no 2×2 browser placeholder cells in CSS or JS', () => {
  assert.equal(/\.grid2x2|\.cell-body|\.cell\.control/.test(css), false);
  assert.equal(/grid2x2/.test(js), false);
});

test('SETUP = the profile table (scrolls inside its panel) + the footer; Game URL is per-profile, NO global input', () => {
  const setup = js.slice(js.indexOf('function renderSetup(r) {'), js.indexOf('function profileTablePanel('));
  assert.match(setup, /profileTablePanel\(\)/);
  assert.match(setup, /runGameFooter\(\)/);
  assert.equal(/bulkProxyPanel\(\)|gamePanel\(\)|panelGeneral\(\)|s1-host|CỤM/.test(setup), false);
  assert.match(js, /'Game URL'/);
  assert.match(js, /id: 'pf-url'/);
});

test('PHASE 6.3.1 — SETUP is a device-profiles TABLE with in-row checkbox selection (§9/§10/§12/§13)', () => {
  assert.match(js, /function profileTablePanel\(\)/);
  assert.match(js, /function profileRow\(p\)/);
  assert.match(js, /class: 'setup-table'/);
  assert.match(js, /'Thêm profile'/);
  // the checkbox is the selection UI; order → B1/B2/B3 via ProfileSelection
  assert.match(js, /PS\.toggle\(selectedProfileIds, p\.id\)/);
  assert.match(js, /PS\.browserOf\(selectedProfileIds, p\.id\)/);
  // no B1/B2/B3 dropdowns, no separate selected-profiles panel
  assert.equal(/Browser 1.*dropdown|selected-profiles-panel|B1 \[dropdown\]/.test(js), false, 'no second selection UI');
  // RUN GAME opens the SELECTED profiles (order → B1/B2/B3), not a fixed cluster
  assert.match(js, /api\.openSelected\(\{ profileIds: selectedProfileIds/);
});

