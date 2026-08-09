import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMachineId } = require('../../desktop/licensing/machine-id.cjs');
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');
const { verifyLicense, parseLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { LicenseGuard } = require('../../desktop/licensing/license-guard.cjs');
const { LicenseStore } = require('../../desktop/licensing/license-store.cjs');

const keypair = generateKeyPairSync('ed25519');
const privateKeyPem = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
const MACHINE_A = 'WVPT-PC-AAAA-BBBB-CCCC-DDDD';
const MACHINE_B = 'WVPT-PC-1111-2222-3333-4444';

function licenseFor(over = {}) {
  const payload = {
    v: 1,
    product: 'WVPT',
    machineId: MACHINE_A,
    issuedAt: 1786233600,
    expiresAt: 1791417600,
    licenseId: 'LIC-' + randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
    ...over,
  };
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
  return { payload, license: `WVPT1.${base64url(canonical)}.${base64url(signature)}` };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'wvpt-license-'));
  return new LicenseStore({ licensePath: join(dir, 'license.dat'), statePath: join(dir, 'license-state.dat') });
}

test('machine id is stable and deterministic across restarts', () => {
  const parts = { machineGuid: ' abc ', uuid: ' 1234-ABCD ', volume: ' aa bb ' };
  const a = buildMachineId(parts);
  const b = buildMachineId(parts);
  assert.equal(a.ok, true);
  assert.equal(a.machineId, b.machineId);
  assert.match(a.machineId, /^WVPT-PC-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(a.canonical, 'WVPT|MACHINEGUID=ABC|UUID=1234-ABCD|VOLUME=AABB');
});

test('machine id uses deterministic fallback and reports unavailable when empty', () => {
  assert.equal(buildMachineId({ machineGuid: 'abc', uuid: '', volume: '' }).ok, true);
  const missing = buildMachineId({ machineGuid: '', uuid: '', volume: '' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'MACHINE_ID_UNAVAILABLE');
});

test('valid signed license verifies on matching machine', () => {
  const { license, payload } = licenseFor();
  const result = verifyLicense(license, { machineId: MACHINE_A, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, payload);
});

test('key sharing to another machine is locked with LICENSE_MACHINE_MISMATCH', () => {
  const { license } = licenseFor();
  const result = verifyLicense(license, { machineId: MACHINE_B, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LICENSE_MACHINE_MISMATCH');
  assert.equal(result.error.licenseMachineId, MACHINE_A);
});

test('expired license is rejected', () => {
  const { license } = licenseFor({ expiresAt: 1787000000 });
  const result = verifyLicense(license, { machineId: MACHINE_A, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.error.code, 'LICENSE_EXPIRED');
});

test('modified expiry fails signature validation', () => {
  const { license } = licenseFor({ expiresAt: 1791417600 });
  const parsed = parseLicense(license);
  parsed.payload.expiresAt = 4070908800;
  const tampered = `WVPT1.${base64url(canonicalJson(parsed.payload))}.${license.split('.')[2]}`;
  const result = verifyLicense(tampered, { machineId: MACHINE_A, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.error.code, 'LICENSE_BAD_SIGNATURE');
});

test('modified machine id fails signature validation before mismatch semantics', () => {
  const { license } = licenseFor();
  const parsed = parseLicense(license);
  parsed.payload.machineId = MACHINE_B;
  const tampered = `WVPT1.${base64url(canonicalJson(parsed.payload))}.${license.split('.')[2]}`;
  const result = verifyLicense(tampered, { machineId: MACHINE_B, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.error.code, 'LICENSE_BAD_SIGNATURE');
});

test('random license returns LICENSE_INVALID_FORMAT without crashing', () => {
  const result = verifyLicense('random string', { machineId: MACHINE_A, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.error.code, 'LICENSE_INVALID_FORMAT');
});

test('generator round trip signs custom expiry exactly', () => {
  const proc = spawnSync(process.execPath, ['tools/license-generator/generate-license.mjs', '--machine-id', MACHINE_A, '--expires', '2099-12-31'], {
    cwd: process.cwd(),
    env: { ...process.env, WVPT_PRIVATE_KEY: privateKeyPem },
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr);
  const license = proc.stdout.trim().split(/\r?\n/).at(-1);
  const result = verifyLicense(license, { machineId: MACHINE_A, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.ok, true);
  assert.equal(result.payload.expiresAt, Date.parse('2099-12-31T00:00:00.000Z') / 1000);
});

test('clock rollback is detected from protected last-seen state', () => {
  const store = tempStore();
  const { license } = licenseFor({ issuedAt: 1700000000, expiresAt: 1800000000 });
  const machineIdProvider = () => ({ ok: true, machineId: MACHINE_A });
  const guardA = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => Date.parse('2026-09-20T00:00:00Z') });
  guardA.initialize();
  assert.equal(guardA.activate(license).active, true);
  const guardB = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => Date.parse('2026-08-01T00:00:00Z') });
  const status = guardB.initialize();
  assert.equal(status.error.code, 'LICENSE_CLOCK_ROLLBACK');
});

test('renewal replaces an expired license with a valid license for the same machine', () => {
  const store = tempStore();
  const machineIdProvider = () => ({ ok: true, machineId: MACHINE_A });
  const oldLicense = licenseFor({ expiresAt: 1787000000 }).license;
  const newLicense = licenseFor({ expiresAt: 1800000000 }).license;
  const guard = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000000000 });
  guard.initialize();
  assert.equal(guard.activate(oldLicense).error.code, 'LICENSE_EXPIRED');
  assert.equal(guard.activate(newLicense).active, true);
  assert.equal(store.loadLicense(), newLicense);
});

test('launch quota increments on startup and locks after maxLaunches', () => {
  const store = tempStore();
  const machineIdProvider = () => ({ ok: true, machineId: MACHINE_A });
  const limited = licenseFor({ maxLaunches: 2 }).license;
  const activator = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000000000 });
  activator.initialize();
  assert.equal(activator.activate(limited).active, true);

  const firstRun = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000001000 });
  assert.equal(firstRun.initialize().launch.used, 1);
  const secondRun = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000002000 });
  assert.equal(secondRun.initialize().launch.used, 2);
  const thirdRun = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000003000 });
  const locked = thirdRun.initialize();
  assert.equal(locked.error.code, 'LICENSE_LAUNCH_LIMIT_REACHED');
  assert.equal(locked.error.usedLaunches, 2);
  assert.equal(locked.error.maxLaunches, 2);
});

test('renewal with a new license resets launch quota for the new license fingerprint', () => {
  const store = tempStore();
  const machineIdProvider = () => ({ ok: true, machineId: MACHINE_A });
  const oldLicense = licenseFor({ maxLaunches: 1, licenseId: 'LIC-AAAA1111' }).license;
  const newLicense = licenseFor({ maxLaunches: 3, licenseId: 'LIC-BBBB2222' }).license;
  const guard = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000000000 });
  guard.initialize();
  guard.activate(oldLicense);
  new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000001000 }).initialize();
  assert.equal(new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000002000 }).initialize().error.code, 'LICENSE_LAUNCH_LIMIT_REACHED');

  const renew = new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000003000 });
  renew.initialize();
  assert.equal(renew.activate(newLicense).active, true);
  assert.equal(new LicenseGuard({ store, machineIdProvider, publicKeyPem, nowMs: () => 1789000004000 }).initialize().launch.used, 1);
});

test('main-process product engine IPC handlers require active license', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  for (const channel of ['open-browser', 'protocol-execute', 'autotest-start', 'bvalidate-start', 'replay-execute', 'ws-send', 'intercept-enable', 'cdp-connect']) {
    const idx = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(idx >= 0, `${channel} exists`);
    assert.ok(main.slice(idx, idx + 260).includes('requireLicense()'), `${channel} is guarded`);
  }
});

test('package audit excludes generator and private signing material from customer app', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.build.files, ['desktop/**/*', 'ui/**/*', 'package.json']);
  assert.ok(!JSON.stringify(pkg.build.files).includes('tools/license-generator'));
  const roots = ['desktop', 'ui'];
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(new URL('../../' + dir, import.meta.url))) {
      const rel = `${dir}/${name}`;
      const full = new URL('../../' + rel, import.meta.url);
      if (statSync(full).isDirectory()) walk(rel);
      else files.push(full);
    }
  }
  roots.forEach(walk);
  const bundleText = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.ok(!bundleText.includes('BEGIN PRIVATE KEY'));
  assert.ok(!bundleText.includes('createSignedLicense'));
  assert.ok(bundleText.includes('BEGIN PUBLIC KEY'));
});
