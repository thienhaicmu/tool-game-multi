'use strict';

// ---------------------------------------------------------------------------
// Special functions for p-value computation — pure, deterministic, no deps.
// erf/normal CDF, regularized incomplete gamma (chi-square tail), regularized
// incomplete beta (Student-t two-sided tail). Ported from standard numerical
// recipes with finite-number guards. These back the retrospective statistical
// engine's p-values; they never predict.
// ---------------------------------------------------------------------------

// Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
function normalCdf(z) { if (!Number.isFinite(z)) return z > 0 ? 1 : 0; return 0.5 * (1 + erf(z / Math.SQRT2)); }
// Two-sided normal tail for a z statistic.
function normalTwoSided(z) { if (!Number.isFinite(z)) return null; return 2 * (1 - normalCdf(Math.abs(z))); }

function gammln(xx) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = xx, y = xx;
  let tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y++; ser += cof[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// Regularized lower incomplete gamma P(a,x) via series (x<a+1) or continued fraction.
function gammp(a, x) {
  if (!(x >= 0) || !(a > 0)) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 300; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return sum * Math.exp(-x + a * Math.log(x) - gammln(a));
  }
  // continued fraction for Q(a,x)=1-P
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - gammln(a)) * h;
  return 1 - q;
}
// Chi-square survival (upper tail) P(X > x) for k degrees of freedom.
function chiSquareSf(x, k) {
  if (!Number.isFinite(x) || !Number.isFinite(k) || k <= 0) return null;
  if (x <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - gammp(k / 2, x / 2)));
}

// Regularized incomplete beta I_x(a,b) via Lentz continued fraction (NR betacf).
function betacf(a, b, x) {
  const FPMIN = 1e-300, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
function betai(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
// Two-sided p-value for a Student-t statistic with df degrees of freedom.
function studentTTwoSided(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;
  const x = df / (df + t * t);
  return Math.max(0, Math.min(1, betai(df / 2, 0.5, x)));
}

module.exports = { erf, normalCdf, normalTwoSided, gammln, gammp, chiSquareSf, betai, studentTTwoSided };
