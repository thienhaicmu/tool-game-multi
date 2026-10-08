'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeAgent, publicSnapshot } = require('../../browser-run/browser-agent.cjs');

// ---------------------------------------------------------------------------
// PROFILE STORE (3.2) — the ONE place a saved profile lives (phom-device-profiles.json, version 2). A LIST of N profiles
// (no fixed A/B/C slots): each has a STABLE id, a name, a browser AGENT (web or mobile — see browser-agent.cjs), a saved
// game URL, an optional proxy REFERENCE, and — since 3.2 — what the tool learned about it:
//   account  the game account last seen playing in it (it becomes the Chromium profile name on the next launch)
//   folder   the name of its Chromium user-data folder under browser-profiles/ (renamed to the account, see
//            chromium-profile-name.resolveProfileDir)
// Metadata only — never a proxy password/account/token (secrets stay in ProxySecretStore). Atomic write.
//
// Before 3.2 account and folder lived in two more files (account-names.json, profile-folders.json) that nobody cleaned
// when a profile was deleted. On the first load they are copied into backupDir and merged in ONCE (the file records it:
// legacyMerged). They are left where they are: an older build on the same machine (same userData) still finds each
// profile's renamed folder through them. A key that is not a saved profile keeps its account/folder under `loose`.
//
// Profiles saved before the device model was removed carry a `device` object; it is migrated on read — its
// mobile/userAgent decides the agent, everything else is dropped (the window is the viewport now).
// ---------------------------------------------------------------------------

const VERSION = 2;
const MAX_NAME = 60;

function genId() { return 'prof-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
// What the game shows for an account that has no display name ("_undefined", seen live 2026-10-09 on a fresh account
// with "Hãy kích hoạt SĐT") is not a name: it never becomes a profile's account (nor its folder / Chromium name).
const PLACEHOLDER_NAME = /^_?(undefined|null|unknown|user_unknown|none)$/i;
function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f]/g, '').trim();
  return s && !PLACEHOLDER_NAME.test(s) ? s.slice(0, MAX_NAME) : null;
}
function readJson(file) {
  try { return { json: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return e && e.code === 'ENOENT' ? { missing: true } : { broken: true, error: e }; }
}

// Agent of a stored record, migrating a legacy `device` object when that is all it has.
function agentOf(p) {
  if (!p) return null;
  const norm = normalizeAgent(p.agent != null ? p.agent : p.device);
  return norm.ok ? norm.agent : null;
}

function publicOf(p) {
  if (!p) return null;
  const agent = agentOf(p);
  return { id: p.id, name: p.name, proxyRef: p.proxyRef || null, gameUrl: p.gameUrl || null, agent, device: publicSnapshot(agent), account: p.account || null, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

class PhomProfileStore {
  // legacy: { accountNames: file, folders: file } — the pre-3.2 files to take over once; backupDir: where they go first
  constructor({ filePath = null, legacy = null, backupDir = null, log = () => {} } = {}) {
    this._filePath = filePath;
    this._legacy = legacy;
    this._backupDir = backupDir;
    this._log = log;
    this._map = new Map();      // id -> profile (insertion order preserved)
    this._loose = new Map();    // key (not a saved profile) -> { account, folder }
    this.load();
  }

  load() {
    if (!this._filePath) return { ok: true, firstRun: true };
    const r = readJson(this._filePath);
    if (r.broken) return { ok: false, error: { code: 'PHOM_PROFILES_STORE_CORRUPT', message: String(r.error && r.error.message || r.error) } };
    const data = r.json || {};
    let migrated = false;
    for (const p of (Array.isArray(data.profiles) ? data.profiles : [])) {
      if (!p || !p.id) continue;
      // A record saved under the device model keeps only its agent from here on.
      const rec = { id: String(p.id), name: p.name, proxyRef: p.proxyRef || null, gameUrl: p.gameUrl || null, agent: agentOf(p), account: cleanName(p.account), folder: p.folder ? String(p.folder) : null, createdAt: p.createdAt, updatedAt: p.updatedAt };
      if (p.device !== undefined || p.agent !== rec.agent) migrated = true;
      this._map.set(rec.id, rec);
    }
    for (const [k, v] of Object.entries(data.loose && typeof data.loose === 'object' ? data.loose : {})) {
      if (v && typeof v === 'object') this._loose.set(String(k), { account: cleanName(v.account), folder: v.folder ? String(v.folder) : null });
    }
    if (r.json && data.version !== VERSION) migrated = true;
    this._legacyMerged = data.legacyMerged === true;
    const took = this._legacyMerged ? [] : this._takeLegacy();
    if (took.length) this._legacyMerged = true;
    if (migrated || took.length) {
      try {
        if (took.length || (r.json && data.version !== VERSION)) this._backup([this._filePath]);
        this._persist();
        if (took.length) this._log('profiles-migrated', { files: took.map((f) => path.basename(f)) });
      } catch { this._legacyMerged = data.legacyMerged === true; /* not written: merged again next start */ }
    }
    return { ok: true, migrated: migrated || took.length > 0, firstRun: !!r.missing && !took.length };
  }

  _backup(files) {
    if (!this._backupDir) return;
    fs.mkdirSync(this._backupDir, { recursive: true });
    for (const f of files) { try { if (fs.existsSync(f)) fs.copyFileSync(f, path.join(this._backupDir, path.basename(f))); } catch { /* the original stays */ } }
  }

  // account-names.json + profile-folders.json → the records (a value already in the store wins). → files taken
  _takeLegacy() {
    const lg = this._legacy || {};
    const files = [lg.accountNames, lg.folders].filter((f) => f && fs.existsSync(f));
    if (!files.length) return [];
    this._backup(files);
    const merge = (file, field, clean) => {
      const r = file ? readJson(file) : {};
      if (!r.json || typeof r.json !== 'object') return;
      for (const [k, v] of Object.entries(r.json)) {
        const val = clean(v);
        if (!val) continue;
        const rec = this._map.get(String(k)) || this._looseOf(String(k));
        if (!rec[field]) rec[field] = val;
      }
    };
    merge(lg.accountNames, 'account', cleanName);
    merge(lg.folders, 'folder', (v) => (typeof v === 'string' && v ? v : null));
    return files;
  }

  _looseOf(key) { let l = this._loose.get(key); if (!l) { l = { account: null, folder: null }; this._loose.set(key, l); } return l; }
  _recOf(key) { return this._map.get(String(key)) || this._looseOf(String(key)); }

  _persist() {
    if (!this._filePath) return;
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    const loose = {};
    for (const [k, v] of this._loose) if (v.account || v.folder) loose[k] = { account: v.account || null, folder: v.folder || null };
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, legacyMerged: !!this._legacyMerged, profiles: [...this._map.values()], loose }, null, 2), 'utf8');
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
      agent: norm.agent, account: null, folder: null, createdAt: now, updatedAt: now,
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

  // A deleted profile takes its account + folder name with it (its browser folder on disk is left alone).
  remove(id) {
    if (this._map.delete(String(id))) { this._persist(); return { ok: true }; }
    return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: `no profile ${id}` } };
  }

  // Profiles currently referencing a proxy id (guards proxy deletion).
  profilesUsingProxy(proxyId) { const id = String(proxyId); return [...this._map.values()].filter((p) => p.proxyRef === id).map((p) => p.id); }

  // ---- what the tool learned (key = the profile id, or the run key of a browser opened without a saved profile) ----
  accountOf(key) { const r = this._map.get(String(key)) || this._loose.get(String(key)); return r ? cleanName(r.account) : null; }
  // → true when it changed (and was saved)
  setAccount(key, account) {
    const k = String(key == null ? '' : key); const a = cleanName(account);
    if (!k || !a) return false;
    const rec = this._recOf(k);
    if (rec.account === a) return false;
    rec.account = a;
    try { this._persist(); } catch { /* best effort */ }
    return true;
  }
  // the folder map chromium-profile-name.resolveProfileDir expects: get / all / set
  folders() {
    return {
      get: (key) => { const r = this._map.get(String(key)) || this._loose.get(String(key)); return r && r.folder ? r.folder : null; },
      all: () => { const out = {}; for (const [k, v] of this._map) if (v.folder) out[k] = v.folder; for (const [k, v] of this._loose) if (v.folder && out[k] == null) out[k] = v.folder; return out; },
      set: (key, folder) => { const rec = this._recOf(key); if (rec.folder === folder) return; rec.folder = folder; try { this._persist(); } catch { /* best effort */ } },
    };
  }
}

module.exports = { PhomProfileStore, VERSION };
