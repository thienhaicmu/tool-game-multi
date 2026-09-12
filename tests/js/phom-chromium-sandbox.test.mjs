// Chromium sandbox policy (SECURITY). The sandbox is a boundary that must stay ON in
// production/packaged; --no-sandbox is never a default. A dev diagnostic bypass exists
// only behind an explicit flag AND every guard, and is refused when packaged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveSandboxPolicy, DIAGNOSTIC_ENV } = require('../../desktop/browser/chromium-sandbox-policy.cjs');
const runtime = require('../../desktop/browser/phom-chromium-runtime.cjs');

const devAllGuards = { isPackaged: false, nodeEnv: 'development', devBypassAllowed: true, localTest: true, diagnosticFlag: true, hasGameEndpoint: false, hasLiveProxy: false };

test('production/packaged never disables the sandbox', () => {
  assert.equal(resolveSandboxPolicy({ isPackaged: true }).sandboxDisabled, false);
  assert.equal(resolveSandboxPolicy({ isPackaged: false, nodeEnv: 'production' }).sandboxDisabled, false);
  // even with the flag + all other guards, packaged stays sandboxed.
  const r = resolveSandboxPolicy({ ...devAllGuards, isPackaged: true });
  assert.equal(r.sandboxDisabled, false);
});

test('packaged build REFUSES the diagnostic flag (PHOM_CHROMIUM_SANDBOX_BYPASS_FORBIDDEN)', () => {
  const r = resolveSandboxPolicy({ isPackaged: true, diagnosticFlag: true });
  assert.equal(r.sandboxDisabled, false);
  assert.equal(r.rejected, 'PHOM_CHROMIUM_SANDBOX_BYPASS_FORBIDDEN');
});

test('development default keeps the sandbox ON (no flag ⇒ no bypass)', () => {
  const r = resolveSandboxPolicy({ isPackaged: false, nodeEnv: 'development' });
  assert.equal(r.sandboxDisabled, false);
  assert.equal(r.mode, 'SANDBOX_ENABLED');
});

test('dev diagnostic bypass requires the flag AND every guard', () => {
  // Full guards -> disabled, with a red banner string.
  const ok = resolveSandboxPolicy(devAllGuards);
  assert.equal(ok.sandboxDisabled, true);
  assert.equal(ok.mode, 'DEV_DIAGNOSTIC_SANDBOX_DISABLED');
  assert.match(ok.banner, /SANDBOX DISABLED/);
  // Missing any single guard -> sandbox stays ON, blocked with PHOM_CHROMIUM_SANDBOX_REQUIRED.
  for (const missing of ['devBypassAllowed', 'localTest']) {
    const r = resolveSandboxPolicy({ ...devAllGuards, [missing]: false });
    assert.equal(r.sandboxDisabled, false, `guard ${missing} must be required`);
    assert.equal(r.blocked, 'PHOM_CHROMIUM_SANDBOX_REQUIRED');
  }
  // A real game endpoint or a live proxy also refuses the bypass.
  assert.equal(resolveSandboxPolicy({ ...devAllGuards, hasGameEndpoint: true }).sandboxDisabled, false);
  assert.equal(resolveSandboxPolicy({ ...devAllGuards, hasLiveProxy: true }).sandboxDisabled, false);
});

test('the diagnostic env var name is the documented one', () => {
  assert.equal(DIAGNOSTIC_ENV, 'PHOM_DEV_DISABLE_CHROMIUM_SANDBOX');
});

test('ensureSandboxAccess is a no-op off Windows and exports the AppContainer SIDs', () => {
  // The AppContainer read+execute grant (the real 0x5 fix) targets these SIDs.
  assert.equal(runtime.SID_ALL_APP_PACKAGES, '*S-1-15-2-1');
  assert.equal(runtime.SID_ALL_RESTRICTED_APP_PACKAGES, '*S-1-15-2-2');
  if (process.platform !== 'win32') {
    assert.deepEqual(runtime.ensureSandboxAccess('/whatever'), { ok: true, changed: false, reason: 'non-windows' });
  }
});
