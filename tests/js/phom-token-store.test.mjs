import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TokenKeyStore } = require('../../desktop/protocol/phom/token-key-store.cjs');
function encryption() {
  const key = randomBytes(32);
  return {
    encrypt(text) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decrypt(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}
test('token store persists encrypted keys and disabled state across reload, and deduplicates imports', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phom-keys-test-'));
  try {
    const config = { file: path.join(dir, 'keys.enc'), ...encryption() };
    const store = new TokenKeyStore(config);
    const first = await store.import(['PRIVATE_TOKEN_ONE', 'PRIVATE_TOKEN_ONE']);
    assert.equal(first.added, 1); assert.equal(first.duplicates, 1);
    await store.setEnabled(first.keys[0].id, false);
    assert.equal((await readFile(config.file)).includes(Buffer.from('PRIVATE_TOKEN_ONE')), false);
    const restored = new TokenKeyStore(config); const snapshot = await restored.snapshot();
    assert.equal(snapshot.keys[0].enabled, false); assert.equal(snapshot.keys[0].id, first.keys[0].id);
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE_TOKEN_ONE'), false);
    assert.equal((await restored.import(['PRIVATE_TOKEN_ONE'])).duplicates, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('unavailable OS encryption prevents persistence without plaintext fallback', async () => {
  const store = new TokenKeyStore({ file: 'unused', available: () => false });
  await assert.rejects(store.import(['secret']), /TOKEN_ENCRYPTION_UNAVAILABLE/);
  assert.deepEqual(store.pool.snapshot(), []);
});
test('concurrent imports are serialized and preserve both keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phom-keys-test-'));
  try {
    const store = new TokenKeyStore({ file: path.join(dir, 'keys.enc'), ...encryption() });
    await Promise.all([store.import(['secret-one']), store.import(['secret-two'])]);
    assert.equal((await store.snapshot()).keys.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
