import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveDevBypass, developmentBypassContext, FORBIDDEN_CODE } = require('../../desktop/licensing/dev-bypass.cjs');
const { LicenseGuard } = require('../../desktop/licensing/license-guard.cjs');

const machineOk = () => ({ ok: true, machineId: 'WVPT-PC-AB12-CD34-EF56-7890' });

// §3 — default OFF: no flag => no bypass.
test('dev bypass is OFF by default', () => {
  assert.deepEqual(resolveDevBypass({ isPackaged: false, env: {} }), { requested: false, allowed: false, forbidden: false });
});

// §3 — development + explicit flag => allowed.
test('dev bypass allowed only in unpackaged development with the flag', () => {
  const r = resolveDevBypass({ isPackaged: false, env: { PHOM_DEV_LICENSE_BYPASS: '1', NODE_ENV: 'development' } });
  assert.equal(r.allowed, true);
  assert.equal(r.forbidden, false);
});

// §3 — packaged build + flag => FORBIDDEN (startup-blocking), never allowed.
test('dev bypass forbidden in a packaged build even with the flag', () => {
  const r = resolveDevBypass({ isPackaged: true, env: { PHOM_DEV_LICENSE_BYPASS: '1', NODE_ENV: 'development' } });
  assert.equal(r.allowed, false);
  assert.equal(r.forbidden, true);
  assert.equal(r.code, FORBIDDEN_CODE);
});

// §3 — production channel / release marker also forbid it.
test('production channel or release marker forbids bypass', () => {
  assert.equal(resolveDevBypass({ isPackaged: false, env: { PHOM_DEV_LICENSE_BYPASS: '1', PHOM_RELEASE_CHANNEL: 'production' } }).forbidden, true);
  assert.equal(resolveDevBypass({ isPackaged: false, releaseMarker: true, env: { PHOM_DEV_LICENSE_BYPASS: '1' } }).forbidden, true);
  assert.equal(resolveDevBypass({ isPackaged: false, env: { PHOM_DEV_LICENSE_BYPASS: '1', NODE_ENV: 'production' } }).allowed, false);
});

// §3 — the bypass context is clearly non-shippable, never "activated key".
test('developmentBypassContext is marked DEVELOPMENT_BYPASS, not a real activation', () => {
  const c = developmentBypassContext('PHOM', 'WVPT-PC-...');
  assert.equal(c.mode, 'DEVELOPMENT_BYPASS');
  assert.equal(c.active, true);
  assert.equal(c.licenseId, null);
  assert.equal(c.expiresAt, null);
  assert.equal(c.productionAllowed, false);
});

// §3 — LicenseGuard with devBypass reports the bypass context WITHOUT verifying a key:
// even a garbage stored license (which would FAIL verification) stays active.
test('LicenseGuard devBypass short-circuits to DEVELOPMENT_BYPASS (no verify)', () => {
  const store = { loadLicense: () => 'WVPT1.garbage.not-a-real-signature', loadState: () => ({}), saveState: () => {}, saveLicense: () => {} };
  const guard = new LicenseGuard({ userDataPath: '.', machineIdProvider: machineOk, nowMs: () => Date.now(), store, expectedGameProduct: 'PHOM', devBypass: true });
  const s = guard.initialize();
  assert.equal(s.active, true);
  assert.equal(s.mode, 'DEVELOPMENT_BYPASS');
  assert.equal(guard.refresh().active, true);
  // proof of non-verification: the SAME garbage license without bypass is inactive.
  const strict = new LicenseGuard({ userDataPath: '.', machineIdProvider: machineOk, nowMs: () => Date.now(), store, expectedGameProduct: 'PHOM' });
  assert.equal(strict.initialize().active, false);
});

// A guard WITHOUT devBypass behaves exactly as before (no license => inactive).
test('LicenseGuard without devBypass still enforces (no license => inactive)', () => {
  const store = { loadLicense: () => null, loadState: () => ({}), saveState: () => {}, saveLicense: () => {} };
  const guard = new LicenseGuard({ userDataPath: '.', machineIdProvider: machineOk, nowMs: () => Date.now(), store, expectedGameProduct: 'PHOM' });
  const s = guard.initialize();
  assert.equal(s.active, false);
});
