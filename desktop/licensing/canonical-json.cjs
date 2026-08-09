'use strict';

function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number cannot be serialized');
    return JSON.stringify(value);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  throw new Error('Unsupported JSON value');
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(input) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(input || ''))) throw new Error('Invalid base64url');
  return Buffer.from(String(input), 'base64url');
}

module.exports = { canonicalJson, base64url, fromBase64url };
