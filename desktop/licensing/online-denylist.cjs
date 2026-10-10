'use strict';

// ONLINE REVOKE via a shared denylist (a static revoked.json on GitHub raw). Agreed 2026-10-09: 30-min checks, 24-h
// offline grace, a revoke/grace-elapsed = make the license go INACTIVE (the app's existing lock path then stops Auto
// and locks the buttons, keeping the windows). The app only READS a public URL — no credential, no Google.
//
//   revoked.json:  { "revoked": { "<licenseId>": "lý do" } }   OR   { "revoked": ["<licenseId>", ...] }
//
// decideOnline() is PURE and testable; createDenylistGuard() is the poller the app starts once a license is active.

const STATE = Object.freeze({ LIVE: 'LIVE', GRACE: 'GRACE', LOCKED: 'LOCKED' });
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

// remote: null | { ok:true, revoked:bool, active:bool, reason? } | { ok:false }
function decideOnline({ remote, anchorAt, now, graceMs = DEFAULT_GRACE_MS }) {
  if (remote && remote.ok) {
    if (remote.revoked) return { state: STATE.LOCKED, reason: remote.reason || 'REVOKED', confirmed: true };
    return { state: STATE.LIVE, reason: null, confirmed: true };
  }
  const elapsed = Math.max(0, Number(now) - Number(anchorAt));
  if (elapsed <= graceMs) return { state: STATE.GRACE, reason: 'OFFLINE', confirmed: false, graceRemainingMs: graceMs - elapsed };
  return { state: STATE.LOCKED, reason: 'GRACE_EXPIRED', confirmed: false };
}

function revokedEntry(body, licenseId) {
  const r = body && body.revoked;
  if (!r) return null;
  if (Array.isArray(r)) return r.includes(licenseId) ? '' : null;
  if (typeof r === 'object') return Object.prototype.hasOwnProperty.call(r, licenseId) ? String(r[licenseId] || '') : null;
  return null;
}

// GET the denylist and report THIS key's status. fetchImpl injected (electron net.fetch / https wrapper / fake).
async function checkDenylist(url, licenseId, { fetchImpl, timeoutMs = 8000 } = {}) {
  if (!url || !fetchImpl || !licenseId) return { ok: false, reason: 'NO_ENDPOINT' };
  const u = new URL(url);
  u.searchParams.set('t', String(Math.floor(Date.now() / 60000))); // cache-bust the raw CDN each minute
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(u.toString(), { cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}) });
    // no list published yet (or it was removed) = nobody revoked — never lock every customer for a missing file
    if (res && res.status === 404) return { ok: true, revoked: false, active: true, reason: 'NO_LIST' };
    if (!res || !res.ok) return { ok: false, reason: 'HTTP_' + (res ? res.status : 'ERR') };
    const body = await res.json();
    const reason = revokedEntry(body, licenseId);
    if (reason != null) return { ok: true, revoked: true, active: false, reason: reason || 'REVOKED' };
    return { ok: true, revoked: false, active: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.name === 'AbortError' ? 'TIMEOUT' : (e && e.message) || e) };
  } finally { if (timer) clearTimeout(timer); }
}

// The poller. onChange(decision) fires whenever the LOCKED-ness changes (so the app locks/unlocks once per transition).
// url empty → OFF (never locks). Start it only after the signed license verified active, with that license's id.
function createDenylistGuard({ url, licenseId, fetchImpl, intervalMs = DEFAULT_INTERVAL_MS, graceMs = DEFAULT_GRACE_MS, now = () => Date.now(), onChange = () => {}, log }) {
  let anchorAt = now();
  let decision = { state: STATE.GRACE, reason: 'STARTING', confirmed: false };
  let timer = null;
  let lastLocked = false;

  async function poll() {
    if (!url || !licenseId || !fetchImpl) { decision = { state: STATE.LIVE, reason: 'OFF', confirmed: true }; return decision; }
    let remote;
    try { remote = await checkDenylist(url, licenseId, { fetchImpl }); }
    catch (e) { remote = { ok: false, reason: String(e && e.message || e) }; }
    if (remote && remote.ok) anchorAt = now();
    decision = decideOnline({ remote, anchorAt, now: now(), graceMs });
    const locked = decision.state === STATE.LOCKED;
    if (locked !== lastLocked) { lastLocked = locked; if (log) try { log({ event: 'ONLINE_LICENSE', state: decision.state, reason: decision.reason }); } catch {} onChange(decision); }
    return decision;
  }
  function start() { if (timer || !url) return; poll(); timer = setInterval(() => poll().catch(() => {}), intervalMs); if (timer.unref) timer.unref(); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  return { start, stop, poll, status: () => ({ ...decision }), isLocked: () => decision.state === STATE.LOCKED };
}

// a tiny https GET → { ok, status, json() } for the guard's fetchImpl (no extra deps; follows one redirect)
function createHttpsFetch() {
  return (url, opts = {}) => new Promise((resolve, reject) => {
    const https = require('node:https');
    const req = https.get(url, { timeout: 8000, headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(createHttpsFetch()(new URL(res.headers.location, url).toString(), opts)); }
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(data) }));
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    if (opts.signal) opts.signal.addEventListener('abort', () => req.destroy(new Error('AbortError')), { once: true });
  });
}

// the shared denylist URL (empty = online revoke OFF). Both products read desktop/licensing/online-denylist.config.json.
function readUrlConfig(file) {
  try { const j = JSON.parse(require('node:fs').readFileSync(file, 'utf8')); return typeof j.url === 'string' ? j.url.trim() : ''; } catch { return ''; }
}

module.exports = { decideOnline, checkDenylist, revokedEntry, createDenylistGuard, createHttpsFetch, readUrlConfig, STATE, DEFAULT_INTERVAL_MS, DEFAULT_GRACE_MS };
