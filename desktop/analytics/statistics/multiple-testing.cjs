'use strict';

// Benjamini–Hochberg FDR correction. Input: array of { key, p } (or numbers).
// Returns per-item { key, rawP, adjustedP, significantRaw, significantAdjusted },
// preserving input order. Adjusted p-values are the monotone (step-up) BH values,
// clamped to [0,1]. Null/NaN p-values pass through as null (excluded from ranking).
function benjaminiHochberg(items, alpha = 0.05) {
  const norm = items.map((it, i) => (typeof it === 'number' ? { key: i, p: it } : { key: it.key, p: it.p }));
  const valid = norm.map((it, i) => ({ i, p: it.p })).filter((x) => Number.isFinite(x.p));
  const m = valid.length;
  const adj = new Array(norm.length).fill(null);
  if (m > 0) {
    valid.sort((a, b) => a.p - b.p);
    // step-up: adj_(k) = min over j>=k of ( m/j * p_(j) ), clamped to 1
    let running = Infinity;
    for (let k = m - 1; k >= 0; k--) {
      const val = (valid[k].p * m) / (k + 1);
      running = Math.min(running, val);
      adj[valid[k].i] = Math.max(0, Math.min(1, running));
    }
  }
  return norm.map((it, i) => ({
    key: it.key,
    rawP: Number.isFinite(it.p) ? it.p : null,
    adjustedP: adj[i],
    significantRaw: Number.isFinite(it.p) ? it.p < alpha : false,
    significantAdjusted: adj[i] != null ? adj[i] < alpha : false,
  }));
}

module.exports = { benjaminiHochberg };
