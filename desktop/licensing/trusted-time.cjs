'use strict';

const https = require('node:https');
const { performance } = require('node:perf_hooks');

const DEFAULT_TIME_URLS = [
  'https://www.google.com/generate_204',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://www.microsoft.com',
];
const DEFAULT_TIMEOUT_MS = 5000;
const UTC_PLUS_7_OFFSET_SECONDS = 7 * 60 * 60;

function parseHttpDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function utcPlus7Date(seconds) {
  if (!Number.isFinite(Number(seconds))) return null;
  return new Date((Number(seconds) + UTC_PLUS_7_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

function readDateHeader(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      const serverMs = parseHttpDate(res.headers.date);
      res.resume();
      resolve(serverMs ? { ok: true, nowMs: serverMs, source: url, header: res.headers.date } : { ok: false, error: 'DATE_HEADER_MISSING', source: url });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'TIME_AUTHORITY_TIMEOUT', source: url });
    });
    req.on('error', (err) => resolve({ ok: false, error: err && err.code || 'TIME_AUTHORITY_ERROR', source: url }));
    req.end();
  });
}

class TrustedTimeProvider {
  constructor({ urls = DEFAULT_TIME_URLS, timeoutMs = DEFAULT_TIMEOUT_MS, fetchDateHeader = readDateHeader } = {}) {
    this._urls = urls;
    this._timeoutMs = timeoutMs;
    this._fetchDateHeader = fetchDateHeader;
    this._snapshot = null;
    this._pending = null;
  }

  _snapshotNowMs(snapshot = this._snapshot) {
    if (!snapshot) return null;
    return Math.floor(snapshot.nowMs + (performance.now() - snapshot.monotonicMs));
  }

  cachedNowMs() {
    const nowMs = this._snapshotNowMs();
    if (nowMs == null) return null;
    return nowMs;
  }

  async now() {
    const cached = this.cachedNowMs();
    if (cached != null) return { ok: true, nowMs: cached, source: this._snapshot.source, cached: true };
    if (this._pending) return this._pending;
    this._pending = this._refresh();
    try { return await this._pending; }
    finally { this._pending = null; }
  }

  async _refresh() {
    const errors = [];
    for (const url of this._urls) {
      const result = await this._fetchDateHeader(url, this._timeoutMs);
      if (result && result.ok && Number.isFinite(result.nowMs)) {
        this._snapshot = { nowMs: result.nowMs, monotonicMs: performance.now(), source: result.source || url };
        return { ok: true, nowMs: this._snapshotNowMs(), source: this._snapshot.source, cached: false };
      }
      errors.push(result || { ok: false, source: url, error: 'TIME_AUTHORITY_ERROR' });
    }
    return { ok: false, error: { code: 'TRUSTED_TIME_UNAVAILABLE', message: 'Unable to verify trusted UTC+7 time', attempts: errors } };
  }
}

module.exports = {
  DEFAULT_TIME_URLS,
  UTC_PLUS_7_OFFSET_SECONDS,
  TrustedTimeProvider,
  parseHttpDate,
  readDateHeader,
  utcPlus7Date,
};
