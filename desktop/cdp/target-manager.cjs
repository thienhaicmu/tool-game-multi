'use strict';

const EventEmitter = require('node:events');
const CDPdefault = require('chrome-remote-interface');
const { CODES, CdpError } = require('./errors.cjs');
const { toDebugTarget, isAttachable } = require('./util.cjs');

/**
 * TargetManager owns the connection to a single CDP endpoint (host:port) and keeps
 * a live map of attachable targets (pages / WebViews). Each target gets its OWN
 * dedicated CDP client via its webSocketDebuggerUrl. That per-target client is the
 * session: capture (WU2), replay (WU3) and intercept (WU4) all run through the
 * client bound to the request's own target, which structurally prevents the
 * "replay in the wrong context" bug.
 *
 * Discovery works uniformly for Chrome, WebView2, CEF and Android WebView because
 * they all expose the same /json list. New/destroyed WebViews are detected by a
 * reconcile loop polling CDP.List(); this is intentionally simple and maximally
 * compatible (Android WebView does not always deliver Target.* browser events).
 *
 * Events:
 *   'target-added'   (DebugTarget)
 *   'target-updated' (DebugTarget)      // url/title changed
 *   'target-removed' (cdpTargetId)
 *   'attached'       ({ target, client })
 *   'detached'       (cdpTargetId)
 *   'error'          (CdpError)
 */
class TargetManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._host = options.host || '127.0.0.1';
    this._port = Number(options.port || 9222);
    this._runtimeHint = options.runtimeHint || null; // e.g. 'ANDROID_WEBVIEW' from adb flow
    this._pollIntervalMs = Number(options.pollIntervalMs || 1500);
    this._CDP = options.cdp || CDPdefault;
    this._versionBrowser = '';
    this._entries = new Map(); // cdpTargetId -> { target, client }
    this._timer = null;
    this._started = false;
    this._reconciling = false;
  }

  get endpoint() { return { host: this._host, port: this._port }; }

  async start() {
    if (this._started) return;
    // Probe the endpoint first so we can fail with a precise typed error.
    try {
      const version = await this._CDP.Version({ host: this._host, port: this._port });
      this._versionBrowser = version.Browser || version.browser || '';
    } catch (err) {
      throw new CdpError(CODES.CDP_ENDPOINT_UNAVAILABLE,
        `No CDP endpoint at ${this._host}:${this._port}`, { cause: String(err && err.message || err) });
    }
    this._started = true;
    await this._reconcile();
    this._timer = setInterval(() => { this._reconcile().catch(() => {}); }, this._pollIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  async stop() {
    this._started = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const entries = [...this._entries.values()];
    this._entries.clear();
    for (const { target, client } of entries) {
      try { await client.close(); } catch { /* ignore */ }
      this.emit('detached', target.cdpTargetId);
    }
  }

  listTargets() {
    return [...this._entries.values()].map(({ target }) => ({ ...target }));
  }

  getSession(cdpTargetId) {
    const entry = this._entries.get(String(cdpTargetId));
    return entry ? { target: { ...entry.target }, client: entry.client } : undefined;
  }

  async _reconcile() {
    if (!this._started || this._reconciling) return;
    this._reconciling = true;
    try {
      let raw;
      try {
        raw = await this._CDP.List({ host: this._host, port: this._port });
      } catch (err) {
        this.emit('error', new CdpError(CODES.CDP_ENDPOINT_UNAVAILABLE,
          'CDP endpoint stopped responding', { cause: String(err && err.message || err) }));
        return;
      }
      const live = new Map();
      for (const entry of raw) {
        if (!isAttachable(entry.type)) continue;
        live.set(String(entry.id), entry);
      }
      // Removed targets (WebView destroyed / tab closed).
      for (const id of [...this._entries.keys()]) {
        if (!live.has(id)) await this._removeTarget(id);
      }
      // Added / updated targets.
      for (const [id, entry] of live) {
        const existing = this._entries.get(id);
        if (!existing) {
          await this._addTarget(entry);
        } else if (existing.target.url !== (entry.url || '') || existing.target.title !== (entry.title || '')) {
          existing.target.url = entry.url || '';
          existing.target.title = entry.title || '';
          this.emit('target-updated', { ...existing.target });
        }
      }
    } finally {
      this._reconciling = false;
    }
  }

  async _addTarget(rawEntry) {
    const target = toDebugTarget(rawEntry, this._versionBrowser, this._runtimeHint);
    let client;
    try {
      client = await this._CDP({ target: rawEntry.webSocketDebuggerUrl });
    } catch (err) {
      this.emit('error', new CdpError(CODES.TARGET_NOT_FOUND,
        `Failed to attach target ${target.cdpTargetId}`, { cause: String(err && err.message || err) }));
      return;
    }
    target.sessionId = client.sessionId || target.cdpTargetId;
    target.attached = true;
    const entry = { target, client };
    this._entries.set(target.cdpTargetId, entry);

    client.on('disconnect', () => {
      if (this._entries.get(target.cdpTargetId) === entry) {
        this._entries.delete(target.cdpTargetId);
        this.emit('detached', target.cdpTargetId);
        this.emit('target-removed', target.cdpTargetId);
      }
    });

    this.emit('target-added', { ...target });
    this.emit('attached', { target: { ...target }, client });
  }

  async _removeTarget(id) {
    const entry = this._entries.get(id);
    if (!entry) return;
    this._entries.delete(id);
    try { await entry.client.close(); } catch { /* already gone */ }
    this.emit('detached', id);
    this.emit('target-removed', id);
  }
}

module.exports = { TargetManager };
