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

test('bootScript honors a custom binding name', () => {
  assert.match(gh.bootScript({ bindingName: '__x' }), /const BID = "__x"/);
});

// ---- phom-header-bridge — CDP install + push (mock client) ----
function mockClient() {
  const calls = { addBinding: [], addScript: [], evaluate: [], bindingCbs: [], navCbs: [] };
  return {
    calls,
    Runtime: {
      enable: async () => {}, addBinding: async (a) => { calls.addBinding.push(a); },
      evaluate: async (a) => { calls.evaluate.push(a.expression); return {}; },
      bindingCalled: (cb) => calls.bindingCbs.push(cb),
    },
    Page: {
      enable: async () => {}, addScriptToEvaluateOnNewDocument: async (a) => { calls.addScript.push(a.source); },
      frameNavigated: (cb) => calls.navCbs.push(cb),
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

// ---- main-process wiring (source-level) ----
const main = read('desktop/phom-main.cjs');

test('main installs the header on attach and routes clicks to the coordinator', () => {
  assert.match(main, /headerBridge\.installHeader\(client, \{ runId: run\.id, boot: gameHeader\.bootScript\(\)/);
  assert.match(main, /onAction: \(rid, payload\) => phomHeaderAction\(rid, payload\)/);
});

test('main pushes header state on every session update (no Tool screen needed)', () => {
  assert.match(main, /phomSessions\.on\('update', \(snap\) => \{ send\('phom:session', snap\); pushHeaderStates\(\); \}\)/);
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
