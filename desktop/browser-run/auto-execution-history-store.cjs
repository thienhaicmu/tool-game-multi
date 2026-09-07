'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// AutoExecutionHistoryStore — WU-AUTO-RUNTIME-HARDENING, Part A.
//
// Persistent per-PersistentBrowser Auto EXECUTION history: ONE terminal record
// per Auto Run execution (browserId + autoExecutionId), distinct from the per-
// ROUND history (RoundHistoryStore). It answers "why did this Auto run stop and
// what was the authoritative ODD at that moment" (§13/§14/§15/§21).
//
// One JSON file per browser: <dir>/<browserId>.json — isolating browsers, bounding
// each file, and localising corruption. Writes are atomic (temp + rename). A missing
// file is an empty first-run; a corrupt file is reported and NEVER silently
// overwritten (evidence preserved). Identity = browserId + autoExecutionId, so a
// recovery pause/resume that keeps the same id updates ONE logical record (§20).
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_PER_BROWSER = 1000;

function err(code, message, extra = {}) { return { error: { code, message, ...extra } }; }
function safeId(id) { return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80); }

class AutoExecutionHistoryStore {
  constructor(deps = {}) {
    this._fs = deps.fs || fsDefault;
    this._dir = deps.dir;
    this._maxPerBrowser = Number(deps.maxPerBrowser || DEFAULT_MAX_PER_BROWSER);
    this._cache = new Map();
    this._corrupt = new Map();
  }

  _fileFor(browserId) { return path.join(this._dir, safeId(browserId) + '.json'); }

  _ensureLoaded(browserId) {
    const bid = String(browserId);
    if (this._cache.has(bid)) return { ok: true, data: this._cache.get(bid) };
    if (this._corrupt.has(bid)) return this._corrupt.get(bid);
    if (!this._dir) { const empty = { version: SCHEMA_VERSION, browserId: bid, executions: [] }; this._cache.set(bid, empty); return { ok: true, data: empty }; }
    let raw;
    try { raw = this._fs.readFileSync(this._fileFor(bid), 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') { const empty = { version: SCHEMA_VERSION, browserId: bid, executions: [] }; this._cache.set(bid, empty); return { ok: true, data: empty }; }
      const er = err('AUTO_EXECUTION_HISTORY_CORRUPT', 'History could not be read: ' + String(e && e.message || e), { browserId: bid }); this._corrupt.set(bid, er); return er;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { const er = err('AUTO_EXECUTION_HISTORY_CORRUPT', 'History file is not valid JSON', { browserId: bid }); this._corrupt.set(bid, er); return er; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.executions)) { const er = err('AUTO_EXECUTION_HISTORY_CORRUPT', 'History file has an invalid shape', { browserId: bid }); this._corrupt.set(bid, er); return er; }
    const data = { version: parsed.version || SCHEMA_VERSION, browserId: bid, executions: parsed.executions };
    this._cache.set(bid, data);
    return { ok: true, data };
  }

  _persist(browserId, data) {
    if (!this._dir) return;
    try { this._fs.mkdirSync(this._dir, { recursive: true }); } catch { /* exists */ }
    const file = this._fileFor(browserId);
    const tmp = file + '.tmp';
    this._fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    this._fs.renameSync(tmp, file);
  }

  isCorrupt(browserId) { return this._corrupt.has(String(browserId)); }

  // Idempotent upsert keyed by browserId + autoExecutionId. Re-finalizing the same
  // execution (or updating it after a recovery-continued run) replaces the record.
  upsert(record) {
    if (!record || record.browserId == null || record.autoExecutionId == null) {
      return err('AUTO_EXECUTION_HISTORY_INVALID_RECORD', 'Record requires browserId and autoExecutionId');
    }
    const loaded = this._ensureLoaded(record.browserId);
    if (loaded.error) return loaded; // corrupt: refuse rather than clobber evidence
    const data = loaded.data;
    const key = String(record.autoExecutionId);
    const i = data.executions.findIndex((r) => String(r.autoExecutionId) === key);
    const stored = { ...record };
    if (i >= 0) data.executions[i] = stored; else data.executions.push(stored);
    if (data.executions.length > this._maxPerBrowser) data.executions.splice(0, data.executions.length - this._maxPerBrowser);
    try { this._persist(record.browserId, data); } catch (e) { return err('AUTO_EXECUTION_HISTORY_WRITE_FAILED', String(e && e.message || e)); }
    return { ok: true, record: stored, updated: i >= 0 };
  }

  list(browserId, { limit = 200 } = {}) {
    const loaded = this._ensureLoaded(browserId);
    if (loaded.error) return [];
    const rows = loaded.data.executions;
    const n = Math.max(0, Math.min(Number(limit) || 200, rows.length));
    return rows.slice(rows.length - n).reverse().map((r) => ({ ...r }));
  }

  count(browserId) { const l = this._ensureLoaded(browserId); return l.error ? 0 : l.data.executions.length; }
}

module.exports = { AutoExecutionHistoryStore, SCHEMA_VERSION, DEFAULT_MAX_PER_BROWSER };
