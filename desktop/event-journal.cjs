const fs = require('node:fs');
const path = require('node:path');

// Every captured event (incl. each game WS frame) lands here, so writes are batched and
// asynchronous: a synchronous append per frame blocked the main process (and re-opened the
// file each time, which Windows AV scans) for the whole session. maxBytes caps one session's
// journal; past it a single marker line is written and further events are dropped.
const DEFAULT_FLUSH_MS = 500;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const FLUSH_NOW_BYTES = 1024 * 1024;

class EventJournal {
  constructor(file, options = {}) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this._flushMs = options.flushMs != null ? Number(options.flushMs) : DEFAULT_FLUSH_MS;
    this._maxBytes = options.maxBytes != null ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
    try { this._bytes = fs.statSync(file).size; } catch { this._bytes = 0; }
    this._buf = [];
    this._bufBytes = 0;
    this._timer = null;
    this._writing = false;
    this._capped = false;
  }

  append(event) {
    if (this._capped) return;
    const line = JSON.stringify({ ...event, journaledAt: new Date().toISOString() }) + '\n';
    this._buf.push(line);
    this._bufBytes += Buffer.byteLength(line, 'utf8');
    if (this._flushMs <= 0 || this._bufBytes >= FLUSH_NOW_BYTES) { this.flush(); return; }
    if (!this._timer) {
      this._timer = setTimeout(() => { this._timer = null; this.flush(); }, this._flushMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  _take() {
    if (!this._buf.length) return '';
    let chunk = this._buf.join('');
    this._buf = []; this._bufBytes = 0;
    const size = Buffer.byteLength(chunk, 'utf8');
    if (this._bytes + size > this._maxBytes) {
      this._capped = true;
      chunk = JSON.stringify({ kind: 'journal-capped', maxBytes: this._maxBytes, journaledAt: new Date().toISOString() }) + '\n';
    }
    this._bytes += Buffer.byteLength(chunk, 'utf8');
    return chunk;
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._flushMs <= 0) { const chunk = this._take(); if (chunk) fs.appendFileSync(this.file, chunk, 'utf8'); return; }
    if (this._writing) return; // the in-flight write re-flushes whatever accumulated meanwhile
    const chunk = this._take();
    if (!chunk) return;
    this._writing = true;
    fs.appendFile(this.file, chunk, 'utf8', () => {
      this._writing = false;
      if (this._buf.length) this.flush();
    });
  }

  // Quit path: persist whatever is still buffered before the process exits.
  flushSync() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const chunk = this._take();
    if (chunk) { try { fs.appendFileSync(this.file, chunk, 'utf8'); } catch { /* best effort */ } }
  }
}

module.exports = { EventJournal };
