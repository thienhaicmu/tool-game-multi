'use strict';

const { chiSquareSf, normalTwoSided } = require('./special.cjs');
const { STATUS, finiteVals } = require('./guards.cjs');
const { averageRanks } = require('./rank-correlation.cjs');

// Kruskal–Wallis H test — do ≥2 groups' maxOdd distributions differ? Tie-corrected.
// H ~ chi-square(k-1). Groups are arrays of numbers; NULLs excluded.
function kruskalWallis(groupsRaw) {
  const groups = groupsRaw.map(finiteVals).filter((g) => g.length > 0);
  const k = groups.length;
  if (k < 2) return { H: null, df: null, pValue: null, groupCount: k, n: 0, status: STATUS.INSUFFICIENT_SAMPLE };
  const pooled = []; const sizes = [];
  for (const g of groups) { sizes.push(g.length); for (const v of g) pooled.push(v); }
  const N = pooled.length;
  if (N < 3) return { H: null, df: null, pValue: null, groupCount: k, n: N, status: STATUS.INSUFFICIENT_SAMPLE };
  const ranks = averageRanks(pooled);
  // rank sums per group (pooled order preserved)
  let offset = 0; let H = 0;
  for (let gi = 0; gi < k; gi++) {
    let rsum = 0; for (let i = 0; i < sizes[gi]; i++) rsum += ranks[offset + i];
    offset += sizes[gi];
    H += (rsum * rsum) / sizes[gi];
  }
  H = (12 / (N * (N + 1))) * H - 3 * (N + 1);
  // tie correction
  const counts = new Map(); for (const v of pooled) counts.set(v, (counts.get(v) || 0) + 1);
  let tieSum = 0; for (const c of counts.values()) tieSum += c * c * c - c;
  const correction = 1 - tieSum / (N * N * N - N);
  if (correction > 0) H = H / correction;
  const df = k - 1;
  return { H, df, pValue: chiSquareSf(H, df), groupCount: k, n: N, status: STATUS.OK };
}

// Mann–Whitney U (two independent groups) with normal approximation + tie correction.
// Effect size: rank-biserial r = 1 - 2U/(n1*n2) (documented). NULLs excluded.
function mannWhitneyU(aRaw, bRaw) {
  const a = finiteVals(aRaw), b = finiteVals(bRaw);
  const n1 = a.length, n2 = b.length;
  if (n1 < 1 || n2 < 1 || n1 + n2 < 3) return { U: null, pValue: null, n1, n2, rankBiserial: null, status: STATUS.INSUFFICIENT_SAMPLE };
  const pooled = a.concat(b);
  const ranks = averageRanks(pooled);
  let R1 = 0; for (let i = 0; i < n1; i++) R1 += ranks[i];
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);
  const mu = (n1 * n2) / 2;
  const N = n1 + n2;
  const counts = new Map(); for (const v of pooled) counts.set(v, (counts.get(v) || 0) + 1);
  let tie = 0; for (const c of counts.values()) tie += c * c * c - c;
  const sigma2 = (n1 * n2 / 12) * ((N + 1) - tie / (N * (N - 1)));
  const pValue = sigma2 > 0 ? normalTwoSided((U - mu) / Math.sqrt(sigma2)) : null;
  const rankBiserial = 1 - (2 * U1) / (n1 * n2); // signed effect (group a vs b)
  return { U, U1, U2, pValue, n1, n2, rankBiserial, status: STATUS.OK };
}

module.exports = { kruskalWallis, mannWhitneyU };
