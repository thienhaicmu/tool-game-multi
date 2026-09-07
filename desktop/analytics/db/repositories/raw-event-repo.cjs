'use strict';

// raw_protocol_events — the SOURCE OF TRUTH. Append-oriented. Malformed frames,
// unknown commands and website SEND frames are all retained; parsed fields stay
// NULL when not proven. No fabrication.

class RawEventRepo {
  constructor(db, now = () => Date.now()) {
    this._db = db; this._now = now;
    this._insert = db.prepare(
      `INSERT INTO raw_protocol_events
        (capture_session_id, browser_id, ws_connection_id, direction, origin,
         wall_timestamp_ms, monotonic_timestamp_ms, opcode, raw_payload,
         parse_status, parse_error, cmd, event_type, sid, odd, jackpot,
         source_target_id, source_session_id, created_at_ms)
       VALUES
        (@captureSessionId, @browserId, @wsConnectionId, @direction, @origin,
         @wallTimestampMs, @monotonicTimestampMs, @opcode, @rawPayload,
         @parseStatus, @parseError, @cmd, @eventType, @sid, @odd, @jackpot,
         @sourceTargetId, @sourceSessionId, @createdAtMs)`
    );
  }

  append(e) {
    const row = {
      captureSessionId: Number(e.captureSessionId),
      browserId: String(e.browserId),
      wsConnectionId: e.wsConnectionId != null ? String(e.wsConnectionId) : null,
      direction: e.direction === 'SEND' ? 'SEND' : 'RECV',
      origin: e.origin != null ? String(e.origin) : null,
      wallTimestampMs: Number(e.wallTimestampMs != null ? e.wallTimestampMs : this._now()),
      monotonicTimestampMs: e.monotonicTimestampMs != null ? Number(e.monotonicTimestampMs) : null,
      opcode: e.opcode != null ? Number(e.opcode) : null,
      rawPayload: e.rawPayload != null ? String(e.rawPayload) : null,
      parseStatus: e.parseStatus || 'UNPARSED',
      parseError: e.parseError != null ? String(e.parseError) : null,
      cmd: Number.isFinite(e.cmd) ? e.cmd : null,
      eventType: e.eventType != null ? String(e.eventType) : null,
      sid: e.sid != null ? String(e.sid) : null,
      odd: Number.isFinite(e.odd) ? e.odd : null,
      jackpot: Number.isFinite(e.jackpot) ? e.jackpot : null,
      sourceTargetId: e.sourceTargetId != null ? String(e.sourceTargetId) : null,
      sourceSessionId: e.sourceSessionId != null ? String(e.sourceSessionId) : null,
      createdAtMs: this._now(),
    };
    const info = this._insert.run(row);
    return Number(info.lastInsertRowid);
  }

  count({ browserId, captureSessionId } = {}) {
    if (captureSessionId != null) return this._db.prepare('SELECT COUNT(*) AS n FROM raw_protocol_events WHERE capture_session_id = ?').get(Number(captureSessionId)).n;
    if (browserId != null) return this._db.prepare('SELECT COUNT(*) AS n FROM raw_protocol_events WHERE browser_id = ?').get(String(browserId)).n;
    return this._db.prepare('SELECT COUNT(*) AS n FROM raw_protocol_events').get().n;
  }

  // Raw events for a round's time window (bounded). Used by getRoundDetail.
  listForWindow({ captureSessionId, fromMs, toMs, limit = 500 }) {
    const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
    return this._db.prepare(
      `SELECT * FROM raw_protocol_events
        WHERE capture_session_id = ? AND wall_timestamp_ms >= ? AND wall_timestamp_ms <= ?
        ORDER BY id ASC LIMIT ?`
    ).all(Number(captureSessionId), Number(fromMs), Number(toMs), lim);
  }
}

module.exports = { RawEventRepo };
