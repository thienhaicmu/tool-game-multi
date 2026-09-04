import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');
const { verifyLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { normalizeEntitlement, validateEntitlementInput, buildLicensePayloadV2, deniedEntitlement, PLAN_PRESETS } = require('../../desktop/licensing/entitlements.cjs');

// A throwaway Ed25519 keypair (TEST signing credentials only).
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

const MACHINE = 'WVPT-PC-AB12-CD34-EF56-7890';
const ISSUED = 1_700_000_000;         // seconds
const EXPIRES = ISSUED + 60 * 24 * 60 * 60;
const NOW_MS = (ISSUED + 100) * 1000;  // not expired

function signPayload(payload) {
  const c = canonicalJson(payload);
  return `WVPT1.${base64url(c)}.${base64url(crypto.sign(null, Buffer.from(c, 'utf8'), privateKey))}`;
}
function v2(overrides = {}) {
  const base = buildLicensePayloadV2({
    machineId: MACHINE, plan: 'PRO', issuedAt: ISSUED, expiresAt: EXPIRES,
    maxBrowsers: 20, maxConcurrentBrowsers: 10,
    features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true },
    licenseId: 'LIC-DEADBEEF',
  });
  return { ...base, ...overrides };
}
const verify = (license, opts = {}) => verifyLicense(license, { machineId: MACHINE, nowMs: NOW_MS, publicKeyPem, ...opts });
// Re-encode a (mutated) payload but keep the ORIGINAL signature -> tamper.
function tamper(license, mutate) {
  const [prefix, , sig] = license.split('.');
  const payload = JSON.parse(Buffer.from(license.split('.')[1], 'base64url').toString('utf8'));
  mutate(payload);
  return `${prefix}.${base64url(canonicalJson(payload))}.${sig}`;
}

// ---- happy path ----
test('v2 license signs, verifies, and normalizes to the exact entitlements', () => {
  const res = verify(signPayload(v2()));
  assert.equal(res.active, true);
  const ent = normalizeEntitlement(res.payload);
  assert.equal(ent.schemaVersion, 2);
  assert.equal(ent.plan, 'PRO');
  assert.equal(ent.maxBrowsers, 20);
  assert.equal(ent.maxConcurrentBrowsers, 10);
  assert.deepEqual(ent.features, { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true });
});

// §59 — generator inputs map 1:1 to verified normalized entitlements.
test('generator inputs map 1:1 to verified entitlements (STANDARD example)', () => {
  const payload = buildLicensePayloadV2({
    machineId: MACHINE, plan: 'STANDARD', issuedAt: ISSUED, expiresAt: EXPIRES,
    maxBrowsers: 5, maxConcurrentBrowsers: 2,
    features: { autoRun: true, jackpotLive: true, jackpotGate: false, roundHistory: true },
    licenseId: 'LIC-1234ABCD',
  });
  const ent = normalizeEntitlement(verify(signPayload(payload)).payload);
  assert.equal(ent.plan, 'STANDARD');
  assert.equal(ent.maxBrowsers, 5);
  assert.equal(ent.maxConcurrentBrowsers, 2);
  assert.deepEqual(ent.features, { autoRun: true, jackpotLive: true, jackpotGate: false, roundHistory: true });
});

// §64 — tampering ANY signed field invalidates the license.
for (const [name, mutate] of [
  ['plan', (p) => { p.plan = 'PRO'; }],
  ['expiresAt', (p) => { p.expiresAt = p.expiresAt + 10 * 365 * 24 * 3600; }],
  ['machineId', (p) => { p.machineId = 'WVPT-PC-0000-0000-0000-0000'; }],
  ['maxBrowsers', (p) => { p.maxBrowsers = 100; }],
  ['maxConcurrentBrowsers', (p) => { p.maxConcurrentBrowsers = 100; }],
  ['features.autoRun', (p) => { p.features.autoRun = false; }],
  ['features.jackpotLive', (p) => { p.features.jackpotLive = false; }],
  ['features.jackpotGate', (p) => { p.features.jackpotGate = false; }],
  ['features.roundHistory', (p) => { p.features.roundHistory = false; }],
]) {
  test(`tamper ${name} -> invalid signature`, () => {
    // start from a STANDARD key so each mutation is a real change
    const start = signPayload(v2({ plan: 'STANDARD', maxBrowsers: 5, maxConcurrentBrowsers: 2, features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true } }));
    const res = verify(tamper(start, mutate));
    assert.equal(res.active, false);
    assert.ok(['LICENSE_BAD_SIGNATURE', 'LICENSE_MACHINE_MISMATCH', 'LICENSE_INVALID_FORMAT'].includes(res.error.code), `${name} -> ${res.error.code}`);
  });
}

// §65 — machine binding is exact.
test('license for another machine is rejected (no fuzzy match)', () => {
  const res = verifyLicense(signPayload(v2()), { machineId: 'WVPT-PC-1111-2222-3333-4444', nowMs: NOW_MS, publicKeyPem });
  assert.equal(res.error.code, 'LICENSE_MACHINE_MISMATCH');
});

// §66 — expiry.
test('expiry: valid before, invalid after expiresAt', () => {
  const license = signPayload(v2());
  assert.equal(verify(license, { nowMs: (EXPIRES - 10) * 1000 }).active, true);
  assert.equal(verify(license, { nowMs: (EXPIRES + 10) * 1000 }).error.code, 'LICENSE_EXPIRED');
});

// §10/§63 — dependency is enforced at VERIFY even if a bad combo was signed.
test('signed jackpotGate without jackpotLive is rejected at verify', () => {
  const bad = v2({ features: { autoRun: true, jackpotLive: false, jackpotGate: true, roundHistory: true } });
  const res = verify(signPayload(bad)); // validly signed, but invalid shape
  assert.equal(res.error.code, 'LICENSE_INVALID_FORMAT');
});

// v2 shape: capacities must be present + sane.
test('v2 requires valid capacities and features', () => {
  assert.equal(verify(signPayload(v2({ maxBrowsers: 0 }))).error.code, 'LICENSE_INVALID_FORMAT');
  assert.equal(verify(signPayload(v2({ maxConcurrentBrowsers: 25 }))).error.code, 'LICENSE_INVALID_FORMAT'); // > maxBrowsers(20)? no, 25>20 -> invalid
  const noFeat = v2(); delete noFeat.features;
  assert.equal(verify(signPayload(noFeat)).error.code, 'LICENSE_INVALID_FORMAT');
});

// ---- entitlement normalization units ----
test('normalize: missing v2 feature is FALSE (never accidental access)', () => {
  const ent = normalizeEntitlement({ v: 2, plan: 'PRO', maxBrowsers: 5, maxConcurrentBrowsers: 2, expiresAt: EXPIRES, licenseId: 'LIC-X', features: { autoRun: true } });
  assert.equal(ent.features.autoRun, true);
  assert.equal(ent.features.jackpotLive, false);
  assert.equal(ent.features.jackpotGate, false);
  assert.equal(ent.features.roundHistory, false);
});
test('normalize: jackpotGate is structurally gated by jackpotLive', () => {
  const ent = normalizeEntitlement({ v: 2, plan: 'PRO', maxBrowsers: 5, maxConcurrentBrowsers: 2, expiresAt: EXPIRES, features: { jackpotLive: false, jackpotGate: true } });
  assert.equal(ent.features.jackpotGate, false);
});
test('normalize: legacy v1 uses the explicit full-access policy', () => {
  const ent = normalizeEntitlement({ v: 1, product: 'WVPT', machineId: MACHINE, issuedAt: ISSUED, expiresAt: EXPIRES, licenseId: 'LIC-OLD' });
  assert.equal(ent.schemaVersion, 1);
  assert.equal(ent.legacy, true);
  assert.equal(ent.maxBrowsers, null); // unlimited
  assert.deepEqual(ent.features, { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true });
});
test('deniedEntitlement denies everything (fail-closed default)', () => {
  const d = deniedEntitlement();
  assert.equal(d.valid, false);
  assert.equal(d.maxBrowsers, 0);
  assert.deepEqual(d.features, { autoRun: false, jackpotLive: false, jackpotGate: false, roundHistory: false });
});

// ---- seller-side pre-sign validation ----
test('validateEntitlementInput rejects the jackpotGate-without-live dependency', () => {
  const r = validateEntitlementInput({ plan: 'PRO', maxBrowsers: 5, maxConcurrentBrowsers: 2, features: { autoRun: true, jackpotLive: false, jackpotGate: true, roundHistory: true } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'JACKPOT_GATE_REQUIRES_LIVE'));
});
test('validateEntitlementInput rejects concurrent > total and bad capacities', () => {
  assert.equal(validateEntitlementInput({ plan: 'PRO', maxBrowsers: 5, maxConcurrentBrowsers: 6, features: allFeat() }).ok, false);
  assert.equal(validateEntitlementInput({ plan: 'PRO', maxBrowsers: 0, maxConcurrentBrowsers: 1, features: allFeat() }).ok, false);
  assert.equal(validateEntitlementInput({ plan: 'NOPE', maxBrowsers: 5, maxConcurrentBrowsers: 2, features: allFeat() }).ok, false);
  assert.equal(validateEntitlementInput({ plan: 'PRO', maxBrowsers: 5, maxConcurrentBrowsers: 2, features: allFeat() }).ok, true);
});
test('plan presets satisfy their own validation', () => {
  for (const plan of Object.keys(PLAN_PRESETS)) {
    const p = PLAN_PRESETS[plan];
    assert.equal(validateEntitlementInput({ plan, maxBrowsers: p.maxBrowsers, maxConcurrentBrowsers: p.maxConcurrentBrowsers, features: p.features }).ok, true, plan);
  }
});
function allFeat() { return { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true }; }
