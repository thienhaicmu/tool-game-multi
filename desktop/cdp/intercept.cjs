'use strict';

const EventEmitter = require('node:events');
const { randomUUID } = require('node:crypto');
const { CODES } = require('./errors.cjs');

const STATES = Object.freeze({
  PAUSED: 'PAUSED', CONTINUED: 'CONTINUED', MODIFIED_AND_CONTINUED: 'MODIFIED_AND_CONTINUED',
  ABORTED: 'ABORTED', TIMED_OUT: 'TIMED_OUT', FAILED: 'FAILED',
});
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function urlHost(u) { try { return new URL(u).host; } catch { return ''; } }

// Coarse Fetch.enable patterns from a rule. Only request-stage, and by default
// only XHR/Fetch so images/fonts/media are never paused.
function buildPatterns(rule = {}) {
  const types = rule.resourceType ? [rule.resourceType] : ['XHR', 'Fetch'];
  return types.map((rt) => ({ urlPattern: '*', resourceType: rt, requestStage: 'Request' }));
}

function ruleMatches(rule, req) {
  if (!rule) return true;
  if (rule.method && String(rule.method).toUpperCase() !== String(req.method).toUpperCase()) return false;
  if (rule.host && urlHost(req.url) !== rule.host) return false;
  if (rule.urlContains && !String(req.url).includes(rule.urlContains)) return false;
  if (rule.resourceType && req.resourceType && String(rule.resourceType).toLowerCase() !== String(req.resourceType).toLowerCase()) return false;
  return true;
}

/**
 * InterceptEngine implements request-stage live interception via the CDP Fetch
 * domain. It is target-bound: enable/continue/abort always go through the
 * request's OWN target client (resolveClient(targetId)), never a global or
 * selected target. Response-stage interception is intentionally NOT implemented.
 *
 * Transport wiring (done by caller):
 *   - subscribe client.Fetch.requestPaused -> engine.onRequestPaused(targetId, params)
 *   - on target detach -> engine.onTargetDetached(targetId)
 *
 * Events: 'paused'(rec), 'resolved'(rec), 'changed'().
 */
class InterceptEngine extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._resolveClient = deps.resolveClient || (() => null);
    this._timeoutMs = Number(deps.timeoutMs || 30000);
    this._active = new Map();   // targetId -> rule
    this._paused = new Map();   // interceptId -> record
    this._byFetchId = new Map();// `${targetId}:${fetchRequestId}` -> interceptId
  }

  isActive(targetId) { return this._active.has(targetId); }
  listPaused() { return [...this._paused.values()].filter((r) => r.state === STATES.PAUSED).map(publicRec); }
  listAll() { return [...this._paused.values()].map(publicRec); } // includes resolved records (WU5 history)
  getPaused(id) { const r = this._paused.get(id); return r ? publicRec(r) : undefined; }

  async enable(targetId, rule = {}) {
    const client = this._resolveClient(targetId);
    if (!client || !client.Fetch) return { error: { code: CODES.TARGET_CONTEXT_UNAVAILABLE, message: 'Target not attached', context: { targetId } } };
    try { await client.Fetch.enable({ patterns: buildPatterns(rule) }); }
    catch (err) { return { error: { code: CODES.INTERCEPT_CONTINUE_FAILED, message: 'Fetch.enable failed: ' + String(err && err.message || err) } }; }
    this._active.set(targetId, { ...rule });
    this.emit('changed');
    return { ok: true, targetId, rule };
  }

  async disable(targetId) {
    this._active.delete(targetId);
    // Release anything still paused on this target so the app is never left frozen.
    for (const rec of [...this._paused.values()]) {
      if (rec.targetId === targetId && rec.state === STATES.PAUSED) await this._release(rec, STATES.CONTINUED);
    }
    const client = this._resolveClient(targetId);
    if (client && client.Fetch) { try { await client.Fetch.disable(); } catch { /* target may be gone */ } }
    this.emit('changed');
    return { ok: true };
  }

  // Called for every paused request on a target's client.
  onRequestPaused(targetId, params) {
    const req = { url: params.request.url, method: params.request.method, headers: { ...(params.request.headers || {}) }, postData: params.request.postData ?? null, resourceType: params.resourceType };
    const rule = this._active.get(targetId);
    // Not intercepting this target, or does not match the rule -> continue immediately.
    if (!rule || !ruleMatches(rule, req)) { this._continueRaw(targetId, params.requestId).catch(() => {}); return null; }

    const id = 'intc_' + randomUUID();
    const rec = {
      id, targetId, fetchRequestId: params.requestId, networkRequestId: params.networkId || null,
      resourceType: params.resourceType, frameId: params.frameId || null,
      pausedAt: new Date().toISOString(), state: STATES.PAUSED,
      original: { method: req.method, url: req.url, headers: { ...req.headers }, body: req.postData },
      draft: { method: req.method, url: req.url, headers: { ...req.headers }, body: req.postData },
      timer: null,
    };
    rec.timer = setTimeout(() => { this._onTimeout(id).catch(() => {}); }, this._timeoutMs);
    if (rec.timer.unref) rec.timer.unref();
    this._paused.set(id, rec);
    this._byFetchId.set(`${targetId}:${params.requestId}`, id);
    this.emit('paused', publicRec(rec));
    this.emit('changed');
    return publicRec(rec);
  }

  updateDraft(id, patch = {}) {
    const rec = this._paused.get(id);
    if (!rec) return { error: { code: CODES.INTERCEPT_NOT_FOUND, message: 'Unknown intercepted request' } };
    if (rec.state !== STATES.PAUSED) return { error: { code: CODES.INTERCEPT_ALREADY_RESOLVED, message: 'Request already ' + rec.state } };
    if (patch.method !== undefined) rec.draft.method = String(patch.method).toUpperCase();
    if (patch.url !== undefined) { try { new URL(String(patch.url)); } catch { return { error: { code: CODES.INVALID_INTERCEPT_DRAFT, message: 'Invalid URL' } }; } rec.draft.url = String(patch.url); }
    if (patch.headers !== undefined) {
      if (patch.headers === null || typeof patch.headers !== 'object' || Array.isArray(patch.headers)) return { error: { code: CODES.INVALID_INTERCEPT_DRAFT, message: 'headers must be an object' } };
      for (const [k, v] of Object.entries(patch.headers)) {
        if (!HEADER_NAME.test(k)) return { error: { code: CODES.INVALID_INTERCEPT_DRAFT, message: 'Invalid header name: ' + k } };
        if (/[\r\n]/.test(String(v))) return { error: { code: CODES.INVALID_INTERCEPT_DRAFT, message: 'Invalid header value for ' + k } };
      }
      rec.draft.headers = { ...patch.headers };
    }
    if (patch.body !== undefined) rec.draft.body = patch.body === null ? null : String(patch.body);
    this.emit('changed');
    return publicRec(rec);
  }

  async continue(id) { return this._resolve(id, false); }
  async continueModified(id, patch) { if (patch) { const u = this.updateDraft(id, patch); if (u && u.error) return u; } return this._resolve(id, true); }

  async abort(id) {
    const rec = this._paused.get(id);
    if (!rec) return { error: { code: CODES.INTERCEPT_NOT_FOUND, message: 'Unknown intercepted request' } };
    if (rec.state !== STATES.PAUSED) return { error: { code: CODES.INTERCEPT_ALREADY_RESOLVED, message: 'Request already ' + rec.state } };
    const client = this._resolveClient(rec.targetId);
    this._clearTimer(rec);
    if (!client || !client.Fetch) { rec.state = STATES.FAILED; rec.error = { code: CODES.TARGET_CONTEXT_UNAVAILABLE }; this._finish(rec); return { error: rec.error }; }
    try { await client.Fetch.failRequest({ requestId: rec.fetchRequestId, errorReason: 'Aborted' }); }
    catch (err) { rec.state = STATES.FAILED; rec.error = { code: CODES.INTERCEPT_ABORT_FAILED, message: String(err && err.message || err) }; this._finish(rec); return { error: rec.error }; }
    rec.state = STATES.ABORTED; this._finish(rec);
    return publicRec(rec);
  }

  onTargetDetached(targetId) {
    this._active.delete(targetId);
    for (const rec of [...this._paused.values()]) {
      if (rec.targetId === targetId && rec.state === STATES.PAUSED) {
        this._clearTimer(rec); rec.state = STATES.FAILED; rec.error = { code: CODES.TARGET_CONTEXT_UNAVAILABLE }; this._finish(rec, false);
      }
    }
    this.emit('changed');
  }

  async _resolve(id, modified) {
    const rec = this._paused.get(id);
    if (!rec) return { error: { code: CODES.INTERCEPT_NOT_FOUND, message: 'Unknown intercepted request' } };
    if (rec.state !== STATES.PAUSED) return { error: { code: CODES.INTERCEPT_ALREADY_RESOLVED, message: 'Request already ' + rec.state } };
    const client = this._resolveClient(rec.targetId);
    this._clearTimer(rec);
    if (!client || !client.Fetch) { rec.state = STATES.FAILED; rec.error = { code: CODES.TARGET_CONTEXT_UNAVAILABLE, message: 'The target that paused this request is gone' }; this._finish(rec); return { error: rec.error }; }
    const params = { requestId: rec.fetchRequestId };
    const warnings = [];
    if (modified) {
      const d = rec.draft;
      if (d.url !== rec.original.url) params.url = d.url;
      if (d.method !== rec.original.method) params.method = d.method;
      const headerArr = [];
      for (const [name, value] of Object.entries(d.headers || {})) headerArr.push({ name, value: String(value) });
      params.headers = headerArr;
      if (d.body != null && !['GET', 'HEAD'].includes(d.method)) params.postData = Buffer.from(String(d.body), 'utf8').toString('base64');
    }
    try { await client.Fetch.continueRequest(params); }
    catch (err) { rec.state = STATES.FAILED; rec.error = { code: CODES.INTERCEPT_CONTINUE_FAILED, message: String(err && err.message || err) }; this._finish(rec); return { error: rec.error }; }
    rec.state = modified ? STATES.MODIFIED_AND_CONTINUED : STATES.CONTINUED;
    rec.warnings = warnings;
    this._finish(rec);
    return publicRec(rec);
  }

  async _onTimeout(id) {
    const rec = this._paused.get(id);
    if (!rec || rec.state !== STATES.PAUSED) return;
    const client = this._resolveClient(rec.targetId);
    // Fail-safe: auto-continue UNMODIFIED so the app is never frozen forever.
    if (client && client.Fetch) { try { await client.Fetch.continueRequest({ requestId: rec.fetchRequestId }); } catch { /* gone */ } }
    rec.state = STATES.TIMED_OUT; this._finish(rec);
  }

  async _continueRaw(targetId, fetchRequestId) {
    const client = this._resolveClient(targetId);
    if (client && client.Fetch) { try { await client.Fetch.continueRequest({ requestId: fetchRequestId }); } catch { /* ignore */ } }
  }

  _clearTimer(rec) { if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; } }
  _finish(rec, emitResolved = true) {
    this._byFetchId.delete(`${rec.targetId}:${rec.fetchRequestId}`);
    if (emitResolved) this.emit('resolved', publicRec(rec));
    this.emit('changed');
  }
}

function publicRec(rec) {
  return {
    id: rec.id, targetId: rec.targetId, fetchRequestId: rec.fetchRequestId, networkRequestId: rec.networkRequestId,
    resourceType: rec.resourceType, frameId: rec.frameId, pausedAt: rec.pausedAt, state: rec.state,
    original: rec.original, draft: rec.draft, error: rec.error, warnings: rec.warnings,
  };
}

module.exports = { InterceptEngine, STATES, ruleMatches, buildPatterns };
