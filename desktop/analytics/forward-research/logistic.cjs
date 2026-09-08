'use strict';

// Pure, deterministic logistic regression via IRLS (Newton–Raphson) with L2 ridge on
// the slopes (never the intercept). Small p (≤ ~10 features), so a dense normal-equation
// solve per iteration is cheap and exact. No dependency, no randomness.

// Scaler fitted on TRAIN ONLY (mean/std); constant features collapse to 0 after centering.
function fitScaler(matrix, p) {
  const mean = new Array(p).fill(0), std = new Array(p).fill(0), cnt = new Array(p).fill(0);
  for (const row of matrix) for (let j = 0; j < p; j++) { const v = row[j]; if (v != null && Number.isFinite(v)) { mean[j] += v; cnt[j]++; } }
  for (let j = 0; j < p; j++) mean[j] = cnt[j] ? mean[j] / cnt[j] : 0;
  for (const row of matrix) for (let j = 0; j < p; j++) { const v = row[j]; if (v != null && Number.isFinite(v)) std[j] += (v - mean[j]) ** 2; }
  for (let j = 0; j < p; j++) std[j] = cnt[j] > 1 ? Math.sqrt(std[j] / (cnt[j] - 1)) : 0;
  return { mean, std };
}
function applyScaler(matrix, scaler) {
  const { mean, std } = scaler;
  return matrix.map((row) => row.map((v, j) => { if (v == null || !Number.isFinite(v)) return 0; return std[j] > 0 ? (v - mean[j]) / std[j] : 0; }));
}

// Solve A·b = c via Gauss-Jordan with partial pivoting. Returns b, or null if singular.
function solve(A, c) {
  const n = c.length; const M = A.map((r, i) => r.concat([c[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col; for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null; // singular
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    for (let k = col; k <= n; k++) M[col][k] /= pv;               // normalize pivot row
    for (let r = 0; r < n; r++) if (r !== col) { const f = M[r][col]; for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k]; }
  }
  return M.map((r) => r[n]);
}

// X: standardized rows (arrays length p). y: 0/1. Returns intercept + slopes + convergence.
function fit(X, y, { l2 = 1.0, maxIter = 100, tol = 1e-8 } = {}) {
  const n = X.length; const p = n ? X[0].length : 0;
  const d = p + 1;                                   // + intercept
  let beta = new Array(d).fill(0);
  const design = X.map((row) => [1, ...row]);
  let converged = false, iter = 0;
  for (; iter < maxIter; iter++) {
    const A = Array.from({ length: d }, () => new Array(d).fill(0));
    const g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = design[i]; let z = 0; for (let j = 0; j < d; j++) z += beta[j] * xi[j];
      const pi = 1 / (1 + Math.exp(-z)); const w = Math.max(pi * (1 - pi), 1e-9);
      for (let a = 0; a < d; a++) { g[a] += (y[i] - pi) * xi[a]; for (let b = 0; b < d; b++) A[a][b] += w * xi[a] * xi[b]; }
    }
    for (let a = 1; a < d; a++) { A[a][a] += l2; g[a] -= l2 * beta[a]; } // ridge on slopes only
    const step = solve(A, g);
    if (!step) return { intercept: beta[0], coef: beta.slice(1), converged: false, iterations: iter, status: 'SINGULAR' };
    let maxDelta = 0; for (let j = 0; j < d; j++) { beta[j] += step[j]; maxDelta = Math.max(maxDelta, Math.abs(step[j])); }
    if (maxDelta < tol) { converged = true; iter++; break; }
  }
  return { intercept: beta[0], coef: beta.slice(1), converged, iterations: iter, status: converged ? 'OK' : 'MAX_ITER' };
}

function predictOne(model, xStd) { let z = model.intercept; for (let j = 0; j < model.coef.length; j++) z += model.coef[j] * xStd[j]; return 1 / (1 + Math.exp(-z)); }
function predict(model, Xstd) { return Xstd.map((row) => predictOne(model, row)); }

module.exports = { fitScaler, applyScaler, fit, predict, predictOne };
