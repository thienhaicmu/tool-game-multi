'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Pinned custom Chromium runtime resolution + validation (§4/§6). The Phỏm QA app
// launches a project-owned Chromium build (v149.0.7827.55) — NEVER the system
// Chrome. This module resolves the runtime root (dev vs packaged), validates the
// bundle is complete + the pinned version/arch, and checks the executable checksum
// before every launch. The binaries live OUTSIDE Git (runtime/phom-chromium/ is
// gitignored); a tracked runtime-manifest.json carries the version + checksums.
// ---------------------------------------------------------------------------

const EXPECTED_VERSION = '149.0.7827.55';
const ARCHITECTURE = 'x64';
const EXECUTABLE = 'chrome.exe';

// Files that MUST be present for the runtime to boot (derived from the bundle audit).
const REQUIRED_FILES = Object.freeze([
  'chrome.exe', 'chrome.dll', 'chrome_elf.dll',
  'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'v8_context_snapshot.bin', 'snapshot_blob.bin',
]);
const REQUIRED_DIRECTORIES = Object.freeze(['locales']);

function err(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }
function sha256(file) { return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

// Resolve the runtime ROOT. Dev: PHOM_CHROMIUM_PATH override, else the project's
// runtime/phom-chromium. Packaged: <resources>/phom-chromium. No system-Chrome fallback.
function resolveRuntimeRoot({ env = process.env, isPackaged = false, resourcesPath = null, projectRoot = null } = {}) {
  if (env.PHOM_CHROMIUM_PATH) return env.PHOM_CHROMIUM_PATH;
  if (isPackaged) {
    if (!resourcesPath) return null;
    return path.join(resourcesPath, 'phom-chromium');
  }
  const base = projectRoot || path.join(__dirname, '..', '..');
  return path.join(base, 'runtime', 'phom-chromium');
}

function executablePath(root) { return path.join(root, EXECUTABLE); }

// Read the tracked runtime-manifest.json if present, else fall back to the bundle's
// own package_manifest.json (chromium_version + chrome_exe_sha256).
function loadManifest(root) {
  const mine = path.join(root, 'runtime-manifest.json');
  if (fs.existsSync(mine)) { try { return JSON.parse(fs.readFileSync(mine, 'utf8')); } catch { /* fall through */ } }
  const pkg = path.join(root, 'package_manifest.json');
  if (fs.existsSync(pkg)) {
    try { const p = JSON.parse(fs.readFileSync(pkg, 'utf8')); return { chromiumVersion: p.chromium_version, checksums: { 'chrome.exe': p.chrome_exe_sha256 ? 'sha256:' + p.chrome_exe_sha256 : undefined } }; } catch { /* ignore */ }
  }
  return null;
}

// Validate a runtime bundle. `deep` also checksums chrome.dll (slow, 400MB).
function validateRuntime(root, { deep = false } = {}) {
  if (!root) return err('PHOM_CHROMIUM_NOT_CONFIGURED', 'No Chromium runtime path configured');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return err('PHOM_CHROMIUM_RUNTIME_NOT_FOUND', `Runtime root not found: ${root}`, { root });
  const exe = executablePath(root);
  if (!fs.existsSync(exe)) return err('PHOM_CHROMIUM_RUNTIME_NOT_FOUND', `Executable not found: ${exe}`, { root });
  for (const f of REQUIRED_FILES) if (!fs.existsSync(path.join(root, f))) return err('PHOM_CHROMIUM_RUNTIME_INCOMPLETE', `Missing required file: ${f}`, { root, missing: f });
  for (const d of REQUIRED_DIRECTORIES) { const p = path.join(root, d); if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return err('PHOM_CHROMIUM_RUNTIME_INCOMPLETE', `Missing required directory: ${d}`, { root, missing: d }); }

  const manifest = loadManifest(root);
  const version = (manifest && manifest.chromiumVersion) || null;
  if (version && version !== EXPECTED_VERSION) return err('PHOM_CHROMIUM_VERSION_MISMATCH', `Expected ${EXPECTED_VERSION}, found ${version}`, { root, expected: EXPECTED_VERSION, found: version });
  if (manifest && manifest.architecture && manifest.architecture !== ARCHITECTURE) return err('PHOM_CHROMIUM_ARCH_MISMATCH', `Expected ${ARCHITECTURE}, found ${manifest.architecture}`, { root });

  // Checksum the executable (fast). chrome.dll only in deep mode.
  const expected = (manifest && manifest.checksums) || {};
  if (expected['chrome.exe']) {
    const actual = sha256(exe);
    if (actual !== expected['chrome.exe']) return err('PHOM_CHROMIUM_CHECKSUM_MISMATCH', 'chrome.exe checksum mismatch', { root, file: 'chrome.exe' });
  }
  if (deep && expected['chrome.dll'] && fs.existsSync(path.join(root, 'chrome.dll'))) {
    const actual = sha256(path.join(root, 'chrome.dll'));
    if (actual !== expected['chrome.dll']) return err('PHOM_CHROMIUM_CHECKSUM_MISMATCH', 'chrome.dll checksum mismatch', { root, file: 'chrome.dll' });
  }
  return { ok: true, root, executable: exe, version: version || EXPECTED_VERSION, architecture: ARCHITECTURE, checksumVerified: !!expected['chrome.exe'] };
}

// Windows AppContainer SIDs the Chromium sandbox's restricted token needs to READ +
// EXECUTE the runtime. A standard Chrome install grants these; a copied runtime loses
// them, which is the REAL cause of "Sandbox cannot access executable … (0x5)".
const SID_ALL_APP_PACKAGES = '*S-1-15-2-1';            // ALL APPLICATION PACKAGES
const SID_ALL_RESTRICTED_APP_PACKAGES = '*S-1-15-2-2'; // ALL RESTRICTED APPLICATION PACKAGES

// Is the AppContainer read+execute grant already present on chrome.exe? (idempotency
// guard so we never re-run icacls once the runtime is prepared.)
function sandboxAccessPresent(root) {
  if (process.platform !== 'win32') return true; // sandbox-ACL is a Windows concern only
  const exe = executablePath(root);
  if (!fs.existsSync(exe)) return false;
  try {
    const res = spawnSync('icacls', [exe], { encoding: 'utf8', windowsHide: true });
    const out = (res && res.stdout) || '';
    return /APPLICATION PACKAGES/i.test(out) || /S-1-15-2-1/.test(out);
  } catch { return false; }
}

// Grant READ+EXECUTE (never Write/Full) to the AppContainer SIDs on the runtime dir so
// the Chromium sandbox works WITHOUT --no-sandbox. Idempotent, best-effort, Windows-only,
// scoped strictly to the project runtime directory. This is the sanctioned 0x5 fix — it
// does NOT run as admin, touch UAC, grant Everyone, or disable the sandbox.
function ensureSandboxAccess(root) {
  if (process.platform !== 'win32') return { ok: true, changed: false, reason: 'non-windows' };
  if (!root || !fs.existsSync(root)) return { ok: false, changed: false, reason: 'runtime-missing' };
  if (sandboxAccessPresent(root)) return { ok: true, changed: false, reason: 'already-granted' };
  try {
    const res = spawnSync('icacls', [root, '/grant', `${SID_ALL_APP_PACKAGES}:(OI)(CI)(RX)`, `${SID_ALL_RESTRICTED_APP_PACKAGES}:(OI)(CI)(RX)`, '/T', '/C', '/Q'],
      { encoding: 'utf8', windowsHide: true });
    const ok = res && res.status === 0;
    return { ok: !!ok, changed: !!ok, reason: ok ? 'granted' : 'icacls-failed' };
  } catch (e) { return { ok: false, changed: false, reason: 'icacls-threw' }; }
}

// Resolve + validate in one call — the launcher's entry point.
function resolveAndValidate(opts = {}) {
  const root = resolveRuntimeRoot(opts);
  return validateRuntime(root, opts);
}

// Generate a runtime-manifest.json for a prepared bundle (used by prepare:phom-chromium).
function generateManifest(root) {
  const exe = executablePath(root);
  if (!fs.existsSync(exe)) return err('PHOM_CHROMIUM_RUNTIME_NOT_FOUND', `Executable not found: ${exe}`, { root });
  const files = fs.readdirSync(root, { withFileTypes: true });
  const manifest = {
    runtimeVersion: EXPECTED_VERSION,
    chromiumVersion: EXPECTED_VERSION,
    architecture: ARCHITECTURE,
    executable: EXECUTABLE,
    generatedAt: new Date().toISOString(),
    fileCount: files.filter((d) => d.isFile()).length,
    requiredFiles: [...REQUIRED_FILES],
    requiredDirectories: [...REQUIRED_DIRECTORIES],
    checksums: {
      'chrome.exe': sha256(exe),
      'chrome.dll': fs.existsSync(path.join(root, 'chrome.dll')) ? sha256(path.join(root, 'chrome.dll')) : undefined,
    },
  };
  return { ok: true, manifest };
}

module.exports = {
  EXPECTED_VERSION, ARCHITECTURE, EXECUTABLE, REQUIRED_FILES, REQUIRED_DIRECTORIES,
  resolveRuntimeRoot, executablePath, loadManifest, validateRuntime, resolveAndValidate, generateManifest,
  sandboxAccessPresent, ensureSandboxAccess, SID_ALL_APP_PACKAGES, SID_ALL_RESTRICTED_APP_PACKAGES,
};
