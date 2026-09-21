// PHASE 6.3.3.2 — wiring assertions (source-level, no GUI): the card observer is fed from the EXISTING
// ingest path (no second WS listener), exposed through a minimal IPC (phom:cards, pull + push) and the
// preload bridge, and consumed read-only by Screen 2 (LÁ BÀI CÒN LẠI uses observed data; LÁ BÀI AN TOÀN
// stays a placeholder; the three hands are never merged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
const mgr = read('desktop/protocol/phom/host-session-manager.cjs');
const main = read('desktop/phom-main.cjs');
const preload = read('desktop/phom-preload.cjs');
const js = read('ui-phom/phom-qa.js');
function rfn(name) { const s = js.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = js.slice(s + 1); const m = rest.indexOf('\n  function '); return rest.slice(0, m > 0 ? m : 4000); }

test('the observer is fed from the EXISTING coordinator.ingest (no second WS listener / CDP)', () => {
  assert.match(coord, /require\('\.\/phom-card-observer\.cjs'\)/);
  assert.match(coord, /this\._cardObserver = createCardObserver\(/);
  // fed inside ingest(), with the browser SLOT + the AUTHORITATIVE own uid (ctx.uid()), not the index
  assert.match(coord, /this\._cardObserver\.ingestFrame\(\{ slot:[^\n]*ownUid: rec\.ctx\.uid\(\)/);
  assert.match(coord, /cardObserverSnapshot\(\) \{ return this\._cardObserver\.getSnapshot\(\); \}/);
  // only ONE new observer instance (no duplicate stacks)
  assert.equal((coord.match(/createCardObserver\(/g) || []).length, 1);
});

test("the coordinator emits a 'cards' snapshot which the session manager re-emits + delegates", () => {
  assert.match(coord, /this\.emit\('cards', this\.cardObserverSnapshot\(\)\)/);
  assert.match(mgr, /coord\.on\('cards', \(cards\) => this\.emit\('cards', cards\)\)/);
  assert.match(mgr, /cardObserverSnapshot\(\) \{[^\n]*c\.cardObserverSnapshot\(\)/);
});

test('cards reach the screen inside ONE coalesced ui snapshot (pull + push), not four separate IPCs', () => {
  // main still exposes the raw card snapshot for diagnostics, but the SCREEN is served by phom:ui-snapshot /
  // 'phom:ui', which carries browsers + group + cards + remaining + the three analyses in a single message.
  assert.match(main, /ipcMain\.handle\('phom:cards'/);
  assert.match(main, /function phomUiSnapshot\(\)/);
  assert.match(main, /ipcMain\.handle\('phom:ui-snapshot'/);
  assert.match(main, /function scheduleCardsBroadcast\(/);
  assert.match(main, /send\('phom:ui', phomUiSnapshot\(\)\)/);
  assert.match(main, /analyses\[slot\] = safeCardAnalyzer\.analyze\(/); // the analyzer runs in MAIN, memoised
  assert.match(preload, /uiSnapshot: \(\) => ipcRenderer\.invoke\('phom:ui-snapshot'\)/);
  assert.match(preload, /onUi: \(cb\) => ipcRenderer\.on\('phom:ui'/);
});

