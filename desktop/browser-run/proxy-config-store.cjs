'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeProxyConfig, publicSnapshot } = require('./proxy-config.cjs');

// ---------------------------------------------------------------------------
// ProxyConfigStore — persists proxy METADATA only (never a password). Passwords
// live behind passwordSecretRef in ProxySecretStore. One small JSON file, atomic
// write. Modeled on the repo's other JSON stores (browser-config-store).
// ---------------------------------------------------------------------------

class ProxyConfigStore {
  constructor({ filePath = null, secretStore = null } = {}) {
    this._filePath = filePath;
    this._secretStore = secretStore;
    this._map = new Map(); // id -> config (metadata only)
    this.load();
  }

  load() {
    if (!this._filePath) return { ok: true, firstRun: true };
    try {
      const data = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
      for (const c of (data && Array.isArray(data.proxies) ? data.proxies : [])) if (c && c.id) this._map.set(String(c.id), c);
      return { ok: true };
    } catch (e) { if (e && e.code === 'ENOENT') return { ok: true, firstRun: true }; return { ok: false, error: { code: 'PROXY_STORE_CORRUPT', message: String(e && e.message || e) } }; }
  }

  _persist() {
    if (!this._filePath) return;
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    // Only metadata is ever serialized — passwordSecretRef is a reference, not a secret.
    const proxies = [...this._map.values()];
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, proxies }, null, 2), 'utf8');
    fs.renameSync(tmp, this._filePath);
  }

  // Create/update from raw input. Routes any plaintext password to the secret store
  // and persists ONLY the metadata + secretRef.
  upsert(input = {}) {
    const norm = normalizeProxyConfig(input);
    if (!norm.ok) return norm;
    const { config, secret } = norm;
    if (secret != null && this._secretStore) {
      const res = this._secretStore.setPassword(config.passwordSecretRef, secret);
      if (res && res.ok === false) return res;
    }
    this._map.set(config.id, config);
    this._persist();
    return { ok: true, config: publicSnapshot(config), id: config.id };
  }

  get(id) { return this._map.get(String(id)) || null; }
  getPublic(id) { const c = this.get(id); return c ? publicSnapshot(c) : null; }
  list() { return [...this._map.values()].map(publicSnapshot); }

  remove(id) {
    const c = this.get(id);
    if (!c) return { ok: false, error: { code: 'PROXY_CONFIG_NOT_FOUND', message: `No such proxy: ${id}` } };
    if (c.passwordSecretRef && this._secretStore) this._secretStore.deletePassword(c.passwordSecretRef);
    this._map.delete(String(id));
    this._persist();
    return { ok: true };
  }

  // Resolve the plaintext password for a config (transport/auth only — never returned to UI).
  resolvePassword(id) {
    const c = this.get(id);
    if (!c || !c.passwordSecretRef || !this._secretStore) return null;
    return this._secretStore.getPassword(c.passwordSecretRef);
  }
}

module.exports = { ProxyConfigStore };
