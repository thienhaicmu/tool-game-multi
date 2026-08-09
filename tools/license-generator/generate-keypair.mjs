import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const privatePath = resolve(process.argv[2] || 'tools/license-generator/private/wvpt-ed25519-private.pem');
const publicPath = resolve(process.argv[3] || 'tools/license-generator/private/wvpt-ed25519-public.pem');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

mkdirSync(dirname(privatePath), { recursive: true });
writeFileSync(privatePath, privatePem, { encoding: 'utf8', mode: 0o600 });
writeFileSync(publicPath, publicPem, { encoding: 'utf8', mode: 0o644 });

console.log('WVPT Ed25519 keypair generated.');
console.log('');
console.log('PRIVATE KEY PATH (DO NOT COMMIT, DO NOT SHIP):');
console.log(privatePath);
console.log('');
console.log('PUBLIC KEY PATH (copy into desktop/licensing/public-key.cjs for customer verification):');
console.log(publicPath);
console.log('');
console.log(publicPem.trim());
