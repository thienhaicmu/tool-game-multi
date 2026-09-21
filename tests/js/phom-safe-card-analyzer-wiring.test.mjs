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

