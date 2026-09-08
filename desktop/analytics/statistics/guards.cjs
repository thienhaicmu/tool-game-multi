'use strict';

const { sampleQuality } = require('../query/confidence.cjs');

// Shared status vocabulary + sample guards for the retrospective statistical engine.
// Every test returns an explicit status rather than a fabricated 0 when it cannot run.
const STATUS = Object.freeze({
  OK: 'OK',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
  CONSTANT_INPUT: 'CONSTANT_INPUT',
  NUMERIC_FAILURE: 'NUMERIC_FAILURE',
  ASSUMPTION_FAILED: 'ASSUMPTION_FAILED',
  NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE: 'NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE',
});

// Minimum pair count before a rank correlation is even attempted (below this the
// p-value is meaningless). Descriptive stats still run on any n.
const MIN_CORR_N = 5;

// null/undefined are NOT numbers (Number(null)===0 would silently coerce a missing
// value to 0) — treat them as missing, then require an actual finite number.
function asFinite(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

// Keep only index-aligned pairs where BOTH values are finite (NULL basis / NULL outcome excluded).
function finitePairs(xs, ys) {
  const x = [], y = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) { const a = asFinite(xs[i]), b = asFinite(ys[i]); if (a != null && b != null) { x.push(a); y.push(b); } }
  return { x, y, n: x.length };
}
function isConstant(arr) { if (arr.length === 0) return true; const f = arr[0]; for (let i = 1; i < arr.length; i++) if (arr[i] !== f) return false; return true; }
function finiteVals(arr) { const o = []; for (const v of arr) { const n = asFinite(v); if (n != null) o.push(n); } return o; }

module.exports = { STATUS, MIN_CORR_N, finitePairs, isConstant, finiteVals, sampleQuality };
