'use strict';

const { studentTTwoSided, normalTwoSided } = require('./special.cjs');
const { STATUS, MIN_CORR_N, finitePairs, isConstant } = require('./guards.cjs');

// Average (fractional) ranks — ties share the mean of the ranks they would occupy.
function averageRanks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1; // 1-based average rank for the tie block
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

function pearson(x, y) {
  const n = x.length; let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Spearman rank correlation (tie-aware via average ranks). Two-sided p from the
// Student-t approximation t = rho*sqrt((n-2)/(1-rho^2)), df=n-2 (documented).
function spearman(xs, ys) {
  const { x, y, n } = finitePairs(xs, ys);
  if (n < MIN_CORR_N) return { rho: null, pValue: null, n, status: STATUS.INSUFFICIENT_SAMPLE };
  if (isConstant(x) || isConstant(y)) return { rho: null, pValue: null, n, status: STATUS.CONSTANT_INPUT };
  const rho = pearson(averageRanks(x), averageRanks(y));
  if (rho == null || !Number.isFinite(rho)) return { rho: null, pValue: null, n, status: STATUS.NUMERIC_FAILURE };
  const r = Math.max(-1, Math.min(1, rho));
  let pValue = null;
  if (Math.abs(r) < 1 && n > 2) { const t = r * Math.sqrt((n - 2) / (1 - r * r)); pValue = studentTTwoSided(t, n - 2); }
  else if (Math.abs(r) >= 1) pValue = 0;
  return { rho: r, pValue, n, status: STATUS.OK };
}

// Count strict inversions (i<j with a[i] > a[j]) via merge sort — O(n log n).
function countInversions(a) {
  const arr = a.slice();
  const tmp = new Array(arr.length);
  let inv = 0;
  const sort = (lo, hi) => {
    if (hi - lo <= 1) return;
    const mid = (lo + hi) >> 1;
    sort(lo, mid); sort(mid, hi);
    let i = lo, j = mid, k = lo;
    while (i < mid && j < hi) {
      if (arr[i] <= arr[j]) tmp[k++] = arr[i++];
      else { inv += mid - i; tmp[k++] = arr[j++]; }   // arr[i..mid) all > arr[j]
    }
    while (i < mid) tmp[k++] = arr[i++];
    while (j < hi) tmp[k++] = arr[j++];
    for (let t = lo; t < hi; t++) arr[t] = tmp[t];
  };
  sort(0, arr.length);
  return inv;
}
function tiePairs(sortedVals) { let s = 0, run = 1; for (let i = 1; i <= sortedVals.length; i++) { if (i < sortedVals.length && sortedVals[i] === sortedVals[i - 1]) run++; else { s += run * (run - 1) / 2; run = 1; } } return s; }

// Kendall tau-b (tie-corrected) via Knight's O(n log n) algorithm — scales to the
// 100k populations the engine benchmarks. Two-sided p from the normal approximation.
function kendallTauB(xs, ys) {
  const { x, y, n } = finitePairs(xs, ys);
  if (n < MIN_CORR_N) return { tau: null, pValue: null, n, status: STATUS.INSUFFICIENT_SAMPLE };
  if (isConstant(x) || isConstant(y)) return { tau: null, pValue: null, n, status: STATUS.CONSTANT_INPUT };
  // Sort pairs by x asc, ties broken by y asc.
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (x[a] - x[b]) || (y[a] - y[b]));
  const xs2 = idx.map((i) => x[i]), ys2 = idx.map((i) => y[i]);
  const n0 = n * (n - 1) / 2;
  const n1 = tiePairs(xs2);                                   // pairs tied in x
  const n2 = tiePairs([...y].sort((a, b) => a - b));          // pairs tied in y
  // pairs tied in BOTH x and y (consecutive equal (x,y) after the sort)
  let n3 = 0, run = 1;
  for (let i = 1; i <= n; i++) { if (i < n && xs2[i] === xs2[i - 1] && ys2[i] === ys2[i - 1]) run++; else { n3 += run * (run - 1) / 2; run = 1; } }
  const swaps = countInversions(ys2);                          // = discordant pairs (D)
  const cPlusD = n0 - n1 - n2 + n3;                            // concordant + discordant
  const numerator = cPlusD - 2 * swaps;                        // P - Q
  const denom = Math.sqrt((n0 - n1) * (n0 - n2));
  if (denom <= 0) return { tau: null, pValue: null, n, status: STATUS.CONSTANT_INPUT };
  const tau = numerator / denom;
  const varS = n * (n - 1) * (2 * n + 5) / 18;                 // no-tie variance baseline
  const z = varS > 0 ? numerator / Math.sqrt(varS) : null;
  return { tau: Math.max(-1, Math.min(1, tau)), pValue: z != null ? normalTwoSided(z) : null, n, status: STATUS.OK };
}

module.exports = { spearman, kendallTauB, averageRanks, pearson };
