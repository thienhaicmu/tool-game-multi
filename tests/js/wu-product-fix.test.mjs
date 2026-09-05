// WU-PRODUCT-FIX — regression guards for the current source repair:
//   1. package.json is the FULL development/source manifest (not the reduced app.asar copy).
//   2. Native browser view is hidden while a product modal is open, restored by product state.
//   3. Delete is gated (hidden while running) and NEVER deletes on-disk profile data.
// Source-assertion + behavioral tests, Electron-free, matching the existing test style.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');

// ---------------------------------------------------------------------------
// 1. package.json full source manifest (the extract-file-over-repo incident guard)
// ---------------------------------------------------------------------------
test('package.json is the full development manifest (scripts + build + devDependencies)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'web-security-observatory-ui');
  assert.ok(pkg.version, 'has version');
  assert.equal(pkg.main, 'desktop/main.cjs', 'main entry preserved');
  for (const s of ['start', 'dev', 'test', 'seal', 'dist']) {
    assert.ok(pkg.scripts && pkg.scripts[s], 'script present: ' + s);
  }
  assert.ok(pkg.build && pkg.build.appId, 'electron-builder build config present');
  assert.ok(pkg.build.productName, 'productName present');
  assert.ok(pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0, 'devDependencies present');
  assert.ok(pkg.dependencies && pkg.dependencies['chrome-remote-interface'], 'runtime dependency preserved');
});

test('package-lock.json version matches package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version, 'lockfile top version matches');
  if (lock.packages && lock.packages['']) assert.equal(lock.packages[''].version, pkg.version, 'lockfile root package version matches');
});

// ---------------------------------------------------------------------------
// 2. Modal state -> native view visibility (renderer wiring, source-asserted)
// ---------------------------------------------------------------------------
test('modal open/close dispatch a single central modal-changed event', () => {
  const js = read('ui/product.js');
  assert.match(js, /modal-changed'[^)]*open:\s*true/, 'openModal dispatches modal-changed{open:true}');
  assert.match(js, /modal-changed'[^)]*open:\s*false/, 'closeModal dispatches modal-changed{open:false}');
  const listeners = js.match(/addEventListener\('modal-changed'/g) || [];
  assert.equal(listeners.length, 1, 'exactly one modal-changed listener owner (no duplicate mechanisms)');
});

test('overviewInAppUI hides the native view while a modal is open and restores from product state', () => {
  const js = read('ui/product.js');
  // reconcile derives visibility from real product state AND the modal predicate
  assert.match(js, /function modalOpen\(\)\s*\{\s*return\s*!!document\.querySelector\('\.bm-overlay:not\(\[hidden\]\)'\)/, 'modalOpen() checks an open .bm-overlay');
  assert.match(js, /const show = !!\(viewIsOverview && runId && !modalOpen\(\)\)/, 'show = overview AND selected run AND not modal — not a blind show');
});

test('Overview is a TWO-ROW layout (browser full width, info below) — not side-by-side', () => {
  const css = read('ui/product.css');
  const html = read('ui/product.html');
  // Major layout stacks the two regions vertically.
  assert.match(css, /\.ov-layout\{[^}]*flex-direction:\s*column/, 'ov-layout is a column (rows), not a side-by-side row');
  // Row 1 (browser) spans the full content width; the info region is no longer a fixed sidebar.
  assert.match(css, /\.ov-web\{[^}]*width:\s*100%/, 'browser region uses full width');
  assert.doesNotMatch(css, /\.ov-side\{[^}]*flex:\s*0 0 300px/, 'info region is not a fixed 300px sidebar');
  assert.match(css, /\.ov-side\{[^}]*border-top:/, 'info region sits below with a top divider');
  // Both regions still exist in the DOM (browser host + info panel).
  assert.ok(html.includes('id="ov-web-host"'), 'browser host present');
  assert.ok(html.includes('class="ov-side"') || html.includes("class='ov-side'"), 'info panel present');
  // Native view bounds are clamped to the content viewport so it can't cover the header on scroll.
  const js = read('ui/product.js');
  assert.match(js, /Math\.max\(r\.top, m\.top\)/, 'browser bounds clamped to #shell-main viewport');
});

test('Overview uses a single document-scroll model so ALL lower info is reachable (no cramped inner scrollbox)', () => {
  const css = read('ui/product.css');
  // The content grows and the outer container scrolls; the info row takes natural height.
  assert.match(css, /#view-overview\{[^}]*min-height:\s*100%/, 'overview grows with content (min-height, not fixed height)');
  assert.match(css, /\.ov-layout\{[^}]*min-height:\s*100%/, 'ov-layout grows with content');
  assert.match(css, /\.ov-side\{[^}]*overflow:\s*visible/, 'info row is in document flow (not an internal scrollbox)');
  assert.doesNotMatch(css, /\.ov-side\{[^}]*overflow-y:\s*auto/, 'info row does not own a competing inner scroll');
  // #shell-main is the established scroll owner.
  assert.match(css, /#shell-main\{[^}]*overflow:\s*auto/, '#shell-main owns vertical scrolling');
});

test('creating a browser focuses the Overview on the NEW browser (configured URL is what the user sees)', () => {
  const js = read('ui/product.js');
  // After a successful create, submitModal selects the newly created browser so the view pointer
  // (currentRunId) follows it — otherwise the Overview keeps showing the previously selected run.
  const submit = js.slice(js.indexOf('async function submitModal'), js.indexOf('async function submitModal') + 1000);
  assert.match(submit, /await api\.createBrowser/, 'create path present');
  assert.match(submit, /select\(r\.browserId\)/, 'the new browser is selected after create');
});

// ---------------------------------------------------------------------------
// 3a. Delete button gating (running: no delete; closed: open/edit/delete)
// ---------------------------------------------------------------------------
test('delete action is offered only for a closed browser, never a running one', () => {
  const js = read('ui/product.js');
  // The offline card offers open + delete (delete lives alongside 'Mở').
  assert.match(js, /data-open="[\s\S]{0,400}?data-del="[\s\S]{0,40}?>Xóa</, 'offline card offers open ... delete');
  // The running action row is edit + close ONLY (no delete control in that branch).
  assert.match(js, /data-edit="\$\{esc\(b\.browserId\)\}">Sửa<\/button><button class="rr-mini danger" data-close="\$\{esc\(b\.browserId\)\}">Đóng<\/button><\/div>`/, 'running card is edit + close only');
  // A running/connected browser must be blocked from deletion at the main layer too.
  const main = read('desktop/main.cjs');
  assert.match(main, /liveRunForBrowser[\s\S]{0,90}BROWSER_ALREADY_RUNNING/, 'delete blocked while running');
});

// ---------------------------------------------------------------------------
// 3b. Delete removes the record but RETAINS on-disk profile data (behavioral)
// ---------------------------------------------------------------------------
test('BrowserRegistry.remove retains the on-disk profile directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wvpt-del-'));
  const reg = new BrowserRegistry({
    filePath: path.join(root, 'browser-registry.json'),
    profilesRoot: path.join(root, 'browser-profiles'),
    entitlement: () => ({ maxBrowsers: null }),
    now: () => 1_700_000_000_000,
  });
  reg.load();
  const b = reg.create({ name: 'Del', launchUrl: 'https://game.test/x' }).browser;
  // simulate persisted profile data on disk (cookies/localStorage live under profileDir)
  fs.mkdirSync(b.profileDir, { recursive: true });
  const marker = path.join(b.profileDir, 'Cookies');
  fs.writeFileSync(marker, 'session-token');

  const res = reg.remove(b.id);
  assert.equal(res.ok, true, 'record removed');
  assert.equal(res.profileRetained, b.profileDir, 'reports profile retained');
  assert.ok(fs.existsSync(b.profileDir), 'profile directory still on disk after delete');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'session-token', 'profile data (cookies) preserved');
  assert.ok(!reg.get(b.id), 'record gone from registry');
});

test('browser record persists the configured launch URL verbatim (path + query preserved) and edits update it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wvpt-url-'));
  const reg = new BrowserRegistry({
    filePath: path.join(root, 'browser-registry.json'),
    profilesRoot: path.join(root, 'browser-profiles'),
    entitlement: () => ({ maxBrowsers: null }),
    now: () => 1_700_000_000_000,
  });
  reg.load();
  const target = 'https://v.hitclub.chat/path/deep?a=hitclub&b=2#frag';
  const b = reg.create({ name: 'URL', launchUrl: target }).browser;
  assert.equal(b.launchUrl, target, 'create persists the URL verbatim (query + fragment kept)');
  assert.equal(reg.get(b.id).launchUrl, target, 'persisted + reloadable');
  // edit to a new URL
  const next = 'https://other.example/x?y=1';
  const up = reg.update(b.id, { launchUrl: next });
  assert.equal(up.browser.launchUrl, next, 'update changes the configured URL');
  assert.equal(reg.get(b.id).launchUrl, next, 'edited URL persisted');
});

test('delete code path performs no storage/profile destruction', () => {
  const registrySrc = read('desktop/browser-run/browser-registry.cjs');
  const mainSrc = read('desktop/main.cjs');
  for (const src of [registrySrc, mainSrc]) {
    assert.doesNotMatch(src, /clearStorageData/, 'no clearStorageData in delete path');
  }
  // deletePersistentBrowser must not recursively remove the profile directory.
  const del = mainSrc.slice(mainSrc.indexOf('function deletePersistentBrowser'), mainSrc.indexOf('function deletePersistentBrowser') + 700);
  assert.doesNotMatch(del, /rmSync|rmdirSync|fs\.rm\(|rimraf/, 'delete does not remove profile directory');
});
