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

test('real FIND uses discovery (not a user stake); stake flows from the discovered table', () => {
  const body = fn(js, 'onManualFind');
  assert.match(body, /api\.manualDiscover\(b\.profileId\)/, 'real FIND calls discovery');
  assert.match(body, /rid: res\.rid, stake: res\.stake/, 'publishes the discovered rid + stake');
  assert.equal(/api\.manualFind\(|Number\(stake\)|Nhập mức cược/.test(body), false, 'no user-stake path in FIND');
});

test('VÀO GAME has a real ENTERING state and a failure state (not a fake success)', () => {
  const cell = fn(js, 'compactBrowserCell');
  assert.match(cell, /manualEntering\[runId\]/);
  assert.match(cell, /ĐANG VÀO GAME/);
  assert.match(cell, /VÀO GAME THẤT BẠI|THỬ LẠI/);
  const enter = fn(js, 'manualEnterGame');
  assert.match(enter, /manualEntering\[runId\] = true/);
  assert.match(enter, /api\.enterGame\(runId\)/);
  assert.match(enter, /setTimeout/, 'bounded entry timeout (no infinite ĐANG VÀO GAME)');
  // in-game flip is authoritative (slotInPhom), cleared in a reconcile
  assert.match(js, /function reconcileEnterStates\(\)/);
  assert.match(js, /slotInPhom\(runId\)/);
});

test('one horizontal row maps slot A/B/C -> Browser 1/2/3 (deterministic, not launch order)', () => {
  const row = fn(js, 'compactBrowserRow');
  assert.match(row, /browser-row/);
  assert.match(row, /SLOTS\.forEach\(\(slot, i\) => .*compactBrowserCell\(i \+ 1, slot, assign\[slot\]\.runId\)/);
});

test('VÀO GAME gates TÌM BÀN: FIND (from browserAction) is enabled only after in-game (§8)', () => {
  const action = fn(js, 'actionButton');
  assert.match(action, /act\.action === 'FIND'[\s\S]*?MCS\.canFind\(manualCluster, b\) && inGame/); // §8
  assert.match(action, /act\.action === 'ENTER_GAME'[\s\S]*?manualEnterGame\(runId\)/);
});

test('main screen shows NO username and NO Host/Follower/player-4 terminology', () => {
  for (const name of ['renderControl', 'compactHeader', 'compactBrowserRow', 'compactBrowserCell']) {
    const body = fn(js, name);
    assert.equal(/username|USER_UNKNOWN|Chưa đăng nhập/.test(body), false, `${name} shows no username`);
    assert.equal(/HOST|FOLLOWER|Follower|Player 4|player-4|Người thứ 4/.test(body), false, `${name} has no host/follower/player-4`);
  }
});

test('VÀO GAME acts on ONE browser via the run-scoped entry IPC (no cross-browser action)', () => {
  const body = fn(js, 'manualEnterGame');
  assert.match(body, /api\.enterGame\(runId\)/);
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
