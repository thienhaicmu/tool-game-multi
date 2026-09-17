// PHASE 6.3.2.6 — lag/perf fixes. The coordinator emits 'update'/'hands' on EVERY observed WS frame; the
// old code broadcast each one to the renderer (IPC) and pushed every header (a CDP Runtime.evaluate per
// browser) per frame — an IPC/CDP storm that saturated the client the VÀO GAME click rides on. These are
// source-level assertions that the storm is coalesced + deduped and that click→ENTERED latency is measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const main = read('desktop/phom-main.cjs');
const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');

test('the storm SOURCE is documented: coordinator emits update per observed frame (ctx change → _evaluate)', () => {
  assert.match(coord, /ctx\.on\('change', \(\) => this\._evaluate\(\)\)/);
  assert.match(coord, /_evaluate\(\)\s*\{[\s\S]*?this\.emit\('update', this\.snapshot\(\)\)/);
});

test('per-frame update/hands are COALESCED (leading+trailing throttle), not sent every frame', () => {
  assert.match(main, /phomSessions\.on\('update', \(snap\) => \{ scheduleSessionBroadcast\(snap\); \}\)/);
  assert.match(main, /phomSessions\.on\('hands', \(hands\) => \{ scheduleHandsBroadcast\(hands\); \}\)/);
  const sb = main.slice(main.indexOf('function scheduleSessionBroadcast('), main.indexOf('function scheduleSessionBroadcast(') + 500);
  assert.match(sb, /if \(_sessTimer\) return;/);          // coalesce while a trailing flush is pending
  assert.match(sb, /send\('phom:session', s\); pushHeaderStates\(\);/); // leading edge immediate
  assert.match(sb, /setTimeout\(\(\) => \{[\s\S]*?_sessPending[\s\S]*?\}, BROADCAST_MS\)/); // trailing latest
});

test('header push DEDUPES per browser — an unchanged state skips the CDP evaluate (kills the storm)', () => {
  const fn = main.slice(main.indexOf('function pushHeaderStates('), main.indexOf('function pushHeaderStates(') + 1900);
  assert.match(fn, /const json = JSON\.stringify\(gameHeader\.deriveHeaderState\(view\)\)/);
  assert.match(fn, /if \(headerLastPushed\[rid\] === json\) continue;/);
  assert.match(fn, /headerLastPushed\[rid\] = json;/);
});

test('click→ENTERED latency is instrumented with a monotonic clock (T6 start → evidence)', () => {
  assert.match(main, /const nowMs = \(\) =>/);
  assert.match(main, /headerEnterStartedAt\[rid\] = nowMs\(\); \/\/ T6/);
  assert.match(main, /ENTER_GAME_START'/);
  assert.match(main, /ENTER_GAME_EVIDENCE'[\s\S]*?elapsedMs: Math\.round\(nowMs\(\) - headerEnterStartedAt\[rid\]\)/);
});

test('caches are cleared on CDP detach AND on reload so a fresh document is always re-pushed (no stale skip)', () => {
  // detach
  assert.match(main, /delete headerLastPushed\[String\(run\.id\)\]; delete headerEnterStartedAt\[String\(run\.id\)\]/);
  // reload reset (reloadWebRun.resetPhom, shared by the header ⟳ button)
  assert.match(main, /resetPhom = \(\) =>[\s\S]*?delete headerLastPushed\[rid\]; delete headerEnterStartedAt\[rid\]/);
});

test('the ENTER path itself has no fixed sleeps (event-driven; evidence is authoritative)', () => {
  const entry = read('desktop/protocol/cocos-lobby-entry.cjs');
  assert.equal(/setTimeout|setInterval|new Promise\(\(r\) => setTimeout/.test(entry), false, 'no sleep/poll in the enter seam');
  // authoritative evidence only (socketReady + connected + channel list) — never a timer-driven success
  assert.match(main, /const inGame = opened && !!b\.socketReady && !!b\.connected && \(b\.channelCount \|\| 0\) > 0/);
});
