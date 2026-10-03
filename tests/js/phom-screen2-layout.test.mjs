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

test('3. the số bàn appears ONCE (status line), never repeated in the three player cards', () => {
  assert.match(fn('statusLine'), /const rid = g && g\.rid != null \? g\.rid : sharedRid;/);
  const card = fn('playerCard');
  assert.equal(/\brid\b|'RID|Số bàn/.test(card), false, 'no per-card table number');
});

test('4. compact player cards; the tabbed LỌC BÀI panel takes the free height (one account at full width)', () => {
  assert.match(css, /\.players \{[^}]*flex: 0 0 auto/);
  assert.match(css, /\.safe-panel \{[^}]*flex: 1 1 auto[^}]*min-height: 0/);
  assert.match(css, /\.safe \{[^}]*flex: 1 1 auto[^}]*overflow-y: auto/);
  assert.match(css, /\.pc-label \{[^}]*text-overflow: ellipsis/, 'a long state is cut with … (full text in the tooltip), never overlapping');
  assert.match(css, /\.pc-res-actions \{[^}]*flex-wrap: wrap/, 'a reserve card\'s buttons wrap instead of overflowing');
  assert.match(css, /\.safe \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(200px, 1fr\)\)/, 'LỌC BÀI groups side by side: a full hand fits one screen');
  assert.match(css, /#phq-root \{[^}]*flex-direction: column[^}]*overflow: hidden/);
});

test('6. LÁ BÀI CÒN LẠI is only a count in the status line', () => {
  assert.match(fn('remainingCount'), /remaining\.count/);
  assert.match(fn('statusLine'), /remainingCount\(\)/);
});

