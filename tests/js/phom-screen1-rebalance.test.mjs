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

test('the profile table shows the P1/P2/P3 badge of each ticked profile, from browserOf', () => {
  const rowFn = fn('profileRow');
  assert.match(rowFn, /PS\.browserOf\(selectedProfileIds, p\.id\)/); // selection order is still the source
  assert.match(rowFn, /el\('span', \{ class: 'p-badge'[\s\S]*?\}, playerLabel\(bLabel\)\)/);
});

// ---- OBJECTIVE A — layout rebalance: table is the flexible primary area, no page-scroll dependency ----
test('the profile table panel is the FLEXIBLE primary area (flex-grows + scrolls internally)', () => {
  const panel = fn('profileTablePanel');
  assert.match(panel, /class: 'panel profile-panel'/);
  assert.match(css, /\.profile-panel \{[^}]*flex: 1 1 auto[^}]*min-height: 0/);
  assert.match(css, /\.table-scroll \{[^}]*flex: 1 1 auto[^}]*overflow: auto/);
  assert.match(css, /\.setup-table th \{[^}]*position: sticky/, 'the column header stays visible while scrolling');
});

test('the footer is a sibling of the table panel (always visible, never scrolled out)', () => {
  const setup = fn('renderSetup');
  assert.match(setup, /r\.appendChild\(profileTablePanel\(\)\);\s*r\.appendChild\(runGameFooter\(\)\);/);
  assert.match(css, /\.bar \{[^}]*flex: 0 0 auto/);
});

test('no separate selected-profile panel / cluster (CỤM) section in the SETUP render', () => {
  const setup = fn('renderSetup');
  assert.equal(/panelGeneral\(\)|panelAssigned\(\)|CỤM|selected-profiles-panel/.test(setup), false);
  const panel = fn('profileTablePanel');
  assert.match(panel, /'Thêm profile'/);
  assert.match(panel, /tick 3 profile → P1 · P2 · P3/);
});
