'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// ProtocolContext — owns the session aid/eid. These are session context set at
// server login / session init, NOT test inputs: they must never be hardcoded,
// user-entered, or shown as editable fields. The tool learns them by observing
// the real client's protocol frames (any frame carrying both aid and eid — an
// enter/login frame or the client's own bet/cashout). The FIRST observed pair is
// adopted and kept stable for the session.
//
// Until a pair is observed the context is NOT ready and ALL protocol testing must
// be disabled ("Waiting for login context…").
// ---------------------------------------------------------------------------
class ProtocolContext extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._aid = null;
    this._eid = null;
    this._at = null;
    if (deps.roundTracker && deps.roundTracker.on) deps.roundTracker.on('frame', (ev) => this.observe(ev));
  }

  // Adopt the first frame that carries both aid and eid.
  observe(ev) {
    if (!ev || ev.aid == null || ev.eid == null) return;
    if (this._aid != null) return; // already have the session context; keep it stable
    this._aid = ev.aid;
    this._eid = ev.eid;
    this._at = Date.now();
    this.emit('change', this.get());
  }

  get() { return { aid: this._aid, eid: this._eid, ready: this._aid != null && this._eid != null, at: this._at }; }

  // Called when the target/session goes away, so a fresh login is re-detected.
  reset() {
    if (this._aid == null && this._eid == null) return;
    this._aid = null; this._eid = null; this._at = null;
    this.emit('change', this.get());
  }
}

module.exports = { ProtocolContext };
