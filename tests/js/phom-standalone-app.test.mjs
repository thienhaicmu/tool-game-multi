import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const mainSrc = read('desktop/phom-main.cjs');
const preloadSrc = read('desktop/phom-preload.cjs');
const rendererSrc = read('ui-phom/phom-qa.js');
const builder = JSON.parse(read('electron-builder.phom.json'));
const pkg = JSON.parse(read('package.json'));
const analyticsBuilder = JSON.parse(read('electron-builder.analytics.json'));

// §12 — distinct application identity (appId / productName / output / userData).
test('Phom app identity is distinct from Control and Analytics', () => {
  assert.equal(builder.appId, 'com.phomqa.desktop');
  assert.equal(builder.productName, 'Phom QA');
  assert.equal(builder.directories.output, 'release-phom');
  assert.notEqual(builder.appId, pkg.build.appId);            // != Control
  assert.notEqual(builder.appId, analyticsBuilder.appId);      // != Analytics
  assert.notEqual(builder.directories.output, pkg.build.directories.output);
  assert.notEqual(builder.directories.output, analyticsBuilder.directories.output);
  assert.equal(builder.extraMetadata.main, 'desktop/phom-main.cjs');
  assert.match(builder.artifactName, /Phom-QA/);
  // main sets its own userData namespace + name
  assert.match(mainSrc, /app\.setName\(PRODUCT_NAME\)/);
  assert.match(mainSrc, /PRODUCT_NAME = 'Phom QA'/);
  assert.match(mainSrc, /requestSingleInstanceLock/);
});

// §3/§7 — license gate expects the PHOM game product.
test('Phom main gates on PHOM license entitlement', () => {
  assert.match(mainSrc, /GAME_PRODUCT = 'PHOM'/);
  assert.match(mainSrc, /expectedGameProduct: GAME_PRODUCT/);
});

// §10/§18 — no import (require) of Control or Analytics renderers/roots/singletons.
// Checks actual require() targets, not documentation prose that names the peers.
test('Phom app does not import Control/Analytics renderer or roots', () => {
  for (const src of [mainSrc, preloadSrc, rendererSrc]) {
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const dep of requires) {
      assert.equal(/product\.js|app-shell|ui\/panels|\bmain\.cjs$/.test(dep), false, `no Control renderer import: ${dep}`);
      assert.equal(/analytics-main|analytics-preload|ui-analytics|analytics\//.test(dep), false, `no Analytics import: ${dep}`);
      assert.equal(/protocol\/(aviator|auto-runner|round-observer|harness)/.test(dep), false, `no Aviator action modules: ${dep}`);
    }
  }
});

// §18 — renderer talks ONLY to the typed preload; no direct network/live sender import.
test('Phom renderer has no direct network / live sender / node imports', () => {
  assert.equal(/require\(/.test(rendererSrc), false, 'renderer must not require() node modules');
  assert.equal(/ws-replay|sendProtocol|chrome-remote-interface|node:net|import\s+net/.test(rendererSrc), false);
  // It uses the exposed API surface.
  assert.match(rendererSrc, /window\.phomQA/);
});

// §18 — every preload IPC channel is namespaced 'phom:'.
test('all Phom preload IPC channels use the phom: namespace', () => {
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|on)\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length >= 15, 'expected the full preload surface');
  for (const c of channels) assert.match(c, /^phom:/, `channel ${c} must be phom:-namespaced`);
});

// §12 — build file list ships the Phom renderer + reused low-level owners, NOT the
// Control/Analytics renderers.
test('Phom build files include ui-phom + shared owners, exclude other renderers', () => {
  const files = builder.files.join('\n');
  assert.match(files, /ui-phom/);
  assert.match(files, /protocol\/phom/);
  assert.match(files, /licensing/);
  assert.equal(/ui\/\*\*|ui-analytics/.test(files), false, 'must not ship Control/Analytics renderer');
});

// The private signing key must NEVER be part of the Phom package (§11).
test('Phom package does not include generator/private-key material', () => {
  const files = builder.files.join('\n');
  assert.equal(/license-generator|private|generate-license|generate-keypair/.test(files), false);
});
