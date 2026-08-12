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
const { TrustedTimeProvider, utcPlus7Date } = require('../../desktop/licensing/trusted-time.cjs');

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

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buf) => String(buf).replace(/^enc:/, ''),
  };
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

test('verifier requires trusted time from caller and never falls back to local clock', () => {
  const { license } = licenseFor();
  const result = verifyLicense(license, { machineId: MACHINE_A, publicKeyPem });
  assert.equal(result.error.code, 'TRUSTED_TIME_UNAVAILABLE');
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
    env: { ...process.env, WVPT_PRIVATE_KEY: privateKeyPem, WVPT_TRUSTED_TIME_MS: '1789000000000' },
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr);
  const license = proc.stdout.trim().split(/\r?\n/).at(-1);
  const result = verifyLicense(license, { machineId: MACHINE_A, publicKeyPem, nowMs: 1789000000000 });
  assert.equal(result.ok, true);
  assert.equal(result.payload.expiresAt, Date.parse('2099-12-31T00:00:00.000+07:00') / 1000);
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

test('license store can read saved license when safeStorage is unavailable later', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wvpt-license-fallback-'));
  const licensePath = join(dir, 'license.dat');
  const statePath = join(dir, 'license-state.dat');
  const protectedStore = new LicenseStore({ licensePath, statePath, safeStorage: fakeSafeStorage() });
  protectedStore.saveLicense('WVPT1.example.signature');
  const portableStore = new LicenseStore({ licensePath, statePath, safeStorage: null });
  assert.equal(portableStore.loadLicense(), 'WVPT1.example.signature');
});

test('trusted time provider uses HTTPS Date header and formats UTC+7 dates', async () => {
  const provider = new TrustedTimeProvider({
    urls: ['https://time.test'],
    fetchDateHeader: async () => ({ ok: true, nowMs: Date.parse('2026-08-09T17:30:00Z'), source: 'https://time.test' }),
  });
  const first = await provider.now();
  assert.equal(first.ok, true);
  assert.equal(first.source, 'https://time.test');
  assert.equal(utcPlus7Date(Date.parse('2026-08-09T17:30:00Z') / 1000), '2026-08-10');
  assert.ok(provider.cachedNowMs() >= first.nowMs);
});

test('async license guard verifies expiry against trusted time instead of local clock', async () => {
  const store = tempStore();
  const machineIdProvider = () => ({ ok: true, machineId: MACHINE_A });
  const expiredByTrustedTime = licenseFor({ issuedAt: 1700000000, expiresAt: 1787000000 }).license;
  const provider = new TrustedTimeProvider({
    urls: ['https://time.test'],
    fetchDateHeader: async () => ({ ok: true, nowMs: 1789000000000, source: 'https://time.test' }),
  });
  const guard = new LicenseGuard({ store, machineIdProvider, publicKeyPem, trustedTimeProvider: provider });
  assert.equal(guard.initialize().checking, true);
  await guard.initializeAsync();
  const status = await guard.activateAsync(expiredByTrustedTime);
  assert.equal(status.error.code, 'LICENSE_EXPIRED');
});

test('async license guard fails closed when trusted UTC+7 time is unavailable', async () => {
  const store = tempStore();
  const machineIdProvider = () => ({ ok: true, machineId: MACHINE_A });
  const validLicense = licenseFor({ issuedAt: 1700000000, expiresAt: 1800000000 }).license;
  const provider = new TrustedTimeProvider({
    urls: ['https://time.test'],
    fetchDateHeader: async () => ({ ok: false, error: 'offline', source: 'https://time.test' }),
  });
  const guard = new LicenseGuard({ store, machineIdProvider, publicKeyPem, trustedTimeProvider: provider });
  guard.initialize();
  const status = await guard.activateAsync(validLicense);
  assert.equal(status.error.code, 'TRUSTED_TIME_UNAVAILABLE');
  assert.equal(store.loadLicense(), null);
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

test('capability IPC is gated in the main process, backing the CSS lock', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../ui/product.css', import.meta.url), 'utf8');
  // Defense in depth: the renderer still hides locked UI...
  assert.ok(/body\[data-license=locked\][\s\S]*#shell/.test(css), 'locked license hides the app shell');
  // ...but the real gate lives in main: a handle() wrapper that fails closed when
  // the license is not active, so flipping the renderer flag cannot unlock features.
  assert.ok(/function handle\(channel, fn\)/.test(main), 'main defines a license-gating handle() wrapper');
  assert.ok(main.includes("code: 'LICENSE_REQUIRED'"), 'gated calls are refused with LICENSE_REQUIRED');
  assert.ok(/if \(!licenseActive\(\)\) return/.test(main), 'gate denies when the license is not active');
  // Every capability channel must be registered through the gate, never raw.
  for (const channel of ['open-browser', 'protocol-execute', 'autotest-start', 'bvalidate-start', 'replay-execute', 'ws-send', 'intercept-enable', 'cdp-connect']) {
    assert.ok(main.includes(`handle('${channel}'`), `${channel} is registered`);
    assert.ok(!main.includes(`ipcMain.handle('${channel}'`), `${channel} is not registered raw (must go through the gate)`);
  }
  // Only the activation-screen channels stay open while locked.
  const openLine = main.match(/const LICENSE_OPEN_CHANNELS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(openLine, 'an explicit open-channel allowlist exists');
  for (const channel of ['license-status', 'license-activate']) assert.ok(openLine[1].includes(`'${channel}'`), `${channel} stays open`);
  for (const channel of ['cdp-connect', 'protocol-execute', 'autotest-start']) assert.ok(!openLine[1].includes(`'${channel}'`), `${channel} is not exempt`);
});

test('main process stores license outside ephemeral instance appData', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(main.includes("const baseUserDataPath = app.getPath('userData');"), 'captures stable app userData before instance override');
  assert.ok(main.includes('new InstanceManager({ baseUserDataPath'), 'instances still use the shared app root');
  assert.ok(main.includes('new LicenseGuard({ userDataPath: baseUserDataPath'), 'license store is shared across app restarts');
  assert.ok(main.includes('function migrateLegacyInstanceLicense()'), 'old per-instance activations are migrated');
  assert.ok(main.includes("path.join(baseUserDataPath, 'instances')"), 'migration scans legacy instance appData folders');
  assert.ok(main.includes("app.setPath('userData', appInstance.paths.appData)"), 'runtime instance data remains isolated');
});

test('protocol websocket send falls back when captured host does not exactly match runtime socket url', () => {
  const src = readFileSync(new URL('../../desktop/cdp/ws-replay.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(main.includes('wsReplay.sendProtocol(ctx, payload)'), 'protocol harness uses the reliable send path');
  assert.ok(src.includes("window.__wsoSendFrame('',"), 'protocol send retries any open websocket in the bound frame/session');
  assert.ok(src.includes('window.__wsoSocketCount'), 'hook exposes socket diagnostics');
});

test('package audit excludes generator and private signing material from customer app', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.build.files, [
    'desktop/**/*',
    '!desktop/protocol/aviator.cjs',
    '!desktop/protocol/harness.cjs',
    '!desktop/protocol/auto-runner.cjs',
    '!desktop/protocol/amount-validator.cjs',
    '!desktop/protocol/round-observer.cjs',
    '!desktop/protocol/protocol-context.cjs',
    'ui/**/*',
    'package.json',
  ]);
  assert.ok(!JSON.stringify(pkg.build.files).includes('tools/license-generator'));
  // Tier 2: the crown-jewel protocol plaintext is excluded; only sealed .enc ships.
  for (const name of ['aviator', 'harness', 'auto-runner', 'amount-validator', 'round-observer', 'protocol-context']) {
    assert.ok(pkg.build.files.includes(`!desktop/protocol/${name}.cjs`), `${name}.cjs plaintext is excluded from the package`);
  }
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
