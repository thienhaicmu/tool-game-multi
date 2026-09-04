import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { normalizeEntitlement } = require('../../desktop/licensing/entitlements.cjs');

const script = fileURLToPath(new URL('../../tools/license-generator/generate-license.mjs', import.meta.url));
const MACHINE = 'WVPT-PC-AB12-CD34-EF56-7890';
const NOW_MS = 1_700_000_000_000; // fixed trusted time

// A throwaway signing keypair for the CLI to use.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

function runGen(args) {
  const env = { ...process.env, WVPT_PRIVATE_KEY: privateKeyPem, WVPT_TRUSTED_TIME_MS: String(NOW_MS) };
  const out = execFileSync(process.execPath, [script, '--machine-id', MACHINE, ...args], { env, encoding: 'utf8' });
  const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith('WVPT1.')).pop();
  assert.ok(line, 'generator emitted a WVPT1 key');
  return line;
}

test('CLI generates a signed v2 STANDARD key the verifier accepts and normalizes', () => {
  const license = runGen(['--plan', 'STANDARD', '--duration', '30', '--no-jackpot-gate']);
  const res = verifyLicense(license, { machineId: MACHINE, nowMs: NOW_MS + 1000, publicKeyPem });
  assert.equal(res.active, true);
  const ent = normalizeEntitlement(res.payload);
  assert.equal(ent.schemaVersion, 2);
  assert.equal(ent.plan, 'STANDARD');
  assert.equal(ent.maxBrowsers, 5);
  assert.equal(ent.maxConcurrentBrowsers, 2);
  assert.equal(ent.features.jackpotGate, false, '--no-jackpot-gate honored');
  assert.equal(ent.features.autoRun, true);
});

test('CLI applies PRO preset and explicit capacity override', () => {
  const license = runGen(['--plan', 'PRO', '--duration', '60', '--max-browsers', '30', '--max-concurrent', '4']);
  const ent = normalizeEntitlement(verifyLicense(license, { machineId: MACHINE, nowMs: NOW_MS + 1000, publicKeyPem }).payload);
  assert.equal(ent.plan, 'PRO');
  assert.equal(ent.maxBrowsers, 30);
  assert.equal(ent.maxConcurrentBrowsers, 4);
  assert.deepEqual(ent.features, { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true });
});

test('CLI refuses to sign an invalid feature dependency', () => {
  let threw = false;
  try { runGen(['--plan', 'PRO', '--duration', '30', '--no-jackpot-live']); } // gate stays on from preset -> dependency error
  catch { threw = true; }
  assert.equal(threw, true, 'jackpotGate-without-live is rejected before signing');
});

test('CLI --schema 1 still produces a valid legacy key', () => {
  const license = runGen(['--schema', '1', '--duration', '30']);
  const res = verifyLicense(license, { machineId: MACHINE, nowMs: NOW_MS + 1000, publicKeyPem });
  assert.equal(res.active, true);
  assert.equal(res.payload.v, 1);
  assert.equal(normalizeEntitlement(res.payload).legacy, true);
});
