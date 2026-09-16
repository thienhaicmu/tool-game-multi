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
  assert.match(fn, /run\.chromeExecutable = usingChrome \? rtChoice\.executable : null/);
  assert.match(fn, /run\.browserKind = rtChoice\.kind/);
  // user-data-dir stays keyed by the stable profile id regardless of runtime kind (§16/§17)
  assert.match(fn, /path\.join\(phomRoot\(\), 'browser-profiles', udKey/);
  // the custom-Chromium sandbox ACL is skipped when running Google Chrome
  assert.match(fn, /if \(!usingChrome && !sandbox\.sandboxDisabled && rt\.ok\)/);
});

test('browser runtime preference is persisted + exposed over IPC; preload bridges it', () => {
  assert.match(main, /function browserRuntimePref\(\)/);
  assert.match(main, /function setBrowserRuntimePref\(/);
  assert.match(main, /'phom:browser-runtime-get'/);
  assert.match(main, /'phom:browser-runtime-set'/);
  assert.match(preload, /browserRuntimeGet:/);
  assert.match(preload, /browserRuntimeSet:/);
});

test('SETUP shows a BROWSER RUNTIME selector; Screen 2 shows read-only RUNTIME/CDP/HEADER status', () => {
  assert.match(js, /function browserRuntimePanel\(\)/);
  assert.match(js, /BROWSER RUNTIME/);
  assert.match(js, /api\.browserRuntimeSet\(/);
  // PHASE 6.3.3 — Screen 2 is now a COMPACT chip: CDP + HEADER are mini-dots, RUNTIME kind is in the chip
  // tooltip. Still read-only diagnostics, no new action buttons.
  const cell = js.slice(js.indexOf('function compactBrowserCell('), js.indexOf('function renderSafeCards('));
  assert.match(cell, /dot\('CDP'/);
  assert.match(cell, /dot\('HDR'/);
  assert.match(cell, /mb\.runtimeKind/);
});
