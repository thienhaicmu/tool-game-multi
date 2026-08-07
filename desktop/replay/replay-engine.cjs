'use strict';

const EventEmitter = require('node:events');
const { randomUUID } = require('node:crypto');
const { CODES } = require('../cdp/errors.cjs');

const MODES = Object.freeze({ WEBVIEW_CONTEXT: 'WEBVIEW_CONTEXT', HTTP_DIRECT: 'HTTP_DIRECT' });
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Headers the browser controls; a WebView-context fetch() cannot set them, so we
// surface a warning instead of pretending they were sent. (Forbidden header names
// per Fetch spec, plus the ones the network stack always manages.)
const BROWSER_CONTROLLED = new Set([
  'host', 'origin', 'referer', 'connection', 'content-length', 'cookie',
  'date', 'expect', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'via', 'user-agent', 'accept-encoding', 'accept-charset',
]);
// Hop-by-hop headers we strip on HTTP_DIRECT (the client recomputes them).
const HOP_BY_HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);

function headersToObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) { const o = {}; for (const [k, v] of headers) o[k] = v; return o; }
  return { ...headers };
}

/**
 * ReplayEngine builds replay from the immutable WU2 CapturedRequest.
 *
 *   CapturedRequest (immutable) --duplicate--> ReplayDraft (mutable overlay)
 *                                --execute-----> ReplayExecution (append-only)
 *                                --------------> ReplayResult (uniform per mode)
 *
 * Dependencies are injected so the engine is testable without Electron:
 *   getCaptured(id)      -> CapturedRequest | undefined   (the WU2 correlator)
 *   resolveClient(tid)   -> CDP client | null             (target's OWN client)
 *   httpFetch(url, opts) -> { status, statusText, headers, body, base64Encoded? }
 */
class ReplayEngine extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._getCaptured = deps.getCaptured || (() => undefined);
    this._resolveClient = deps.resolveClient || (() => null);
    this._httpFetch = deps.httpFetch || null;
    this._timeoutMs = Number(deps.timeoutMs || 30000);
    this._drafts = new Map();       // draftId -> draft
    this._executions = new Map();   // executionId -> execution
    this._byCaptured = new Map();   // capturedRequestId -> { drafts:Set, executions:Set }
  }

  _index(capturedRequestId) {
    let e = this._byCaptured.get(capturedRequestId);
    if (!e) { e = { drafts: new Set(), executions: new Set() }; this._byCaptured.set(capturedRequestId, e); }
    return e;
  }

  // Duplicate a CapturedRequest into an editable draft. Captured stays untouched.
  createDraft(capturedRequestId, options = {}) {
    const captured = this._getCaptured(capturedRequestId);
    if (!captured) return { error: { code: CODES.REQUEST_NOT_FOUND, message: 'Unknown captured request' } };
    const now = new Date().toISOString();
    const draft = {
      id: 'draft_' + randomUUID(),
      capturedRequestId,
      targetId: captured.targetId,
      mode: options.mode && MODES[options.mode] ? options.mode : MODES.WEBVIEW_CONTEXT,
      method: captured.method,
      url: captured.url,
      headers: headersToObject(captured.headers),
      cookies: Array.isArray(captured.cookies) ? captured.cookies.map(c => ({ name: c.name, value: c.value })) : [],
      body: captured.body && captured.body.raw != null
        ? { mode: 'raw', raw: String(captured.body.raw), contentType: captured.body.contentType || null }
        : { mode: 'raw', raw: '', contentType: captured.body && captured.body.contentType || null },
      createdAt: now, updatedAt: now,
    };
    this._drafts.set(draft.id, draft);
    this._index(capturedRequestId).drafts.add(draft.id);
    this.emit('draft-created', draft);
    return draft;
  }

  getDraft(draftId) { return this._drafts.get(draftId); }

  updateDraft(draftId, patch = {}) {
    const draft = this._drafts.get(draftId);
    if (!draft) return { error: { code: CODES.INVALID_DRAFT, message: 'Unknown draft' } };
    if (patch.method !== undefined) {
      const m = String(patch.method).toUpperCase();
      if (!METHODS.has(m)) return { error: { code: CODES.INVALID_DRAFT, message: `Method not allowed: ${m}` } };
      draft.method = m;
    }
    if (patch.url !== undefined) {
      try { new URL(String(patch.url)); } catch { return { error: { code: CODES.INVALID_DRAFT, message: 'Invalid URL' } }; }
      draft.url = String(patch.url);
    }
    if (patch.mode !== undefined) {
      if (!MODES[patch.mode]) return { error: { code: CODES.INVALID_DRAFT, message: 'Invalid mode' } };
      draft.mode = patch.mode;
    }
    if (patch.headers !== undefined) {
      if (patch.headers === null || typeof patch.headers !== 'object' || Array.isArray(patch.headers)) return { error: { code: CODES.INVALID_HEADER, message: 'Headers must be an object' } };
      for (const [k, v] of Object.entries(patch.headers)) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) return { error: { code: CODES.INVALID_HEADER, message: `Invalid header name: ${k}` } };
        if (/[\r\n]/.test(String(v))) return { error: { code: CODES.INVALID_HEADER, message: `Invalid header value for ${k}` } };
      }
      draft.headers = { ...patch.headers };
    }
    if (patch.cookies !== undefined) {
      if (!Array.isArray(patch.cookies)) return { error: { code: CODES.INVALID_DRAFT, message: 'cookies must be an array' } };
      draft.cookies = patch.cookies.map(c => ({ name: String(c.name), value: String(c.value) }));
    }
    if (patch.body !== undefined) {
      if (patch.body === null) draft.body = { mode: 'raw', raw: '', contentType: null };
      else if (typeof patch.body === 'string') draft.body = { ...draft.body, mode: 'raw', raw: patch.body };
      else if (typeof patch.body === 'object') draft.body = { mode: patch.body.mode || 'raw', raw: String(patch.body.raw ?? ''), contentType: patch.body.contentType ?? draft.body.contentType };
      else return { error: { code: CODES.INVALID_BODY, message: 'Invalid body' } };
    }
    draft.updatedAt = new Date().toISOString();
    this.emit('draft-updated', draft);
    return draft;
  }

  history(capturedRequestId) {
    const e = this._byCaptured.get(capturedRequestId);
    if (!e) return { drafts: [], executions: [] };
    return {
      drafts: [...e.drafts].map(id => this._drafts.get(id)).filter(Boolean),
      executions: [...e.executions].map(id => this._executions.get(id)).filter(Boolean)
        .sort((a, b) => a.seq - b.seq),
    };
  }

  // Build the concrete request the engine will send, applying per-mode header
  // policy and collecting warnings (nothing is silently dropped).
  _build(draft) {
    const method = draft.method;
    const hasBody = !['GET', 'HEAD'].includes(method) && draft.body && draft.body.raw !== '';
    const warnings = [];
    const outHeaders = {};
    for (const [k, v] of Object.entries(draft.headers || {})) {
      const lk = k.toLowerCase();
      if (draft.mode === MODES.WEBVIEW_CONTEXT && BROWSER_CONTROLLED.has(lk)) {
        warnings.push({ header: k, policy: 'ignored', reason: 'browser-controlled in WebView context' });
        continue;
      }
      if (draft.mode === MODES.HTTP_DIRECT && HOP_BY_HOP.has(lk)) {
        warnings.push({ header: k, policy: 'recalculated', reason: 'hop-by-hop header set by HTTP client' });
        continue;
      }
      outHeaders[k] = String(v);
    }
    if (draft.mode === MODES.WEBVIEW_CONTEXT && draft.cookies && draft.cookies.length) {
      warnings.push({ policy: 'cookies', reason: 'WebView cookie jar applies; draft cookie overrides are not injected in WebView mode' });
    }
    return { method, url: draft.url, headers: outHeaders, body: hasBody ? draft.body.raw : undefined, warnings };
  }

  async execute(draftId) {
    const draft = this._drafts.get(draftId);
    if (!draft) return { error: { code: CODES.INVALID_DRAFT, message: 'Unknown draft' } };
    const built = this._build(draft);
    const execution = {
      id: 'exec_' + randomUUID(), draftId, capturedRequestId: draft.capturedRequestId,
      mode: draft.mode, startedAt: new Date().toISOString(), finishedAt: null,
      status: 'SENDING', error: null, response: null, warnings: built.warnings,
      seq: this._executions.size,
    };
    this._executions.set(execution.id, execution);
    this._index(draft.capturedRequestId).executions.add(execution.id);
    this.emit('execution-started', execution);

    let result;
    try {
      result = draft.mode === MODES.HTTP_DIRECT ? await this._runHttp(built) : await this._runWebView(draft, built);
    } catch (err) {
      result = { error: { code: CODES.REPLAY_FAILED, message: String(err && err.message || err) } };
    }
    execution.finishedAt = new Date().toISOString();
    if (result.error) { execution.status = 'FAILED'; execution.error = result.error; }
    else { execution.status = 'COMPLETED'; execution.response = { ...result, mode: draft.mode, warnings: built.warnings }; }
    this.emit('execution-finished', execution);
    return execution;
  }

  async _runWebView(draft, built) {
    const client = this._resolveClient(draft.targetId);
    if (!client || !client.Runtime || typeof client.Runtime.evaluate !== 'function') {
      return { error: { code: CODES.TARGET_CONTEXT_UNAVAILABLE, message: 'The target that produced this request is no longer attached', context: { targetId: draft.targetId } } };
    }
    const opts = { method: built.method, headers: built.headers, credentials: 'include' };
    if (built.body !== undefined) opts.body = built.body;
    const expr = `(async()=>{const t0=performance.now();try{const r=await fetch(${JSON.stringify(built.url)},${JSON.stringify(opts)});const h={};r.headers.forEach((v,k)=>h[k]=v);const b=await r.text();return{ok:true,status:r.status,statusText:r.statusText,headers:h,body:b.slice(0,200000),duration:Math.round(performance.now()-t0)};}catch(e){return{ok:false,error:String(e&&e.message||e)};}})()`;
    let evalRes;
    try {
      evalRes = await Promise.race([
        client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), this._timeoutMs)),
      ]);
    } catch (err) {
      if (String(err.message) === 'timeout') return { error: { code: CODES.REPLAY_TIMEOUT, message: 'WebView replay timed out' } };
      return { error: { code: CODES.TARGET_CONTEXT_UNAVAILABLE, message: String(err && err.message || err) } };
    }
    const value = evalRes && evalRes.result && evalRes.result.value;
    if (!value) return { error: { code: CODES.REPLAY_FAILED, message: 'No result returned by the WebView' } };
    if (!value.ok) return { error: { code: CODES.REPLAY_BLOCKED_BY_BROWSER, message: value.error || 'fetch failed (CORS/CSP or network)' } };
    return { status: value.status, statusText: value.statusText, headers: value.headers || {}, body: value.body, duration: value.duration };
  }

  async _runHttp(built) {
    if (!this._httpFetch) return { error: { code: CODES.HTTP_REPLAY_FAILED, message: 'No HTTP client configured' } };
    const t0 = Date.now();
    try {
      const r = await Promise.race([
        this._httpFetch(built.url, { method: built.method, headers: built.headers, body: built.body }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), this._timeoutMs)),
      ]);
      return { status: r.status, statusText: r.statusText || '', headers: headersToObject(r.headers), body: r.body != null ? String(r.body).slice(0, 200000) : '', base64Encoded: Boolean(r.base64Encoded), duration: Date.now() - t0 };
    } catch (err) {
      if (String(err.message) === 'timeout') return { error: { code: CODES.REPLAY_TIMEOUT, message: 'HTTP replay timed out' } };
      return { error: { code: CODES.HTTP_REPLAY_FAILED, message: String(err && err.message || err) } };
    }
  }
}

module.exports = { ReplayEngine, MODES, BROWSER_CONTROLLED, HOP_BY_HOP };
