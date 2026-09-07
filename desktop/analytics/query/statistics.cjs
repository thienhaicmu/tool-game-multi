'use strict';

// Pure, deterministic descriptive statistics over arrays of numbers. No DB, no
// prediction, no randomness. Used by the analytics query engine so every screen
// computes percentiles/streaks/gaps the SAME way.

// Quantile via linear interpolation between closest ranks (R-7 / numpy 'linear').
// p in [0,1]. Input need NOT be pre-sorted. n=0 -> null.
function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx), frac = idx - lo;
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}
function quantile(arr, p) { return quantileSorted([...arr].sort((a, b) => a - b), p); }

function mean(arr) { if (!arr.length) return null; return arr.reduce((a, b) => a + b, 0) / arr.length; }
function median(arr) { return quantile(arr, 0.5); }

// Full descriptive summary (one sort). Returns nulls for empty input.
function describe(arr) {
  const a = [...arr].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return { count: 0, min: null, max: null, mean: null, median: null, p10: null, p25: null, p50: null, p75: null, p90: null, p95: null, p99: null };
  return {
    count: n, min: a[0], max: a[n - 1], mean: mean(a), median: quantileSorted(a, 0.5),
    p10: quantileSorted(a, 0.10), p25: quantileSorted(a, 0.25), p50: quantileSorted(a, 0.50),
    p75: quantileSorted(a, 0.75), p90: quantileSorted(a, 0.90), p95: quantileSorted(a, 0.95), p99: quantileSorted(a, 0.99),
  };
}

// Threshold reach counts from an array of maxOdd values (nulls excluded).
// reached iff maxOdd >= T. Returns per-threshold { threshold, reachedCount, notReachedCount, sampleCount }.
function thresholdCounts(maxOdds, thresholds) {
  const vals = maxOdds.filter((x) => Number.isFinite(x));
  const n = vals.length;
  return thresholds.map((t) => {
    let reached = 0;
    for (const v of vals) if (v >= t) reached++;
    return { threshold: t, reachedCount: reached, notReachedCount: n - reached, sampleCount: n };
  });
}

// Mutually-exclusive distribution buckets. Each bucket = { label, min, max } with
// [min, max) half-open semantics; max=null means open-ended (>=min). Nulls excluded.
function distribution(maxOdds, buckets) {
  const vals = maxOdds.filter((x) => Number.isFinite(x));
  const n = vals.length;
  const counts = buckets.map(() => 0);
  for (const v of vals) {
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const ge = v >= b.min;
      const lt = b.max == null ? true : v < b.max;
      if (ge && lt) { counts[i]++; break; }
    }
  }
  return {
    total: n,
    buckets: buckets.map((b, i) => ({ label: b.label, min: b.min, max: b.max, count: counts[i], observedRate: n ? counts[i] / n : null })),
  };
}

// Streak analytics for condition (value < T). Operates on an ordered value array.
// currentStreak = trailing run of (<T); completed streaks exclude the current run.
function streaks(values, t) {
  const runs = []; let cur = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v < t) cur++;
    else { if (cur > 0) runs.push(cur); cur = 0; }
  }
  const currentStreak = cur; // trailing (unfinished) run
  const completed = runs;    // every pushed run was terminated by a >= T round
  const longest = Math.max(0, currentStreak, ...completed);
  return {
    threshold: t,
    currentStreak,
    longestStreak: longest,
    completedStreakCount: completed.length,
    averageCompletedStreak: completed.length ? mean(completed) : null,
    medianCompletedStreak: completed.length ? median(completed) : null,
    distribution: streakDistribution(completed),
  };
}
function streakDistribution(lengths) {
  const d = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6-10': 0, '11+': 0 };
  for (const L of lengths) {
    if (L <= 0) continue;
    if (L >= 11) d['11+']++; else if (L >= 6) d['6-10']++; else d[String(L)]++;
  }
  return d;
}

// Gap analytics for qualifying condition (value >= T). Operates on an ordered array.
// gap between occurrences at positions p_i,p_{i+1} = p_{i+1}-p_i-1 (rounds strictly between).
// currentGap = eligible non-qualifying rounds AFTER the most recent qualifying round.
function gaps(values, t) {
  const positions = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]) && values[i] >= t) positions.push(i);
  const n = values.length;
  if (positions.length === 0) {
    return { threshold: t, occurrences: 0, hasPriorOccurrence: false, currentGapRounds: n, completedGapCount: 0,
      averageGapRounds: null, medianGapRounds: null, minGapRounds: null, maxGapRounds: null, p75: null, p90: null, p95: null };
  }
  const completed = [];
  for (let i = 1; i < positions.length; i++) completed.push(positions[i] - positions[i - 1] - 1);
  const last = positions[positions.length - 1];
  const currentGapRounds = (n - 1) - last; // non-qualifying rounds after most recent occurrence
  const sorted = [...completed].sort((a, b) => a - b);
  return {
    threshold: t,
    occurrences: positions.length,
    hasPriorOccurrence: true,
    currentGapRounds,
    completedGapCount: completed.length,
    averageGapRounds: completed.length ? mean(completed) : null,
    medianGapRounds: completed.length ? quantileSorted(sorted, 0.5) : null,
    minGapRounds: completed.length ? sorted[0] : null,
    maxGapRounds: completed.length ? sorted[sorted.length - 1] : null,
    p75: completed.length ? quantileSorted(sorted, 0.75) : null,
    p90: completed.length ? quantileSorted(sorted, 0.90) : null,
    p95: completed.length ? quantileSorted(sorted, 0.95) : null,
  };
}

// Rolling observed rate of (value >= T) over full windows of size `window`.
// Full-window only (policy B): first point ends at index window-1. Deterministic order.
function rolling(values, t, window) {
  const w = Math.max(1, Math.trunc(window));
  const out = [];
  if (values.length < w) return out;
  // prefix sum of reached flags
  let reached = 0;
  const flags = values.map((v) => (Number.isFinite(v) && v >= t) ? 1 : 0);
  for (let i = 0; i < w; i++) reached += flags[i];
  out.push({ index: w - 1, windowSize: w, reachedCount: reached, observedRate: reached / w });
  for (let i = w; i < flags.length; i++) {
    reached += flags[i] - flags[i - w];
    out.push({ index: i, windowSize: w, reachedCount: reached, observedRate: reached / w });
  }
  return out;
}

// Last-N snapshot: observed rate of (>=T) over the trailing N values (as available).
function lastNRate(values, t, n) {
  const slice = values.slice(-n).filter((v) => Number.isFinite(v));
  const avail = slice.length;
  let reached = 0; for (const v of slice) if (v >= t) reached++;
  return { requested: n, available: avail, reachedCount: reached, observedRate: avail ? reached / avail : null };
}

module.exports = { quantile, quantileSorted, mean, median, describe, thresholdCounts, distribution, streaks, streakDistribution, gaps, rolling, lastNRate };
