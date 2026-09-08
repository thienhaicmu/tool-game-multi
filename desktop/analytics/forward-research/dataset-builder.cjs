'use strict';

const { byName, isForwardEligible, STAGE_ORDER } = require('./feature-registry.cjs');

// ---------------------------------------------------------------------------
// Dataset builder — turns ordered completed rounds into leakage-safe forward rows.
//
//   - features for round i use ONLY the current round's early state (jp_open / jp_lock,
//     stage-gated) and STRICTLY-PRIOR completed rounds (shift(1) / rolling), never the
//     current outcome or any current-round post-outcome aggregate.
//   - prior/rolling context is computed PER browser stream (no B1→B2 crossover, §9/§39).
//   - the current round is appended to the rolling history AFTER its features are built,
//     so a round can never enter its own predictors (shift(1), §38).
//   - missing values stay null (never coerced to 0 — the S06 lesson).
// ---------------------------------------------------------------------------

function fin(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function localHour(ms) { const n = fin(ms); return n == null ? null : new Date(n).getHours(); }

// Build one round's feature object for the requested, stage-eligible feature names.
function buildFeatures(featureNames, modelStage, round, hist) {
  const prev = hist.length ? hist[hist.length - 1] : null;
  const out = {};
  for (const name of featureNames) {
    if (!isForwardEligible(name, modelStage)) continue;               // hard stage gate
    const f = byName.get(name);
    switch (name) {
      case 'jp_open': out[name] = fin(round.jackpot_at_open); break;
      case 'jp_lock': out[name] = fin(round.jackpot_at_lock); break;
      case 'prev_max_odd': out[name] = prev ? fin(prev.max_odd) : null; break;
      case 'prev_reached_2x': out[name] = prev ? (fin(prev.max_odd) == null ? null : (prev.max_odd >= 2 ? 1 : 0)) : null; break;
      case 'prev_jp_open': out[name] = prev ? fin(prev.jackpot_at_open) : null; break;
      case 'prev_jp_delta': out[name] = prev ? fin(prev.jackpot_delta) : null; break;
      case 'roll_mean_maxodd_5': out[name] = rollAgg(hist, 5, (r) => fin(r.max_odd), 'mean'); break;
      case 'roll_rate2_10': out[name] = rollAgg(hist, 10, (r) => (fin(r.max_odd) == null ? null : (r.max_odd >= 2 ? 1 : 0)), 'mean'); break;
      case 'roll_jp_mean_10': out[name] = rollAgg(hist, 10, (r) => fin(r.jackpot_at_open), 'mean'); break;
      case 'low_odd_streak': out[name] = lowOddStreak(hist); break;
      case 'hour_sin': { const h = localHour(round.opened_at_ms); out[name] = h == null ? null : Math.sin(2 * Math.PI * h / 24); break; }
      case 'hour_cos': { const h = localHour(round.opened_at_ms); out[name] = h == null ? null : Math.cos(2 * Math.PI * h / 24); break; }
      default: out[name] = null; void f; break;
    }
  }
  return out;
}

// Rolling aggregate over up to `window` STRICTLY-PRIOR rounds (hist excludes current). null if none.
function rollAgg(hist, window, pick, agg) {
  const start = Math.max(0, hist.length - window);
  const vals = [];
  for (let i = start; i < hist.length; i++) { const v = pick(hist[i]); if (v != null) vals.push(v); }
  if (!vals.length) return null;
  if (agg === 'mean') return vals.reduce((a, b) => a + b, 0) / vals.length;
  return null;
}
function lowOddStreak(hist) {
  let s = 0;
  for (let i = hist.length - 1; i >= 0; i--) { const v = fin(hist[i].max_odd); if (v == null) break; if (v < 2) s++; else break; }
  return s;
}

// rounds: flat rows (snake_case) with browser_id, sid, sequence_number, opened_at_ms, max_odd,
// jackpot_at_open, jackpot_at_lock, jackpot_delta. Returns { rows, meta }.
function buildDataset({ rounds, modelStage, featureNames, target }) {
  if (!target || !Number.isFinite(Number(target.threshold))) throw new Error('target.threshold required');
  const T = Number(target.threshold);
  // Partition by browser, order each stream by sequence_number (deterministic; no SQL-order ambiguity).
  const byBrowser = new Map();
  for (const r of rounds) { const b = String(r.browser_id); if (!byBrowser.has(b)) byBrowser.set(b, []); byBrowser.get(b).push(r); }
  const rows = []; let missingOutcome = 0;
  for (const [browserId, list] of byBrowser) {
    list.sort((a, b) => (a.sequence_number - b.sequence_number) || (fin(a.opened_at_ms) - fin(b.opened_at_ms)));
    const hist = [];
    for (const round of list) {
      const mo = fin(round.max_odd);
      if (mo == null) { missingOutcome++; continue; }                 // missing outcome → excluded, counted
      const features = buildFeatures(featureNames, modelStage, round, hist);
      rows.push({ browserId, sid: round.sid != null ? String(round.sid) : null, eventTime: fin(round.opened_at_ms), features, target: mo >= T ? 1 : 0 });
      hist.push(round);                                               // append AFTER feature build (shift 1)
    }
  }
  // Global chronological order for splitting (stable tie-break so ordering is deterministic).
  rows.sort((a, b) => (a.eventTime - b.eventTime) || (a.browserId < b.browserId ? -1 : a.browserId > b.browserId ? 1 : 0));
  // Per-feature missingness.
  const missing = {};
  for (const name of featureNames) { if (!isForwardEligible(name, modelStage)) continue; let m = 0; for (const r of rows) if (r.features[name] == null) m++; missing[name] = { missing: m, n: rows.length, missingRate: rows.length ? m / rows.length : null }; }
  return { rows, meta: { n: rows.length, browsers: byBrowser.size, missingOutcome, modelStage, target: target.name, threshold: T, featureNames: featureNames.filter((f) => isForwardEligible(f, modelStage)), missing } };
}

module.exports = { buildDataset, buildFeatures, STAGE_ORDER };
