// PHASE 6.2.3 — bet selector UX (source-level assertions). After a browser is in game, the FIND control
// is a REAL bet dropdown (from the browser's server betOptions) + TÌM BÀN; FIND is gated on a chosen
// stake; the chosen stake is passed to discovery. No manual number input, no hard-coded list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
const main = read('desktop/phom-main.cjs');
function fn(src, name) { const s = src.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = src.slice(s + 1); const m = rest.search(/\n {2}(async )?function /); return rest.slice(0, m > 0 ? m : 4000); }

test('the FIND action renders a bet selector + TÌM BÀN (not a plain button)', () => {
  const action = fn(js, 'actionButton');
  assert.match(action, /act\.action === 'FIND'[\s\S]*?betFindGroup\(b, runId, inGame\)/);
});

test('bet options come from the browser betOptions (server stakes), not a hard-coded list', () => {
  const g = fn(js, 'betFindGroup');
  assert.match(g, /b\.betOptions/);
  // no hard-coded stake values / no free-text stake input
  assert.equal(/\[100, 500, 1000|placeholder: '100'|type: 'number'|phq-manual-stake/.test(g), false, 'no hard-coded / manual stake');
  // building <option> from the real options
  assert.match(g, /for \(const s of options\)/);
});

test('FIND is enabled only after a stake is chosen (§11)', () => {
  const g = fn(js, 'betFindGroup');
  assert.match(g, /selectedStakeByBrowser\[runId\]/);
  // enable/disable is gated on canFind && inGame && a chosen stake (val != null), toggled in place
  assert.match(g, /findBtn\.disabled = \(!!MCS && MCS\.canFind\(manualCluster, b\) && inGame && val != null\)/);
});

test('no bet options yet => "đang tải" + refresh (never a default stake)', () => {
  const g = fn(js, 'betFindGroup');
  assert.match(g, /đang tải/);
  assert.match(g, /onRefreshBets\(runId\)/);
  assert.match(js, /function onRefreshBets\(/);
  assert.match(js, /api\.requestChannels\(\)/);
});

test('FIND passes the CHOSEN stake to discovery (api.findAndJoinGroup with selectedStake)', () => {
  const h = fn(js, 'onManualFind');
  assert.match(h, /selectedStakeByBrowser\[b\.profileId\]/);
  assert.match(h, /api\.findAndJoinGroup\(b\.profileId, \{ selectedStake \}\)/);
  // refuse to find without a chosen stake
  assert.match(h, /selectedStake == null[\s\S]*?Chọn mức cược/);
});

test('backend exposes per-browser betOptions = distinct server stakes (rs[].b), not hard-coded', () => {
  assert.match(coord, /_betOptionsFor\(rec\)/);
  assert.match(coord, /betOptions: this\._betOptionsFor\(rec\)/);
  // discovery filters by the selected stake (now via the pure qualifier) and requires it (§6.3.2.3)
  assert.match(coord, /pickQualifiedCandidate\(chans, \{[\s\S]*?selectedStake/);
  assert.match(coord, /PHOM_NO_STAKE_SELECTED/);
  const qualify = read('desktop/protocol/phom/table-qualify.cjs');
  assert.match(qualify, /Number\(c\.b\) !== wantStake/);
});

test('picking a stake enables TÌM BÀN IN PLACE (no full renderApp that would close the dropdown)', () => {
  const g = fn(js, 'betFindGroup');
  // the select onchange sets the value + toggles the button via setEnabled — it must NOT call renderApp
  assert.match(g, /onchange:[^}]*setEnabled\(v\)/);
  assert.equal(/onchange:[^}]*renderApp\(\)/.test(g), false, 'selecting a stake must not trigger a full rebuild');
  assert.match(g, /findBtn\.disabled/);
});

test('background re-renders (poll/pushes) skip while a bet dropdown is focused (bug fix)', () => {
  assert.match(js, /function betSelectFocused\(\)/);
  assert.match(js, /classList\.contains\('bet-sel'\)/);
  assert.match(js, /function bgRender\(\)/);
  // the 2s poll and the pushes use bgRender, not a raw renderApp
  assert.match(js, /if \(!\$\('workspace'\)\.hidden\) bgRender\(\);\s*\n\s*}, 2000\)/);
  assert.match(js, /onSession\([\s\S]*?bgRender\(\)/);
  assert.match(js, /onCluster\([\s\S]*?bgRender\(\)/);
});

test('reload (↻ WEB) resets the browser so VÀO GAME returns; backend resets that Phỏm context', () => {
  const h = fn(js, 'onReloadWeb');
  assert.match(h, /delete manualEntering\[runId\]/);
  assert.match(h, /delete selectedStakeByBrowser\[runId\]/);
  assert.match(h, /VÀO GAME/);
  // backend wiring: the reload IPC (and the header ⟳ button) reset the browser context via reloadWebRun.
  assert.match(main, /ipcMain\.handle\('phom:reload-web', guarded\(async \(_e, cfg\) => reloadWebRun/);
  assert.match(main, /async function reloadWebRun\(runId\)[\s\S]*?resetBrowser\(rid\)/);
  assert.match(coord, /resetBrowser\(profileId\)/);
  assert.match(coord, /rec\.ctx\.reset\(\)/);
});

test('B2/B3 (shared RID) show VÀO BÀN, not a bet selector (no re-selection, no discovery)', () => {
  // the bet selector is only reachable from the FIND action; JOIN_SHARED has no selector
  const action = fn(js, 'actionButton');
  assert.match(action, /act\.action === 'JOIN_SHARED'[\s\S]*?onManualJoinShared\(b\)/);
  const share = fn(js, 'onManualJoinShared');
  assert.equal(/selectedStakeByBrowser|manualDiscover|betOptions/.test(share), false, 'VÀO BÀN never re-selects a stake or re-discovers');
});
