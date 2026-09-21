'use strict';

const { randomUUID } = require('node:crypto');
class TokenKeyPool {
  #keys = [];
  #cursor = 0;
  constructor({ now = Date.now } = {}) { this.now = now; }
  import(values) {
    const existing = new Set(this.#keys.map((k) => k.value));
    let added = 0; let duplicates = 0;
    for (const input of values) {
      if (typeof input !== 'string' || !input.trim()) continue;
      const value = input.trim();
      if (existing.has(value)) { duplicates++; continue; }
      this.#keys.push({ id: randomUUID(), value, enabled: true, status: 'READY', failureCount: 0, cooldownUntil: null });
      existing.add(value); added++;
    }
    return { added, duplicates };
  }
  setEnabled(id, enabled) {
    const k = this.#keys.find((k) => k.id === id);
    if (!k) throw new TypeError('TOKEN_KEY_NOT_FOUND');
    if (k.status === 'IN_USE') throw new Error('TOKEN_KEY_IN_USE');
    k.enabled = !!enabled; k.status = enabled ? 'READY' : 'DISABLED'; k.cooldownUntil = null;
  }
  acquire() {
    if (this.#keys.some((k) => k.status === 'IN_USE')) return null;
    for (let n = 0; n < this.#keys.length; n++) {
      const i = (this.#cursor + n) % this.#keys.length; const k = this.#keys[i];
      if (k.enabled && k.status === 'COOLDOWN' && k.cooldownUntil <= this.now()) { k.status = 'READY'; k.cooldownUntil = null; }
      if (!k.enabled || k.status !== 'READY') continue;
      k.status = 'IN_USE'; this.#cursor = (i + 1) % this.#keys.length;
      // The raw value is handed only to the transport, never to snapshots.
      return { id: k.id, value: k.value };
    }
    return null;
  }
  release(id, outcome = 'OK', cooldownMs = 5000) {
    const k = this.#keys.find((k) => k.id === id);
    if (!k || k.status !== 'IN_USE') return;
    if (!['OK', 'ABORTED'].includes(outcome)) k.failureCount++;
    k.status = outcome === 'TOKEN_INVALID' ? 'INVALID' : ['TOKEN_RATE_LIMITED', 'TOKEN_TIMEOUT'].includes(outcome) ? 'COOLDOWN' : 'READY';
    k.cooldownUntil = k.status === 'COOLDOWN' ? this.now() + cooldownMs : null;
  }
  snapshot() {
    return this.#keys.map(({ value, ...meta }, i) => ({ ...meta, label: `Key ${String(i + 1).padStart(2, '0')} ••••${value.length > 4 ? value.slice(-4) : ''}` }));
  }
  encryptedBackup(encrypt) {
    return encrypt(JSON.stringify({ keys: this.#keys.map(({ id, value, enabled }) => ({ id, value, enabled })), cursor: this.#cursor }));
  }
  restoreEncrypted(ciphertext, decrypt) {
    const data = JSON.parse(decrypt(ciphertext));
    if (!data || !Array.isArray(data.keys) || data.keys.some((k) => typeof k.id !== 'string' || typeof k.value !== 'string' || !k.value.trim() || typeof k.enabled !== 'boolean')
      || new Set(data.keys.map((k) => k.id)).size !== data.keys.length || new Set(data.keys.map((k) => k.value)).size !== data.keys.length) throw new Error('TOKEN_STORE_INVALID');
    this.#keys = data.keys.map(({ id, value, enabled }) => ({ id, value, enabled, status: enabled ? 'READY' : 'DISABLED', failureCount: 0, cooldownUntil: null }));
    this.#cursor = Number.isSafeInteger(data.cursor) && data.cursor >= 0 && data.cursor < this.#keys.length ? data.cursor : 0;
  }
}
module.exports = { TokenKeyPool };
