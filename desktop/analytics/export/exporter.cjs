'use strict';

const fs = require('node:fs');
const { buildWhere, basisColumn } = require('../query/analytics-filter.cjs');
const { THRESHOLDS, thresholdKey, columnsFor } = require('../thresholds.cjs');

// ---------------------------------------------------------------------------
// Read-only exporters. All operate in the MAIN process directly against the
// persisted SQLite DB (never renderer state), stream rows to avoid loading huge
// sets into memory, and never emit protocol actions. NULL is rendered as an empty
// CSV field / JSON null. Column order is deterministic.
// ---------------------------------------------------------------------------

const EXPORT_SCHEMA_VERSION = 1;

// deterministic CSV column order
const ROUND_CSV_BASE = [
  'sequenceNumber', 'browserId', 'captureSessionId', 'sid', 'completeness',
  'openedAtMs', 'lockedAtMs', 'firstOddAtMs', 'endedAtMs', 'durationMs',
  'firstOdd', 'lastOdd', 'maxOdd',
  'jackpotAtOpen', 'jackpotAtLock', 'jackpotAtFirstOdd', 'jackpotAtEnd',
  'jackpotMin', 'jackpotMax', 'jackpotAvg', 'jackpotDelta',
  'oddSampleCount', 'jackpotSampleCount', 'timingCensored',
];
function roundCsvHeader() {
  const cols = [...ROUND_CSV_BASE];
  for (const t of THRESHOLDS) { const k = thresholdKey(t); cols.push(`reached_${k}`, `timeTo_${k}_ms`); }
  return cols;
}

function csvCell(v) {
  if (v == null) return '';                 // consistent NULL representation
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvLine(values) { return values.map(csvCell).join(',') + '\r\n'; }

// Rounds CSV over the filtered set. Streams via db.iterate; returns { rows, path }.
function exportRoundsCsv(store, spec, outPath) {
  const db = store.db;
  const { clause, params } = buildWhere(spec, { includeAnalytic: true });
  const limit = spec.lastNRounds != null ? spec.lastNRounds : 1e9;
  const metricSel = [];
  for (const t of THRESHOLDS) { const c = columnsFor(t); metricSel.push(`m.${c.reached}`, `m.${c.time}`); }
  const sql = `SELECT r.*, m.timing_censored AS m_censored, ${metricSel.join(', ')}
    FROM rounds r LEFT JOIN round_metrics m ON m.round_id = r.id ${clause}
    ORDER BY r.sequence_number DESC LIMIT ?`;
  const header = roundCsvHeader();
  const fd = fs.openSync(outPath, 'w');
  let rows = 0;
  try {
    fs.writeSync(fd, header.join(',') + '\r\n');
    for (const r of db.prepare(sql).iterate(...params, limit)) {
      const base = [
        r.sequence_number, r.browser_id, r.capture_session_id, r.sid, r.completeness,
        r.opened_at_ms, r.locked_at_ms, r.first_odd_at_ms, r.ended_at_ms, r.duration_ms,
        r.first_odd, r.last_odd, r.max_odd,
        r.jackpot_at_open, r.jackpot_at_lock, r.jackpot_at_first_odd, r.jackpot_at_end,
        r.jackpot_min, r.jackpot_max, r.jackpot_avg, r.jackpot_delta,
        r.odd_sample_count, r.jackpot_sample_count, r.m_censored == null ? '' : r.m_censored,
      ];
      for (const t of THRESHOLDS) { const c = columnsFor(t); base.push(r[c.reached] == null ? '' : r[c.reached], r[c.time]); }
      fs.writeSync(fd, csvLine(base));
      rows++;
    }
  } finally { fs.closeSync(fd); }
  return { ok: true, path: outPath, rows };
}

// One round → JSON with normalized round + metrics + samples + related raw events.
function exportRoundDetailJson(store, roundId, outPath) {
  const detail = store.getRoundDetail(roundId);
  if (detail.error) return detail;
  const payload = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    round: detail.round,
    metrics: detail.metrics,
    oddSamples: detail.oddSamples,
    jackpotSamples: detail.jackpotSamples,
    rawEvents: detail.relatedRawEvents,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true, path: outPath, roundId: detail.round.id };
}

// Raw events → JSONL (one raw_protocol_events row per line), streamed. Scoped by
// session/browser/time. rawPayload preserved verbatim.
function exportRawEventsJsonl(store, { captureSessionId = null, browserId = null, fromMs = null, toMs = null } = {}, outPath) {
  const db = store.db;
  const where = []; const params = [];
  if (captureSessionId != null) { where.push('capture_session_id = ?'); params.push(Number(captureSessionId)); }
  if (browserId != null) { where.push('browser_id = ?'); params.push(String(browserId)); }
  if (fromMs != null) { where.push('wall_timestamp_ms >= ?'); params.push(Number(fromMs)); }
  if (toMs != null) { where.push('wall_timestamp_ms <= ?'); params.push(Number(toMs)); }
  const sql = `SELECT * FROM raw_protocol_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
  const fd = fs.openSync(outPath, 'w');
  let lines = 0;
  try {
    for (const r of db.prepare(sql).iterate(...params)) { fs.writeSync(fd, JSON.stringify(r) + '\n'); lines++; }
  } finally { fs.closeSync(fd); }
  return { ok: true, path: outPath, lines };
}

module.exports = { exportRoundsCsv, exportRoundDetailJson, exportRawEventsJsonl, roundCsvHeader, csvCell, EXPORT_SCHEMA_VERSION };
