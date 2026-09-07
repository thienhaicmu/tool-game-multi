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

class AnalyticsPersistence {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error('AnalyticsPersistence requires a store');
    this._store = store;
    this._now = now;
    this._byBrowser = new Map(); // browserId -> { sessionId, assembler, localToDb, seqBase }
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

  // One observed WS frame. direction: 'recv' | 'send'.
  onFrame(browserId, { direction, raw, at, wsConnectionId, targetId } = {}) {
    const s = this._ensure(browserId);
    const t = at != null ? at : this._now();
    const cls = classifyFrame(raw);
    const dir = direction === 'send' ? 'SEND' : 'RECV';
    const odd = (Number.isFinite(cls.odd) && cls.odd > 0) ? cls.odd : null;
    const jackpot = Number.isFinite(cls.jp) ? cls.jp : null;
    const parseStatus = cls.json == null ? 'UNPARSED' : (cls.known ? 'OK' : 'UNKNOWN_CMD');

    const rawEventId = this._store.raw.append({
      captureSessionId: s.sessionId, browserId: String(browserId), wsConnectionId,
      direction: dir, origin: dir === 'SEND' ? 'WEBSITE' : 'SERVER',
      wallTimestampMs: t, monotonicTimestampMs: null, opcode: null,
      rawPayload: cls.raw, parseStatus, parseError: parseStatus === 'UNPARSED' ? 'non-JSON or unparseable frame' : null,
      cmd: Number.isFinite(cls.cmd) ? cls.cmd : null, eventType: cls.type,
      sid: cls.sid != null ? cls.sid : null, odd, jackpot,
      sourceTargetId: targetId, sourceSessionId: null,
    });
    this._store.sessions.touch(s.sessionId, t);

    // Only RECV authoritative frames mutate normalized round state (§10).
    s.assembler.observe({ rawEventId, captureSessionId: s.sessionId, browserId: String(browserId), direction: dir, timestampMs: t, cmd: cls.cmd, type: cls.type, sid: cls.sid != null ? cls.sid : null, odd, jackpot });
    return rawEventId;
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
