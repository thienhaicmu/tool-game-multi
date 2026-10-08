// PHASE 6.3.2.2 — BROWSER RUNTIME resolver (Custom Chromium ↔ Google Chrome) + wiring. The resolver is
// pure (fileExists injected) so the decision is unit-testable without a real Chrome install. Wiring is
// asserted at the source level (per-run executable, per-profile user-data-dir preserved, IPC + setting).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const R = require('../../desktop/browser/browser-runtime-resolver.cjs');

const CUSTOM = { ok: true, executable: 'D:/tool/runtime/phom-chromium/chrome.exe', version: '149.0.7827.55' };
const noFile = () => false;
const hasFile = (p) => /Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/.test(String(p));

test('AUTO prefers the custom Chromium when available (kind by SOURCE, not filename)', () => {
  const r = R.resolveBrowserRuntime({ preference: 'AUTO', customChromium: CUSTOM, env: {}, fileExists: hasFile });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'chromium');           // even though the file is literally chrome.exe
  assert.equal(r.executable, CUSTOM.executable);
  assert.equal(r.fellBack, false);
});

test('AUTO falls back to Google Chrome (fellBack) when the custom Chromium is unavailable', () => {
  const env = { 'ProgramFiles': 'C:\\Program Files' };
  const r = R.resolveBrowserRuntime({ preference: 'AUTO', customChromium: { ok: false }, env, fileExists: hasFile });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'chrome');
  assert.equal(r.fellBack, true);
  assert.match(r.executable, /Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
});

test('AUTO with neither runtime available returns a typed error (never a hidden fallback)', () => {
  const r = R.resolveBrowserRuntime({ preference: 'AUTO', customChromium: { ok: false }, env: {}, fileExists: noFile });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_NO_BROWSER_RUNTIME');
});

test('CUSTOM_CHROMIUM refuses (typed) when the custom runtime is unavailable — no silent Chrome', () => {
  const r = R.resolveBrowserRuntime({ preference: 'CUSTOM_CHROMIUM', customChromium: { ok: false }, env: {}, fileExists: hasFile });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_CUSTOM_CHROMIUM_UNAVAILABLE');
});

test('GOOGLE_CHROME uses Chrome even when the custom Chromium is available', () => {
  const env = { 'ProgramFiles': 'C:\\Program Files' };
  const r = R.resolveBrowserRuntime({ preference: 'GOOGLE_CHROME', customChromium: CUSTOM, env, fileExists: hasFile });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'chrome');
  assert.equal(r.fellBack, false);
});

test('GOOGLE_CHROME honors an explicit PHOM_CHROME_PATH override; missing override is a typed error', () => {
  const ok = R.resolveGoogleChrome({ env: { PHOM_CHROME_PATH: 'C:/custom/chrome.exe' }, fileExists: (p) => p === 'C:/custom/chrome.exe' });
  assert.equal(ok.ok, true); assert.equal(ok.source, 'PHOM_CHROME_PATH');
  const bad = R.resolveGoogleChrome({ env: { PHOM_CHROME_PATH: 'C:/missing.exe' }, fileExists: noFile });
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'PHOM_CHROME_PATH_NOT_FOUND');
});

test('chromeCandidates covers Program Files / Program Files (x86) / LOCALAPPDATA — no single hard-coded path', () => {
  const c = R.chromeCandidates({ 'ProgramFiles': 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', 'LOCALAPPDATA': 'C:\\LA' });
  assert.equal(c.length, 3);
  assert.ok(c.some((p) => p.startsWith('C:\\PF\\')));
  assert.ok(c.some((p) => p.startsWith('C:\\PF86\\')));
  assert.ok(c.some((p) => p.startsWith('C:\\LA\\')));
});

test('normalizePreference clamps unknown values to AUTO', () => {
  assert.equal(R.normalizePreference('google_chrome'), 'GOOGLE_CHROME');
  assert.equal(R.normalizePreference('nonsense'), 'AUTO');
  assert.equal(R.normalizePreference(undefined), 'AUTO');
});

// ---- wiring (source-level) ----
const main = read('desktop/phom-main.cjs');
const preload = read('desktop/phom-preload.cjs');
const js = read('ui-phom/phom-qa.js');

test('openProfile launches from the resolved runtime per-run and preserves the per-profile user-data-dir', () => {
  const fn = main.slice(main.indexOf('async function openProfile('), main.indexOf('async function openProfile(') + 7000);
  assert.match(fn, /resolveBrowserRuntimeChoice\(\)/);
  assert.match(fn, /const usingChrome = rtChoice\.kind === 'chrome'/);
  // the executable goes INTO createRun (the launcher is built inside it) — never assigned afterwards
  assert.match(fn, /runManager\.createRun\(\{[^}]*chromeExecutable: usingChrome \? rtChoice\.executable : null \}\)/);
  assert.doesNotMatch(fn, /run\.chromeExecutable = /, 'a later assignment is too late: the launcher already exists');
  assert.match(fn, /run\.browserKind = rtChoice\.kind/);
  // user-data-dir stays keyed by the stable profile id regardless of runtime kind (§16/§17)
  assert.match(fn, /resolveProfileDir\(\{ root: profilesRoot, key: udKey \|\| slot \|\| 'X'/);
  // the custom-Chromium sandbox ACL is skipped when running Google Chrome
  assert.match(fn, /if \(!usingChrome && !sandbox\.sandboxDisabled && rt\.ok\)/);
});

// The bug behind "Trình duyệt: Chrome opens no browser" (2026-10-07): phom-main set run.chromeExecutable AFTER
// createRun, but createRun builds the launcher at once — "Chrome" launched the custom Chromium (and skipped its
// sandbox ACL step). Behavioural: the run manager + the real launcher facade spawn the executable given to createRun.
test('createRun({ chromeExecutable }) — the launcher spawns THAT executable, not the runtime default', async () => {
  const { BrowserRunManager } = require('../../desktop/browser-run/browser-run-manager.cjs');
  const { ChromeRuntime } = require('../../desktop/browser/chrome-runtime.cjs');
  const spawned = [];
  const fakeChild = { pid: 4242, killed: false, once() {}, on() {}, unref() {}, stderr: null };
  const chromeRt = new ChromeRuntime({ env: {}, chromeExecutable: process.execPath, spawn: (exe) => { spawned.push(exe); return fakeChild; } });
  const mgr = new BrowserRunManager({ createLauncher: (run) => chromeRt.launcher(run), createTargetManager: () => ({}) });
  const chrome = process.execPath + '.chrome'; // any distinct path: the spawn is faked
  const { mkdtempSync } = require('node:fs'); const { tmpdir } = require('node:os'); const { join } = require('node:path');
  const base = mkdtempSync(join(tmpdir(), 'phom-rt-'));
  const r1 = mgr.createRun({ profileDir: join(base, 'p1'), chromeExecutable: chrome });
  assert.equal(r1.chromeExecutable, chrome);
  await r1.launcher.open('about:blank').catch(() => {});
  const r2 = mgr.createRun({ profileDir: join(base, 'p2') });
  await r2.launcher.open('about:blank').catch(() => {});
  assert.deepEqual(spawned, [chrome, process.execPath], 'Chrome for the Chrome run, the pinned runtime for the other');
});

test('browser runtime preference is persisted + exposed over IPC; preload bridges it', () => {
  // the settings store's browserRuntime key (behaviour: phom-stores.test.mjs)
  assert.match(main, /browserRuntime: \{ default: 'CUSTOM_CHROMIUM', normalize: browserRuntimeResolver\.normalizePreference,/);
  assert.match(main, /preference: settings\(\)\.set\('browserRuntime', cfg && cfg\.preference\)/);
  assert.match(main, /'phom:browser-runtime-get'/);
  assert.match(main, /'phom:browser-runtime-set'/);
  assert.match(preload, /browserRuntimeGet:/);
  assert.match(preload, /browserRuntimeSet:/);
});

