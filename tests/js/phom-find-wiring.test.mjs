// PHASE 6.3.4 — FIND wiring (source-level, no GUI). The in-Chromium header is the SOLE finder surface:
// main marks Player 1 (browserIndex 1) as the finder + anchor; the coordinator has a gated FIND trace and
// single-flight; and the phase adds NO game-action (no PLAY/DRAW/MELD/CDP click / browser restart).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const main = read('desktop/phom-main.cjs');
const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
const header = read('desktop/protocol/phom/game-header.cjs');

test('main: Player 1 (browserIndex 1) is the SINGLE room anchor + the only finder', () => {
  assert.match(main, /const anchor = list\.find\(\(b\) => b && b\.browserIndex === 1 && b\.manualState === 'JOINED' && b\.rid != null\)/);
  assert.match(main, /isFinder: b\.browserIndex === 1/);
});

test('header: a follower (isFinder:false, no shared RID) is gated out of FIND (WAIT_ANCHOR)', () => {
  assert.match(header, /view\.isFinder === false/);
  assert.match(header, /action: 'WAIT_ANCHOR'/);
});

test('coordinator: FIND is single-flight (no duplicate CMD 300) + reuses a fresh cached list', () => {
  assert.match(coord, /if \(rec\._discovering\)/);
  assert.match(coord, /PHOM_FIND_IN_FLIGHT/);
  // reuse: pick a cached candidate BEFORE requesting CMD 300; only request when none qualifies
  assert.match(coord, /let candidate = this\._pickManualCandidate\(rec, need, selectedStake\);/);
  assert.match(coord, /buildChannelListFrame\(aid\)/);
  // the single-flight flag is released on the finally + on leave/reset
  assert.match(coord, /finally \{ rec\._discovering = false; \}/);
  assert.match(coord, /rec\._discovering = false;\s*\/\/ PHASE 6\.3\.4 — release the FIND single-flight on ↻ WEB reset/);
});

test('coordinator: gated FIND trace (PHOM_FIND_LOG) with runId/slotId/findGen + latency', () => {
  assert.match(coord, /_findLog\(event, rec, findGen, data = \{\}\)/);
  assert.match(coord, /process\.env\.PHOM_FIND_LOG !== '1'/);
  for (const m of ['F0_FIND_START', 'F1_CMD300_REQUEST', 'F3_TABLE_LIST_READY', 'F5_CANDIDATE_QUALIFIED', 'F6_JOIN_SENT', 'F7_TABLE_STATE', 'F8_OWN_UID_CONFIRMED', 'F9_RID_READY', 'F10_FIND_SUCCESS']) {
    assert.ok(coord.includes(m), `trace milestone ${m} present`);
  }
  for (const fx of ['FX_DUPLICATE_IGNORED', 'FX_FIND_CANCELLED', 'FX_TABLE_CHANGED', 'FX_JOIN_REJECTED', 'FX_TIMEOUT', 'FX_SESSION_DEAD']) {
    assert.ok(coord.includes(fx), `failure trace ${fx} present`);
  }
  assert.match(coord, /totalMs: Math\.round\(\(this\._mono\(\) - t0\)/); // latency measured
});

test('§34 safety: the FIND phase adds NO game-action / browser restart to the coordinator FIND path', () => {
  // the JOIN wire frame is unchanged (buildJoinFrame) and there is no play/draw/meld/click/restart
  const discover = coord.slice(coord.indexOf('async manualDiscoverTable('), coord.indexOf('async manualFindTable('));
  for (const forbidden of ['buildPlayFrame', 'buildDrawFrame', 'buildMeldFrame', 'Input.dispatch', '.click(', 'closeRun', 'reopen', 'restart']) {
    assert.equal(discover.includes(forbidden), false, `manualDiscoverTable must not reference ${forbidden}`);
  }
  // JOIN protocol untouched
  assert.match(coord, /buildJoinFrame\(r\)/);
});
