'use strict';

const { THRESHOLDS, thresholdKey, columnsFor } = require('../../thresholds.cjs');

// rounds + round_odd_samples + round_jackpot_samples + round_metrics persistence.
// Rounds are inserted at start (ended_at NULL, completeness UNKNOWN) and updated
// as evidence arrives; finalize writes the terminal aggregates + metrics in one
// transaction. Never fabricates values: absent evidence stays NULL.

const SORT_COLUMNS = new Set(['sequence_number', 'opened_at_ms', 'ended_at_ms', 'max_odd', 'id']);

class RoundRepo {
  constructor(db, now = () => Date.now()) {
    this._db = db; this._now = now;

    this._insertRound = db.prepare(
      `INSERT INTO rounds (capture_session_id, browser_id, sid, sequence_number, opened_at_ms,
         completeness, odd_sample_count, jackpot_sample_count, created_at_ms, updated_at_ms)
       VALUES (@captureSessionId, @browserId, @sid, @sequenceNumber, @openedAtMs, @completeness, 0, 0, @now, @now)`
    );
    this._updateRound = db.prepare(
      `UPDATE rounds SET
         sid = @sid, opened_at_ms = @openedAtMs, locked_at_ms = @lockedAtMs,
         first_odd_at_ms = @firstOddAtMs, ended_at_ms = @endedAtMs, duration_ms = @durationMs,
         first_odd = @firstOdd, last_odd = @lastOdd, max_odd = @maxOdd,
         jackpot_at_open = @jackpotAtOpen, jackpot_at_lock = @jackpotAtLock,
         jackpot_at_first_odd = @jackpotAtFirstOdd, jackpot_at_end = @jackpotAtEnd,
         jackpot_min = @jackpotMin, jackpot_max = @jackpotMax, jackpot_avg = @jackpotAvg, jackpot_delta = @jackpotDelta,
         odd_sample_count = @oddSampleCount, jackpot_sample_count = @jackpotSampleCount,
         completeness = @completeness, updated_at_ms = @now
       WHERE id = @id`
    );
    this._insertOdd = db.prepare(
      `INSERT INTO round_odd_samples (round_id, sequence, timestamp_ms, elapsed_from_first_odd_ms, odd, source_event_id)
       VALUES (@roundId, @sequence, @timestampMs, @elapsedFromFirstOddMs, @odd, @sourceEventId)`
    );
    this._insertJp = db.prepare(
      `INSERT INTO round_jackpot_samples (round_id, sequence, timestamp_ms, elapsed_ms, jackpot, source_event_id)
       VALUES (@roundId, @sequence, @timestampMs, @elapsedMs, @jackpot, @sourceEventId)`
    );

    // round_metrics upsert, columns generated from the shared threshold list.
    const cols = ['round_id', 'timing_censored'];
    const params = ['@roundId', '@timingCensored'];
    for (const t of THRESHOLDS) {
      const c = columnsFor(t); const k = thresholdKey(t);
      cols.push(c.reached, c.time);
      params.push(`@reached_${k}`, `@time_${k}`);
    }
    this._upsertMetrics = db.prepare(
      `INSERT OR REPLACE INTO round_metrics (${cols.join(', ')}) VALUES (${params.join(', ')})`
    );
  }

  insertRound({ captureSessionId, browserId, sid, sequenceNumber, openedAtMs, completeness = 'UNKNOWN' }) {
    const info = this._insertRound.run({
      captureSessionId: Number(captureSessionId), browserId: String(browserId),
      sid: sid != null ? String(sid) : null, sequenceNumber: Number(sequenceNumber),
      openedAtMs: openedAtMs != null ? Number(openedAtMs) : null, completeness, now: this._now(),
    });
    return Number(info.lastInsertRowid);
  }

  _roundParams(id, r) {
    return {
      id: Number(id), now: this._now(),
      sid: r.sid != null ? String(r.sid) : null,
      openedAtMs: num(r.openedAtMs), lockedAtMs: num(r.lockedAtMs), firstOddAtMs: num(r.firstOddAtMs),
      endedAtMs: num(r.endedAtMs), durationMs: num(r.durationMs),
      firstOdd: num(r.firstOdd), lastOdd: num(r.lastOdd), maxOdd: num(r.maxOdd),
      jackpotAtOpen: num(r.jackpotAtOpen), jackpotAtLock: num(r.jackpotAtLock),
      jackpotAtFirstOdd: num(r.jackpotAtFirstOdd), jackpotAtEnd: num(r.jackpotAtEnd),
      jackpotMin: num(r.jackpotMin), jackpotMax: num(r.jackpotMax), jackpotAvg: num(r.jackpotAvg), jackpotDelta: num(r.jackpotDelta),
      oddSampleCount: Number(r.oddSampleCount || 0), jackpotSampleCount: Number(r.jackpotSampleCount || 0),
      completeness: r.completeness || 'UNKNOWN',
    };
  }

  updateRound(id, r) { this._updateRound.run(this._roundParams(id, r)); }

  insertOddSample(s) {
    this._insertOdd.run({ roundId: Number(s.roundId), sequence: Number(s.sequence), timestampMs: Number(s.timestampMs),
      elapsedFromFirstOddMs: num(s.elapsedFromFirstOddMs), odd: Number(s.odd), sourceEventId: s.sourceEventId != null ? Number(s.sourceEventId) : null });
  }
  insertJackpotSample(s) {
    this._insertJp.run({ roundId: Number(s.roundId), sequence: Number(s.sequence), timestampMs: Number(s.timestampMs),
      elapsedMs: num(s.elapsedMs), jackpot: Number(s.jackpot), sourceEventId: s.sourceEventId != null ? Number(s.sourceEventId) : null });
  }

  upsertMetrics(id, metrics = {}) {
    const p = { roundId: Number(id), timingCensored: metrics.censored ? 1 : 0 };
    for (const t of THRESHOLDS) {
      const k = thresholdKey(t);
      p[`reached_${k}`] = (metrics.reached && metrics.reached[k]) ? 1 : 0;
      const tm = metrics.timings ? metrics.timings[k] : null;
      p[`time_${k}`] = Number.isFinite(tm) ? tm : null;
    }
    this._upsertMetrics.run(p);
  }

  // Terminal write: round aggregates + metrics in a single transaction.
  finalize(id, round) {
    const tx = this._db.transaction(() => {
      this.updateRound(id, round);
      this.upsertMetrics(id, round.metrics || {});
    });
    tx();
  }

  // ---- reads ----
  getRound(id) { return this._db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(id)) || null; }
  getOddSamples(roundId) { return this._db.prepare('SELECT * FROM round_odd_samples WHERE round_id = ? ORDER BY sequence ASC').all(Number(roundId)); }
  getJackpotSamples(roundId) { return this._db.prepare('SELECT * FROM round_jackpot_samples WHERE round_id = ? ORDER BY sequence ASC').all(Number(roundId)); }
  getMetrics(roundId) { return this._db.prepare('SELECT * FROM round_metrics WHERE round_id = ?').get(Number(roundId)) || null; }

  count({ browserId, captureSessionId } = {}) {
    if (captureSessionId != null) return this._db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE capture_session_id = ?').get(Number(captureSessionId)).n;
    if (browserId != null) return this._db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE browser_id = ?').get(String(browserId)).n;
    return this._db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n;
  }

  maxSequence(browserId) {
    const row = this._db.prepare('SELECT MAX(sequence_number) AS m FROM rounds WHERE browser_id = ?').get(String(browserId));
    return row && row.m != null ? row.m : 0;
  }

  listRounds({ browserId = null, captureSessionId = null, limit = 50, offset = 0, sort = 'sequence_number', dir = 'DESC' } = {}) {
    const where = []; const args = [];
    if (browserId != null) { where.push('browser_id = ?'); args.push(String(browserId)); }
    if (captureSessionId != null) { where.push('capture_session_id = ?'); args.push(Number(captureSessionId)); }
    const sortCol = SORT_COLUMNS.has(sort) ? sort : 'sequence_number';
    const sortDir = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const lim = Math.max(1, Math.min(1000, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const sql = `SELECT * FROM rounds ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sortCol} ${sortDir}, id ${sortDir} LIMIT ? OFFSET ?`;
    const rows = this._db.prepare(sql).all(...args, lim, off);
    const total = this.count({ browserId, captureSessionId });
    return { rows, total, limit: lim, offset: off };
  }

  // Startup reconciliation: unfinished rounds (ended_at IS NULL) that are not yet
  // terminal become INTERRUPTED. No fabricated ended_at / END evidence.
  reconcileInterrupted(sessionIds) {
    if (!sessionIds || !sessionIds.length) return { reconciled: 0 };
    const now = this._now();
    const upd = this._db.prepare("UPDATE rounds SET completeness = 'INTERRUPTED', updated_at_ms = ? WHERE capture_session_id = ? AND ended_at_ms IS NULL AND completeness IN ('UNKNOWN','PARTIAL_START')");
    let n = 0;
    const tx = this._db.transaction((ids) => { for (const id of ids) { n += upd.run(now, Number(id)).changes; } });
    tx(sessionIds);
    return { reconciled: n };
  }
}

function num(v) { return Number.isFinite(v) ? v : null; }

module.exports = { RoundRepo, SORT_COLUMNS };
