'use strict';

// A lease belongs to an operation, never just a browser. An old finally cannot
// release a newer operation's lease after STOP/cancel and restart.
class FindLock {
  constructor(now = Date.now) { this.now = now; this.current = null; this.sequence = 0; }
  acquire(ownerBrowserId, sessionId) {
    if (this.current) return null;
    const lease = { ownerBrowserId: String(ownerBrowserId), sessionId, sequence: ++this.sequence,
      acquiredAt: this.now(), controller: new AbortController() };
    this.current = lease;
    return lease;
  }
  release(lease) { if (this.current === lease) this.current = null; }
  cancel(ownerBrowserId) {
    const lease = this.current;
    if (!lease || (ownerBrowserId != null && lease.ownerBrowserId !== String(ownerBrowserId))) return;
    lease.controller.abort();
    this.release(lease);
  }
  snapshot() {
    if (!this.current) return null;
    const { ownerBrowserId, sessionId, sequence, acquiredAt } = this.current;
    return { ownerBrowserId, sessionId, sequence, acquiredAt };
  }
}
module.exports = { FindLock };
