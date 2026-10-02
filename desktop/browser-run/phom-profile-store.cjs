'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeAgent, publicSnapshot } = require('./browser-agent.cjs');

// ---------------------------------------------------------------------------
// PhomProfileStore — persists the three reusable Phỏm profiles (slot A/B/C), each
// binding a proxy REFERENCE and a browser AGENT (web or mobile — browser-agent.cjs).
// Metadata only: NEVER a proxy password / account / token / cookie (secrets stay in
// ProxySecretStore). Small JSON file, atomic write.
//
// The agent belongs to the BROWSER profile (slot), not to a role — changing a slot's
// role never moves its agent/proxy. Records saved under the old device model are
// migrated on read (their mobile/userAgent decides the agent).
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
      let migrated = false;
      for (const p of (data && Array.isArray(data.profiles) ? data.profiles : [])) {
        if (!p || !SLOTS.includes(p.slot)) continue;
        // A record saved under the device model keeps only its agent (see browser-agent.cjs).
        const rec = { slot: p.slot, name: p.name, proxyRef: p.proxyRef || null, agent: this._agentOf(p), windowSlot: p.windowSlot || p.slot, createdAt: p.createdAt, updatedAt: p.updatedAt };
        if (p.device !== undefined || p.agent !== rec.agent) migrated = true;
        this._map.set(rec.slot, rec);
      }
      if (migrated) { try { this._persist(); } catch { /* the next write migrates it */ } }
      return { ok: true, migrated };
    } catch (e) { if (e && e.code === 'ENOENT') return { ok: true, firstRun: true }; return { ok: false, error: { code: 'PHOM_PROFILE_STORE_CORRUPT', message: String(e && e.message || e) } }; }
  }

  _persist() {
    if (!this._filePath) return;
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: [...this._map.values()] }, null, 2), 'utf8');
    fs.renameSync(tmp, this._filePath);
  }

  // Create/update a slot's profile. `input.agent` is 'WEB' or 'MOBILE' (absent keeps
  // what the slot has, or the default for a new slot).
  upsert(slot, input = {}) {
    if (!SLOTS.includes(slot)) return { ok: false, error: { code: 'PHOM_PROFILE_INVALID_SLOT', message: `slot must be A/B/C, got ${slot}` } };
    const existing = this._map.get(slot) || {};
    let agent = this._agentOf(existing);
    if (input.agent !== undefined || input.device !== undefined) {
      const norm = normalizeAgent(input.agent !== undefined ? input.agent : input.device);
      if (!norm.ok) return norm;
      agent = norm.agent;
    }
    const now = new Date().toISOString();
    const profile = {
      slot,
      name: input.name != null ? String(input.name) : (existing.name || `Profile ${slot}`),
      proxyRef: input.proxyRef !== undefined ? (input.proxyRef || null) : (existing.proxyRef || null),
      agent,
      windowSlot: slot,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    this._map.set(slot, profile);
    this._persist();
    return { ok: true, profile: this.getPublic(slot) };
  }

  // The agent of a stored record, migrating a legacy device object when that is all it has.
  _agentOf(p) {
    if (!p || (p.agent == null && p.device == null)) return null;
    const norm = normalizeAgent(p.agent != null ? p.agent : p.device);
    return norm.ok ? norm.agent : null;
  }

  get(slot) { return this._map.get(slot) || null; }
  getPublic(slot) {
    const p = this.get(slot); if (!p) return null;
    const agent = this._agentOf(p);
    return { slot: p.slot, name: p.name, proxyRef: p.proxyRef, agent, device: agent ? publicSnapshot(agent) : null, windowSlot: p.windowSlot, createdAt: p.createdAt, updatedAt: p.updatedAt };
  }
  list() { return SLOTS.map((s) => this.getPublic(s)).filter(Boolean); }
  // The agent to apply over CDP for this slot ('WEB' | 'MOBILE' | null when unset).
  agentFor(slot) { return this._agentOf(this.get(slot)); }

  // Slots currently referencing a proxy id (used to guard proxy deletion).
  slotsUsingProxy(proxyId) { const id = String(proxyId); return SLOTS.filter((s) => { const p = this._map.get(s); return p && p.proxyRef === id; }); }

  remove(slot) { if (this._map.delete(slot)) { this._persist(); return { ok: true }; } return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `no profile for slot ${slot}` } }; }
}

module.exports = { PhomProfileStore, SLOTS };
