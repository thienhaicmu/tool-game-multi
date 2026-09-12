#!/usr/bin/env node
'use strict';

// Prepare the pinned Phỏm Chromium runtime from a VERSIONED ARCHIVE (§7). Two modes:
//   A. local archive:   node tools/prepare-phom-chromium.mjs --archive <path-to.zip>
//   B. configured remote: node tools/prepare-phom-chromium.mjs   (uses manifest.download)
//
// Flow: load tracked artifact manifest -> validate platform/arch -> resolve source ->
// download/copy to a temp file -> verify SHA-256 (+ size cap) -> list + reject unsafe
// zip entries -> extract to a temp dir -> validate extracted runtime -> verify file
// checksums -> ATOMIC replace runtime/phom-chromium/ -> cleanup. On any failure the
// existing runtime is preserved. It NEVER defaults to D:\m-profile.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rt = require('../desktop/browser/phom-chromium-runtime.cjs');
const art = require('../desktop/browser/phom-runtime-artifact.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const RUNTIME = path.join(projectRoot, 'runtime', 'phom-chromium');
const MANIFESTS_DIR = path.join(projectRoot, 'runtime-manifests');
const IP_ALLOWLIST = (process.env.PHOM_RUNTIME_DOWNLOAD_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; }
function die(code, msg) { console.error(`${code}: ${msg}`); process.exit(1); }

function pickManifest() {
  const explicit = arg('--manifest');
  if (explicit) return explicit;
  if (!fs.existsSync(MANIFESTS_DIR)) return null;
  const host = process.platform, arch = process.arch;
  for (const f of fs.readdirSync(MANIFESTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const m = JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, f), 'utf8')); if (m.platform === host && m.architecture === arch) return path.join(MANIFESTS_DIR, f); } catch { /* skip */ }
  }
  return null;
}

// Zip listing + extraction via built-in Windows PowerShell (System.IO.Compression;
// GNU tar here can't read a Compress-Archive zip). No new dependency.
function psQuote(p) { return "'" + String(p).replace(/'/g, "''") + "'"; }
function ps(script) { return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); }
function listZipEntries(zip) {
  const r = ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead(${psQuote(zip)}); try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`);
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).filter(Boolean);
}
function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const r = ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zip)}, ${psQuote(dest)})`);
  return r.status === 0;
}

async function main() {
  const manifestPath = pickManifest();
  if (!manifestPath) die('PHOM_RUNTIME_MANIFEST_INVALID', `no artifact manifest for ${process.platform}-${process.arch} in ${MANIFESTS_DIR}`);
  let manifest; try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { die('PHOM_RUNTIME_MANIFEST_INVALID', String(e.message || e)); }
  const mv = art.validateArtifactManifest(manifest, { platform: process.platform, arch: process.arch });
  if (!mv.ok) die(mv.error.code, mv.error.message);
  console.log('Manifest:', path.basename(manifestPath), manifest.chromiumVersion, `${manifest.platform}-${manifest.architecture}`);

  // resolve the source provider.
  const localArchive = arg('--archive') || process.env.PHOM_CHROMIUM_ARCHIVE || null;
  let provider, source;
  if (localArchive) {
    provider = new art.LocalArchiveProvider({ archivePath: localArchive });
    source = provider.resolve(manifest);
  } else if (mv.configured) {
    provider = new art.HttpsArtifactProvider({ allowlist: IP_ALLOWLIST });
    source = provider.resolve(manifest);
  } else {
    die('PHOM_RUNTIME_SOURCE_NOT_CONFIGURED', 'no --archive given and manifest.download.provider is NOT_CONFIGURED');
  }
  if (!source.ok) die(source.error.code, source.error.message);

  // Work on the SAME drive as the runtime so the atomic rename-swap is same-device.
  fs.mkdirSync(path.dirname(RUNTIME), { recursive: true });
  const work = fs.mkdtempSync(path.join(path.dirname(RUNTIME), '.phom-rt-prep-'));
  const tmpZip = path.join(work, manifest.archiveName);
  const tmpExtract = path.join(work, 'extracted');
  try {
    // download/copy.
    const dl = await provider.download(source, tmpZip, {});
    if (!dl.ok) die(dl.error.code, dl.error.message);

    // verify checksum + size cap.
    const vr = art.verifyArchive(tmpZip, manifest.archiveSha256, { maxBytes: (manifest.archiveSize || 0) * 4 + 64 * 1024 * 1024 });
    if (!vr.ok) die(vr.error.code, vr.error.message);
    console.log('Archive checksum OK:', vr.sha256);

    // entry-safety (zip-slip).
    const entries = listZipEntries(tmpZip);
    if (!entries) die('PHOM_RUNTIME_EXTRACT_FAILED', 'could not list archive entries');
    const safe = art.assertSafeEntries(entries);
    if (!safe.ok) die(safe.error.code, safe.error.message);

    // extract to temp.
    if (!extractZip(tmpZip, tmpExtract)) die('PHOM_RUNTIME_EXTRACT_FAILED', 'extraction failed');

    // validate the extracted runtime BEFORE touching the live one.
    const ev = rt.validateRuntime(tmpExtract);
    if (!ev.ok) die('PHOM_RUNTIME_VALIDATION_FAILED', `${ev.error.code}: ${ev.error.message}`);
    // verify file checksums from the manifest.
    for (const [f, want] of Object.entries(manifest.fileChecksums || {})) {
      const p = path.join(tmpExtract, f);
      if (!fs.existsSync(p) || art.sha256File(p) !== want) die('PHOM_RUNTIME_VALIDATION_FAILED', `file checksum mismatch: ${f}`);
    }

    // atomic install (previous runtime preserved on failure).
    const inst = art.atomicInstall(tmpExtract, RUNTIME);
    if (!inst.ok) die(inst.error.code, inst.error.message);

    const fin = rt.validateRuntime(RUNTIME);
    if (!fin.ok) die('PHOM_RUNTIME_VALIDATION_FAILED', fin.error.code);
    console.log('Installed + validated:', fin.version, fin.architecture, 'at', RUNTIME);

    // Grant the AppContainer read+execute ACL the Chromium sandbox needs (a copied
    // runtime loses it → "Sandbox cannot access executable … 0x5"). This keeps the
    // sandbox ON in production; it is NOT a --no-sandbox workaround. RX only, project dir.
    const acl = rt.ensureSandboxAccess(RUNTIME);
    console.log('Sandbox ACL (AppContainer RX):', acl.ok ? (acl.changed ? 'granted' : 'already present') : `WARN ${acl.reason}`);
    if (!acl.ok && rt.sandboxAccessPresent(RUNTIME) === false) die('PHOM_CHROMIUM_SANDBOX_REQUIRED', 'could not grant AppContainer read+execute on the runtime (sandbox would fail).');
    console.log('DONE.');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main().catch((e) => die('PHOM_RUNTIME_PREPARE_FAILED', String(e && e.message || e)));
