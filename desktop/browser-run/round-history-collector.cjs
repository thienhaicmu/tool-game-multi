'use strict';

// ---------------------------------------------------------------------------
// RoundHistoryCollector — WU-C.2. Turns an AutoRunner's authoritative finalized
// round into a persistent RoundRecord attributed to the OWNING BrowserRun's
// persistent browser. Attribution is structural (browserId + runId from the run
// that produced the evidence) — never from UI selection (§37).
//
// RESULT DERIVATION IS EVIDENCE-ONLY (§4/§5/§6):
//   WIN     = the server ACCEPTED the cashout. In AutoRunner terms that is
//             RESULT.COMPLETED, which is only reached on a correlated server
//             cashout ACK (recv cmd:100003, matching eid, not an error frame).
//   UNKNOWN = anything else. There is NO authoritative per-player loss/settlement
//             frame in the current protocol (cmd:100007 ROUND_END carries only
//             lastOdd), so LOSS is never inferred. UNKNOWN is first-class.
//
// Forbidden heuristics are NOT used: no `wm>0?WIN:LOSS`, no `cashout requested ->
// WIN`, no `odd>=stopOdd -> WIN`, no `roundEnd && !cashout -> LOSS`.
// ---------------------------------------------------------------------------

const RESULT = Object.freeze({ WIN: 'WIN', LOSS: 'LOSS', UNKNOWN: 'UNKNOWN' });

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function iso(ms) { return ms != null ? new Date(ms).toISOString() : null; }

// Highest authoritative server odd for the round: the observer-derived maxOdd
// (recv cmd:100009). Falls back to the strongest authoritative odds actually seen
// (trigger / cashout-ack) — never predicted/interpolated.
function highestOdd(pub) {
  if (isNum(pub.maxOdd)) return pub.maxOdd;
  const candidates = [pub.triggerOdd, pub.ackOdd].filter(isNum);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * deriveRoundRecord — pure. Maps an AutoRunner publicRound to a persisted record.
 * Unknown numeric facts are null (never 0): unknown bet/odd/payout must not read as
 * a certain zero (§14).
 */
function deriveRoundRecord({ browserId, runId, pub, at } = {}) {
  const participated = pub && pub.betResult === 'ACK'; // server-accepted bet == a played round (§24)
  let result, resultEvidence;
  if (pub && pub.result === 'COMPLETED') {
    result = RESULT.WIN;
    resultEvidence = { source: 'CASHOUT_ACK', cmd: 100003, authoritative: true };
  } else {
    result = RESULT.UNKNOWN;
    resultEvidence = { source: 'INSUFFICIENT_SERVER_EVIDENCE', authoritative: false, terminationReason: pub ? pub.result : null };
  }
  return {
    browserId: String(browserId), runId: String(runId), sid: pub ? pub.sid : null,
    startedAt: iso(pub && pub.openedAtMs), endedAt: iso((pub && pub.finishedAtMs) || at) || null,
    requestedBet: pub && pub.amount != null ? pub.amount : null,                 // client-sent b (§15)
    acceptedBet: participated && pub && pub.betAckAmount != null ? pub.betAckAmount : null, // server-echoed b (§15)
    stopOdd: pub && pub.stopOdd != null ? pub.stopOdd : null,
    triggerOdd: pub && pub.triggerOdd != null ? pub.triggerOdd : null,           // authoritative recv odd at threshold
    cashoutAckOdd: pub && pub.ackOdd != null ? pub.ackOdd : null,                // server cashout-ack odd (recv 100003)
    highestObservedOdd: pub ? highestOdd(pub) : null,                            // recv 100009 telemetry (§17/§30)
    payout: null,                                                                // wm meaning unproven -> never a payout (§28)
    wmRaw: pub && pub.wm != null ? pub.wm : null,                                // compact raw evidence, uninterpreted (§42)
    result, resultEvidence,
    participated: !!participated,
    terminationReason: pub ? (pub.result || null) : null,                        // AutoRunner RESULT constant, kept separate from result (§22)
  };
}

class RoundHistoryCollector {
  constructor(deps = {}) {
    this._store = deps.store;
    this._browserId = deps.browserId;
    this._runId = deps.runId;
    this._onPersisted = deps.onPersisted || (() => {});
    this._now = deps.now || (() => Date.now());
    if (deps.autoRunner && deps.autoRunner.on) deps.autoRunner.on('roundFinalized', (pub) => this.record(pub));
  }

  record(pub) {
    try {
      const rec = deriveRoundRecord({ browserId: this._browserId, runId: this._runId, pub, at: this._now() });
      const res = this._store.upsert(rec);
      if (!res.error) this._onPersisted(this._browserId, res.record);
      return res;
    } catch (e) { return { error: { code: 'BROWSER_HISTORY_COLLECT_FAILED', message: String(e && e.message || e) } }; }
  }
}

module.exports = { RoundHistoryCollector, deriveRoundRecord, highestOdd, RESULT };
