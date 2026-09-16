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

// PHASE 6.3.2-fix — the game URL is remembered per profile so it is not re-typed each launch; a typed URL
// overrides + is saved back, otherwise the profile's own saved URL is used.
test('open-from-selection remembers + reuses the Game URL per profile (§6.3.2-fix)', () => {
  const fn = main.slice(main.indexOf('function openSelectedProfiles('), main.indexOf('function ensureCluster()'));
  assert.match(fn, /typedUrl \|\| \(p\.gameUrl/); // typed URL overrides, else the profile's saved URL
  assert.match(fn, /deviceProfilesStore\.update\(ids\[i\], \{ gameUrl: profUrl \}\)/); // save it back for next launch
  assert.match(fn, /PHOM_GAME_URL_REQUIRED/); // still required (typed or saved) unless local test
  // the renderer seeds the URL field from a saved profile when empty
  assert.match(js, /profilesX\.find\(\(p\) => p\.gameUrl\)/);
});

// PHASE 6.3.2-fix — a valid product license IS the authorization for manual QA control (no hidden env gate),
// wired live so it reflects the current license regardless of when the coordinator was built.
test('a licensed app authorizes manual control; authorization is a LIVE getter', () => {
  const authFn = main.slice(main.indexOf('function phomAuthorizedEnv('), main.indexOf('function phomAuthorizedEnv(') + 400);
  assert.match(authFn, /if \(licenseActive\(\)\) return true/);
  const mgr = read('desktop/protocol/phom/host-session-manager.cjs');
  assert.match(mgr, /environmentAuthorized: \(\) => this\.authorized\(\)/); // live, not a snapshot
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  assert.match(coord, /this\._authorizedFn = typeof deps\.environmentAuthorized === 'function'/);
  assert.match(coord, /_guard\(\) \{ return this\._authorizedFn\(\) && !this\._stopped; \}/);
});

test('index.html loads the profile-selection module before the renderer', () => {
  const html = read('ui-phom/index.html');
  assert.match(html, /profile-selection\.js/);
  assert.ok(html.indexOf('profile-selection.js') < html.indexOf('phom-qa.js'));
});
