'use strict';

// ---------------------------------------------------------------------------
// Seller-generator duration math (PURE — no crypto, no network, no license core).
//
// The signed `expiresAt` stays epoch seconds exactly as the existing schema v2
// requires. This module only decides WHICH second, from a duration spec, using
// the SAME UTC+7 (Vietnam) wall-clock semantics the generator already used for
// custom `YYYY-MM-DD` expiry (midnight +07:00).
//
// Duration spec (from the GUI):
//   { unit: 'days',   value: 7 }
//   { unit: 'months', value: 1 | 3 | 6 | 12 }   -> CALENDAR months, end-of-month safe
//   { unit: 'custom', expires: 'YYYY-MM-DD' }    -> midnight +07:00 of that date
// ---------------------------------------------------------------------------

const UTC_PLUS_7_OFFSET_SECONDS = 7 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

// Custom expiry: a calendar date interpreted at 00:00:00 in UTC+7 (unchanged from
// the generator's original `utcDateSeconds`).
function customExpiresSeconds(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) throw new Error('Ngày hết hạn phải theo dạng YYYY-MM-DD.');
  const ms = Date.parse(`${dateText}T00:00:00.000+07:00`);
  if (!Number.isFinite(ms)) throw new Error('Ngày hết hạn không hợp lệ.');
  return Math.floor(ms / 1000);
}

// Add N calendar months to an epoch-seconds instant, evaluated in UTC+7 wall clock,
// keeping the same time-of-day. Day-of-month is clamped to the target month's last
// day so 2026-01-31 + 1 month -> 2026-02-28 (deterministic, never an invalid date).
function addCalendarMonthsSeconds(issuedAtSeconds, months) {
  const m = Number(months);
  if (!Number.isInteger(m)) throw new Error('Số tháng phải là số nguyên.');
  // Shift into UTC+7 wall clock so getUTC* reads Vietnam-local components.
  const wall = new Date((Number(issuedAtSeconds) + UTC_PLUS_7_OFFSET_SECONDS) * 1000);
  const y = wall.getUTCFullYear();
  const mon = wall.getUTCMonth();
  const day = wall.getUTCDate();
  const hh = wall.getUTCHours();
  const mm = wall.getUTCMinutes();
  const ss = wall.getUTCSeconds();
  const targetIndex = mon + m;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  const wallMs = Date.UTC(targetYear, targetMonth, targetDay, hh, mm, ss);
  return Math.floor(wallMs / 1000) - UTC_PLUS_7_OFFSET_SECONDS;
}

// Resolve a duration spec against a trusted `issuedAt` (epoch seconds).
function resolveExpiresAt(issuedAtSeconds, spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Thiếu thông tin thời hạn.');
  if (spec.unit === 'days') {
    const d = Number(spec.value);
    if (!Number.isInteger(d) || d < 1) throw new Error('Số ngày không hợp lệ.');
    return Number(issuedAtSeconds) + d * DAY_SECONDS;
  }
  if (spec.unit === 'months') return addCalendarMonthsSeconds(issuedAtSeconds, spec.value);
  if (spec.unit === 'custom') return customExpiresSeconds(spec.expires);
  throw new Error('Đơn vị thời hạn không hợp lệ.');
}

// Human dd/mm/yyyy in UTC+7 for previews and result display.
function formatUtcPlus7(seconds) {
  if (!Number.isFinite(Number(seconds))) return '';
  const d = new Date((Number(seconds) + UTC_PLUS_7_OFFSET_SECONDS) * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

module.exports = {
  UTC_PLUS_7_OFFSET_SECONDS,
  DAY_SECONDS,
  customExpiresSeconds,
  addCalendarMonthsSeconds,
  resolveExpiresAt,
  formatUtcPlus7,
};
