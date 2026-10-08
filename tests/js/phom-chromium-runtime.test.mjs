import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rt = require('../../desktop/browser/phom-chromium-runtime.cjs');

const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

// Build a minimal FAKE runtime bundle in a temp dir (no real Chromium needed for the
// validation logic tests). content lets us control the executable checksum.
function makeBundle({ omit = [], omitDir = [], version = rt.EXPECTED_VERSION, arch = 'x64', exeContent = 'EXE', withDllChecksum = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-rt-'));
  for (const f of rt.REQUIRED_FILES) if (!omit.includes(f)) fs.writeFileSync(path.join(dir, f), f === 'chrome.exe' ? exeContent : f);
  for (const d of rt.REQUIRED_DIRECTORIES) if (!omitDir.includes(d)) { fs.mkdirSync(path.join(dir, d)); fs.writeFileSync(path.join(dir, d, 'en-US.pak'), 'x'); }
  const checksums = { 'chrome.exe': sha256(Buffer.from(exeContent)) };
  if (withDllChecksum && !omit.includes('chrome.dll')) checksums['chrome.dll'] = sha256(Buffer.from('chrome.dll'));
  fs.writeFileSync(path.join(dir, 'runtime-manifest.json'), JSON.stringify({ chromiumVersion: version, architecture: arch, checksums }));
  return dir;
}

// §17.A — complete runtime validates.
test('complete runtime validates (version + arch + checksum)', () => {
  const dir = makeBundle();
  const v = rt.validateRuntime(dir);
  assert.equal(v.ok, true);
  assert.equal(v.version, rt.EXPECTED_VERSION);
  assert.equal(v.checksumVerified, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing chrome.exe / chrome.dll / required dir fail typed', () => {
  let d = makeBundle({ omit: ['chrome.exe'] });
  assert.equal(rt.validateRuntime(d).error.code, 'PHOM_CHROMIUM_RUNTIME_NOT_FOUND'); fs.rmSync(d, { recursive: true, force: true });
  d = makeBundle({ omit: ['chrome.dll'] });
  assert.equal(rt.validateRuntime(d).error.code, 'PHOM_CHROMIUM_RUNTIME_INCOMPLETE'); fs.rmSync(d, { recursive: true, force: true });
  d = makeBundle({ omitDir: ['locales'] });
  assert.equal(rt.validateRuntime(d).error.code, 'PHOM_CHROMIUM_RUNTIME_INCOMPLETE'); fs.rmSync(d, { recursive: true, force: true });
});

test('version + arch + checksum mismatch fail typed', () => {
  let d = makeBundle({ version: '148.0.0.0' });
  assert.equal(rt.validateRuntime(d).error.code, 'PHOM_CHROMIUM_VERSION_MISMATCH'); fs.rmSync(d, { recursive: true, force: true });
  d = makeBundle({ arch: 'arm64' });
  assert.equal(rt.validateRuntime(d).error.code, 'PHOM_CHROMIUM_ARCH_MISMATCH'); fs.rmSync(d, { recursive: true, force: true });
  // tamper the executable after the manifest is written -> checksum mismatch
  d = makeBundle();
  fs.writeFileSync(path.join(d, 'chrome.exe'), 'TAMPERED');
  assert.equal(rt.validateRuntime(d).error.code, 'PHOM_CHROMIUM_CHECKSUM_MISMATCH'); fs.rmSync(d, { recursive: true, force: true });
});

test('no path configured / missing root fail typed', () => {
  assert.equal(rt.validateRuntime(null).error.code, 'PHOM_CHROMIUM_NOT_CONFIGURED');
  assert.equal(rt.validateRuntime(path.join(os.tmpdir(), 'nope-' + Date.now())).error.code, 'PHOM_CHROMIUM_RUNTIME_NOT_FOUND');
});

// §6 — resolution: dev override, project dir, packaged resources; no system fallback.
test('resolveRuntimeRoot honors override / project / packaged; never system Chrome', () => {
  assert.equal(rt.resolveRuntimeRoot({ env: { PHOM_CHROMIUM_PATH: 'X:/rt' } }), 'X:/rt');
  assert.match(rt.resolveRuntimeRoot({ env: {}, isPackaged: false, projectRoot: 'P' }), /runtime[\\/]phom-chromium$/);
  assert.match(rt.resolveRuntimeRoot({ env: {}, isPackaged: true, resourcesPath: 'R' }), /phom-chromium$/);
  assert.equal(rt.resolveRuntimeRoot({ env: {}, isPackaged: true, resourcesPath: null }), null);
});

// The REAL prepared runtime (if present) validates end-to-end.
test('the prepared project runtime validates (skipped if not prepared)', (t) => {
  const root = rt.resolveRuntimeRoot({ env: {}, isPackaged: false });
  if (!fs.existsSync(path.join(root, 'chrome.exe'))) return t.skip('runtime/phom-chromium not prepared on this machine');
  const v = rt.validateRuntime(root);
  assert.equal(v.ok, true, v.ok ? '' : `${v.error && v.error.code}`);
  assert.equal(v.version, '149.0.7827.55');
});
