'use strict';

const REDACTED = '[redacted]';
const SECRET = /password|passwd|pwd|token|secret|cookie|authorization|sessiontoken|roomcode|sharedcode|hostkey|^key$|^value$|^sig(nature)?$/i;
// Diagnostics accept structured metadata only. Opaque strings (including binary
// previews, game-memory probes and exception bodies) are not safe to export.
const OPAQUE = /^(raw|hex|ascii|result|err|stack|message|msg)$/i;
function maskSecret(value) { return value == null || value === '' ? null : `••••${String(value).length > 4 ? String(value).slice(-4) : ''}`; }
function redactDiagnostic(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redactDiagnostic(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET.test(key) || OPAQUE.test(key) ? REDACTED : redactDiagnostic(item, depth + 1);
  }
  return out;
}
module.exports = { redactDiagnostic, maskSecret, REDACTED };
