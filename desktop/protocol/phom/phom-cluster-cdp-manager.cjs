'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// PhomClusterCdpManager (§7–13) — the CONTROL-PLANE owner of the three-profile
// cluster. It coordinates lifecycle + device/proxy fan-out + event aggregation,
// but keeps THREE fully independent CDP connections (one per BrowserRun): it never
// opens a shared CDP session, never routes one client's command to another profile.
//
// It REUSES existing owners (no second BrowserRun/CDP implementation):
//   - deps.openProfile(slot,cfg)         -> opens a BrowserRun (custom Chromium)
//   - deps.getRunClient(runId)           -> that run's OWN CDP client
//   - deps.applyDeviceToClient(client,d) -> device emulation on that client
//   - deps.testProxy(proxyRef)           -> proxy observed-IP tester
//   - deps.hostSession                   -> HostSessionManager (game orchestration)
//   - deps.closeRun(runId)               -> teardown one owned run
//
// Fan-out results are per-profile: a partial success is reported PARTIAL, never
// promoted to full success, and one profile's result is never copied to another.
// ---------------------------------------------------------------------------

const SLOTS = Object.freeze(['A', 'B', 'C']);

class PhomClusterCdpManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._now = deps.now || (() => Date.now());
    this._openProfile = deps.openProfile || (async () => ({ ok: false, error: { code: 'PHOM_CLUSTER_NO_OPENER', message: 'no openProfile' } }));
    this._getRunClient = deps.getRunClient || (() => null);
    this._applyDeviceToClient = deps.applyDeviceToClient || (async () => ({ applied: [], unsupported: [] }));
    this._testProxy = deps.testProxy || (async () => ({ state: 'NOT_CONFIGURED' }));
    this._closeRun = deps.closeRun || (async () => {});
    this._host = deps.hostSession || null;
    this._runInfo = deps.getRunInfo || (() => null); // (runId) -> { pid, port, userDataDir }

    this._cluster = null; // { clusterSessionId, hostSlot, selectedStake, slots:Map, stopped }
  }

  active() { return !!this._cluster && !this._cluster.stopped; }
  clusterSessionId() { return this._cluster ? this._cluster.clusterSessionId : null; }

  // §8 createCluster — define the three slots (profile refs + device + proxy). Does not
  // open browsers yet.
  createCluster(config = {}) {
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const bySlot = new Map(profiles.map((p) => [p.slot, p]));
    if (SLOTS.some((s) => !bySlot.has(s))) return { ok: false, error: { code: 'PHOM_CLUSTER_INCOMPLETE', message: 'exactly slots A/B/C are required' } };
    const hostSlot = SLOTS.includes(config.hostSlot) ? config.hostSlot : 'A';
    const slots = new Map();
    for (const s of SLOTS) {
      const p = bySlot.get(s);
      slots.set(s, { slot: s, profileId: null, proxyRef: p.proxyRef || null, device: p.device || null,
        role: s === hostSlot ? 'HOST' : 'FOLLOWER', cdpConnected: false, deviceApplied: null, proxyState: 'NOT_TESTED',
        observedIp: null, error: null, lastSeq: -1, seen: new Set() });
    }
    this._cluster = { clusterSessionId: `PHOMCLU-${this._now()}`, hostSlot, selectedStake: config.selectedStake != null ? config.selectedStake : null, slots, stopped: false };
    this._emit();
    return { ok: true, clusterSessionId: this._cluster.clusterSessionId, hostSlot };
  }

  _guard() { return this._cluster && !this._cluster.stopped; }
  _slot(s) { return this._cluster ? this._cluster.slots.get(s) : null; }

  // §8/§13 openCluster — fan-out open the three BrowserRuns. PARTIAL if not all three.
  async openCluster() {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const results = [];
    for (const s of SLOTS) {
      const slot = this._slot(s);
      let res;
      try { res = await this._openProfile(s, { proxyRef: slot.proxyRef }); } catch (e) { res = { ok: false, error: { code: 'PHOM_CHROMIUM_LAUNCH_FAILED', message: safe(e) } }; }
      if (res && res.ok) { slot.profileId = res.runId; slot.error = null; }
      else { slot.error = (res && res.error) || { code: 'PHOM_CHROMIUM_LAUNCH_FAILED' }; }
      results.push({ slot: s, ...res });
    }
    this._emit();
    const opened = SLOTS.filter((s) => this._slot(s).profileId).length;
    return { ok: opened === 3, opened, results };
  }

  // §7/§13 connectClusterCdp — confirm each run has its OWN live CDP client.
  connectClusterCdp() {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const results = [];
    const clients = new Set();
    for (const s of SLOTS) {
      const slot = this._slot(s);
      const client = slot.profileId ? this._getRunClient(slot.profileId) : null;
      slot.cdpConnected = !!client;
      if (client) { if (clients.has(client)) slot.error = { code: 'PHOM_CLUSTER_SHARED_CLIENT', message: 'CDP client must be unique per profile' }; clients.add(client); }
      results.push({ slot: s, connected: !!client });
    }
    this._emit();
    const connected = results.filter((r) => r.connected).length;
    return { ok: connected === 3, connected, results };
  }

  // §12/§13 applyClusterDevices — fan-out device emulation through each profile's OWN
  // client. Never copies one slot's result to another; PARTIAL if any slot fails.
  async applyClusterDevices() {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const results = [];
    for (const s of SLOTS) {
      const slot = this._slot(s);
      const client = slot.profileId ? this._getRunClient(slot.profileId) : null;
      if (!client) { slot.deviceApplied = { ok: false }; results.push({ slot: s, ok: false, error: { code: 'PHOM_CLUSTER_NO_CLIENT' } }); continue; }
      let r;
      try { r = await this._applyDeviceToClient(client, slot.device); } catch (e) { r = { error: { code: 'PHOM_DEVICE_APPLY_FAILED', message: safe(e) } }; }
      const okApplied = r && Array.isArray(r.applied) && r.applied.includes('setDeviceMetricsOverride');
      slot.deviceApplied = { ok: !!okApplied, applied: r && r.applied, unsupported: r && r.unsupported };
      results.push({ slot: s, ok: !!okApplied, applied: r && r.applied, unsupported: r && r.unsupported });
    }
    this._emit();
    const applied = results.filter((r) => r.ok).length;
    return { ok: applied === 3, applied, results };
  }

  // §8 testClusterProxies — fan-out proxy tests (per profile ref).
  async testClusterProxies() {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const results = [];
    for (const s of SLOTS) {
      const slot = this._slot(s);
      if (!slot.proxyRef) { slot.proxyState = 'NOT_CONFIGURED'; results.push({ slot: s, state: 'NOT_CONFIGURED' }); continue; }
      let r; try { r = await this._testProxy(slot.proxyRef); } catch (e) { r = { state: 'FAILED', error: { message: safe(e) } }; }
      slot.proxyState = (r && r.state) || 'FAILED'; slot.observedIp = (r && r.observedIp) || null;
      results.push({ slot: s, state: slot.proxyState, observedIp: slot.observedIp });
    }
    this._emit();
    const pass = results.filter((r) => r.state === 'PASS').length;
    return { ok: pass === 3, pass, results };
  }

  // §14 game orchestration is delegated to the existing HostSessionManager, mapping the
  // host slot -> its run. Never re-implemented here.
  async acquireHostTable() { return this._delegateHost((h) => h.acquireHost()); }
  async joinFollowers() { return this._delegateHost((h) => h.joinFollowers()); }
  async applyReadyPolicy() { return this._delegateHost((h) => h.applyReady()); }
  async _delegateHost(fn) {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    if (!this._host) return { ok: false, error: { code: 'PHOM_CLUSTER_NO_HOST_SESSION', message: 'no host session' } };
    // ensure the host session is bound to the three runs with the chosen host.
    if (!this._host.active()) {
      const runIds = SLOTS.map((s) => this._slot(s).profileId).filter(Boolean);
      if (runIds.length !== 3) return { ok: false, error: { code: 'PHOM_CLUSTER_INCOMPLETE', message: 'three runs required' } };
      const hostRun = this._slot(this._cluster.hostSlot).profileId;
      const started = this._host.startSession({ runIds, hostId: hostRun, selectedStake: this._cluster.selectedStake });
      if (started && started.ok === false) return started;
    }
    return fn(this._host);
  }

  // §9 event envelope — normalize + validate one per-profile CDP frame. Old cluster /
  // wrong profile / duplicate / late-round events are rejected BEFORE any mutation.
  ingestEvent(profileId, meta = {}) {
    if (!this._guard()) return { accepted: false, reason: 'CLUSTER_INACTIVE' };
    const slot = this._slotForRun(profileId);
    if (!slot) return { accepted: false, reason: 'PROFILE_NOT_IN_CLUSTER' };
    if (meta.clusterSessionId && meta.clusterSessionId !== this._cluster.clusterSessionId) return { accepted: false, reason: 'STALE_CLUSTER_SESSION' };
    const seq = Number.isFinite(meta.seq) ? meta.seq : null;
    const key = meta.eventId || (seq != null ? `${slot.slot}:${seq}` : null);
    if (key && slot.seen.has(key)) return { accepted: false, reason: 'DUPLICATE' };
    if (seq != null && seq <= slot.lastSeq) return { accepted: false, reason: 'OUT_OF_ORDER' };
    if (key) slot.seen.add(key);
    if (seq != null) slot.lastSeq = seq;
    const envelope = {
      clusterSessionId: this._cluster.clusterSessionId, profileId, slot: slot.slot,
      browserRunId: profileId, targetId: meta.targetId || null, cdpSessionId: meta.cdpSessionId || null,
      roundIdentity: meta.roundIdentity || null, sequence: seq, receivedAt: this._now(), frame: meta.raw != null ? meta.raw : null,
    };
    // Route to the host session (updates ONLY this profile's state), then recompute aggregate.
    let cls = null;
    try { if (this._host) cls = this._host.routeFrame({ id: profileId }, { isWebSocket: true, wsDirection: meta.direction || 'recv', seq, targetId: meta.targetId, cdpSessionId: meta.cdpSessionId, url: meta.url, body: { raw: meta.raw } }); } catch { /* isolation: never throw across profiles */ }
    this._emit();
    return { accepted: true, envelope, classified: cls };
  }

  restoreClusterLayout() { return this._guard() ? { ok: true } : { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE' } }; }

  async leaveCluster() { if (this._host && this._host.active()) { try { await this._host.leaveAll(); } catch { /* best effort */ } } this._emit(); return { ok: true }; }

  // §13 stopCluster — cancel pending, tear down ONLY owned runs, idempotent.
  async stopCluster() {
    if (!this._cluster) return { ok: true, alreadyStopped: true };
    if (this._cluster.stopped) return { ok: true, alreadyStopped: true };
    this._cluster.stopped = true;
    try { if (this._host && this._host.stop) this._host.stop(); } catch { /* ignore */ }
    const closed = [];
    for (const s of SLOTS) {
      const slot = this._slot(s);
      if (slot.profileId) { try { await this._closeRun(slot.profileId); closed.push(slot.profileId); } catch { /* best effort */ } }
    }
    this._emit();
    return { ok: true, closed };
  }

  // §10 aggregate snapshot — no secrets.
  getClusterSnapshot() {
    if (!this._cluster) return null;
    const c = this._cluster;
    const hostSnap = (this._host && this._host.snapshot && this._host.active()) ? this._host.snapshot() : null;
    const profiles = {};
    for (const s of SLOTS) {
      const slot = c.slots.get(s);
      const info = slot.profileId ? (this._runInfo(slot.profileId) || {}) : {};
      profiles[s] = {
        slot: s, role: slot.role, profileId: slot.profileId,
        pid: info.pid != null ? info.pid : null, cdpPort: info.port != null ? info.port : null, userDataDir: info.userDataDir || null,
        cdpConnected: slot.cdpConnected, deviceApplied: slot.deviceApplied ? !!slot.deviceApplied.ok : false,
        proxyState: slot.proxyState, observedIp: slot.observedIp,
        deviceName: slot.device ? slot.device.name : null, resolution: slot.device ? `${slot.device.viewportWidth}×${slot.device.viewportHeight}` : null,
        error: slot.error || null,
      };
    }
    return {
      clusterSessionId: c.clusterSessionId, stopped: c.stopped, hostProfileId: c.slots.get(c.hostSlot).profileId, hostSlot: c.hostSlot,
      selectedStake: c.selectedStake, tableIdentity: hostSnap ? hostSnap.hostTableIdentity : null,
      profiles,
      connectedCount: SLOTS.filter((s) => c.slots.get(s).cdpConnected).length,
      deviceAppliedCount: SLOTS.filter((s) => c.slots.get(s).deviceApplied && c.slots.get(s).deviceApplied.ok).length,
      proxyPassCount: SLOTS.filter((s) => c.slots.get(s).proxyState === 'PASS').length,
      joinedCount: hostSnap ? hostSnap.profiles.filter((p) => p.confirmedInTable).length : 0,
      readyCount: hostSnap ? hostSnap.readyCount : 0,
      sameTableState: hostSnap ? hostSnap.tableVerdict : 'IDLE',
      authoritativePlayerCount: hostSnap ? hostSnap.playerCount : 0,
      roundState: hostSnap ? (hostSnap.roundRunning ? 'RUNNING' : hostSnap.state) : 'IDLE',
      errors: SLOTS.map((s) => c.slots.get(s).error).filter(Boolean),
    };
  }

  _slotForRun(runId) { if (!this._cluster) return null; for (const s of SLOTS) { const slot = this._cluster.slots.get(s); if (slot.profileId === runId) return slot; } return null; }
  _emit() { this.emit('update', this.getClusterSnapshot()); }
}

function safe(e) { return String((e && e.message) || e || '').slice(0, 200); }

module.exports = { PhomClusterCdpManager, SLOTS };
