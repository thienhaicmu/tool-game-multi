// 3.2 — the features that act on a browser (desktop/phom/features). Behaviour through a fake CDP client; one wiring
// check that main builds them in the right ORDER.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createSessionRegistry } = require('../../desktop/phom/core/session-registry.cjs');
const { createCaptureFeature, STALE_MS, REHOOK_EVERY_MS, NETWORK_BUFFERS } = require('../../desktop/phom/features/capture.cjs');
const { createBrowserAgentFeature } = require('../../desktop/phom/features/browser-agent.cjs');
const { createWsHookFeature } = require('../../desktop/phom/features/ws-hook.cjs');
const { createAnDanhFeature } = require('../../desktop/phom/features/an-danh.cjs');
const { createDocNavFeature } = require('../../desktop/phom/features/doc-nav.cjs');
const { createProxyAuthFeature } = require('../../desktop/phom/features/proxy-auth.cjs');
const { createMemoryWatchFeature } = require('../../desktop/phom/features/memory-watch.cjs');
const browserAgent = require('../../desktop/browser-run/browser-agent.cjs');

// a fake CDP client that records every call and every subscription
function fakeClient() {
  const calls = []; const subs = {};
  const domain = (name) => new Proxy({}, { get: (_, m) => (arg) => {
    if (typeof arg === 'function') { (subs[name + '.' + m] = subs[name + '.' + m] || []).push(arg); return undefined; }
    calls.push([name + '.' + m, arg]); return Promise.resolve({ identifier: 'id-' + calls.length });
  } });
  return { calls, subs, Network: domain('Network'), Emulation: domain('Emulation'), Page: domain('Page'), Runtime: domain('Runtime') };
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- capture ----
test('capture: Network with small buffers, the FOUR WebSocket events only, subscribed once per client', () => {
  const seen = [];
  const capture = new Proxy({}, { get: (_, m) => (...a) => seen.push([m, a[0]]) });
  const f = createCaptureFeature({ capture, targetsOf: () => [], injectSendHook: () => {} });
  const c = fakeClient();
  f.attach({ client: c, target: { cdpTargetId: 'T1' } });
  f.attach({ client: c, target: { cdpTargetId: 'T2' } });                 // re-attach of the same client
  assert.deepEqual(c.calls.filter(([m]) => m === 'Network.enable').map(([, a]) => a), [NETWORK_BUFFERS, NETWORK_BUFFERS]);
  assert.deepEqual(Object.keys(c.subs).sort(), ['Network.webSocketClosed', 'Network.webSocketCreated', 'Network.webSocketFrameReceived', 'Network.webSocketFrameSent']);
  assert.ok(Object.values(c.subs).every((l) => l.length === 1), 'subscribed ONCE (a second subscription handled every frame twice)');
  c.subs['Network.webSocketFrameReceived'][0]({ x: 1 }, 'S');
  assert.deepEqual(seen, [['onWebSocketFrameReceived', 'T2']], 'frames are tagged with the CURRENT target');
});

test('capture: a browser whose frames stopped is re-hooked (capture + send hook) — at most once per 30 s', () => {
  let t = 100000; const logs = []; const injected = [];
  const c = fakeClient();
  const f = createCaptureFeature({ capture: {}, targetsOf: () => [{ targetId: 'T1', client: c }], injectSendHook: (cl) => injected.push(cl), log: (e) => logs.push(e), now: () => t });
  const reg = createSessionRegistry(); const session = reg.get('BR-1');
  f.push({ run: { id: 'BR-1' }, session, browser: { lastFrameAt: t - 1000 } });          // fresh: nothing
  assert.equal(logs.length, 0);
  f.push({ run: { id: 'BR-1' }, session, browser: { lastFrameAt: t - STALE_MS - 1 } });  // stale: re-hook
  f.push({ run: { id: 'BR-1' }, session, browser: { lastFrameAt: t - STALE_MS - 1 } });  // again at once: throttled
  assert.deepEqual(logs, ['capture-rehook']); assert.equal(injected.length, 1);
  t += REHOOK_EVERY_MS;
  f.push({ run: { id: 'BR-1' }, session, browser: { lastFrameAt: 0 } });
  assert.equal(logs.length, 2);
  f.push({ run: { id: 'BR-1', closed: true }, session, browser: { lastFrameAt: 0 } });   // closed: never
  f.push({ run: { id: 'BR-1' }, session, browser: { lastFrameAt: null } });              // no frame yet: never
  assert.equal(logs.length, 2);
});

// ---- browser agent ----
test('browser-agent: WEB applies nothing, MOBILE only the user agent — never metrics / touch emulation', async () => {
  const notes = [];
  const f = createBrowserAgentFeature({ browserAgent, notify: (p) => notes.push(p) });
  const web = fakeClient(); const mob = fakeClient();
  await f.attach({ run: { id: 'A', browserAgent: 'WEB' }, client: web });
  await f.attach({ run: { id: 'B', browserAgent: 'MOBILE' }, client: mob });
  assert.deepEqual(web.calls, []);
  assert.deepEqual(mob.calls.map(([m]) => m), ['Emulation.setUserAgentOverride']);
  assert.deepEqual(notes.map((n) => [n.runId, n.applied]), [['A', []], ['B', ['setUserAgentOverride']]]);
});

// ---- ws hook ----
test('ws-hook: the send hook is installed on every attached target (page or worker)', async () => {
  const got = [];
  const f = createWsHookFeature({ injectSendHook: async (c) => { got.push(c); } });
  await f.attach({ client: 'P' }); await f.attach({ client: 'W' });
  assert.deepEqual(got, ['P', 'W']);
});

// ---- an danh ----
test('an-danh: OFF by default, applied on PAGE targets only, the switch re-applies to every open browser; IPC get/set', async () => {
  const applied = [];
  const anDanh = { applyAnDanh: async (client, on) => { applied.push([client, on]); return { ok: true }; } };
  const f = createAnDanhFeature({ anDanh, pageClients: () => [{ runId: 'BR-1', client: 'C1' }, { runId: 'BR-2', client: 'C2' }] });
  await f.attach({ client: 'C1', target: { type: 'PAGE' } });
  await f.attach({ client: 'W1', target: { type: 'WORKER' } });
  assert.deepEqual(applied, [['C1', false]]);
  const ipc = {}; f.registerIpc((ch, fn, o) => { ipc[ch] = { fn, guarded: !!(o && o.guarded) }; });
  assert.deepEqual(await ipc['phom:an-danh-get'].fn(), { ok: true, on: false });
  assert.equal(ipc['phom:an-danh-set'].guarded, true, 'setting it needs a licence');
  const r = await ipc['phom:an-danh-set'].fn(null, { on: true });
  assert.equal(r.on, true); assert.deepEqual(Object.keys(r.results), ['BR-1', 'BR-2']);
  assert.deepEqual(applied.slice(1), [['C1', true], ['C2', true]]);
  await f.attach({ client: 'C3', target: { type: 'PAGE' } });
  assert.deepEqual(applied.at(-1), ['C3', true], 'a browser opened later gets the current value');
});

// ---- doc nav ----
test('doc-nav: only the PAGE, only the top frame, subscribed once per client; about:blank is the caller\'s call', () => {
  const docs = [];
  const f = createDocNavFeature({ onDocument: (rid, url) => docs.push([rid, url]) });
  const page = fakeClient(); const worker = fakeClient();
  f.attach({ run: { id: 'BR-1' }, client: page, target: { type: 'PAGE' } });
  f.attach({ run: { id: 'BR-1' }, client: page, target: { type: 'PAGE' } });
  f.attach({ run: { id: 'BR-1' }, client: worker, target: { type: 'WORKER' } });
  assert.equal(page.subs['Page.frameNavigated'].length, 1);
  assert.equal(worker.subs['Page.frameNavigated'], undefined);
  page.subs['Page.frameNavigated'][0]({ frame: { url: 'https://g/', parentId: null } });
  page.subs['Page.frameNavigated'][0]({ frame: { url: 'https://ad/', parentId: 'F0' } });     // an iframe
  assert.deepEqual(docs, [['BR-1', 'https://g/']]);
});

// ---- proxy auth ----
test('proxy-auth: only an authenticated proxy binds; the PAGE navigates to the game ONCE, after the bind', async () => {
  const order = [];
  const bindProxyAuth = async (client, ctx) => { order.push('bind'); assert.equal(ctx.resolvePassword(), 'pw'); return () => {}; };
  const f = createProxyAuthFeature({ bindProxyAuth, resolvePassword: (id) => (id === 'PX' ? 'pw' : null) });
  const none = fakeClient();
  await f.attach({ run: { id: 'A', proxy: null }, client: none, target: { type: 'PAGE' } });
  assert.deepEqual(order, []);
  const c = fakeClient();
  const run = { id: 'B', proxy: { id: 'PX', requiresAuth: true }, _pendingNavigateUrl: 'https://g/' };
  await f.attach({ run, client: c, target: { type: 'PAGE' } });
  await f.attach({ run, client: c, target: { type: 'PAGE' } });                         // re-attach
  assert.deepEqual(order, ['bind', 'bind']);
  assert.deepEqual(c.calls.filter(([m]) => m === 'Page.navigate').map(([, a]) => a.url), ['https://g/'], 'navigated once');
  assert.equal(run._pendingNavigateUrl, null);
});

// ---- memory watch ----
test('memory-watch: HIGH logged once, RUNAWAY logged + noticed + closed then killed; a closed browser is skipped', async () => {
  const logs = []; const notices = []; const closed = []; const killed = [];
  const reg = createSessionRegistry(); reg.note('BR-1', 'ENTER_GAME_START');
  const runs = [{ id: 'BR-1', slot: 'A', profileDir: 'C:\\p\\P1', profileLabel: 'P1', browserKind: 'chrome' }, { id: 'BR-2', slot: 'B', profileDir: 'C:\\p\\P2', closed: true }];
  const f = createMemoryWatchFeature({ marker: () => 'x', runs: () => runs, closeRun: async (rid) => closed.push(rid), killPid: (pid) => killed.push(pid), log: (e, d) => logs.push([e, d]), notice: (n) => notices.push(n), sessions: reg, killWaitMs: 5, watch: () => ({ start() {}, stop() {} }) });
  const sample = (mb) => new Map([['c:\\p\\p1', { mainPid: 77, mainMb: mb, rendererMb: 500 }], ['c:\\p\\p2', { mainPid: 88, mainMb: 9000, rendererMb: 1 }]]);
  f._onSample(sample(1600)); f._onSample(sample(1700));
  assert.deepEqual(logs.map(([e]) => e), ['BROWSER_MEMORY_HIGH']);
  assert.deepEqual(logs[0][1].recent.map((x) => x.split('@')[0]), ['ENTER_GAME_START'], 'with the tool\'s last steps');
  f._onSample(sample(3100)); f._onSample(sample(3200));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(logs.map(([e]) => e), ['BROWSER_MEMORY_HIGH', 'BROWSER_MEMORY_RUNAWAY']);
  assert.deepEqual(notices, [{ event: 'BROWSER_MEMORY_RUNAWAY', slot: 'A', mb: 3100 }]);
  assert.deepEqual(closed, ['BR-1']); assert.deepEqual(killed, [77], 'BR-2 (closed) never touched');
});

// ---- wiring: main builds the set in the right order and routes attach / push / IPC through it ----
test('wiring: main runs every browser feature through ONE set, in order (send hook → header → proxy last)', () => {
  const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('_features = createFeatureSet({');
  const block = main.slice(start, main.indexOf('return _features;', start));
  // enter-game before header on push: the bar shows the entering state the auto entry just set
  const order = ['createCaptureFeature', 'createBrowserAgentFeature', 'createWsHookFeature', '_anDanhFeature', 'createDocNavFeature', '_enterFeature,', 'createLoginOriginFeature', '_headerFeature,', 'createProxyAuthFeature', '_memoryFeature'];
  const at = order.map((k) => block.indexOf(k));
  assert.ok(at.every((i) => i > 0), 'all ten present');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in this order');
  assert.match(main, /features\(\)\.attach\(\{ run, target, client, session: sessions\.get\(run\.id\) \}\);/);
  assert.match(main, /features\(\)\.push\(\{ run, session: sessions\.get\(rid\), view, browser:/);
  assert.match(main, /features\(\)\.documentReplaced\(\{ run: runManager && runManager\.get\(rid\), session: sessions\.get\(rid\), url: String\(url\) \}\);/);
  // a feature that throws is never silent: it always reaches coseat.jsonl
  assert.match(main, /const ALWAYS_LOGGED = new Set\(\[[^\]]*'feature-error'/);
  assert.match(main, /features\(\)\.registerIpc\(\(channel, fn, opts\) => ipcMain\.handle\(channel, opts && opts\.guarded \? guarded\(fn\) : fn\)\);/);
  assert.match(main, /runManager\.on\('run-closed', \(s\) => \{ if \(s && s\.id != null\) dropRunSession\(s\.id\); \}\);/);
  assert.match(main, /autoReplaceFromReserve\(runId, closed\);\s*dropRunSession\(runId\);/);
  // the old per-run maps of the moved features are gone
  for (const gone of ['anDanhOn', 'attachCapture', 'maybeRehookCapture', '_lastRehookAt', 'recentRunEvents', 'PHOM_DIAG_NO_',
    'headerEntering', 'headerActionBusy', 'headerKeys', 'headerLastPushed', 'headerDomPresent', 'maybeAutoEnter', 'startEnterGame',
    'rememberLoginOrigin', 'rememberAccountName', 'phomHeaderAction', 'attachHeader', 'settleHeaderError', 'lastTopUrl']) assert.equal(main.includes(gone), false, gone);
});
