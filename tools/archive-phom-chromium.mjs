#!/usr/bin/env node
'use strict';

// Create a versioned Chromium runtime ARCHIVE from the local runtime + update the
// tracked artifact manifest (§9). Uses the built-in Windows PowerShell Compress-
// Archive (no new dependency). Does NOT upload / commit / push.
//
//   npm run archive:phom-chromium

import fs from 'node:fs';
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
const ARCHIVES_DIR = path.join(projectRoot, 'runtime-archives');
const MANIFESTS_DIR = path.join(projectRoot, 'runtime-manifests');

function fail(msg, code = 1) { console.error(msg); process.exit(code); }

function main() {
  // 1) validate the local runtime.
  const v = rt.validateRuntime(RUNTIME);
  if (!v.ok) fail(`RUNTIME INVALID: ${v.error.code}: ${v.error.message}`, 2);
  console.log('Runtime valid:', v.version, v.architecture);

  // 2) forbidden-file scan (never archive a user profile / secret).
  const forbidden = art.scanForbidden(RUNTIME);
  if (forbidden.length) fail(`FORBIDDEN FILES in runtime (refusing to archive):\n${forbidden.join('\n')}`, 3);
  console.log('Forbidden-file scan: clean');

  const name = art.archiveName(v.version, 'win32', 'x64');
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
  const archivePath = path.join(ARCHIVES_DIR, name);
  if (fs.existsSync(archivePath)) fs.rmSync(archivePath, { force: true });

  // 3) create the zip via PowerShell Compress-Archive (contents at archive root).
  console.log('Creating archive (Compress-Archive)…');
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${RUNTIME}\\*' -DestinationPath '${archivePath}' -CompressionLevel Optimal -Force`],
    { stdio: 'inherit', windowsHide: true });
  if (ps.status !== 0 || !fs.existsSync(archivePath)) fail('Compress-Archive failed', 4);

  // 4-5) checksums + size + file checksums.
  const archiveSha256 = art.sha256File(archivePath);
  const archiveSize = fs.statSync(archivePath).size;
  const fileChecksums = {
    'chrome.exe': art.sha256File(path.join(RUNTIME, 'chrome.exe')),
    'chrome.dll': art.sha256File(path.join(RUNTIME, 'chrome.dll')),
  };

  // 6) update the tracked artifact manifest (provider NOT_CONFIGURED — no upload).
  const manifest = art.buildArtifactManifest({
    version: v.version, platform: 'win32', arch: 'x64', archivePath,
    requiredFiles: rt.REQUIRED_FILES, requiredDirectories: rt.REQUIRED_DIRECTORIES, fileChecksums,
    provider: 'NOT_CONFIGURED', url: null,
  });
  fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
  const manifestPath = path.join(MANIFESTS_DIR, name.replace(/\.zip$/, '.json'));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('Archive:', archivePath, `(${(archiveSize / 1048576).toFixed(1)} MB)`);
  console.log('archiveSha256:', archiveSha256);
  console.log('Manifest written:', manifestPath);
  console.log('DONE (not uploaded, not committed).');
}

main();
