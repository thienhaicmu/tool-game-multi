// PHASE 6.3.3.3 — SAFE CARD ANALYZER wiring (source-level, no GUI). The analyzer runs read-only in main
// over the observer snapshot, exposed via a minimal IPC + preload bridge; Screen 2 owns the ONE-of-three
// target selection, re-analyses on every card snapshot (event-driven), clears on round change, and adds no
// game-action. Confirms the diff never touches the play/send/click pipeline (§28).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const main = read('desktop/phom-main.cjs');
const preload = read('desktop/phom-preload.cjs');
const js = read('ui-phom/phom-qa.js');
function rfn(name) { const s = js.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = js.slice(s + 1); const m = rest.indexOf('\n  function '); return rest.slice(0, m > 0 ? m : 4000); }

test('main runs the analyzer READ-ONLY over the observer snapshot for one target uid', () => {
  assert.match(main, /require\('\.\/protocol\/phom\/phom-safe-card-analyzer\.cjs'\)/);
  assert.match(main, /const safeCardAnalyzer = createSafeCardAnalyzer\(\)/);
  assert.match(main, /ipcMain\.handle\('phom:analyze-safe-cards', \(_e, targetPlayerUid\) =>/);
  assert.match(main, /safeCardAnalyzer\.analyze\(\{ snapshot, targetPlayerUid \}\)/);
  // the snapshot comes from the EXISTING observer accessor (no second observation)
  assert.match(main, /phomSessions\.cardObserverSnapshot\(\)/);
});

test('preload bridges analyzeSafeCards(targetUid) → phom:analyze-safe-cards', () => {
  assert.match(preload, /analyzeSafeCards: \(targetPlayerUid\) => ipcRenderer\.invoke\('phom:analyze-safe-cards', targetPlayerUid\)/);
});

test('Screen 2 owns a ONE-of-three player selector (never ALL / combine / merge) resolving slot → uid', () => {
  const sel = rfn('playerAnalysisSelector');
  assert.match(sel, /\['B1', 'B2', 'B3'\]/);       // exactly the three players (B1/B2/B3)
  assert.match(sel, /'B' \+ \(i \+ 1\)/);          // PHASE 6.3.9 — labelled B1/B2/B3 (matches the mockup)
  // PHASE 6.3.9 — "Tất cả" is the DEFAULT no-target state (selectedAnalysisPlayer = null): it shows the
  // aggregate remaining view but NEVER merges the three hands for the per-player SAFE analysis (§20).
  assert.match(sel, /selectedAnalysisPlayer = null;.*'Tất cả'|'Tất cả'/);
  assert.match(sel, /selectedAnalysisPlayer = null/);
  // no MERGED-hand option anywhere (a combined/team hand is never fed to the analyzer).
  assert.equal(/mergedHand|combinedHand|B1 \+ B2 \+ B3|P1\+P2\+P3/.test(js), false, 'no merged-hand option');
  // the selection resolves through the authoritative slot→uid binding, not a browser index
  const refresh = rfn('refreshSafeAnalysis');
  assert.match(refresh, /cardsSnap\.slotBinding\[slot\]/);
  assert.match(refresh, /api\.analyzeSafeCards\(uid\)/);
});

test('the analysis re-runs on every card snapshot (event-driven push + pull) — not a timer', () => {
  // push: a fresh phom:cards snapshot triggers a re-analyse
  assert.match(js, /api\.onCards\(\(c\) => \{ cardsSnap = c \|\| null; refreshSafeAnalysis\(\)/);
  // pull: refreshManual re-analyses off the pulled snapshot
  assert.match(js, /await refreshSafeAnalysis\(\);/);
  // selection change also re-analyses immediately (event-driven, no wait for the next tick)
  assert.match(js, /refreshSafeAnalysis\(\)\.then\(\(\) => bgRender\(\)\)/);
});

test('empty / waiting / insufficient states are explicit (no fabricated numbers) — §24', () => {
  const body = rfn('renderSafeBody');
  assert.match(body, /Chọn B1 \/ B2 \/ B3 để xem lá an toàn/); // PHASE 6.3.9 — "Tất cả" (no target) prompts a pick
  assert.match(body, /ĐANG CHỜ DỮ LIỆU BÀI/);
  assert.match(body, /CHƯA ĐỦ DỮ LIỆU/);
  // transparency line present
  assert.match(js, /Phân tích từ dữ liệu công khai đã quan sát/);
});

test('the phase adds NO game-action wiring to the renderer analyzer path (§28)', () => {
  // the selector + analysis functions never send/join/find/play/click
  for (const name of ['renderSafeCards', 'playerAnalysisSelector', 'renderSafeBody', 'refreshSafeAnalysis']) {
    const body = rfn(name);
    assert.equal(/manualEnterGame|onManualJoin|onManualLeave|onManualFind|headerAction|sendPlay|\.click\(/.test(body), false, `${name} has no game action`);
  }
});
