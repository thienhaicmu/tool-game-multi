'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { redactHeaders, redactString, safeUrlKeepQuery, REDACTED } = require('../diagnostics/redaction.cjs');

// ---------------------------------------------------------------------------
// TrafficStore — bounded, per-BrowserRun persistence of the EXISTING Control
// CaptureCorrelator evidence stream. This is NOT a capture engine: it only
// serialises records the correlator already produced (HTTP request/response/
// body, WS created/frame/closed) plus recovery lifecycle markers, so a long
// disconnect/re-entry episode can be reconstructed offline.
//
// Design invariants (mirrors DiagnosticLog so behaviour is familiar/tested):
//   * Structured JSONL, append-only, one record per line.
//   * Per-run directory → structural B1/B2 isolation (a run's records can only
//     ever land under that run's dir; ownership comes from the emitting run).
//   * Bounded disk: size rotation (maxFileSizeBytes × maxFilesPerRun) + age purge.
//   * Shared canonical redaction applied BEFORE write (no secret at rest).
//   * Raw safe payload preserved verbatim; derived tags are ADDITIVE.
//   * Failure-window pinning: on a failure marker the surrounding pre/post window
//     is snapshotted into an episode file that size-rotation never evicts.
//   * Never throws to the caller — a persistence failure must not break runtime.
//
// Electron-free and dependency-injected (fs / clock) for deterministic tests.
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  maxFileSizeBytes: 16 * 1024 * 1024, // 16 MB active file before rotation
  maxFilesPerRun: 8,                  // active + 7 archives ⇒ ~128 MB/run ceiling
  maxBodyBytes: 256 * 1024,           // per-record response-body cap (text only)
  ringWindowMs: 120000,               // pre-failure window kept in memory for pinning
  ringMaxRecords: 6000,               // hard cap on the in-memory ring per run
  postWindowMs: 120000,               // how long an opened episode keeps teeing records
});

// Known Aviator/lobby protocol cmds — used ONLY for additive tagging/classification.
// Unknown cmds are still fully persisted (never filtered out).
const AVIATOR_CMDS = new Set([100000, 100001, 100002, 100003, 100005, 100006, 100007, 100008, 100009, 100010, 100016]);
const LOBBY_CMDS = new Set([10000, 10001, 10002, 10003, 10004]);

// Failure markers whose arrival pins the surrounding evidence window. These are all
// Aviator-context-CORRELATED recovery signals (emitted by the context tracker / recovery
// machine on the OWNING game socket), never a generic WS close. A raw WS close on an
// unrelated side channel (chat / telemetry / video / gemsdatapi / millicast) is still
// persisted as raw traffic + a marker, but must NOT pin a failure episode by itself —
// otherwise constant side-channel churn would explode episode storage.
const FAILURE_EVENTS = new Set([
  'AVIATOR_CONTEXT_LOST_REENTER', 'AVIATOR_CONTEXT_ESCALATE_FULL_RECOVERY',
  'AVIATOR_CONTEXT_REQUIRE_USER_ACTION', 'REENTRY_FAILED', 'RECOVERY_FAILED',
  'AUTO_RESUME_FAILED', 'LOGIN_REQUIRED',
]);

function classifyPayload(raw) {
  const s = raw == null ? '' : String(raw);
  const trimmed = s.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return { cmd: null, parsed: false };
  try {
    const j = JSON.parse(trimmed);
    let cmd = null;
    if (Array.isArray(j) && j.length && Number.isFinite(Number(j[0]))) cmd = Number(j[0]);
    else if (j && Number.isFinite(Number(j.cmd))) cmd = Number(j.cmd);
    return { cmd, parsed: true };
  } catch { return { cmd: null, parsed: false }; }
}

function textLikeMime(mime) {
  return /^(application\/(json|[^;]*\+json|xml|javascript|x-www-form-urlencoded|graphql)|text\/)/i.test(String(mime || ''));
}

class TrafficStore {
  constructor(deps = {}) {
    this._fs = deps.fs || fsDefault;
    this._dir = deps.dir || null;               // root traffic dir (per-run subdirs live under it)
    this._now = deps.now || (() => Date.now());
    this._monoNow = deps.monoNow || (() => performance.now());
    this._enabled = deps.enabled !== false;
    this._maxFileSize = Number(deps.maxFileSizeBytes || DEFAULTS.maxFileSizeBytes);
    this._maxFiles = Math.max(1, Number(deps.maxFilesPerRun || DEFAULTS.maxFilesPerRun));
    this._maxBodyBytes = Number(deps.maxBodyBytes || DEFAULTS.maxBodyBytes);
    this._ringWindowMs = Number(deps.ringWindowMs != null ? deps.ringWindowMs : DEFAULTS.ringWindowMs);
    this._ringMax = Number(deps.ringMaxRecords || DEFAULTS.ringMaxRecords);
    this._postWindowMs = Number(deps.postWindowMs != null ? deps.postWindowMs : DEFAULTS.postWindowMs);
    this._seq = 0;
    this._runs = new Map();       // runId -> { size, ring:[], episodes:[{file, until}] }
    this._runBrowser = new Map(); // runId -> browserId (for path nesting + resolution)
  }

  _runState(runId) {
    const id = String(runId);
    let s = this._runs.get(id);
    if (!s) { s = { size: null, ring: [], episodes: [] }; this._runs.set(id, s); }
    return s;
  }

  _safe(x) { return String(x).replace(/[^a-zA-Z0-9_.-]/g, '-'); }

  // Evidence nests as <dir>/<browserId>/<runId> so per-run isolation AND per-browser
  // purge (§8) are both structural. When a reader doesn't know the browserId (e.g. after
  // a restart) we scan the browser dirs for the run.
  _runDir(runId, browserId) {
    if (!this._dir) return null;
    const bid = browserId != null ? browserId : this._runBrowser.get(String(runId));
    if (bid != null) return path.join(this._dir, this._safe(bid), this._safe(runId));
    // resolve by scanning
    let bs; try { bs = this._fs.readdirSync(this._dir); } catch { bs = []; }
    for (const b of bs) { const cand = path.join(this._dir, b, this._safe(runId)); try { if (this._fs.statSync(cand).isDirectory()) return cand; } catch { /* skip */ } }
    return path.join(this._dir, '_unknown', this._safe(runId));
  }
  _activeFile(runId, browserId) { const d = this._runDir(runId, browserId); return d ? path.join(d, 'traffic.jsonl') : null; }

  // ---- ownership fields (structural; never from UI selection) ----
  _owner(owner = {}) {
    return {
      browserId: owner.browserId != null ? String(owner.browserId) : null,
      runId: owner.runId != null ? String(owner.runId) : null,
      autoExecutionId: owner.autoExecutionId != null ? String(owner.autoExecutionId) : null,
      // NOTE: run.recovery.attempts() is a RETRY COUNTER within one incident (resets to 0 on
      // READY/reset), NOT a unique recovery-generation id. Recorded honestly as recoveryAttempt.
      // A unique incident id (recoveryEpisodeId) is minted recorder-side at pin time (see pinEpisode).
      recoveryAttempt: Number.isFinite(owner.recoveryAttempt) ? owner.recoveryAttempt : null,
      targetId: owner.targetId != null ? String(owner.targetId) : null,
      sessionId: owner.sessionId != null ? String(owner.sessionId) : null,
      requestId: owner.requestId != null ? String(owner.requestId) : null,
    };
  }

  // ------------------------------------------------------------------ public API
  recordHttpRequest(owner, req = {}) {
    return this._write(owner, {
      kind: 'http-request', requestId: req.cdpRequestId != null ? String(req.cdpRequestId) : (owner && owner.requestId),
      hop: req.hop != null ? req.hop : 0, loaderId: req.loaderId || null, frameId: req.frameId || null,
      method: req.method || null, url: safeUrlKeepQuery(req.url), host: req.host || null, path: req.path || null,
      resourceType: req.resourceType || null, redirectFromId: req.redirectFromId || null,
      headers: redactHeaders(req.headers || {}),
      body: this._safeReqBody(req.body),
      tags: this._tagsForHttp(req),
    }, req);
  }

  recordHttpResponse(owner, req = {}) {
    const r = req.response || {};
    return this._write(owner, {
      kind: 'http-response', requestId: req.cdpRequestId != null ? String(req.cdpRequestId) : (owner && owner.requestId),
      hop: req.hop != null ? req.hop : 0, url: safeUrlKeepQuery(req.url),
      status: r.status != null ? r.status : null, statusText: r.statusText || null,
      mimeType: r.mimeType || null, protocol: r.protocol || null,
      remoteIP: r.remoteIP || null, remotePort: r.remotePort != null ? r.remotePort : null,
      headers: redactHeaders(r.headers || {}),
      durationMs: req.durationMs != null ? Math.round(req.durationMs) : null,
      failed: req.state === 'FAILED' || req.failure != null, failureReason: req.failure ? req.failure.errorText : null,
      tags: this._tagsForHttp(req),
    }, req);
  }

  // body: { available, body, base64Encoded, length, truncated } from capture.getResponseBody()
  recordHttpBody(owner, req = {}, body = {}) {
    const mime = req.response && req.response.mimeType;
    let rec = { kind: 'http-body', requestId: req.cdpRequestId != null ? String(req.cdpRequestId) : (owner && owner.requestId), hop: req.hop != null ? req.hop : 0, bodySize: body.length != null ? body.length : null };
    if (!body || !body.available) { rec.captureStatus = 'UNAVAILABLE'; rec.captureError = body && body.error ? (body.error.message || body.error.code) : 'unavailable'; }
    else if (body.base64Encoded || !textLikeMime(mime)) { rec.captureStatus = 'SKIPPED_BINARY'; }
    else {
      let text = String(body.body || '');
      let truncated = Boolean(body.truncated);
      if (text.length > this._maxBodyBytes) { text = text.slice(0, this._maxBodyBytes); truncated = true; }
      rec.body = redactString(text); rec.truncated = truncated; rec.captureStatus = 'CAPTURED';
    }
    return this._write(owner, rec, req);
  }

  recordWsCreated(owner, req = {}) {
    return this._write(owner, {
      kind: 'ws-created', requestId: req.cdpRequestId != null ? String(req.cdpRequestId) : (owner && owner.requestId),
      url: safeUrlKeepQuery(req.url), host: req.host || null, tags: this._tagsForWs(req.url, null),
    }, req);
  }

  recordWsFrame(owner, req = {}) {
    const raw = req.body && req.body.raw;
    const cls = classifyPayload(raw);
    return this._write(owner, {
      kind: 'ws-frame', direction: req.wsDirection || null,
      requestId: req.cdpRequestId != null ? String(req.cdpRequestId) : (owner && owner.requestId),
      url: safeUrlKeepQuery(req.url), cmd: cls.cmd, parsed: cls.parsed,
      payload: redactString(raw == null ? '' : String(raw)),
      payloadSize: raw != null ? String(raw).length : 0,
      tags: this._tagsForWs(req.url, cls.cmd),
    }, req);
  }

  recordWsClosed(owner, req = {}) {
    // CDP Network.webSocketClosed carries no close code/reason → preserve UNKNOWN, never invent.
    return this._write(owner, {
      kind: 'ws-closed', requestId: req.cdpRequestId != null ? String(req.cdpRequestId) : (owner && owner.requestId),
      url: safeUrlKeepQuery(req.url), closeCode: null, closeReason: null, tags: this._tagsForWs(req.url, null),
    }, req);
  }

  // Recovery/Auto lifecycle marker (fed from the same diagnostic events already emitted).
  // A failure marker pins the surrounding evidence window.
  recordMarker(owner, marker = {}) {
    const event = marker.event != null ? String(marker.event) : 'MARKER';
    const rec = this._write(owner, {
      kind: 'marker', category: marker.category != null ? String(marker.category) : null,
      event, level: marker.level || 'INFO',
      meta: marker.meta != null ? marker.meta : undefined,
    }, {});
    if (FAILURE_EVENTS.has(event)) { try { this.pinEpisode(owner && owner.runId, { reason: event }); } catch { /* best effort */ } }
    return rec;
  }

  // ------------------------------------------------------------------ write path
  _write(owner, fields, req) {
    if (!this._enabled) return null;
    const o = this._owner({ ...owner, ...(req && req.targetId ? { targetId: req.targetId } : {}), ...(req && req.cdpSessionId ? { sessionId: req.cdpSessionId } : {}) });
    const rec = { seq: this._seq++, ts: this._now(), mono: Math.round(this._monoNow()), ...o, ...fields };
    if (!o.runId) return rec; // no owner → cannot isolate; drop silently (never cross-route)
    if (o.browserId != null) this._runBrowser.set(o.runId, o.browserId);
    this._appendToRing(o.runId, rec);
    if (!this._dir) return rec; // memory-only mode
    const line = JSON.stringify(rec) + '\n';
    try {
      const dir = this._runDir(o.runId);
      this._fs.mkdirSync(dir, { recursive: true });
      this._rotateIfNeeded(o.runId, Buffer.byteLength(line, 'utf8'));
      this._fs.appendFileSync(this._activeFile(o.runId), line, 'utf8');
      const s = this._runState(o.runId);
      s.size = (s.size == null ? this._currentSize(o.runId) : s.size) + Buffer.byteLength(line, 'utf8');
      this._teeToEpisodes(o.runId, line, rec.ts);
    } catch { /* best effort — never throw into runtime */ }
    return rec;
  }

  _appendToRing(runId, rec) {
    const s = this._runState(runId);
    s.ring.push(rec);
    const cutoff = rec.ts - this._ringWindowMs;
    while (s.ring.length && (s.ring[0].ts < cutoff || s.ring.length > this._ringMax)) s.ring.shift();
  }

  _teeToEpisodes(runId, line, ts) {
    const s = this._runState(runId);
    if (!s.episodes.length) return;
    s.episodes = s.episodes.filter((ep) => {
      if (ts > ep.until) return false; // window elapsed → stop teeing, keep the file
      try { this._fs.appendFileSync(ep.file, line, 'utf8'); } catch { /* best effort */ }
      return true;
    });
  }

  // Snapshot the pre-failure ring window into an episode file and keep teeing for postWindowMs.
  // Episode files are exempt from size rotation (only age-purged) so the failure window survives.
  //
  // DEDUP (one physical incident → one episode): a single recovery incident emits several failure
  // markers in quick succession (context-lost → reenter → reenter-failed → recovery-failed). If an
  // episode is still within its post-window we EXTEND it instead of writing a second full window —
  // those later markers are already teed into the open file. A genuinely new incident (arriving
  // after the window closed) mints a fresh recoveryEpisodeId and a new file.
  pinEpisode(runId, { reason = 'FAILURE', at = null, postWindowMs = null } = {}) {
    if (!this._dir || runId == null) return null;
    const id = String(runId);
    const when = at != null ? at : this._now();
    const s = this._runState(id);
    const post = postWindowMs != null ? postWindowMs : this._postWindowMs;
    const open = s.episodes.find((ep) => when <= ep.until);
    if (open) { // coalesce into the in-flight incident
      open.until = Math.max(open.until, when + post);
      if (open.reason !== reason) { open.reasons = open.reasons || [open.reason]; open.reasons.push(reason); }
      return { file: open.file, reason, coalesced: true, recoveryEpisodeId: open.recoveryEpisodeId };
    }
    const episodeId = (s.recoveryEpisodeSeq = (s.recoveryEpisodeSeq || 0) + 1);
    const dir = path.join(this._runDir(id), 'episodes');
    const stamp = new Date(when).toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `episode-${stamp}-g${episodeId}-${String(reason).slice(0, 40)}.jsonl`);
    try {
      this._fs.mkdirSync(dir, { recursive: true });
      const pre = s.ring.filter((r) => r.ts >= when - this._ringWindowMs);
      const header = JSON.stringify({ seq: -1, ts: when, kind: 'episode-pin', runId: id, recoveryEpisodeId: episodeId, reason, preWindowMs: this._ringWindowMs, postWindowMs: post }) + '\n';
      this._fs.writeFileSync(file, header + pre.map((r) => JSON.stringify(r)).join('\n') + (pre.length ? '\n' : ''), 'utf8');
      s.episodes.push({ file, until: when + post, reason, recoveryEpisodeId: episodeId });
      return { file, reason, preRecords: pre.length, recoveryEpisodeId: episodeId };
    } catch { return null; }
  }

  // ------------------------------------------------------------------ read/export
  // All records for a run within [fromMs,toMs], de-duplicated by seq, ordered by (ts,seq).
  readRun(runId, { fromMs = null, toMs = null } = {}) {
    const files = this._filesForRun(runId, { includeEpisodes: true });
    const bySeq = new Map();
    for (const f of files) {
      let raw; try { raw = this._fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.kind === 'episode-pin') continue; // header, not evidence
        if (fromMs != null && rec.ts < fromMs) continue;
        if (toMs != null && rec.ts > toMs) continue;
        if (!bySeq.has(rec.seq)) bySeq.set(rec.seq, rec);
      }
    }
    return [...bySeq.values()].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  }

  // Export one episode/time-range as ordered, redacted JSONL. Returns { ok, path, lines }.
  exportEpisode({ runId, fromMs = null, toMs = null } = {}, outPath) {
    const rows = this.readRun(runId, { fromMs, toMs });
    try {
      const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
      this._fs.writeFileSync(outPath, body, 'utf8');
      return { ok: true, path: outPath, lines: rows.length };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // READ-ONLY offline summary of a disconnect/re-entry episode. Never controls the game.
  summarizeEpisode({ runId, fromMs = null, toMs = null } = {}) {
    const rows = this.readRun(runId, { fromMs, toMs });
    const sum = {
      runId: runId != null ? String(runId) : null, records: rows.length,
      firstAt: rows.length ? rows[0].ts : null, lastAt: rows.length ? rows[rows.length - 1].ts : null,
      lastAviatorFrameAt: null, lastWsSendAt: null, lastWsRecvAt: null, wsCloseAt: null,
      contextLostAt: null, reentryAttemptAt: null, gameActAt: null, reloadAt: null,
      cocosEntryAt: null, freshActiveAt: null, resumeAt: null, failedAt: null,
      socketGenerations: [], markers: [],
    };
    const socks = new Map();
    // A socket generation is identified by target:session:request — NOT requestId alone. CDP
    // resets requestId per target, so after a reload a new socket can reuse an old requestId;
    // keying on the composite keeps generations across reloads distinguishable (§5).
    const skey = (r) => `${r.targetId != null ? r.targetId : ''}:${r.sessionId != null ? r.sessionId : ''}:${r.requestId != null ? r.requestId : ''}`;
    for (const r of rows) {
      if (r.kind === 'ws-frame') {
        const aviator = Array.isArray(r.tags) && r.tags.includes('AVIATOR_PROTOCOL');
        if (r.direction === 'send') sum.lastWsSendAt = r.ts;
        if (r.direction === 'recv') { sum.lastWsRecvAt = r.ts; if (aviator) sum.lastAviatorFrameAt = r.ts; }
        const k = skey(r);
        const g = socks.get(k) || { key: k, requestId: r.requestId, targetId: r.targetId, sessionId: r.sessionId, url: r.url, firstAt: r.ts, lastAt: r.ts, send: 0, recv: 0 };
        g.lastAt = r.ts; if (r.direction === 'send') g.send++; else g.recv++;
        socks.set(k, g);
      } else if (r.kind === 'ws-created') {
        const k = skey(r);
        socks.set(k, socks.get(k) || { key: k, requestId: r.requestId, targetId: r.targetId, sessionId: r.sessionId, url: r.url, firstAt: r.ts, lastAt: r.ts, send: 0, recv: 0 });
      } else if (r.kind === 'ws-closed') { sum.wsCloseAt = r.ts; const g = socks.get(skey(r)); if (g) g.closedAt = r.ts; }
      else if (r.kind === 'http-request' && Array.isArray(r.tags) && r.tags.includes('GAME_ACT')) sum.gameActAt = r.ts;
      else if (r.kind === 'marker') {
        sum.markers.push({ ts: r.ts, event: r.event, recoveryAttempt: r.recoveryAttempt });
        const e = r.event;
        if (e === 'AVIATOR_CONTEXT_LOST_REENTER' || e === 'AVIATOR_CONTEXT_ESCALATE_FULL_RECOVERY') sum.contextLostAt = sum.contextLostAt || r.ts;
        if (e === 'REENTRY_STARTED' || e === 'AVIATOR_CONTEXT_LOST_REENTER' || e === 'COCOS_ENTRY_ATTEMPT') sum.reentryAttemptAt = sum.reentryAttemptAt || r.ts;
        if (e === 'RELOAD_STARTED' || e === 'RECOVERY_RELOAD_START') sum.reloadAt = sum.reloadAt || r.ts;
        if (e === 'COCOS_ENTRY_ATTEMPT') sum.cocosEntryAt = sum.cocosEntryAt || r.ts;
        if (e === 'ENTRY_ACTIVE_CONFIRMED' || e === 'RECOVERY_READY' || e === 'AVIATOR_ACTIVE') sum.freshActiveAt = sum.freshActiveAt || r.ts;
        if (e === 'AUTO_RESUMED' || e === 'AUTO_RESUME') sum.resumeAt = sum.resumeAt || r.ts;
        if (e === 'RECOVERY_FAILED' || e === 'REENTRY_FAILED' || e === 'AUTO_RESUME_FAILED') sum.failedAt = sum.failedAt || r.ts;
      }
    }
    sum.socketGenerations = [...socks.values()];
    return sum;
  }

  // ------------------------------------------------------------------ tagging (additive)
  _tagsForHttp(req) {
    const tags = [];
    const p = String((req && req.path) || '');
    const u = String((req && req.url) || '');
    if (/game-act/i.test(p) || /game-act/i.test(u)) tags.push('GAME_ACT');
    return tags;
  }
  _tagsForWs(url, cmd) {
    const tags = [];
    const host = (() => { try { return new URL(url).host; } catch { return String(url || ''); } })();
    if (/mynisketgw|carkgwaiz|wsmt8g/i.test(host)) tags.push('GAME_WS');
    if (cmd != null && AVIATOR_CMDS.has(cmd)) tags.push('AVIATOR_PROTOCOL', 'AVIATOR_WS');
    else if (cmd != null && LOBBY_CMDS.has(cmd)) tags.push('LOBBY_PROTOCOL');
    return tags;
  }

  _safeReqBody(body) {
    if (!body || body.raw == null) return { hasBody: Boolean(body && body.hasBody) };
    let raw = String(body.raw);
    let truncated = false;
    if (raw.length > this._maxBodyBytes) { raw = raw.slice(0, this._maxBodyBytes); truncated = true; }
    return { hasBody: true, raw: redactString(raw), truncated, contentType: body.contentType || null, size: body.size != null ? body.size : raw.length };
  }

  // ------------------------------------------------------------------ rotation / retention
  _currentSize(runId) { try { return this._fs.statSync(this._activeFile(runId)).size; } catch { return 0; } }

  _rotateIfNeeded(runId, incomingBytes) {
    const s = this._runState(runId);
    const cur = s.size == null ? this._currentSize(runId) : s.size;
    if (cur + incomingBytes <= this._maxFileSize) { s.size = cur; return; }
    if (cur === 0) { s.size = 0; return; } // a single oversized line still writes once
    const stamp = new Date(this._now()).toISOString().replace(/[:.]/g, '-');
    const archive = path.join(this._runDir(runId), `traffic-${stamp}-${this._seq}.jsonl`);
    try { this._fs.renameSync(this._activeFile(runId), archive); } catch { /* best effort */ }
    s.size = 0;
    this._pruneArchives(runId);
  }

  // Keep newest (maxFilesPerRun-1) archives + active. Episode snapshots are NOT pruned here.
  _pruneArchives(runId) {
    const dir = this._runDir(runId);
    let entries; try { entries = this._fs.readdirSync(dir); } catch { return; }
    const archives = entries
      .filter((n) => n.startsWith('traffic-') && n.endsWith('.jsonl'))
      .map((n) => { let m = 0; try { m = this._fs.statSync(path.join(dir, n)).mtimeMs; } catch { m = 0; } return { name: n, mtime: m }; })
      .sort((a, b) => a.mtime - b.mtime);
    const drop = archives.length - Math.max(0, this._maxFiles - 1);
    for (let i = 0; i < drop; i++) { try { this._fs.unlinkSync(path.join(dir, archives[i].name)); } catch { /* best effort */ } }
  }

  _filesForRun(runId, { includeEpisodes = false, browserId = null } = {}) {
    const dir = this._runDir(runId, browserId);
    if (!dir) return [];
    let entries; try { entries = this._fs.readdirSync(dir); } catch { return []; }
    const out = [];
    const active = 'traffic.jsonl';
    const archives = entries.filter((n) => n.startsWith('traffic-') && n.endsWith('.jsonl'))
      .map((n) => ({ n, m: (() => { try { return this._fs.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => a.m - b.m).map((a) => a.n);
    for (const a of archives) out.push(path.join(dir, a));
    if (entries.includes(active)) out.push(path.join(dir, active));
    if (includeEpisodes) {
      const epDir = path.join(dir, 'episodes');
      let eps; try { eps = this._fs.readdirSync(epDir); } catch { eps = []; }
      for (const e of eps) if (e.endsWith('.jsonl')) out.push(path.join(epDir, e));
    }
    return out;
  }

  // Iterate every run dir as [browserId, runId, dir].
  _eachRunDir(fn) {
    let browsers; try { browsers = this._fs.readdirSync(this._dir); } catch { return; }
    for (const b of browsers) {
      const bDir = path.join(this._dir, b);
      let runs; try { runs = this._fs.readdirSync(bDir); } catch { continue; }
      for (const r of runs) { const d = path.join(bDir, r); try { if (this._fs.statSync(d).isDirectory()) fn(b, r, d); } catch { /* skip */ } }
    }
  }

  // Newest embedded record timestamp in a JSONL file (last parseable line's ts).
  // Deterministic (clock-injected) and independent of filesystem mtime.
  _newestTs(file) {
    let raw; try { raw = this._fs.readFileSync(file, 'utf8'); } catch { return null; }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]; if (!l) continue;
      try { const ts = JSON.parse(l).ts; if (Number.isFinite(ts)) return ts; } catch { /* keep scanning up */ }
    }
    return null;
  }

  // Age-based retention across ALL runs (archives + episodes). Active files kept.
  // Drops a whole archive/episode file once its NEWEST record is older than maxAgeMs.
  // Files with no parseable timestamp are KEPT (never mass-dropped). Returns { dropped }.
  purgeExpired({ now = this._now(), maxAgeMs } = {}) {
    if (!this._dir || !Number.isFinite(Number(maxAgeMs))) return { dropped: 0 };
    const cutoff = now - Number(maxAgeMs);
    let dropped = 0;
    this._eachRunDir((b, r, dir) => {
      const scan = (d, isActiveDir) => {
        let entries; try { entries = this._fs.readdirSync(d); } catch { return; }
        for (const n of entries) {
          const full = path.join(d, n);
          if (isActiveDir && n === 'traffic.jsonl') continue; // never purge the active file
          if (!n.endsWith('.jsonl')) continue;
          const newest = this._newestTs(full);
          if (newest == null) continue;            // unparseable -> keep
          if (newest < cutoff) { try { this._fs.unlinkSync(full); dropped++; } catch { /* best effort */ } }
        }
      };
      scan(dir, true);
      scan(path.join(dir, 'episodes'), false);
    });
    return { dropped };
  }

  // §8 — remove one run's evidence entirely. Other runs untouched.
  purgeRun(runId, browserId) {
    const dir = this._runDir(runId, browserId);
    if (!dir) return { ok: true };
    try { this._fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    this._runs.delete(String(runId));
    return { ok: true };
  }

  // §8 — remove ALL of one browser's runs (profile deletion). B2 untouched.
  purgeBrowser(browserId) {
    if (!this._dir) return { ok: true };
    try { this._fs.rmSync(path.join(this._dir, this._safe(browserId)), { recursive: true, force: true }); } catch { /* best effort */ }
    for (const [rid, bid] of [...this._runBrowser.entries()]) if (String(bid) === String(browserId)) { this._runBrowser.delete(rid); this._runs.delete(rid); }
    return { ok: true };
  }

  stats() {
    const runs = [];
    let total = 0;
    if (this._dir) {
      this._eachRunDir((b, r, dir) => {
        let bytes = 0; const files = this._filesForRun(r, { includeEpisodes: true, browserId: b });
        for (const f of files) { try { bytes += this._fs.statSync(f).size; } catch { /* skip */ } }
        runs.push({ browserId: b, runId: r, bytes, files: files.length });
        total += bytes;
      });
    }
    return { directory: this._dir, format: 'JSONL', totalBytes: total, runs, retention: this.retentionPolicy() };
  }

  retentionPolicy() {
    return {
      format: 'JSONL', perRunMaxFileSizeBytes: this._maxFileSize, perRunMaxFiles: this._maxFiles,
      perRunSizeCeilingBytes: this._maxFileSize * this._maxFiles,
      failureWindowMs: this._ringWindowMs + this._postWindowMs,
    };
  }
}

module.exports = { TrafficStore, DEFAULTS, classifyPayload, AVIATOR_CMDS };
