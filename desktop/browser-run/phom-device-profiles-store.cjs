'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeDeviceProfile, publicSnapshot } = require('./device-profile.cjs');

// ---------------------------------------------------------------------------
// PhomDeviceProfilesStore (PHASE 6.3.1) — the CANONICAL flexible profile repository.
// A LIST of N device profiles (no fixed A/B/C slots): each profile has a STABLE id,
// a name, a normalized device (OS window ⟂ viewport, §6.2.4 model), and an optional
// proxy REFERENCE. Metadata only — never a proxy password/account/token (secrets stay
// in ProxySecretStore). Small JSON file, atomic write. Profile id is stable across
// restarts and unaffected by reorder/remove of other profiles.
//
// The SETUP table both MANAGES (add/edit/delete) and SELECTS profiles; the 3 ticked
// profiles become runtime browsers B1/B2/B3 (selection order → slot), decided by the
// caller — this store is pure persistence + validation.
// ---------------------------------------------------------------------------

function genId() { return 'prof-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

function publicOf(p) {
  if (!p) return null;
  return { id: p.id, name: p.name, proxyRef: p.proxyRef || null, gameUrl: p.gameUrl || null, device: p.device ? publicSnapshot(p.device) : null, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

class PhomDeviceProfilesStore {
  constructor({ filePath = null } = {}) {
    this._filePath = filePath;
    this._map = new Map();     // id -> profile (insertion order preserved)
    this.load();
  }

  load() {
    if (!this._filePath) return { ok: true, firstRun: true };
    try {
      const data = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
      for (const p of (data && Array.isArray(data.profiles) ? data.profiles : [])) if (p && p.id) this._map.set(String(p.id), p);
      return { ok: true };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, firstRun: true };
      return { ok: false, error: { code: 'PHOM_PROFILES_STORE_CORRUPT', message: String(e && e.message || e) } };
    }
  }

  _persist() {
    if (!this._filePath) return;
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: [...this._map.values()] }, null, 2), 'utf8');
    fs.renameSync(tmp, this._filePath);
  }

  // ---- read ----
  list() { return [...this._map.values()].map(publicOf); }        // creation order
  get(id) { return this._map.get(String(id)) || null; }
  getPublic(id) { return publicOf(this.get(id)); }
  deviceFor(id) { const p = this.get(id); return p ? p.device : null; } // full device (CDP) — never leaves main
  has(id) { return this._map.has(String(id)); }
  count() { return this._map.size; }

  // ---- write ----
  // create — `input.device` is a preset id (+overrides) OR explicit dims; normalized + validated
  // (landscape invariant on the VIEWPORT; OS window is an independent axis). Gets a fresh stable id.
  create(input = {}) {
    const norm = normalizeDeviceProfile({ ...(input.device || {}), name: input.name != null ? input.name : (input.device && input.device.name) });
    if (!norm.ok) return norm;
    const id = genId();
    const now = new Date().toISOString();
    const profile = {
      id, name: input.name != null ? String(input.name) : norm.device.name,
      proxyRef: input.proxyRef != null ? String(input.proxyRef) : null,
      // The game URL is remembered per profile so it is never re-typed on the next app launch (§6.3.2-fix).
      gameUrl: input.gameUrl != null && String(input.gameUrl).trim() ? String(input.gameUrl).trim() : null,
      device: { ...norm.device, id }, createdAt: now, updatedAt: now,
    };
    this._map.set(id, profile);
    this._persist();
    return { ok: true, profile: publicOf(profile) };
  }

  // update — merge patch; the device id is preserved (stable identity across edits, §6/§10).
  update(id, patch = {}) {
    const existing = this._map.get(String(id));
    if (!existing) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `no profile ${id}` } };
    let device = existing.device;
    if (patch.device) {
      const devInput = { ...existing.device, ...stripUndefined(patch.device), id: existing.device && existing.device.id };
      const norm = normalizeDeviceProfile(devInput);
      if (!norm.ok) return norm;
      device = { ...norm.device, id: existing.device ? existing.device.id : norm.device.id };
    }
    const profile = {
      ...existing,
      name: patch.name != null ? String(patch.name) : existing.name,
      proxyRef: patch.proxyRef !== undefined ? (patch.proxyRef || null) : existing.proxyRef,
      gameUrl: patch.gameUrl !== undefined ? (patch.gameUrl && String(patch.gameUrl).trim() ? String(patch.gameUrl).trim() : null) : (existing.gameUrl || null),
      device, updatedAt: new Date().toISOString(),
    };
    this._map.set(String(id), profile);
    this._persist();
    return { ok: true, profile: publicOf(profile) };
  }

  // Bind a proxy reference to a profile (used by bulk-proxy apply). Clears with null.
  setProxyRef(id, proxyRef) { return this.update(id, { proxyRef: proxyRef || null }); }

  remove(id) {
    if (this._map.delete(String(id))) { this._persist(); return { ok: true }; }
    return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `no profile ${id}` } };
  }

  // Profiles currently referencing a proxy id (guards proxy deletion).
  profilesUsingProxy(proxyId) { const id = String(proxyId); return [...this._map.values()].filter((p) => p.proxyRef === id).map((p) => p.id); }
}

function stripUndefined(o) { const r = {}; for (const k of Object.keys(o || {})) if (o[k] !== undefined) r[k] = o[k]; return r; }

module.exports = { PhomDeviceProfilesStore };
