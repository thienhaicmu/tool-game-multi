'use strict';

// ---------------------------------------------------------------------------
// WU-E.1 — PageScreencast. A DISPLAY + INPUT layer over the existing managed-Chrome
// page CDP client. It mirrors the OWNING run's top-level page into the app via
// CDP `Page.startScreencast` and forwards user input back to the SAME page session via
// `Input.dispatch*`.
//
// It is NOT a new runtime: it opens no socket, owns no profile, creates no BrowserRun,
// and never selects a target across runs. It is strictly additive on top of the CDP
// clients that TargetManager already owns. Exactly ONE run is mirrored at a time (the
// selected browser); other runs keep executing unchanged in the background.
//
// Dependency-injected + Electron-free so it is unit-testable: the host supplies
// `resolvePageClient(runId) -> { client, targetId } | null` and an `onFrame` sink.
// ---------------------------------------------------------------------------

class PageScreencast {
  constructor(deps = {}) {
    this._resolvePageClient = deps.resolvePageClient || (() => null);
    this._onFrame = deps.onFrame || (() => {});
    this._onError = deps.onError || (() => {});
    this._opts = Object.assign({ format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 }, deps.opts || {});
    this._active = null;            // { runId, client, targetId }
    this._wired = new WeakSet();    // clients we've attached the frame listener to
    this._gen = 0;                  // bumped on every start/stop so stale frames are dropped
  }

  activeRunId() { return this._active ? this._active.runId : null; }

  // Start mirroring `runId`'s page. Stops any previous mirror first (single visible run).
  async start(runId, opts = {}) {
    const id = runId != null ? String(runId) : '';
    if (!id) return { ok: false, error: { code: 'RUN_NOT_FOUND', message: 'No run id for screencast' } };
    const resolved = this._resolvePageClient(id);
    if (!resolved || !resolved.client) return { ok: false, error: { code: 'SCREENCAST_TARGET_UNAVAILABLE', message: 'No page target for this browser yet' } };
    // If already mirroring this exact run, treat as a viewport update (restart params).
    if (this._active && this._active.runId === id && this._active.client === resolved.client) {
      return this._begin(resolved.client, opts);
    }
    await this.stop();
    this._active = { runId: id, client: resolved.client, targetId: resolved.targetId };
    return this._begin(resolved.client, opts);
  }

  async _begin(client, opts) {
    const gen = ++this._gen;
    const params = Object.assign({}, this._opts, sanitizeOpts(opts));
    try {
      await client.Page.enable();
    } catch (e) { /* Page may already be enabled */ }
    if (!this._wired.has(client)) {
      this._wired.add(client);
      client.Page.screencastFrame((frame) => this._handleFrame(client, gen, frame));
    }
    try {
      await client.Page.startScreencast({ format: params.format, quality: params.quality, maxWidth: params.maxWidth, maxHeight: params.maxHeight, everyNthFrame: params.everyNthFrame });
      return { ok: true, runId: this._active ? this._active.runId : null };
    } catch (e) {
      return { ok: false, error: { code: 'SCREENCAST_START_FAILED', message: String(e && e.message || e) } };
    }
  }

  _handleFrame(client, gen, frame) {
    // Always ack so Chrome keeps sending; drop the frame if it is stale (a newer
    // start/stop happened) or belongs to a client that is no longer the active mirror.
    const ack = () => { try { client.Page.screencastFrameAck({ sessionId: frame.sessionId }); } catch { /* ignore */ } };
    ack();
    if (gen !== this._gen || !this._active || this._active.client !== client) return;
    try { this._onFrame({ runId: this._active.runId, data: frame.data, metadata: frame.metadata || {} }); }
    catch (e) { this._onError({ code: 'SCREENCAST_FRAME_SINK_FAILED', message: String(e && e.message || e) }); }
  }

  // Stop the current mirror (no-op when idle). Bumps gen so in-flight frames are dropped.
  async stop() {
    this._gen++;
    const active = this._active;
    this._active = null;
    if (active && active.client) {
      try { await active.client.Page.stopScreencast(); } catch { /* client may be gone */ }
    }
    return { ok: true };
  }

  // If the mirrored run is closed/detached, clear so we don't paint a dead run.
  onRunGone(runId) {
    if (this._active && this._active.runId === String(runId)) { this.stop().catch(() => {}); }
  }

  // Forward one input event to the page client that OWNS `runId` (resolved fresh so it is
  // always the correct per-run session; never a global/last socket). Only the mirrored run
  // accepts input (display-bound), which also prevents background runs from being driven.
  async input(runId, ev = {}) {
    const id = runId != null ? String(runId) : '';
    if (!this._active || this._active.runId !== id) return { ok: false, error: { code: 'SCREENCAST_NOT_ACTIVE', message: 'This browser is not the mirrored view' } };
    const client = this._active.client;
    try {
      if (ev.kind === 'mouse') {
        await client.Input.dispatchMouseEvent(pickMouse(ev));
      } else if (ev.kind === 'wheel') {
        await client.Input.dispatchMouseEvent(Object.assign({ type: 'mouseWheel' }, pickMouse(ev), { deltaX: num(ev.deltaX), deltaY: num(ev.deltaY) }));
      } else if (ev.kind === 'key') {
        await client.Input.dispatchKeyEvent(pickKey(ev));
      } else {
        return { ok: false, error: { code: 'SCREENCAST_BAD_INPUT', message: 'Unknown input kind' } };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: { code: 'SCREENCAST_INPUT_FAILED', message: String(e && e.message || e) } };
    }
  }
}

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function sanitizeOpts(o = {}) {
  const out = {};
  if (Number.isFinite(Number(o.maxWidth))) out.maxWidth = Math.max(64, Math.min(4096, Math.round(Number(o.maxWidth))));
  if (Number.isFinite(Number(o.maxHeight))) out.maxHeight = Math.max(64, Math.min(4096, Math.round(Number(o.maxHeight))));
  if (Number.isFinite(Number(o.quality))) out.quality = Math.max(10, Math.min(100, Math.round(Number(o.quality))));
  return out;
}
// Whitelist the exact CDP fields (never forward arbitrary renderer objects to CDP).
function pickMouse(ev) {
  const m = { type: String(ev.type || ''), x: num(ev.x), y: num(ev.y) };
  if (ev.button) m.button = String(ev.button);
  if (ev.buttons != null) m.buttons = num(ev.buttons);
  if (ev.clickCount != null) m.clickCount = num(ev.clickCount);
  if (ev.modifiers != null) m.modifiers = num(ev.modifiers);
  return m;
}
function pickKey(ev) {
  const k = { type: String(ev.type || '') };
  if (ev.text != null) k.text = String(ev.text);
  if (ev.key != null) k.key = String(ev.key);
  if (ev.code != null) k.code = String(ev.code);
  if (ev.windowsVirtualKeyCode != null) k.windowsVirtualKeyCode = num(ev.windowsVirtualKeyCode);
  if (ev.nativeVirtualKeyCode != null) k.nativeVirtualKeyCode = num(ev.nativeVirtualKeyCode);
  if (ev.modifiers != null) k.modifiers = num(ev.modifiers);
  if (ev.autoRepeat != null) k.autoRepeat = !!ev.autoRepeat;
  return k;
}

module.exports = { PageScreencast };
