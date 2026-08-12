import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalJson } = require('../../desktop/licensing/canonical-json.cjs');
const { seal, unseal, install, SEALED_BASENAMES } = require('../../desktop/protocol/sealed-loader.cjs');
const { deriveFeatureKey } = require('../../desktop/licensing/feature-key.cjs');

// --- seal/unseal round trip -------------------------------------------------
test('seal/unseal returns the exact source and is authenticated', () => {
  const key = crypto.randomBytes(32);
  const src = 'module.exports = { hello: () => 123 };\n// unicode ✈ and bytes';
  const blob = seal(src, key);
  assert.ok(Buffer.isBuffer(blob));
  assert.notEqual(blob.toString('utf8'), src, 'ciphertext is not the plaintext');
  assert.equal(unseal(blob, key).toString('utf8'), src, 'round trips');
});

test('unseal rejects a wrong key and tampered ciphertext', () => {
  const key = crypto.randomBytes(32);
  const blob = seal('module.exports = 1;', key);
  assert.throws(() => unseal(blob, crypto.randomBytes(32)), 'wrong key fails the auth tag');
  const tampered = Buffer.from(blob); tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => unseal(tampered, key), 'a flipped byte fails the auth tag');
  assert.throws(() => unseal(Buffer.from('not sealed at all'), key), 'garbage is rejected');
});

// --- runtime loader: sealed module requiring a sealed sibling ---------------
test('install() decrypts sealed modules on require, resolving sealed siblings', () => {
  const key = crypto.randomBytes(32);
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-'));
  try {
    // b is required by a; both are sealed with NO plaintext .cjs on disk.
    const aAbs = path.join(dir, 'a.cjs');
    const bAbs = path.join(dir, 'b.cjs');
    writeFileSync(bAbs + '.enc', seal('module.exports = { val: 42 };', key));
    writeFileSync(aAbs + '.enc', seal("const b = require('./b.cjs'); module.exports = { total: b.val + 1 };", key));
    install({ key, files: [aAbs, bAbs] });
    const a = require(aAbs);
    assert.equal(a.total, 43, 'sealed a decrypted and pulled sealed b through the hook');
    assert.equal(require(aAbs).total, 43, 'second require is served from cache');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sealed set covers the crown-jewel protocol modules', () => {
  assert.deepEqual([...SEALED_BASENAMES].sort(), ['amount-validator', 'auto-runner', 'aviator', 'harness', 'protocol-context', 'round-observer']);
});

// --- feature key is released only for a genuine, machine-matched license ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const MACHINE = 'WVPT-PC-1111-2222-3333-4444';

function makeLicense(overrides = {}, signer = privateKey) {
  const payload = { v: 1, product: 'WVPT', machineId: MACHINE, licenseId: 'LIC-DEADBEEF', issuedAt: 1000, expiresAt: 9999999999, ...overrides };
  const canonical = canonicalJson(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), signer);
  return `WVPT1.${Buffer.from(canonical, 'utf8').toString('base64url')}.${sig.toString('base64url')}`;
}

test('deriveFeatureKey returns a 32-byte key for a valid, machine-matched license', () => {
  const key = deriveFeatureKey({ license: makeLicense(), machineId: MACHINE, publicKeyPem });
  assert.ok(Buffer.isBuffer(key) && key.length === 32);
  // Deterministic: build and runtime must derive the same key.
  const again = deriveFeatureKey({ license: makeLicense({ licenseId: 'LIC-0000FFFF' }), machineId: MACHINE, publicKeyPem });
  assert.ok(again.equals(key), 'key depends on the pepper+public key, not per-license fields');
});

test('deriveFeatureKey refuses wrong machine, wrong product, tamper, and wrong signer', () => {
  assert.equal(deriveFeatureKey({ license: makeLicense(), machineId: 'WVPT-PC-9999-9999-9999-9999', publicKeyPem }), null, 'machine mismatch');
  assert.equal(deriveFeatureKey({ license: makeLicense({ product: 'OTHER' }), machineId: MACHINE, publicKeyPem }), null, 'wrong product');
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(deriveFeatureKey({ license: makeLicense({}, other), machineId: MACHINE, publicKeyPem }), null, 'signed by an attacker key');
  const lic = makeLicense();
  const parts = lic.split('.');
  const raw = Buffer.from(parts[1], 'base64url'); raw[raw.length - 2] ^= 0x01;
  const tampered = `${parts[0]}.${raw.toString('base64url')}.${parts[2]}`;
  assert.equal(deriveFeatureKey({ license: tampered, machineId: MACHINE, publicKeyPem }), null, 'payload tamper breaks verification');
  assert.equal(deriveFeatureKey({ license: '', machineId: MACHINE, publicKeyPem }), null, 'empty license');
});
