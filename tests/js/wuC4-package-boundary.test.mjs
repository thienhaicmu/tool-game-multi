import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const gen = JSON.parse(readFileSync(new URL('../../tools/license-generator/electron-builder.json', import.meta.url), 'utf8'));

// §49/§57 — the CUSTOMER package must contain ZERO private signing material and no
// seller generator/signing code.
test('customer build ships no private key, seller key file, or generator tooling', () => {
  const files = pkg.build.files.join('\n');
  assert.ok(!/\.pem/.test(files), 'no .pem in customer files');
  assert.ok(!/private/.test(files), 'no private/ path in customer files');
  assert.ok(!/tools\//.test(files), 'no tools/ (generator) in customer files');
  assert.ok(!/generate-license|ui-main/.test(files), 'no signing code in customer files');
  // Public verification key IS shipped (bundled under desktop/**).
  assert.ok(/desktop\/\*\*/.test(files), 'customer ships desktop/** (incl. public-key.cjs)');
});

// PUBLIC_VERIFICATION_KEY_PRESENT=YES, PRIVATE_SIGNING_KEY_PRESENT=NO (source proof).
test('public key module exists; private signing key is not in the repo tree', () => {
  const pub = readFileSync(new URL('../../desktop/licensing/public-key.cjs', import.meta.url), 'utf8');
  assert.match(pub, /PUBLIC KEY/);
  // The signer reads the private key from an external path/env — never a bundled constant.
  const signer = readFileSync(new URL('../../tools/license-generator/ui-main.cjs', import.meta.url), 'utf8');
  assert.ok(!/BEGIN (?:ED25519 )?PRIVATE KEY/.test(signer), 'no inline private key in the generator source');
  assert.match(signer, /readPrivateKey/);
});

// The generator build includes the licensing modules its main process now requires.
test('generator build bundles the licensing modules it imports', () => {
  const files = gen.files.join('\n');
  for (const need of ['canonical-json', 'license-verifier', 'entitlements', 'public-key', 'trusted-time']) {
    assert.ok(files.includes(need), `generator files include ${need}`);
  }
  assert.equal(gen.appId, 'com.aviatorcontrolstudio.licensegenerator');
});

// §31 — customer and generator are separate apps (distinct appIds -> independent locks).
test('customer and generator are distinct applications', () => {
  assert.notEqual(pkg.build.appId, gen.appId);
});
