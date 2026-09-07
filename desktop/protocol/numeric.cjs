'use strict';

// ---------------------------------------------------------------------------
// numeric — canonical STRICT parsing for user-editable numeric config.
//
// JavaScript's Number()/parseInt() are full of silent-coercion footguns that let
// nonsense reach the runtime:
//     Number('')      === 0        Number('   ')   === 0
//     Number('1e3')   === 1000     Number('0x10')  === 16
//     parseInt('12ab')=== 12       parseInt('2.5') === 2
//     Number('9007199254740993') silently loses precision
// This module rejects all of those. It accepts ONLY a plain decimal literal
// (optional sign, digits, optional single fraction) and — for integer fields —
// only a SAFE integer, so an accepted value always matches the whole input and
// never loses precision. It never rounds.
//
// It is used by the main-process authority (auto-runner.validateConfig,
// browser-config-store, autotest-start). The renderer mirrors the SAME rules for
// immediate feedback; a cross-check test keeps the two from drifting.
// ---------------------------------------------------------------------------

const INT_RE = /^[+-]?\d+$/;                       // 0, 42, -7  (no 1e3 / 0x10 / 2.5)
const DEC_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;   // 0, 2, 2.50, .5, -1.25 (no 1e3 / 0x10)

// parseStrict(raw, opts) -> { value } | { error }
//   integer   require an integer (and a SAFE integer)
//   gt        value must be strictly > gt
//   min/max   inclusive bounds
//   allowNull null / undefined / '' → { value: null } instead of an error
function parseStrict(raw, opts = {}) {
  const { integer = false, min = null, max = null, gt = null, allowNull = false } = opts;

  if (raw === null || raw === undefined) return allowNull ? { value: null } : { error: 'required' };

  let n;
  if (typeof raw === 'number') {
    // A typed number already went through JS parsing; enforce finiteness + integer safety
    // here (a string that was scientific/hex became a plain number upstream, which is fine —
    // the string layer is where those textual forms are rejected).
    if (!Number.isFinite(raw)) return { error: 'not-finite' };
    n = raw;
  } else {
    const s = String(raw).trim();
    if (s === '') return allowNull ? { value: null } : { error: 'empty' };
    const re = integer ? INT_RE : DEC_RE;
    if (!re.test(s)) return { error: integer ? 'not-integer' : 'not-number' };
    n = Number(s);
    if (!Number.isFinite(n)) return { error: 'not-finite' };
  }

  if (integer) {
    if (!Number.isInteger(n)) return { error: 'not-integer' };
    if (!Number.isSafeInteger(n)) return { error: 'unsafe-integer' };
  }
  if (gt !== null && !(n > gt)) return { error: 'too-small' };
  if (min !== null && n < min) return { error: 'too-small' };
  if (max !== null && n > max) return { error: 'too-large' };
  return { value: n };
}

// Convenience boolean predicate for whitelist-style validators.
function isStrict(raw, opts = {}) { return !parseStrict(raw, opts).error; }

module.exports = { parseStrict, isStrict, INT_RE, DEC_RE };
