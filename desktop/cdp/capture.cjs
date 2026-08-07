'use strict';

const EventEmitter = require('node:events');
const { CODES } = require('./errors.cjs');

// Default cap so a single huge body can't blow up memory during verification.
// Not a storage platform (WU10 owns scale); truncation is always flagged.
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

function parseUrl(raw) {
  try {
    const u = new URL(raw);
    return { scheme: u.protocol.replace(/:$/, ''), host: u.host, path: u.pathname, query: [...u.searchParams.entries()] };
  } catch { return { scheme: '', host: '', path: raw, query: [] }; }
}

// Cookies the browser associated with the request (network-level), from ExtraInfo.
function requestCookies(extra) {
  if (!extra || !Array.isArray(extra.associatedCookies)) return [];
  return extra.associatedCookies.map(c => ({
    name: c.cookie && c.cookie.name, value: c.cookie && c.cookie.value,
    blocked: Array.isArray(c.blockedReasons) && c.blockedReasons.length ? c.blockedReasons : undefined,
  })).filter(c => c.name);
}

/**
 * CaptureCorrelator turns raw CDP Network events (fed per target) into a
 * canonical CapturedRequest/CapturedResponse model. It is transport-agnostic:
 * the caller subscribes to a target's dedicated client and forwards events with
 * that target's id, so request identity is always target-bound.
 *
 * Correlation key = `${targetId}:${cdpRequestId}`. CDP reuses requestId across
 * redirect hops, so each hop becomes its own CapturedRequest linked by
 * redirectFromId; `_current` points at the in-flight hop for a key.
 *
 * ExtraInfo events may arrive before OR after their main event; unmatched
 * ExtraInfo is held pending and merged when the main event lands.
 *
 * Events emitted: 'request'(captured), 'response'(captured), 'update'(captured).
 */
class CaptureCorrelator extends EventEmitter {
  constructor(options = {}) {
    super();
    this._resolveClient = options.resolveClient || (() => null); // (targetId) -> CDP client | null
    this._maxBodyBytes = Number(options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES);
    this._store = new Map();          // capturedId -> CapturedRequest
    this._current = new Map();        // cdpKey -> capturedId (in-flight hop)
    this._pendingReqExtra = new Map();// cdpKey -> requestWillBeSentExtraInfo params
    this._pendingRespExtra = new Map();// cdpKey -> responseReceivedExtraInfo params
    this._ws = new Map();             // cdpKey -> { id, url, frameSeq } (open WebSocket)
    this._seq = 0;
  }

  get(id) { const r = this._store.get(id); return r ? r : undefined; }
  list() { return [...this._store.values()]; }

  // sessionId distinguishes flattened child sessions (OOPIF / worker) that share
  // one connection but reuse requestId numbering independently.
  _key(targetId, requestId, sessionId) { return `${targetId}:${sessionId || ''}:${requestId}`; }

  onRequestWillBeSent(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    let redirectFromId = null;
    if (p.redirectResponse && this._current.has(cdpKey)) {
      // Finalize the previous hop; do NOT overwrite its evidence.
      const prev = this._store.get(this._current.get(cdpKey));
      if (prev) {
        prev.response = this._buildResponse(p.redirectResponse, prev.response);
        prev.state = 'FINISHED';
        prev.redirected = true;
        redirectFromId = prev.id;
        this.emit('update', prev);
      }
    }
    const hop = redirectFromId ? (this._store.get(redirectFromId).hop + 1) : 0;
    const id = `${cdpKey}#${hop}`;
    const parsed = parseUrl(p.request.url);
    const request = {
      id, targetId, cdpRequestId: String(p.requestId), cdpSessionId: sessionId || null, hop,
      loaderId: p.loaderId || null, frameId: p.frameId || null, documentURL: p.documentURL || null,
      startedAt: new Date().toISOString(), timestamp: p.timestamp, wallTime: p.wallTime,
      startMonotonic: p.timestamp,
      method: p.request.method, url: p.request.url, ...parsed,
      headers: { ...(p.request.headers || {}) }, cookies: [],
      body: p.request.postData != null ? { raw: p.request.postData, hasBody: true, contentType: (p.request.headers && (p.request.headers['Content-Type'] || p.request.headers['content-type'])) || null, size: Buffer.byteLength(p.request.postData) } : { hasBody: Boolean(p.request.hasPostData), raw: null },
      resourceType: String(p.type || 'Other'), initiator: p.initiator || null,
      redirectFromId, response: null, failure: null, state: 'REQUEST_SENT',
      seq: this._seq++,
    };
    this._store.set(id, request);
    this._current.set(cdpKey, id);
    const pendingExtra = this._pendingReqExtra.get(cdpKey);
    if (pendingExtra) { this._mergeRequestExtra(request, pendingExtra); this._pendingReqExtra.delete(cdpKey); }
    this.emit('request', request);
  }

  onRequestWillBeSentExtraInfo(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const id = this._current.get(cdpKey);
    const req = id && this._store.get(id);
    if (req && !req.response) { this._mergeRequestExtra(req, p); this.emit('update', req); }
    else this._pendingReqExtra.set(cdpKey, p); // arrived before main (or after response); hold it
  }

  _mergeRequestExtra(req, extra) {
    // Network-level headers are more authoritative; keep the union.
    req.headers = { ...req.headers, ...(extra.headers || {}) };
    const cookies = requestCookies(extra);
    if (cookies.length) req.cookies = cookies;
    if (extra.connectTiming) req.connectTiming = extra.connectTiming;
  }

  onResponseReceived(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const id = this._current.get(cdpKey);
    const req = id && this._store.get(id);
    if (!req) return;
    req.response = this._buildResponse(p.response, req.response);
    req.state = 'RESPONSE_RECEIVED';
    const pendingExtra = this._pendingRespExtra.get(cdpKey);
    if (pendingExtra) { this._mergeResponseExtra(req.response, pendingExtra); this._pendingRespExtra.delete(cdpKey); }
    this.emit('response', req);
  }

  onResponseReceivedExtraInfo(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const id = this._current.get(cdpKey);
    const req = id && this._store.get(id);
    if (req && req.response) { this._mergeResponseExtra(req.response, p); this.emit('update', req); }
    else this._pendingRespExtra.set(cdpKey, p);
  }

  _buildResponse(r, existing) {
    const headers = { ...(existing && existing.headers), ...(r.headers || {}) };
    return {
      status: r.status, statusText: r.statusText || '',
      headers, setCookies: [],
      mimeType: r.mimeType || null, protocol: r.protocol || null,
      remoteIP: r.remoteIPAddress || null, remotePort: r.remotePort || null,
      connectionReused: r.connectionReused, connectionId: r.connectionId,
      fromDiskCache: Boolean(r.fromDiskCache), fromServiceWorker: Boolean(r.fromServiceWorker), fromPrefetchCache: Boolean(r.fromPrefetchCache),
      encodedSize: r.encodedDataLength != null ? r.encodedDataLength : (existing && existing.encodedSize) || null,
      securityState: r.securityState || null, timing: r.timing || (existing && existing.timing) || null,
      body: (existing && existing.body) || { state: 'PENDING' },
    };
  }

  _mergeResponseExtra(resp, extra) {
    resp.headers = { ...resp.headers, ...(extra.headers || {}) };
    if (extra.resourceIPAddressSpace) resp.ipAddressSpace = extra.resourceIPAddressSpace;
    if (Array.isArray(extra.blockedCookies) && extra.blockedCookies.length) resp.blockedCookies = extra.blockedCookies;
    const setCookie = resp.headers['set-cookie'] || resp.headers['Set-Cookie'];
    if (setCookie) resp.setCookies = String(setCookie).split('\n').map(s => s.trim()).filter(Boolean);
  }

  onLoadingFinished(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const id = this._current.get(cdpKey);
    const req = id && this._store.get(id);
    if (!req) return;
    req.finishedAt = p.timestamp;
    req.durationMs = (req.startMonotonic != null && p.timestamp != null) ? Math.max(0, (p.timestamp - req.startMonotonic) * 1000) : null;
    if (req.response) {
      if (p.encodedDataLength != null) req.response.encodedSize = p.encodedDataLength;
      req.response.body = req.response.body && req.response.body.available ? req.response.body : { state: 'AVAILABLE' };
      req.state = 'BODY_AVAILABLE';
    } else {
      req.state = 'FINISHED';
    }
    this._clearKey(cdpKey);
    this.emit('update', req);
  }

  onLoadingFailed(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const id = this._current.get(cdpKey);
    const req = id && this._store.get(id);
    if (!req) return;
    req.finishedAt = p.timestamp;
    req.durationMs = (req.startMonotonic != null && p.timestamp != null) ? Math.max(0, (p.timestamp - req.startMonotonic) * 1000) : null;
    req.failure = { errorText: p.errorText || null, canceled: Boolean(p.canceled), blockedReason: p.blockedReason || null, corsErrorStatus: p.corsErrorStatus || null };
    req.state = 'FAILED';
    if (req.response) req.response.body = { state: 'UNAVAILABLE', reason: 'request failed' };
    this._clearKey(cdpKey);
    this.emit('update', req);
  }

  _clearKey(cdpKey) {
    this._current.delete(cdpKey);
    this._pendingReqExtra.delete(cdpKey);
    this._pendingRespExtra.delete(cdpKey);
  }

  // ---- WebSocket capture ----
  // HTTP capture never sees WS traffic: the bet/action of real-time games is a
  // WebSocket *frame*, not an HTTP request. We surface the connection as one row
  // and every data frame as its own selectable row so the payload is inspectable.
  onWebSocketCreated(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const id = `${cdpKey}#ws`;
    const req = {
      id, targetId, cdpRequestId: String(p.requestId), cdpSessionId: sessionId || null, hop: 0,
      startedAt: new Date().toISOString(),
      method: 'WS', url: p.url, ...parseUrl(p.url),
      headers: {}, cookies: [], body: { hasBody: false, raw: null },
      resourceType: 'WebSocket', initiator: p.initiator || null,
      redirectFromId: null, response: null, failure: null, state: 'REQUEST_SENT',
      isWebSocket: true, seq: this._seq++,
    };
    this._store.set(id, req);
    this._ws.set(cdpKey, { id, url: p.url, frameSeq: 0 });
    this.emit('request', req);
  }

  onWebSocketWillSendHandshakeRequest(targetId, p, sessionId) {
    const conn = this._ws.get(this._key(targetId, p.requestId, sessionId));
    const req = conn && this._store.get(conn.id);
    if (req && p.request && p.request.headers) { req.headers = { ...req.headers, ...p.request.headers }; this.emit('update', req); }
  }

  onWebSocketHandshakeResponseReceived(targetId, p, sessionId) {
    const conn = this._ws.get(this._key(targetId, p.requestId, sessionId));
    const req = conn && this._store.get(conn.id);
    if (!req) return;
    req.response = this._buildResponse(p.response || { status: 101, statusText: 'Switching Protocols' }, req.response);
    req.state = 'RESPONSE_RECEIVED';
    this.emit('response', req);
  }

  onWebSocketClosed(targetId, p, sessionId) {
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const conn = this._ws.get(cdpKey);
    const req = conn && this._store.get(conn.id);
    if (req) { req.state = 'FINISHED'; this.emit('update', req); }
    this._ws.delete(cdpKey);
  }

  onWebSocketFrameSent(targetId, p, sessionId) { this._frame(targetId, p, sessionId, 'send'); }
  onWebSocketFrameReceived(targetId, p, sessionId) { this._frame(targetId, p, sessionId, 'recv'); }

  _frame(targetId, p, sessionId, dir) {
    const r = p.response || {};
    // opcode 1 = text, 2 = binary. Skip control frames (ping/pong/close) as noise.
    if (r.opcode !== 1 && r.opcode !== 2) return;
    const cdpKey = this._key(targetId, p.requestId, sessionId);
    const conn = this._ws.get(cdpKey);
    const url = conn ? conn.url : '';
    const seq = conn ? conn.frameSeq++ : this._seq;
    const id = `${cdpKey}#${dir}${seq}`;
    const raw = r.opcode === 2 ? `[binary ${String(r.payloadData || '').length} bytes]` : String(r.payloadData || '');
    const looksJson = /^[[{]/.test(raw.trim());
    const req = {
      id, targetId, cdpRequestId: String(p.requestId), cdpSessionId: sessionId || null, hop: 0,
      startedAt: new Date().toISOString(), durationMs: 0,
      method: dir === 'send' ? 'WS▶' : 'WS◀', url, ...parseUrl(url),
      headers: {}, cookies: [],
      body: { raw, hasBody: true, contentType: looksJson ? 'application/json' : 'text/plain', size: raw.length },
      resourceType: 'WebSocket', initiator: null, redirectFromId: null,
      response: { status: 101, statusText: dir === 'send' ? 'Frame Sent' : 'Frame Received', headers: {}, setCookies: [], mimeType: null, body: { state: 'UNAVAILABLE', reason: 'websocket frame' } },
      failure: null, state: 'BODY_AVAILABLE', isWebSocket: true, wsDirection: dir, seq: this._seq++,
    };
    this._store.set(id, req);
    this.emit('request', req);
    this.emit('response', req);
  }

  // Lazy, target-bound response body retrieval. MUST use the request's own target
  // client — never a global/selected/other target.
  async getResponseBody(capturedId) {
    const req = this._store.get(capturedId);
    if (!req) return { available: false, error: { code: CODES.REQUEST_NOT_FOUND, message: 'Unknown captured request' } };
    if (!req.response) return { available: false, error: { code: CODES.RESPONSE_NOT_RECEIVED, message: 'No response yet for this request' } };
    if (req.response.body && req.response.body.available) return req.response.body; // cached
    if (req.state === 'FAILED') return { available: false, error: { code: CODES.RESPONSE_BODY_UNAVAILABLE, message: 'Request failed', cause: req.failure } };
    if (req.state !== 'BODY_AVAILABLE') return { available: false, error: { code: CODES.RESPONSE_BODY_NOT_READY, message: `Body not ready (state ${req.state})` } };
    const client = this._resolveClient(req.targetId);
    if (!client) return { available: false, error: { code: CODES.TARGET_CONTEXT_UNAVAILABLE, message: 'The target that produced this request is no longer attached', context: { targetId: req.targetId } } };
    let result;
    try {
      // For flattened child sessions (OOPIF / worker) the body must be fetched on
      // that session; CRI routes the command when a sessionId is passed.
      result = await client.Network.getResponseBody({ requestId: req.cdpRequestId }, req.cdpSessionId || undefined);
    } catch (err) {
      // Common for cache/service-worker/redirect/no-body responses.
      const body = { available: false, error: { code: CODES.RESPONSE_BODY_UNAVAILABLE, message: String(err && err.message || err), cause: { fromDiskCache: req.response.fromDiskCache, fromServiceWorker: req.response.fromServiceWorker } } };
      req.response.body = body;
      return body;
    }
    let text = result.body || '';
    let truncated = false;
    const size = result.base64Encoded ? Math.floor(text.length * 0.75) : Buffer.byteLength(text);
    if (size > this._maxBodyBytes) { truncated = true; text = text.slice(0, this._maxBodyBytes); }
    const body = { available: true, body: text, base64Encoded: Boolean(result.base64Encoded), encoding: result.base64Encoded ? 'base64' : 'utf8', length: size, truncated };
    req.response.body = body;
    return body;
  }
}

module.exports = { CaptureCorrelator, parseUrl, DEFAULT_MAX_BODY_BYTES };
