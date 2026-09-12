import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');
const { verifyLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { buildLicensePayloadV2, normalizeEntitlement } = require('../../desktop/licensing/entitlements.cjs');

// Throwaway Ed25519 keypair (TEST signing only — never a real private key).
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

const MACHINE = 'WVPT-PC-AB12-CD34-EF56-7890';
const ISSUED = 1_700_000_000;
const EXPIRES = ISSUED + 60 * 24 * 60 * 60;
const NOW_MS = (ISSUED + 100) * 1000;

function signPayload(payload) {
  const c = canonicalJson(payload);
  return `WVPT1.${base64url(c)}.${base64url(crypto.sign(null, Buffer.from(c, 'utf8'), privateKey))}`;
}
function key({ gameProduct } = {}) {
  return signPayload(buildLicensePayloadV2({
    machineId: MACHINE, plan: 'STANDARD', issuedAt: ISSUED, expiresAt: EXPIRES,
    maxBrowsers: 5, maxConcurrentBrowsers: 2,
    features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true },
    licenseId: 'LIC-DEADBEEF', gameProduct,
  }));
}
const verify = (license, expectedGameProduct) => verifyLicense(license, { machineId: MACHINE, nowMs: NOW_MS, publicKeyPem, expectedGameProduct });

// §3 — PHOM key in the Phom app activates.
test('PHOM key + expected PHOM => active', () => {
  const r = verify(key({ gameProduct: 'PHOM' }), 'PHOM');
  assert.equal(r.active, true);
  assert.equal(r.payload.gameProduct, 'PHOM');
});

// §3 — AVIATOR key in the Phom app is a typed mismatch (not generic invalid).
test('AVIATOR key + expected PHOM => LICENSE_GAME_PRODUCT_MISMATCH', () => {
  const r = verify(key({ gameProduct: 'AVIATOR' }), 'PHOM');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_GAME_PRODUCT_MISMATCH');
});

// §3 — PHOM key in the Aviator app is a typed mismatch.
test('PHOM key + expected AVIATOR => LICENSE_GAME_PRODUCT_MISMATCH', () => {
  const r = verify(key({ gameProduct: 'PHOM' }), 'AVIATOR');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_GAME_PRODUCT_MISMATCH');
});

// §4 — legacy key (no signed gameProduct) runs AVIATOR but NEVER PHOM.
test('legacy key (no gameProduct) => AVIATOR ok, PHOM entitlement required', () => {
  const legacy = key({ gameProduct: undefined }); // buildLicensePayloadV2 omits the field
  assert.equal(verify(legacy, 'AVIATOR').active, true);
  const r = verify(legacy, 'PHOM');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_PHOM_ENTITLEMENT_REQUIRED');
});

// §2 — ALL grants both (only if policy issues it).
test('ALL key satisfies both AVIATOR and PHOM', () => {
  const all = key({ gameProduct: 'ALL' });
  assert.equal(verify(all, 'AVIATOR').active, true);
  assert.equal(verify(all, 'PHOM').active, true);
});

// §2 — flipping the signed gameProduct fails the signature (cannot self-upgrade).
test('editing gameProduct in the payload breaks the signature', () => {
  const phom = key({ gameProduct: 'PHOM' });
  const [prefix, body, sig] = phom.split('.');
  const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  payload.gameProduct = 'AVIATOR';
  const forged = `${prefix}.${base64url(canonicalJson(payload))}.${sig}`;
  const r = verify(forged, 'AVIATOR');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_BAD_SIGNATURE');
});

// §2 — unknown gameProduct value is a hard format failure.
test('unknown gameProduct => LICENSE_GAME_PRODUCT_INVALID', () => {
  const bad = signPayload({ ...JSON.parse(Buffer.from(key({ gameProduct: 'PHOM' }).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')), gameProduct: 'ROULETTE' });
  const r = verify(bad, 'PHOM');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_GAME_PRODUCT_INVALID');
});

// no expectedGameProduct => unchanged legacy behaviour (backward compat).
test('no expectedGameProduct => gameProduct not enforced', () => {
  assert.equal(verify(key({ gameProduct: 'PHOM' })).active, true);
  assert.equal(verify(key({ gameProduct: 'AVIATOR' })).active, true);
});

// normalizeEntitlement surfaces gameProduct; legacy defaults to AVIATOR.
test('normalizeEntitlement surfaces gameProduct (legacy => AVIATOR)', () => {
  assert.equal(normalizeEntitlement({ v: 2, plan: 'PRO', maxBrowsers: 5, maxConcurrentBrowsers: 2, expiresAt: EXPIRES, gameProduct: 'PHOM', features: {} }).gameProduct, 'PHOM');
  assert.equal(normalizeEntitlement({ v: 2, plan: 'PRO', maxBrowsers: 5, maxConcurrentBrowsers: 2, expiresAt: EXPIRES, features: {} }).gameProduct, 'AVIATOR');
  assert.equal(normalizeEntitlement({ v: 1, product: 'WVPT', machineId: MACHINE, issuedAt: ISSUED, expiresAt: EXPIRES }).gameProduct, 'AVIATOR');
});
