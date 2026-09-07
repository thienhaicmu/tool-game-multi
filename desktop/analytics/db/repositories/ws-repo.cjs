'use strict';

// ws_connections / raw_ws_events persistence. raw_ws_events is the append-only raw
// WebSocket evidence from which raw_protocol_events are derived. direction SEND means
// the WEBSITE sent the frame — never Analytics.

class WsRepo {
  constructor(db, now = () => Date.now()) {
    this._db = db; this._now = now;
    this._insConn = db.prepare(
      `INSERT INTO ws_connections (capture_session_id, browser_id, target_id, request_id, url, opened_at_ms, created_at_ms)
       VALUES (@captureSessionId, @browserId, @targetId, @requestId, @url, @openedAtMs, @createdAtMs)`);
    this._insEvent = db.prepare(
      `INSERT INTO raw_ws_events
        (ws_connection_id, capture_session_id, browser_id, direction, timestamp_ms, monotonic_ms, opcode,
         payload, payload_size, parse_status, cmd, event_type, sid, odd, jackpot, created_at_ms)
       VALUES
        (@wsConnectionId, @captureSessionId, @browserId, @direction, @timestampMs, @monotonicMs, @opcode,
         @payload, @payloadSize, @parseStatus, @cmd, @eventType, @sid, @odd, @jackpot, @createdAtMs)`);
  }

  insertConnection(e) {
    const info = this._insConn.run({
      captureSessionId: Number(e.captureSessionId), browserId: String(e.browserId),
      targetId: e.targetId != null ? String(e.targetId) : null, requestId: e.requestId != null ? String(e.requestId) : null,
      url: e.url != null ? String(e.url) : null, openedAtMs: e.openedAtMs != null ? Number(e.openedAtMs) : this._now(),
      createdAtMs: this._now(),
    });
    return Number(info.lastInsertRowid);
  }

  closeConnection(id, { closedAtMs, closeStatus } = {}) {
    this._db.prepare('UPDATE ws_connections SET closed_at_ms = ?, close_status = ? WHERE id = ?')
      .run(closedAtMs != null ? Number(closedAtMs) : this._now(), closeStatus != null ? String(closeStatus) : null, Number(id));
  }

  insertEvent(e) {
    const info = this._insEvent.run({
      wsConnectionId: e.wsConnectionId != null ? Number(e.wsConnectionId) : null,
      captureSessionId: Number(e.captureSessionId), browserId: String(e.browserId),
      direction: e.direction === 'SEND' ? 'SEND' : 'RECV',
      timestampMs: Number(e.timestampMs != null ? e.timestampMs : this._now()),
      monotonicMs: Number.isFinite(e.monotonicMs) ? e.monotonicMs : null,
      opcode: Number.isFinite(e.opcode) ? e.opcode : null,
      payload: e.payload != null ? String(e.payload) : null,
      payloadSize: Number.isFinite(e.payloadSize) ? e.payloadSize : (e.payload != null ? String(e.payload).length : null),
      parseStatus: e.parseStatus != null ? String(e.parseStatus) : null,
      cmd: Number.isFinite(e.cmd) ? e.cmd : null, eventType: e.eventType != null ? String(e.eventType) : null,
      sid: e.sid != null ? String(e.sid) : null, odd: Number.isFinite(e.odd) ? e.odd : null, jackpot: Number.isFinite(e.jackpot) ? e.jackpot : null,
      createdAtMs: this._now(),
    });
    if (e.wsConnectionId != null) {
      const col = e.direction === 'SEND' ? 'send_count' : 'recv_count';
      this._db.prepare(`UPDATE ws_connections SET ${col} = ${col} + 1 WHERE id = ?`).run(Number(e.wsConnectionId));
    }
    return Number(info.lastInsertRowid);
  }

  getConnection(id) { return this._db.prepare('SELECT * FROM ws_connections WHERE id = ?').get(Number(id)) || null; }
  getEvents(connId, { limit = 1000 } = {}) { return this._db.prepare('SELECT * FROM raw_ws_events WHERE ws_connection_id = ? ORDER BY id ASC LIMIT ?').all(Number(connId), Math.max(1, Math.min(5000, Number(limit) || 1000))); }
  connectionCount() { return this._db.prepare('SELECT COUNT(*) AS n FROM ws_connections').get().n; }
  eventCount() { return this._db.prepare('SELECT COUNT(*) AS n FROM raw_ws_events').get().n; }
}

module.exports = { WsRepo };
