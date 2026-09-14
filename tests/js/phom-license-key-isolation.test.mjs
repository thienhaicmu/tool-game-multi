import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');
const { verifyLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { buildLicensePayloadV2 } = require('../../desktop/licensing/entitlements.cjs');

// TWO separate throwaway keypairs standing in for the AVIATOR and PHOM signing keys.
const aviator = crypto.generateKeyPairSync('ed25519');
const phom = crypto.generateKeyPairSync('ed25519');
const SIGNING_KEYS = {
  AVIATOR_V1: aviator.publicKey.export({ type: 'spki', format: 'pem' }),
  PHOM_V1: phom.publicKey.export({ type: 'spki', format: 'pem' }),
};
const PRODUCT_KEY_IDS = { AVIATOR: ['AVIATOR_V1'], PHOM: ['PHOM_V1'] };

const MACHINE = 'WVPT-PC-AB12-CD34-EF56-7890';
const ISSUED = 1_700_000_000, EXPIRES = ISSUED + 60 * 86400, NOW_MS = (ISSUED + 100) * 1000;

function signWith(priv, payload) {
  const c = canonicalJson(payload);
  return `WVPT1.${base64url(c)}.${base64url(crypto.sign(null, Buffer.from(c, 'utf8'), priv))}`;
}
function payload({ gameProduct, signingKeyId }) {
  return buildLicensePayloadV2({
    machineId: MACHINE, plan: 'STANDARD', issuedAt: ISSUED, expiresAt: EXPIRES, maxBrowsers: 5, maxConcurrentBrowsers: 2,
    features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true }, licenseId: 'LIC-DEADBEEF', gameProduct, signingKeyId,
  });
}
// Verify against the REGISTRY (no publicKeyPem override) so keyId resolution is exercised.
const verify = (license, expectedGameProduct) => verifyLicense(license, { machineId: MACHINE, nowMs: NOW_MS, expectedGameProduct, signingKeys: SIGNING_KEYS, productKeyIds: PRODUCT_KEY_IDS });

test('AVIATOR payload signed with the AVIATOR key => valid in Aviator', () => {
  const r = verify(signWith(aviator.privateKey, payload({ gameProduct: 'AVIATOR' })), 'AVIATOR');
  assert.equal(r.active, true);
});

test('PHOM payload signed with the PHOM key => valid in Phom', () => {
  const r = verify(signWith(phom.privateKey, payload({ gameProduct: 'PHOM' })), 'PHOM');
  assert.equal(r.active, true);
});

test('PHOM payload signed with the AVIATOR key => rejected (bad signature)', () => {
  // signingKeyId says PHOM_V1, so the verifier uses the PHOM public key — an Aviator-signed
  // blob does not verify.
  const r = verify(signWith(aviator.privateKey, payload({ gameProduct: 'PHOM' })), 'PHOM');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_BAD_SIGNATURE');
});

test('AVIATOR payload signed with the PHOM key => rejected (bad signature)', () => {
  const r = verify(signWith(phom.privateKey, payload({ gameProduct: 'AVIATOR' })), 'AVIATOR');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_BAD_SIGNATURE');
});

test('crafted keyId cross-over (PHOM product, AVIATOR_V1 key, Aviator-signed) => key/product mismatch', () => {
  // The attacker sets signingKeyId=AVIATOR_V1 on a PHOM payload and signs with the Aviator
  // key so the signature verifies — but AVIATOR_V1 is not allowed for PHOM.
  const r = verify(signWith(aviator.privateKey, payload({ gameProduct: 'PHOM', signingKeyId: 'AVIATOR_V1' })), 'PHOM');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_SIGNING_KEY_PRODUCT_MISMATCH');
});

test('unknown signingKeyId => rejected', () => {
  const r = verify(signWith(phom.privateKey, payload({ gameProduct: 'PHOM', signingKeyId: 'GHOST_V9' })), 'PHOM');
  assert.equal(r.active, false);
  assert.equal(r.error.code, 'LICENSE_SIGNING_KEY_ID_INVALID');
});

test('tampering the signed gameProduct or signingKeyId breaks the signature', () => {
  const good = signWith(phom.privateKey, payload({ gameProduct: 'PHOM' }));
  const [prefix, body, sig] = good.split('.');
  const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  for (const mut of [{ gameProduct: 'AVIATOR' }, { signingKeyId: 'AVIATOR_V1' }, { machineId: 'WVPT-PC-9999-9999-9999-9999' }, { expiresAt: EXPIRES + 999999 }]) {
    const tampered = { ...p, ...mut };
    const forged = `${prefix}.${base64url(canonicalJson(tampered))}.${sig}`;
    const r = verify(forged, 'PHOM');
    assert.equal(r.active, false, `tamper ${JSON.stringify(mut)} must fail`);
    assert.ok(['LICENSE_BAD_SIGNATURE', 'LICENSE_SIGNING_KEY_PRODUCT_MISMATCH', 'LICENSE_MACHINE_MISMATCH'].includes(r.error.code));
  }
});

test('legacy key (no gameProduct, no signingKeyId) verifies with the Aviator key only', () => {
  // A legacy Aviator payload (v1, no entitlement fields) signed with the Aviator key.
  const legacy = { v: 1, product: 'WVPT', machineId: MACHINE, issuedAt: ISSUED, expiresAt: EXPIRES, licenseId: 'LIC-12345678' };
  const license = signWith(aviator.privateKey, legacy);
  assert.equal(verify(license, 'AVIATOR').active, true);
  assert.equal(verify(license, 'PHOM').error.code, 'LICENSE_PHOM_ENTITLEMENT_REQUIRED');
  // the same legacy payload signed with the PHOM key must NOT verify (wrong key for AVIATOR default).
  assert.equal(verify(signWith(phom.privateKey, legacy), 'AVIATOR').error.code, 'LICENSE_BAD_SIGNATURE');
});
