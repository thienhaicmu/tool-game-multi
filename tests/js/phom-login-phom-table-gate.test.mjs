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

test('VÀO GAME fires the verified `vgcg_8` entry action per browser (no guessed navigation/selector)', () => {
  // Entry is per browser now (the chip's VÀO GAME / the in-page bar), not one bulk action for all three.
  const fn = between('async function manualEnterGame(runId)', 'function reconcileEnterStates(');
  assert.match(fn, /api\.enterGame\(runId\)/);
  // the tool never guesses: no navigate, no deep-link/route, no DOM selector, no learn-from-click
  assert.equal(/api\.navigateRun|loadURL|Page\.navigate|querySelector|\.click\(\)|deep.?link|entryLearn|entryReplay/i.test(fn), false, 'no guessed navigation/selector/learn in the entry path');
  // no table orchestration during entry
  assert.equal(/requestChannels|createTable|joinTable|setAuto/.test(fn), false);
  // a failure is isolated to that browser and never closes it
  assert.match(fn, /manualEnterError\[runId\]/);
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

test('BUG1: detection is prompt — poll actively requests the channel list when socket is up but list missing', () => {
  const poll = between('function startEntryPolling()', 'function stopEntryPolling()');
  assert.match(poll, /needChannels/);
  // §35 — scoped: each browser still missing the list is asked individually, never all three at once
  assert.match(poll, /api\.requestChannels\(assign\[sl\]\.runId\)/);
  assert.equal(/api\.requestChannels\(\)/.test(poll), false, 'the poll must not broadcast CMD 300 to every browser');
  // no fixed multi-minute sleep to become ready
  assert.equal(/600000|300000|sleep\(\s*[0-9]{6,}/.test(poll), false);
});

