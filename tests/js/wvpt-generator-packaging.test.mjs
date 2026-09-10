import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const gen = JSON.parse(read('tools/license-generator/electron-builder.json'));

// ---- Control (customer) package: ABSOLUTE secret boundary ----
test('Control package excludes every seller secret and generator resource', () => {
  const files = pkg.build.files.join('\n');
  assert.ok(!/\.pem/.test(files), 'no private key');
  assert.ok(!/private/.test(files), 'no private/ path');
  assert.ok(!/tools\//.test(files), 'no generator tooling');
  assert.ok(!/service-account|google-service-account|aviator-license-management/i.test(files), 'no Google credential');
  assert.ok(!/generate-license|ui-main|google-sheet/.test(files), 'no signing/sheet-write code');
  assert.ok(/desktop\/\*\*/.test(files), 'Control still ships desktop/** (public verify key)');
  // Control has no extraResources smuggling secrets in.
  const extra = JSON.stringify(pkg.build.extraResources || []);
  assert.ok(!/service-account|\.pem|private/i.test(extra), 'no secrets in Control extraResources');
});

// ---- Generator package: self-contained (bundles BOTH secrets as extraResources) ----
test('Generator bundles the private signing key and Google credential as extraResources', () => {
  const extra = JSON.stringify(gen.extraResources || []);
  assert.match(extra, /\*\.pem/, 'private key bundled');
  assert.match(extra, /google-service-account\.json/, 'Google credential bundled');
  const toPaths = (gen.extraResources || []).map((e) => e.to).join('\n');
  assert.match(toPaths, /private\/google-service-account\.json/, 'credential lands under private/ in resources');
});

test('Generator does NOT ship the Google credential in normal files (extraResources only)', () => {
  const files = gen.files.join('\n');
  assert.ok(!/google-service-account|service-account|aviator-license-management/i.test(files), 'credential not in files[]');
  assert.ok(!/\.pem/.test(files), 'private key not in files[]');
  // But it DOES ship the code that consumes the bundled resources.
  for (const need of ['seller-resources', 'google-sheet', 'ui-main']) assert.ok(files.includes(need), `files include ${need}`);
});

// ---- Fresh-install UX: open and use, ZERO manual configuration / file dialogs ----
test('no credential/key file pickers remain anywhere in the generator UI', () => {
  const html = read('tools/license-generator/ui.html');
  const js = read('tools/license-generator/ui.js');
  const preload = read('tools/license-generator/ui-preload.cjs');
  const main = read('tools/license-generator/ui-main.cjs');
  for (const src of [html, js, preload, main]) {
    assert.ok(!/choose-key|choose-sa|choosePrivateKey|chooseServiceAccount|choose-private-key|choose-service-account/.test(src), 'no picker wiring');
  }
  assert.ok(!/Chọn khóa ký|Service Account/i.test(html), 'no setup labels in UI');
  assert.ok(!/showOpenDialog/.test(main), 'main opens NO file dialogs (FRESH_INSTALL_FILE_DIALOGS=0)');
  // Inspect stays available; readiness chips exist.
  assert.match(html, /view-inspect/);
  assert.match(html, /signing-chip/);
  assert.match(html, /sheet-chip/);
});

test('no spreadsheet/sheet-id config inputs are exposed in the UI', () => {
  const html = read('tools/license-generator/ui.html');
  assert.ok(!/spreadsheet/i.test(html), 'no spreadsheet id input');
  assert.ok(!/sheetId|sheet-id/i.test(html), 'no sheet id input');
});

// ---- IPC security: renderer bridge exposes only safe operations/state ----
test('preload exposes a safe allowlist with no secret-reading APIs', () => {
  const preload = read('tools/license-generator/ui-preload.cjs');
  const allowed = new Set(['signingStatus', 'generateLicense', 'inspectLicense', 'planPresets', 'planDefaults', 'previewExpiry', 'copy', 'sheetStatus', 'syncLicense']);
  const exposed = [...preload.matchAll(/^\s*([a-zA-Z]+):\s*(?:record|input|license|text)?\s*=>/gm)].map((m) => m[1]);
  assert.ok(exposed.length > 0, 'parsed some exposed methods');
  for (const name of exposed) assert.ok(allowed.has(name), `exposed method "${name}" is on the safe allowlist`);
  assert.ok(!/private_key|readPrivateKey|serviceAccount|privateKey/i.test(preload), 'no key material named in the bridge');
});

test('no IPC handler returns private key or Google private_key material to the renderer', () => {
  const main = read('tools/license-generator/ui-main.cjs');
  // signing-status returns only a boolean; sheet-status returns only safe fields.
  assert.match(main, /handle\('signing-status',\s*\(\)\s*=>\s*\(\{\s*ready:/);
  // The private key is read only inside signing (createLicense/inspect), never returned.
  assert.ok(!/return[^\n;]*readPrivateKey\(\)/.test(main), 'readPrivateKey result is never returned over IPC');
  assert.ok(!/return[^\n;]*private_key/.test(main), 'private_key is never returned over IPC');
  // loadServiceAccount result (with private_key) is used only to build the client/email.
  assert.ok(!/handle\([^)]*\)[^{]*\{[^}]*\.private_key/.test(main), 'no handler surfaces .private_key');
});
