'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

// ---------------------------------------------------------------------------
// Versioned Chromium runtime ARTIFACT distribution (§5–10). Instead of committing
// 537 MB of Chromium (or LFS pointers), the repo tracks a small artifact MANIFEST
// (version + archive SHA-256 + file checksums + provider), and `prepare` fetches +
// verifies + atomically installs the runtime from a versioned archive. Provider is
// neutral (local archive now; generic HTTPS later) — never locked to GitHub LFS,
// never defaults to D:\m-profile.
//
// This module owns the pure/verifiable pieces: manifest schema+validation, provider
// resolution/allowlist, archive checksum, zip entry-safety, and atomic install. Zip
// create/extract shell out to platform tools (no new dependency) via an injectable
// `exec` so the logic stays testable.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const RUNTIME_ID = 'phom-chromium';
// A runtime archive must NEVER contain a user profile / secret (§5).
const FORBIDDEN_BASENAMES = Object.freeze(['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal', 'Web Data', 'History', 'Preferences', 'Local State', 'Network Action Predictor', '.env']);
const FORBIDDEN_DIRNAMES = Object.freeze(['User Data', 'Default', 'Cache', 'Code Cache', 'GPUCache', 'Cookies']);

function err(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }
function sha256File(p) { return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function archiveName(version, platform = 'win32', arch = 'x64') {
  const os = platform === 'win32' ? 'win' : platform;
  return `${RUNTIME_ID}-${version}-${os}-${arch}.zip`;
}

function buildArtifactManifest({ version, platform = 'win32', arch = 'x64', archivePath = null, requiredFiles = [], requiredDirectories = [], fileChecksums = {}, provider = 'NOT_CONFIGURED', url = null } = {}) {
  const name = archiveName(version, platform, arch);
  const manifest = {
    schemaVersion: SCHEMA_VERSION, runtimeId: RUNTIME_ID, chromiumVersion: version,
    platform, architecture: arch, archiveName: name,
    archiveSha256: archivePath ? sha256File(archivePath) : null,
    archiveSize: archivePath ? fs.statSync(archivePath).size : 0,
    executableRelativePath: 'chrome.exe',
    requiredFiles: [...requiredFiles], requiredDirectories: [...requiredDirectories],
    fileChecksums: { ...fileChecksums },
    download: { provider: provider || 'NOT_CONFIGURED', url: url || null },
  };
  return manifest;
}

// Validate a tracked artifact manifest against the host platform/arch.
function validateArtifactManifest(manifest, { platform = process.platform, arch = process.arch } = {}) {
  if (!manifest || typeof manifest !== 'object') return err('PHOM_RUNTIME_MANIFEST_INVALID', 'manifest is not an object');
  if (manifest.schemaVersion !== SCHEMA_VERSION) return err('PHOM_RUNTIME_MANIFEST_INVALID', `unsupported schemaVersion ${manifest.schemaVersion}`);
  if (manifest.platform !== platform) return err('PHOM_RUNTIME_PLATFORM_MISMATCH', `manifest platform ${manifest.platform} != host ${platform}`);
  if (manifest.architecture !== arch) return err('PHOM_RUNTIME_ARCH_MISMATCH', `manifest arch ${manifest.architecture} != host ${arch}`);
  if (!/^phom-chromium-.+-(win|linux|darwin)-(x64|arm64)\.zip$/.test(String(manifest.archiveName || ''))) return err('PHOM_RUNTIME_MANIFEST_INVALID', `invalid archiveName ${manifest.archiveName}`);
  if (!manifest.archiveSha256 || !/^sha256:[0-9a-f]{64}$/.test(manifest.archiveSha256)) return err('PHOM_RUNTIME_MANIFEST_INVALID', 'missing/invalid archiveSha256');
  const provider = manifest.download && manifest.download.provider;
  const configured = provider && provider !== 'NOT_CONFIGURED' && manifest.download.url;
  return { ok: true, configured: !!configured, provider: provider || 'NOT_CONFIGURED' };
}

// ---- providers (resolve source + download to a destination) ----
class LocalArchiveProvider {
  constructor({ archivePath } = {}) { this._archivePath = archivePath; }
  resolve() { return this._archivePath ? { ok: true, kind: 'local', path: this._archivePath } : err('PHOM_RUNTIME_SOURCE_NOT_CONFIGURED', 'no local archive path'); }
  async download(_source, dest) {
    if (!this._archivePath || !fs.existsSync(this._archivePath)) return err('PHOM_RUNTIME_ARCHIVE_NOT_FOUND', `archive not found: ${this._archivePath}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(this._archivePath, dest);
    return { ok: true, path: dest, bytes: fs.statSync(dest).size };
  }
}

class HttpsArtifactProvider {
  constructor({ allowlist = [], timeoutMs = 120000, maxBytes = 2 * 1024 * 1024 * 1024, request = null } = {}) {
    this._allowlist = allowlist.map((h) => String(h).toLowerCase());
    this._timeoutMs = timeoutMs; this._maxBytes = maxBytes; this._request = request; // request injectable for tests
  }
  _hostAllowed(u) { try { const url = new URL(u); return url.protocol === 'https:' && this._allowlist.includes(url.hostname.toLowerCase()); } catch { return false; } }
  resolve(manifest) {
    const d = manifest && manifest.download;
    if (!d || d.provider === 'NOT_CONFIGURED' || !d.url) return err('PHOM_RUNTIME_SOURCE_NOT_CONFIGURED', 'no configured download URL');
    if (!this._hostAllowed(d.url)) return err('PHOM_RUNTIME_DOWNLOAD_NOT_ALLOWLISTED', `host not allowlisted or not https: ${d.url}`);
    return { ok: true, kind: 'https', url: d.url };
  }
  async download(source, dest, { signal } = {}) {
    if (!source || !this._hostAllowed(source.url)) return err('PHOM_RUNTIME_DOWNLOAD_NOT_ALLOWLISTED', 'source url not allowlisted');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const getFn = this._request || ((url, opts, cb) => https.get(url, opts, cb));
    return new Promise((resolve) => {
      let received = 0; let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const req = getFn(source.url, { timeout: this._timeoutMs }, (res) => {
        // NEVER follow a redirect outside the allowlist.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (!this._hostAllowed(res.headers.location)) return finish(err('PHOM_RUNTIME_DOWNLOAD_NOT_ALLOWLISTED', 'redirect outside allowlist'));
        }
        if (res.statusCode !== 200) return finish(err('PHOM_RUNTIME_DOWNLOAD_FAILED', `status ${res.statusCode}`));
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => { received += c.length; if (received > this._maxBytes) { try { req.destroy(); } catch {} out.destroy(); finish(err('PHOM_RUNTIME_ARCHIVE_TOO_LARGE', `exceeds ${this._maxBytes} bytes`)); } });
        res.pipe(out);
        out.on('finish', () => finish({ ok: true, path: dest, bytes: received }));
        out.on('error', (e) => finish(err('PHOM_RUNTIME_DOWNLOAD_FAILED', String(e && e.message || e))));
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} finish(err('PHOM_RUNTIME_DOWNLOAD_TIMEOUT', 'download timed out')); });
      req.on('error', (e) => finish(err('PHOM_RUNTIME_DOWNLOAD_FAILED', String(e && e.message || e))));
      if (signal) signal.addEventListener('abort', () => { try { req.destroy(); } catch {} finish(err('PHOM_RUNTIME_DOWNLOAD_FAILED', 'cancelled')); });
    });
  }
}

// verify a downloaded/local archive against the manifest checksum + size cap.
function verifyArchive(archivePath, expectedSha256, { maxBytes = Infinity } = {}) {
  if (!fs.existsSync(archivePath)) return err('PHOM_RUNTIME_ARCHIVE_NOT_FOUND', `archive not found: ${archivePath}`);
  const size = fs.statSync(archivePath).size;
  if (size > maxBytes) return err('PHOM_RUNTIME_ARCHIVE_TOO_LARGE', `archive ${size} > ${maxBytes}`);
  const actual = sha256File(archivePath);
  if (expectedSha256 && actual !== expectedSha256) return err('PHOM_RUNTIME_ARCHIVE_CHECKSUM_MISMATCH', 'archive checksum mismatch', { expected: expectedSha256, actual });
  return { ok: true, size, sha256: actual };
}

// Reject zip entries that would escape the extraction root (zip-slip) or are absolute.
function assertSafeEntries(entries) {
  for (const raw of entries) {
    const e = String(raw).replace(/\\/g, '/').trim();
    if (!e) continue;
    if (e.startsWith('/') || /^[A-Za-z]:/.test(e)) return err('PHOM_RUNTIME_EXTRACT_FAILED', `absolute path entry rejected: ${e}`);
    if (e.split('/').some((seg) => seg === '..')) return err('PHOM_RUNTIME_EXTRACT_FAILED', `path traversal entry rejected: ${e}`);
  }
  return { ok: true };
}

// Scan a runtime/extracted tree for forbidden profile/secret files (§5).
function scanForbidden(root) {
  const hits = [];
  const walk = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (FORBIDDEN_DIRNAMES.includes(ent.name)) hits.push(full); else walk(full); }
      else if (FORBIDDEN_BASENAMES.includes(ent.name)) hits.push(full);
    }
  };
  walk(root);
  return hits;
}

// Atomically swap an extracted runtime into place: move current aside, move new in,
// on any failure restore the previous runtime. Never leaves a partial runtime.
function atomicInstall(extractedRoot, runtimeRoot) {
  const parent = path.dirname(runtimeRoot);
  fs.mkdirSync(parent, { recursive: true });
  const backup = runtimeRoot + '.bak-' + Date.now();
  const hadPrev = fs.existsSync(runtimeRoot);
  // Cross-device (EXDEV) rename isn't allowed; fall back to a recursive copy so the
  // install still works when the extract dir is on another drive.
  const moveInto = (src, dst) => { try { fs.renameSync(src, dst); } catch (e) { if (e && e.code === 'EXDEV') { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); } else throw e; } };
  try {
    if (hadPrev) fs.renameSync(runtimeRoot, backup);
    moveInto(extractedRoot, runtimeRoot);
    if (hadPrev) fs.rmSync(backup, { recursive: true, force: true });
    return { ok: true, root: runtimeRoot };
  } catch (e) {
    // restore previous runtime if we moved it
    try { if (fs.existsSync(runtimeRoot) && hadPrev) fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
    try { if (hadPrev && fs.existsSync(backup)) fs.renameSync(backup, runtimeRoot); } catch {}
    return err('PHOM_RUNTIME_ATOMIC_INSTALL_FAILED', String(e && e.message || e));
  }
}

module.exports = {
  SCHEMA_VERSION, RUNTIME_ID, FORBIDDEN_BASENAMES, FORBIDDEN_DIRNAMES,
  sha256File, archiveName, buildArtifactManifest, validateArtifactManifest,
  LocalArchiveProvider, HttpsArtifactProvider, verifyArchive, assertSafeEntries, scanForbidden, atomicInstall,
};
