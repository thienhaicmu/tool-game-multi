'use strict';

// Debug-oriented diff: answers "what changed", not "show two JSONs".
// Pure + dependency-free so it is unit-testable.

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) return false; return a.every((x, i) => deepEqual(x, b[i])); }
  if (isObj(a) && isObj(b)) { const ak = Object.keys(a), bk = Object.keys(b); if (ak.length !== bk.length) return false; return ak.every((k) => k in b && deepEqual(a[k], b[k])); }
  return false;
}

// Structural JSON diff -> list of { path, op:'add'|'remove'|'change', from?, to? }.
function jsonDiff(a, b, path = '') {
  const out = [];
  if (deepEqual(a, b)) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? path + '.' + k : k;
      if (!(k in a)) out.push({ path: p, op: 'add', to: b[k] });
      else if (!(k in b)) out.push({ path: p, op: 'remove', from: a[k] });
      else out.push(...jsonDiff(a[k], b[k], p));
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, op: 'add', to: b[i] });
      else if (i >= b.length) out.push({ path: p, op: 'remove', from: a[i] });
      else out.push(...jsonDiff(a[i], b[i], p));
    }
  } else {
    out.push({ path: path || '$', op: 'change', from: a, to: b });
  }
  return out;
}

function tryParse(raw) { try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false }; } }

function lineDiff(a, b) {
  const al = String(a).split(/\r?\n/), bl = String(b).split(/\r?\n/);
  const aset = new Set(al), bset = new Set(bl);
  return { added: bl.filter((l) => !aset.has(l)), removed: al.filter((l) => !bset.has(l)) };
}

// Body diff: JSON semantic if both parse, else line diff, else binary metadata.
function bodyDiff(aRaw, bRaw) {
  if (aRaw == null && bRaw == null) return { changed: false };
  if (aRaw === bRaw) return { changed: false };
  if (aRaw == null || bRaw == null) return { changed: true, type: 'presence', from: aRaw, to: bRaw };
  const aj = tryParse(aRaw), bj = tryParse(bRaw);
  if (aj.ok && bj.ok) { const changes = jsonDiff(aj.value, bj.value); return { changed: changes.length > 0, type: 'json', changes }; }
  return { changed: true, type: 'text', lines: lineDiff(aRaw, bRaw) };
}

function lowerMap(h) {
  const m = new Map();
  for (const [name, value] of Object.entries(h || {})) m.set(name.toLowerCase(), { name, value: String(value) });
  return m;
}

// Header/cookie map diff (case-insensitive names).
function headersDiff(a, b) {
  const an = lowerMap(a), bn = lowerMap(b);
  const added = [], removed = [], changed = [];
  for (const [lk, e] of bn) if (!an.has(lk)) added.push({ name: e.name, value: e.value });
  for (const [lk, e] of an) {
    if (!bn.has(lk)) removed.push({ name: e.name, value: e.value });
    else if (bn.get(lk).value !== e.value) changed.push({ name: e.name, from: e.value, to: bn.get(lk).value });
  }
  return { added, removed, changed, count: added.length + removed.length + changed.length };
}

function queryOf(url) { try { const u = new URL(url); const o = {}; for (const [k, v] of u.searchParams) o[k] = v; return o; } catch { return {}; } }

// a,b: { method, url, headers, cookies?, body }  (body = raw string | null)
function requestDiff(a, b) {
  const method = a.method !== b.method ? { changed: true, from: a.method, to: b.method } : { changed: false };
  const url = a.url !== b.url ? { changed: true, from: a.url, to: b.url } : { changed: false };
  const query = headersDiff(queryOf(a.url), queryOf(b.url));
  const headers = headersDiff(a.headers, b.headers);
  const cookies = headersDiff(cookieMap(a.cookies), cookieMap(b.cookies));
  const body = bodyDiff(a.body ?? null, b.body ?? null);
  const changed = method.changed || url.changed || query.count > 0 || headers.count > 0 || cookies.count > 0 || body.changed;
  return { changed, method, url, query, headers, cookies, body };
}

function cookieMap(cookies) {
  if (!cookies) return {};
  if (Array.isArray(cookies)) { const o = {}; for (const c of cookies) if (c && c.name) o[c.name] = c.value; return o; }
  return cookies;
}

// a,b: { status, statusText, headers, body, duration }
function responseDiff(a, b) {
  if (!a || !b) return { comparable: false, reason: 'missing one side' };
  const status = a.status !== b.status ? { changed: true, from: a.status, to: b.status } : { changed: false };
  const headers = headersDiff(a.headers, b.headers);
  const bodyComparable = a.body != null && b.body != null;
  const body = bodyComparable ? bodyDiff(a.body, b.body) : { changed: false, comparable: false, reason: 'original body not loaded' };
  const durationDelta = (typeof a.duration === 'number' && typeof b.duration === 'number') ? b.duration - a.duration : null;
  const changed = status.changed || headers.count > 0 || (body.changed === true);
  return { comparable: true, changed, status, headers, body, duration: { from: a.duration ?? null, to: b.duration ?? null, deltaMs: durationDelta } };
}

module.exports = { requestDiff, responseDiff, jsonDiff, bodyDiff, headersDiff, deepEqual };
