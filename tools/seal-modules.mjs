// Tier 2 build step — seal the crown-jewel protocol modules into AES-256-GCM
// ciphertext (`<name>.cjs.enc`) that the runtime sealed-loader decrypts in memory.
// Run before electron-builder (see the `dist` script); the packaged app excludes the
// plaintext `.cjs` for these modules and ships only the `.enc`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveSealKey } = require('../desktop/licensing/seal-secret.cjs');
const { seal, SEALED_BASENAMES } = require('../desktop/protocol/sealed-loader.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'desktop', 'protocol');
const key = deriveSealKey();

for (const name of SEALED_BASENAMES) {
  const src = path.join(dir, `${name}.cjs`);
  const out = `${src}.enc`;
  const blob = seal(readFileSync(src), key);
  writeFileSync(out, blob);
  console.log(`sealed ${name}.cjs -> ${name}.cjs.enc (${blob.length} bytes)`);
}
console.log(`Sealed ${SEALED_BASENAMES.length} protocol modules.`);
