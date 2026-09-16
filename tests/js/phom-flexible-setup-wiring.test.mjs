// PHASE 6.3.1 — wiring assertions for the flexible SETUP: main IPC (CRUD + open-from-selection with the
// active-profile guard + device forwarding) and the renderer (table selection, bulk proxy, RUN GAME →
// openSelected). Source-level (no GUI runtime) — the pure store/selection logic is tested separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const main = read('desktop/phom-main.cjs');
const preload = read('desktop/phom-preload.cjs');
const js = read('ui-phom/phom-qa.js');

test('main exposes flexible profile CRUD IPC backed by the new store', () => {
  assert.match(main, /new PhomDeviceProfilesStore\(/);
  for (const ch of ['phom:profiles-list', 'phom:profile-create', 'phom:profile-update-x', 'phom:profile-delete-x', 'phom:profile-set-proxy', 'phom:open-selected']) {
    assert.ok(main.includes(ch), `IPC ${ch} present`);
  }
  for (const b of ['profilesList', 'profileCreate', 'profileUpdateX', 'profileDeleteX', 'profileSetProxy', 'openSelected']) {
    assert.ok(preload.includes(b + ':'), `preload bridge ${b}`);
  }
});

test('delete + proxy-change are blocked while the profile backs a LIVE Chromium (§11/§30)', () => {
  assert.match(main, /function profileInUse\(profileId\)/);
  assert.match(main, /String\(run\.profileId\) === String\(profileId\)/);
  // both delete-x and set-proxy consult the guard
  const del = main.slice(main.indexOf("phom:profile-delete-x"), main.indexOf("phom:profile-delete-x") + 400);
  assert.match(del, /profileInUse\(pid\)/);
  const setpx = main.slice(main.indexOf("phom:profile-set-proxy"), main.indexOf("phom:profile-set-proxy") + 500);
  assert.match(setpx, /profileInUse\(pid\)/);
});

test('open-from-selection maps selection order → B1/B2/B3 (internal slots A/B/C) with each profile device+proxy', () => {
  const fn = main.slice(main.indexOf('function openSelectedProfiles('), main.indexOf('function ensureCluster()'));
  assert.match(fn, /ids\.length !== 3/); // exactly 3
  assert.match(fn, /PHOM_GAME_URL_REQUIRED/); // game url required (unless local test)
  assert.match(fn, /slot: SLOTS_ABC\[i\]/); // selection order i → slot A/B/C → B(i+1)
  assert.match(fn, /device: p\.device/); // each browser gets ITS profile device
  assert.match(fn, /proxyRef: p\.proxyRef/);
  assert.match(fn, /profileId: p\.id/); // stable profile identity carried to the run
});

test('openProfile forwards an explicit device + records browserRunId → profileId (reopen uses the right profile)', () => {
  assert.match(main, /const device = deviceArg \|\| profileStore\.deviceFor\(pk\)/);
  assert.match(main, /run\.profileId = udKey/);
  // the cluster openProfile closure forwards the flexible profile id + device
  assert.match(main, /profileId: \(cfg && \(cfg\.profileId \|\| cfg\.browserProfileId\)\)/);
  assert.match(main, /device: \(cfg && cfg\.device\)/);
});

test('renderer SETUP: profile list, ordered selection, bulk proxy by order, RUN GAME → openSelected', () => {
  assert.match(js, /window\.ProfileSelection/);
  assert.match(js, /api\.profilesList\(\)/);
  assert.match(js, /api\.profileCreate\(|api\.profileUpdateX\(/);
  assert.match(js, /api\.profileDeleteX\(/);
  assert.match(js, /api\.profileSetProxy\(/);
  // bulk proxy maps to the selection order via the pure module
  assert.match(js, /PS\.mapProxies\(selectedProfileIds, bulkProxyText\)/);
  // RUN GAME opens the ordered selection
  assert.match(js, /api\.openSelected\(\{ profileIds: selectedProfileIds, gameUrl: gameUrlX, localTest \}\)/);
  // OS window ⟂ viewport in the modal (separate fields)
  assert.match(js, /pf-osw/); assert.match(js, /pf-vpw/);
});

test('index.html loads the profile-selection module before the renderer', () => {
  const html = read('ui-phom/index.html');
  assert.match(html, /profile-selection\.js/);
  assert.ok(html.indexOf('profile-selection.js') < html.indexOf('phom-qa.js'));
});
