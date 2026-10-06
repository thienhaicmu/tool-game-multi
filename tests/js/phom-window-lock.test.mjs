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

test('wiring: every 1.5 s each OPEN browser (P1–P3 + reserves) is checked and put back with the same move as XẾP CỬA SỔ', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /async function enforceWindowFrames\(\) \{/);
  assert.match(main, /process\.env\.PHOM_WINDOW_LOCK === '0'\) return;/);
  assert.match(main, /const why = windowLock\.reframeReason\(bounds, rect, _lockAccepted\[runId\]\);\s*if \(!why\) continue;\s*await moveRunWindow\(runId, rect\);/);
  assert.match(main, /createWindow\(\);\s*startWindowLock\(\);/);
  assert.equal(lock.CHECK_MS, 1500);
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
