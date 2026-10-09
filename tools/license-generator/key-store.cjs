'use strict';

// LOCAL key/user store for the generator (one JSON file, no network) — ADDED alongside the Google Sheet so the seller
// can manage issued keys locally (search · người dùng · thu hồi-ghi-chú · khôi phục · gia hạn · xóa). The Sheet stays
// the online ledger; this is the seller's own offline record. Written atomically.

const fs = require('node:fs');
const path = require('node:path');

function createKeyStore({ dir, now = () => new Date() }) {
  const file = path.join(dir, 'issued-keys.json');

  function read() { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.keys) ? j.keys : []; } catch { return []; } }
  function write(keys) { fs.mkdirSync(dir, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ v: 1, keys }, null, 1), 'utf8'); fs.renameSync(tmp, file); }

  function add(entry) { const keys = read(); keys.push({ status: 'ACTIVE', savedAt: now().toISOString(), ...entry }); write(keys); return entry; }
  function get(licenseId) { return read().find((k) => k.licenseId === licenseId) || null; }

  function setStatus(licenseId, status, reason = '') {
    const keys = read(); const k = keys.find((x) => x.licenseId === licenseId);
    if (!k) return { ok: false, found: false };
    k.status = status;
    if (status === 'REVOKED') { k.revokedAt = now().toISOString(); k.revokeReason = reason || ''; } else { delete k.revokedAt; delete k.revokeReason; }
    write(keys); return { ok: true, found: true };
  }
  function remove(licenseId) { const keys = read(); const next = keys.filter((k) => k.licenseId !== licenseId); if (next.length === keys.length) return { ok: false, found: false }; write(next); return { ok: true, found: true }; }

  // newest first; q matches licenseId / customerName / phone / machineId / gameProduct
  function list({ q = '', status = 'all', limit = 1000 } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    let rows = read().slice().reverse();
    if (status !== 'all') rows = rows.filter((k) => (k.status || 'ACTIVE') === status);
    if (needle) rows = rows.filter((k) => [k.licenseId, k.customerName, k.phone, k.machineId, k.gameProduct].filter(Boolean).join(' ').toLowerCase().includes(needle));
    return rows.slice(0, limit);
  }

  // users = keys grouped by customer name (fallback: machine)
  function users() {
    const byUser = new Map();
    for (const k of read()) { const name = (k.customerName && k.customerName.trim()) || k.machineId || '—'; if (!byUser.has(name)) byUser.set(name, []); byUser.get(name).push(k); }
    const out = [];
    for (const [name, keys] of byUser) {
      keys.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
      out.push({ name, phone: keys.map((k) => k.phone).find(Boolean) || '', machines: [...new Set(keys.map((k) => k.machineId).filter(Boolean))], keyCount: keys.length, activeCount: keys.filter((k) => (k.status || 'ACTIVE') === 'ACTIVE').length, keys });
    }
    return out.sort((a, b) => String(b.keys[0].savedAt || '').localeCompare(String(a.keys[0].savedAt || '')));
  }

  function stats() { const r = read(); return { total: r.length, active: r.filter((k) => (k.status || 'ACTIVE') === 'ACTIVE').length, revoked: r.filter((k) => k.status === 'REVOKED').length, users: users().length }; }

  return { add, get, setStatus, remove, list, users, stats, file, dir };
}

module.exports = { createKeyStore };
