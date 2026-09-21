'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { TokenKeyPool } = require('./token-key-pool.cjs');

// Disk persistence receives ciphertext only. Mutation is serialized and rolled
// back on failed writes; IPC callers see masked snapshots, never key values.
class TokenKeyStore {
  constructor({ file, encrypt, decrypt, available = () => true }) {
    this.file = file; this.encrypt = encrypt; this.decrypt = decrypt; this.available = available;
    this.pool = new TokenKeyPool(); this.loaded = false; this.queue = Promise.resolve();
  }
  run(action) {
    const result = this.queue.then(async () => {
      if (!this.available()) throw new Error('TOKEN_ENCRYPTION_UNAVAILABLE');
      if (!this.loaded) {
        let data;
        try { data = await fs.readFile(this.file); } catch (e) { if (e.code !== 'ENOENT') throw new Error('TOKEN_STORE_READ_FAILED'); }
        if (data) this.pool.restoreEncrypted(data, this.decrypt);
        this.loaded = true;
      }
      if (!action) return { keys: this.pool.snapshot(), scanAvailable: false };
      const backup = this.pool.encryptedBackup(this.encrypt);
      try {
        const result = action(this.pool);
        const encrypted = this.pool.encryptedBackup(this.encrypt);
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file + '.tmp', encrypted, { mode: 0o600 });
        await fs.rename(this.file + '.tmp', this.file);
        return { ...result, keys: this.pool.snapshot(), scanAvailable: false };
      } catch {
        this.pool.restoreEncrypted(backup, this.decrypt);
        throw new Error('TOKEN_STORE_UPDATE_FAILED');
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  snapshot() { return this.run(); }
  import(values) { return this.run((pool) => pool.import(values)); }
  setEnabled(id, enabled) { return this.run((pool) => { pool.setEnabled(id, enabled); return {}; }); }
}
module.exports = { TokenKeyStore };
