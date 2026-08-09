// Auto Run config reader/validator. UI-only, pure, testable. Loaded as a
// browser global (window.AutoTestConfig) AND as a Node module for unit tests.
//
// It mirrors the AutoRunner backend contract EXACTLY (roundCount / amount / stopOdd,
// aid/eid default 1) — it does not invent a second schema or new limits. Client-side
// validation exists only so Start can be disabled and per-field errors shown before
// any IPC call; the backend validateConfig remains the source of truth.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AutoTestConfig = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function toNum(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  // validate(raw) — raw = { rounds, amount, stopOdd, aid?, eid? } (strings from inputs).
  // Returns { ok, errors:{field:msg}, config:{roundCount,amount,stopOdd,aid,eid}|null }.
  function validate(raw = {}) {
    const errors = {};
    const rc = toNum(raw.rounds);
    if (rc == null) errors.rounds = 'Required';
    else if (!Number.isInteger(rc) || rc < 1) errors.rounds = 'Whole number ≥ 1';

    const amt = toNum(raw.amount);
    if (amt == null) errors.amount = 'Required';
    else if (!(amt > 0)) errors.amount = 'Must be > 0';

    const so = toNum(raw.stopOdd);
    if (so == null) errors.stopOdd = 'Required';
    else if (!(so > 0)) errors.stopOdd = 'Must be > 0';

    const aidRaw = raw.aid == null || String(raw.aid).trim() === '' ? 1 : toNum(raw.aid);
    const eidRaw = raw.eid == null || String(raw.eid).trim() === '' ? 1 : toNum(raw.eid);
    if (!Number.isInteger(aidRaw) || aidRaw < 0) errors.aid = 'Non-negative integer';
    if (!Number.isInteger(eidRaw) || eidRaw < 0) errors.eid = 'Non-negative integer';

    const ok = Object.keys(errors).length === 0;
    const config = ok ? { roundCount: rc, amount: amt, stopOdd: so, aid: aidRaw, eid: eidRaw } : null;
    return { ok, errors, config };
  }

  return { toNum, validate };
});
