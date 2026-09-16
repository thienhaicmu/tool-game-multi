// PHASE 6.1 — search lock + shared Room/RID cluster state (pure). Covers the §32 scenario matrix and
// the §33 requirements: only one FIND at a time; success/failure unlock; first finder owns the shared
// RID; other browsers JOIN the shared RID (never a second matchmaking); leave/lifecycle; button rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the SHARED browser module exactly as a classic <script> would (window global), so the test
// verifies the same file the renderer loads. (The repo is type:module, so a .js require() would treat
// it as ESM and miss the UMD export — vm runs it as a classic script and grabs the attached global.)
const code = readFileSync(new URL('../../ui-phom/manual-cluster-state.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(code, ctx);
const S = ctx.ManualClusterState;

const B = (profileId, manualState, extra = {}) => ({ profileId, manualState, rid: null, lastRid: null, canRejoin: false, ...extra });

// 1/2 — search lock starts immediately; other two Find disabled
test('search lock: starting a find locks the cluster; other browsers cannot find', () => {
  let st = S.create();
  const r = S.onFindStart(st, '1');
  assert.equal(r.action, 'SEARCH');
  st = r.state;
  assert.equal(st.searchingBrowserId, '1');
  // other browsers blocked
  assert.equal(S.onFindStart(st, '2').action, 'BLOCKED');
  assert.equal(S.canFind(st, B('2', 'READY')), false);
  assert.equal(S.canFind(st, B('3', 'READY')), false);
  // the searcher's own find button is also disabled while a search is running (§27)
  assert.equal(S.canFind(st, B('1', 'SEARCHING')), false);
});

// 3 — search success unlocks buttons + publishes shared RID (Scenario A)
test('Scenario A: B1 finds RID=100 => lock cleared, shared RID published, all can find', () => {
  let st = S.onFindStart(S.create(), '1').state;
  st = S.onFindResult(st, '1', { ok: true, rid: 100 });
  assert.equal(st.searchingBrowserId, null);
  assert.equal(st.sharedRid, 100);
  assert.equal(st.sharedRidOwner, '1');
  assert.equal(S.canFind(st, B('2', 'READY')), true);
  assert.equal(S.canFind(st, B('3', 'READY')), true);
});

// 4 — search failure unlocks buttons, shared RID stays null (Scenario D)
test('Scenario D: search failure clears the lock and leaves shared RID null', () => {
  let st = S.onFindStart(S.create(), '1').state;
  st = S.onFindResult(st, '1', { ok: false });
  assert.equal(st.searchingBrowserId, null);
  assert.equal(st.sharedRid, null);
  assert.equal(S.canFind(st, B('1', 'ERROR')), true);
  assert.equal(S.canFind(st, B('2', 'READY')), true);
  assert.equal(S.canFind(st, B('3', 'READY')), true);
});

// 5/6/7 — first finder owns; other browser FIND uses shared RID, no second matchmaking (Scenario B)
test('Scenario B: after B2 finds RID=200, B1/B3 FIND -> JOIN_SHARED 200 (no new matchmaking)', () => {
  let st = S.onFindResult(S.onFindStart(S.create(), '2').state, '2', { ok: true, rid: 200 });
  assert.equal(st.sharedRid, 200);
  const b1 = S.onFindStart(st, '1');
  assert.equal(b1.action, 'JOIN_SHARED');
  assert.equal(b1.rid, 200);
  const b3 = S.onFindStart(st, '3');
  assert.equal(b3.action, 'JOIN_SHARED');
  assert.equal(b3.rid, 200);
  // JOIN result must NOT change ownership
  const after = S.onJoinResult(st, '1', { ok: true });
  assert.equal(after.sharedRidOwner, '2');
});

// 8 — any of B1/B2/B3 can be the first finder (Scenario C is symmetric)
test('Scenario C: any browser can be the first finder', () => {
  for (const first of ['1', '2', '3']) {
    let st = S.onFindResult(S.onFindStart(S.create(), first).state, first, { ok: true, rid: 300 });
    assert.equal(st.sharedRidOwner, first);
    for (const other of ['1', '2', '3'].filter((x) => x !== first)) assert.equal(S.onFindStart(st, other).action, 'JOIN_SHARED');
  }
});

// 9 — leave one browser doesn't clear shared RID if others remain joined (Scenario E)
test('Scenario E: owner leaves but others still joined => shared RID kept', () => {
  let st = S.onFindResult(S.onFindStart(S.create(), '1').state, '1', { ok: true, rid: 100 });
  // B2, B3 joined the shared room; B1 (owner) then leaves (rid cleared, state LEFT)
  const browsers = [B('1', 'LEFT', { rid: null, lastRid: 100 }), B('2', 'JOINED', { rid: 100 }), B('3', 'JOINED', { rid: 100 })];
  st = S.reconcile(st, browsers);
  assert.equal(st.sharedRid, 100, 'shared RID survives while B2/B3 are still on it');
});

// 10 — all leave clears shared RID (Scenario F)
test('Scenario F: all browsers leave => shared RID + owner cleared, ready to find again', () => {
  let st = { searchingBrowserId: null, sharedRid: 100, sharedRidOwner: '1' };
  const browsers = [B('1', 'LEFT', { lastRid: 100 }), B('2', 'LEFT', { lastRid: 100 }), B('3', 'LEFT', { lastRid: 100 })];
  st = S.reconcile(st, browsers);
  assert.equal(st.sharedRid, null);
  assert.equal(st.sharedRidOwner, null);
  assert.equal(S.canFind(st, B('1', 'LEFT')), true);
});

// 13 — the search lock never gets stuck: reconcile unsticks a non-busy searcher
test('reconcile unsticks a search lock whose owner reached a terminal state', () => {
  let st = { searchingBrowserId: '2', sharedRid: null, sharedRidOwner: null };
  // B2 is no longer SEARCHING (e.g. errored) -> lock must clear
  st = S.reconcile(st, [B('1', 'READY'), B('2', 'ERROR'), B('3', 'READY')]);
  assert.equal(st.searchingBrowserId, null);
});

// button rules (§27/§32)
test('button rules: join needs a RID; rejoin needs canRejoin; leave needs JOINED', () => {
  const st = S.create();
  assert.equal(S.canJoin(st, B('1', 'READY'), ''), false, 'empty RID -> no join');
  assert.equal(S.canJoin(st, B('1', 'READY'), '139'), true);
  assert.equal(S.canJoin(st, B('1', 'JOINING'), '139'), false, 'already joining');
  assert.equal(S.canRejoin(st, B('1', 'LEFT', { canRejoin: true })), true);
  assert.equal(S.canRejoin(st, B('1', 'READY', { canRejoin: false })), false);
  assert.equal(S.canLeave(st, B('1', 'JOINED')), true);
  assert.equal(S.canLeave(st, B('1', 'READY')), false);
});

// labels/prefill reflect cluster state (§10/§14/§28/§30)
test('find label + RID prefill reflect the cluster state', () => {
  let st = S.create();
  assert.equal(S.findLabel(st, B('1', 'READY')), 'TÌM BÀN');
  assert.equal(S.findLabel(st, B('1', 'SEARCHING')), '🔍 ĐANG TÌM BÀN…');
  st = { searchingBrowserId: null, sharedRid: 139, sharedRidOwner: '2' };
  assert.equal(S.findLabel(st, B('1', 'READY')), 'VÀO BÀN 139', 'joining shared, not "find new"');
  assert.equal(S.prefillRid(st, B('1', 'READY')), '139', 'prefill shared RID');
  assert.equal(S.prefillRid(st, B('2', 'JOINED', { rid: 139 })), '139', 'own rid prefilled');
});

// 6.2.1 — the discovered table's STAKE is captured into the shared room (server-derived, not user input)
test('shared room captures the discovered table stake (sharedStake)', () => {
  let st = S.onFindResult(S.onFindStart(S.create(), '1').state, '1', { ok: true, rid: 700100, stake: 500 });
  assert.equal(st.sharedRid, 700100);
  assert.equal(st.sharedStake, 500, 'stake stored from the discovered table');
  // a follower joining the shared room does not change the stake
  const after = S.onJoinResult(st, '2', { ok: true });
  assert.equal(after.sharedStake, 500);
  // all-leave clears the stake with the rid
  const cleared = S.reconcile(st, [{ profileId: '1', manualState: 'LEFT', rid: null }]);
  assert.equal(cleared.sharedRid, null);
  assert.equal(cleared.sharedStake, null);
});

// 11/12 — manual join / rejoin do not disturb the lock; manual join keeps ownership stable
test('manual join result clears only a matching lock and never steals ownership', () => {
  let st = { searchingBrowserId: null, sharedRid: 500, sharedRidOwner: '3' };
  const after = S.onJoinResult(st, '1', { ok: true });
  assert.equal(after.sharedRidOwner, '3');
  assert.equal(after.sharedRid, 500);
});
