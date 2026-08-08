'use strict';

const fs = require('node:fs');
const path = require('node:path');

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

class RuntimeLock {
  constructor(file, data = {}) {
    this.file = file;
    this.data = { ...data };
    this.acquired = false;
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = { ...this.data, pid: process.pid, startedAt: new Date().toISOString() };
    if (fs.existsSync(this.file)) {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { current = null; }
      if (current && processAlive(current.pid)) {
        return { ok: false, error: { code: 'INSTANCE_ALREADY_RUNNING', message: `Instance is already running in pid ${current.pid}`, lock: current } };
      }
      try { fs.unlinkSync(this.file); } catch { /* stale lock cleanup best effort */ }
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
      this.acquired = true;
      this.data = payload;
      return { ok: true, lock: payload };
    } catch (e) {
      return { ok: false, error: { code: 'INSTANCE_LOCK_FAILED', message: String(e && e.message || e) } };
    }
  }

  update(patch = {}) {
    if (!this.acquired) return;
    this.data = { ...this.data, ...patch, updatedAt: new Date().toISOString() };
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8'); } catch { /* best effort */ }
  }

  release() {
    if (!this.acquired) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Number(current.pid) === process.pid) fs.unlinkSync(this.file);
    } catch { /* best effort */ }
    this.acquired = false;
  }
}

module.exports = { RuntimeLock, processAlive };
