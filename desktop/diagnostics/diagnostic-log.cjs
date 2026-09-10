'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
// Redaction is the SHARED canonical policy (also used by TrafficStore + Analytics).
const { REDACTED, SENSITIVE_KEY, SENSITIVE_QUERY, sanitizeUrl, redactString, redact } = require('./redaction.cjs');

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

  // Rewrite every diagnostic file keeping only the records for which keep(rec) is true.
  // Unparseable lines are KEPT (never mass-dropped on a parse glitch). An emptied ARCHIVE
  // file is unlinked; the ACTIVE file is left in place (possibly empty). Returns dropped
  // count. This method itself writes NO diagnostic records (avoids cleanup recursion, §23).
  _rewrite(keep) {
    let dropped = 0;
    if (!this._dir) return dropped;
    const active = this.activeFile();
    for (const file of this.files()) {
      let raw;
      try { raw = this._fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = raw.split('\n').filter((l) => l.length);
      const kept = [];
      for (const line of lines) {
        let rec = null;
        try { rec = JSON.parse(line); } catch { kept.push(line); continue; } // malformed -> keep
        if (keep(rec)) kept.push(line); else dropped++;
      }
      if (kept.length === lines.length) continue; // unchanged
      if (kept.length === 0 && file !== active) { try { this._fs.unlinkSync(file); } catch { /* best effort */ } continue; }
      const body = kept.length ? kept.join('\n') + '\n' : '';
      try {
        const tmp = file + '.tmp';
        this._fs.writeFileSync(tmp, body, 'utf8');
        this._fs.renameSync(tmp, file);
      } catch { /* best effort */ }
    }
    this._size = null; // active-file size cache is stale after rewrite
    return dropped;
  }

  // §8 — remove only THIS browser's diagnostic records from the shared store; B2 untouched.
  purgeBrowser(browserId) {
    const bid = String(browserId);
    const dropped = this._rewrite((rec) => String(rec.browserId) !== bid);
    return { ok: true, dropped };
  }

  // §16 — automatic 48h retention. Drop records whose timestamp is at least maxAgeMs old.
  // Missing/invalid/future timestamps are KEPT (§20). Works alongside size-based rotation.
  purgeExpired({ now = this._now(), maxAgeMs } = {}) {
    if (!Number.isFinite(Number(maxAgeMs))) return { ok: true, dropped: 0 };
    const cutoff = now - Number(maxAgeMs);
    const dropped = this._rewrite((rec) => {
      const ms = Date.parse(rec.ts);
      if (!Number.isFinite(ms)) return true;   // missing/invalid -> keep
      if (ms > now) return true;                // future -> keep
      return ms > cutoff;                       // keep only younger than maxAgeMs
    });
    return { ok: true, dropped };
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
