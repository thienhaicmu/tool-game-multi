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

test('main exposes a minimal phom:cards IPC (pull) + a throttled push; preload bridges both', () => {
  assert.match(main, /ipcMain\.handle\('phom:cards'/);
  assert.match(main, /phomSessions\.on\('cards', \(cards\) => \{ scheduleCardsBroadcast\(cards\); \}\)/);
  assert.match(main, /function scheduleCardsBroadcast\(/);
  assert.match(main, /send\('phom:cards'/);
  assert.match(preload, /cardsSnapshot: \(\) => ipcRenderer\.invoke\('phom:cards'\)/);
  assert.match(preload, /onCards: \(cb\) => ipcRenderer\.on\('phom:cards'/);
});

