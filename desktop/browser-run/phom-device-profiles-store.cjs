'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeAgent, publicSnapshot } = require('./browser-agent.cjs');

// ---------------------------------------------------------------------------
// PhomProfilesStore — the CANONICAL profile repository. A LIST of N profiles (no fixed
// A/B/C slots): each profile has a STABLE id, a name, a browser AGENT (web or mobile —
// the only rendering choice left, see browser-agent.cjs), a saved game URL and an
// optional proxy REFERENCE. Metadata only — never a proxy password/account/token
// (secrets stay in ProxySecretStore). Small JSON file, atomic write. Profile id is
// stable across restarts and unaffected by reorder/remove of other profiles.
//
// Profiles saved before the device model was removed carry a `device` object; it is
// migrated on read — its mobile/userAgent decides the agent, everything else (viewport,
// screen, scale, touch, OS window) is dropped, because the window is the viewport now.
//
// The SETUP table both MANAGES (add/edit/delete) and SELECTS profiles; the 3 ticked
// profiles become runtime browsers B1/B2/B3 (selection order → slot), decided by the
// caller — this store is pure persistence + validation.
// ---------------------------------------------------------------------------

function genId() { return 'prof-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

// Agent of a stored record, migrating a legacy `device` object when that is all it has.
function agentOf(p) {
  if (!p) return null;
  const norm = normalizeAgent(p.agent != null ? p.agent : p.device);
  return norm.ok ? norm.agent : null;
}

function publicOf(p) {
  if (!p) return null;
  const agent = agentOf(p);
  return { id: p.id, name: p.name, proxyRef: p.proxyRef || null, gameUrl: p.gameUrl || null, agent, device: publicSnapshot(agent), createdAt: p.createdAt, updatedAt: p.updatedAt };
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
      let migrated = false;
      for (const p of (data && Array.isArray(data.profiles) ? data.profiles : [])) {
        if (!p || !p.id) continue;
        // A record saved under the device model keeps only its agent from here on; the
        // viewport/screen/scale/touch/OS-window fields are dropped (the window is the viewport).
        const rec = { id: String(p.id), name: p.name, proxyRef: p.proxyRef || null, gameUrl: p.gameUrl || null, agent: agentOf(p), createdAt: p.createdAt, updatedAt: p.updatedAt };
        if (p.device !== undefined || p.agent !== rec.agent) migrated = true;
        this._map.set(rec.id, rec);
      }
      if (migrated) { try { this._persist(); } catch { /* the next write migrates it */ } }
      return { ok: true, migrated };
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
  agentFor(id) { return agentOf(this.get(id)); }                  // 'WEB' | 'MOBILE' | null
  has(id) { return this._map.has(String(id)); }
  count() { return this._map.size; }

  // ---- write ----
  // create — `input.agent` is 'WEB' or 'MOBILE' (absent = the default). Gets a fresh stable id.
  create(input = {}) {
    const norm = normalizeAgent(input.agent != null ? input.agent : input.device);
    if (!norm.ok) return norm;
    const id = genId();
    const now = new Date().toISOString();
    const profile = {
      id, name: input.name != null ? String(input.name) : 'Profile',
      proxyRef: input.proxyRef != null ? String(input.proxyRef) : null,
      // The game URL is remembered per profile so it is never re-typed on the next app launch (§6.3.2-fix).
      gameUrl: input.gameUrl != null && String(input.gameUrl).trim() ? String(input.gameUrl).trim() : null,
      agent: norm.agent, createdAt: now, updatedAt: now,
    };
    this._map.set(id, profile);
    this._persist();
    return { ok: true, profile: publicOf(profile) };
  }

  // update — merge patch; the profile id (and with it the Chromium user-data-dir) never changes.
  update(id, patch = {}) {
    const existing = this._map.get(String(id));
    if (!existing) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `no profile ${id}` } };
    let agent = agentOf(existing);
    if (patch.agent !== undefined || patch.device !== undefined) {
      const norm = normalizeAgent(patch.agent !== undefined ? patch.agent : patch.device);
      if (!norm.ok) return norm;
      agent = norm.agent;
    }
    const profile = {
      ...existing,
      name: patch.name != null ? String(patch.name) : existing.name,
      proxyRef: patch.proxyRef !== undefined ? (patch.proxyRef || null) : existing.proxyRef,
      gameUrl: patch.gameUrl !== undefined ? (patch.gameUrl && String(patch.gameUrl).trim() ? String(patch.gameUrl).trim() : null) : (existing.gameUrl || null),
      agent, updatedAt: new Date().toISOString(),
    };
    delete profile.device; // a migrated record keeps only its agent
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

module.exports = { PhomDeviceProfilesStore };
