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
function fn(src, name) { const s = src.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = src.slice(s + 1); const n = rest.indexOf('\n  function '); return rest.slice(0, n > 0 ? n : 4000); }

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
  assert.match(g, /canFind = [^;]*MCS\.canFind\(manualCluster, b\) && inGame && selected != null/);
});

test('no bet options yet => "đang tải" + refresh (never a default stake)', () => {
  const g = fn(js, 'betFindGroup');
  assert.match(g, /đang tải/);
  assert.match(g, /onRefreshBets\(runId\)/);
  assert.match(js, /function onRefreshBets\(/);
  assert.match(js, /api\.requestChannels\(\)/);
});

test('FIND passes the CHOSEN stake to discovery (api.manualDiscover with selectedStake)', () => {
  const h = fn(js, 'onManualFind');
  assert.match(h, /selectedStakeByBrowser\[b\.profileId\]/);
  assert.match(h, /api\.manualDiscover\(b\.profileId, \{ selectedStake \}\)/);
  // refuse to find without a chosen stake
  assert.match(h, /selectedStake == null[\s\S]*?Chọn mức cược/);
});

test('backend exposes per-browser betOptions = distinct server stakes (rs[].b), not hard-coded', () => {
  assert.match(coord, /_betOptionsFor\(rec\)/);
  assert.match(coord, /betOptions: this\._betOptionsFor\(rec\)/);
  // discovery filters by the selected stake and requires it
  assert.match(coord, /Number\(c\.b\) === wantStake/);
  assert.match(coord, /PHOM_NO_STAKE_SELECTED/);
});

test('B2/B3 (shared RID) show VÀO BÀN, not a bet selector (no re-selection, no discovery)', () => {
  // the bet selector is only reachable from the FIND action; JOIN_SHARED has no selector
  const action = fn(js, 'actionButton');
  assert.match(action, /act\.action === 'JOIN_SHARED'[\s\S]*?onManualJoinShared\(b\)/);
  const share = fn(js, 'onManualJoinShared');
  assert.equal(/selectedStakeByBrowser|manualDiscover|betOptions/.test(share), false, 'VÀO BÀN never re-selects a stake or re-discovers');
});
