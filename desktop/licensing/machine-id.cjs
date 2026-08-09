'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const PRODUCT = 'WVPT';

function clean(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 3000, ...options });
  } catch {
    return '';
  }
}

function readMachineGuid() {
  if (process.platform !== 'win32') return '';
  const out = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
  const match = out.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
  return match ? clean(match[1]) : '';
}

function readSystemUuid() {
  if (process.platform !== 'win32') return '';
  const ps = run('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_ComputerSystemProduct).UUID"]);
  const uuid = ps.split(/\r?\n/).map(clean).find((line) => /^[0-9A-F-]{8,}$/.test(line) && !/^0+$/.test(line.replace(/-/g, '')));
  if (uuid) return uuid;
  const wmic = run('wmic', ['csproduct', 'get', 'uuid']);
  return wmic.split(/\r?\n/).map(clean).find((line) => /^[0-9A-F-]{8,}$/.test(line) && line !== 'UUID') || '';
}

function readVolumeSerial() {
  if (process.platform !== 'win32') return '';
  const drive = (process.env.SystemDrive || 'C:').replace(/\\$/, '');
  const out = run('cmd.exe', ['/c', 'vol', drive]);
  const match = out.match(/Serial Number is\s+([0-9A-F-]+)/i);
  return match ? clean(match[1]) : '';
}

function canonicalMachineInput(parts) {
  const fields = {
    MACHINEGUID: clean(parts.machineGuid),
    UUID: clean(parts.uuid),
    VOLUME: clean(parts.volume),
  };
  return `${PRODUCT}|MACHINEGUID=${fields.MACHINEGUID}|UUID=${fields.UUID}|VOLUME=${fields.VOLUME}`;
}

function publicDeviceIdFromCanonical(canonical) {
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').toUpperCase();
  const chunks = digest.slice(0, 16).match(/.{1,4}/g);
  return `${PRODUCT}-PC-${chunks.join('-')}`;
}

function buildMachineId(parts) {
  const normalized = {
    machineGuid: clean(parts.machineGuid),
    uuid: clean(parts.uuid),
    volume: clean(parts.volume),
  };
  const available = Object.values(normalized).filter(Boolean);
  if (!available.length) {
    return { ok: false, error: { code: 'MACHINE_ID_UNAVAILABLE', message: 'No stable Windows machine identifiers are available' } };
  }
  const canonical = canonicalMachineInput(normalized);
  return { ok: true, machineId: publicDeviceIdFromCanonical(canonical), canonical, components: Object.keys(normalized).filter((key) => normalized[key]) };
}

function getMachineId(deps = {}) {
  const collectors = deps.collectors || {};
  const parts = {
    machineGuid: collectors.machineGuid ? collectors.machineGuid() : readMachineGuid(),
    uuid: collectors.uuid ? collectors.uuid() : readSystemUuid(),
    volume: collectors.volume ? collectors.volume() : readVolumeSerial(),
  };
  const built = buildMachineId(parts);
  if (built.ok) return built;
  if (deps.allowNonWindowsFallback && process.platform !== 'win32') {
    return buildMachineId({ machineGuid: `DEV-${os.hostname()}`, uuid: '', volume: '' });
  }
  return built;
}

module.exports = { PRODUCT, clean, canonicalMachineInput, publicDeviceIdFromCanonical, buildMachineId, getMachineId };
