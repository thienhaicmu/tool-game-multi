// THAY PROFILE — a closed P1/P2/P3 slot reopens with another saved profile (its own login/proxy/agent) without
// touching the other two browsers: cluster reassign + in-place run replacement in the Phỏm session + wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhomClusterCdpManager } = require('../../desktop/protocol/phom/phom-cluster-cdp-manager.cjs');
const { HostSessionManager } = require('../../desktop/protocol/phom/host-session-manager.cjs');
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

function makeCluster() {
  let n = 0;
  const opened = [];
  const mgr = new PhomClusterCdpManager({
    now: () => 1,
    openProfile: async (slot, cfg) => { opened.push({ slot, ...cfg }); return { ok: true, runId: 'BR-' + (++n) }; },
    getRunClient: () => ({}),
  });
  mgr.createCluster({ hostSlot: 'A', profiles: [
    { slot: 'A', browserProfileId: 'p1', label: 'P1', agent: 'WEB' },
    { slot: 'B', browserProfileId: 'p2', label: 'P2', agent: 'WEB' },
    { slot: 'C', browserProfileId: 'p3', label: 'P3', agent: 'WEB' },
  ] });
  return { mgr, opened };
}

test('a closed slot reopens with ANOTHER profile; only that slot opens; the others keep their runs', async () => {
  const { mgr, opened } = makeCluster();
  await mgr.openCluster();
  assert.equal(opened.length, 3);
  const runA = mgr.getClusterSnapshot().profiles.A.profileId;
  assert.equal(mgr.reassignSlot('A', { browserProfileId: 'p4' }).error.code, 'PHOM_SLOT_BUSY', 'an open slot is never repointed');
  mgr.markRunClosed(runA, 'USER_CLOSED_WINDOW');
  const r = mgr.reassignSlot('A', { browserProfileId: 'p4', label: 'P4', proxyRef: 'px-4', agent: 'MOBILE', gameUrl: 'https://g/' });
  assert.equal(r.ok, true);
  await mgr.openCluster();
  assert.equal(opened.length, 4, 'only the closed slot opened');
  assert.deepEqual({ slot: opened[3].slot, id: opened[3].browserProfileId, proxy: opened[3].proxyRef, agent: opened[3].agent, url: opened[3].gameUrl },
    { slot: 'A', id: 'p4', proxy: 'px-4', agent: 'MOBILE', url: 'https://g/' });
  const snap = mgr.getClusterSnapshot();
  assert.equal(snap.profiles.A.deviceProfileId, 'p4');
  assert.equal(snap.profiles.A.label, 'P4');
  assert.notEqual(snap.profiles.A.profileId, runA, 'a new run');
  assert.equal(snap.openBrowserCount, 3);
});

test('a profile already running in another slot cannot be opened twice', async () => {
  const { mgr } = makeCluster();
  await mgr.openCluster();
  mgr.markRunClosed(mgr.getClusterSnapshot().profiles.C.profileId, 'USER_CLOSED_WINDOW');
  assert.equal(mgr.reassignSlot('C', { browserProfileId: 'p1' }).error.code, 'PHOM_PROFILE_IN_USE');
  assert.equal(mgr.reassignSlot('C', { browserProfileId: 'p3' }).ok, true, 'its own profile is fine');
});

function makeSession() {
  const mgr = new HostSessionManager({
    wsReplay: { sendProtocol: async () => ({ ok: true }) }, authorized: () => true, featureEnabled: () => true,
    now: (() => { let t = 0; return () => (t += 1); })(),
    resolveProfileMeta: (runId) => ({ displayName: `Run ${runId}`, uid: null }),
  });
  mgr.startSession({ runIds: ['A', 'B', 'C'] });
  return mgr;
}
const frame = (raw) => ({ isWebSocket: true, wsDirection: 'recv', seq: 1, targetId: 'T', url: 'wss://x/websocket', body: { raw } });
const lobbyRaw = JSON.stringify([5, { rs: [{ rid: 139, gid: 8, b: 100, Mu: 4, uC: 0, zn: 'Simms' }] }]);
function seedGroup(mgr, roles) {
  mgr._group._group = { rid: 777, stake: 100, creatorId: 'A', roles: new Map(Object.entries(roles)), kicks: new Map(), rejoinOn: new Set(Object.keys(roles)), rejoinPending: new Set(), autoRejoin: new Set(), recreating: false };
}

test('the new run takes the old one\'s place (same P order) and its frames are covered; the old run is not', () => {
  const mgr = makeSession();
  assert.equal(mgr.replaceRun('B', 'D').replaced, true);
  assert.deepEqual(mgr.manualBrowserSnapshot().map((b) => b.profileId), ['A', 'D', 'C'], 'P2 is still the middle slot');
  mgr.routeFrame({ id: 'D' }, frame(lobbyRaw));
  assert.equal(mgr.manualBrowserSnapshot()[1].channelCount, 1, 'the new browser is observed');
  assert.equal(mgr.replaceRun('B', 'E').replaced, false, 'the old run is gone from the session');
});

test('replacing a member: the new browser takes its role (+ReJoin); the KEY and the table stay', () => {
  const mgr = makeSession();
  seedGroup(mgr, { A: 'KEY', B: 'READY', C: 'NOT_READY' });
  mgr.replaceRun('C', 'D');
  assert.equal(mgr.sharedRid(), 777);
  assert.equal(mgr.groupRoleOf('A'), 'KEY');
  assert.equal(mgr.groupRoleOf('C'), null);
  assert.equal(mgr.groupRoleOf('D'), 'NOT_READY', 'same role as the account it replaces');
  assert.equal(mgr._group.rejoinOn('D'), true);
  mgr.endSession(); // stops the "wait until in game" poll
});

test('a browser swapped out to the reserves leaves the table first (leaveNow) — main does it before the swap', async () => {
  const mgr = makeSession();
  assert.deepEqual(await mgr.leaveNow('A'), { ok: true, already: true }, 'not seated → nothing sent');
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /async function swapSlot[\s\S]*?phomSessions\.leaveNow\(oldRun\)[\s\S]*?phomCluster\.swapSlot\(s, r\)/);
  assert.match(main, /async function replaceSlot[\s\S]*?phomSessions\.leaveNow\(oldRun\)[\s\S]*?closeBrowserRun\(oldRun\)/);
});

test('replacing the KEY dissolves the group (its table has no owner any more)', () => {
  const mgr = makeSession();
  seedGroup(mgr, { A: 'KEY', B: 'READY' });
  const notices = []; mgr.on('notice', (n) => notices.push(n.event));
  mgr.replaceRun('A', 'D');
  assert.equal(mgr.sharedRid(), null);
  assert.equal(mgr.groupRoleOf('B'), null);
  assert.ok(notices.includes('GROUP_DISSOLVED'));
});

// ---- RESERVES: tick 4–5 profiles → 3 play, the rest wait behind the tool and are swapped in --------------------
function makeClusterWithReserves() {
  let n = 0;
  const opened = [];
  const mgr = new PhomClusterCdpManager({
    now: () => 1,
    openProfile: async (slot, cfg) => { opened.push({ slot, ...cfg }); return { ok: true, runId: 'BR-' + (++n) }; },
    getRunClient: () => ({}),
  });
  mgr.createCluster({ hostSlot: 'A',
    profiles: [{ slot: 'A', browserProfileId: 'p1', label: 'P1' }, { slot: 'B', browserProfileId: 'p2', label: 'P2' }, { slot: 'C', browserProfileId: 'p3', label: 'P3' }],
    reserves: [{ slot: 'D', browserProfileId: 'p4', label: 'P4' }, { slot: 'E', browserProfileId: 'p5', label: 'P5' }] });
  return { mgr, opened };
}

test('4th/5th profile open as reserves D/E; the playing count stays 3/3', async () => {
  const { mgr, opened } = makeClusterWithReserves();
  const res = await mgr.openCluster();
  assert.deepEqual(opened.map((o) => o.slot), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(res.opened, 3);
  const snap = mgr.getClusterSnapshot();
  assert.equal(snap.openBrowserCount, 3, 'reserves never count as playing');
  assert.deepEqual(Object.values(snap.reserves).map((r) => [r.slot, r.deviceProfileId, r.browserState]), [['D', 'p4', 'OPEN'], ['E', 'p5', 'OPEN']]);
});

test('ĐỔI: a reserve plays in slot B at once, slot B\'s browser becomes the reserve (nothing closes or reopens)', async () => {
  const { mgr, opened } = makeClusterWithReserves();
  await mgr.openCluster();
  const before = mgr.getClusterSnapshot();
  const r = mgr.swapSlot('B', 'D');
  assert.equal(r.ok, true);
  assert.equal(r.playingRun, before.reserves.D.profileId);
  assert.equal(r.benchedRun, before.profiles.B.profileId);
  const after = mgr.getClusterSnapshot();
  assert.equal(after.profiles.B.deviceProfileId, 'p4');
  assert.equal(after.reserves.D.deviceProfileId, 'p2');
  assert.equal(opened.length, 5, 'no browser opened');
  assert.equal(mgr.reassignSlot('C', { browserProfileId: 'p2' }).ok, false, 'a profile open as reserve is not opened twice');
});

test('a CLOSED slot can take a reserve too; the closed browser is not counted as a reserve', async () => {
  const { mgr } = makeClusterWithReserves();
  await mgr.openCluster();
  mgr.markRunClosed(mgr.getClusterSnapshot().profiles.A.profileId, 'USER_CLOSED_WINDOW');
  const r = mgr.swapSlot('A', 'E');
  assert.equal(r.ok, true);
  assert.equal(r.benchedRun, null);
  const snap = mgr.getClusterSnapshot();
  assert.equal(snap.profiles.A.browserState, 'OPEN');
  assert.equal(snap.reserves.E.browserState, 'CLOSED_BY_USER');
  assert.equal(mgr.swapSlot('B', 'E').error.code, 'PHOM_RESERVE_NOT_OPEN');
});

test('LỌC BÀI follows the slot: the replaced account is no longer ours; the new one binds to the slot at once', () => {
  const mgr = makeSession();
  const coord = mgr._session.coord;
  mgr.setIdentity('B', { uid: '1_old' });
  coord.rebindCardSlot('B');
  assert.equal(mgr.cardObserverSnapshot().slotBinding.B2, '1_old');
  mgr.replaceRun('B', 'D');
  let cards = mgr.cardObserverSnapshot();
  assert.equal(cards.slotBinding.B2, null, 'P2 unbound right away');
  assert.equal(cards.players['1_old'].controlled, false, 'the old account is a stranger now');
  mgr.setIdentity('D', { uid: '1_new' });
  coord.rebindCardSlot('D');
  cards = mgr.cardObserverSnapshot();
  assert.equal(cards.slotBinding.B2, '1_new');
  assert.equal(cards.players['1_new'].controlled, true);
});

test('wiring: swap IPC moves the windows (reserve → behind the tool) and swaps the session member', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /ipcMain\.handle\('phom:slot-swap'/);
  assert.match(main, /async function swapSlot[\s\S]*?phomSessions\.swapRuns\(oldRun, res\.playingRun\)[\s\S]*?windows\(\)\.move\(res\.playingRun, windows\(\)\.rectFor\(s\)\)[\s\S]*?windows\(\)\.move\(res\.benchedRun, windows\(\)\.rectFor\(r\)\)[\s\S]*?shell\.moveTop\(\)/);
  assert.match(read('desktop/phom-preload.cjs'), /swapSlot: \(slot, reserve\) => ipcRenderer\.invoke\('phom:slot-swap'/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /function reserveCard\(r\)[\s\S]*?onclick: \(\) => onSwapSlot\(slot, r\.slot\)/, 'a reserve card puts itself into P1/P2/P3 (→1/→2/→3)');
  assert.match(ui, /api\.swapSlot\(slot, reserve\)/);
});

test('a PLAYING browser closed from its own window is replaced by the first open reserve (P4, then P5); a tool close never is', () => {
  const main = read('desktop/phom-main.cjs');
  // the run-exit hook hands the closed slot to the auto-replace
  assert.match(main, /onRunExit: \(runId, record\) => \{[\s\S]*?closed = phomCluster\.markRunClosed\(runId, record && record\.reason\)[\s\S]*?autoReplaceFromReserve\(runId, closed\);/);
  const fnSrc = main.slice(main.indexOf('function autoReplaceFromReserve('), main.indexOf('function resolveTargetClient('));
  assert.match(fnSrc, /if \(toolClosingRuns\.delete\(rid\)\) return;/, 'a close made by the tool is skipped');
  assert.match(fnSrc, /SLOTS_ABC\.includes\(closed\.slot\)/, 'only a playing slot — a reserve closing replaces nothing');
  assert.match(fnSrc, /phomCluster\.active\(\)/, 'never while the cluster is being stopped (Đóng tất cả)');
  assert.match(fnSrc, /RESERVE_SLOTS\.find\(/, 'first open reserve in order D (P4) then E (P5)');
  assert.match(fnSrc, /swapSlot\(closed\.slot, reserve\)/);
  assert.match(fnSrc, /event: 'SLOT_AUTO_REPLACED'/);
  // every tool-initiated close is flagged first (⏻, Thay profile)
  assert.match(main, /async function closeBrowserRun[\s\S]*?toolClosingRuns\.add\(rid\);[\s\S]*?runManager\.closeRun\(rid\)/);
  assert.match(main, /const RESERVE_SLOTS = \['D', 'E'\]/);
  // the tool window follows: cards re-bound, the notice shown
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /\/\^SLOT_AUTO_\/\.test\(n\.event\)[\s\S]*?bindSlotsFromCluster\(\); syncSelectionFromCluster\(\);/);
  assert.match(ui, /case 'SLOT_AUTO_REPLACED':/);
});

test('wiring: IPC phom:slot-replace → replaceSlot (close, reassign, open, replaceRun); preload; closed card shows the picker', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /ipcMain\.handle\('phom:slot-replace'/);
  assert.match(main, /phomCluster\.reassignSlot\(s,/);
  assert.match(main, /phomSessions\.replaceRun\(oldRun, newRun\)/);
  assert.match(read('desktop/phom-preload.cjs'), /replaceSlot: \(slot, profileId\) => ipcRenderer\.invoke\('phom:slot-replace'/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /else if \(s\.chromiumClosed\) extra = closedSlotActions\(slot\)/);
  assert.match(ui, /function closedSlotActions[\s\S]*?onSwapSlot\(slot, r\.slot\)[\s\S]*?'Mở lại'[\s\S]*?'Profile khác…'/, 'closed slot: ←P4/←P5, Mở lại, another profile');
  assert.match(ui, /api\.replaceSlot\(slot,/);
});

// ---- GĐ4 — warm reserves: full members of the session (same bar), never seated by TỰ ĐỘNG -----------------------
function makeSession5() {
  const mgr = new HostSessionManager({
    wsReplay: { sendProtocol: async () => ({ ok: true }) }, authorized: () => true, featureEnabled: () => true,
    now: (() => { let t = 0; return () => (t += 1); })(),
    resolveProfileMeta: () => ({}),
  });
  const r = mgr.startSession({ runIds: ['A', 'B', 'C', 'D', 'E'] });
  return { mgr, r };
}

test('a session takes 3 to 5 runs; P4/P5 are members (their bar works) but not playing', () => {
  const { mgr, r } = makeSession5();
  assert.equal(r.ok, true);
  const coord = mgr._session.coord;
  assert.deepEqual(coord.profileIds(), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(coord.playingIds(), ['A', 'B', 'C']);
  assert.equal(mgr.manualBrowserSnapshot().length, 5, 'the reserves have their own state (their bar)');
  assert.equal(new HostSessionManager({ featureEnabled: () => true }).startSession({ runIds: ['A', 'B'] }).ok, false);
});

test('a reserve sitting at ANOTHER table never feeds the group table\'s cards / round', () => {
  const { mgr } = makeSession5();
  mgr.setIdentity('D', { uid: '1_44' });
  mgr.routeFrame({ id: 'D' }, frame(JSON.stringify([5, { b: 100, Mu: 4, ps: [{ uid: '1_44', sit: 0, C: true }, { uid: '1_99', sit: 1 }], cmd: 202 }])));
  const cards = mgr.cardObserverSnapshot();
  assert.equal(cards.players['1_99'], undefined, 'strangers of the reserve\'s table are not in LỌC BÀI');
  assert.equal(Object.values(cards.slotBinding).includes('1_44'), false);
  assert.equal(mgr.coSeatStatus().browserCount, 3, 'co-seat counts the playing browsers only');
});

test('ĐỔI with a warm reserve: the two swap places, the reserve takes the role; LỌC BÀI follows the slot', () => {
  const { mgr } = makeSession5();
  const coord = mgr._session.coord;
  mgr.setIdentity('B', { uid: '1_22' }); coord.rebindCardSlot('B');
  mgr.setIdentity('D', { uid: '1_44' });
  seedGroup(mgr, { A: 'KEY', B: 'READY' });
  const r = mgr.swapRuns('B', 'D');
  assert.equal(r.swapped, true);
  assert.deepEqual(coord.profileIds(), ['A', 'D', 'C', 'B', 'E'], 'D plays as P2, B is now the reserve');
  assert.equal(mgr.groupRoleOf('D'), 'READY'); assert.equal(mgr.groupRoleOf('B'), null);
  const cards = mgr.cardObserverSnapshot();
  assert.equal(cards.slotBinding.B2, '1_44');
  assert.equal(cards.players['1_22'].controlled, false);
  mgr.endSession();
});

test('TỰ ĐỘNG only ever works with the playing accounts', () => {
  const { mgr } = makeSession5();
  assert.deepEqual(mgr._group._orderedIds(), ['A', 'B', 'C']);
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /function reserveViewFor[\s\S]*?reserve: true, reserveLabel: label/);
  assert.match(main, /\.\.\.reserveViewFor\(runId\)/);
  assert.match(read('ui-phom/phom-qa.js'), /for \(const r of openReserves\(\)\) if \(r\.profileId && !runIds\.includes\(r\.profileId\)\) runIds\.push\(r\.profileId\)/);
});

test('with a reserve open the tool stays above it (P4/P5 open where the tool is); none → a normal window again', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /phomCluster\.on\('update', \(snap\) => \{ send\('phom:cluster', snap\); syncToolOnTop\(snap\); \}\)/);
  const fn = main.slice(main.indexOf('function syncToolOnTop('), main.indexOf('function send('));
  assert.match(fn, /Object\.values\(rs\)\.some\(\(r\) => r && r\.profileId && r\.browserState === 'OPEN'\)/);
  assert.match(fn, /if \(want === _toolOnTop\) return;/, 'only when the reserve count flips');
  assert.match(fn, /shell\.setAlwaysOnTop\(want\)/);
});

// ---- N4 — no dead members; a closed reserve comes back from its own card -------------------------------------------
test('N4: a closed reserve leaves the session; reopening adds it back (warm), never more than 5', () => {
  const { mgr } = makeSession5();
  assert.equal(mgr.removeRun('D').removed, true);
  assert.deepEqual(mgr._session.coord.profileIds(), ['A', 'B', 'C', 'E']);
  assert.equal(mgr.removeRun('B').removed, false, 'a playing browser is never removed this way');
  assert.equal(mgr.addRun('F').added, true);
  assert.deepEqual(mgr._session.coord.profileIds(), ['A', 'B', 'C', 'E', 'F']);
  assert.equal(mgr.addRun('G').added, false, 'at most 3 playing + 2 reserves');
});

test('N4: a closed slot that took a reserve drops its dead browser from the session', () => {
  const { mgr } = makeSession5();
  mgr.swapRuns('B', 'D');                     // B was closed; D plays as P2, B moved to the reserve position
  assert.equal(mgr.removeRun('B').removed, true);
  assert.deepEqual(mgr._session.coord.profileIds(), ['A', 'D', 'C', 'E']);
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /if \(phomSessions && oldRun && !res\.benchedRun\) phomSessions\.removeRun\(oldRun\)/);
  assert.match(main, /RESERVE_SLOTS\.includes\(closed\.slot\) && phomSessions\) phomSessions\.removeRun\(runId\)/);
});

test('N4: the cluster reopens ONLY that closed reserve; main re-adds it to the session; its card has Mở lại', async () => {
  const { mgr, opened } = makeClusterWithReserves();
  await mgr.openCluster();
  const d = mgr.getClusterSnapshot().reserves.D.profileId;
  assert.equal(mgr.reopenReserve('D').error.code, 'PHOM_SLOT_BUSY', 'an open reserve is not reopened');
  mgr.markRunClosed(d, 'USER_CLOSED_WINDOW');
  assert.equal(mgr.reopenReserve('D').ok, true);
  await mgr.openCluster();
  assert.equal(opened.length, 6, 'one browser opened');
  assert.equal(opened[5].slot, 'D');
  assert.equal(mgr.getClusterSnapshot().reserves.D.browserState, 'OPEN');
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /async function reopenReserve[\s\S]*?phomCluster\.reopenReserve\(r\)[\s\S]*?phomSessions\.addRun\(rs\.profileId\)/);
  assert.match(read('ui-phom/phom-qa.js'), /onclick: \(\) => onReopenReserve\(r\.slot\)/);
});
