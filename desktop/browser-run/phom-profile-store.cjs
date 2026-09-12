'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeDeviceProfile, publicSnapshot } = require('./device-profile.cjs');

// ---------------------------------------------------------------------------
// PhomProfileStore — persists the three reusable Phỏm profiles (slot A/B/C), each
// binding a proxy REFERENCE and a normalized mobile device profile. Metadata only:
// NEVER a proxy password / account / token / cookie (secrets stay in
// ProxySecretStore). Small JSON file, atomic write. Device identity is STABLE across
// restarts (persisted), never re-randomized on reload.
//
// The device profile belongs to the BROWSER profile (slot), not to the HOST/FOLLOWER
// role — changing a slot's role never moves its device/proxy.
// ---------------------------------------------------------------------------

const SLOTS = Object.freeze(['A', 'B', 'C']);

class PhomProfileStore {
  constructor({ filePath = null } = {}) {
    this._filePath = filePath;
    this._map = new Map(); // slot -> profile
    this.load();
  }

  load() {
    if (!this._filePath) return { ok: true, firstRun: true };
    try {
      const data = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
      for (const p of (data && Array.isArray(data.profiles) ? data.profiles : [])) if (p && SLOTS.includes(p.slot)) this._map.set(p.slot, p);
      return { ok: true };
    } catch (e) { if (e && e.code === 'ENOENT') return { ok: true, firstRun: true }; return { ok: false, error: { code: 'PHOM_PROFILE_STORE_CORRUPT', message: String(e && e.message || e) } }; }
  }

  _persist() {
    if (!this._filePath) return;
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: [...this._map.values()] }, null, 2), 'utf8');
    fs.renameSync(tmp, this._filePath);
  }

  // Create/update a slot's profile. `input.device` may be a preset id (+overrides) or
  // an explicit device; it is normalized + validated (landscape invariant enforced).
  upsert(slot, input = {}) {
    if (!SLOTS.includes(slot)) return { ok: false, error: { code: 'PHOM_PROFILE_INVALID_SLOT', message: `slot must be A/B/C, got ${slot}` } };
    const existing = this._map.get(slot) || {};
    let device = existing.device || null;
    if (input.device) {
      // Preserve a stable device id across edits unless a fresh preset is chosen.
      const devInput = { ...input.device };
      if (existing.device && existing.device.id && !input.device.regenerate && (!input.device.presetId || input.device.presetId === existing.device.presetId)) devInput.id = existing.device.id;
      const norm = normalizeDeviceProfile(devInput);
      if (!norm.ok) return norm;
      device = norm.device;
    }
    const now = new Date().toISOString();
    const profile = {
      slot,
      name: input.name != null ? String(input.name) : (existing.name || `Profile ${slot}`),
      proxyRef: input.proxyRef !== undefined ? (input.proxyRef || null) : (existing.proxyRef || null),
      device,
      windowSlot: slot,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    this._map.set(slot, profile);
    this._persist();
    return { ok: true, profile: this.getPublic(slot) };
  }

  get(slot) { return this._map.get(slot) || null; }
  getPublic(slot) {
    const p = this.get(slot); if (!p) return null;
    return { slot: p.slot, name: p.name, proxyRef: p.proxyRef, device: p.device ? publicSnapshot(p.device) : null, windowSlot: p.windowSlot, createdAt: p.createdAt, updatedAt: p.updatedAt };
  }
  list() { return SLOTS.map((s) => this.getPublic(s)).filter(Boolean); }
  // Full device object (for CDP emulation) — never leaves main.
  deviceFor(slot) { const p = this.get(slot); return p ? p.device : null; }

  // Slots currently referencing a proxy id (used to guard proxy deletion).
  slotsUsingProxy(proxyId) { const id = String(proxyId); return SLOTS.filter((s) => { const p = this._map.get(s); return p && p.proxyRef === id; }); }

  remove(slot) { if (this._map.delete(slot)) { this._persist(); return { ok: true }; } return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `no profile for slot ${slot}` } }; }
}

module.exports = { PhomProfileStore, SLOTS };
