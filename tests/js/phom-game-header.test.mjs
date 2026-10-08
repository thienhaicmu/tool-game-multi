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

test('in game + JOINING -> ĐANG VÀO BÀN, and Vào shows it is running (Vào.)', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINING' });
  assert.match(s.statusLabel, /ĐANG VÀO BÀN/);
  assert.equal(s.joining, true);
  assert.equal(s.canAct, true, 'the button row stays');
});

test('JOINED -> SS <rid>, the whole button row, Thoát enabled', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINED', rid: 700100, sharedRid: 700100 });
  assert.equal(s.statusLabel, 'SS 700100');
  assert.equal(s.canAct, true); assert.equal(s.inTable, true); assert.equal(s.primary, null);
  assert.equal(s.rid, '700100'); assert.equal(s.ssDefault, 700100);
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
  assert.match(src, /emit\('FIND_TABLE'\)/); // the stake is the Phỏm tool's; the bar never invents one
  // no game-DOM/canvas mutation beyond its own bar + a body margin offset for the bar — and (3.1.32) never the page title
  assert.equal(/innerHTML|canvas/.test(src), false);
  assert.equal(/document\.title\s*=/.test(src), false, 'the tab title is the game\'s own');
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
  assert.match(main, /gameHeader\.bootScript\(\{ nonce: headerKey, slotId: run\.slot \|\| null, profileId: run\.profileId \|\| null, runId: run\.id, observerLog: process\.env\.PHOM_HEADER_OBSERVER_LOG === '1', clickLog: process\.env\.PHOM_CLICK_LOG === '1' \|\| process\.env\.PHOM_HEADER_LOG === '1' \}\)/);
  assert.match(main, /headerBridge\.installHeader\(client, \{ runId: run\.id, slotId: run\.slot \|\| null, boot, onAction: \(rid, payload\) => phomHeaderAction\(rid, payload\), log: headerLog \}\)/);
});

// PHASE 6.3.2.2 / 6.3.2.3 — reliability guards in the action router (single-flight via the pure guard,
// identity cross-check, and dead-session guard). PHOM_HEADER_BUSY now lives in header-action-guard.cjs.
test('router has a per-browser single-flight + identity guard and a dead-session guard', () => {
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('function liveRunCount('));
  assert.match(r, /evaluateHeaderAction\(/);             // pure single-flight + identity guard
  assert.match(r, /busy: !!headerActionBusy\[rid\]/);    // one op per browser
  assert.match(r, /if \(!runClientFor\(rid\)\)/);        // never route into a dead CDP session
  assert.match(r, /PHOM_HEADER_NO_CLIENT/);
  // §34 — an escape action (HỦY / ⟳ / ⏻ / ↑) runs ALONGSIDE the long op it escapes, so it neither takes nor
  // releases the flag; every other action still releases it unconditionally.
  assert.match(r, /if \(!exempt\) headerActionBusy\[rid\] = true;/);
  assert.match(r, /finally \{ if \(!exempt\) delete headerActionBusy\[rid\]; \}/);
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

test('the shared số bàn = the group\'s (Tạo found it); header and Tool window read the same value', () => {
  assert.match(main, /function headerSharedRid\(\)/);
  assert.match(main, /sharedRid: phomSessions\.sharedRid\(\)/, 'the Tool window snapshot');
  const sm = read('desktop/protocol/phom/host-session-manager.cjs');
  assert.match(sm, /sharedRid\(\) \{ const g = this\._g\(\); return g \? g\.rid\(\) : null; \}/);
});

test('inGame is derived like the renderer slotInPhom (socketReady + connected + channel list)', () => {
  assert.match(main, /const inGame = opened && !!b\.socketReady && !!b\.connected && \(b\.channelCount \|\| 0\) > 0/);
  // and the coordinator snapshot now carries channelCount for the manual browser view
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  // NOTE: use \s* (not an explicit \n) so the assertion is line-ending agnostic — the file is LF in git but a
  // Windows checkout (autocrlf) yields CRLF, and a literal \n would not match across the intervening \r.
  assert.match(coord, /channelCount: c\.channels\.length,/);
  assert.match(coord, /rid: rec\._joinedRid, lastRid: rec\._lastRid,/);
});

test('STATE-01 initial lobby (opened, not in game) -> VÀO GAME', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: false, entering: false });
  assert.equal(s.primary.action, 'ENTER_GAME');
  assert.equal(s.primary.label, 'VÀO GAME');
  assert.equal(s.primary.disabled, undefined);
});

test('STATE-02 during ENTER (entering) -> ĐANG VÀO GAME… (busy, disabled)', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: false, entering: true });
  assert.match(s.statusLabel, /ĐANG VÀO GAME/);
  assert.equal(s.primary.busy, true);
  assert.equal(s.primary.disabled, true);
});

test('STATE-04 authoritative non-game/lobby (entering cleared) -> VÀO GAME (never stuck)', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: false, entering: false });
  assert.equal(s.primary.action, 'ENTER_GAME');
  assert.equal(s.primary.label, 'VÀO GAME');
});

test('STATE-05 enteringActive is BOUNDED: within window active, past window reverts (not stuck)', () => {
  const T = gh.ENTER_GAME_TIMEOUT_MS;
  assert.equal(typeof T, 'number'); assert.ok(T > 0);
  assert.equal(gh.enteringActive({ pending: true, inGame: false, startedAt: 0, now: 1000, timeoutMs: T }), true);   // in flight
  assert.equal(gh.enteringActive({ pending: true, inGame: false, startedAt: 0, now: T + 1, timeoutMs: T }), false); // timed out → NOT_IN_GAME
  assert.equal(gh.enteringActive({ pending: true, inGame: false, startedAt: null, now: 9e9 }), true);               // just clicked, no clock yet
});

test('STATE-06/09 a fresh ENTER re-arms the bounded timeout, and ↻ WEB reset clears the ENTERING transient', () => {
  // ↻ WEB reload path (reloadWebRun.resetPhom, shared by the header ⟳ button) resets entering + cancels the timer.
  assert.match(main, /delete headerEntering\[rid\]; clearHeaderEnterTimer\(rid\); delete headerError\[rid\]/);
  // a fresh ENTER cancels any prior timer before re-arming (no leaked/overlapping timers).
  assert.match(main, /function armEnterTimeout\(rid\) \{\s*clearHeaderEnterTimer\(rid\);\s*headerEnterTimer\[rid\] = setTimeout\(/);
  assert.match(main, /headerEntering\[rid\] = true;\s*armEnterTimeout\(rid\);/);
});

test('STATE-07 pending flag is main-side + guarded (late/stale ENTER cannot resurrect a newer state)', () => {
  // headerEntering is keyed by rid and only set inside the single-flight guarded ENTER branch; the pure
  // enteringActive gate + inGame evidence always win, so an old ENTER cannot override newer authoritative state.
  assert.match(main, /const headerEntering = Object\.create\(null\)/);
  assert.match(main, /gameHeader\.enteringActive\(\{ pending: !!headerEntering\[String\(runId\)\]/);
});

test('STATE-08 transport/CDP/header health is NOT treated as IN_GAME', () => {
  // inGame requires authoritative game evidence (channelCount > 0), never merely socket/CDP connected.
  assert.match(main, /const inGame = opened && !!b\.socketReady && !!b\.connected && \(b\.channelCount \|\| 0\) > 0/);
  // pure gate: authoritative inGame (or nothing pending) always wins over the optimistic ENTERING flag.
  assert.equal(gh.enteringActive({ pending: true, inGame: true, startedAt: 0, now: 0 }), false);
  assert.equal(gh.enteringActive({ pending: false }), false);
});

test('main: bounded ENTERING timeout is armed on ENTER and cancelled on authoritative evidence / failure', () => {
  assert.match(main, /const headerEnterTimer = Object\.create\(null\)/);
  assert.match(main, /function clearHeaderEnterTimer\(rid\)/);
  // armed on ENTER accept, and the callback reverts the header (delete entering + re-push) if still pending.
  assert.match(main, /if \(headerEntering\[rid\]\) \{ delete headerEntering\[rid\]; delete headerEnterStartedAt\[rid\];[\s\S]*?pushHeaderStates\(\); \}/);
  // cancelled the instant authoritative in-game evidence arrives.
  assert.match(main, /delete headerEntering\[rid\]; clearHeaderEnterTimer\(rid\);/);
  // cancelled on an immediate ENTER send failure.
  assert.match(main, /delete headerEntering\[rid\]; delete headerEnterStartedAt\[rid\]; clearHeaderEnterTimer\(rid\); \}/);
});

// ---- PHASE 6.3.6 — USER-SELECTED FINDER (room anchor), never defaulted to Player 1 ----
// isFinder is a PROP of the derived view (true = may FIND). No finder chosen → true for every browser; a
// finder chosen → true only for that browser. finderIndex drives the dynamic "CHỜ PLAYER N TÌM BÀN" label.

test('in the lobby with no group the bar tells the user to press Dò Key on ONE account', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true });
  assert.match(s.statusLabel, /Dò Key/); assert.equal(s.canAct, true);
});

test('BC: the bar is the reference strip — no background, fixed at the top, only the table buttons + Hide', () => {
  const src = gh.bootScript({ slotId: 'B2', profileId: 'p', runId: 'r' });
  // the reference tool's colours: SS red · Copy orange · Vào green · ReJoin yellow · Tạo purple · Dò Key red · Thoát blue · Hide white
  for (const c of ["chip('SS', '#e3170a')", "txtBtn('Copy','#ff9800'", "'Vào','#2e9e3e'", "'#ffe600'", "'#8e24aa'", "'#e53935'", "txtBtn('Thoát','#1e6fe0'", 'background:#ffffff;color:#111']) assert.ok(src.includes(c), c);
  assert.match(src, /position:fixed;top:0;left:0;right:0;[^']*width:100%;[^']*background:transparent;/, 'no background over the game');
  assert.equal(/__drag/.test(src), false, 'a fixed strip is not draggable');
  assert.match(src, /const infoLine = mk\('div','position:fixed;top:23px;left:0;right:0;[^']*text-align:center;[^']*color:#4fd8ff;[^']*'\+OUTLINE\+'/, 'status text in the name colour with a thin navy letter outline');
  assert.match(src, /var OUTLINE = 'text-shadow:-.5px -.5px 0 #0b2545,/);
  assert.equal(/localStorage|sessionStorage/.test(src), false, 'no persistent storage in the injected header');
  assert.match(src, /hideBtn\.textContent = __collapsed \? 'Show' : 'Hide';/);
  // only what the reference tool has: SS · Copy · Vào · ReJoin · Tạo · Dò Key · Thoát (+ VÀO GAME / TẢI LẠI before the game)
  for (const a of ['JOIN_CODE', 'REJOIN', 'SCAN_TABLE', 'FIND_TABLE', 'CANCEL_FIND', 'LEAVE']) assert.match(src, new RegExp("emit\\('" + a + "'"));
  assert.equal(/menuBtn|menuItem|emit\('STOP'\)|emit\('FOCUS'\)|emit\('NEW_TABLE'\)|CAPTURE_|rooms/.test(src), false, 'the ⋮ menu and its extras are gone');
  assert.equal(/emit\('HOST'\)|emit\('READY'\)|emit\('KICK'\)/.test(src), false);
});

test('BC: the bar has NO stake picker (the Phỏm tool owns it) and the Dò Key / Tạo / Vào buttons always carry their onclick', () => {
  const src = gh.bootScript();
  // one stake for the session: the bar only DISPLAYS it, and Dò Key / Tạo need it before they can be pressed
  assert.doesNotMatch(src, /stakeSel/);
  assert.match(src, /CHƯA CHỌN CƯỢC/);
  assert.match(src, /function needStake\(\)\{ if\(state\.stake == null\)\{ showFeedback\([^\n]+return true; \}/);
  // the reference tool's buttons: the running one ends with '.' and a second click stops it (DỪNG = CANCEL_FIND)
  assert.match(src, /txtBtn\(keying \? 'Dò Key\.' : 'Dò Key', [^,]+, function\(\)\{ if\(keying\)\{ emit\('CANCEL_FIND'\); return; \} if\(needStake\(\)\) return; emit\('FIND_TABLE'\); \}/);
  assert.match(src, /txtBtn\(scanning \? 'Tạo\.' : 'Tạo', [^,]+, function\(\)\{ if\(scanning\)\{ emit\('CANCEL_FIND'\); return; \} if\(needStake\(\)\) return; emit\('SCAN_TABLE'\); \}/);
  // Vào parses the SS box without a regex (a lost backslash once turned /^\\d+$/ into /^d+$/ and the button did nothing)
  assert.match(src, /txtBtn\(state\.joining \? 'Vào\.' : 'Vào','#2e9e3e',function\(\)\{ var r=ssRid\(\); if\(r==null\)\{ showFeedback\([^)]+\); return; \} emit\('JOIN_CODE',\{ rid:r \}\); \}/);
  assert.match(src, /txtBtn\(state\.rejoinOn \? 'ReJoin\.' : 'ReJoin'/);
  assert.match(src, /txtBtn\('Thoát','#1e6fe0',function\(\)\{ emit\('LEAVE'\); \}/);
  assert.doesNotMatch(src, /\^d\+\$/);
});

test('BC: the header router handles only what the bar sends; TẢI LẠI reuses the tool window\'s reload', () => {
  assert.match(main, /async function reloadWebRun\(runId\)/);
  assert.match(main, /action === 'RELOAD'\) \{[\s\S]*?res = await reloadWebRun\(rid\);/);
  assert.equal(/action === 'STOP'|action === 'FOCUS'|action === 'NEW_TABLE'|action === 'CAPTURE_/.test(main), false);
  // the tool window keeps reload / close per browser
  assert.match(main, /ipcMain\.handle\('phom:reload-web', guarded\(async \(_e, cfg\) => reloadWebRun\(cfg && cfg\.browserId\)\)\)/);
  assert.match(main, /ipcMain\.handle\('phom:close-browser', guarded\(async \(_e, cfg\) => closeBrowserRun\(cfg && cfg\.browserId\)\)\)/);
});

test('unconfirmed leave says so and keeps Thoát on the bar', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'LEAVE_UNCONFIRMED', sharedRid: 123 });
  assert.match(s.statusLabel, /CHƯA XÁC NHẬN RỜI BÀN/);
  assert.equal(s.canAct, true);
});

test('DÒ KEY / TẠO on the bar: the bar stays while it searches (Tạo. / Dò Key.), progress in the line under it; ReJoin shows ON', () => {
  const base = { opened: true, inGame: true, stake: 20000 };
  const searching = gh.deriveHeaderState({ ...base, manualState: 'SEARCHING', searchKind: 'SCAN', searchElapsedSec: 12, searchAttempt: 6 });
  assert.equal(searching.statusLabel, 'ĐANG DÒ BÀN KEY 12s · lần 6');
  assert.equal(searching.canAct, true, 'every button stays, like the reference tool');
  assert.equal(searching.searchKind, 'SCAN');
  assert.equal(gh.deriveHeaderState({ ...base, manualState: 'SEARCHING', searchKind: 'KEY' }).statusLabel, 'ĐANG DÒ KEY');
  assert.match(gh.deriveHeaderState({ ...base, manualState: 'READY' }).statusLabel, /bấm Dò Key/);
  const next = gh.deriveHeaderState({ ...base, manualState: 'READY', keySeated: true });
  assert.match(next.statusLabel, /KEY đã ngồi · bấm Tạo/); assert.equal(next.keySeated, true);
  assert.equal(gh.deriveHeaderState({ ...base, manualState: 'JOINED', rid: 7907972, rejoinOn: true }).rejoinOn, true);
  assert.equal(gh.HEADER_ACTIONS.SCAN_TABLE.short, 'Tạo'); assert.equal(gh.HEADER_ACTIONS.FIND_TABLE.short, 'Dò Key');
  const src = gh.bootScript();
  assert.match(src, /state\.rejoinOn \? 'ReJoin\.' : 'ReJoin'/);
  // the line under the bar: ID Bàn · Số người · name-money of everyone at the table
  const seated = gh.deriveHeaderState({ ...base, manualState: 'JOINED', rid: 7907972, playerCount: 3, money: 453384,
    players: [{ name: 'gdufuud', money: 453384, host: true, ours: true }, { name: 'riftraidpu454', money: 789200, ours: false }] });
  assert.equal(seated.playerCount, 3); assert.equal(seated.money, 453384);
  assert.deepEqual(seated.players.map((p) => [p.name, p.money, p.host, p.ours]), [['gdufuud', 453384, true, true], ['riftraidpu454', 789200, false, false]]);
  assert.match(src, /'ID Bàn: ' \+ \(state\.joinedViaChannel \? 'chưa có \(kênh ' \+ state\.rid \+ '\)' : state\.rid\) \+ ' · Số người: '/);
  // SS never holds a stake channel (live run 2026-10-03: 139 in the SS box → every Vào refused, code 166)
  assert.equal(gh.deriveHeaderState({ ...base, manualState: 'JOINED', rid: 139, joinedViaChannel: true }).ssDefault, null);
  assert.equal(gh.deriveHeaderState({ ...base, manualState: 'JOINED', rid: 139, joinedViaChannel: true, sharedRid: 8039315 }).ssDefault, 8039315);
});
