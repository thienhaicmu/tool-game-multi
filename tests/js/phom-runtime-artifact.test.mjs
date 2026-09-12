import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const art = require('../../desktop/browser/phom-runtime-artifact.cjs');

const sha = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
function tmpFile(content) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-art-')); const p = path.join(d, 'a.zip'); fs.writeFileSync(p, content); return { d, p }; }

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1, runtimeId: 'phom-chromium', chromiumVersion: '149.0.7827.55',
    platform: 'win32', architecture: 'x64', archiveName: 'phom-chromium-149.0.7827.55-win-x64.zip',
    archiveSha256: 'sha256:' + 'a'.repeat(64), archiveSize: 100, executableRelativePath: 'chrome.exe',
    requiredFiles: [], requiredDirectories: [], fileChecksums: {}, download: { provider: 'NOT_CONFIGURED', url: null },
    ...overrides,
  };
}

// §16.A — manifest validation.
test('valid manifest passes; NOT_CONFIGURED is reported', () => {
  const r = art.validateArtifactManifest(validManifest(), { platform: 'win32', arch: 'x64' });
  assert.equal(r.ok, true);
  assert.equal(r.configured, false);
  assert.equal(r.provider, 'NOT_CONFIGURED');
});
test('wrong platform / arch / bad name / missing checksum reject', () => {
  assert.equal(art.validateArtifactManifest(validManifest(), { platform: 'linux', arch: 'x64' }).error.code, 'PHOM_RUNTIME_PLATFORM_MISMATCH');
  assert.equal(art.validateArtifactManifest(validManifest(), { platform: 'win32', arch: 'arm64' }).error.code, 'PHOM_RUNTIME_ARCH_MISMATCH');
  assert.equal(art.validateArtifactManifest(validManifest({ archiveName: 'evil.zip' }), { platform: 'win32', arch: 'x64' }).error.code, 'PHOM_RUNTIME_MANIFEST_INVALID');
  assert.equal(art.validateArtifactManifest(validManifest({ archiveSha256: null }), { platform: 'win32', arch: 'x64' }).error.code, 'PHOM_RUNTIME_MANIFEST_INVALID');
  assert.equal(art.validateArtifactManifest(validManifest({ schemaVersion: 99 }), { platform: 'win32', arch: 'x64' }).error.code, 'PHOM_RUNTIME_MANIFEST_INVALID');
});
test('configured provider with URL is reported configured', () => {
  const r = art.validateArtifactManifest(validManifest({ download: { provider: 'https', url: 'https://cdn.example/rt.zip' } }), { platform: 'win32', arch: 'x64' });
  assert.equal(r.configured, true);
});

// §16.B — archive checksum + size + entry safety + forbidden scan.
test('verifyArchive: checksum match / mismatch / too-large / not-found', () => {
  const { d, p } = tmpFile(Buffer.from('hello-archive'));
  assert.equal(art.verifyArchive(p, sha(Buffer.from('hello-archive'))).ok, true);
  assert.equal(art.verifyArchive(p, 'sha256:' + 'b'.repeat(64)).error.code, 'PHOM_RUNTIME_ARCHIVE_CHECKSUM_MISMATCH');
  assert.equal(art.verifyArchive(p, sha(Buffer.from('hello-archive')), { maxBytes: 2 }).error.code, 'PHOM_RUNTIME_ARCHIVE_TOO_LARGE');
  assert.equal(art.verifyArchive(path.join(d, 'nope.zip'), 'sha256:x').error.code, 'PHOM_RUNTIME_ARCHIVE_NOT_FOUND');
  fs.rmSync(d, { recursive: true, force: true });
});
test('assertSafeEntries rejects zip-slip / absolute paths', () => {
  assert.equal(art.assertSafeEntries(['chrome.exe', 'locales/en-US.pak']).ok, true);
  assert.equal(art.assertSafeEntries(['../escape.exe']).error.code, 'PHOM_RUNTIME_EXTRACT_FAILED');
  assert.equal(art.assertSafeEntries(['a/../../b']).error.code, 'PHOM_RUNTIME_EXTRACT_FAILED');
  assert.equal(art.assertSafeEntries(['C:/windows/system32/x.dll']).error.code, 'PHOM_RUNTIME_EXTRACT_FAILED');
  assert.equal(art.assertSafeEntries(['/etc/passwd']).error.code, 'PHOM_RUNTIME_EXTRACT_FAILED');
});
test('scanForbidden flags a user-data/cookie/credential file', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-scan-'));
  fs.writeFileSync(path.join(d, 'chrome.exe'), 'x');
  fs.mkdirSync(path.join(d, 'Default'));
  fs.writeFileSync(path.join(d, 'Cookies'), 'x');
  const hits = art.scanForbidden(d);
  assert.ok(hits.some((h) => h.endsWith('Cookies')));
  assert.ok(hits.some((h) => h.endsWith('Default')));
  assert.equal(art.scanForbidden(path.join(d, 'nope')).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

// §16.C — atomic install.
test('atomicInstall: success replaces, failure preserves previous runtime', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-inst-'));
  const runtime = path.join(base, 'runtime');
  fs.mkdirSync(runtime); fs.writeFileSync(path.join(runtime, 'OLD'), 'old');
  // success
  const ex1 = path.join(base, 'ex1'); fs.mkdirSync(ex1); fs.writeFileSync(path.join(ex1, 'NEW'), 'new');
  assert.equal(art.atomicInstall(ex1, runtime).ok, true);
  assert.ok(fs.existsSync(path.join(runtime, 'NEW')));
  assert.ok(!fs.existsSync(path.join(runtime, 'OLD')));
  // failure (source does not exist) preserves current runtime
  const before = fs.readdirSync(runtime);
  const r = art.atomicInstall(path.join(base, 'does-not-exist'), runtime);
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(runtime), before, 'previous runtime preserved on failure');
  fs.rmSync(base, { recursive: true, force: true });
});

// §16.D — providers.
test('LocalArchiveProvider resolves + copies; missing archive rejects', async () => {
  const { d, p } = tmpFile(Buffer.from('zipdata'));
  const prov = new art.LocalArchiveProvider({ archivePath: p });
  assert.equal(prov.resolve().kind, 'local');
  const dest = path.join(d, 'out.zip');
  assert.equal((await prov.download(prov.resolve(), dest)).ok, true);
  assert.ok(fs.existsSync(dest));
  const missing = new art.LocalArchiveProvider({ archivePath: path.join(d, 'nope.zip') });
  assert.equal((await missing.download({}, path.join(d, 'x'))).error.code, 'PHOM_RUNTIME_ARCHIVE_NOT_FOUND');
  fs.rmSync(d, { recursive: true, force: true });
});
test('HttpsArtifactProvider enforces https + allowlist + no cross-host redirect', () => {
  const prov = new art.HttpsArtifactProvider({ allowlist: ['cdn.example'] });
  assert.equal(prov.resolve(validManifest()).error.code, 'PHOM_RUNTIME_SOURCE_NOT_CONFIGURED');
  assert.equal(prov.resolve(validManifest({ download: { provider: 'https', url: 'http://cdn.example/x.zip' } })).error.code, 'PHOM_RUNTIME_DOWNLOAD_NOT_ALLOWLISTED');
  assert.equal(prov.resolve(validManifest({ download: { provider: 'https', url: 'https://evil.test/x.zip' } })).error.code, 'PHOM_RUNTIME_DOWNLOAD_NOT_ALLOWLISTED');
  assert.equal(prov.resolve(validManifest({ download: { provider: 'https', url: 'https://cdn.example/x.zip' } })).kind, 'https');
});

// The real tracked manifest (if present) validates on this host.
test('the tracked artifact manifest validates on win32-x64 (skipped elsewhere)', (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('non win32-x64 host');
  const dir = new URL('../../runtime-manifests/', import.meta.url);
  let file; try { file = fs.readdirSync(dir).find((f) => f.endsWith('.json')); } catch { return t.skip('no runtime-manifests dir'); }
  if (!file) return t.skip('no tracked manifest');
  const m = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'));
  const r = art.validateArtifactManifest(m, { platform: 'win32', arch: 'x64' });
  assert.equal(r.ok, true);
  assert.equal(m.chromiumVersion, '149.0.7827.55');
  assert.match(m.archiveSha256, /^sha256:[0-9a-f]{64}$/);
});
