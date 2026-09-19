// PHASE 6.2.2 — two tabs (SETUP/PHỎM) + per-browser lifecycle wiring (↻ WEB, ⏻ close, MỞ CHROMIUM, VÀO
// BÀN). Source-level + IPC assertions (no DOM/GUI runtime in CI). Backend actions are run-scoped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const main = read('desktop/phom-main.cjs');
const preload = read('desktop/phom-preload.cjs');

function fn(src, name) { const s = src.indexOf('function ' + name + '('); if (s < 0) return ''; const rest = src.slice(s + 1); const n = rest.indexOf('\n  function '); return rest.slice(0, n > 0 ? n : 4000); }

test('two tabs: SETUP and PHỎM, switchable', () => {
  assert.match(js, /function renderTabBar\(/);
  assert.match(js, /tab\('SETUP', 'PROFILE'\)/); // PHASE 6.3.9 — tab id 'SETUP' (internal), label 'PROFILE'
  assert.match(js, /tab\('PHOM', 'PHỎM'\)/);
  assert.match(js, /let activeTab = 'SETUP'/);
  assert.match(js, /activeTab = id; renderApp\(\)/);
});

test('SETUP tab shows setup; PHỎM tab shows control (no table controls in SETUP)', () => {
  const app = fn(js, 'renderApp');
  assert.match(app, /activeTab === 'PHOM'[\s\S]*?renderControl\(content\)/);
  assert.match(app, /renderSetup\(content\)/);
  // opening the cluster switches to the PHỎM tab
  assert.match(js, /uiState = UI\.CONTROL; activeTab = "PHOM"/);
});

test('VÀO BÀN joins the shared RID (never a new discovery) and shows ĐANG VÀO BÀN', () => {
  const h = fn(js, 'onManualJoinShared');
  assert.match(h, /manualCluster\.sharedRid/);
  assert.match(h, /manualJoining\[b\.profileId\] = true/); // immediate ĐANG VÀO BÀN
  // exact shared RID, no discovery — and §38 the SAME join the header uses (bounded retry + same-room proof)
  assert.match(h, /api\.manualJoinShared\(b\.profileId, rid\)/);
  assert.equal(/api\.manualDiscover\(/.test(h), false, 'VÀO BÀN must not run discovery');
});

test('↻ WEB reloads/re-opens web in the SAME Chromium (never a new window)', () => {
  const h = fn(js, 'onReloadWeb');
  assert.match(h, /api\.reloadWeb\(runId\)/);
  assert.match(preload, /reloadWeb:/);
  // backend: reload the page, else re-navigate the SAME run — no run/window creation
  assert.match(main, /phom:reload-web/);
  assert.match(main, /Page\.reload/);
  assert.match(main, /Page\.navigate/);
  assert.equal(/phom:reload-web[\s\S]{0,400}createRun|phom:reload-web[\s\S]{0,400}openProfile/.test(main), false, 'reload never launches a new Chromium');
});

test('⏻ closes ONLY that run; MỞ CHROMIUM reopens the closed browser', () => {
  const close = fn(js, 'onCloseBrowser');
  assert.match(close, /api\.closeBrowser\(runId\)/);
  assert.match(preload, /closeBrowser:/);
  assert.match(main, /phom:close-browser/);
  assert.match(main, /async function closeBrowserRun\(runId\)[\s\S]*?runManager\.closeRun\(rid\)/);
  const reopen = fn(js, 'onReopenBrowser');
  assert.match(reopen, /api\.clusterOpen\(\)/); // reopens closed slots only; live untouched
  // no auto-rejoin after reopen (§16)
  assert.equal(/manualJoin|manualDiscover|onManualJoinShared/.test(reopen), false, 'reopen must not auto-rejoin');
});

test('close is browser-scoped: the close handler never closes the Tool or all browsers', () => {
  const close = fn(js, 'onCloseBrowser');
  assert.equal(/closeBrowsers\(\)|clusterStop|api\.clusterStop/.test(close), false, 'never closes the whole cluster/Tool');
});

test('no manual stake input and no host/follower terminology on the main control surface (§6.3.2)', () => {
  // PHASE 6.3.2 — ACCOUNT (the logged-in display name) is now shown READ-ONLY in the cell, so the old
  // blanket "no username" ban no longer applies to compactBrowserCell; the manual stake input is still
  // banned everywhere (stake is a server option picked in the Chromium header).
  for (const name of ['compactHeader', 'compactBrowserCell', 'compactBrowserRow']) {
    const body = fn(js, name);
    assert.equal(/phq-manual-stake|placeholder: '100'/.test(body), false, `${name} must have no manual stake input`);
    assert.equal(/HOST|FOLLOWER|Player 4|player-4/.test(body), false, `${name} must have no host/follower/player-4`);
  }
});

test('lifecycle controls: reload-web + power icon buttons appear per browser card (§6/§24)', () => {
  const cell = fn(js, 'compactBrowserCell');
  // PHASE 6.3 — icon buttons (no emoji glyphs); wiring + tooltips preserved
  assert.match(cell, /iconButton\('refresh',[\s\S]*?onReloadWeb\(runId\)/);
  assert.match(cell, /iconButton\('power',[\s\S]*?onCloseBrowser\(slot, runId\)/);
  assert.match(cell, /MỞ CHROMIUM/);
});
