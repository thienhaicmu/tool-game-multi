'use strict';

// ---------------------------------------------------------------------------
// RuntimeCapacity — WU-C.4. Race-safe cap on SIMULTANEOUSLY running managed
// browsers (maxConcurrentBrowsers). It counts RUNNING + LAUNCHING reservations,
// so two near-simultaneous OPEN requests can never both claim the final slot.
//
// Reservation is SYNCHRONOUS (Node single thread): reserve() checks and mutates in
// one tick with no await, so the check-then-reserve is atomic. This is a tiny
// capacity guard around a launch mutation — NOT a global execution lock. AutoRunner
// concurrency, protocol frames and observers are completely unaffected.
//
// Capacity unit is the application-owned managed BrowserRun, NOT chrome.exe
// processes (one browser instance spawns many Chromium processes).
// ---------------------------------------------------------------------------

class RuntimeCapacity {
  constructor(deps = {}) {
    this._getMax = deps.getMax || (() => null); // null = unlimited (legacy)
    this._slots = new Map(); // token -> browserId
    this._seq = 0;
  }

  runningCount() { return this._slots.size; }
  max() { const m = this._getMax(); return m == null ? null : Number(m); }

  // Atomically reserve a slot (LAUNCHING). Returns { ok, token } or { error }.
  reserve(browserId) {
    const max = this.max();
    if (max != null && this._slots.size >= max) {
      return { error: { code: 'BROWSER_RUNTIME_LIMIT_REACHED', message: 'Đã đạt số trình duyệt được phép chạy đồng thời.', running: this._slots.size, max } };
    }
    const token = 'rc_' + (++this._seq);
    this._slots.set(token, browserId != null ? String(browserId) : null);
    return { ok: true, token };
  }

  // Idempotent release (user close / exit / crash / launch failure / cleanup).
  release(token) {
    if (token && this._slots.has(token)) { this._slots.delete(token); return true; }
    return false;
  }
  releaseBrowser(browserId) {
    let n = 0;
    for (const [t, b] of this._slots) if (b === String(browserId)) { this._slots.delete(t); n += 1; }
    return n;
  }

  snapshot() { const max = this.max(); return { running: this._slots.size, max }; }
}

module.exports = { RuntimeCapacity };
