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
