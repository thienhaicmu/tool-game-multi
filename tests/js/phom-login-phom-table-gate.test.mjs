import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Explicit entry gate: RUN GAME → (user) ĐÃ LOGIN — TIẾP TỤC → (user) VÀO GAME PHỎM →
// A/B/C in Phỏm (authoritative signal) → (user) TÌM BÀN → stake → existing HOST flow.
// Source-level assertions on the renderer wiring (no DOM runtime in CI). The old HOST/
// coordinator mechanics are NOT rewritten — these only assert the added state gate.
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const between = (from, to) => { const a = js.indexOf(from); const b = to ? js.indexOf(to, a + 1) : js.length; return js.slice(a, b > a ? b : js.length); };

test('RUN GAME lands in LOGIN phase (no auto channel/acquire/join/ready)', () => {
  const open = between('async function openCluster()', 'async function stopOrchestration()');
  assert.match(open, /entryPhase = ENTRY\.LOGIN; phomSessionStarted = false/);
  // openCluster must not request channels / acquire / join / ready.
  assert.equal(/requestChannels|acquireHost|joinFollowers|applyReady|selectStake/.test(open), false,
    'RUN GAME must not trigger any find-table action');
});

test('ĐÃ LOGIN — TIẾP TỤC only advances to CONFIRMED (no session start, no channel/acquire)', () => {
  const fn = between('function confirmLogin()', 'async function enterPhom()');
  assert.match(fn, /entryPhase = ENTRY\.CONFIRMED/);
  assert.equal(/startSession|requestChannels|acquireHost|joinFollowers|applyReady/.test(fn), false,
    'login-confirm must not start the session or request channels');
});

test('VÀO GAME PHỎM starts the PASSIVE session and never requests channels/acquire/join/ready', () => {
  const fn = between('async function enterPhom()', 'function slotInPhom(');
  assert.match(fn, /entryPhase = ENTRY\.ENTERING/);
  assert.match(fn, /api\.startSession\(/);
  assert.equal(/requestChannels|acquireHost|joinFollowers|applyReady|selectStake/.test(fn), false,
    'entering Phỏm must not request channels / acquire / join / ready');
});

test('VÀO GAME PHỎM triggers the verified `vgcg_8` entry action via the site\'s own mechanism (no guess)', () => {
  const fn = between('async function enterPhom()', 'function armEntryTimeout(');
  // start the passive session then fire the entry action on each slot via the reused seam.
  assert.match(fn, /api\.startSession\(/);
  assert.match(fn, /api\.enterGame\(runId\)/);
  // the tool never guesses: no navigate, no deep-link/route, no DOM selector, no learn-from-click.
  assert.equal(/api\.navigateRun|loadURL|Page\.navigate|querySelector|\.click\(\)|deep.?link|entryLearn|entryReplay/i.test(fn), false, 'no guessed navigation/selector/learn in the entry path');
  // no channel/acquire/join/ready during entry.
  assert.equal(/requestChannels|acquireHost|joinFollowers|applyReady|selectStake/.test(fn), false);
  // per-slot failure isolated; never closes a browser.
  assert.match(fn, /assign\[sl\]\.entryError/);
  assert.equal(/closeRun|clusterStop|closeBrowsers|kill|destroy/.test(fn), false, 'entry action must never close a browser');
});

test('main triggers `vgcg_8` through the REUSED Aviator Cocos-node seam (runEnterGameViaSite), not a new flow', () => {
  const main = read('desktop/phom-main.cjs');
  const preload = read('desktop/phom-preload.cjs');
  // reuse the shared game-agnostic seam + the PHOM game id constant (not an Aviator id, not a URL).
  assert.match(main, /runEnterGameViaSite\b/);
  assert.match(main, /GAME_ID: PHOM_GAME_ID/);
  const fn = main.slice(main.indexOf('async function phomEnterGame('), main.indexOf('// ---- VÀO GAME PHỎM') > -1 ? main.length : main.length).slice(0, 1200);
  assert.match(fn, /runEnterGameViaSite\(client, undefined, PHOM_GAME_ID/);
  // no guessed HTTP/navigation/selector/raw-send in the Phỏm entry.
  assert.equal(/game-act|fetch\(|loadURL|Page\.navigate|querySelector|sendProtocol|\.click\(/.test(fn), false, 'no invented endpoint/navigation/selector/raw-send');
  // IPC + preload expose the single enter-game action; the learn/replay path is gone.
  assert.match(main, /ipcMain\.handle\('phom:enter-game'/);
  assert.match(preload, /enterGame:\s*\(runId\)\s*=>\s*ipcRenderer\.invoke\('phom:enter-game', runId\)/);
  assert.equal(/phom:entry-learn|phom:entry-replay|phom:entry-action|phom:navigate-run/.test(main + preload), false, 'superseded learn/replay/navigate IPC removed');
});

test('the Phỏm game id `vgcg_8` is the verified entry action id (not vgmn_221, not a URL)', () => {
  const cls = read('desktop/protocol/phom/phom-frame-classify.cjs');
  assert.match(cls, /GAME_ID = 'vgcg_8'/);
  const main = read('desktop/phom-main.cjs');
  assert.equal(/vgmn_221/.test(main), false, 'never the Aviator id for Phỏm');
});

test('READY is set ONLY by the authoritative in-Phỏm signal (never by the entry action firing)', () => {
  const rec = between('function reconcileEntryPhase(', 'async function openCluster(');
  assert.match(rec, /allInPhom\(\)/); // READY is gated on the authoritative in-Phỏm signal
  assert.match(rec, /entryPhase = ENTRY\.READY/);
  const inPhom = between('function slotInPhom(', 'function allInPhom(');
  // Authoritative in-Phỏm signal = a bound game socket (server-evidence frame) + connected. uid is
  // NOT required for the entry gate (it only arrives on a table JOIN; requiring it hung the gate at
  // the lobby). socketReady is not fakeable, so readiness is still authoritative.
  assert.match(inPhom, /p\.socketReady && p\.connected/);
});

test('PHOM_READY requires the authoritative 3/3 in-Phỏm signal (socketReady+connected), never faked', () => {
  const inPhom = between('function slotInPhom(', 'function reconcileEntryPhase(');
  assert.match(inPhom, /p\.socketReady && p\.connected/);
  const rec = between('function reconcileEntryPhase(', 'async function openCluster()');
  assert.match(rec, /allInPhom\(\)/); // READY is gated on the authoritative in-Phỏm signal
  assert.match(rec, /entryPhase = ENTRY\.READY/);
});

test('TÌM BÀN is enabled ONLY when in the Phỏm lobby (ready); otherwise (re)enter Phỏm', () => {
  // The CTA is derived from the REAL live signal (allInPhom), not a one-shot phase, so it recovers
  // for repeated use / after a logout. TÌM BÀN shows only when ready; else the (re)enter button.
  const bar = between('function commandToolbar(s)', 'function confirmLogin(');
  assert.match(bar, /const ready = allInPhom\(\)/);
  assert.match(bar, /entryPhase === ENTRY\.ENTERING[^]*ĐANG VÀO GAME PHỎM/);
  assert.match(bar, /ready[^]*TÌM BÀN · CHỌN CƯỢC/);
  assert.match(bar, /VÀO GAME PHỎM/); // (re)enter when not in Phỏm
});

test('stake appears ONLY in the Find-Table modal (never on Screen 1, never before TÌM BÀN)', () => {
  const ft = between('async function openFindTable()', 'async function runFindTable(');
  assert.match(ft, /ft-stake/);
  assert.match(ft, /api\.requestChannels\(\)/);      // channels requested only inside TÌM BÀN
  assert.match(ft, /api\.stakeChannels\(\)/);         // authoritative stake list (no hard-code)
  // Screen 1 (setup) carries no stake input.
  const setup = between('function renderSetup(r)', 'function panelGeneral()');
  assert.equal(/stake|cược/i.test(setup), false, 'no stake on Screen 1');
});

test('TÌM BÀN reuses the already-started session (never re-creates it, which would drop context)', () => {
  const ft = between('async function openFindTable()', 'async function runFindTable(');
  assert.match(ft, /if \(!phomSessionStarted\)/);
  assert.match(ft, /phomSessionStarted = true/);
});

test('Cancel of the stake modal sends no acquire/join/ready', () => {
  const ft = between('async function openFindTable()', 'async function runFindTable(');
  // HỦY just closes the overlay; acquire/join/ready live in runFindTable/advanceAutoFlow, reached
  // only via XÁC NHẬN → runFindTable(stake).
  assert.match(ft, /onclick: close \}, 'HỦY'/);
  assert.equal(/acquireHost|joinFollowers|applyReady/.test(ft), false, 'the modal itself never acquires/joins/readies');
});

test('DỪNG and RUN-GAME reset touch entryPhase but never close browsers', () => {
  const stop = between('async function stopOrchestration()', 'async function closeBrowsers()');
  assert.equal(/api\.closeBrowsers|api\.clusterStop|closeRun/.test(stop), false, 'DỪNG never closes browsers');
  // closeBrowsers (the explicit close) resets the gate.
  const close = between('async function closeBrowsers()', 'async function reopenSlot(');
  assert.match(close, /entryPhase = ENTRY\.LOGIN; phomSessionStarted = false/);
});

test('entry gate never closes a browser on any failure path', () => {
  const enter = between('async function enterPhom()', 'function slotInPhom(');
  assert.equal(/closeRun|clusterStop|closeBrowsers|kill/.test(enter), false, 'VÀO GAME PHỎM must not close browsers on failure');
  const confirm = between('function confirmLogin()', 'async function enterPhom()');
  assert.equal(/closeRun|clusterStop|closeBrowsers|kill/.test(confirm), false, 'login-confirm must not close browsers');
});

// ===== BLOCKING BUG FIXES =====

// BUG #1 — readiness is the run's OWN authoritative signal (socketReady+connected+uid), detected as
// soon as frames arrive (no fixed 10-min timeout); the status reflects real per-run state.
test('BUG1: slotLoggedIn = socketReady && connected && uid (authoritative, per run)', () => {
  const fn = between('function slotLoggedIn(', 'function slotInPhom(');
  assert.match(fn, /p\.socketReady && p\.connected && p\.uid != null/);
});

test('BUG1: entry status chips reflect REAL per-run state, not the entryPhase', () => {
  const bar = between('function entryStatusBar()', 'function slotStatus(');
  // must key off the live signal…
  assert.match(bar, /p\.socketReady && p\.connected && p\.uid != null/);
  assert.match(bar, /p\.channelCount \|\| 0\) > 0/);
  // …and NOT gate the login label purely on entryPhase === ENTRY.LOGIN anymore
  assert.equal(/entryPhase === ENTRY\.LOGIN\) \{ cls = 'yellow'; label = 'CHỜ LOGIN'/.test(bar), false);
});

test('BUG1: detection is prompt — poll actively requests the channel list when socket is up but list missing', () => {
  const poll = between('function startEntryPolling()', 'function stopEntryPolling()');
  assert.match(poll, /needChannels/);
  // §35 — scoped: each browser still missing the list is asked individually, never all three at once
  assert.match(poll, /api\.requestChannels\(assign\[sl\]\.runId\)/);
  assert.equal(/api\.requestChannels\(\)/.test(poll), false, 'the poll must not broadcast CMD 300 to every browser');
  // no fixed multi-minute sleep to become ready
  assert.equal(/600000|300000|sleep\(\s*[0-9]{6,}/.test(poll), false);
});

// BUG #2 — TÌM BÀN click always produces an observable action + never leaves the button stuck.
test('BUG2: runFindTable emits immediate feedback and ALWAYS clears autoFlow (finally)', () => {
  const fn = between('async function runFindTable(', 'function advanceAutoFlow(');
  assert.match(fn, /Đang tìm bàn/);            // FIND_TABLE_REQUESTED visible feedback
  // §44 — ONE engine: the Tool-wide TÌM BÀN drives the SAME manual flow as the per-browser buttons and the
  // in-Chromium headers (it used to start the legacy HOST/FOLLOWER loop instead).
  assert.match(fn, /await api\.manualDiscover\(finderRunId, \{ selectedStake: stake \}\)/);
  assert.match(fn, /await api\.manualJoinShared\(runId, d\.rid\)/);
  assert.equal(/api\.discover\(\)/.test(fn), false, 'the legacy cluster discovery loop is no longer started here');
  assert.match(fn, /finally \{[^]*autoFlow = false/); // never stuck "ĐANG CHẠY…"
  assert.match(fn, /Không thể tìm bàn/);       // typed error, not silent
});

test('BUG2: TÌM BÀN button is disabled ONLY while running (not mute-disabled by auth/browser count)', () => {
  const bar = between('function commandToolbar(s)', 'function confirmLogin(');
  assert.match(bar, /disabled: running \? true : null, onclick: openFindTable/);
});

test('BUG2: openFindTable reports the authorization gate with a typed note (no silent failure)', () => {
  const fn = between('async function openFindTable()', 'async function runFindTable(');
  assert.match(fn, /caps\.authorized/);
  assert.match(fn, /Không thể tìm bàn: môi trường chưa được cấp quyền QA/);
});
