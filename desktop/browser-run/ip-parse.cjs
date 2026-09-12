'use strict';

// Pure parsing of an IP-check endpoint response into an observed public IP. Accepts
// common shapes: JSON { ip | origin | query | ipAddress } or a plain-text body that
// contains an IPv4/IPv6 address. Returns null when nothing usable is present (the
// caller then raises PROXY_IP_RESPONSE_INVALID — never a direct fallback).

function isIp(s) {
  const v = String(s || '').trim();
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(v) || /^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/.test(v);
}

function parseObservedIp(body) {
  const text = String(body == null ? '' : body).trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const cand = j && (j.ip || j.origin || j.query || j.ipAddress);
    if (cand) { const first = String(cand).split(',')[0].trim(); if (isIp(first)) return first; }
  } catch { /* not json */ }
  const m = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-fA-F:]{2,}:[0-9a-fA-F:]+\b/);
  return m && isIp(m[0]) ? m[0] : null;
}

module.exports = { isIp, parseObservedIp };
