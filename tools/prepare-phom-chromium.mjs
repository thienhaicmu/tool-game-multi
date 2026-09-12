#!/usr/bin/env node
'use strict';

// Prepare the pinned Phỏm custom Chromium runtime (§5). Copies a complete runnable
// Chromium bundle from a CONFIGURABLE source into runtime/phom-chromium/, generates a
// runtime-manifest.json (version + checksums), and validates it. The binaries are
// gitignored — this script + the manifest + the validator are what's tracked, so any
// machine can reproduce the runtime without depending on D:\m-profile.
//
// Usage:
//   node tools/prepare-phom-chromium.mjs [--source <dir>] [--force]
//   PHOM_CHROMIUM_SOURCE=<dir> node tools/prepare-phom-chromium.mjs
// Default source: D:\m-profile\dist\chromium-runtime (reference; adjust per machine).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rt = require('../desktop/browser/phom-chromium-runtime.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const TARGET = path.join(projectRoot, 'runtime', 'phom-chromium');

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }
const FORCE = process.argv.includes('--force');
const SOURCE = arg('--source', process.env.PHOM_CHROMIUM_SOURCE || 'D:\\m-profile\\dist\\chromium-runtime');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  const exeAlready = fs.existsSync(path.join(TARGET, rt.EXECUTABLE));
  if (!exeAlready || FORCE) {
    if (!fs.existsSync(path.join(SOURCE, rt.EXECUTABLE))) {
      console.error(`PHOM_CHROMIUM_RUNTIME_NOT_FOUND: no ${rt.EXECUTABLE} at source ${SOURCE}`);
      process.exit(2);
    }
    console.log(`Copying Chromium runtime from ${SOURCE} -> ${TARGET} ...`);
    copyDir(SOURCE, TARGET);
  } else {
    console.log(`Runtime already present at ${TARGET} (use --force to re-copy).`);
  }

  const gen = rt.generateManifest(TARGET);
  if (!gen.ok) { console.error(`${gen.error.code}: ${gen.error.message}`); process.exit(3); }
  fs.writeFileSync(path.join(TARGET, 'runtime-manifest.json'), JSON.stringify(gen.manifest, null, 2), 'utf8');
  console.log('Wrote runtime-manifest.json', { version: gen.manifest.chromiumVersion, files: gen.manifest.fileCount });

  const v = rt.validateRuntime(TARGET);
  if (!v.ok) { console.error(`VALIDATION FAILED: ${v.error.code}: ${v.error.message}`); process.exit(4); }
  console.log('Runtime VALID:', { version: v.version, arch: v.architecture, checksumVerified: v.checksumVerified, root: v.root });
}

main();
