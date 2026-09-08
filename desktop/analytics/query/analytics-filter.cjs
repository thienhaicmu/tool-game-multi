'use strict';

// ---------------------------------------------------------------------------
// AnalyticsFilter — the single reusable filter contract for every analytics
// query. Normalizes/validates a raw filter and builds a deterministic SQL WHERE
// clause. All filters combine with AND semantics.
//
// Locked conventions:
//   - TIME BASIS: rounds.opened_at_ms (local capture wall clock). Hour-of-day,
//     day-of-week and specific-date use SQLite 'localtime' (system timezone),
//     which matches JS local Date used in the engine.
//   - RANGE filters (jackpotMin/Max, maxOddMin/Max, time) are INCLUSIVE both ends.
//   - DEFAULT completeness = COMPLETE only (partial rounds are opt-in).
//   - LAST-N applies AFTER all other filters: the chronologically latest N rounds
//     (ORDER BY sequence_number DESC) among rounds matching every other filter.
// ---------------------------------------------------------------------------

const COMPLETENESS_VALUES = new Set(['COMPLETE', 'PARTIAL_START', 'PARTIAL_END', 'INTERRUPTED', 'UNKNOWN']);
const JACKPOT_BASIS_COLUMN = Object.freeze({
  JACKPOT_AT_OPEN: 'jackpot_at_open',
  JACKPOT_AT_LOCK: 'jackpot_at_lock',
  JACKPOT_AT_FIRST_ODD: 'jackpot_at_first_odd',
  JACKPOT_AT_END: 'jackpot_at_end',
  JACKPOT_MIN: 'jackpot_min',
  JACKPOT_MAX: 'jackpot_max',
  JACKPOT_AVG: 'jackpot_avg',
  JACKPOT_DELTA: 'jackpot_delta',
});
const MAX_LAST_N = 100000;

class FilterError extends Error { constructor(message) { super(message); this.name = 'FilterError'; this.code = 'INVALID_FILTER'; } }

function numOrNull(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }
function intOrNull(v) { const n = Number(v); return Number.isInteger(n) ? n : (Number.isFinite(n) ? Math.trunc(n) : null); }

// Validate + normalize a raw filter into a canonical spec. Throws FilterError on bad input.
function normalizeFilter(raw = {}) {
  const f = raw || {};
  const spec = {};
  spec.browserId = f.browserId != null ? String(f.browserId) : null;
  spec.captureSessionId = f.captureSessionId != null ? Number(f.captureSessionId) : null;
  if (spec.captureSessionId != null && !Number.isFinite(spec.captureSessionId)) throw new FilterError('captureSessionId must be numeric');

  spec.timeFromMs = numOrNull(f.timeFromMs);
  spec.timeToMs = numOrNull(f.timeToMs);
  if (spec.timeFromMs != null && spec.timeToMs != null && spec.timeFromMs > spec.timeToMs) throw new FilterError('timeFromMs must be <= timeToMs');

  spec.lastNRounds = null;
  if (f.lastNRounds != null) {
    const n = intOrNull(f.lastNRounds);
    if (n == null || n <= 0) throw new FilterError('lastNRounds must be a positive integer');
    spec.lastNRounds = Math.min(n, MAX_LAST_N);
  }

  spec.jackpotBasis = f.jackpotBasis != null ? String(f.jackpotBasis) : 'JACKPOT_AT_OPEN';
  if (!JACKPOT_BASIS_COLUMN[spec.jackpotBasis]) throw new FilterError('invalid jackpotBasis: ' + spec.jackpotBasis);
  spec.jackpotMin = numOrNull(f.jackpotMin);
  spec.jackpotMax = numOrNull(f.jackpotMax);
  if (spec.jackpotMin != null && spec.jackpotMax != null && spec.jackpotMin > spec.jackpotMax) throw new FilterError('jackpotMin must be <= jackpotMax');

  // AUTHORITATIVE GLOBAL JACKPOT RANGE — HALF-OPEN [min, max) on the SELECTED basis column.
  // Distinct from the legacy inclusive jackpotMin/Max: the range filter must match the report's
  // half-open bucket boundaries exactly (no double counting), and the final bucket is open-ended
  // (max = null → only the lower bound applies). NULL basis rounds are excluded (see buildWhere).
  spec.jackpotRangeMin = numOrNull(f.jackpotRangeMin);
  spec.jackpotRangeMax = numOrNull(f.jackpotRangeMax);
  if (spec.jackpotRangeMin != null && spec.jackpotRangeMax != null && spec.jackpotRangeMin > spec.jackpotRangeMax) throw new FilterError('jackpotRangeMin must be <= jackpotRangeMax');

  spec.maxOddMin = numOrNull(f.maxOddMin);
  spec.maxOddMax = numOrNull(f.maxOddMax);
  if (spec.maxOddMin != null && spec.maxOddMax != null && spec.maxOddMin > spec.maxOddMax) throw new FilterError('maxOddMin must be <= maxOddMax');

  spec.hourFrom = f.hourFrom != null ? intOrNull(f.hourFrom) : null;
  spec.hourTo = f.hourTo != null ? intOrNull(f.hourTo) : null;
  for (const h of [spec.hourFrom, spec.hourTo]) if (h != null && (h < 0 || h > 23)) throw new FilterError('hour must be 0..23');

  spec.daysOfWeek = null;
  if (Array.isArray(f.daysOfWeek) && f.daysOfWeek.length) {
    spec.daysOfWeek = f.daysOfWeek.map((d) => intOrNull(d));
    for (const d of spec.daysOfWeek) if (d == null || d < 0 || d > 6) throw new FilterError('daysOfWeek entries must be 0..6');
  }

  spec.specificDate = null;
  if (f.specificDate != null) {
    const s = String(f.specificDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new FilterError('specificDate must be YYYY-MM-DD');
    spec.specificDate = s;
  }

  if (f.completeness != null) {
    const list = Array.isArray(f.completeness) ? f.completeness.map(String) : [String(f.completeness)];
    for (const c of list) if (!COMPLETENESS_VALUES.has(c)) throw new FilterError('invalid completeness: ' + c);
    spec.completeness = list;
  } else {
    spec.completeness = ['COMPLETE']; // default
  }

  return spec;
}

function basisColumn(spec) { return JACKPOT_BASIS_COLUMN[spec.jackpotBasis]; }

// Build the SQL WHERE clause + params. `includeAnalytic` adds jackpot-range and
// maxOdd-range constraints; scope-only (false) is used to count the candidate
// population and missing-basis counts.
function buildWhere(spec, { includeAnalytic = true, alias = 'r' } = {}) {
  const a = alias;
  const where = []; const params = [];
  const openedSec = `(${a}.opened_at_ms/1000)`;

  if (spec.browserId != null) { where.push(`${a}.browser_id = ?`); params.push(spec.browserId); }
  if (spec.captureSessionId != null) { where.push(`${a}.capture_session_id = ?`); params.push(spec.captureSessionId); }
  if (spec.completeness && spec.completeness.length) { where.push(`${a}.completeness IN (${spec.completeness.map(() => '?').join(',')})`); params.push(...spec.completeness); }
  if (spec.timeFromMs != null) { where.push(`${a}.opened_at_ms >= ?`); params.push(spec.timeFromMs); }
  if (spec.timeToMs != null) { where.push(`${a}.opened_at_ms <= ?`); params.push(spec.timeToMs); }

  if (spec.hourFrom != null || spec.hourTo != null) {
    const hourExpr = `CAST(strftime('%H', ${openedSec}, 'unixepoch', 'localtime') AS INTEGER)`;
    const from = spec.hourFrom != null ? spec.hourFrom : 0;
    const to = spec.hourTo != null ? spec.hourTo : 23;
    if (from <= to) { where.push(`${hourExpr} BETWEEN ? AND ?`); params.push(from, to); }
    else { where.push(`(${hourExpr} >= ? OR ${hourExpr} <= ?)`); params.push(from, to); } // wrap-around
  }
  if (spec.daysOfWeek && spec.daysOfWeek.length) {
    where.push(`CAST(strftime('%w', ${openedSec}, 'unixepoch', 'localtime') AS INTEGER) IN (${spec.daysOfWeek.map(() => '?').join(',')})`);
    params.push(...spec.daysOfWeek);
  }
  if (spec.specificDate != null) { where.push(`date(${openedSec}, 'unixepoch', 'localtime') = ?`); params.push(spec.specificDate); }

  if (includeAnalytic) {
    if (spec.maxOddMin != null) { where.push(`${a}.max_odd >= ?`); params.push(spec.maxOddMin); }
    if (spec.maxOddMax != null) { where.push(`${a}.max_odd <= ?`); params.push(spec.maxOddMax); }
    if (spec.jackpotMin != null || spec.jackpotMax != null) {
      const col = `${a}.${basisColumn(spec)}`;
      where.push(`${col} IS NOT NULL`);
      if (spec.jackpotMin != null) { where.push(`${col} >= ?`); params.push(spec.jackpotMin); }
      if (spec.jackpotMax != null) { where.push(`${col} <= ?`); params.push(spec.jackpotMax); }
    }
    // Global Jackpot Range — HALF-OPEN [min, max) on the selected basis; NULL basis excluded so
    // a range never coerces a missing value to 0 (§2/§7). Upper bound is EXCLUSIVE; a null max is
    // the open-ended final bucket. This matches JackpotReport's inRange() bucket membership exactly.
    if (spec.jackpotRangeMin != null || spec.jackpotRangeMax != null) {
      const col = `${a}.${basisColumn(spec)}`;
      where.push(`${col} IS NOT NULL`);
      if (spec.jackpotRangeMin != null) { where.push(`${col} >= ?`); params.push(spec.jackpotRangeMin); }
      if (spec.jackpotRangeMax != null) { where.push(`${col} < ?`); params.push(spec.jackpotRangeMax); }
    }
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

module.exports = { normalizeFilter, buildWhere, basisColumn, FilterError, JACKPOT_BASIS_COLUMN, COMPLETENESS_VALUES, MAX_LAST_N };
