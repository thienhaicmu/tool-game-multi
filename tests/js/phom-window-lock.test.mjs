// KHÓA KHUNG + no bars over the page (user 2026-10-06 "giữ đúng size chuẩn"). The decision is pure (window-lock.cjs);
// the real behaviour was checked once with the tool's own ChromeLauncher + CDP on the bundled Chromium 149: maximized →
// put back to 900×500 @60,60, resized/moved → put back, minimized → left alone; with the flag + env neither
// "Google API keys are missing" nor "launch when Windows starts" shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lock = require('../../desktop/protocol/phom/window-lock.cjs');
const { ChromeLauncher, CHROMIUM_INFOBAR_ENV } = require('../../desktop/browser/chrome-launcher.cjs');
const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const rect = { x: 60, y: 60, width: 900, height: 500 };
const b = (o) => ({ left: 60, top: 60, width: 900, height: 500, windowState: 'normal', ...o });

test('reframe: maximized / full screen / resized / moved are put back; the frame and minimized are left alone', () => {
  assert.equal(lock.reframeReason(b({}), rect), null);
  assert.equal(lock.reframeReason(b({ left: 63, width: 904 }), rect), null, 'a few px of rounding is fine');
  assert.equal(lock.reframeReason(b({ left: -8, top: -8, width: 1936, height: 1048, windowState: 'maximized' }), rect), 'MAXIMIZED');
  assert.equal(lock.reframeReason(b({ windowState: 'fullscreen' }), rect), 'FULLSCREEN');
  assert.equal(lock.reframeReason(b({ width: 1300, height: 760 }), rect), 'RESIZED');
  assert.equal(lock.reframeReason(b({ left: 400, top: 300 }), rect), 'MOVED');
  assert.equal(lock.reframeReason(b({ windowState: 'minimized', left: -32000 }), rect), null, 'the user hid it');
  assert.equal(lock.reframeReason(null, rect), null);
});

test('reframe: bounds Chromium really took for the frame are accepted — never a fight loop; a NEW frame is enforced', () => {
  const took = b({ width: 920 });                       // e.g. Chromium's minimum width
  const accepted = { rect: lock.toBounds(rect), bounds: took };
  assert.equal(lock.reframeReason(took, rect), 'RESIZED', 'without the memory it would fight');
  assert.equal(lock.reframeReason(took, rect, accepted), null);
  assert.notEqual(lock.reframeReason(took, { ...rect, x: 980 }, accepted), null, 'the layout changed: the new frame wins');
});

// ---- the window-frames feature, against fake browser windows (CDP Browser domain) ----
const { createWindowFramesFeature } = require('../../desktop/phom/features/window-frames.cjs');
const { createSessionRegistry } = require('../../desktop/phom/core/session-registry.cjs');
function mkWindows({ lockOn = true, takes = null } = {}) {
  const wins = {}; const logs = []; const tool = { bounds: null, top: 0, isDestroyed: () => false, setBounds(b) { this.bounds = b; }, moveTop() { this.top += 1; } };
  const client = (rid) => ({ Browser: {
    getWindowForTarget: async () => ({ windowId: rid, bounds: { ...wins[rid] } }),
    getWindowBounds: async () => ({ bounds: { ...wins[rid] } }),
    setWindowBounds: async ({ bounds }) => { const b = takes ? takes(bounds) : bounds; wins[rid] = { ...wins[rid], ...b, windowState: b.windowState || wins[rid].windowState }; },
  } });
  const rects = { A: { x: 0, y: 0, width: 900, height: 500 }, B: { x: 960, y: 0, width: 900, height: 500 }, D: { x: 960, y: 520, width: 900, height: 500 }, TOOL: { x: 960, y: 520, width: 900, height: 500 } };
  let saved = { a: 1 };
  const f = createWindowFramesFeature({
    sessions: createSessionRegistry(),
    layout: { get: () => saved, set: (l) => { saved = l; return l; }, defaults: { a: 1 } },
    rectForItem: (item) => rects[item] || null,
    fallbackRect: () => ({ x: 1, y: 1, width: 2, height: 2 }),
    toolFallback: () => null,
    openRuns: () => Object.keys(wins).map((rid) => [rid, rid === 'BR-1' ? 'A' : rid === 'BR-2' ? 'B' : 'D']),
    clientFor: (rid) => (wins[rid] ? client(rid) : null),
    tool: () => tool,
    lockOn: () => lockOn,
    log: (e, d) => logs.push([e, d]),
  });
  return { f, wins, logs, tool };
}

test('KHÓA KHUNG: a maximized / moved browser is put back into its frame; a minimized one is left alone; off = untouched', async () => {
  const w = mkWindows();
  w.wins['BR-1'] = { left: 0, top: 0, width: 1920, height: 1040, windowState: 'maximized' };
  w.wins['BR-2'] = { left: 100, top: 100, width: 900, height: 500, windowState: 'normal' };
  w.wins['BR-4'] = { left: 5, top: 5, width: 10, height: 10, windowState: 'minimized' };
  await w.f.enforce();
  assert.deepEqual(w.wins['BR-1'], { left: 0, top: 0, width: 900, height: 500, windowState: 'normal' });
  assert.deepEqual([w.wins['BR-2'].left, w.wins['BR-2'].top], [960, 0]);
  assert.equal(w.wins['BR-4'].width, 10, 'minimized: the user hid it');
  assert.deepEqual(w.logs.map(([, d]) => d.reason), ['MAXIMIZED', 'MOVED']);
  const off = mkWindows({ lockOn: false });
  off.wins['BR-1'] = { left: 0, top: 0, width: 1920, height: 1040, windowState: 'maximized' };
  await off.f.enforce();
  assert.equal(off.wins['BR-1'].windowState, 'maximized', 'PHOM_FEATURES_OFF=window-frames');
  assert.equal(lock.CHECK_MS, 1500);
});

test('KHÓA KHUNG never fights Chromium: the bounds it really took for a rect become the reference', async () => {
  const w = mkWindows({ takes: (b) => (b.width ? { ...b, width: b.width + 20 } : b) }); // e.g. a minimum width / DPI rounding
  w.wins['BR-1'] = { left: 300, top: 300, width: 900, height: 500, windowState: 'normal' };
  await w.f.enforce();
  await w.f.enforce();
  await w.f.enforce();
  assert.equal(w.logs.length, 1, 'put back once, then accepted');
});

test('XẾP CỬA SỔ / layout IPC: the tool to its quarter, every open browser back, the tool in front of the reserves', async () => {
  const w = mkWindows();
  w.wins['BR-1'] = { left: 400, top: 400, width: 900, height: 500, windowState: 'normal' };
  w.wins['BR-5'] = { left: 0, top: 0, width: 500, height: 300, windowState: 'normal' };
  const ipc = {};
  w.f.registerIpc((ch, fn, opts) => { ipc[ch] = { fn, guarded: !!(opts && opts.guarded) }; });
  assert.deepEqual(Object.keys(ipc).sort(), ['phom:layout-get', 'phom:layout-set', 'phom:restore-layout']);
  assert.equal(ipc['phom:layout-set'].guarded, true); assert.equal(ipc['phom:restore-layout'].guarded, true);
  assert.deepEqual(ipc['phom:layout-get'].fn(), { ok: true, layout: { a: 1 }, defaultLayout: { a: 1 } });
  const r = ipc['phom:layout-set'].fn(null, { layout: { a: 2 } });
  assert.deepEqual(r, { ok: true, layout: { a: 2 } });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(w.tool.bounds, { x: 960, y: 520, width: 900, height: 500 });
  assert.equal(w.tool.top, 1);
  assert.deepEqual([w.wins['BR-1'].left, w.wins['BR-1'].top], [0, 0]);
  assert.deepEqual([w.wins['BR-5'].left, w.wins['BR-5'].top], [960, 520], 'a reserve sits behind the tool');
});

test('wiring: main starts the lock with the tool window and builds window-frames as a feature', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /createWindow\(\);\s*windows\(\)\.start\(\);/);
  assert.match(main, /lockOn: \(\) => features\(\)\.enabled\('window-frames'\),/);
  assert.match(main, /openRuns: openRunSlots,/);
  assert.equal(/PHOM_WINDOW_LOCK|enforceWindowFrames|_lockAccepted|moveRunWindow|windowRectForSlot|function restoreLayout/.test(main), false);
});

test('no bars over the page: the launch carries --disable-features=LaunchOnStartup (once) and the "no Google keys" env', async () => {
  let seen = null;
  const fakeChild = { pid: 4242, stderr: null, unref() {}, once() {}, on() {}, killed: false };
  const L = new ChromeLauncher({ profilePath: 'X:/p', chromeExecutable: 'X:/chrome.exe', env: { PATH: 'p' }, spawn: (exe, args, opts) => { seen = { exe, args, opts }; return fakeChild; } });
  L.cdpPort = async () => 9333;
  const r = await L.open('about:blank');
  assert.equal(r.ok, true);
  assert.equal(seen.args.filter((a) => a.startsWith('--disable-features=')).length, 1, 'only ONE --disable-features (the last one wins)');
  assert.ok(seen.args.includes('--disable-features=LaunchOnStartup'));
  assert.deepEqual(CHROMIUM_INFOBAR_ENV, { GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' });
  for (const [k, v] of Object.entries(CHROMIUM_INFOBAR_ENV)) assert.equal(seen.opts.env[k], v);
  assert.equal(seen.opts.env.PATH, 'p', 'the rest of the environment is kept');
  assert.equal(seen.args.indexOf('--disable-features=LaunchOnStartup') < seen.args.indexOf('--new-window'), true);
});

test('the profile button names the window: every launch carries --pm-show-profile-name (owned Chromium patch; stock ignores it)', async () => {
  let seen = null;
  const fakeChild = { pid: 4243, stderr: null, unref() {}, once() {}, on() {}, killed: false };
  const L = new ChromeLauncher({ profilePath: 'X:/p', chromeExecutable: 'X:/chrome.exe', env: {}, spawn: (exe, args, opts) => { seen = { args, opts }; return fakeChild; } });
  L.cdpPort = async () => 9334;
  await L.open('about:blank');
  assert.ok(seen.args.includes('--pm-show-profile-name'));
  assert.ok(seen.args.indexOf('--pm-show-profile-name') < seen.args.indexOf('--new-window'));
});
