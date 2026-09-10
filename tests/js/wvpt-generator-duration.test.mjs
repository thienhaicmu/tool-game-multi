import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  customExpiresSeconds, addCalendarMonthsSeconds, resolveExpiresAt, formatUtcPlus7, DAY_SECONDS,
} = require('../../tools/license-generator/duration.cjs');

// All calendar semantics are evaluated in UTC+7 (matches the generator's custom-date rule).
const at = (ymd) => customExpiresSeconds(ymd); // midnight +07:00 of that date

test('days duration adds exact seconds', () => {
  const issued = at('2026-09-10');
  assert.equal(resolveExpiresAt(issued, { unit: 'days', value: 7 }), issued + 7 * DAY_SECONDS);
});

test('1 calendar month keeps the day-of-month', () => {
  assert.equal(addCalendarMonthsSeconds(at('2026-09-10'), 1), at('2026-10-10'));
  assert.equal(formatUtcPlus7(addCalendarMonthsSeconds(at('2026-09-10'), 1)), '10/10/2026');
});

test('month-end is clamped deterministically (Jan 31 + 1 month -> Feb 28 non-leap)', () => {
  assert.equal(addCalendarMonthsSeconds(at('2026-01-31'), 1), at('2026-02-28'));
  assert.equal(formatUtcPlus7(addCalendarMonthsSeconds(at('2026-01-31'), 1)), '28/02/2026');
});

test('leap year: Jan 31 2028 + 1 month -> Feb 29 2028', () => {
  assert.equal(addCalendarMonthsSeconds(at('2028-01-31'), 1), at('2028-02-29'));
  assert.equal(formatUtcPlus7(addCalendarMonthsSeconds(at('2028-01-31'), 1)), '29/02/2028');
});

test('3 / 6 / 12 month spans', () => {
  assert.equal(formatUtcPlus7(resolveExpiresAt(at('2026-09-10'), { unit: 'months', value: 3 })), '10/12/2026');
  assert.equal(formatUtcPlus7(resolveExpiresAt(at('2026-09-10'), { unit: 'months', value: 6 })), '10/03/2027');
  assert.equal(formatUtcPlus7(resolveExpiresAt(at('2026-09-10'), { unit: 'months', value: 12 })), '10/09/2027');
});

test('month math crosses year boundaries', () => {
  assert.equal(formatUtcPlus7(addCalendarMonthsSeconds(at('2026-12-15'), 1)), '15/01/2027');
});

test('calendar-month preserves time-of-day (not midnight-only)', () => {
  // 2026-09-10 15:30:00 UTC+7
  const issued = at('2026-09-10') + 15 * 3600 + 30 * 60;
  const plus1 = addCalendarMonthsSeconds(issued, 1);
  assert.equal(plus1, at('2026-10-10') + 15 * 3600 + 30 * 60);
});

test('custom expiry resolves to midnight UTC+7 of the given date', () => {
  assert.equal(resolveExpiresAt(0, { unit: 'custom', expires: '2026-03-01' }), at('2026-03-01'));
  assert.equal(formatUtcPlus7(at('2026-03-01')), '01/03/2026');
});

test('invalid duration specs throw', () => {
  assert.throws(() => resolveExpiresAt(0, null));
  assert.throws(() => resolveExpiresAt(0, { unit: 'weeks', value: 1 }));
  assert.throws(() => resolveExpiresAt(0, { unit: 'custom', expires: '10/09/2026' }));
});
