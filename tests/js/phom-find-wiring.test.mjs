// PHASE 6.3.4/6.3.6 — FIND wiring (source-level, no GUI). The in-Chromium header is the SOLE finder surface;
// the finder + room anchor is the USER's explicit choice (selectedFinderIndex), NOT defaulted to Player 1. The
// coordinator has a gated FIND trace and single-flight; the phase adds NO game-action (no PLAY/DRAW/MELD/CDP
// click / browser restart).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const main = read('desktop/phom-main.cjs');
const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
const header = read('desktop/protocol/phom/game-header.cjs');

// PHASE 6.3.6 — the finder/anchor is now the USER's explicit choice (selectedFinderIndex), NOT Player 1.
test('main: the finder + shared-RID anchor follow the USER-selected finder, never browserIndex 1', () => {
  // shared RID anchor = the selected finder's validated room (or first valid holder when none chosen). §38 — derived
  // ONCE in the coordinator; main delegates, and the coordinator syncs the finder the user picked.
  assert.match(main, /phomSessions\.sharedRid\(\)/);
  assert.match(main, /applyFinderToCoordinator/);
  // FIND gating follows the user choice; the old browserIndex-1 hard-codes are gone.
  assert.match(main, /isFinder: selectedFinderIndex == null \? true : \(b\.browserIndex === selectedFinderIndex\)/);
  assert.equal(/isFinder: b\.browserIndex === 1/.test(main), false, 'finder must not be hard-coded to Player 1');
  assert.equal(/const anchor = list\.find\(\(b\) => b\.browserIndex === 1 && valid\(b\)\)/.test(main), false, 'anchor must not be hard-coded to Player 1');
});

test('header: a follower (isFinder:false, no shared RID) is gated out of FIND (WAIT_ANCHOR)', () => {
  assert.match(header, /view\.isFinder === false/);
  assert.match(header, /action: 'WAIT_ANCHOR'/);
});

test('coordinator: FIND is single-flight (no duplicate CMD 300) + reuses a cached list only while FRESH', () => {
  assert.match(coord, /if \(rec\._discovering\)/);
  assert.match(coord, /PHOM_FIND_IN_FLIGHT/);
  // PHASE 6.3.7 — reuse a cached candidate on the first pass ONLY while the list is fresh; a stale cache falls
  // through to a fresh CMD 300 (a user FIND is live discovery). Recovery passes always request fresh.
  assert.match(coord, /let candidate = \(recovery === 0 && cacheFresh\) \? this\._pickManualCandidate\(rec, minSeats, selectedStake, runFailedRids\) : null;/);
  assert.match(coord, /cacheFresh = at != null && \(this\._now\(\) - Number\(at\)\) < freshMs;/);
  assert.match(coord, /buildChannelListFrame\(aid\)/);
  // the single-flight flag is released on the finally + on leave/reset
  assert.match(coord, /finally \{ rec\._discovering = false; rec\._searchStartedAt = null; \}/);
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

// §32/§34 — persistent FIND + its escape hatch, wired end to end (source-level, no GUI).
test('coordinator: the persistent search is bounded by an explicit budget + poll, never a while(true)', () => {
  assert.match(coord, /const FIND_BUDGET_MS = \d+;/);
  assert.match(coord, /const FIND_LIST_POLL_MS = \d+;/);
  assert.match(coord, /const deadline = t0 \+ budgetMs;/);
  assert.match(coord, /if \(left <= 0\) break;/);                     // the poll loop always terminates
  assert.match(coord, /if \(recovery > 0 && this\._mono\(\) >= deadline\)/); // re-anchor passes respect it too
  // both bounds are configurable per session, so the budget can be tuned without editing call sites
  assert.match(coord, /this\._findBudgetMs = deps\.findBudgetMs != null/);
  assert.match(coord, /this\._findPollMs = deps\.findPollMs != null/);
});

test('coordinator: HỦY cancels via the SAME generation token the rest of the flow uses', () => {
  assert.match(coord, /async cancelFind\(profileId\)/);
  assert.match(coord, /PHOM_FIND_NOT_RUNNING/);
  assert.match(coord, /rec\._manualGen = \(rec\._manualGen \|\| 0\) \+ 1; \/\/ supersede the pending search\/join waits/);
  assert.match(coord, /buildLeaveFrame\(\)/); // a join already in flight is undone, not left dangling
  // the snapshot carries live progress for the header
  for (const f of ['searching:', 'searchAttempt:', 'searchElapsedSec:']) assert.ok(coord.includes(f), `snapshot exposes ${f}`);
});

test('main: HỦY is routed, and the escape actions are exempt from single-flight', () => {
  assert.match(main, /action === 'CANCEL_FIND'/);
  assert.match(main, /phomSessions\.cancelFind\(rid\)/);
  assert.match(main, /const exempt = headerActionGuard\.isBusyExempt\(action\);/);
  assert.match(main, /if \(!exempt\) headerActionBusy\[rid\] = true;/);
  assert.match(main, /searchElapsedSec: b\.searchElapsedSec \|\| 0,/);
});

test('header: SEARCHING offers HỦY and reports progress; the guard exempts the escapes', () => {
  assert.match(header, /CANCEL_FIND: \{ icon:/);
  assert.match(header, /action: 'CANCEL_FIND', label: 'HỦY TÌM'/);
  const guard = read('desktop/protocol/phom/header-action-guard.cjs');
  assert.match(guard, /BUSY_EXEMPT_ACTIONS = Object\.freeze\(new Set\(\['CANCEL_FIND', 'RELOAD', 'STOP', 'FOCUS', 'CAPTURE_START', 'CAPTURE_STOP'\]\)\)/);
  assert.match(guard, /if \(busy && !isBusyExempt\(p\.action\)\)/);
});

// §38 — the Tool window and the in-Chromium header drive the SAME operations with the SAME semantics.
test('Tool window: VÀO BÀN uses join-shared (retry + same-room proof), HỦY cancels, shared room is authoritative', () => {
  const ui = read('ui-phom/phom-qa.js');
  const preload = read('desktop/phom-preload.cjs');
  assert.equal(/api\.manualJoin\(b\.profileId, rid\)[\s\S]{0,40}\/\/ exact shared/.test(ui), false);
  assert.match(ui, /api\.manualJoinShared\(b\.profileId, rid\)/);
  assert.match(ui, /api\.manualJoinShared\(b\.profileId, dec\.rid\)/);
  assert.match(ui, /api\.cancelFind\(b\.profileId\)/);
  assert.match(ui, /b\.manualState === 'SEARCHING'/);
  assert.match(ui, /MCS\.reconcile\(manualCluster, manualBrowsers, sharedAuth\)/);
  assert.match(preload, /manualJoinShared: \(browserId, rid, opts\) => ipcRenderer\.invoke\('phom:manual-join-shared'/);
  assert.match(preload, /cancelFind: \(browserId\) => ipcRenderer\.invoke\('phom:manual-cancel-find'/);
  assert.match(main, /ipcMain\.handle\('phom:manual-join-shared'/);
  assert.match(main, /ipcMain\.handle\('phom:manual-cancel-find'/);
  // a Tool-side THOÁT BÀN no longer swallows an unconfirmed leave
  assert.match(ui, /res = await api\.manualLeave\(b\.profileId\)/);
});
