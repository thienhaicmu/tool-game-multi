'use strict';

// Language-NEUTRAL effect-size interpretation (the renderer maps enums → Vietnamese).
// These are conventional descriptive bands, NOT causal or predictive claims.

// Correlation magnitude bands (|r|). Conservative Cohen-style thresholds.
function interpretCorrelation(r) {
  if (r == null || !Number.isFinite(r)) return 'NONE';
  const a = Math.abs(r);
  if (a < 0.10) return 'NEGLIGIBLE';
  if (a < 0.30) return 'WEAK';
  if (a < 0.50) return 'MODERATE';
  return 'STRONG';
}

// Cramér's V bands adjusted for table size (min dimension df* = min(r,c)-1).
// Cohen's guideline scales the small/medium/large cut by 1/sqrt(df*).
function interpretCramersV(v, minDim) {
  if (v == null || !Number.isFinite(v)) return 'NONE';
  const df = Math.max(1, (minDim || 2) - 1);
  const small = 0.10 / Math.sqrt(df), medium = 0.30 / Math.sqrt(df), large = 0.50 / Math.sqrt(df);
  if (v < small) return 'NEGLIGIBLE';
  if (v < medium) return 'WEAK';
  if (v < large) return 'MODERATE';
  return 'STRONG';
}

// Rank-biserial / eta-style magnitude (absolute).
function interpretRankEffect(r) {
  if (r == null || !Number.isFinite(r)) return 'NONE';
  const a = Math.abs(r);
  if (a < 0.10) return 'NEGLIGIBLE';
  if (a < 0.30) return 'WEAK';
  if (a < 0.50) return 'MODERATE';
  return 'STRONG';
}

module.exports = { interpretCorrelation, interpretCramersV, interpretRankEffect };
