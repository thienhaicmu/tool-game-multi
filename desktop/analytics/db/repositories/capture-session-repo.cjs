'use strict';

// CaptureSession persistence. A session is one observation period for a browser.
// Status: CAPTURING | DISCONNECTED | LOGIN_REQUIRED | STOPPED | INTERRUPTED | FAILED.

const VALID_STATUS = new Set(['CAPTURING', 'DISCONNECTED', 'LOGIN_REQUIRED', 'STOPPED', 'INTERRUPTED', 'FAILED']);

class CaptureSessionRepo {
  constructor(db, now = () => Date.now()) { this._db = db; this._now = now; }

  start({ browserId, startedAtMs }) {
    const t = startedAtMs != null ? startedAtMs : this._now();
    const info = this._db.prepare(
      `INSERT INTO capture_sessions (browser_id, started_at_ms, ended_at_ms, status, last_event_at_ms, disconnect_count, created_at_ms, updated_at_ms)
       VALUES (?, ?, NULL, 'CAPTURING', NULL, 0, ?, ?)`
    ).run(String(browserId), t, t, t);
    return Number(info.lastInsertRowid);
  }

  touch(id, atMs) {
    const t = atMs != null ? atMs : this._now();
    this._db.prepare('UPDATE capture_sessions SET last_event_at_ms = ?, updated_at_ms = ? WHERE id = ?').run(t, this._now(), Number(id));
  }

  setStatus(id, status, { endedAtMs } = {}) {
    if (!VALID_STATUS.has(status)) throw new Error('Invalid capture session status: ' + status);
    const now = this._now();
    if (endedAtMs !== undefined) {
      this._db.prepare('UPDATE capture_sessions SET status = ?, ended_at_ms = ?, updated_at_ms = ? WHERE id = ?').run(status, endedAtMs, now, Number(id));
    } else {
      this._db.prepare('UPDATE capture_sessions SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now, Number(id));
    }
  }

  incrementDisconnect(id) {
    this._db.prepare('UPDATE capture_sessions SET disconnect_count = disconnect_count + 1, updated_at_ms = ? WHERE id = ?').run(this._now(), Number(id));
  }

  get(id) { return this._db.prepare('SELECT * FROM capture_sessions WHERE id = ?').get(Number(id)) || null; }
  listByBrowser(browserId) { return this._db.prepare('SELECT * FROM capture_sessions WHERE browser_id = ? ORDER BY id DESC').all(String(browserId)); }
  count() { return this._db.prepare('SELECT COUNT(*) AS n FROM capture_sessions').get().n; }

  // Startup reconciliation: any session still CAPTURING (or DISCONNECTED) from a
  // previous process is not trustworthy -> INTERRUPTED. No fabricated ended_at.
  reconcileStale() {
    const rows = this._db.prepare("SELECT id FROM capture_sessions WHERE status IN ('CAPTURING','DISCONNECTED')").all();
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      const now = this._now();
      const upd = this._db.prepare("UPDATE capture_sessions SET status = 'INTERRUPTED', updated_at_ms = ? WHERE id = ?");
      const tx = this._db.transaction((list) => { for (const id of list) upd.run(now, id); });
      tx(ids);
    }
    return { reconciled: ids.length, ids };
  }
}

module.exports = { CaptureSessionRepo, VALID_STATUS };
