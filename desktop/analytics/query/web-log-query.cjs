'use strict';

const S = require('./statistics.cjs');

// ---------------------------------------------------------------------------
// WebLogQuery + NetworkReport — read-only descriptive views over the passive
// Web/network evidence (network_requests/responses/bodies, ws_connections,
// raw_ws_events). No replay/resend/edit/intercept. All filters combine with AND.
// ---------------------------------------------------------------------------

const RESOURCE_TYPES = new Set(['Document', 'XHR', 'Fetch', 'WebSocket', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Other']);
const STATUS_FAMILY = new Set(['2xx', '3xx', '4xx', '5xx', 'Failed']);
const MAX_ROWS = 500000;

function normalizeNetworkFilter(raw = {}) {
  const f = raw || {}; const spec = {};
  spec.browserId = f.browserId != null ? String(f.browserId) : null;
  spec.captureSessionId = f.captureSessionId != null ? Number(f.captureSessionId) : null;
  spec.timeFromMs = (f.timeFromMs != null && Number.isFinite(Number(f.timeFromMs))) ? Number(f.timeFromMs) : null;
  spec.timeToMs = (f.timeToMs != null && Number.isFinite(Number(f.timeToMs))) ? Number(f.timeToMs) : null;
  spec.resourceType = (f.resourceType && RESOURCE_TYPES.has(f.resourceType)) ? f.resourceType : null;
  spec.method = f.method != null ? String(f.method).toUpperCase() : null;
  spec.statusFamily = (f.statusFamily && STATUS_FAMILY.has(f.statusFamily)) ? f.statusFamily : null;
  spec.host = f.host != null ? String(f.host) : null;
  spec.urlContains = f.urlContains != null ? String(f.urlContains) : null;
  spec.text = f.text != null ? String(f.text) : null;
  spec.wsDirection = (f.wsDirection === 'SEND' || f.wsDirection === 'RECV') ? f.wsDirection : null;
  spec.cmd = Number.isFinite(Number(f.cmd)) ? Number(f.cmd) : null;
  spec.sid = f.sid != null ? String(f.sid) : null;
  spec.hasOdd = f.hasOdd === true;
  spec.hasJackpot = f.hasJackpot === true;
  return spec;
}

function statusFamilyClause(fam, col) {
  switch (fam) {
    case '2xx': return `${col} >= 200 AND ${col} < 300`;
    case '3xx': return `${col} >= 300 AND ${col} < 400`;
    case '4xx': return `${col} >= 400 AND ${col} < 500`;
    case '5xx': return `${col} >= 500 AND ${col} < 600`;
    case 'Failed': return `(resp.failed = 1 OR ${col} IS NULL)`;
    default: return null;
  }
}

class WebLogQuery {
  constructor({ store } = {}) { if (!store) throw new Error('WebLogQuery requires a store'); this._store = store; this._db = store.db; }

  _wsOnly(spec) { return spec.resourceType === 'WebSocket' || spec.wsDirection != null || spec.cmd != null || spec.sid != null || spec.hasOdd || spec.hasJackpot; }
  _httpOnly(spec) { return (spec.resourceType != null && spec.resourceType !== 'WebSocket') || spec.method != null || spec.statusFamily != null; }

  _httpWhere(spec) {
    const w = ['1=1']; const p = [];
    if (spec.browserId != null) { w.push('nr.browser_id = ?'); p.push(spec.browserId); }
    if (spec.captureSessionId != null) { w.push('nr.capture_session_id = ?'); p.push(spec.captureSessionId); }
    if (spec.timeFromMs != null) { w.push('nr.timestamp_ms >= ?'); p.push(spec.timeFromMs); }
    if (spec.timeToMs != null) { w.push('nr.timestamp_ms <= ?'); p.push(spec.timeToMs); }
    if (spec.resourceType && spec.resourceType !== 'WebSocket') { w.push('nr.resource_type = ?'); p.push(spec.resourceType); }
    if (spec.method) { w.push('nr.method = ?'); p.push(spec.method); }
    if (spec.host) { w.push('nr.host = ?'); p.push(spec.host); }
    if (spec.urlContains) { w.push('nr.url LIKE ?'); p.push('%' + spec.urlContains + '%'); }
    if (spec.text) { w.push('(nr.url LIKE ? OR nr.host LIKE ? OR nr.method LIKE ?)'); p.push('%' + spec.text + '%', '%' + spec.text + '%', '%' + spec.text + '%'); }
    if (spec.statusFamily) { const c = statusFamilyClause(spec.statusFamily, 'resp.status'); if (c) w.push(c); }
    return { clause: w.join(' AND '), params: p };
  }
  _wsWhere(spec) {
    const w = ['1=1']; const p = [];
    if (spec.browserId != null) { w.push('rwe.browser_id = ?'); p.push(spec.browserId); }
    if (spec.captureSessionId != null) { w.push('rwe.capture_session_id = ?'); p.push(spec.captureSessionId); }
    if (spec.timeFromMs != null) { w.push('rwe.timestamp_ms >= ?'); p.push(spec.timeFromMs); }
    if (spec.timeToMs != null) { w.push('rwe.timestamp_ms <= ?'); p.push(spec.timeToMs); }
    if (spec.wsDirection) { w.push('rwe.direction = ?'); p.push(spec.wsDirection); }
    if (spec.cmd != null) { w.push('rwe.cmd = ?'); p.push(spec.cmd); }
    if (spec.sid != null) { w.push('rwe.sid = ?'); p.push(spec.sid); }
    if (spec.hasOdd) { w.push('rwe.odd IS NOT NULL'); }
    if (spec.hasJackpot) { w.push('rwe.jackpot IS NOT NULL'); }
    if (spec.urlContains) { w.push('wsc.url LIKE ?'); p.push('%' + spec.urlContains + '%'); }
    if (spec.text) { w.push('(wsc.url LIKE ? OR rwe.payload LIKE ?)'); p.push('%' + spec.text + '%', '%' + spec.text + '%'); }
    return { clause: w.join(' AND '), params: p };
  }

  // Paginated unified log (HTTP + WS frames), newest first.
  query(rawFilter, { limit = 100, offset = 0 } = {}) {
    const spec = normalizeNetworkFilter(rawFilter);
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const includeHttp = !this._wsOnly(spec);
    const includeWs = !this._httpOnly(spec);
    const parts = []; const params = [];
    if (includeHttp) {
      const h = this._httpWhere(spec);
      parts.push(`SELECT 'HTTP' AS kind, nr.id AS id, nr.timestamp_ms AS ts, nr.resource_type AS type, nr.method AS method,
        resp.status AS status, nr.host AS host, nr.url AS url, resp.duration_ms AS duration, resp.encoded_data_length AS size,
        NULL AS direction, NULL AS cmd, NULL AS sid, NULL AS odd, NULL AS jackpot
        FROM network_requests nr LEFT JOIN network_responses resp ON resp.network_request_id = nr.id WHERE ${h.clause}`);
      params.push(...h.params);
    }
    if (includeWs) {
      const wq = this._wsWhere(spec);
      parts.push(`SELECT 'WS' AS kind, rwe.id AS id, rwe.timestamp_ms AS ts, ('WS ' || rwe.direction) AS type, NULL AS method,
        NULL AS status, wsc.url AS host, wsc.url AS url, NULL AS duration, rwe.payload_size AS size,
        rwe.direction AS direction, rwe.cmd AS cmd, rwe.sid AS sid, rwe.odd AS odd, rwe.jackpot AS jackpot
        FROM raw_ws_events rwe LEFT JOIN ws_connections wsc ON wsc.id = rwe.ws_connection_id WHERE ${wq.clause}`);
      params.push(...wq.params);
    }
    if (!parts.length) return { rows: [], total: 0, limit: lim, offset: off };
    const union = parts.join(' UNION ALL ');
    const rows = this._db.prepare(`SELECT * FROM (${union}) ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    const total = this._db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get(...params).n;
    return { rows, total, limit: lim, offset: off };
  }

  summary(rawFilter) {
    const spec = normalizeNetworkFilter(rawFilter);
    const h = this._httpWhere(spec);
    const httpCount = this._db.prepare(`SELECT COUNT(*) AS n FROM network_requests nr LEFT JOIN network_responses resp ON resp.network_request_id = nr.id WHERE ${h.clause}`).get(...h.params).n;
    const wq = this._wsWhere(spec);
    const wsCount = this._db.prepare(`SELECT COUNT(*) AS n FROM raw_ws_events rwe LEFT JOIN ws_connections wsc ON wsc.id = rwe.ws_connection_id WHERE ${wq.clause}`).get(...wq.params).n;
    return { httpRequests: httpCount, wsFrames: wsCount };
  }

  detail(kind, id) {
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return { error: { code: 'INVALID_ID', message: 'id must be a positive integer' } };
    if (kind === 'WS') {
      const ev = this._db.prepare('SELECT * FROM raw_ws_events WHERE id = ?').get(nid);
      if (!ev) return { error: { code: 'NOT_FOUND', message: 'No such WS event' } };
      const conn = ev.ws_connection_id != null ? this._store.ws.getConnection(ev.ws_connection_id) : null;
      return { kind: 'WS', event: ev, connection: conn };
    }
    const req = this._db.prepare('SELECT * FROM network_requests WHERE id = ?').get(nid);
    if (!req) return { error: { code: 'NOT_FOUND', message: 'No such request' } };
    const resp = this._db.prepare('SELECT * FROM network_responses WHERE network_request_id = ? ORDER BY id DESC LIMIT 1').get(nid) || null;
    const body = this._db.prepare('SELECT * FROM network_bodies WHERE network_request_id = ? ORDER BY id DESC LIMIT 1').get(nid) || null;
    return { kind: 'HTTP', request: req, response: resp, body };
  }

  wsConnection(id) { const c = this._store.ws.getConnection(id); return c ? { connection: c } : { error: { code: 'NOT_FOUND', message: 'No such ws connection' } }; }
  wsFrames(id, opts) { return { frames: this._store.ws.getEvents(id, opts || {}) }; }
}

// -------- Network / API report (descriptive; "Observed network activity") --------
class NetworkReport {
  constructor({ store } = {}) { if (!store) throw new Error('NetworkReport requires a store'); this._store = store; this._db = store.db; }

  _load(spec) {
    const w = ['1=1']; const p = [];
    if (spec.browserId != null) { w.push('nr.browser_id = ?'); p.push(spec.browserId); }
    if (spec.captureSessionId != null) { w.push('nr.capture_session_id = ?'); p.push(spec.captureSessionId); }
    if (spec.timeFromMs != null) { w.push('nr.timestamp_ms >= ?'); p.push(spec.timeFromMs); }
    if (spec.timeToMs != null) { w.push('nr.timestamp_ms <= ?'); p.push(spec.timeToMs); }
    if (spec.host) { w.push('nr.host = ?'); p.push(spec.host); }
    const sql = `SELECT nr.id, nr.timestamp_ms AS ts, nr.resource_type AS type, nr.method, nr.host, nr.path,
      resp.status AS status, resp.failed AS failed, resp.duration_ms AS duration, resp.encoded_data_length AS size
      FROM network_requests nr LEFT JOIN network_responses resp ON resp.network_request_id = nr.id
      WHERE ${w.join(' AND ')} ORDER BY nr.timestamp_ms ASC LIMIT ?`;
    return this._db.prepare(sql).all(...p, MAX_ROWS);
  }
  _wsCounts(spec) {
    const w = ['1=1']; const p = [];
    if (spec.browserId != null) { w.push('browser_id = ?'); p.push(spec.browserId); }
    if (spec.captureSessionId != null) { w.push('capture_session_id = ?'); p.push(spec.captureSessionId); }
    if (spec.timeFromMs != null) { w.push('timestamp_ms >= ?'); p.push(spec.timeFromMs); }
    if (spec.timeToMs != null) { w.push('timestamp_ms <= ?'); p.push(spec.timeToMs); }
    const row = this._db.prepare(`SELECT SUM(direction='SEND') AS s, SUM(direction='RECV') AS r, COUNT(*) AS n FROM raw_ws_events WHERE ${w.join(' AND ')}`).get(...p);
    return { send: row.s || 0, recv: row.r || 0, frames: row.n || 0 };
  }

  overview(rawFilter) {
    const spec = normalizeNetworkFilter(rawFilter);
    const rows = this._load(spec);
    const ws = this._wsCounts(spec);
    const n = rows.length;
    const fam = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, failed: 0 };
    let xhr = 0, fetch = 0, doc = 0;
    const durations = [];
    let firstTs = null, lastTs = null;
    for (const r of rows) {
      if (r.type === 'XHR') xhr++; else if (r.type === 'Fetch') fetch++; else if (r.type === 'Document') doc++;
      if (r.failed || r.status == null) fam.failed++;
      else if (r.status < 300) fam['2xx']++; else if (r.status < 400) fam['3xx']++; else if (r.status < 500) fam['4xx']++; else fam['5xx']++;
      if (Number.isFinite(r.duration)) durations.push(r.duration);
      if (r.ts != null) { if (firstTs == null || r.ts < firstTs) firstTs = r.ts; if (lastTs == null || r.ts > lastTs) lastTs = r.ts; }
    }
    const spanMin = (firstTs != null && lastTs != null && lastTs > firstTs) ? (lastTs - firstTs) / 60000 : null;
    const d = S.describe(durations);
    return {
      totalRequests: n, requestsPerMinute: spanMin ? n / spanMin : null,
      xhrCount: xhr, fetchCount: fetch, documentCount: doc,
      wsFrames: ws.frames, wsSendCount: ws.send, wsRecvCount: ws.recv,
      status: fam,
      durationMeanMs: d.mean, durationMedianMs: d.median, durationP95Ms: d.p95,
      timeRange: { firstTs, lastTs },
    };
  }

  endpoints(rawFilter, { limit = 50 } = {}) {
    const rows = this._load(normalizeNetworkFilter(rawFilter));
    const map = new Map();
    for (const r of rows) {
      const key = `${r.method || '?'} ${r.host || '?'} ${r.path || '?'}`;
      let e = map.get(key);
      if (!e) { e = { key, method: r.method, host: r.host, path: r.path, count: 0, success: 0, c4xx: 0, c5xx: 0, failures: 0, durations: [], bytes: 0 }; map.set(key, e); }
      e.count++;
      if (r.failed || r.status == null) e.failures++;
      else if (r.status >= 200 && r.status < 400) e.success++; else if (r.status < 500) e.c4xx++; else e.c5xx++;
      if (Number.isFinite(r.duration)) e.durations.push(r.duration);
      if (Number.isFinite(r.size)) e.bytes += r.size;
    }
    const out = [...map.values()].map((e) => ({ key: e.key, method: e.method, host: e.host, path: e.path, count: e.count, success: e.success, c4xx: e.c4xx, c5xx: e.c5xx, failures: e.failures, meanDurationMs: S.mean(e.durations), medianDurationMs: S.median(e.durations), p95DurationMs: S.quantile(e.durations, 0.95), responseBytes: e.bytes }));
    out.sort((a, b) => b.count - a.count);
    return { endpoints: out.slice(0, Math.max(1, Math.min(500, limit))) };
  }

  hosts(rawFilter, { limit = 50 } = {}) {
    const spec = normalizeNetworkFilter(rawFilter);
    const rows = this._load(spec);
    const map = new Map();
    for (const r of rows) {
      const key = r.host || '?';
      let h = map.get(key);
      if (!h) { h = { host: key, requestCount: 0, xhrFetch: 0, errors: 0, durations: [] }; map.set(key, h); }
      h.requestCount++;
      if (r.type === 'XHR' || r.type === 'Fetch') h.xhrFetch++;
      if (r.failed || (r.status != null && r.status >= 400)) h.errors++;
      if (Number.isFinite(r.duration)) h.durations.push(r.duration);
    }
    const out = [...map.values()].map((h) => ({ host: h.host, requestCount: h.requestCount, xhrFetchCount: h.xhrFetch, errorCount: h.errors, meanDurationMs: S.mean(h.durations) }));
    out.sort((a, b) => b.requestCount - a.requestCount);
    return { hosts: out.slice(0, Math.max(1, Math.min(500, limit))) };
  }

  timeline(rawFilter, granularity = '5m') {
    const sizes = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 };
    const size = sizes[granularity] || 300000;
    const rows = this._load(normalizeNetworkFilter(rawFilter));
    const map = new Map();
    for (const r of rows) {
      if (r.ts == null) continue;
      const bucket = Math.floor(r.ts / size) * size;
      let b = map.get(bucket);
      if (!b) { b = { bucket, count: 0, xhrFetch: 0, errors: 0, durations: [] }; map.set(bucket, b); }
      b.count++;
      if (r.type === 'XHR' || r.type === 'Fetch') b.xhrFetch++;
      if (r.failed || (r.status != null && r.status >= 400)) b.errors++;
      if (Number.isFinite(r.duration)) b.durations.push(r.duration);
    }
    const ws = this._wsTimeline(normalizeNetworkFilter(rawFilter), size);
    const buckets = [...map.values()].sort((a, b) => a.bucket - b.bucket).map((b) => ({
      bucketStartMs: b.bucket, label: new Date(b.bucket).toISOString(), requestCount: b.count, xhrFetchCount: b.xhrFetch,
      errorCount: b.errors, avgDurationMs: S.mean(b.durations), wsSend: ws.get(b.bucket) ? ws.get(b.bucket).s : 0, wsRecv: ws.get(b.bucket) ? ws.get(b.bucket).r : 0,
    }));
    return { granularity, buckets };
  }
  _wsTimeline(spec, size) {
    const w = ['1=1']; const p = [];
    if (spec.browserId != null) { w.push('browser_id = ?'); p.push(spec.browserId); }
    if (spec.captureSessionId != null) { w.push('capture_session_id = ?'); p.push(spec.captureSessionId); }
    if (spec.timeFromMs != null) { w.push('timestamp_ms >= ?'); p.push(spec.timeFromMs); }
    if (spec.timeToMs != null) { w.push('timestamp_ms <= ?'); p.push(spec.timeToMs); }
    const rows = this._db.prepare(`SELECT (timestamp_ms/${size})*${size} AS bucket, SUM(direction='SEND') AS s, SUM(direction='RECV') AS r FROM raw_ws_events WHERE ${w.join(' AND ')} GROUP BY bucket`).all(...p);
    const m = new Map(); for (const r of rows) m.set(r.bucket, { s: r.s || 0, r: r.r || 0 }); return m;
  }
}

module.exports = { WebLogQuery, NetworkReport, normalizeNetworkFilter, RESOURCE_TYPES };
