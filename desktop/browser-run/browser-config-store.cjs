'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// BrowserConfigStore — WU-D. Per-PersistentBrowser USER OPERATING CONFIGURATION,
// kept SEPARATE from BrowserRegistry (identity/profile) and RoundHistoryStore
// (evidence), mirroring the existing WU-C separation of concerns.
//
// This store owns ONLY user-entered Auto settings for a browser B-*:
//   amount, roundCount, stopOdd, waitForJackpot, jackpotThreshold, stopAutoAt1000x
//
// It is NOT a parallel identity database (it never invents B-* ids; BrowserRegistry
// remains the sole identity authority — configs are keyed by that id).
//
// It NEVER persists runtime truth (sid/aid/eid/currentOdd/jackpot/socket/gate/run
// status) — those are reconstructed from the live server on each open (§8.1). It
// NEVER persists license authority (maxBrowsers/maxConcurrent/features) — those stay
// verified-signed-key only (§8.2). A saved `waitForJackpot:true` is a REQUEST; the
// main process still enforces features.jackpotGate before any Auto executes.
//
// Persistence: one small JSON file written atomically (temp + rename). Missing file
// is a valid first-run; a corrupt file is reported and NEVER silently overwritten.
// Schema is versioned for forward migration.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// The exact whitelist of persisted operating-config fields, with validators and
// defaults. Any key NOT in this list is rejected/ignored — this is the structural
// guarantee that runtime truth and license authority can never leak into config.
const FIELDS = Object.freeze({
  amount: { def: null, valid: (v) => v === null || (Number.isFinite(Number(v)) && Number(v) > 0), coerce: (v) => (v === null ? null : Number(v)) },
  roundCount: { def: 1, valid: (v) => Number.isInteger(Number(v)) && Number(v) >= 1, coerce: (v) => Number(v) },
  stopOdd: { def: null, valid: (v) => v === null || (Number.isFinite(Number(v)) && Number(v) > 0), coerce: (v) => (v === null ? null : Number(v)) },
  waitForJackpot: { def: false, valid: (v) => typeof v === 'boolean', coerce: (v) => v === true },
  jackpotThreshold: { def: null, valid: (v) => v === null || (Number.isFinite(Number(v)) && Number(v) >= 0), coerce: (v) => (v === null ? null : Number(v)) },
  stopAutoAt1000x: { def: false, valid: (v) => typeof v === 'boolean', coerce: (v) => v === true },
});
const FIELD_KEYS = Object.freeze(Object.keys(FIELDS));

function err(code, message, extra = {}) { return { error: { code, message, ...extra } }; }

function defaultConfig() {
  const out = {};
  for (const k of FIELD_KEYS) out[k] = FIELDS[k].def;
  return out;
}

// Coerce a stored/patch object into a valid config, dropping unknown keys and
// falling back to defaults for missing/invalid ones. Used for load-migration and as
// the base for set(). Never throws.
function sanitizeConfig(raw, base) {
  const out = { ...(base || defaultConfig()) };
  if (raw && typeof raw === 'object') {
    for (const k of FIELD_KEYS) {
      if (!(k in raw)) continue;
      const v = raw[k];
      if (FIELDS[k].valid(v)) out[k] = FIELDS[k].coerce(v);
    }
  }
  return out;
}

class BrowserConfigStore {
  constructor(deps = {}) {
    this._fs = deps.fs || fsDefault;
    this._filePath = deps.filePath;                 // <root>/browser-configs.json
    this._now = deps.now || (() => Date.now());
    this._data = { version: SCHEMA_VERSION, configs: {} };
    this._corrupt = false;
    this._corruptError = null;
    this._loaded = false;
  }

  // ---- load / migration ----
  load() {
    this._loaded = true;
    if (!this._filePath) { this._data = { version: SCHEMA_VERSION, configs: {} }; return { ok: true, firstRun: true }; }
    let raw;
    try { raw = this._fs.readFileSync(this._filePath, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') { this._data = { version: SCHEMA_VERSION, configs: {} }; return { ok: true, firstRun: true }; }
      this._corrupt = true; this._corruptError = err('BROWSER_CONFIG_CORRUPT', 'Config could not be read: ' + String(e && e.message || e)); return this._corruptError;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { this._corrupt = true; this._corruptError = err('BROWSER_CONFIG_CORRUPT', 'Config file is not valid JSON'); return this._corruptError; }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.configs !== 'object' || parsed.configs === null) {
      this._corrupt = true; this._corruptError = err('BROWSER_CONFIG_CORRUPT', 'Config file has an invalid shape'); return this._corruptError;
    }
    // Migration is non-destructive: every stored config is sanitized against the
    // current whitelist (unknown fields dropped, missing fields defaulted), and the
    // version is stamped forward. Old B-* ids are preserved verbatim.
    const migrated = {};
    for (const [id, cfg] of Object.entries(parsed.configs)) migrated[String(id)] = sanitizeConfig(cfg, defaultConfig());
    const migratedFrom = Number(parsed.version) || 0;
    this._data = { version: SCHEMA_VERSION, configs: migrated };
    this._corrupt = false; this._corruptError = null;
    return { ok: true, migrated: migratedFrom !== SCHEMA_VERSION, migratedFrom };
  }

  _ensureLoaded() { if (!this._loaded) this.load(); }

  _persist() {
    if (!this._filePath) return;
    try { this._fs.mkdirSync(path.dirname(this._filePath), { recursive: true }); } catch { /* exists */ }
    const tmp = this._filePath + '.tmp';
    this._fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    this._fs.renameSync(tmp, this._filePath);
  }

  isCorrupt() { return this._corrupt; }

  // ---- reads ----
  // Always returns a fully-defaulted config, even for an unknown browser (so the UI
  // always has a coherent shape). Never mutates.
  get(browserId) {
    this._ensureLoaded();
    if (this._corrupt) return defaultConfig();
    const cfg = this._data.configs[String(browserId)];
    return cfg ? { ...defaultConfig(), ...cfg } : defaultConfig();
  }

  has(browserId) { this._ensureLoaded(); return !this._corrupt && Object.prototype.hasOwnProperty.call(this._data.configs, String(browserId)); }

  // ---- write (whitelist-validated, atomic) ----
  set(browserId, patch = {}) {
    this._ensureLoaded();
    if (this._corrupt) return this._corruptError || err('BROWSER_CONFIG_CORRUPT', 'Config is corrupt');
    const id = String(browserId || '');
    if (!id) return err('BROWSER_CONFIG_INVALID', 'A browserId is required');
    // Reject any explicitly-invalid known field (unknown keys are silently ignored —
    // they can never be persisted). This keeps runtime/license fields out by design.
    for (const k of FIELD_KEYS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k) && !FIELDS[k].valid(patch[k])) {
        return err('BROWSER_CONFIG_INVALID', `Invalid value for ${k}`, { field: k });
      }
    }
    const base = this._data.configs[id] ? { ...defaultConfig(), ...this._data.configs[id] } : defaultConfig();
    const next = sanitizeConfig(patch, base);
    const prev = this._data.configs[id];
    this._data.configs[id] = next;
    try { this._persist(); }
    catch (e) { if (prev === undefined) delete this._data.configs[id]; else this._data.configs[id] = prev; return err('BROWSER_CONFIG_WRITE_FAILED', 'Could not persist config: ' + String(e && e.message || e)); }
    return { config: { ...next } };
  }

  // Drop a browser's config (called when its identity is deleted). Best-effort; never
  // required for correctness. History/profile retention policy is unaffected.
  remove(browserId) {
    this._ensureLoaded();
    if (this._corrupt) return this._corruptError;
    const id = String(browserId || '');
    if (!Object.prototype.hasOwnProperty.call(this._data.configs, id)) return { ok: true, removed: false };
    const prev = this._data.configs[id];
    delete this._data.configs[id];
    try { this._persist(); } catch (e) { this._data.configs[id] = prev; return err('BROWSER_CONFIG_WRITE_FAILED', String(e && e.message || e)); }
    return { ok: true, removed: true };
  }
}

module.exports = { BrowserConfigStore, SCHEMA_VERSION, FIELD_KEYS, defaultConfig, sanitizeConfig };
