'use strict';

// ===========================================================================
// Aviator Analytics — centralized presentation formatter (AFmt).
//
// Display layer ONLY. It never mutates stored/query values; it turns raw numbers
// into user-readable strings. Every helper treats NULL/undefined/NaN as "no data"
// and returns the em dash "—" (NULL != 0). Grouping uses Intl for locale-safe
// thousands separators. Loaded as a classic <script> BEFORE analytics.js (sets
// window.AFmt); also exported for unit tests (vm/CommonJS).
// ===========================================================================

var AFmt = (function () {
  var DASH = '—';

  function isNum(v) { return v != null && Number.isFinite(Number(v)); }

  // Locale-grouped number with a bounded number of fraction digits (trailing
  // zeros trimmed down to `min`). Used as the base for jackpot/count.
  function grouped(v, min, max) {
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: true });
  }

  // JACKPOT — grouped, up to 2 decimals, trailing zeros trimmed.
  //   0 → "0" · 12.3 → "12.3" · 123.4567 → "123.46" · 1234.5 → "1,234.5" · 1234567.89 → "1,234,567.89"
  function jackpot(v) { return isNum(v) ? grouped(v, 0, 2) : DASH; }

  // ODD — always 2 decimals + the × sign, grouped for large multipliers.
  //   1.2 → "1.20×" · 2 → "2.00×" · 10.456 → "10.46×" · 1000 → "1,000.00×"
  function odd(v) { return isNum(v) ? grouped(v, 2, 2) + '×' : DASH; }

  // PERCENT — input is a FRACTION in [0,1]. 2 decimals. Very small non-zero shows
  // "<0.01%" instead of a misleading "0.00%". Exact 0 → "0%".
  //   0.123456 → "12.35%"
  function percent(v) {
    if (!isNum(v)) return DASH;
    var p = Number(v) * 100;
    if (p === 0) return '0%';
    if (p > 0 && p < 0.01) return '<0.01%';
    if (p < 0 && p > -0.01) return '>-0.01%';
    return p.toFixed(2) + '%';
  }

  // 95% CI from two fractions → "95% CI: 18.42–22.17%". NULL bounds → "".
  function ci(low, high) {
    if (!isNum(low) || !isNum(high)) return '';
    return '95% CI: ' + (Number(low) * 100).toFixed(2) + '–' + (Number(high) * 100).toFixed(2) + '%';
  }

  // COUNT — grouped integer. 1250 → "1,250".
  function count(v) { return isNum(v) ? grouped(Math.round(Number(v)), 0, 0) : DASH; }

  // Sample size label: "n = 1,250".
  function sampleN(v) { return 'n = ' + count(v); }

  // DURATION — readable unit. 842ms · 1.24s · 12.8s · 1m 24s.
  function duration(ms) {
    if (!isNum(ms)) return DASH;
    var m = Number(ms);
    if (m < 1000) return Math.round(m) + 'ms';
    if (m < 10000) return (m / 1000).toFixed(2) + 's';
    if (m < 60000) return (m / 1000).toFixed(1) + 's';
    var totalSec = Math.round(m / 1000);
    return Math.floor(totalSec / 60) + 'm ' + (totalSec % 60) + 's';
  }

  // Fixed-decimal plain number (streak medians etc.); grouped, NULL-safe.
  function fixed(v, d) { return isNum(v) ? grouped(v, d == null ? 2 : d, d == null ? 2 : d) : DASH; }

  // Identifier passthrough (SID / CMD) — no grouping, NULL-safe.
  function id(v) { return v == null ? DASH : String(v); }

  // Byte size for the Data panel. 12_300_000 → "12.30 MB".
  function bytes(v) { return isNum(v) ? (Number(v) / 1e6).toFixed(2) + ' MB' : DASH; }

  // P-VALUE — never the misleading "p = 0.000". 0.032 → "p = 0.032"; 0.0004 → "p < 0.001".
  function pvalue(p) {
    if (!isNum(p)) return DASH;
    const v = Number(p);
    if (v < 0.001) return 'p < 0.001';
    return 'p = ' + v.toFixed(3);
  }

  return { DASH: DASH, jackpot: jackpot, odd: odd, percent: percent, ci: ci, count: count, sampleN: sampleN, duration: duration, fixed: fixed, id: id, bytes: bytes, pvalue: pvalue };
})();

if (typeof window !== 'undefined') window.AFmt = AFmt;
if (typeof module !== 'undefined' && module.exports) module.exports = AFmt;
