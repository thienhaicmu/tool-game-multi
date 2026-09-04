'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// BrowserRegistry — WU-C.1. Persistent browser identity + stable profile
// ownership, kept SEPARATE from the runtime BrowserRunManager.
//
//   PersistentBrowser (B-0001)  — survives app restart; owns a stable profileDir
//        │ open
//   BrowserRun (BR-0042)        — ephemeral runtime session (BrowserRunManager)
//
// The registry NEVER stores live protocol truth (sid/odd/aid/eid/socket/ACK/
// AutoRunner). Those are reacquired from the live server on each open.
//
// Persistence is a single small JSON file written atomically (temp + rename). A
// missing file is a valid first-run; a corrupt file is reported (never silently
// overwritten). Capacity is governed by an injected entitlement seam so the
// license (or a test) decides how many persistent browsers may be created — this
// module never invents a limit.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

function err(code, message, extra = {}) { return { error: { code, message, ...extra } }; }
function iso(ms) { try { return new Date(ms).toISOString(); } catch { return new Date().toISOString(); } }
function padId(n) { return 'B-' + String(n).padStart(4, '0'); }

class BrowserRegistry {
  constructor(deps = {}) {
    this._fs = deps.fs || fsDefault;
    this._filePath = deps.filePath;                 // <userData>/browser-registry.json
    this._profilesRoot = deps.profilesRoot;         // <userData>/browser-profiles
    this._now = deps.now || (() => Date.now());
    // Injected entitlement: () => ({ maxBrowsers: number|null }). null = unlimited.
    this._entitlement = deps.entitlement || (() => ({ maxBrowsers: null }));
    this._data = { version: SCHEMA_VERSION, nextBrowserNumber: 1, browsers: [] };
    this._corrupt = false;
    this._corruptError = null;
  }

  // ---- load / persistence ----
  load() {
    if (!this._filePath) return { ok: true, firstRun: true };
    let raw;
    try { raw = this._fs.readFileSync(this._filePath, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') { this._data = this._empty(); return { ok: true, firstRun: true }; } this._corrupt = true; this._corruptError = err('BROWSER_REGISTRY_CORRUPT', 'Registry could not be read: ' + String(e && e.message || e)); return this._corruptError; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { this._corrupt = true; this._corruptError = err('BROWSER_REGISTRY_CORRUPT', 'Registry file is not valid JSON'); return this._corruptError; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.browsers) || !Number.isInteger(parsed.nextBrowserNumber)) {
      this._corrupt = true; this._corruptError = err('BROWSER_REGISTRY_CORRUPT', 'Registry file has an invalid shape'); return this._corruptError;
    }
    this._data = { version: parsed.version || SCHEMA_VERSION, nextBrowserNumber: parsed.nextBrowserNumber, browsers: parsed.browsers.map((b) => ({ ...b })) };
    this._corrupt = false; this._corruptError = null;
    return { ok: true };
  }

  _empty() { return { version: SCHEMA_VERSION, nextBrowserNumber: 1, browsers: [] }; }

  _persist() {
    if (!this._filePath) return; // in-memory only (tests may omit a path)
    const tmp = this._filePath + '.tmp';
    this._fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    this._fs.renameSync(tmp, this._filePath);
  }

  isCorrupt() { return this._corrupt; }

  // ---- reads ----
  list() { return this._corrupt ? [] : this._data.browsers.map((b) => ({ ...b })); }
  get(id) { if (this._corrupt) return null; const b = this._data.browsers.find((x) => x.id === String(id)); return b ? { ...b } : null; }
  count() { return this._corrupt ? 0 : this._data.browsers.length; }

  // ---- entitlement / capacity (main-process authority) ----
  capacity() {
    const registered = this.count();
    const ent = this._entitlement() || {};
    const max = ent.maxBrowsers == null ? null : Number(ent.maxBrowsers);
    const unlimited = max == null;
    const overCapacity = !unlimited && registered > max;
    const canCreate = !this._corrupt && (unlimited || registered < max);
    return { registered, max, remaining: unlimited ? null : Math.max(0, max - registered), canCreate, overCapacity, unlimited, corrupt: this._corrupt };
  }

  // ---- create (capacity-guarded, atomic; synchronous so two near-simultaneous
  // requests cannot both observe the same final slot — no execution lock) ----
  create({ name, launchUrl } = {}) {
    if (this._corrupt) return this._corruptError || err('BROWSER_REGISTRY_CORRUPT', 'Registry is corrupt');
    const url = String(launchUrl || '').trim();
    if (!isValidLaunchUrl(url)) return err('BROWSER_INVALID_URL', 'Launch URL must be an http(s) URL');
    const cap = this.capacity();
    if (!cap.canCreate) return err('BROWSER_LIMIT_REACHED', `Browser limit reached (${cap.registered}/${cap.max})`, { registered: cap.registered, max: cap.max });

    const num = this._data.nextBrowserNumber;
    const id = padId(num);
    const now = this._now();
    const rec = {
      id,
      name: String(name || '').trim() || ('Browser ' + num),
      launchUrl: url,
      profileDir: this._profilePathFor(id),
      createdAt: iso(now), updatedAt: iso(now),
      lastOpenedAt: null, lastRunId: null,
    };
    // Mutate, then persist. On write failure, roll back so no id/slot is consumed.
    this._data.nextBrowserNumber = num + 1;
    this._data.browsers.push(rec);
    try { this._persist(); }
    catch (e) { this._data.browsers.pop(); this._data.nextBrowserNumber = num; return err('BROWSER_REGISTRY_WRITE_FAILED', 'Could not persist the registry: ' + String(e && e.message || e)); }
    return { browser: { ...rec } };
  }

  update(id, patch = {}) {
    if (this._corrupt) return this._corruptError;
    const rec = this._data.browsers.find((x) => x.id === String(id));
    if (!rec) return err('BROWSER_NOT_FOUND', 'No such browser: ' + id);
    if (patch.name != null) { const n = String(patch.name).trim(); if (n) rec.name = n; }
    if (patch.launchUrl != null) { const u = String(patch.launchUrl).trim(); if (!isValidLaunchUrl(u)) return err('BROWSER_INVALID_URL', 'Launch URL must be an http(s) URL'); rec.launchUrl = u; }
    rec.updatedAt = iso(this._now());
    try { this._persist(); } catch (e) { return err('BROWSER_REGISTRY_WRITE_FAILED', String(e && e.message || e)); }
    return { browser: { ...rec } };
  }

  // Remove the persistent RECORD only. Profile directory is intentionally NOT
  // deleted here (conservative WU-C.1 delete). nextBrowserNumber is never rewound,
  // so ids are not reused. Caller must ensure the browser has no live run.
  remove(id) {
    if (this._corrupt) return this._corruptError;
    const i = this._data.browsers.findIndex((x) => x.id === String(id));
    if (i < 0) return err('BROWSER_NOT_FOUND', 'No such browser: ' + id);
    const [removed] = this._data.browsers.splice(i, 1);
    try { this._persist(); } catch (e) { this._data.browsers.splice(i, 0, removed); return err('BROWSER_REGISTRY_WRITE_FAILED', String(e && e.message || e)); }
    return { ok: true, removed: { ...removed }, profileRetained: removed.profileDir };
  }

  // Record that a browser was opened as a given runtime run (metadata only).
  touchOpened(id, runId) {
    if (this._corrupt) return this._corruptError;
    const rec = this._data.browsers.find((x) => x.id === String(id));
    if (!rec) return err('BROWSER_NOT_FOUND', 'No such browser: ' + id);
    rec.lastOpenedAt = iso(this._now());
    rec.lastRunId = runId != null ? String(runId) : rec.lastRunId;
    try { this._persist(); } catch { /* metadata write is best-effort */ }
    return { browser: { ...rec } };
  }

  _profilePathFor(id) { return this._profilesRoot ? path.join(this._profilesRoot, id) : id; }
}

// Launch URL must be a real http(s) URL (mirrors what the launcher can open).
function isValidLaunchUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}

module.exports = { BrowserRegistry, isValidLaunchUrl, SCHEMA_VERSION };
