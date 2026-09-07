'use strict';

const { classifyFrame } = require('../protocol/frame-classify.cjs');
const { RoundAssembler, CAUSE } = require('./round-assembler.cjs');

// ---------------------------------------------------------------------------
// AnalyticsPersistence — the write path. For each browser it owns:
//   - one active CaptureSession row
//   - one RoundAssembler
//   - a localId -> DB round id mapping
//
// Every observed frame is persisted to raw_protocol_events (SOURCE OF TRUTH)
// BEFORE / independently of any renderer consumption, then fed to the assembler
// whose emitted results are written to rounds / samples / metrics. It performs
// NO protocol send (it only reads frames). Writes are synchronous prepared
// statements; finalize is transactional. Per-browser isolation is structural.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 2 * 1024 * 1024; // §28 — conservative default response-body cap
function textLikeMime(mime) { return /^(application\/(json|[^;]*\+json|xml|javascript|x-www-form-urlencoded|graphql)|text\/)/i.test(String(mime || '')); }
function wsKeyOf(ev) { return `${ev.targetId != null ? ev.targetId : ''}:${ev.cdpSessionId != null ? ev.cdpSessionId : ''}:${ev.cdpRequestId != null ? ev.cdpRequestId : ''}`; }
function wallOf(iso, fallback) { const t = Date.parse(iso); return Number.isFinite(t) ? t : fallback; }

class AnalyticsPersistence {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error('AnalyticsPersistence requires a store');
    this._store = store;
    this._now = now;
    this._byBrowser = new Map(); // browserId -> { sessionId, assembler, localToDb, seqBase }
    this._netReqByCaptured = new Map(); // captured HTTP id -> network_request_id (bounded; cleared on finalize)
    this._wsConnByKey = new Map();      // wsKey -> ws_connection_id
  }

  beginSession(browserId, { startedAtMs } = {}) {
    const id = String(browserId);
    let s = this._byBrowser.get(id);
    if (s && s.sessionId != null) return s.sessionId;
    const sessionId = this._store.sessions.start({ browserId: id, startedAtMs });
    s = this._makeAssemblerState(id, sessionId);
    this._byBrowser.set(id, s);
    return sessionId;
  }

  _makeAssemblerState(browserId, sessionId) {
    let seqBase = this._store.rounds.maxSequence(browserId);
    const assembler = new RoundAssembler({
      browserId, captureSessionId: sessionId,
      allocateSequence: () => ++seqBase,
    });
    const localToDb = new Map();
    const rounds = this._store.rounds;
    assembler.on('round-started', (r) => {
      const dbId = rounds.insertRound({ captureSessionId: sessionId, browserId, sid: r.sid, sequenceNumber: r.sequenceNumber, openedAtMs: r.openedAtMs, completeness: 'UNKNOWN' });
      localToDb.set(r.localId, dbId);
    });
    assembler.on('odd-sample', ({ localId, sample }) => {
      const dbId = localToDb.get(localId); if (dbId != null) rounds.insertOddSample({ roundId: dbId, ...sample });
    });
    assembler.on('jackpot-sample', ({ localId, sample }) => {
      const dbId = localToDb.get(localId); if (dbId != null) rounds.insertJackpotSample({ roundId: dbId, ...sample });
    });
    assembler.on('round-updated', (r) => {
      const dbId = localToDb.get(r.localId); if (dbId != null) rounds.updateRound(dbId, r);
    });
    assembler.on('round-finalized', (r) => {
      const dbId = localToDb.get(r.localId); if (dbId != null) rounds.finalize(dbId, r);
    });
    return { sessionId, assembler, localToDb };
  }

  _ensure(browserId) {
    const id = String(browserId);
    let s = this._byBrowser.get(id);
    if (!s) { this.beginSession(id); s = this._byBrowser.get(id); }
    return s;
  }

  // One observed WS frame. direction: 'recv' | 'send'. Persists the RAW WS event
  // (source of truth), derives a raw_protocol_event linked by source_ws_event_id
  // (provenance: round -> protocol event -> raw WS frame), then feeds the assembler.
  onWsFrame(browserId, { direction, raw, at, opcode, targetId, cdpRequestId, cdpSessionId } = {}) {
    const s = this._ensure(browserId);
    const t = at != null ? at : this._now();
    const cls = classifyFrame(raw);
    const dir = direction === 'send' ? 'SEND' : 'RECV';
    const odd = (Number.isFinite(cls.odd) && cls.odd > 0) ? cls.odd : null;
    const jackpot = Number.isFinite(cls.jp) ? cls.jp : null;
    const parseStatus = cls.json == null ? 'UNPARSED' : (cls.known ? 'OK' : 'UNKNOWN_CMD');
    const wsConnectionId = this._wsConnByKey.get(wsKeyOf({ targetId, cdpRequestId, cdpSessionId })) || null;

    // Raw WS evidence layer.
    const wsEventId = this._store.ws.insertEvent({
      wsConnectionId, captureSessionId: s.sessionId, browserId: String(browserId), direction: dir,
      timestampMs: t, monotonicMs: null, opcode: opcode != null ? opcode : null,
      payload: cls.raw, payloadSize: cls.raw != null ? String(cls.raw).length : null, parseStatus,
      cmd: Number.isFinite(cls.cmd) ? cls.cmd : null, eventType: cls.type, sid: cls.sid != null ? cls.sid : null, odd, jackpot,
    });

    // Derived protocol event (with provenance back to the raw WS frame).
    const rawEventId = this._store.raw.append({
      captureSessionId: s.sessionId, browserId: String(browserId), wsConnectionId,
      direction: dir, origin: dir === 'SEND' ? 'WEBSITE' : 'SERVER',
      wallTimestampMs: t, monotonicTimestampMs: null, opcode: opcode != null ? opcode : null,
      rawPayload: cls.raw, parseStatus, parseError: parseStatus === 'UNPARSED' ? 'non-JSON or unparseable frame' : null,
      cmd: Number.isFinite(cls.cmd) ? cls.cmd : null, eventType: cls.type,
      sid: cls.sid != null ? cls.sid : null, odd, jackpot,
      sourceTargetId: targetId, sourceSessionId: cdpSessionId, sourceWsEventId: wsEventId,
    });
    this._store.sessions.touch(s.sessionId, t);

    // Only RECV authoritative frames mutate normalized round state (§10).
    s.assembler.observe({ rawEventId, captureSessionId: s.sessionId, browserId: String(browserId), direction: dir, timestampMs: t, cmd: cls.cmd, type: cls.type, sid: cls.sid != null ? cls.sid : null, odd, jackpot });
    return rawEventId;
  }

  // Backward-compatible alias (WS frame by raw string).
  onFrame(browserId, ev = {}) { return this.onWsFrame(browserId, ev); }

  // ---- WebSocket connection lifecycle ----
  onWsCreated(browserId, req = {}) {
    const s = this._ensure(browserId);
    const connId = this._store.ws.insertConnection({
      captureSessionId: s.sessionId, browserId: String(browserId), targetId: req.targetId,
      requestId: req.cdpRequestId, url: req.url, openedAtMs: wallOf(req.startedAt, this._now()),
    });
    this._wsConnByKey.set(wsKeyOf({ targetId: req.targetId, cdpRequestId: req.cdpRequestId, cdpSessionId: req.cdpSessionId }), connId);
    return connId;
  }
  onWsClosed(browserId, req = {}) {
    const key = wsKeyOf({ targetId: req.targetId, cdpRequestId: req.cdpRequestId, cdpSessionId: req.cdpSessionId });
    const connId = this._wsConnByKey.get(key);
    if (connId != null) { this._store.ws.closeConnection(connId, { closedAtMs: this._now() }); this._wsConnByKey.delete(key); }
  }

  // ---- HTTP network evidence ----
  onHttpRequest(browserId, req = {}) {
    const s = this._ensure(browserId);
    const netId = this._store.network.insertRequest({
      captureSessionId: s.sessionId, browserId: String(browserId), targetId: req.targetId, sessionId: req.cdpSessionId,
      requestId: req.cdpRequestId, loaderId: req.loaderId, timestampMs: wallOf(req.startedAt, this._now()),
      monotonicMs: Number.isFinite(req.startMonotonic) ? req.startMonotonic : null,
      resourceType: req.resourceType, method: req.method, url: req.url, scheme: req.scheme, host: req.host, path: req.path,
      requestHeaders: req.headers || null, requestBody: req.body && req.body.raw ? req.body.raw : null,
      initiatorType: req.initiator && req.initiator.type ? req.initiator.type : null,
      redirectFromRequestId: req.redirectFromId != null ? (this._netReqByCaptured.get(req.redirectFromId) || null) : null,
    });
    this._netReqByCaptured.set(req.id, netId);
    this._store.sessions.touch(s.sessionId, this._now());
    return netId;
  }

  // Finalize an HTTP request: persist the response + apply the body policy. bodyFetcher
  // is an async () => capture.getResponseBody(capturedId) supplied by the runtime (passive).
  async onHttpFinalize(browserId, req = {}, bodyFetcher) {
    const netId = this._netReqByCaptured.get(req.id);
    if (netId == null) return null;
    const resp = req.response || null;
    const failed = req.state === 'FAILED' || (req.failure != null);
    this._store.network.insertResponse({
      networkRequestId: netId, timestampMs: this._now(),
      status: resp ? resp.status : null, statusText: resp ? resp.statusText : null,
      mimeType: resp ? resp.mimeType : null, protocol: resp ? resp.protocol : null,
      responseHeaders: resp ? resp.headers : null, remoteIp: resp ? resp.remoteIP : null, remotePort: resp ? resp.remotePort : null,
      fromDiskCache: resp ? resp.fromDiskCache : false, fromServiceWorker: resp ? resp.fromServiceWorker : false,
      encodedDataLength: resp ? resp.encodedSize : null, timingJson: resp ? resp.timing : null,
      failed, failureReason: req.failure ? req.failure.errorText : null, durationMs: req.durationMs,
    });
    // Body policy (§9/§28).
    const size = resp ? resp.encodedSize : null;
    let bodyRec = { networkRequestId: netId, bodySize: Number.isFinite(size) ? size : null };
    if (failed || !resp) { bodyRec.captureStatus = 'UNAVAILABLE'; bodyRec.captureError = req.failure ? req.failure.errorText : 'no response'; }
    else if (Number.isFinite(size) && size > MAX_BODY_BYTES) { bodyRec.captureStatus = 'SKIPPED_TOO_LARGE'; }
    else if (!textLikeMime(resp.mimeType)) { bodyRec.captureStatus = 'SKIPPED_TYPE'; }
    else if (typeof bodyFetcher === 'function') {
      try {
        const b = await bodyFetcher();
        if (b && b.available) { bodyRec = { networkRequestId: netId, body: b.body, base64Encoded: !!b.base64Encoded, bodySize: b.length != null ? b.length : bodyRec.bodySize, captureStatus: 'CAPTURED' }; }
        else { bodyRec.captureStatus = 'UNAVAILABLE'; bodyRec.captureError = b && b.error ? (b.error.message || b.error.code) : 'unavailable'; }
      } catch (err) { bodyRec.captureStatus = 'FAILED'; bodyRec.captureError = String(err && err.message || err); }
    } else { bodyRec.captureStatus = 'UNAVAILABLE'; }
    this._store.network.insertBody(bodyRec);
    this._netReqByCaptured.delete(req.id);
    return netId;
  }

  // WS disconnect: finalize the open round as partial (no fabricated END) and
  // mark the session DISCONNECTED. A later frame reopens CAPTURING.
  onDisconnect(browserId) {
    const id = String(browserId);
    const s = this._byBrowser.get(id);
    if (!s) return;
    s.assembler.finalizeCurrent(CAUSE.DISCONNECT);
    this._store.sessions.incrementDisconnect(s.sessionId);
    this._store.sessions.setStatus(s.sessionId, 'DISCONNECTED');
  }

  // Explicit stop / browser close (graceful).
  endSession(browserId, status = 'STOPPED') {
    const id = String(browserId);
    const s = this._byBrowser.get(id);
    if (!s) return;
    // A graceful stop is not an authoritative END for the in-flight round.
    s.assembler.finalizeCurrent(status === 'INTERRUPTED' ? CAUSE.INTERRUPT : CAUSE.DISCONNECT);
    this._store.sessions.setStatus(s.sessionId, status, { endedAtMs: this._now() });
    this._byBrowser.delete(id);
  }

  sessionIdFor(browserId) { const s = this._byBrowser.get(String(browserId)); return s ? s.sessionId : null; }
}

module.exports = { AnalyticsPersistence };
