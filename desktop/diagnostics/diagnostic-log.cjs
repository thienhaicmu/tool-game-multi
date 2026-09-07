'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// ---------------------------------------------------------------------------
// DiagnosticLog — WU-AUTO-RUNTIME-HARDENING, Part C.
//
// A hidden/background technical post-mortem log, kept SEPARATE from the user-
// facing round/execution History. Its job: after a user reports "Auto tự dừng",
// "không cược vòng tiếp", "request lỗi", "mất login", "cashout gửi nhưng không
// thấy ACK" ... we can reconstruct what actually happened, correlated by
// browserId / runId / autoExecutionId / sid.
//
// Design invariants:
//   * Structured JSONL (one JSON object per line) — greppable, append-only.
//   * Bounded disk usage — size-capped active file + capped rotated files.
//   * Automatic redaction — passwords, tokens, authorization/cookie headers,
//     refresh/session secrets and secret query parameters are NEVER persisted.
//   * Never throws to the caller — a diagnostics failure must not break runtime.
//
// It is Electron-free and dependency-injected (fs / clocks / dir) so the full
// behaviour is deterministically unit-testable.
// ---------------------------------------------------------------------------

const LEVEL = Object.freeze({ DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' });

const CATEGORY = Object.freeze({
  APP: 'APP', BROWSER_RUN: 'BROWSER_RUN', NAVIGATION: 'NAVIGATION', HTTP: 'HTTP',
  WEBSOCKET: 'WEBSOCKET', LOGIN: 'LOGIN', AVIATOR_ENTRY: 'AVIATOR_ENTRY', PROTOCOL: 'PROTOCOL',
  ROUND: 'ROUND', AUTO_RUNNER: 'AUTO_RUNNER', BET: 'BET', CASHOUT: 'CASHOUT', JACKPOT: 'JACKPOT',
  RECOVERY: 'RECOVERY', HISTORY: 'HISTORY', IPC: 'IPC', RENDERER: 'RENDERER',
});

const DEFAULTS = Object.freeze({
  maxFileSizeBytes: 2 * 1024 * 1024, // 2 MB active file before rotation
  maxFiles: 6,                        // active + up to (maxFiles-1) rotated archives
  filePrefix: 'diagnostic',
});

const REDACTED = '[REDACTED]';

// Keys whose VALUES must never be persisted (case-insensitive substring match).
const SENSITIVE_KEY = /(password|passwd|pwd|secret|token|authorization|\bauth\b|cookie|bearer|refresh|credential|api[_-]?key|apikey|x-auth|sessionid|session[_-]?secret|set-cookie)/i;
// Query parameters commonly carrying secrets — dropped from any URL we persist.
const SENSITIVE_QUERY = /(token|auth|password|secret|sid|session|key|sig|signature|access_token|refresh_token)/i;

// Reduce an arbitrary URL to safe host + path (drop query, hash and userinfo).
function sanitizeUrl(url) {
  const raw = String(url == null ? '' : url);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Not a full URL — strip anything after ? or # and any inline credentials.
    return raw.split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//');
  }
}

// Recursively copy a value, redacting sensitive keys, Bearer strings and secret
// query strings. Bounded depth guards against cycles / pathological nesting.
function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[TRUNCATED]';
  const t = typeof value;
  if (t === 'string') return redactString(value);
  if (t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (SENSITIVE_KEY.test(k)) { out[k] = REDACTED; continue; }
      if (/^(url|href|location|path|requestUrl|documentUrl)$/i.test(k) && typeof value[k] === 'string') {
        out[k] = sanitizeUrl(value[k]);
        continue;
      }
      try { out[k] = redact(value[k], depth + 1); } catch { out[k] = '[UNSERIALIZABLE]'; }
    }
    return out;
  }
  return undefined; // functions/symbols dropped
}

function redactString(s) {
  let out = s;
  // Authorization: Bearer <jwt> / Basic <...>
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 ' + REDACTED);
  // Bare JWT-looking tokens (three base64url segments).
  out = out.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED);
  return out;
}

class DiagnosticLog {
  constructor(deps = {}) {
    this._fs = deps.fs || fsDefault;
    this._dir = deps.dir || null;
    this._now = deps.now || (() => Date.now());
    this._monoNow = deps.monoNow || (() => performance.now());
    this._enabled = deps.enabled !== false;
    this._maxFileSize = Number(deps.maxFileSizeBytes || DEFAULTS.maxFileSizeBytes);
    this._maxFiles = Math.max(1, Number(deps.maxFiles || DEFAULTS.maxFiles));
    this._prefix = String(deps.filePrefix || DEFAULTS.filePrefix);
    this._size = null;         // cached active-file size (lazy)
    this._seq = 0;             // monotonic rotation sequence within this process
    this._writeErrors = 0;
  }

  activeFile() { return this._dir ? path.join(this._dir, this._prefix + '.jsonl') : null; }

  // Append one structured record. Never throws. Returns the persisted record (redacted).
  log(entry = {}) {
    if (!this._enabled) return null;
    const rec = this._normalize(entry);
    if (!this._dir) return rec; // memory-only mode (no dir configured)
    try {
      this._fs.mkdirSync(this._dir, { recursive: true });
    } catch { /* exists */ }
    const line = JSON.stringify(rec) + '\n';
    try {
      this._rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
      this._fs.appendFileSync(this.activeFile(), line, 'utf8');
      this._size = (this._size == null ? this._currentSize() : this._size) + Buffer.byteLength(line, 'utf8');
    } catch (e) {
      this._writeErrors += 1;
    }
    return rec;
  }

  // Convenience wrappers keyed by level.
  debug(category, event, fields) { return this.log({ level: LEVEL.DEBUG, category, event, ...fields }); }
  info(category, event, fields) { return this.log({ level: LEVEL.INFO, category, event, ...fields }); }
  warn(category, event, fields) { return this.log({ level: LEVEL.WARN, category, event, ...fields }); }
  error(category, event, fields) { return this.log({ level: LEVEL.ERROR, category, event, ...fields }); }

  _normalize(entry) {
    const { level, category, event, browserId, runId, autoExecutionId, sid,
      stateBefore, stateAfter, reason, errorCode, ...rest } = entry || {};
    const rec = {
      ts: new Date(this._now()).toISOString(),
      mono: Math.round(this._monoNow()),
      level: LEVEL[level] || LEVEL.INFO,
      category: category || CATEGORY.APP,
      event: event != null ? String(event) : 'EVENT',
    };
    if (browserId != null) rec.browserId = String(browserId);
    if (runId != null) rec.runId = String(runId);
    if (autoExecutionId != null) rec.autoExecutionId = String(autoExecutionId);
    if (sid != null) rec.sid = sid;
    if (stateBefore != null) rec.stateBefore = String(stateBefore);
    if (stateAfter != null) rec.stateAfter = String(stateAfter);
    if (reason != null) rec.reason = String(reason);
    if (errorCode != null) rec.errorCode = String(errorCode);
    const meta = redact(rest);
    if (meta && Object.keys(meta).length) rec.meta = meta;
    return rec;
  }

  _currentSize() {
    try { return this._fs.statSync(this.activeFile()).size; } catch { return 0; }
  }

  _rotateIfNeeded(incomingBytes) {
    const cur = this._size == null ? this._currentSize() : this._size;
    if (cur + incomingBytes <= this._maxFileSize) { this._size = cur; return; }
    if (cur === 0) { this._size = 0; return; } // a single oversized line still writes once
    // Rotate the active file to an archive name, then prune.
    this._seq += 1;
    const stamp = new Date(this._now()).toISOString().replace(/[:.]/g, '-');
    const archive = path.join(this._dir, `${this._prefix}-${stamp}-${this._seq}.jsonl`);
    try { this._fs.renameSync(this.activeFile(), archive); } catch { /* best effort */ }
    this._size = 0;
    this._prune();
  }

  // Keep only the newest (maxFiles-1) archives alongside the active file.
  _prune() {
    let entries;
    try { entries = this._fs.readdirSync(this._dir); } catch { return; }
    const archives = entries
      .filter((n) => n.startsWith(this._prefix + '-') && n.endsWith('.jsonl'))
      .map((n) => {
        let mtime = 0;
        try { mtime = this._fs.statSync(path.join(this._dir, n)).mtimeMs; } catch { mtime = 0; }
        return { name: n, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first
    const keep = Math.max(0, this._maxFiles - 1);
    const drop = archives.length - keep;
    for (let i = 0; i < drop; i++) {
      try { this._fs.unlinkSync(path.join(this._dir, archives[i].name)); } catch { /* best effort */ }
    }
  }

  // All diagnostic files (active first), newest archives next — for export.
  files() {
    if (!this._dir) return [];
    let entries;
    try { entries = this._fs.readdirSync(this._dir); } catch { return []; }
    const active = this._prefix + '.jsonl';
    const archives = entries
      .filter((n) => n.startsWith(this._prefix + '-') && n.endsWith('.jsonl'))
      .map((n) => ({ name: n, mtime: (() => { try { return this._fs.statSync(path.join(this._dir, n)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((a) => a.name);
    const out = [];
    if (entries.includes(active)) out.push(path.join(this._dir, active));
    for (const a of archives) out.push(path.join(this._dir, a));
    return out;
  }

  totalBytes() {
    return this.files().reduce((sum, f) => { try { return sum + this._fs.statSync(f).size; } catch { return sum; } }, 0);
  }

  clear() {
    for (const f of this.files()) { try { this._fs.unlinkSync(f); } catch { /* best effort */ } }
    this._size = 0;
  }

  retentionPolicy() {
    return {
      directory: this._dir,
      format: 'JSONL',
      maxFileSizeBytes: this._maxFileSize,
      maxFiles: this._maxFiles,
      maxTotalBytes: this._maxFileSize * this._maxFiles,
    };
  }
}

module.exports = { DiagnosticLog, LEVEL, CATEGORY, DEFAULTS, redact, sanitizeUrl };
