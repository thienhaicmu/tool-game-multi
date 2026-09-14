'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');
const model = require('./phom-cluster-profile.cjs');

// ---------------------------------------------------------------------------
// PhomClusterProfileStore — persists MANY PhomClusterProfiles (see
// phom-cluster-profile.cjs) plus the currently-selected id. One small JSON file in
// the Phom QA userData namespace, written atomically (temp + rename). Modeled on the
// repo's other JSON stores (proxy-config-store / browser-config-store / phom-profile-
// store): missing file = valid first-run; a corrupt file is NEVER silently
// overwritten — it is backed up aside and the store continues empty.
//
// It persists METADATA + REFERENCES only (a cluster profile has no secret by design)
// and NEVER live runtime state (BrowserRun id, CDP port, PID, target/session, hand/
// join/ready). Reference INTEGRITY (browser profile / device / proxy existence) is
// decided against injected resolvers so this store never imports the other stores;
// the runtime active-session guard is an injected predicate for the same reason.
//
// This store is PART OF the Phom QA product only: it is not the Analytics database
// and is never surfaced to the Control product.
// ---------------------------------------------------------------------------

const { SLOTS } = model;

function err(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }

class PhomClusterProfileStore {
  constructor(deps = {}) {
    this._fs = deps.fs || fsDefault;
    this._filePath = deps.filePath || null;
    this._now = deps.now || (() => new Date().toISOString());
    // Injected reference resolvers (return metadata objects or null). Kept as deps so
    // this store never imports PhomProfileStore / ProxyConfigStore directly.
    this._resolveBrowserProfile = deps.resolveBrowserProfile || (() => null); // (browserProfileId) -> profile|null
    this._resolveDevice = deps.resolveDevice || (() => null);                 // (browserProfileId, deviceProfileId) -> device|null
    this._resolveProxy = deps.resolveProxy || (() => null);                   // (proxyRef) -> proxy|null
    // Injected runtime guard: true when a live ClusterSession references this profile.
    this._isActive = deps.isActive || (() => false);                          // (clusterProfileId) -> boolean
    // Injected migration source (existing per-slot Phom selections). Optional.
    this._migrationSource = deps.migrationSource || (() => null);             // () -> { slots:{A:{deviceProfileId,proxyRef},...} } | null

    this._map = new Map();     // id -> profile
    this._selectedId = null;
    this._migratedDefault = false;
    this._corrupt = false;
    this._corruptError = null;
    this._loaded = false;
  }

  // ---- load / recovery ----
  load() {
    this._loaded = true;
    this._map = new Map();
    this._selectedId = null;
    this._migratedDefault = false;
    this._corrupt = false;
    this._corruptError = null;
    if (!this._filePath) return { ok: true, firstRun: true };
    let raw;
    try { raw = this._fs.readFileSync(this._filePath, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return { ok: true, firstRun: true }; return this._recover('Could not read store: ' + safe(e)); }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return this._recover('Store file is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.profiles)) return this._recover('Store file has an invalid shape');
    // Schema check: a future version we cannot understand is treated as corrupt/
    // unsupported rather than silently downgraded.
    const ver = Number(parsed.schemaVersion) || 0;
    if (ver > model.SCHEMA_VERSION) { this._corrupt = true; this._corruptError = err('PHOM_CLUSTER_PROFILE_SCHEMA_UNSUPPORTED', `Unsupported store schema ${ver}`).error; return { ok: false, error: this._corruptError }; }
    // Re-normalize every stored profile through the model (drops unknown/runtime fields,
    // re-validates structure). A structurally-bad stored entry is skipped, never trusted.
    for (const entry of parsed.profiles) {
      const res = model.normalizeClusterProfile(entry, { existing: entry });
      if (!res.ok) continue; // drop corrupt entry (kept out of runtime), do not abort the load
      const p = res.profile;
      p.createdAt = isString(entry.createdAt) ? entry.createdAt : this._now();
      p.updatedAt = isString(entry.updatedAt) ? entry.updatedAt : p.createdAt;
      this._map.set(p.id, p);
    }
    this._selectedId = isString(parsed.selectedId) && this._map.has(parsed.selectedId) ? parsed.selectedId : null;
    this._migratedDefault = parsed.migratedDefault === true;
    return { ok: true, migratedFrom: ver !== model.SCHEMA_VERSION ? ver : undefined };
  }

  // A corrupt/unreadable file is backed up aside (never discarded), and the store
  // continues EMPTY so the app stays usable. The next write persists cleanly.
  _recover(message) {
    this._corrupt = false; // we recover into a clean empty state
    try {
      if (this._filePath && this._fs.existsSync(this._filePath)) {
        const backup = `${this._filePath}.corrupt-${Date.now()}`;
        this._fs.renameSync(this._filePath, backup);
        this._corruptError = { code: 'PHOM_CLUSTER_PROFILE_STORE_RECOVERED', message, backup };
      }
    } catch { /* best effort — still continue empty */ }
    this._map = new Map();
    this._selectedId = null;
    this._migratedDefault = false;
    return { ok: true, recovered: true, error: this._corruptError };
  }

  _ensureLoaded() { if (!this._loaded) this.load(); }

  _persist() {
    if (!this._filePath) return { ok: true };
    // Deterministic ordering: by createdAt, then id (stable across restarts).
    const profiles = [...this._map.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || String(a.id).localeCompare(String(b.id)));
    const data = { schemaVersion: model.SCHEMA_VERSION, profiles, selectedId: this._selectedId || null, migratedDefault: this._migratedDefault === true };
    try {
      this._fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      const tmp = this._filePath + '.tmp';
      this._fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      this._fs.renameSync(tmp, this._filePath);
      return { ok: true };
    } catch (e) { return err('PHOM_CLUSTER_PROFILE_STORE_FAILED', 'Could not persist cluster profiles: ' + safe(e)); }
  }

  // ---- reads ----
  get(id) { this._ensureLoaded(); return this._map.get(String(id)) || null; }
  getPublic(id) { const p = this.get(id); return p ? model.publicSnapshot(p, { state: this._stateOf(p) }) : null; }
  list() { this._ensureLoaded(); return this._ordered().map((p) => model.publicSnapshot(p, { state: this._stateOf(p) })); }
  _ordered() { return [...this._map.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || String(a.id).localeCompare(String(b.id))); }

  getSelected() { this._ensureLoaded(); return this._selectedId && this._map.has(this._selectedId) ? this.getPublic(this._selectedId) : null; }
  selectedId() { this._ensureLoaded(); return this._selectedId && this._map.has(this._selectedId) ? this._selectedId : null; }

  // Resolve references for one profile and derive its state (no secret is ever read
  // into the result — proxy resolution only confirms existence).
  _resolveRefs(profile) {
    const proxyMissing = [], browserMissing = [], deviceMissing = [];
    const slots = {};
    for (const s of SLOTS) {
      const slot = profile.slots[s];
      const browserProfile = slot.browserProfileId ? this._resolveBrowserProfile(slot.browserProfileId) : null;
      const device = (browserProfile && slot.deviceProfileId) ? this._resolveDevice(slot.browserProfileId, slot.deviceProfileId) : null;
      const hasRef = !!slot.proxyRef;
      const proxyExists = hasRef ? !!this._resolveProxy(slot.proxyRef) : false;
      if (!browserProfile) browserMissing.push(s);
      if (!device) deviceMissing.push(s);
      // Proxy is OPTIONAL: a null proxyRef => DIRECT (valid). Only a DANGLING ref (set
      // but unresolvable) counts as missing/not-ready.
      if (hasRef && !proxyExists) proxyMissing.push(s);
      slots[s] = { browserProfile, device, proxyRef: slot.proxyRef || null, proxyExists, executionMode: hasRef ? 'PROXY' : 'DIRECT' };
    }
    const state = model.deriveState(profile, { proxyMissing, browserMissing, deviceMissing });
    return { slots, proxyMissing, browserMissing, deviceMissing, state };
  }

  _stateOf(profile) { try { return this._resolveRefs(profile).state; } catch { return model.deriveState(profile); } }

  // ---- writes ----
  create(input = {}) {
    this._ensureLoaded();
    const res = model.normalizeClusterProfile(input || {}, { existing: null });
    if (!res.ok) return res;
    const p = res.profile;
    if (this._map.has(p.id)) return err('PHOM_CLUSTER_PROFILE_EXISTS', `A cluster profile with id ${p.id} already exists`);
    const now = this._now();
    p.createdAt = now; p.updatedAt = now;
    this._map.set(p.id, p);
    const w = this._persist();
    if (!w.ok) { this._map.delete(p.id); return w; }
    return { ok: true, profile: this.getPublic(p.id) };
  }

  update(id, patch = {}) {
    this._ensureLoaded();
    const existing = this.get(id);
    if (!existing) return err('PHOM_CLUSTER_PROFILE_NOT_FOUND', `No cluster profile: ${id}`);
    // The id and createdAt are immutable; a renderer can never set runtime fields
    // because normalizeClusterProfile only ever keeps the whitelisted model fields.
    const res = model.normalizeClusterProfile({ ...(patch || {}), id: existing.id }, { existing });
    if (!res.ok) return res;
    const p = res.profile;
    p.createdAt = existing.createdAt;
    p.updatedAt = this._now();
    const prev = existing;
    this._map.set(p.id, p);
    const w = this._persist();
    if (!w.ok) { this._map.set(prev.id, prev); return w; }
    return { ok: true, profile: this.getPublic(p.id) };
  }

  delete(id) {
    this._ensureLoaded();
    const sid = String(id);
    const existing = this._map.get(sid);
    if (!existing) return err('PHOM_CLUSTER_PROFILE_NOT_FOUND', `No cluster profile: ${id}`);
    // §7 — a cluster profile backing a live ClusterSession cannot be deleted (stop it
    // first). The referenced browser/device/proxy objects are NEVER deleted here.
    if (this._isActive(sid)) return err('PHOM_CLUSTER_PROFILE_IN_USE', 'Cluster profile is in use by an active session; stop it first', { id: sid });
    this._map.delete(sid);
    const clearedSelection = this._selectedId === sid;
    if (clearedSelection) this._selectedId = null;
    const w = this._persist();
    if (!w.ok) { this._map.set(sid, existing); if (clearedSelection) this._selectedId = sid; return w; }
    return { ok: true, deleted: sid, clearedSelection };
  }

  duplicate(id, newName) {
    this._ensureLoaded();
    const existing = this.get(id);
    if (!existing) return err('PHOM_CLUSTER_PROFILE_NOT_FOUND', `No cluster profile: ${id}`);
    if (!isString(newName) || !newName.trim()) return err('PHOM_CLUSTER_PROFILE_NAME_REQUIRED', 'A new name is required to duplicate');
    // Copy ONLY references (browser/device/proxy ids) + settings — no runtime state,
    // no secret value (proxyRef is a reference, resolved at runtime). Fresh id/timestamps.
    const res = model.normalizeClusterProfile({
      name: newName,
      gameUrl: existing.gameUrl,
      defaultHostSlot: existing.defaultHostSlot,
      defaultStake: existing.defaultStake,
      slots: {
        A: { ...existing.slots.A },
        B: { ...existing.slots.B },
        C: { ...existing.slots.C },
      },
    }, { existing: null });
    if (!res.ok) return res;
    const p = res.profile;
    const now = this._now();
    p.createdAt = now; p.updatedAt = now;
    this._map.set(p.id, p);
    const w = this._persist();
    if (!w.ok) { this._map.delete(p.id); return w; }
    return { ok: true, profile: this.getPublic(p.id) };
  }

  // ---- selection ----
  select(id) {
    this._ensureLoaded();
    const sid = String(id);
    if (!this._map.has(sid)) return err('PHOM_CLUSTER_PROFILE_NOT_FOUND', `No cluster profile: ${id}`);
    this._selectedId = sid;
    const w = this._persist();
    if (!w.ok) return w;
    return { ok: true, selectedId: sid, profile: this.getPublic(sid) };
  }
  clearSelection() {
    this._ensureLoaded();
    this._selectedId = null;
    const w = this._persist();
    if (!w.ok) return w;
    return { ok: true };
  }

  // ---- readiness / projection ----
  // validateReady(id) -> { ok, state, ready, missing, errors }. `ok` is true only when
  // the profile is READY_TO_RUN (url present + all refs resolve). Never throws.
  validateReady(id) {
    this._ensureLoaded();
    const p = this.get(id);
    if (!p) return err('PHOM_CLUSTER_PROFILE_NOT_FOUND', `No cluster profile: ${id}`);
    const r = this._resolveRefs(p);
    const errors = [];
    if (!p.gameUrl) errors.push({ code: 'PHOM_CLUSTER_GAME_URL_INVALID', message: 'gameUrl is required to run', field: 'gameUrl' });
    for (const s of r.browserMissing) errors.push({ code: 'PHOM_CLUSTER_BROWSER_PROFILE_MISSING', message: `browser profile missing for slot ${s}`, slot: s });
    for (const s of r.deviceMissing) errors.push({ code: 'PHOM_CLUSTER_DEVICE_PROFILE_MISSING', message: `device missing for slot ${s}`, slot: s });
    for (const s of r.proxyMissing) errors.push({ code: 'PHOM_CLUSTER_PROXY_MISSING', message: `proxy missing for slot ${s}`, slot: s });
    const ready = r.state === 'READY_TO_RUN' && errors.length === 0;
    return { ok: ready, state: r.state, ready, missing: { gameUrl: !p.gameUrl, browser: r.browserMissing, device: r.deviceMissing, proxy: r.proxyMissing }, errors };
  }

  // toRuntimeConfig(id) -> { ok, config } | typed error. Resolves references, then
  // delegates to the PURE projection. Rejects unless READY_TO_RUN. Never mutates the
  // stored profile; never includes a secret.
  toRuntimeConfig(id) {
    this._ensureLoaded();
    const p = this.get(id);
    if (!p) return err('PHOM_CLUSTER_PROFILE_NOT_FOUND', `No cluster profile: ${id}`);
    const r = this._resolveRefs(p);
    const resolved = { slots: {} };
    for (const s of SLOTS) resolved.slots[s] = { browserProfile: r.slots[s].browserProfile, device: r.slots[s].device, proxyRef: r.slots[s].proxyExists ? p.slots[s].proxyRef : null };
    return model.toClusterRuntimeConfig(p, resolved);
  }

  // ---- migration ----
  // Additive + idempotent. If NO cluster profiles exist and we have not already
  // migrated, AND the existing per-slot Phom selections form three resolvable browser
  // profiles, create ONE default cluster profile (DRAFT if no gameUrl/proxy yet). It
  // never invents a fake game URL and never opens a browser. Running it again is a
  // no-op (a persisted marker prevents re-creating after the user deletes it).
  migrate(opts = {}) {
    this._ensureLoaded();
    if (this._map.size > 0) { this._markMigrated(); return { ok: true, migrated: false, reason: 'PROFILES_PRESENT' }; }
    if (this._migratedDefault) return { ok: true, migrated: false, reason: 'ALREADY_MIGRATED' };
    const source = opts.source !== undefined ? opts.source : this._migrationSource();
    if (!source || typeof source !== 'object' || !source.slots) { this._markMigrated(); return { ok: true, migrated: false, reason: 'NO_SOURCE' }; }
    const slots = {};
    for (const s of SLOTS) {
      const sel = source.slots[s];
      if (!sel || !isString(sel.deviceProfileId)) { this._markMigrated(); return { ok: true, migrated: false, reason: 'INCOMPLETE_SOURCE', slot: s }; }
      slots[s] = { browserProfileId: isString(sel.browserProfileId) ? sel.browserProfileId : s, deviceProfileId: sel.deviceProfileId, proxyRef: isString(sel.proxyRef) ? sel.proxyRef : null };
    }
    const res = model.normalizeClusterProfile({
      name: source.name || 'Cụm mặc định',
      gameUrl: source.gameUrl || null,       // DRAFT when absent — never fabricated
      defaultHostSlot: source.defaultHostSlot || 'A',
      defaultStake: source.defaultStake != null ? source.defaultStake : null,
      slots,
    }, { existing: null });
    if (!res.ok) { this._markMigrated(); return { ok: true, migrated: false, reason: 'SOURCE_INVALID', error: res.error }; }
    const p = res.profile;
    const now = this._now();
    p.createdAt = now; p.updatedAt = now;
    this._map.set(p.id, p);
    this._selectedId = p.id;
    this._migratedDefault = true;
    const w = this._persist();
    if (!w.ok) { this._map.delete(p.id); this._selectedId = null; this._migratedDefault = false; return w; }
    return { ok: true, migrated: true, profile: this.getPublic(p.id) };
  }

  _markMigrated() { if (!this._migratedDefault) { this._migratedDefault = true; this._persist(); } }
}

function isString(v) { return typeof v === 'string'; }
function safe(e) { return String((e && e.message) || e || '').slice(0, 200); }

module.exports = { PhomClusterProfileStore };
