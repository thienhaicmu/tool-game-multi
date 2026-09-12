'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// ProxySecretStore — keeps proxy passwords out of the config store, the command
// line, logs and IPC. It uses Electron safeStorage (OS-backed encryption) exactly
// like LicenseStore, but with a STRICTER policy for passwords (§8): if safeStorage
// is unavailable we NEVER write plaintext to disk — the password is kept in memory
// for this session only and the UI must re-collect it next launch.
//
// On disk we only ever persist the OS-encrypted ciphertext keyed by secretRef.
// ---------------------------------------------------------------------------

class ProxySecretStore {
  constructor({ filePath = null, safeStorage = null } = {}) {
    this._filePath = filePath;
    this._safeStorage = safeStorage;
    this._session = new Map(); // secretRef -> plaintext (memory only, never serialized)
  }

  _canProtect() {
    return !!(this._safeStorage && this._safeStorage.isEncryptionAvailable && this._safeStorage.isEncryptionAvailable());
  }

  capability() {
    return { persistent: this._canProtect(), backend: this._canProtect() ? 'safeStorage' : 'session-only' };
  }

  _readDisk() {
    if (!this._filePath) return {};
    try { return JSON.parse(fs.readFileSync(this._filePath, 'utf8')) || {}; } catch { return {}; }
  }
  _writeDisk(map) {
    if (!this._filePath) return;
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    fs.writeFileSync(this._filePath, JSON.stringify(map), 'utf8');
  }

  // Store a password for a secretRef. Persistent (encrypted) when safeStorage is
  // available; otherwise session-only. Returns how it was stored (no secret echoed).
  setPassword(secretRef, password) {
    const ref = String(secretRef || '');
    if (!ref) return { ok: false, error: { code: 'PROXY_CONFIG_INVALID', message: 'secretRef is required' } };
    if (password == null || String(password) === '') {
      this.deletePassword(ref);
      return { ok: true, stored: 'cleared' };
    }
    this._session.set(ref, String(password));
    if (this._canProtect()) {
      try {
        const map = this._readDisk();
        map[ref] = this._safeStorage.encryptString(String(password)).toString('base64');
        this._writeDisk(map);
        return { ok: true, stored: 'persistent' };
      } catch {
        return { ok: true, stored: 'session' }; // encryption failed at write — keep memory only
      }
    }
    return { ok: true, stored: 'session' };
  }

  // Resolve a password. Memory first (fresh submissions), then encrypted disk.
  getPassword(secretRef) {
    const ref = String(secretRef || '');
    if (!ref) return null;
    if (this._session.has(ref)) return this._session.get(ref);
    if (this._canProtect() && this._filePath) {
      const map = this._readDisk();
      const enc = map[ref];
      if (enc) {
        try { const pw = this._safeStorage.decryptString(Buffer.from(enc, 'base64')); this._session.set(ref, pw); return pw; } catch { return null; }
      }
    }
    return null;
  }

  hasPassword(secretRef) {
    const ref = String(secretRef || '');
    if (this._session.has(ref)) return true;
    if (this._canProtect() && this._filePath) return Object.prototype.hasOwnProperty.call(this._readDisk(), ref);
    return false;
  }

  deletePassword(secretRef) {
    const ref = String(secretRef || '');
    this._session.delete(ref);
    if (this._filePath) { const map = this._readDisk(); if (map[ref] != null) { delete map[ref]; this._writeDisk(map); } }
  }
}

module.exports = { ProxySecretStore };
