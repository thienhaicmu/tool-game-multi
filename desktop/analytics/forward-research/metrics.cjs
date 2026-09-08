'use strict';

// Pure evaluation metrics for binary forward targets. Probabilities clipped to (eps,1-eps).
const EPS = 1e-12;
const clip = (p) => Math.min(1 - EPS, Math.max(EPS, p));

function baseRate(y) { if (!y.length) return null; let s = 0; for (const v of y) s += v; return s / y.length; }

// ROC AUC via the rank identity (average-rank tie handling). null if only one class.
function rocAuc(scores, y) {
  const n = scores.length; let pos = 0; for (const v of y) pos += v; const neg = n - pos;
  if (pos === 0 || neg === 0) return null;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(n); let i = 0;
  while (i < n) { let j = i; while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[idx[k]] = r; i = j + 1; }
  let sumPos = 0; for (let k = 0; k < n; k++) if (y[k] === 1) sumPos += ranks[k];
  return (sumPos - pos * (pos + 1) / 2) / (pos * neg);
}

// Average precision (PR-AUC). Descending score order; step at each positive.
function prAuc(scores, y) {
  const n = scores.length; let P = 0; for (const v of y) P += v; if (P === 0) return null;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a]);
  let tp = 0, fp = 0, ap = 0, prevRecall = 0;
  for (const k of idx) { if (y[k] === 1) tp++; else fp++; const precision = tp / (tp + fp); const recall = tp / P; ap += precision * (recall - prevRecall); prevRecall = recall; }
  return ap;
}

function brier(p, y) { if (!p.length) return null; let s = 0; for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) ** 2; return s / p.length; }
function logLoss(p, y) { if (!p.length) return null; let s = 0; for (let i = 0; i < p.length; i++) { const q = clip(p[i]); s += -(y[i] * Math.log(q) + (1 - y[i]) * Math.log(1 - q)); } return s / p.length; }

// Calibration bins (equal-width in [0,1]). Each bin: meanPredicted, observedRate, n.
function calibration(p, y, nbins = 10) {
  const bins = Array.from({ length: nbins }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (let i = 0; i < p.length; i++) { let b = Math.floor(p[i] * nbins); if (b >= nbins) b = nbins - 1; if (b < 0) b = 0; bins[b].sumP += p[i]; bins[b].sumY += y[i]; bins[b].n++; }
  return bins.map((b, i) => ({ bin: i, lo: i / nbins, hi: (i + 1) / nbins, n: b.n, meanPredicted: b.n ? b.sumP / b.n : null, observedRate: b.n ? b.sumY / b.n : null, diff: b.n ? (b.sumP - b.sumY) / b.n : null }));
}

function evaluate(p, y) {
  return { n: y.length, positives: y.reduce((a, b) => a + b, 0), prevalence: baseRate(y), auc: rocAuc(p, y), prAuc: prAuc(p, y), brier: brier(p, y), logLoss: logLoss(p, y) };
}

// Deterministic PRNG (mulberry32) for the moving-block bootstrap (time-series aware).
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Moving-block bootstrap CI for AUC — respects temporal dependence (naive IID bootstrap
// would understate uncertainty in a time series). Block length ≈ n^(1/3). Deterministic seed.
function bootstrapAucCI(scores, y, { iters = 500, seed = 12345 } = {}) {
  const n = scores.length; const pos = y.reduce((a, b) => a + b, 0);
  if (pos < 5 || n - pos < 5 || n < 30) return { method: 'MOVING_BLOCK_BOOTSTRAP', status: 'INSUFFICIENT_SAMPLE', low: null, high: null };
  const block = Math.max(2, Math.round(Math.cbrt(n)));
  const rnd = mulberry32(seed); const aucs = [];
  for (let b = 0; b < iters; b++) {
    const s = [], yy = [];
    while (s.length < n) { const start = Math.floor(rnd() * n); for (let k = 0; k < block && s.length < n; k++) { const j = (start + k) % n; s.push(scores[j]); yy.push(y[j]); } }
    const a = rocAuc(s, yy); if (a != null) aucs.push(a);
  }
  if (aucs.length < iters * 0.5) return { method: 'MOVING_BLOCK_BOOTSTRAP', status: 'DEGENERATE', low: null, high: null };
  aucs.sort((a, b) => a - b);
  const q = (p) => aucs[Math.min(aucs.length - 1, Math.max(0, Math.floor(p * (aucs.length - 1))))];
  return { method: 'MOVING_BLOCK_BOOTSTRAP', status: 'OK', blockLength: block, iters: aucs.length, low: q(0.025), high: q(0.975) };
}

module.exports = { baseRate, rocAuc, prAuc, brier, logLoss, calibration, evaluate, bootstrapAucCI };
