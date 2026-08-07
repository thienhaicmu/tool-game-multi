'use strict';

const { requestDiff, responseDiff } = require('./replay/diff.cjs');
const { CODES } = require('./cdp/errors.cjs');

function headersObj(h) { return h && typeof h === 'object' ? { ...h } : {}; }
function reqShape(cap) { return { method: cap.method, url: cap.url, headers: headersObj(cap.headers), cookies: cap.cookies, body: cap.body && cap.body.raw != null ? cap.body.raw : null }; }
function respShapeFromCaptured(cap) {
  if (!cap.response) return null;
  const body = cap.response.body && cap.response.body.available ? cap.response.body.body : null;
  return { status: cap.response.status, statusText: cap.response.statusText, headers: headersObj(cap.response.headers), body, duration: cap.durationMs ?? null };
}
function reqShapeFromIntercept(side) { return { method: side.method, url: side.url, headers: headersObj(side.headers), body: side.body ?? null }; }

/**
 * Timeline aggregates ALL evidence for one CapturedRequest — the original
 * capture, every ReplayExecution, and every InterceptedRequest that belongs to
 * it (linked by networkId+target) — in chronological order, with diffs computed
 * against the original. It never mutates any evidence; it only presents it.
 */
class Timeline {
  constructor(deps = {}) {
    this._capture = deps.capture;
    this._replay = deps.replay;
    this._intercept = deps.intercept;
  }

  build(capturedRequestId) {
    const cap = this._capture.get(capturedRequestId);
    if (!cap) return { error: { code: CODES.REQUEST_NOT_FOUND, message: 'Unknown captured request' } };
    const origReq = reqShape(cap);
    const origResp = respShapeFromCaptured(cap);
    const events = [];

    events.push({
      kind: 'capture', id: cap.id, time: cap.startedAt, target: cap.targetId,
      method: cap.method, url: cap.url, status: cap.response ? cap.response.status : null,
      state: cap.state, summary: 'Original capture', isOriginal: true,
    });

    const hist = this._replay.history(capturedRequestId);
    for (const ex of hist.executions) {
      const sent = ex.request || null;
      events.push({
        kind: 'replay', id: ex.id, time: ex.startedAt, target: cap.targetId, mode: ex.mode,
        method: sent ? sent.method : cap.method, url: sent ? sent.url : cap.url,
        status: ex.response ? ex.response.status : null, state: ex.status,
        error: ex.error || null, warnings: (ex.response && ex.response.warnings) || ex.warnings || [],
        requestDiff: sent ? requestDiff(origReq, sent) : null,
        responseDiff: ex.response ? responseDiff(origResp, ex.response) : null,
        summary: `Replay #${ex.seq + 1} (${ex.mode})`,
      });
    }

    const intercepts = (this._intercept && this._intercept.listAll ? this._intercept.listAll() : [])
      .filter((r) => r.targetId === cap.targetId && r.networkRequestId === cap.cdpRequestId);
    for (const ir of intercepts) {
      events.push({
        kind: 'intercept', id: ir.id, time: ir.pausedAt, target: ir.targetId,
        method: ir.draft.method, url: ir.draft.url, status: null, state: ir.state,
        error: ir.error || null, warnings: ir.warnings || [],
        requestDiff: requestDiff(reqShapeFromIntercept(ir.original), reqShapeFromIntercept(ir.draft)),
        summary: `Intercept (${ir.state})`,
      });
    }

    events.sort((a, b) => new Date(a.time) - new Date(b.time) || seqRank(a) - seqRank(b));

    const withStatus = events.filter((e) => e.status != null);
    const actions = events.filter((e) => e.kind !== 'capture');
    return {
      capturedRequestId,
      summary: {
        captured: 1,
        replayed: hist.executions.length,
        intercepted: intercepts.length,
        lastStatus: withStatus.length ? withStatus[withStatus.length - 1].status : null,
        // Error only if the MOST RECENT action still ended in error (so a
        // fail -> retry -> success progression clears the summary error).
        lastError: actions.length ? (actions[actions.length - 1].error || null) : null,
      },
      events,
    };
  }
}

function seqRank(e) { return e.kind === 'capture' ? 0 : 1; } // capture first on time ties

module.exports = { Timeline };
