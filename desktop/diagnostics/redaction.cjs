'use strict';

// ---------------------------------------------------------------------------
// Canonical sensitive-data redaction policy — SHARED by every persistence path
// (Control DiagnosticLog, Control TrafficStore, Analytics SQLite writes).
//
// One policy, one place: header values, URL query secrets and inline
// Bearer/JWT tokens are redacted BEFORE anything is written to disk. Header
// NAMES are always preserved (so evidence still shows that an Authorization /
// X-TOKEN header existed) — only the secret VALUE becomes "[REDACTED]".
//
// Extracted verbatim from diagnostic-log.cjs (which now re-exports these) so the
// two products can never drift into divergent redaction rules.
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

// Keys whose VALUES must never be persisted (case-insensitive substring match).
const SENSITIVE_KEY = /(password|passwd|pwd|secret|token|authorization|proxy-authorization|\bauth\b|cookie|bearer|refresh|credential|api[_-]?key|apikey|x-auth|x-fg-id|sessionid|session[_-]?secret|set-cookie)/i;
// Query parameters commonly carrying secrets — dropped from any URL we persist.
const SENSITIVE_QUERY = /(token|auth|password|secret|sid|session|key|sig|signature|access_token|refresh_token)/i;

// Reduce an arbitrary URL to safe host + path (drop query, hash and userinfo).
function sanitizeUrl(url) {
  const raw = String(url == null ? '' : url);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Not a full URL — strip anything after ? or # and any inline credentials.
    return raw.split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//');
  }
}

// Keep host + path + query, but strip inline credentials and redact the VALUES
// of any query parameter whose name looks secret. Used for traffic evidence
// where the query string is research-relevant (e.g. game entry params) but must
// not leak tokens.
function safeUrlKeepQuery(url) {
  const raw = String(url == null ? '' : url);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.username = ''; u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(k)) u.searchParams.set(k, REDACTED);
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@]*@/, '//');
  }
}

function redactString(s) {
  let out = String(s);
  // Authorization: Bearer <jwt> / Basic <...>
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 ' + REDACTED);
  // Bare JWT-looking tokens (three base64url segments).
  out = out.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED);
  return out;
}

// Recursively copy a value, redacting sensitive keys, Bearer strings and secret
// query strings. Bounded depth guards against cycles / pathological nesting.
function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[TRUNCATED]';
  const t = typeof value;
  if (t === 'string') return redactString(value);
  if (t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (SENSITIVE_KEY.test(k)) { out[k] = REDACTED; continue; }
      if (/^(url|href|location|path|requestUrl|documentUrl)$/i.test(k) && typeof value[k] === 'string') {
        out[k] = sanitizeUrl(value[k]);
        continue;
      }
      try { out[k] = redact(value[k], depth + 1); } catch { out[k] = '[UNSERIALIZABLE]'; }
    }
    return out;
  }
  return undefined; // functions/symbols dropped
}

// Redact an HTTP header map: preserve every header NAME, replace the VALUE of any
// sensitive header with "[REDACTED]". Non-sensitive values are still run through
// redactString so an inline Bearer/JWT never survives. Returns a NEW object; the
// input is never mutated. Accepts null/undefined (returns as-is).
function redactHeaders(headers) {
  if (headers == null || typeof headers !== 'object') return headers;
  const out = {};
  for (const k of Object.keys(headers)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactString(headers[k]);
  }
  return out;
}

module.exports = { REDACTED, SENSITIVE_KEY, SENSITIVE_QUERY, sanitizeUrl, safeUrlKeepQuery, redactString, redact, redactHeaders };
