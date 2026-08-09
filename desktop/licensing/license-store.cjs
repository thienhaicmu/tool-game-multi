'use strict';

const fs = require('node:fs');
const path = require('node:path');

class LicenseStore {
  constructor({ licensePath, statePath, safeStorage = null } = {}) {
    this.licensePath = licensePath;
    this.statePath = statePath;
    this.safeStorage = safeStorage;
  }

  _canProtect() {
    return this.safeStorage && this.safeStorage.isEncryptionAvailable && this.safeStorage.isEncryptionAvailable();
  }

  _encode(value) {
    const text = JSON.stringify(value);
    if (this._canProtect()) return { protected: true, data: this.safeStorage.encryptString(text).toString('base64') };
    return { protected: false, data: Buffer.from(text, 'utf8').toString('base64') };
  }

  _decode(raw) {
    const box = JSON.parse(raw);
    if (box.protected) {
      if (!this._canProtect()) throw new Error('Protected data is unavailable');
      return JSON.parse(this.safeStorage.decryptString(Buffer.from(box.data, 'base64')));
    }
    return JSON.parse(Buffer.from(box.data, 'base64').toString('utf8'));
  }

  _read(file) {
    try { return this._decode(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  _write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this._encode(value)), 'utf8');
  }

  loadLicense() {
    const data = this._read(this.licensePath);
    return data && typeof data.license === 'string' ? data.license : null;
  }

  saveLicense(license) {
    this._write(this.licensePath, { license: String(license), savedAt: new Date().toISOString() });
  }

  loadState() {
    return this._read(this.statePath) || {};
  }

  saveState(state) {
    this._write(this.statePath, state || {});
  }
}

module.exports = { LicenseStore };
