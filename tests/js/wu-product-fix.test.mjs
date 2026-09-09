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
// 2. CONTROL-V3 — the website/game is NOT embedded in Control; each profile opens its own
//    external browser window (BrowserWindowHost). These guard that the embed is gone and the
//    Control window is a compact automation console.
// ---------------------------------------------------------------------------
test('Control does NOT embed the website — the in-app embed reconciler is removed', () => {
  const js = read('ui/product.js');
  const html = read('ui/product.html');
  // The old Overview embed reconciler that positioned/showed a native WebContentsView is gone.
  assert.doesNotMatch(js, /function overviewInAppUI/, 'no embedded-web reconciler');
  assert.doesNotMatch(js, /api\.inappView\([^)]*true\s*\)/, 'renderer never asks main to SHOW an embedded view');
  // The embedded web host element is removed from the Control DOM.
  assert.ok(!html.includes('id="ov-web-host"'), 'no embedded browser host in Control');
  // Tổng quan remains as a live-status view (ov-side present, no web region).
  assert.ok(html.includes('class="ov-side"'), 'status panel present');
});

test('main hosts each profile in its OWN external window and the embed IPC is inert', () => {
  const main = read('desktop/main.cjs');
  const host = read('desktop/browser/browser-window-host.cjs');
  // A dedicated BrowserWindowHost owns one top-level BrowserWindow per run.
  assert.match(main, /new BrowserWindowHost\(/, 'main constructs the external-window host');
  assert.match(host, /new BrowserWindow\(/, 'host creates a top-level BrowserWindow per run');
  assert.match(host, /addChildView\(view\)/, 're-parents the run\'s existing view (no duplicate webContents)');
  // The legacy embed IPC is kept as an inert stub (never positions a view in Control).
  assert.match(main, /handle\('inapp-view',[^)]*\)\s*=>\s*\(\{\s*ok:\s*true,\s*external:\s*true/, 'inapp-view is an inert external stub');
});

test('Control opens Auto-first at a compact console size (no maximized dashboard)', () => {
  const js = read('ui/product.js');
  const win = read('desktop/window-state.cjs');
  // Normal flow lands on Tự động (Automation), not the status tab.
  assert.match(js, /setView\('auto'\)/, 'boot opens the Tự động workspace');
  // Compact landscape default + small usable minimum (§7/§28).
  const def = require('../../desktop/window-state.cjs').DEFAULTS;
  assert.ok(def.width <= 900 && def.height <= 640, 'compact default (<=900x640)');
  assert.ok(def.minWidth <= 700 && def.minHeight <= 520, 'usable down to ~560x480');
  assert.match(win, /width:\s*620/, 'documented compact default width');
});

test('Auto LƯỢT rows are a compact scrollable table with a column header', () => {
  const html = read('ui/product.html');
  const css = read('ui/product.css');
  assert.ok(html.includes('class="at-seq-cols"'), 'compact column header present');
  assert.match(css, /\.at-test-rows\{[^}]*overflow-y:\s*auto/, 'rows area scrolls when there are many LƯỢT');
  assert.match(css, /\.at-test-rows\{[^}]*max-height/, 'rows area is bounded so START/STOP stay visible');
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
  // The offline card offers "Mở web" + delete (delete lives alongside open). CONTROL-V3 uses a
  // compact 🗑 icon, but the invariant is the same: only a CLOSED profile exposes data-del.
  assert.match(js, /data-open="[\s\S]{0,400}?data-del="/, 'offline card offers open ... delete');
  // The running action row is reload + edit + close — and NEVER a delete control in that branch.
  const online = js.slice(js.indexOf('        : b.online'), js.indexOf('        : b.online') + 400);
  assert.match(online, /data-close="/, 'running card offers close');
  assert.doesNotMatch(online, /data-del="/, 'running card never offers delete (delete only when closed)');
  // WU-PROFILE-DATA-LIFECYCLE §6 — deleting a profile with a live run must be SAFE: the
  // main layer disposes the runtime (closeRun tears down timers/view + releases capacity)
  // BEFORE deleting data, rather than refusing. (The UI still only surfaces delete on the
  // offline card; the main-layer dispose is defensive depth.)
  const main = read('desktop/main.cjs');
  assert.match(main, /liveRunForBrowser[\s\S]{0,400}closeRun/, 'delete safely disposes a live run before deleting');
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

test('Phase 4: per-run recovery state is projected to the UI and mapped to concise Vietnamese status', () => {
  const main = read('desktop/main.cjs');
  const mgr = read('desktop/browser-run/browser-run-manager.cjs');
  const js = read('ui/product.js');
  // authoritative state is projected main -> browser summary -> renderer (not re-derived in UI)
  assert.match(mgr, /recoveryState: run\.recovery/, 'run summary carries authoritative recovery state');
  assert.match(main, /recoveryState: rs \? rs\.recoveryState : null/, 'browser summary carries recovery state to the renderer');
  // renderer maps each authoritative state to the required label (HEALTHY/READY -> normal UI)
  assert.match(js, /function recoveryBadge\(rec\)/, 'renderer has a recovery->label mapper');
  for (const [state, label] of [
    ['VERIFYING', 'Đang kiểm tra kết nối'],
    ['RECOVERING', 'Đang khôi phục'],
    ['WAITING_AVIATOR', 'Đang vào lại game'],
    ['LOGIN_REQUIRED', 'Cần đăng nhập'],
    ['RECOVERY_FAILED', 'Khôi phục thất bại'],
  ]) {
    assert.ok(js.includes("'" + label + "'"), 'label present: ' + label);
    assert.ok(js.includes(state), 'state mapped: ' + state);
  }
  assert.ok(js.includes('Cần tiếp tục thủ công'), 'public user-action label present');
  assert.match(js, /userActionRequired/, 'user-action-required surfaced in UI mapping');
  // recovery status is per-browser (fed from the per-run summary b.recoveryState), not global
  assert.match(js, /recoveryBadge\(b\.recoveryState\)/, 'badge uses the per-browser recovery state');
});

test('user can manually reload a run browser (first-load/WS error), same run + partition', () => {
  const main = read('desktop/main.cjs');
  const pre = read('desktop/preload.cjs');
  const js = read('ui/product.js');
  assert.match(main, /handle\('browser-reload'/, 'browser-reload IPC exists');
  assert.match(main, /const wc = inappRuntime\.webContents\(id\)/, 'reloads the run\'s in-app webContents (same run/partition)');
  assert.match(main, /wc\.loadURL\(String\(target\)\)/, 're-navigates the current URL (reliable reload for a WebContentsView)');
  assert.match(pre, /reloadRun: runId => ipcRenderer\.invoke\('browser-reload'/, 'preload exposes reloadRun');
  assert.match(js, /data-reload="\$\{esc\(b\.runId/, 'online browser card offers a Tải lại (reload) action');
  assert.match(js, /api\.reloadRun\(x\.dataset\.reload\)/, 'reload button calls reloadRun');
});

test('an already-activated user can re-activate with a new key, and a failed attempt cannot lock them out', () => {
  const main = read('desktop/main.cjs');
  const pre = read('desktop/preload.cjs');
  const js = read('ui/product.js');
  const css = read('ui/product.css');
  const html = read('ui/product.html');
  // re-activation entry point + back button + force re-verify of the stored license
  assert.match(js, /pill\.onclick = \(\) => \{[\s\S]*?document\.body\.dataset\.reactivate = 'on'/, 'clicking the license pill opens re-activation');
  assert.ok(html.includes('id="activation-back"'), 'activation screen has a back button');
  assert.match(css, /body\[data-reactivate=on\] #activation-screen\{display:grid!important\}/, 'reactivate override shows activation over the active app');
  assert.match(main, /handle\('license-refresh'/, 'license-refresh IPC exists');
  assert.match(main, /'license-refresh'/, 'license-refresh is an OPEN channel (usable while inactive)');
  assert.match(pre, /refreshLicense: \(\) => ipcRenderer\.invoke\('license-refresh'\)/, 'preload exposes refreshLicense');
  assert.match(js, /api\.refreshLicense\(\)/, 'back/cancel force re-verifies the stored license (no lockout)');
  // safety: activate verifies before persisting, so a bad new key never overwrites the stored one
  const guard = read('desktop/licensing/license-guard.cjs');
  assert.match(guard, /if \(!result\.active\) \{[\s\S]*?return this\.status\(\);\s*\}\s*this\._store\.saveLicense/, 'activateAsync saves only after a successful verify');
});

test('CONTROL-V3: focusing a profile window grants keyboard focus and input ownership can be recovered', () => {
  const src = read('desktop/browser/inapp-runtime.cjs');
  const host = read('desktop/browser/browser-window-host.cjs');
  // The external browser window is focused AND its view's webContents is focused, so a
  // programmatic focus/raise grants keyboard input without needing a click.
  assert.match(host, /focusWindow\(runId\)\s*\{[\s\S]*?\.focus\(\)/, 'focusWindow raises/focuses the window');
  assert.match(host, /focusWindow\(runId\)\s*\{[\s\S]*?webContents\.focus\(\)/, 'focusWindow also focuses the site view (input ownership)');
  // InAppRuntime.focus(runId) delegates to the host so input ownership is recoverable without a reload.
  assert.match(src, /focus\(runId\)\s*\{[\s\S]*?this\._windowHost\.focusWindow\(runId\)/, 'explicit focus(runId) recovers input via the window host');
});

// WU-PROFILE-DATA-LIFECYCLE §3/§4/§5 — deleting a profile now deletes ALL data it owns.
// (This deliberately supersedes the earlier conservative "retain everything" policy.)
test('delete code path deletes owned data (history/auto-exec/diagnostics/config) + session storage', () => {
  const mainSrc = read('desktop/main.cjs');
  const start = mainSrc.indexOf('async function deletePersistentBrowser');
  const del = mainSrc.slice(start, start + 4200);
  assert.match(del, /removeBrowser\(bid\)/, 'removes per-browser history + auto-exec');
  assert.match(del, /purgeBrowser\(bid\)/, 'removes this browser\'s diagnostic records');
  assert.match(del, /browserConfigStore\.remove\(bid\)/, 'removes operating config');
  assert.match(del, /clearProfileSessionStorage\(bid\)/, 'clears Electron session storage (cookies/localStorage/...)');
  assert.match(del, /browserRegistry\.remove\(bid\)/, 'removes the identity record last');
  // Session storage is cleared via the SAME partition the runtime uses (no path guessing).
  assert.match(mainSrc, /clearStorageData/, 'delete clears profile session storage');
  assert.match(mainSrc, /partitionFor\(browserId\)/, 'session resolved through the runtime partition');
});
