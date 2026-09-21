// PHASE 6.3.3 — Screen 2 compact browser header + dominant card workspace. UI/layout only (source + CSS
// assertions; no behavior). B1/B2/B3 = one compact row; RID shown once; cards get the growing space.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const css = read('ui-phom/phom-qa.css');
function fn(name) { const s = js.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = js.slice(s + 1); const m = rest.indexOf('\n  function '); return rest.slice(0, m > 0 ? m : 4000); }

test('3. shared RID appears ONCE (tool header), never repeated in the three chips', () => {
  const header = fn('compactHeader');
  assert.match(header, /manualCluster\.sharedRid/);      // RID shown once, in the header
  const cell = fn('compactBrowserCell');
  // the chip does not DISPLAY a RID value (no ridText / no 'RID:' label / no infoRow('RID'))
  assert.equal(/ridText|'RID:'|infoRow\('RID'/.test(cell), false, 'no per-chip RID value displayed');
});

test('4. the card workspace is flex-growing and holds both card sections', () => {
  const ws = fn('renderCardWorkspace');
  assert.match(ws, /card-workspace/);
  assert.match(ws, /renderSafeCards\(\)/);
  assert.match(ws, /renderRemainingCards\(\)/);
  // PHASE 6.3.9 — the two card panels are SIDE-BY-SIDE (row); each panel scrolls its own cards.
  assert.match(css, /\.card-workspace \{[^}]*flex: 1 1 auto[^}]*flex-direction: row/);
  // control mode is a flex column so the workspace can grow; root doesn't double-scroll
  assert.match(css, /#phq-root\.mode-control \{[^}]*overflow: hidden/);
});

test('6. LÁ BÀI CÒN LẠI (CARDS REMAINING) remains, rendering the backend result unchanged', () => {
  const rem = fn('renderRemainingCards');
  assert.match(rem, /CARDS REMAINING/);
  assert.match(rem, /remaining\.cards/);
  assert.match(rem, /remaining\.count/);
});

