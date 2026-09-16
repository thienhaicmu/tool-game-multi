// PHASE 6.1 — renderer wiring for the manual per-browser UI (source-level assertions; no DOM runtime in
// CI). Verifies the renderer consumes the tested backend contract, uses Browser 1/2/3 terminology (no
// Host/Follower, no player-4), renders remaining cards from the backend, shows the username from the
// snapshot, and never touches the game DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const html = read('ui-phom/index.html');
const preload = read('desktop/phom-preload.cjs');
const stateJs = read('ui-phom/manual-cluster-state.js');

test('index.html loads the shared search-lock/shared-RID module before the renderer', () => {
  assert.match(html, /manual-cluster-state\.js/);
  assert.ok(html.indexOf('manual-cluster-state.js') < html.indexOf('phom-qa.js'), 'state module loads first');
});

test('renderer consumes the manual backend contract (discover/join/rejoin/leave/snapshot/remaining)', () => {
  // PHASE 6.2.1 — a REAL find now goes through discovery (api.manualDiscover); JOIN_SHARED uses api.manualJoin.
  for (const call of ['api.manualDiscover(', 'api.manualJoin(', 'api.manualRejoin(', 'api.manualLeave(', 'api.manualSnapshot(', 'api.remainingCards(']) {
    assert.ok(js.includes(call), `renderer should call ${call}`);
  }
  for (const bridge of ['manualDiscover:', 'manualJoin:', 'manualRejoin:', 'manualLeave:', 'manualSnapshot:', 'remainingCards:']) {
    assert.ok(preload.includes(bridge), `preload should expose ${bridge}`);
  }
});

test('manual UI uses Browser 1/2/3 terminology, not Host/Follower or player-4', () => {
  const start = js.indexOf('function manualControlPanel(');
  const end = js.indexOf('// ---------- helpers ----------');
  const body = js.slice(start, end);
  assert.match(body, /BROWSER '\s*\+\s*b\.browserIndex|BROWSER 1 \/ 2 \/ 3/);
  assert.equal(/HOST|FOLLOWER|Follower|Player 4|player4|player-4|Người thứ 4/.test(body), false, 'no host/follower/player-4 terms in the manual panel');
});

test('search lock: the FIND handler goes through the pure state module (no direct second matchmaking)', () => {
  assert.match(js, /MCS\.onFindStart\(/);
  assert.match(js, /action === 'JOIN_SHARED'/);
  // when a shared RID exists the click JOINs it via manualJoin, not a fresh manualFind
  assert.match(js, /JOIN_SHARED[\s\S]*api\.manualJoin\(/);
});

test('Screen 2 renders backend remaining cards (never recomputes) and is not "player 4"', () => {
  const start = js.indexOf('function renderRemainingCards(');
  const body = js.slice(start, start + 700);
  assert.match(body, /CARDS REMAINING/);
  assert.match(body, /remaining\.cards/);
  assert.equal(/allKnownCards|fullDeck|\.filter\(/.test(body), false, 'renderer renders the backend result, does not recompute');
  assert.equal(/Player 4|Opponent|Người thứ 4/.test(body), false);
});

test('username comes from the snapshot (USER_UNKNOWN handled), never hard-coded', () => {
  assert.match(js, /b\.username/);
  assert.match(js, /USER_UNKNOWN/);
  assert.match(js, /Chưa đăng nhập/);
});

test('renderer never injects into the game DOM / document.title (tool-side UI only)', () => {
  // no document.title write, no injection into a game page (renderer only builds its own tool DOM)
  assert.equal(/document\.title\s*=/.test(js), false, 'no document.title write');
  assert.equal(/executeJavaScript|game.*innerHTML|canvas/i.test(js.slice(js.indexOf('function manualControlPanel('), js.indexOf('// ---------- helpers ----------'))), false);
});

test('Screen 2 refreshes on card-state pushes and on the control poll (event-driven, no fast polling)', () => {
  assert.match(js, /onHands[\s\S]*refreshManual\(\)/);
  assert.match(js, /await refreshManual\(\);\s*\/\/ PHASE 6\.1/);
});

test('the shared module exposes the search-lock/shared-RID API used by the renderer', () => {
  for (const fn of ['onFindStart', 'onFindResult', 'reconcile', 'canFind', 'findLabel', 'prefillRid']) {
    assert.ok(stateJs.includes(fn), `state module should define ${fn}`);
  }
});
