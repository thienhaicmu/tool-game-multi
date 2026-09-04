'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function readMachineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const { execFileSync } = require('node:child_process');
    return String(execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true, encoding: 'utf8' })).split(/\s{2,}/).pop().trim();
  } catch { return ''; }
}

function deviceFingerprint() {
  const parts = [os.hostname(), readMachineGuid(), os.arch(), os.platform()];
  try { parts.push(fs.statSync(path.parse(process.execPath).root).dev.toString()); } catch { /* best effort */ }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = { deviceFingerprint };
