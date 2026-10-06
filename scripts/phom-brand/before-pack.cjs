'use strict';
// electron-builder beforePack (electron-builder.phom.json): stage a BRANDED copy of the bundled Chromium in
// .phom-brand/phom-chromium — the packaging copies THAT folder (extraResources) and signs its chrome.exe afterwards.
// (An afterPack hook was too late: electron-builder signs chrome.exe while copying the extra resources, and changing
// it after that breaks the signature — seen in the 3.1.25 build log 2026-10-06.) runtime/phom-chromium itself is never
// modified, so dev runs keep the stock Chromium.
const fs = require('node:fs');
const path = require('node:path');
const { brandChromiumDir } = require('./brand-chromium.cjs');

const STAGE = path.join('.phom-brand', 'phom-chromium');

function stageBrandedChromium(projectDir) {
  const src = path.join(projectDir, 'runtime', 'phom-chromium');
  const dst = path.join(projectDir, STAGE);
  if (!fs.existsSync(path.join(src, 'chrome.exe'))) throw new Error('runtime/phom-chromium/chrome.exe missing — prepare the Chromium runtime first');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  return brandChromiumDir(dst, path.join(projectDir, 'build', 'phom-icon.ico'));
}

exports.default = async function beforePack(context) {
  const t0 = Date.now();
  const r = stageBrandedChromium(context.packager.projectDir);
  console.log(`  • phom-brand: Chromium staged + branded (exe groups ${r.exe.replaced}, dll group ${r.dll.group}, "${r.exe.name}") in ${Date.now() - t0} ms`);
};
exports.stageBrandedChromium = stageBrandedChromium;
exports.STAGE = STAGE;
