'use strict';

// network_requests / network_responses / network_bodies persistence. Append-oriented
// passive evidence — no replay/action metadata. Bodies follow a size/type policy.

class NetworkRepo {
  constructor(db, now = () => Date.now()) {
    this._db = db; this._now = now;
    this._insReq = db.prepare(
      `INSERT INTO network_requests
        (capture_session_id, browser_id, target_id, session_id, request_id, loader_id,
         timestamp_ms, monotonic_ms, resource_type, method, url, scheme, host, path,
         request_headers, request_body, initiator_type, redirect_from_request_id, created_at_ms)
       VALUES
        (@captureSessionId, @browserId, @targetId, @sessionId, @requestId, @loaderId,
         @timestampMs, @monotonicMs, @resourceType, @method, @url, @scheme, @host, @path,
         @requestHeaders, @requestBody, @initiatorType, @redirectFromRequestId, @createdAtMs)`);
    this._insResp = db.prepare(
      `INSERT INTO network_responses
        (network_request_id, timestamp_ms, status, status_text, mime_type, protocol, response_headers,
         remote_ip, remote_port, from_disk_cache, from_service_worker, encoded_data_length, timing_json,
         failed, failure_reason, duration_ms, created_at_ms)
       VALUES
        (@networkRequestId, @timestampMs, @status, @statusText, @mimeType, @protocol, @responseHeaders,
         @remoteIp, @remotePort, @fromDiskCache, @fromServiceWorker, @encodedDataLength, @timingJson,
         @failed, @failureReason, @durationMs, @createdAtMs)`);
    this._insBody = db.prepare(
      `INSERT INTO network_bodies (network_request_id, body, base64_encoded, body_size, capture_status, capture_error, created_at_ms)
       VALUES (@networkRequestId, @body, @base64Encoded, @bodySize, @captureStatus, @captureError, @createdAtMs)`);
  }

  insertRequest(e) {
    const info = this._insReq.run({
      captureSessionId: Number(e.captureSessionId), browserId: String(e.browserId),
      targetId: e.targetId != null ? String(e.targetId) : null, sessionId: e.sessionId != null ? String(e.sessionId) : null,
      requestId: e.requestId != null ? String(e.requestId) : null, loaderId: e.loaderId != null ? String(e.loaderId) : null,
      timestampMs: Number(e.timestampMs != null ? e.timestampMs : this._now()),
      monotonicMs: Number.isFinite(e.monotonicMs) ? e.monotonicMs : null,
      resourceType: e.resourceType != null ? String(e.resourceType) : null,
      method: e.method != null ? String(e.method) : null, url: e.url != null ? String(e.url) : null,
      scheme: e.scheme != null ? String(e.scheme) : null, host: e.host != null ? String(e.host) : null, path: e.path != null ? String(e.path) : null,
      requestHeaders: e.requestHeaders != null ? JSON.stringify(e.requestHeaders) : null,
      requestBody: e.requestBody != null ? String(e.requestBody) : null,
      initiatorType: e.initiatorType != null ? String(e.initiatorType) : null,
      redirectFromRequestId: e.redirectFromRequestId != null ? Number(e.redirectFromRequestId) : null,
      createdAtMs: this._now(),
    });
    return Number(info.lastInsertRowid);
  }

  insertResponse(e) {
    const info = this._insResp.run({
      networkRequestId: Number(e.networkRequestId), timestampMs: e.timestampMs != null ? Number(e.timestampMs) : null,
      status: Number.isFinite(e.status) ? e.status : null, statusText: e.statusText != null ? String(e.statusText) : null,
      mimeType: e.mimeType != null ? String(e.mimeType) : null, protocol: e.protocol != null ? String(e.protocol) : null,
      responseHeaders: e.responseHeaders != null ? JSON.stringify(e.responseHeaders) : null,
      remoteIp: e.remoteIp != null ? String(e.remoteIp) : null, remotePort: Number.isFinite(e.remotePort) ? e.remotePort : null,
      fromDiskCache: e.fromDiskCache ? 1 : 0, fromServiceWorker: e.fromServiceWorker ? 1 : 0,
      encodedDataLength: Number.isFinite(e.encodedDataLength) ? e.encodedDataLength : null,
      timingJson: e.timingJson != null ? JSON.stringify(e.timingJson) : null,
      failed: e.failed ? 1 : 0, failureReason: e.failureReason != null ? String(e.failureReason) : null,
      durationMs: Number.isFinite(e.durationMs) ? Math.round(e.durationMs) : null, createdAtMs: this._now(),
    });
    return Number(info.lastInsertRowid);
  }

  insertBody(e) {
    this._insBody.run({
      networkRequestId: Number(e.networkRequestId), body: e.body != null ? String(e.body) : null,
      base64Encoded: e.base64Encoded ? 1 : 0, bodySize: Number.isFinite(e.bodySize) ? e.bodySize : null,
      captureStatus: String(e.captureStatus || 'UNAVAILABLE'), captureError: e.captureError != null ? String(e.captureError) : null,
      createdAtMs: this._now(),
    });
  }

  count() { return this._db.prepare('SELECT COUNT(*) AS n FROM network_requests').get().n; }
  responseCount() { return this._db.prepare('SELECT COUNT(*) AS n FROM network_responses').get().n; }
  bodyCount() { return this._db.prepare('SELECT COUNT(*) AS n FROM network_bodies').get().n; }
  bodyBytes() { return this._db.prepare('SELECT COALESCE(SUM(body_size),0) AS n FROM network_bodies WHERE capture_status = ?').get('CAPTURED').n; }
}

module.exports = { NetworkRepo };
