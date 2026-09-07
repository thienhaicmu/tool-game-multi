'use strict';

// Confidence + sample-quality helpers for observed historical rates. These describe
// how trustworthy the SAMPLE is — they are NOT predictions of future outcomes.

// 95% Wilson score interval for a binomial proportion. z = 1.959963985 (two-sided 95%).
// Returns { rate, low, high } in [0,1]. For n=0 returns all null (never NaN/Infinity).
const Z95 = 1.959963984540054;

function wilson(successes, n, z = Z95) {
  const s = Number(successes), N = Number(n);
  if (!Number.isFinite(N) || N <= 0) return { rate: null, low: null, high: null, n: 0 };
  const p = s / N;
  const z2 = z * z;
  const denom = 1 + z2 / N;
  const centre = p + z2 / (2 * N);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * N)) / N);
  return {
    rate: p,
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
    n: N,
  };
}

// Sample-quality label: UI confidence-in-sample indicator ONLY (not prediction confidence).
// Documented thresholds: <30 VERY_LOW, 30–99 LOW, 100–999 MODERATE, >=1000 GOOD.
function sampleQuality(n) {
  const N = Number(n) || 0;
  if (N < 30) return 'VERY_LOW';
  if (N < 100) return 'LOW';
  if (N < 1000) return 'MODERATE';
  return 'GOOD';
}

module.exports = { wilson, sampleQuality, Z95 };
