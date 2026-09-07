'use strict';

const { openDatabase, LATEST_VERSION, currentVersion } = require('./database.cjs');
const { CaptureSessionRepo } = require('./repositories/capture-session-repo.cjs');
const { RawEventRepo } = require('./repositories/raw-event-repo.cjs');
const { RoundRepo } = require('./repositories/round-repo.cjs');
const { NetworkRepo } = require('./repositories/network-repo.cjs');
const { WsRepo } = require('./repositories/ws-repo.cjs');
const { THRESHOLDS, thresholdKey, columnsFor } = require('../thresholds.cjs');

// ---------------------------------------------------------------------------
// AnalyticsStore — MAIN-PROCESS owner of the SQLite database + repositories +
// the validated read/query API. The renderer never gets the handle; only the
// structured results below cross IPC. No executeSQL / arbitrary file access.
// ---------------------------------------------------------------------------

class AnalyticsStore {
  constructor({ file, now = () => Date.now() } = {}) {
    this._now = now;
    this.db = openDatabase({ file });
    this.sessions = new CaptureSessionRepo(this.db, now);
    this.raw = new RawEventRepo(this.db, now);
    this.rounds = new RoundRepo(this.db, now);
    this.network = new NetworkRepo(this.db, now);
    this.ws = new WsRepo(this.db, now);
  }

  schemaVersion() { return currentVersion(this.db); }

  // Startup reconciliation: stale CAPTURING/DISCONNECTED sessions -> INTERRUPTED,
  // and their unfinished rounds -> INTERRUPTED. No fabricated end evidence (§7/§20).
  reconcileOnStartup() {
    const s = this.sessions.reconcileStale();
    const r = this.rounds.reconcileInterrupted(s.ids);
    return { sessions: s.reconciled, rounds: r.reconciled };
  }

  counts() {
    return {
      rawEvents: this.raw.count(),
      rounds: this.rounds.count(),
      sessions: this.sessions.count(),
      oddSamples: this.db.prepare('SELECT COUNT(*) AS n FROM round_odd_samples').get().n,
      jackpotSamples: this.db.prepare('SELECT COUNT(*) AS n FROM round_jackpot_samples').get().n,
      networkRequests: this.network.count(),
      networkResponses: this.network.responseCount(),
      networkBodies: this.network.bodyCount(),
      responseBodyBytes: this.network.bodyBytes(),
      wsConnections: this.ws.connectionCount(),
      wsEvents: this.ws.eventCount(),
      schemaVersion: this.schemaVersion(),
    };
  }

  // ---- query API (validated) ----
  listRounds({ browserId = null, captureSessionId = null, limit = 50, offset = 0, sort = 'sequence_number', dir = 'DESC' } = {}) {
    const res = this.rounds.listRounds({ browserId, captureSessionId, limit, offset, sort, dir });
    return { rounds: res.rows.map(mapRoundRow), total: res.total, limit: res.limit, offset: res.offset };
  }

  getRoundDetail(roundId) {
    const id = Number(roundId);
    if (!Number.isInteger(id) || id <= 0) return { error: { code: 'INVALID_ROUND_ID', message: 'roundId must be a positive integer' } };
    const row = this.rounds.getRound(id);
    if (!row) return { error: { code: 'ROUND_NOT_FOUND', message: 'No such round: ' + id } };
    const oddSamples = this.rounds.getOddSamples(id).map(mapOddSample);
    const jackpotSamples = this.rounds.getJackpotSamples(id).map(mapJackpotSample);
    const metricsRow = this.rounds.getMetrics(id);
    // Bounded related raw events over the round's time window (from samples if lifecycle ts absent).
    const tsAll = [...oddSamples, ...jackpotSamples].map((s) => s.timestampMs).filter((t) => Number.isFinite(t));
    const fromMs = row.opened_at_ms != null ? row.opened_at_ms : (row.first_odd_at_ms != null ? row.first_odd_at_ms : (tsAll.length ? Math.min(...tsAll) : null));
    const toMs = row.ended_at_ms != null ? row.ended_at_ms : (tsAll.length ? Math.max(...tsAll) : fromMs);
    let relatedRawEvents = [];
    if (fromMs != null && toMs != null) relatedRawEvents = this.raw.listForWindow({ captureSessionId: row.capture_session_id, fromMs, toMs, limit: 500 }).map(mapRawEvent);
    return { round: mapRoundRow(row), metrics: mapMetrics(metricsRow), oddSamples, jackpotSamples, relatedRawEvents };
  }

  // SQLite-safe online backup (better-sqlite3 backup API). Produces a
  // self-consistent standalone DB while the source stays open under WAL; the
  // original remains writable and capture may continue. Returns a Promise.
  async backup(destPath) {
    if (!destPath) return { error: { code: 'BACKUP_NO_DEST', message: 'A destination path is required' } };
    try {
      await this.db.backup(String(destPath));
      return { ok: true, path: String(destPath) };
    } catch (err) {
      return { error: { code: 'BACKUP_FAILED', message: String(err && err.message || err) } };
    }
  }

  // Open a standalone DB file read-only and run PRAGMA integrity_check.
  static integrityCheck(file) {
    const Database = require('better-sqlite3');
    const db = new Database(String(file), { readonly: true });
    try { return db.pragma('integrity_check', { simple: true }); } finally { db.close(); }
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

// ---- row mappers (snake_case DB -> camelCase API) ----
function mapRoundRow(r) {
  if (!r) return null;
  return {
    id: r.id, captureSessionId: r.capture_session_id, browserId: r.browser_id, sid: r.sid,
    sequenceNumber: r.sequence_number,
    openedAtMs: r.opened_at_ms, lockedAtMs: r.locked_at_ms, firstOddAtMs: r.first_odd_at_ms, endedAtMs: r.ended_at_ms, durationMs: r.duration_ms,
    firstOdd: r.first_odd, lastOdd: r.last_odd, maxOdd: r.max_odd,
    jackpotAtOpen: r.jackpot_at_open, jackpotAtLock: r.jackpot_at_lock, jackpotAtFirstOdd: r.jackpot_at_first_odd, jackpotAtEnd: r.jackpot_at_end,
    jackpotMin: r.jackpot_min, jackpotMax: r.jackpot_max, jackpotAvg: r.jackpot_avg, jackpotDelta: r.jackpot_delta,
    oddSampleCount: r.odd_sample_count, jackpotSampleCount: r.jackpot_sample_count,
    completeness: r.completeness,
  };
}
function mapOddSample(s) { return { sequence: s.sequence, timestampMs: s.timestamp_ms, elapsedFromFirstOddMs: s.elapsed_from_first_odd_ms, odd: s.odd, sourceEventId: s.source_event_id }; }
function mapJackpotSample(s) { return { sequence: s.sequence, timestampMs: s.timestamp_ms, elapsedMs: s.elapsed_ms, jackpot: s.jackpot, sourceEventId: s.source_event_id }; }
function mapRawEvent(e) {
  return { id: e.id, direction: e.direction, origin: e.origin, timestampMs: e.wall_timestamp_ms, cmd: e.cmd, type: e.event_type, sid: e.sid, odd: e.odd, jackpot: e.jackpot, parseStatus: e.parse_status, raw: e.raw_payload };
}
function mapMetrics(m) {
  if (!m) return null;
  const out = { timingCensored: !!m.timing_censored, thresholds: {} };
  for (const t of THRESHOLDS) {
    const c = columnsFor(t); const k = thresholdKey(t);
    out.thresholds[t] = { reached: !!m[c.reached], timeToMs: m[c.time] != null ? m[c.time] : null };
  }
  return out;
}

module.exports = { AnalyticsStore, LATEST_VERSION };
