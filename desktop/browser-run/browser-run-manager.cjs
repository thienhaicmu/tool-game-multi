'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// BrowserRunManager — WU-A. Ownership layer for "Open Browser".
//
// Each press of Open Browser creates ONE BrowserRun that owns its browser
// process (its own ChromeLauncher + profile + CDP port), its own TargetManager,
// and its own protocol subsystem (aviator/protocolContext/observer/harness/
// autoRunner/amountValidator). Nothing here is a global singleton: two runs
// observe independently and never cross-contaminate.
//
// Shared, target-keyed resources (capture / intercept / wsReplay / replay /
// timeline / cookieVault) stay OUTSIDE this module — they are already keyed by
// the globally-unique CDP targetId. This manager just routes those shared frames
// to the right run via a targetId -> runId index (`runForTarget`).
//
// This module is dependency-injected and Electron/CDP-free so it is unit
// testable: main.cjs supplies the `createLauncher`, `createTargetManager` and
// `buildSubsystem` factories.
// ---------------------------------------------------------------------------

const STATUS = Object.freeze({
  STARTING: 'STARTING',
  CONNECTED: 'CONNECTED',
  WAITING_PROTOCOL: 'WAITING_PROTOCOL',
  READY: 'READY',
  AUTO_RUNNING: 'AUTO_RUNNING',
  TEST_RUNNING: 'TEST_RUNNING',
  DISCONNECTED: 'DISCONNECTED',
  CLOSED: 'CLOSED',
  ERROR: 'ERROR',
});

// Statuses a run never transitions out of (evidence stays available afterwards).
const TERMINAL = new Set([STATUS.CLOSED]);

class BrowserRunManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    // Factories (injected). Each returns the per-run object; none are singletons.
    this._createLauncher = deps.createLauncher || (() => { throw new Error('createLauncher factory is required'); });
    this._createTargetManager = deps.createTargetManager || (() => { throw new Error('createTargetManager factory is required'); });
    this._buildSubsystem = deps.buildSubsystem || (() => ({}));
    this._now = deps.now || (() => Date.now());

    this._runs = new Map();          // runId -> BrowserRun
    this._order = [];                 // creation order (for run #1 special-casing / UI)
    this._activeRunId = null;
    this._targetIndex = new Map();    // cdpTargetId -> runId
    this._seq = 0;
  }

  // ---- identity ----
  _nextId() { this._seq += 1; return 'BR-' + String(this._seq).padStart(4, '0'); }
  runCount() { return this._order.length; }

  // ---- run creation ----
  // Builds the per-run launcher + protocol subsystem. The TargetManager is
  // attached later (once the launcher yields a CDP endpoint) via setTargetManager.
  createRun({ launchUrl = '', browserId = null, profileDir = null } = {}) {
    const id = this._nextId();
    const ordinal = this._order.length; // 0 for the first run
    const run = {
      id,
      ordinal,
      // WU-C.1: the persistent browser that owns this runtime run (null for
      // Advanced Debug / external CDP attaches with no persistent identity).
      browserId: browserId != null ? String(browserId) : null,
      profileDir: profileDir != null ? String(profileDir) : null,
      status: STATUS.STARTING,
      createdAt: new Date(this._now()).toISOString(),
      endedAt: null,
      launchUrl: String(launchUrl || ''),
      launcher: null,
      cdpEndpoint: null,
      targetManager: null,
      selectedTargetId: null,
      error: null,
      // protocol subsystem (assigned below)
      aviator: null, protocolContext: null, observer: null,
      harness: null, autoRunner: null, amountValidator: null, entryGate: null,
      jackpotObserver: null, jackpotGate: null,
    };
    run.launcher = this._createLauncher(run);
    const subsystem = this._buildSubsystem(run) || {};
    run.aviator = subsystem.aviator || null;
    run.protocolContext = subsystem.protocolContext || null;
    run.observer = subsystem.observer || null;
    run.harness = subsystem.harness || null;
    run.autoRunner = subsystem.autoRunner || null;
    run.amountValidator = subsystem.amountValidator || null;
    run.entryGate = subsystem.entryGate || null;
    run.jackpotObserver = subsystem.jackpotObserver || null;
    run.jackpotGate = subsystem.jackpotGate || null;

    this._runs.set(id, run);
    this._order.push(id);
    if (!this._activeRunId) this._activeRunId = id;
    this.emit('run-created', this.summary(run));
    return run;
  }

  // Create and wire the run's own TargetManager against its endpoint.
  setTargetManager(run, endpoint) {
    if (!run || TERMINAL.has(run.status)) return null;
    run.cdpEndpoint = endpoint || run.cdpEndpoint;
    run.targetManager = this._createTargetManager(run.cdpEndpoint, run);
    return run.targetManager;
  }

  // ---- target routing (shared capture -> owning run) ----
  registerTarget(cdpTargetId, run) {
    if (cdpTargetId == null || !run) return;
    this._targetIndex.set(String(cdpTargetId), run.id);
    if (run.status === STATUS.STARTING) this.setStatus(run, STATUS.CONNECTED);
  }
  unregisterTarget(cdpTargetId) {
    if (cdpTargetId == null) return;
    this._targetIndex.delete(String(cdpTargetId));
  }
  runForTarget(cdpTargetId) {
    if (cdpTargetId == null) return null;
    const id = this._targetIndex.get(String(cdpTargetId));
    return id ? this._runs.get(id) || null : null;
  }
  targetsForRun(runId) {
    const out = [];
    for (const [tid, rid] of this._targetIndex) if (rid === runId) out.push(tid);
    return out;
  }

  // ---- active run (Option A: one active test run) ----
  activeRun() { return this._activeRunId ? this._runs.get(this._activeRunId) || null : null; }
  activeRunId() { return this._activeRunId; }
  setActive(runId) {
    if (!this._runs.has(runId)) return false;
    if (this._activeRunId === runId) return true;
    this._activeRunId = runId;
    this.emit('active-changed', runId);
    return true;
  }
  isActive(run) { return !!run && this._activeRunId === run.id; }

  get(runId) { return this._runs.get(runId) || null; }
  list() { return this._order.map((id) => this.summary(this._runs.get(id))).filter(Boolean); }

  // WU-C.1: the CURRENT live (non-terminal) run for a persistent browser, if any.
  // Used to enforce one live run per persistent browser and to join summaries.
  liveRunForBrowser(browserId) {
    if (browserId == null) return null;
    const bid = String(browserId);
    for (const id of this._order) {
      const run = this._runs.get(id);
      if (run && run.browserId === bid && !TERMINAL.has(run.status)) return run;
    }
    return null;
  }

  // ---- status ----
  setStatus(run, status) {
    if (!run || !STATUS[status] || TERMINAL.has(run.status)) return;
    if (run.status === status) return;
    run.status = status;
    this.emit('run-updated', this.summary(run));
  }
  failRun(run, error) {
    if (!run) return;
    run.error = error || { code: 'RUN_ERROR', message: 'Browser run failed' };
    this.setStatus(run, STATUS.ERROR);
  }

  // Called when a run loses all its targets (browser closed / disconnected) but
  // the run object + history is retained. Stops the run's own protocol activity
  // deterministically; never touches another run.
  disconnectRun(run) {
    if (!run || TERMINAL.has(run.status)) return;
    this._quiesceSubsystem(run);
    this.setStatus(run, STATUS.DISCONNECTED);
  }

  // Full teardown of a run: stop subsystem, detach its TargetManager, drop its
  // targets from the index. History (held inside the subsystem objects) is kept.
  async closeRun(runId, finalStatus = STATUS.CLOSED) {
    const run = this._runs.get(runId);
    if (!run || TERMINAL.has(run.status)) return;
    this._quiesceSubsystem(run);
    for (const tid of this.targetsForRun(runId)) this.unregisterTarget(tid);
    if (run.targetManager && run.targetManager.stop) {
      try { await run.targetManager.stop(); } catch { /* already gone */ }
    }
    if (run.launcher && run.launcher.close) {
      try { run.launcher.close(); } catch { /* best effort */ }
    }
    run.endedAt = new Date(this._now()).toISOString();
    run.status = finalStatus;
    this.emit('run-updated', this.summary(run));
    this.emit('run-closed', this.summary(run));
    // Hand the active flag to the most recent still-open run, if any.
    if (this._activeRunId === runId) {
      const next = [...this._order].reverse().find((id) => {
        const r = this._runs.get(id);
        return r && r.id !== runId && !TERMINAL.has(r.status);
      });
      this._activeRunId = next || null;
      this.emit('active-changed', this._activeRunId);
    }
  }

  // Stop this run's protocol activity without touching shared resources. Only THIS
  // run's runners are stopped and only THIS run's harness waiters are resolved.
  _quiesceSubsystem(run) {
    try { if (run.autoRunner && run.autoRunner.isRunning && run.autoRunner.isRunning()) run.autoRunner.stop(); } catch { /* ignore */ }
    try { if (run.amountValidator && run.amountValidator.isRunning && run.amountValidator.isRunning()) run.amountValidator.stop(); } catch { /* ignore */ }
    try { if (run.harness && run.harness.cancelWaiters) run.harness.cancelWaiters(); } catch { /* ignore */ }
    try { if (run.entryGate && run.entryGate.onDisconnect) run.entryGate.onDisconnect(); } catch { /* ignore */ }
    try { if (run.jackpotGate && run.jackpotGate.cancel) run.jackpotGate.cancel('DISCONNECTED'); } catch { /* ignore */ }
    try { if (run.jackpotObserver && run.jackpotObserver.onDisconnect) run.jackpotObserver.onDisconnect(); } catch { /* ignore */ }
    try { if (run.observer && run.observer.onDisconnect) run.observer.onDisconnect(); } catch { /* ignore */ }
  }

  // Compact, serialisable per-run summary for the run list / IPC. It is built from
  // the OWNING run's own state (observer/autoRunner/protocolContext), so every run's
  // live SID/ODD/status can be shown at once WITHOUT forwarding raw frames. Never
  // leaks the live CDP client.
  summary(run) {
    if (!run) return null;
    const cur = run.observer && run.observer.currentRound ? run.observer.currentRound() : null;
    let protocolReady = false;
    try { protocolReady = !!(run.protocolContext && run.protocolContext.get && run.protocolContext.get().ready); } catch { protocolReady = false; }
    return {
      id: run.id,
      browserId: run.browserId,
      status: run.status,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      launchUrl: run.launchUrl,
      host: runHost(run),
      active: this._activeRunId === run.id,
      selectedTargetId: run.selectedTargetId,
      cdpEndpoint: run.cdpEndpoint,
      protocolReady,
      currentSid: cur ? cur.sid : null,
      currentOdd: cur ? cur.currentOdd : null,
      phase: cur ? cur.phase : null,
      autoRunning: !!(run.autoRunner && run.autoRunner.isRunning && run.autoRunner.isRunning()),
      testRunning: !!(run.amountValidator && run.amountValidator.isRunning && run.amountValidator.isRunning()),
      aviatorEntered: !!(run.entryGate && run.entryGate.isEntered && run.entryGate.isEntered()),
      entryState: run.entryGate && run.entryGate.state ? run.entryGate.state() : 'NOT_ENTERED',
      currentJackpot: run.jackpotObserver && run.jackpotObserver.current ? run.jackpotObserver.current() : null,
      jackpotObservedAt: run.jackpotObserver && run.jackpotObserver.snapshot ? run.jackpotObserver.snapshot().jackpotObservedAt : null,
      jackpotGateState: run.jackpotGate && run.jackpotGate.state ? run.jackpotGate.state() : 'IDLE',
      jackpotThreshold: run.jackpotGate && run.jackpotGate.threshold ? run.jackpotGate.threshold() : null,
      error: run.error || null,
    };
  }
}

// Best-effort host identity for a run: the selected target's URL host, else the
// launch URL host. Never throws.
function runHost(run) {
  let url = '';
  try { const s = run.targetManager && run.targetManager.getSession && run.targetManager.getSession(run.selectedTargetId); url = (s && s.target && s.target.url) || ''; } catch { url = ''; }
  if (!url) url = run.launchUrl || '';
  try { return url ? new URL(url).host : ''; } catch { return ''; }
}

module.exports = { BrowserRunManager, STATUS };
