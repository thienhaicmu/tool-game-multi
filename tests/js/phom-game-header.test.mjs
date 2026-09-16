// PHASE 6.3.2 — the in-Chromium GAME HEADER. Pure unit tests for the state deriver + boot-script generator
// (game-header.cjs) and the CDP bridge (phom-header-bridge.cjs), plus source-level wiring assertions for
// the main process (install on attach, action router, read-only push). No browser/CDP runtime in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const gh = require('../../desktop/protocol/phom/game-header.cjs');
const bridge = require('../../desktop/protocol/phom/phom-header-bridge.cjs');

// ---- deriveHeaderState — the single business decision (mirrors browserAction + REJOIN/THOÁT PHÒNG) ----
test('not opened -> CHƯA MỞ with a disabled VÀO GAME', () => {
  const s = gh.deriveHeaderState({ opened: false });
  assert.equal(s.statusLabel, 'CHƯA MỞ');
  assert.equal(s.primary.action, 'ENTER_GAME');
  assert.equal(s.primary.disabled, true);
  assert.equal(s.account, '—');
  assert.equal(s.rid, '—');
});

test('opened + entering -> busy ĐANG VÀO GAME (no fake success)', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: false, entering: true });
  assert.match(s.statusLabel, /ĐANG VÀO GAME/);
  assert.equal(s.primary.busy, true);
  assert.equal(s.primary.disabled, true);
});

test('opened + not in game -> VÀO GAME (ENTER_GAME)', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: false });
  assert.equal(s.primary.action, 'ENTER_GAME');
  assert.equal(s.primary.label, 'VÀO GAME');
  assert.equal(s.primary.disabled, undefined);
});

test('in game + SEARCHING -> busy ĐANG TÌM BÀN', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'SEARCHING' });
  assert.match(s.statusLabel, /ĐANG TÌM BÀN/);
  assert.equal(s.primary.busy, true);
});

test('in game + JOINING -> busy ĐANG VÀO BÀN', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINING' });
  assert.match(s.statusLabel, /ĐANG VÀO BÀN/);
  assert.equal(s.primary.busy, true);
});

test('in game + no shared room -> TÌM BÀN needs a bet picked from the server betOptions', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', betOptions: [50, 100, 500] });
  assert.equal(s.primary.action, 'FIND');
  assert.equal(s.primary.label, 'TÌM BÀN');
  assert.equal(s.primary.needsBet, true);
  assert.deepEqual(s.primary.betOptions, [50, 100, 500]);
});

test('in game + a cluster shared RID (not yet joined) -> VÀO BÀN for that RID (no re-discovery)', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', sharedRid: 700100, betOptions: [100] });
  assert.equal(s.primary.action, 'JOIN_SHARED');
  assert.equal(s.primary.label, 'VÀO BÀN');
  assert.equal(s.primary.rid, 700100);
});

test('JOINED -> REJOIN primary + THOÁT PHÒNG (danger) secondary; RID shown', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINED', rid: 700100, sharedRid: 700100 });
  assert.equal(s.statusLabel, 'ĐÃ VÀO BÀN');
  assert.equal(s.primary.action, 'REJOIN');
  assert.equal(s.secondary.length, 1);
  assert.equal(s.secondary[0].action, 'LEAVE');
  assert.equal(s.secondary[0].label, 'THOÁT PHÒNG'); // NOT "THOÁT GAME"
  assert.equal(s.secondary[0].danger, true);
  assert.equal(s.rid, '700100');
  assert.equal(s.joinedShared, true);
});

test('account passes through when known; RID falls back to lastRid then —', () => {
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, account: 'Simms', lastRid: 42, manualState: 'READY' }).account, 'Simms');
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, lastRid: 42, manualState: 'READY' }).rid, '42');
});

// ---- bootScript — the injected page bar (tool-owned overlay only, no game DOM mutation) ----
test('bootScript is idempotent, exposes the render hook + binding, and uses THOÁT PHÒNG naming', () => {
  const src = gh.bootScript();
  assert.match(src, /__phomHeaderInstalled/);            // install-once guard
  assert.match(src, /window\.__phomHeaderRender = function/);
  assert.match(src, /__phomAction/);                     // default binding name
  assert.match(src, /id = '__phom_header'/);             // its OWN element, namespaced
  assert.match(src, /z-index:2147483647/);               // overlay on top
  assert.match(src, /emit\('FIND',\{ stake:Number\(sel\.value\) \}\)/); // server stake, numeric
  // no game-DOM/canvas mutation beyond its own bar + a body margin offset for the bar
  assert.equal(/innerHTML|canvas|document\.title\s*=/.test(src), false);
});

// PHASE 6.3.2.2 — self-healing + identity.
test('bootScript self-heals (re-mounts if the bar was removed) and carries browser identity + actionId', () => {
  const src = gh.bootScript({ slotId: 'B2', profileId: 'prof-x', runId: 'run-9' });
  // already-installed but bar missing => re-mount instead of returning early
  assert.match(src, /if \(window\.__phomHeaderInstalled\) \{ if \(!document\.getElementById\('__phom_header'\) && window\.__phomHeaderMount\) window\.__phomHeaderMount\(\); return; \}/);
  assert.match(src, /window\.__phomHeaderMount = ready/);
  // every action carries slot/profile/run identity + a correlation actionId
  assert.match(src, /"slotId":"B2"/);
  assert.match(src, /"profileId":"prof-x"/);
  assert.match(src, /"runId":"run-9"/);
  assert.match(src, /actionId:/);
  assert.match(src, /slotId: ID\.slotId/);
});

test('bootScript honors a custom binding name', () => {
  assert.match(gh.bootScript({ bindingName: '__x' }), /const BID = "__x"/);
});

// ---- phom-header-bridge — CDP install + push (mock client) ----
function mockClient({ present = true } = {}) {
  const calls = { addBinding: [], addScript: [], evaluate: [], bindingCbs: [], navCbs: [], loadCbs: [], domCbs: [] };
  return {
    calls,
    Runtime: {
      enable: async () => {}, addBinding: async (a) => { calls.addBinding.push(a); },
      // verifyPresent uses returnByValue; the bar-injection evaluates just record the expression.
      evaluate: async (a) => { calls.evaluate.push(a.expression); return a.returnByValue ? { result: { value: present } } : {}; },
      bindingCalled: (cb) => calls.bindingCbs.push(cb),
    },
    Page: {
      enable: async () => {}, addScriptToEvaluateOnNewDocument: async (a) => { calls.addScript.push(a.source); },
      frameNavigated: (cb) => calls.navCbs.push(cb),
      loadEventFired: (cb) => calls.loadCbs.push(cb),
      domContentEventFired: (cb) => calls.domCbs.push(cb),
    },
  };
}

test('installHeader wires the binding + persistent injection + immediate evaluate + a bindingCalled router', async () => {
  const c = mockClient();
  let routed = null;
  const r = await bridge.installHeader(c, { runId: 'B1', boot: 'BOOT();', onAction: (rid, p) => { routed = { rid, p }; } });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls.addBinding[0], { name: '__phomAction' });
  assert.equal(c.calls.addScript[0], 'BOOT();');       // survives navigation/reload
  assert.ok(c.calls.evaluate.includes('BOOT();'));      // current document
  assert.equal(c.calls.bindingCbs.length, 1);
  // a binding call is parsed + routed to onAction with the runId
  c.calls.bindingCbs[0]({ name: '__phomAction', payload: JSON.stringify({ action: 'FIND', stake: 100 }) });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(routed, { rid: 'B1', p: { action: 'FIND', stake: 100 } });
});

test('installHeader is idempotent per client (guarded), and ignores foreign bindings', async () => {
  const c = mockClient();
  await bridge.installHeader(c, { runId: 'B1', boot: 'X();', onAction: () => {} });
  const again = await bridge.installHeader(c, { runId: 'B1', boot: 'X();', onAction: () => {} });
  assert.equal(again.already, true);
  assert.equal(c.calls.addBinding.length, 1);
  let hit = false;
  c.calls.bindingCbs[0]({ name: 'somethingElse', payload: '{}' });
  await new Promise((res) => setImmediate(res));
  assert.equal(hit, false); // no throw, no route
});

test('pushHeaderState evaluates window.__phomHeaderRender with the JSON state', () => {
  const c = mockClient();
  bridge.pushHeaderState(c, { account: 'Simms', rid: '5' });
  assert.match(c.calls.evaluate[0], /window\.__phomHeaderRender && window\.__phomHeaderRender\(\{"account":"Simms","rid":"5"\}\)/);
});

// PHASE 6.3.2.2 — the boot is re-driven from EVERY lifecycle signal (attach + load + DOMContentLoaded +
// top-frame navigation), so the header is present whether attach lands before or after the page loaded.
test('installHeader re-injects the boot on load / DOMContentLoaded / top-frame navigation (not once)', async () => {
  const c = mockClient();
  await bridge.installHeader(c, { runId: 'B1', slotId: 'B1', boot: 'BOOT();', onAction: () => {} });
  const injectedAtAttach = c.calls.evaluate.filter((e) => e === 'BOOT();').length;
  assert.ok(injectedAtAttach >= 1, 'injected on attach');
  assert.equal(c.calls.loadCbs.length, 1); c.calls.loadCbs[0]();
  assert.equal(c.calls.domCbs.length, 1); c.calls.domCbs[0]();
  c.calls.navCbs[0]({ frame: { url: 'x' } }); // top frame (no parentId)
  await new Promise((r) => setImmediate(r));
  assert.ok(c.calls.evaluate.filter((e) => e === 'BOOT();').length >= injectedAtAttach + 3, 'boot re-driven by each signal');
});

test('installHeader logs each step and reports errors instead of swallowing them', async () => {
  const events = [];
  const c = mockClient();
  await bridge.installHeader(c, { runId: 'B1', slotId: 'B1', boot: 'B();', onAction: () => {}, log: (ev, d) => events.push({ ev, d }) });
  const names = events.map((e) => e.ev);
  assert.ok(names.includes('binding-install'));
  assert.ok(names.includes('header-inject'));
  assert.ok(names.includes('header-ready'));
  // a routed click is logged with its actionId (traceable end-to-end)
  c.calls.bindingCbs[0]({ name: '__phomAction', payload: JSON.stringify({ action: 'ENTER_GAME', actionId: 'a1' }) });
  await new Promise((r) => setImmediate(r));
  assert.ok(events.some((e) => e.ev === 'action-received' && e.d && e.d.actionId === 'a1'));
});

test('verifyPresent reflects whether the bar + binding exist in the page', async () => {
  assert.equal(await bridge.verifyPresent(mockClient({ present: true })), true);
  assert.equal(await bridge.verifyPresent(mockClient({ present: false })), false);
});

// ---- main-process wiring (source-level) ----
const main = read('desktop/phom-main.cjs');

test('main installs the header on attach with per-run identity + logging, routes clicks to the coordinator', () => {
  assert.match(main, /gameHeader\.bootScript\(\{ slotId: run\.slot \|\| null, profileId: run\.profileId \|\| null, runId: run\.id, observerLog: process\.env\.PHOM_HEADER_OBSERVER_LOG === '1', clickLog: process\.env\.PHOM_CLICK_LOG === '1' \|\| process\.env\.PHOM_HEADER_LOG === '1' \}\)/);
  assert.match(main, /headerBridge\.installHeader\(client, \{ runId: run\.id, slotId: run\.slot \|\| null, boot, onAction: \(rid, payload\) => phomHeaderAction\(rid, payload\), log: headerLog \}\)/);
});

// PHASE 6.3.2.2 / 6.3.2.3 — reliability guards in the action router (single-flight via the pure guard,
// identity cross-check, and dead-session guard). PHOM_HEADER_BUSY now lives in header-action-guard.cjs.
test('router has a per-browser single-flight + identity guard and a dead-session guard', () => {
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('async function phomHeaderAction(') + 5200);
  assert.match(r, /evaluateHeaderAction\(/);             // pure single-flight + identity guard
  assert.match(r, /busy: !!headerActionBusy\[rid\]/);    // one op per browser
  assert.match(r, /if \(!runClientFor\(rid\)\)/);        // never route into a dead CDP session
  assert.match(r, /PHOM_HEADER_NO_CLIENT/);
  assert.match(r, /finally \{ delete headerActionBusy\[rid\]/);
  const guard = read('desktop/protocol/phom/header-action-guard.cjs');
  assert.match(guard, /PHOM_HEADER_BUSY/);
  assert.match(guard, /STALE_RUN/); assert.match(guard, /STALE_PROFILE/); assert.match(guard, /DUPLICATE_ACTION_ID/);
});

test('main tracks header readiness + exposes read-only runtime/CDP/header status for Screen 2', () => {
  assert.match(main, /const headerReady = Object\.create\(null\)/);
  assert.match(main, /function browserRuntimeStatus\(runId\)/);
  // §6.3.2.7 — HEADER is READY only when the page CONFIRMED the DOM present; RECOVERING when binding up but
  // DOM missing; never a stale READY.
  assert.match(main, /header = headerDomPresent\[rid\] \? 'READY' : 'RECOVERING'/);
  assert.match(main, /const headerDomPresent = Object\.create\(null\)/);
  // the manual snapshot merges it per browser
  assert.match(main, /Object\.assign\(b, browserRuntimeStatus\(b\.profileId\)\)/);
});

test('main pushes header state on session updates via a coalesced broadcast (no Tool screen needed)', () => {
  // §6.3.2.6 lag fix — the per-frame storm is throttled; pushHeaderStates dedupes unchanged states.
  assert.match(main, /phomSessions\.on\('update', \(snap\) => \{ scheduleSessionBroadcast\(snap\); \}\)/);
  assert.match(main, /function scheduleSessionBroadcast\(snap\)/);
  assert.match(main, /if \(headerLastPushed\[rid\] === json\) continue;/); // per-run dedupe skips the CDP evaluate
});

test('the cluster shared RID = the first JOINED browser (header VÀO BÀN uses it, § shared RID)', () => {
  assert.match(main, /function headerSharedRid\(browsers\)/);
  assert.match(main, /manualState === 'JOINED' && b\.rid != null/);
});

test('inGame is derived like the renderer slotInPhom (socketReady + connected + channel list)', () => {
  assert.match(main, /const inGame = opened && !!b\.socketReady && !!b\.connected && \(b\.channelCount \|\| 0\) > 0/);
  // and the coordinator snapshot now carries channelCount for the manual browser view
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  assert.match(coord, /channelCount: Array\.isArray\(c\.channels\) \? c\.channels\.length : 0,\n\s*rid: rec\._joinedRid/);
});

test('REJOIN uses lastRid and LEAVE (THOÁT PHÒNG) preserves it (coordinator, unchanged this phase)', () => {
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  // rejoin falls back to _lastRid
  assert.match(coord, /rec\._joinedRid != null \? rec\._joinedRid : rec\._lastRid/);
  // leave clears _joinedRid but NOT _lastRid
  const leave = coord.slice(coord.indexOf('async manualLeave('), coord.indexOf('async manualLeave(') + 700);
  assert.match(leave, /rec\._joinedRid = null/);
  assert.equal(/_lastRid = null/.test(leave), false, 'LEAVE must preserve _lastRid for REJOIN');
});
