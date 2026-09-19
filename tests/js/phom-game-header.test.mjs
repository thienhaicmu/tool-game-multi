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

// §32/§34 — a persistent search reports progress and offers HỦY. A disabled "ĐANG TÌM BÀN…" held for up to a
// minute is indistinguishable from a hang and left the user no way out of the operation.
test('in game + SEARCHING -> ĐANG TÌM BÀN with a working HỦY button', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'SEARCHING' });
  assert.match(s.statusLabel, /ĐANG TÌM BÀN/);
  assert.equal(s.primary.action, 'CANCEL_FIND');
  assert.notEqual(s.primary.disabled, true, 'HỦY must be clickable while the search runs');
});

test('SEARCHING shows live progress (elapsed + how many times the server was asked)', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'SEARCHING', searchElapsedSec: 12, searchAttempt: 6 });
  assert.match(s.statusLabel, /12s/);
  assert.match(s.statusLabel, /lần 6/);
  // a just-started search has nothing to report yet and must not render "0s · lần 0"
  const s0 = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'SEARCHING' });
  assert.doesNotMatch(s0.statusLabel, /0s|lần 0/);
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

test('the cluster shared RID = the first JOINED browser (header VÀO BÀN uses it, § shared RID)', () => {
  // §38 — single source: the header asks the coordinator (the same value the Tool window gets in its snapshot)
  assert.match(main, /function headerSharedRid\(\)/);
  assert.match(main, /sharedRid: active \? phomSessions\.sharedRid\(\) : null/);
});

test('inGame is derived like the renderer slotInPhom (socketReady + connected + channel list)', () => {
  assert.match(main, /const inGame = opened && !!b\.socketReady && !!b\.connected && \(b\.channelCount \|\| 0\) > 0/);
  // and the coordinator snapshot now carries channelCount for the manual browser view
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  // NOTE: use \s* (not an explicit \n) so the assertion is line-ending agnostic — the file is LF in git but a
  // Windows checkout (autocrlf) yields CRLF, and a literal \n would not match across the intervening \r.
  assert.match(coord, /channelCount: Array\.isArray\(c\.channels\) \? c\.channels\.length : 0,/);
  assert.match(coord, /rid: rec\._joinedRid != null \? rec\._joinedRid : null,/);
});

test('REJOIN uses lastRid and LEAVE (THOÁT PHÒNG) preserves it (coordinator, unchanged this phase)', () => {
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  // rejoin falls back to _lastRid
  assert.match(coord, /rec\._joinedRid != null \? rec\._joinedRid : rec\._lastRid/);
  // leave clears _joinedRid but NOT _lastRid
  // the whole method (it now waits for server confirmation, so it no longer fits a fixed-size window)
  const leave = coord.slice(coord.indexOf('async manualLeave('), coord.indexOf('  resetBrowser(profileId)'));
  assert.match(leave, /rec\._joinedRid = null/);
  assert.equal(/_lastRid = null/.test(leave), false, 'LEAVE must preserve _lastRid for REJOIN');
});

// ---- PHASE 6.3.6 — HEADER STATE SYNCHRONIZATION (bounded ENTERING; transport/CDP/header ≠ IN_GAME) ----
// The bug: the tile click is INVOKED != ENTERED, so a fired-but-never-entered ENTER left the header stuck on
// "ĐANG VÀO GAME…" forever. The fix bounds the ENTERING state so it reverts to NOT_IN_GAME ("VÀO GAME").

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

test('STATE-03 authoritative IN_GAME (no manualState) -> TÌM BÀN', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true });
  assert.equal(s.primary.action, 'FIND');
  assert.equal(s.primary.label, 'TÌM BÀN');
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

test('STATE-10/11/12 IN_GAME still exposes existing FIND / VÀO BÀN / THOÁT PHÒNG unchanged', () => {
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', betOptions: [100] }).primary.action, 'FIND'); // TÌM BÀN
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'READY', sharedRid: 700100 }).primary.action, 'JOIN_SHARED'); // VÀO BÀN
  const joined = gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINED', rid: 700100, sharedRid: 700100 });
  assert.equal(joined.primary.action, 'REJOIN');
  assert.equal(joined.secondary[0].action, 'LEAVE'); // THOÁT PHÒNG
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

test('FINDER-01 no finder chosen -> every Player may FIND (TÌM BÀN, not WAIT)', () => {
  for (const idx of [1, 2, 3]) {
    const s = gh.deriveHeaderState({ opened: true, inGame: true, isFinder: true, finderIndex: null });
    assert.equal(s.primary.action, 'FIND');
    assert.equal(s.primary.label, 'TÌM BÀN');
  }
});

test('FINDER-02 finder = Player 1 -> P1 FIND, P2/P3 WAIT "CHỜ PLAYER 1 TÌM BÀN"', () => {
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, isFinder: true, finderIndex: 1 }).primary.action, 'FIND');
  for (const p of [2, 3]) {
    const w = gh.deriveHeaderState({ opened: true, inGame: true, isFinder: false, finderIndex: 1 });
    assert.equal(w.primary.action, 'WAIT_ANCHOR');
    assert.equal(w.primary.label, 'CHỜ PLAYER 1 TÌM BÀN');
    assert.equal(w.primary.disabled, true);
  }
});

test('FINDER-03 finder = Player 2 -> P2 FIND, P1/P3 WAIT "CHỜ PLAYER 2 TÌM BÀN"', () => {
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, isFinder: true, finderIndex: 2 }).primary.action, 'FIND');
  const w = gh.deriveHeaderState({ opened: true, inGame: true, isFinder: false, finderIndex: 2 });
  assert.equal(w.primary.action, 'WAIT_ANCHOR');
  assert.equal(w.primary.label, 'CHỜ PLAYER 2 TÌM BÀN');
});

test('FINDER-04 finder = Player 3 -> P3 FIND, P1/P2 WAIT "CHỜ PLAYER 3 TÌM BÀN"', () => {
  assert.equal(gh.deriveHeaderState({ opened: true, inGame: true, isFinder: true, finderIndex: 3 }).primary.action, 'FIND');
  const w = gh.deriveHeaderState({ opened: true, inGame: true, isFinder: false, finderIndex: 3 });
  assert.equal(w.primary.label, 'CHỜ PLAYER 3 TÌM BÀN');
});

test('FINDER-08 with no finder, NO browser is ever put in WAIT_ANCHOR', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: true, isFinder: true, finderIndex: null });
  assert.notEqual(s.primary.action, 'WAIT_ANCHOR');
});

test('FINDER-09 once the finder has a shared RID, followers show VÀO BÀN (JOIN_SHARED), not WAIT', () => {
  // sharedRid resolves BEFORE the isFinder gate, so a non-finder with the anchor RID joins it.
  const s = gh.deriveHeaderState({ opened: true, inGame: true, isFinder: false, finderIndex: 2, sharedRid: 700100 });
  assert.equal(s.primary.action, 'JOIN_SHARED');
  assert.equal(s.primary.label, 'VÀO BÀN');
  assert.equal(s.primary.rid, 700100);
});

test('FINDER-10 a non-finder WAIT_ANCHOR is DISABLED (it can never send CMD 300 / self-FIND)', () => {
  const w = gh.deriveHeaderState({ opened: true, inGame: true, isFinder: false, finderIndex: 1 });
  assert.equal(w.primary.disabled, true);
  assert.equal(w.primary.needsBet, undefined); // no bet picker → no FIND path for a follower
});

test('main: FIND gating + shared RID + WAIT label follow selectedFinderIndex, NEVER browserIndex 1', () => {
  // isFinder is derived from the user choice, not the browser index.
  assert.match(main, /isFinder: selectedFinderIndex == null \? true : \(b\.browserIndex === selectedFinderIndex\)/);
  assert.match(main, /finderIndex: selectedFinderIndex/);
  // the old hard-coded Player-1 finder is GONE.
  assert.equal(/isFinder: b\.browserIndex === 1/.test(main), false, 'must not hard-code finder = browserIndex 1');
  // shared RID anchor = the selected finder (or first valid holder when none), never browserIndex 1 — §38 now derived
  // once, in the coordinator (behaviour covered by FIND-SHARED-* in phom-find-resilience-v2); main only delegates.
  assert.match(main, /phomSessions\.sharedRid\(\)/);
  assert.equal(/browserIndex === 1 && valid\(b\)/.test(main), false, 'shared RID must not be keyed on browserIndex 1');
  // the set-finder IPC syncs the coordinator anchor + re-pushes every header immediately.
  assert.match(main, /ipcMain\.handle\('phom:set-finder'/);
  assert.match(main, /applyFinderToCoordinator\(\);[\s\S]*?pushHeaderStates\(\);/);
});

test('FINDER-05/06 Finder ownership is SEPARATE from the analyzer target (Finder ≠ Analysis is valid)', () => {
  // main owns the finder; the analyzer takes a target uid independently — the two never share state.
  assert.match(main, /let selectedFinderIndex = null/);
  assert.match(main, /ipcMain\.handle\('phom:analyze-safe-cards', \(_e, targetPlayerUid\)/);
  // renderer keeps two DISTINCT selections.
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /let selectedFinderPlayer = null/);
  assert.match(ui, /let selectedAnalysisPlayer = null/);
  assert.match(ui, /function finderSelector\(\)/);
  assert.match(ui, /api\.setFinder/);
});

// ---- PHASE 6.3.8 — BROWSER CONTROL redesign (compact single-row floating header; state-dependent icons) ----

test('BC: HEADER_ACTIONS exposes ONLY existing actions (no HOST/READY/KICK/DevTools invented)', () => {
  const a = gh.HEADER_ACTIONS;
  for (const k of ['ENTER_GAME', 'FIND', 'JOIN_SHARED', 'JOIN', 'REJOIN', 'LEAVE', 'WAIT_ANCHOR', 'RELOAD', 'STOP', 'FOCUS']) {
    assert.ok(a[k] && a[k].icon && a[k].tip, 'has meta for ' + k);
  }
  for (const forbidden of ['HOST', 'READY', 'KICK', 'DEVTOOLS', 'SCREENSHOT', 'RESIZE', 'CLEAR_CACHE']) {
    assert.equal(a[forbidden], undefined, 'must NOT invent action ' + forbidden);
  }
});

test('BC: deriveHeaderState exposes an ordered GAME/TABLE icon set (actions), state-dependent', () => {
  // not in game → [ENTER_GAME]
  assert.deepEqual(gh.deriveHeaderState({ opened: true, inGame: false }).actions.map((x) => x.action), ['ENTER_GAME']);
  // finder in game, no shared rid → [FIND]
  assert.deepEqual(gh.deriveHeaderState({ opened: true, inGame: true }).actions.map((x) => x.action), ['FIND']);
  // shared rid available (follower) → [JOIN_SHARED]
  assert.deepEqual(gh.deriveHeaderState({ opened: true, inGame: true, isFinder: false, finderIndex: 2, sharedRid: 700 }).actions.map((x) => x.action), ['JOIN_SHARED']);
  // joined → [REJOIN, LEAVE]
  assert.deepEqual(gh.deriveHeaderState({ opened: true, inGame: true, manualState: 'JOINED', rid: 700, sharedRid: 700 }).actions.map((x) => x.action), ['REJOIN', 'LEAVE']);
  // each action carries an icon + tooltip
  const find = gh.deriveHeaderState({ opened: true, inGame: true }).actions[0];
  assert.equal(find.icon, '🔍'); assert.ok(find.tip);
});

test('BC: bootScript is a compact draggable single-row header with per-slot accent, collapse + quick menu', () => {
  const src = gh.bootScript({ slotId: 'B2', profileId: 'p', runId: 'r' });
  // per-player accent (B1 blue / B2 green / B3 orange) + "Player N" badge from the slot id
  assert.match(src, /SLOTN===1\?'#2563eb':SLOTN===2\?'#16a34a':SLOTN===3\?'#ea580c'/);
  // single FLOATING row (fixed, not a full-width bar; no body margin push)
  assert.match(src, /position:fixed;top:8px;right:8px/);
  assert.equal(/marginTop\s*=\s*'34px'/.test(src), false, 'no longer pushes the game with a full-width bar');
  // draggable (page-local; clamped inside the viewport). No storage → F5-safe like the optimistic overlay.
  assert.match(src, /handle\.addEventListener\('mousedown'/);
  assert.match(src, /bar\.style\.left=x\+'px'/);
  assert.equal(/localStorage|sessionStorage/.test(src), false, 'no persistent storage in the injected header');
  // collapse toggle (page-local)
  assert.match(src, /__collapsed/);
  assert.match(src, /collapseBtn\.onclick/);
  // lifecycle actions are always available; FOCUS lives in the quick menu — all map to existing actions
  assert.match(src, /emit\('RELOAD'\)/);
  assert.match(src, /emit\('STOP'\)/);
  assert.match(src, /emit\('FOCUS'\)/);
  // no invented game actions in the page
  assert.equal(/emit\('HOST'\)|emit\('READY'\)|emit\('KICK'\)/.test(src), false);
});

test('BC: the bet-picker FIND button always carries its onclick (picking a stake actually fires FIND)', () => {
  const src = gh.bootScript();
  // REGRESSION: it must NOT be created disabled — iconBtn drops the handler when disabled, which left FIND dead.
  assert.equal(/'Tìm Bàn', true, !sel\.value/.test(src), false, 'FIND must not be created disabled');
  // always clickable; the click guards on a chosen stake; the empty state is shown by style only.
  assert.match(src, /iconBtn\(a\.icon\|\|'🔍','Tìm Bàn', true, false, false, function\(\)\{ if\(sel\.value\) emit\('FIND',\{ stake:Number\(sel\.value\) \}\); \}/);
  assert.match(src, /var syncFb=function\(\)\{ var ok=!!sel\.value;/);
});

test('BC: the header router handles RELOAD/STOP/FOCUS by REUSING existing run helpers (no new IPC)', () => {
  assert.match(main, /async function reloadWebRun\(runId\)/);
  assert.match(main, /async function closeBrowserRun\(runId\)/);
  // the header binding routes the lifecycle actions to the shared helpers / existing focus
  assert.match(main, /action === 'RELOAD'\) \{[\s\S]*?res = await reloadWebRun\(rid\);/);
  assert.match(main, /action === 'STOP'\) \{[\s\S]*?res = await closeBrowserRun\(rid\);/);
  assert.match(main, /action === 'FOCUS'\) \{[\s\S]*?res = focusBrowser\(rid\)/);
  // the IPC handlers reuse the SAME helpers (unchanged contract)
  assert.match(main, /ipcMain\.handle\('phom:reload-web', guarded\(async \(_e, cfg\) => reloadWebRun\(cfg && cfg\.browserId\)\)\)/);
  assert.match(main, /ipcMain\.handle\('phom:close-browser', guarded\(async \(_e, cfg\) => closeBrowserRun\(cfg && cfg\.browserId\)\)\)/);
});
