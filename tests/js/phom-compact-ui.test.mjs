// PHASE 6.2 — the compact final Tool UI (source-level assertions; no DOM runtime in CI). The main
// CONTROL screen is a low header (BÀN/CÒN LẠI) + a single row of Browser 1/2/3 controls with a VÀO GAME
// gate; no username, no Host/Follower, no legacy entry toolbars/monitor rendered on the main screen; the
// Tool is the 4th window of the deterministic layout. Backend/protocol untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const main = read('desktop/phom-main.cjs');

function fn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  // next top-level "  function " at the same indent
  const rest = src.slice(start + 1);
  const nextIdx = rest.indexOf('\n  function ');
  return rest.slice(0, nextIdx > 0 ? nextIdx : 4000);
}

test('renderControl renders the compact UI (header + browser row + remaining), not the legacy toolbars', () => {
  const body = fn(js, 'renderControl');
  assert.match(body, /compactHeader\(\)/);
  assert.match(body, /compactBrowserRow\(\)/);
  assert.match(body, /renderRemainingCards\(\)/);
  // legacy host-first/entry toolbars + monitor are NOT called from the main screen
  assert.equal(/statusToolbar\(|commandToolbar\(|entryStatusBar\(|liveMonitor\(/.test(body), false, 'no legacy toolbars/monitor on the main screen');
});

test('header shows server-derived BÀN (RID) + CƯỢC (stake) + CÒN LẠI; NO manual stake input (6.2.1)', () => {
  const body = fn(js, 'compactHeader');
  assert.match(body, /BÀN:/);
  assert.match(body, /manualCluster\.sharedRid/);
  assert.match(body, /CƯỢC:/);
  assert.match(body, /manualCluster\.sharedStake/, 'stake is the server-derived shared stake');
  assert.match(body, /CÒN LẠI:/);
  assert.match(body, /remaining\.count/);
  // §8/§12 — no stake/channel input in the header (stake comes from the discovered table)
  assert.equal(/phq-manual-stake|oninput.*manualStake|placeholder: '100'/.test(body), false, 'no manual stake input');
});

test('real FIND uses discovery with the CHOSEN server stake; stake flows from the discovered table', () => {
  const body = fn(js, 'onManualFind');
  assert.match(body, /api\.manualDiscover\(b\.profileId, \{ selectedStake \}\)/, 'real FIND calls discovery with the chosen stake');
  assert.match(body, /rid: res\.rid, stake: res\.stake/, 'publishes the discovered rid + stake');
  assert.equal(/api\.manualFind\(|Number\(stake\)|type: 'number'/.test(body), false, 'no manual/user-typed stake path in FIND');
});

// PHASE 6.3.2 — Screen 2 is READ-ONLY. The game action (VÀO GAME) + its ENTERING/failure states now live
// in the in-Chromium header (game-header.cjs); the Tool cell only mirrors ACCOUNT/RID/STATE/WS.
test('the in-Chromium header owns VÀO GAME with a real ENTERING + failure state (deriveHeaderState)', () => {
  const gh = read('desktop/protocol/phom/game-header.cjs');
  assert.match(gh, /ENTER_GAME/);
  assert.match(gh, /entering[\s\S]*?ĐANG VÀO GAME/); // busy ENTERING label
  assert.match(gh, /error:/); // failure surfaced back into the header
  // the main process tracks the transient entering flag + bounded evidence via slotInPhom-equivalent
  assert.match(main, /headerEntering/);
  assert.match(main, /if \(view\.inGame\) \{[\s\S]*?delete headerEntering\[rid\]/); // real in-game evidence clears ENTERING
});

test('Screen 2 cell is READ-ONLY: mirrors ACCOUNT/RID/STATE/WS, keeps only ↻/⏻ lifecycle (no game buttons)', () => {
  const cell = fn(js, 'compactBrowserCell');
  assert.match(cell, /bc-readonly/);
  assert.match(cell, /ACCOUNT/);
  assert.match(cell, /'RID'/);
  assert.match(cell, /'STATE'/);
  assert.match(cell, /'WS'/);
  // browser lifecycle stays in the Tool (↻ WEB + ⏻)
  assert.match(cell, /onReloadWeb\(runId\)/);
  assert.match(cell, /onCloseBrowser\(slot, runId\)/);
  // NO game-control action is wired from the read-only cell (they live in the Chromium header)
  assert.equal(/actionButton\(|betFindGroup\(|manualEnterGame\(|onManualJoinShared\(|onManualLeave\(/.test(cell), false, 'no game action wired in the read-only cell');
});

test('one horizontal row maps slot A/B/C -> Browser 1/2/3 (deterministic, not launch order)', () => {
  const row = fn(js, 'compactBrowserRow');
  assert.match(row, /browser-row/);
  assert.match(row, /SLOTS\.forEach\(\(slot, i\) => .*compactBrowserCell\(i \+ 1, slot, assign\[slot\]\.runId\)/);
});

test('the header gates TÌM BÀN behind VÀO GAME and renders a REAL bet selector (game-header.cjs)', () => {
  const gh = read('desktop/protocol/phom/game-header.cjs');
  // not in game yet -> the only action is ENTER_GAME (VÀO GAME), never FIND
  assert.match(gh, /!view\.inGame[\s\S]*?action: 'ENTER_GAME'/);
  // in game + no shared room -> FIND needs a bet chosen from the server betOptions (no hard-coded stake)
  assert.match(gh, /action: 'FIND'[\s\S]*?needsBet: true[\s\S]*?betOptions/);
  // the injected bar sends FIND with the picked stake (Number), never a typed/hard-coded value
  assert.match(gh, /emit\('FIND',\{ stake:Number\(sel\.value\) \}\)/);
});

test('main screen shows NO Host/Follower/player-4 terminology (ACCOUNT is now shown read-only, §6.3.2)', () => {
  for (const name of ['renderControl', 'compactHeader', 'compactBrowserRow', 'compactBrowserCell']) {
    const body = fn(js, name);
    assert.equal(/HOST|FOLLOWER|Follower|Player 4|player-4|Người thứ 4/.test(body), false, `${name} has no host/follower/player-4`);
  }
  // the read-only cell DOES surface the logged-in ACCOUNT (display name), with USER_UNKNOWN mapped to —
  const cell = fn(js, 'compactBrowserCell');
  assert.match(cell, /mb\.username/);
  assert.match(cell, /USER_UNKNOWN/);
});

test('the header action router acts on ONE browser via the run-scoped coordinator API (no cross-browser)', () => {
  // ENTER_GAME -> phomEnterGame(runId); FIND/JOIN/REJOIN/LEAVE -> the run-scoped manual* API, all keyed by
  // the single runId the click came from (never a leave-all / cross-browser action).
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('async function phomHeaderAction(') + 4200);
  assert.match(r, /ENTER_GAME'[\s\S]*?phomEnterGame\(rid\)/);
  assert.match(r, /FIND'[\s\S]*?manualDiscoverTable\(rid, \{ selectedStake \}\)/);
  assert.match(r, /manualRejoin\(rid/);
  assert.match(r, /manualLeave\(rid\)/);
});

test('the Tool is the 4th window of the deterministic cluster arrangement', () => {
  assert.match(main, /arrangeClusterWindows/);
  assert.match(main, /clusterFourWindowArrangement/);
  // browsers use .slots; the Tool window (restoreLayout) uses .tool
  assert.match(main, /clusterFourWindowArrangement\(\)[\s\S]*?arr\.slots\[slotIndex\]/);
  assert.match(main, /clusterFourWindowArrangement\(\);\s*control = arr && arr\.tool/);
});

test('remaining cards on the main screen are backend-provided and not "player 4"', () => {
  const body = fn(js, 'renderRemainingCards');
  assert.match(body, /CARDS REMAINING/);
  assert.match(body, /remaining\.cards/);
  assert.equal(/Player 4|Opponent|Người thứ 4/.test(body), false);
});

test('renderer never writes document.title or injects game DOM (tool-side only)', () => {
  assert.equal(/document\.title\s*=/.test(js), false);
});
