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

test('1. B1/B2/B3 are siblings in ONE horizontal browser-row (not three vertical panels)', () => {
  const row = fn('compactBrowserRow');
  assert.match(row, /class: 'browser-row'/);
  assert.match(row, /SLOTS\.forEach\(\(slot, i\) => .*compactBrowserCell\(i \+ 1, slot, assign\[slot\]\.runId\)/);
  // the row is a flex row and each cell is a compact horizontal chip (row direction, small padding)
  assert.match(css, /\.browser-row \{[^}]*display: flex/);
  assert.match(css, /\.browser-cell \{[^}]*flex-direction: row[^}]*align-items: center/);
});

test('2. the browser chip is compact — no tall min-height, no per-cell info-row block', () => {
  assert.match(css, /\.browser-cell \{[^}]*min-height: 0/);
  const cell = fn('compactBrowserCell');
  assert.equal(/bc-body|bc-readonly|bc-meta/.test(cell), false, 'no tall body/meta block in the compact chip');
});

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
  assert.match(css, /\.card-workspace \{[^}]*flex: 1 1 auto[^}]*overflow-y: auto/);
  // control mode is a flex column so the workspace can grow; root doesn't double-scroll
  assert.match(css, /#phq-root\.mode-control \{[^}]*overflow: hidden/);
});

test('5. LÁ BÀI AN TOÀN section is present (placeholder region; no card logic added)', () => {
  const safe = fn('renderSafeCards');
  assert.match(safe, /LÁ BÀI AN TOÀN/);
  assert.match(safe, /section-t/);
  // it is a UI placeholder only — no card computation / no analysis controls
  assert.equal(/remaining\.|findMelds|analyze|safeCardsCompute/.test(safe), false, 'no card logic in the placeholder');
});

test('6. LÁ BÀI CÒN LẠI (CARDS REMAINING) remains, rendering the backend result unchanged', () => {
  const rem = fn('renderRemainingCards');
  assert.match(rem, /CARDS REMAINING/);
  assert.match(rem, /remaining\.cards/);
  assert.match(rem, /remaining\.count/);
});

test('7. Screen 2 remains read-only — no game action WIRING reintroduced (status labels are not buttons)', () => {
  const cell = fn('compactBrowserCell');
  // status LABELS may contain "VÀO GAME" as text (e.g. "ĐÃ VÀO GAME"); what must NOT exist is action wiring.
  assert.equal(/manualEnterGame\(|onManualJoinShared\(|onManualLeave\(|onManualFind\(|betFindGroup\(|actionButton\(|emit\(/.test(cell), false, 'no game-action handlers wired into the chip');
});
