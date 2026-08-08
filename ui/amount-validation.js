// WU10.2 — Bet Amount Validation: pure UI helpers (parse + presets). UI-only,
// testable. Browser global (window.AmountValidation) + Node module for tests.
//
// TYPE validation only (§4): reject values that can't represent the numeric field
// (empty / NaN / Infinity / non-numeric). It NEVER rejects on business range —
// negatives, zero, below-min, above-max and extremes are all allowed on purpose,
// because testing whether the SERVER enforces those is the whole point (§3/§27).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AmountValidation = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // parseAmount(str) -> { value, error }. Accepts any finite number (incl. -1, 0).
  function parseAmount(str) {
    const s = String(str == null ? '' : str).trim();
    if (s === '') return { value: null, error: 'Required' };
    if (/^(nan|infinity|-infinity|\+infinity)$/i.test(s)) return { value: null, error: 'Not a finite number' };
    const n = Number(s);
    if (!Number.isFinite(n)) return { value: null, error: 'Not a number' };
    return { value: n, error: null };
  }

  // parseValues(text) -> { values, errors } from a newline/comma separated list.
  function parseValues(text) {
    const lines = String(text == null ? '' : text).split(/[\n,]/).map((x) => x.trim()).filter((x) => x !== '');
    const values = [], errors = [];
    for (const line of lines) { const p = parseAmount(line); if (p.error) errors.push({ input: line, error: p.error }); else values.push(p.value); }
    return { values, errors };
  }

  // Convenience preset generator around the OBSERVED client UI limits (§7/§23).
  // These are editable suggestions, NOT validation rules.
  function generateAroundLimits(uiMin, uiMax) {
    const lo = Number(uiMin), hi = Number(uiMax);
    const out = [0, 1, lo - 1, lo, lo + 1, hi - 1, hi, hi + 1];
    return out.filter((v, i, a) => Number.isFinite(v) && a.indexOf(v) === i);
  }

  return { parseAmount, parseValues, generateAroundLimits };
});
