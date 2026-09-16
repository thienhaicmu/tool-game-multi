// PHASE 6.3.3.1 — SCREEN 1 SETUP rebalance + user-facing "Player 1/2/3" naming. Source + CSS assertions
// (no GUI runtime): the DEVICE PROFILES table is the FLEXIBLE primary area (fills unused height, scrolls
// internally) so the proxy block + footer stay put without page-level scrolling; the three runtime browsers
// are labelled "Player N" everywhere they are shown, while the INTERNAL slot ids stay B1/B2/B3 (§14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const css = read('ui-phom/phom-qa.css');
const sel = read('ui-phom/profile-selection.js');
function fn(name) { const s = js.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = js.slice(s + 1); const m = rest.indexOf('\n  function '); return rest.slice(0, m > 0 ? m : 4000); }

// ---- OBJECTIVE B — user-facing Player naming (B1/B2/B3 stay as INTERNAL ids only) ----
test('a display-only playerLabel maps internal B1/B2/B3 → "Player 1/2/3" (browserOf unchanged)', () => {
  assert.match(js, /const playerLabel = /);
  // internal selection logic still speaks B1/B2/B3 (stable slot ids, §14) — NOT renamed
  assert.match(sel, /'B' \+ \(i \+ 1\)/);
  // the renderer never SHOWS a raw "B1"/"B2"/"B3" badge — it maps through playerLabel
  const rowFn = fn('profileRow');
  assert.match(rowFn, /playerLabel\(bLabel\)/);
  assert.equal(/'b-badge' \}, bLabel\)/.test(rowFn), false, 'raw B# badge must go through playerLabel');
});

test('Screen 1 profile table exposes a PLAYER column (not a bare "#") and keeps browserOf as the source', () => {
  const panel = fn('profileTablePanel');
  assert.match(panel, /'PLAYER'/);
  const rowFn = fn('profileRow');
  assert.match(rowFn, /PS\.browserOf\(selectedProfileIds, p\.id\)/); // selection order is still the source
});

test('the bulk-proxy selection preview + error use the Player label (not B#)', () => {
  const bp = fn('bulkProxyPanel');
  assert.match(bp, /`Player \$\{i \+ 1\} → /);
  const ab = fn('applyBulkProxy');
  assert.match(ab, /playerLabel\(m\.browser\)/);
});

test('Screen 2 compact browser chip is labelled "Player N" (was "B" + index)', () => {
  const cell = fn('compactBrowserCell');
  assert.match(cell, /'Player ' \+ index/);
  assert.equal(/'B' \+ index/.test(cell), false, 'Screen 2 no longer shows raw B#');
});

// ---- OBJECTIVE A — layout rebalance: table is the flexible primary area, no page-scroll dependency ----
test('the profile table panel is the FLEXIBLE primary area (flex-grows + scrolls internally)', () => {
  const panel = fn('profileTablePanel');
  assert.match(panel, /class: 'setup-panel profile-panel'/);
  assert.match(css, /\.profile-panel \{[^}]*flex: 1 1 auto[^}]*min-height/);
  assert.match(css, /\.profile-panel \.table-scroll \{[^}]*flex: 1 1 auto[^}]*overflow-y: auto/);
});

test('secondary config (proxy/runtime) stays compact so it never eats the workspace (§5)', () => {
  assert.match(css, /\.setup-page > \.setup-panel:not\(\.profile-panel\) \{[^}]*flex: 0 0 auto/);
});

test('the footer is a sibling of the scroll page (always accessible, never scrolled out) (§19)', () => {
  const setup = fn('renderSetup');
  // footer is appended to the tab-content root (r), NOT inside setup-page → it stays pinned
  assert.match(setup, /r\.appendChild\(runGameFooter\(\)\)/);
  assert.match(css, /\.setup-footer \{[^}]*flex: 0 0 auto/);
});

test('no separate selected-profile panel / cluster (CỤM) section in the SETUP render (§10)', () => {
  const setup = fn('renderSetup');
  assert.equal(/panelGeneral\(\)|panelAssigned\(\)|CỤM|selected-profiles-panel/.test(setup), false);
  // the toolbar (ADD PROFILE + count) lives in the table panel section-header
  const panel = fn('profileTablePanel');
  assert.match(panel, /THÊM PROFILE/);
  assert.match(panel, /ĐÃ CHỌN/);
});
