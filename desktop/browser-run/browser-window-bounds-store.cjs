'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// BrowserWindowBoundsStore — CONTROL-V3. Per-PersistentBrowser saved geometry
// for that profile's EXTERNAL browser window (x/y/width/height), so reopening
// B-0010 restores B-0010's window and B-0011 restores B-0011's — never mixed.
//
// It is deliberately SEPARATE from:
//   - BrowserRegistry (identity/profile),
//   - BrowserConfigStore (whitelist-locked Auto operating config — window geometry
//     is presentation, not operating config, and must never leak into that store),
//   - RoundHistoryStore (evidence).
//
// It stores ONLY a rectangle per browserId. It NEVER stores runtime truth or
// license authority. Persistence mirrors BrowserConfigStore: one small JSON file
// written atomically (temp + rename); a missing file is a valid first run; a
// corrupt file is reported and NEVER silently overwritten (reads fall back to
// empty, writes are refused while corrupt).
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const MAX_DIM = 10000;

function err(code, message, extra = {}) { return { error: { code, message, ...extra } }; }

// A rectangle is valid only if width/height are finite and within sane bounds.
// x/y are optional (an unknown position is legal — the host re-centers it).
function sanitizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const w = Number(raw.width), h = Number(raw.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM) return null;
  const out = { width: Math.round(w), height: Math.round(h) };
  const x = Number(raw.x), y = Number(raw.y);
  if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 20000 && Math.abs(y) < 20000) {
    out.x = Math.round(x); out.y = Math.round(y);
  }
  return out;
}

class BrowserWindowBoundsStore {
  constructor(deps = {}) {
    this._fs = deps.fs || fsDefault;
    this._filePath = deps.filePath;                  // <root>/browser-window-bounds.json
    this._data = { version: SCHEMA_VERSION, bounds: {} };
    this._corrupt = false;
    this._corruptError = null;
    this._loaded = false;
  }

  load() {
    this._loaded = true;
    if (!this._filePath) { this._data = { version: SCHEMA_VERSION, bounds: {} }; return { ok: true, firstRun: true }; }
    let raw;
    try { raw = this._fs.readFileSync(this._filePath, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') { this._data = { version: SCHEMA_VERSION, bounds: {} }; return { ok: true, firstRun: true }; }
      this._corrupt = true; this._corruptError = err('BROWSER_BOUNDS_CORRUPT', 'Window bounds could not be read: ' + String(e && e.message || e)); return this._corruptError;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { this._corrupt = true; this._corruptError = err('BROWSER_BOUNDS_CORRUPT', 'Window bounds file is not valid JSON'); return this._corruptError; }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.bounds !== 'object' || parsed.bounds === null) {
      this._corrupt = true; this._corruptError = err('BROWSER_BOUNDS_CORRUPT', 'Window bounds file has an invalid shape'); return this._corruptError;
    }
    const migrated = {};
    for (const [id, rect] of Object.entries(parsed.bounds)) { const s = sanitizeBounds(rect); if (s) migrated[String(id)] = s; }
    this._data = { version: SCHEMA_VERSION, bounds: migrated };
    this._corrupt = false; this._corruptError = null;
    return { ok: true };
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

  // Returns the saved rectangle for a browser, or null when unknown/corrupt. Never mutates.
  get(browserId) {
    this._ensureLoaded();
    if (this._corrupt) return null;
    const rect = this._data.bounds[String(browserId)];
    return rect ? { ...rect } : null;
  }

  // Persist a browser's window rectangle (atomic). Invalid rectangles are refused so a
  // transient/garbage bounds report can never poison the saved geometry.
  set(browserId, rect) {
    this._ensureLoaded();
    if (this._corrupt) return this._corruptError || err('BROWSER_BOUNDS_CORRUPT', 'Window bounds are corrupt');
    const id = String(browserId || '');
    if (!id) return err('BROWSER_BOUNDS_INVALID', 'A browserId is required');
    const clean = sanitizeBounds(rect);
    if (!clean) return err('BROWSER_BOUNDS_INVALID', 'Invalid window rectangle');
    const prev = this._data.bounds[id];
    this._data.bounds[id] = clean;
    try { this._persist(); }
    catch (e) { if (prev === undefined) delete this._data.bounds[id]; else this._data.bounds[id] = prev; return err('BROWSER_BOUNDS_WRITE_FAILED', 'Could not persist window bounds: ' + String(e && e.message || e)); }
    return { bounds: { ...clean } };
  }

  remove(browserId) {
    this._ensureLoaded();
    if (this._corrupt) return this._corruptError;
    const id = String(browserId || '');
    if (Object.prototype.hasOwnProperty.call(this._data.bounds, id)) {
      const prev = this._data.bounds[id];
      delete this._data.bounds[id];
      try { this._persist(); } catch (e) { this._data.bounds[id] = prev; return err('BROWSER_BOUNDS_WRITE_FAILED', 'Could not persist window bounds: ' + String(e && e.message || e)); }
    }
    return { ok: true };
  }
}

module.exports = { BrowserWindowBoundsStore, sanitizeBounds, MAX_DIM };
