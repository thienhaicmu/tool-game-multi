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
  const rt = require(path.join(projectDir, 'desktop', 'browser', 'phom-chromium-runtime.cjs'));
  const src = path.join(projectDir, 'runtime', 'phom-chromium');
  const dst = path.join(projectDir, STAGE);
  if (!fs.existsSync(path.join(src, 'chrome.exe'))) throw new Error('runtime/phom-chromium/chrome.exe missing — prepare the Chromium runtime first');
  const before = rt.validateRuntime(src);
  if (!before.ok) throw new Error('runtime/phom-chromium is not valid: ' + before.error.code);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  const r = brandChromiumDir(dst, path.join(projectDir, 'build', 'phom-icon.ico'));
  // The tool checks chrome.exe against runtime-manifest.json before every launch: the branded files get their own
  // manifest (3.1.25 shipped the old one → PHOM_CHROMIUM_CHECKSUM_MISMATCH, no browser could open). Then the SAME
  // check the tool runs — a copy that would not launch never gets packaged.
  const m = rt.generateManifest(dst);
  if (!m.ok) throw new Error('manifest: ' + m.error.code);
  fs.writeFileSync(path.join(dst, 'runtime-manifest.json'), JSON.stringify(m.manifest, null, 2) + '\n');
  const after = rt.validateRuntime(dst, { deep: true });
  if (!after.ok) throw new Error('branded Chromium fails the launch check: ' + after.error.code);
  return { ...r, validated: after.checksumVerified === true };
}

exports.default = async function beforePack(context) {
  const t0 = Date.now();
  const r = stageBrandedChromium(context.packager.projectDir);
  console.log(`  • phom-brand: Chromium staged + branded (exe groups ${r.exe.replaced}, dll group ${r.dll.group}, "${r.exe.name}") in ${Date.now() - t0} ms`);
};
exports.stageBrandedChromium = stageBrandedChromium;
exports.STAGE = STAGE;

// npm run brand:phom — stage it by hand, so `npm run dev:phom` also runs the branded browser.
if (require.main === module) {
  const t0 = Date.now();
  const r = stageBrandedChromium(path.join(__dirname, '..', '..'));
  console.log(`branded Chromium staged in ${STAGE} (launch check ${r.validated ? 'passed' : 'FAILED'}) in ${Date.now() - t0} ms`);
}
