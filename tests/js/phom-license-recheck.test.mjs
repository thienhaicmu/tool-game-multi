import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LicenseGuard } = require('../../desktop/licensing/license-guard.cjs');
const { issueLicense } = require('../../tools/license-generator/license-signer.cjs');

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const MACHINE = 'WVPT-PC-AB12-CD34-EF56-7890';
const ISSUED = 1_780_000_000;
const KEY = new URL('../../tools/license-generator/private/phom-ed25519-private.pem', import.meta.url);

function memoryStore() {
  let license = null; let state = {};
  return { loadState: () => state, saveState(s) { state = s; }, loadLicense: () => license, saveLicense(l) { license = l; } };
}

// GĐ1 · K1 — the guard re-verifies the stored key against the (trusted) clock, so a key that expires while the app
// runs goes inactive at the next check; the recheck never spends a launch.
test('a PHOM key that expires mid-session is inactive at the next recheck (LICENSE_EXPIRED), launches untouched', { skip: existsSync(KEY) ? false : 'PHOM private key not present' }, async () => {
  const priv = readFileSync(KEY, 'utf8');
  const { license } = issueLicense({ game: 'PHOM', plan: 'TRIAL', duration: { unit: 'days', value: 7 }, machineId: MACHINE, features: { autoRun: true } }, { issuedAt: ISSUED, privateKeyForGame: () => priv });
  let now = (ISSUED + 3600) * 1000;
  const store = memoryStore();
  const guard = new LicenseGuard({ machineIdProvider: () => ({ ok: true, machineId: MACHINE }), nowMs: () => now, expectedGameProduct: 'PHOM', store });
  guard.initialize();
  assert.equal(guard.activate(license).active, true);
  const used = store.loadState().launch.used;
  assert.equal((await guard.refreshAsync({ consumeLaunch: false })).active, true);
  now = (ISSUED + 8 * 86400) * 1000; // past the 7 days the key allows
  const s = await guard.refreshAsync({ consumeLaunch: false });
  assert.equal(s.active, false);
  assert.equal(s.error.code, 'LICENSE_EXPIRED');
  assert.equal(store.loadState().launch.used, used);
});

test('phom-main rechecks the key every 5 min, and only a change is pushed (with Tự động off on a lock)', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /const LICENSE_RECHECK_MS = 5 \* 60 \* 1000;/);
  assert.match(main, /setInterval\(\(\) => \{ recheckLicense\(\)\.catch\(\(\) => \{\}\); \}, LICENSE_RECHECK_MS\)\.unref\(\);/);
  const fn = main.slice(main.indexOf('async function recheckLicense'), main.indexOf('async function licenseStatus'));
  assert.match(fn, /refreshAsync\(\{ consumeLaunch: false \}\)/);
  assert.match(fn, /if \(active === _licenseWasActive\) return;/);
  assert.match(fn, /setAuto\(false\)/);
  assert.match(fn, /send\('phom:license'/);
});

test('a key activated in the app starts the online check for ITS id (a new key replaces the old guard)', () => {
  const main = read('desktop/phom-main.cjs');
  const activate = main.slice(main.indexOf("ipcMain.handle('phom:license-activate'"), main.indexOf("ipcMain.handle('phom:machine-id'"));
  assert.match(activate, /startOnlineRevoke\(s\)/);
  const start = main.slice(main.indexOf('function startOnlineRevoke'), main.indexOf('// Development-only license bypass'));
  assert.match(start, /_onlineGuard && _onlineLicenseId === licenseId/);
  assert.match(start, /_onlineGuard\.stop\(\)/);
});

test('an online lock makes the reported status inactive with a reason the activation screen can show', () => {
  const main = read('desktop/phom-main.cjs');
  const status = main.slice(main.indexOf('async function licenseStatus'), main.indexOf('// Active orchestration IPC'));
  assert.match(status, /_onlineLocked && !devBypass\.allowed\) status = \{ \.\.\.status, active: false, error: onlineLockError\(\) \}/);
  assert.match(main, /LICENSE_OFFLINE_TOO_LONG/);
  assert.match(main, /LICENSE_REVOKED_ONLINE/);
  const ui = read('ui-phom/phom-qa.js');
  assert.match(ui, /else if \(s\.active === false && !\$\('workspace'\)\.hidden\) showActivation\(s\);/);
  assert.match(ui, /e\.code === 'LICENSE_REVOKED_ONLINE'/);
  assert.match(ui, /e\.code === 'LICENSE_OFFLINE_TOO_LONG'/);
});
