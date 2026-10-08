'use strict';

const EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// PhomClusterCdpManager (§7–13) — the CONTROL-PLANE owner of the three-profile
// cluster. It coordinates lifecycle + agent/proxy fan-out + event aggregation,
// but keeps THREE fully independent CDP connections (one per BrowserRun): it never
// opens a shared CDP session, never routes one client's command to another profile.
//
// It REUSES existing owners (no second BrowserRun/CDP implementation):
//   - deps.openProfile(slot,cfg)         -> opens a BrowserRun (custom Chromium)
//   - deps.getRunClient(runId)           -> that run's OWN CDP client
//   - deps.applyAgentToClient(client,a)  -> applies that browser's agent (web/mobile UA)
//   - deps.hostSession                   -> HostSessionManager (game orchestration)
//   - deps.closeRun(runId)               -> teardown one owned run
//
// Fan-out results are per-profile: a partial success is reported PARTIAL, never
// promoted to full success, and one profile's result is never copied to another.
// ---------------------------------------------------------------------------

const SLOTS = Object.freeze(['A', 'B', 'C']);
// RESERVE browsers (the 4th/5th ticked profile): open and logged in, NOT playing — they wait behind the Phỏm tool
// until the user swaps one into a playing slot (swapSlot).
const RESERVES = Object.freeze(['D', 'E']);

class PhomClusterCdpManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._now = deps.now || (() => Date.now());
    this._openProfile = deps.openProfile || (async () => ({ ok: false, error: { code: 'PHOM_CLUSTER_NO_OPENER', message: 'no openProfile' } }));
    this._getRunClient = deps.getRunClient || (() => null);
    this._applyAgentToClient = deps.applyAgentToClient || (async () => ({ applied: [], unsupported: [] }));
    this._closeRun = deps.closeRun || (async () => {});
    this._host = deps.hostSession || null;
    this._runInfo = deps.getRunInfo || (() => null); // (runId) -> { pid, port, userDataDir }

    this._cluster = null; // { clusterSessionId, hostSlot, selectedStake, slots:Map, stopped }
  }

  active() { return !!this._cluster && !this._cluster.stopped; }
  clusterSessionId() { return this._cluster ? this._cluster.clusterSessionId : null; }

  // §8 createCluster — define the three slots (profile refs + agent + proxy). Does not
  // open browsers yet.
  createCluster(config = {}) {
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const bySlot = new Map(profiles.map((p) => [p.slot, p]));
    if (SLOTS.some((s) => !bySlot.has(s))) return { ok: false, error: { code: 'PHOM_CLUSTER_INCOMPLETE', message: 'exactly slots A/B/C are required' } };
    // IDEMPOTENT RE-ENTRY (browser-lifetime independence): if a cluster is already OPEN
    // (at least one live run), a second RUN GAME must REUSE it — never teardown+recreate,
    // never close/reopen the browsers. Only orchestration is re-armable; the browsers keep
    // running until the user closes a window or invokes the explicit ĐÓNG 3 TRÌNH DUYỆT.
    if (this._cluster && !this._cluster.stopped) {
      const openRuns = SLOTS.filter((s) => this._cluster.slots.get(s).profileId).length;
      if (openRuns > 0) {
        this._emit();
        return { ok: true, reused: true, clusterSessionId: this._cluster.clusterSessionId, hostSlot: this._cluster.hostSlot };
      }
    }
    const hostSlot = SLOTS.includes(config.hostSlot) ? config.hostSlot : 'A';
    const clusterGameUrl = config.gameUrl != null ? config.gameUrl : null;
    const slots = new Map();
    const entry = (s, p, role) => ({ slot: s, profileId: null,
        // Authoritative launch identity from the saved profile projection (§3): the
        // browser profile key (user-data-dir/agent/proxy owner) and the shared game
        // URL travel WITH the slot so openProfile never re-derives from the slot letter.
        browserProfileId: p.browserProfileId || null,
        gameUrl: p.gameUrl != null ? p.gameUrl : clusterGameUrl,
        label: p.label || `Profile ${s}`,
        proxyRef: p.proxyRef || null, agent: p.agent || null,
        role, cdpConnected: false, agentApplied: null, error: null, lastSeq: -1 });
    for (const s of SLOTS) slots.set(s, entry(s, bySlot.get(s), s === hostSlot ? 'HOST' : 'FOLLOWER'));
    const reserves = new Map();
    (Array.isArray(config.reserves) ? config.reserves : []).slice(0, RESERVES.length).forEach((p, i) => reserves.set(RESERVES[i], entry(RESERVES[i], p, 'RESERVE')));
    this._cluster = { clusterSessionId: `PHOMCLU-${this._now()}`, clusterProfileId: config.clusterProfileId || null, hostSlot, selectedStake: config.selectedStake != null ? config.selectedStake : null, gameUrl: clusterGameUrl, slots, reserves, stopped: false };
    this._emit();
    return { ok: true, clusterSessionId: this._cluster.clusterSessionId, hostSlot };
  }

  _guard() { return this._cluster && !this._cluster.stopped; }
  _slot(s) { return this._cluster ? (this._cluster.slots.get(s) || this._cluster.reserves.get(s) || null) : null; }
  _reserveKeys() { return this._cluster ? [...this._cluster.reserves.keys()] : []; }

  // §8/§13 openCluster — fan-out open the three BrowserRuns. PARTIAL if not all three.
  async openCluster() {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const results = [];
    for (const s of SLOTS) {
      const slot = this._slot(s);
      // Idempotent: a slot with a LIVE run is REUSED, never reopened (§11). A slot the user
      // CLOSED is re-openable (§10) — reset it and open a fresh run for THAT slot only.
      if (slot.profileId && !slot.browserClosed) { results.push({ slot: s, ok: true, reused: true, runId: slot.profileId }); continue; }
      if (slot.browserClosed) { slot.browserClosed = false; slot.profileId = null; slot.cdpConnected = false; slot.error = null; }
      let res;
      try { res = await this._openProfile(s, { proxyRef: slot.proxyRef, browserProfileId: slot.browserProfileId, gameUrl: slot.gameUrl, agent: slot.agent, label: slot.label }); } catch (e) { res = { ok: false, error: { code: 'PHOM_CHROMIUM_LAUNCH_FAILED', message: safe(e) } }; }
      // A launch failure NEVER closes the slots that already opened (§14): record the
      // typed error for THIS slot and keep every opened browser alive (PARTIAL).
      if (res && res.ok) { slot.profileId = res.runId; slot.error = null; }
      else { slot.error = (res && res.error) || { code: 'PHOM_CHROMIUM_LAUNCH_FAILED' }; }
      results.push({ slot: s, ...res });
    }
    // reserves open once with the cluster; one the user closed stays closed
    for (const s of this._reserveKeys()) {
      const r = this._slot(s);
      if (r.profileId || r.browserClosed) continue;
      let res;
      try { res = await this._openProfile(s, { proxyRef: r.proxyRef, browserProfileId: r.browserProfileId, gameUrl: r.gameUrl, agent: r.agent, label: r.label }); } catch (e) { res = { ok: false, error: { code: 'PHOM_CHROMIUM_LAUNCH_FAILED', message: safe(e) } }; }
      if (res && res.ok) { r.profileId = res.runId; r.error = null; } else { r.error = (res && res.error) || { code: 'PHOM_CHROMIUM_LAUNCH_FAILED' }; }
      results.push({ slot: s, reserve: true, ...res });
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

  // §12/§13 applyClusterAgents — fan-out the browser agent through each profile's OWN client.
  // Never copies one slot's result to another; PARTIAL if any slot fails. The WEB agent applies
  // nothing by design (the browser keeps its own identity), so it counts as applied.
  async applyClusterAgents() {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const results = [];
    for (const s of SLOTS) {
      const slot = this._slot(s);
      const client = slot.profileId ? this._getRunClient(slot.profileId) : null;
      if (!client) { slot.agentApplied = { ok: false }; results.push({ slot: s, ok: false, error: { code: 'PHOM_CLUSTER_NO_CLIENT' } }); continue; }
      let r;
      try { r = await this._applyAgentToClient(client, slot.agent); } catch (e) { r = { error: { code: 'PHOM_AGENT_APPLY_FAILED', message: safe(e) } }; }
      const okApplied = !!(r && Array.isArray(r.applied) && !(r.unsupported || []).length);
      slot.agentApplied = { ok: okApplied, applied: r && r.applied, unsupported: r && r.unsupported };
      results.push({ slot: s, ok: okApplied, applied: r && r.applied, unsupported: r && r.unsupported });
    }
    this._emit();
    const applied = results.filter((r) => r.ok).length;
    return { ok: applied === 3, applied, results };
  }

  // §9 event envelope — normalize + validate one per-profile CDP frame. Old cluster /
  // wrong profile / duplicate / late-round events are rejected BEFORE any mutation.
  ingestEvent(profileId, meta = {}) {
    if (!this._guard()) return { accepted: false, reason: 'CLUSTER_INACTIVE' };
    const slot = this._slotForRun(profileId);
    if (!slot) return { accepted: false, reason: 'PROFILE_NOT_IN_CLUSTER' };
    if (meta.clusterSessionId && meta.clusterSessionId !== this._cluster.clusterSessionId) return { accepted: false, reason: 'STALE_CLUSTER_SESSION' };
    // seq is monotonic per capture: a frame at or below the last one seen is a duplicate or a late one. (3.2: the
    // per-slot `seen` Set that kept EVERY frame key — ~15/s per browser, never pruned — is gone; this check alone
    // already refused every duplicate.)
    const seq = Number.isFinite(meta.seq) ? meta.seq : null;
    if (seq != null && seq <= slot.lastSeq) return { accepted: false, reason: seq === slot.lastSeq ? 'DUPLICATE' : 'OUT_OF_ORDER' };
    if (seq != null) slot.lastSeq = seq;
    const envelope = {
      clusterSessionId: this._cluster.clusterSessionId, profileId, slot: slot.slot,
      browserRunId: profileId, targetId: meta.targetId || null, cdpSessionId: meta.cdpSessionId || null,
      roundIdentity: meta.roundIdentity || null, sequence: seq, receivedAt: this._now(), frame: meta.raw != null ? meta.raw : null,
    };
    // Route to the host session (updates ONLY this profile's state), then recompute aggregate.
    let cls = null;
    try { if (this._host) cls = this._host.routeFrame({ id: profileId }, { isWebSocket: true, wsDirection: meta.direction || 'recv', seq, targetId: meta.targetId, cdpSessionId: meta.cdpSessionId, url: meta.url, body: { raw: meta.raw } }); } catch { /* isolation: never throw across profiles */ }
    // N2 — a game frame never changes the CLUSTER (browsers/slots/proxies): no snapshot + IPC per frame (it was
    // ~15 frames/s per browser). The Phỏm state that a frame does change is pushed by the host session, throttled.
    return { accepted: true, envelope, classified: cls };
  }

  // §10 — ONE run's Chrome exited for real (routed here from the launcher's classified
  // exit). Mark ONLY that slot closed and record the HONEST reason — never blanket
  // CLOSED_BY_USER. The other browsers are untouched; the slot is re-openable via
  // openCluster (reopen). A TRACKED_PID_REPLACED (bootstrap swap, browser still alive)
  // NEVER reaches here — the launcher keeps that run OPEN — so a live browser is never
  // mislabelled closed.
  markRunClosed(runId, reason) {
    const slot = this._slotForRun(runId);
    if (!slot) return { ok: false, reason: 'NOT_IN_CLUSTER' };
    slot.browserClosed = true;
    slot.exitReason = normalizeExitReason(reason);
    slot.cdpConnected = false;
    this._emit();
    return { ok: true, slot: slot.slot, exitReason: slot.exitReason };
  }

  // THAY PROFILE — point a slot that has no live browser (closed by the user, crashed, never opened) at another saved
  // profile: its own user-data-dir (= its own logged-in account), proxy, agent and game URL. openCluster then opens
  // ONLY that slot; the other two browsers are untouched. A profile already running in another slot is refused.
  reassignSlot(s, p = {}) {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const slot = this._slot(s);
    if (!slot) return { ok: false, error: { code: 'PHOM_SLOT_UNKNOWN', message: `unknown slot ${s}` } };
    if (slot.profileId && !slot.browserClosed) return { ok: false, error: { code: 'PHOM_SLOT_BUSY', message: 'Tắt trình duyệt của ô này trước khi thay profile.' } };
    if (!p.browserProfileId) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_FOUND', message: 'no profile' } };
    const inUse = [...SLOTS, ...this._reserveKeys()].find((o) => o !== s && this._slot(o).browserProfileId === p.browserProfileId && this._slot(o).profileId && !this._slot(o).browserClosed);
    if (inUse) return { ok: false, error: { code: 'PHOM_PROFILE_IN_USE', message: 'Profile này đang chạy ở ô khác.' } };
    slot.browserProfileId = p.browserProfileId;
    slot.label = p.label || slot.label;
    slot.proxyRef = p.proxyRef || null;
    slot.agent = p.agent || null;
    if (p.gameUrl != null) slot.gameUrl = p.gameUrl;
    slot.agentApplied = null; slot.error = null;
    this._emit();
    return { ok: true, slot: s, browserProfileId: slot.browserProfileId };
  }

  // N4 — reopen a CLOSED reserve (P4/P5) with its own profile; openCluster then opens only it.
  reopenReserve(r) {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    const res = this._cluster.reserves.get(r);
    if (!res) return { ok: false, error: { code: 'PHOM_SLOT_UNKNOWN', message: 'unknown reserve' } };
    if (res.profileId && !res.browserClosed) return { ok: false, error: { code: 'PHOM_SLOT_BUSY', message: 'Dự bị này đang mở.' } };
    const inUse = [...SLOTS, ...this._reserveKeys()].find((o) => o !== r && this._slot(o).browserProfileId === res.browserProfileId && this._slot(o).profileId && !this._slot(o).browserClosed);
    if (inUse) return { ok: false, error: { code: 'PHOM_PROFILE_IN_USE', message: 'Profile này đang chạy ở ô khác.' } };
    res.browserClosed = false; res.profileId = null; res.cdpConnected = false; res.error = null; res.exitReason = null;
    this._emit();
    return { ok: true, reserve: r };
  }

  // ĐỔI NGƯỜI CHƠI — a reserve browser takes a playing slot and the slot's browser becomes the reserve (both stay
  // open, nothing reloads). Returns the two runs so the caller moves the windows and swaps the Phỏm session member.
  swapSlot(s, r) {
    if (!this._guard()) return { ok: false, error: { code: 'PHOM_CLUSTER_NOT_ACTIVE', message: 'no cluster' } };
    if (!SLOTS.includes(s) || !this._cluster.reserves.has(r)) return { ok: false, error: { code: 'PHOM_SLOT_UNKNOWN', message: 'unknown slot' } };
    const a = this._slot(s), b = this._slot(r);
    if (!b.profileId || b.browserClosed) return { ok: false, error: { code: 'PHOM_RESERVE_NOT_OPEN', message: 'Trình duyệt dự bị này đã tắt.' } };
    const KEYS = ['profileId', 'browserProfileId', 'label', 'proxyRef', 'agent', 'gameUrl', 'browserClosed', 'exitReason', 'cdpConnected', 'agentApplied', 'error', 'lastSeq'];
    for (const k of KEYS) { const t = a[k]; a[k] = b[k]; b[k] = t; }
    this._emit();
    return { ok: true, slot: s, reserve: r, playingRun: a.profileId, benchedRun: b.profileId && !b.browserClosed ? b.profileId : null };
  }

  // §13 stopCluster — EXPLICIT browser close (ĐÓNG 3 TRÌNH DUYỆT / app shutdown). This is
  // the ONLY manager path that closes the owned runs. Tears down ONLY owned runs, idempotent.
  async stopCluster() {
    if (!this._cluster) return { ok: true, alreadyStopped: true };
    if (this._cluster.stopped) return { ok: true, alreadyStopped: true };
    this._cluster.stopped = true;
    try { if (this._host && this._host.stop) this._host.stop(); } catch { /* ignore */ }
    const closed = [];
    for (const s of [...SLOTS, ...this._reserveKeys()]) {
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
    const profiles = {};
    for (const s of SLOTS) {
      const slot = c.slots.get(s);
      const info = slot.profileId ? (this._runInfo(slot.profileId) || {}) : {};
      // Per-slot BROWSER state is independent of orchestration: OPEN once a run exists,
      // else NOT_OPEN. (User-close/crash flips it via the run's own exit -> onRunExit.)
      profiles[s] = {
        slot: s, role: slot.role, profileId: slot.profileId,
        // which saved profile this slot runs (THAY PROFILE changes it), for the tool's "free profiles" list
        deviceProfileId: slot.browserProfileId || null, label: slot.label || null,
        browserState: slot.browserClosed ? exitReasonToBrowserState(slot.exitReason) : (slot.profileId ? 'OPEN' : 'NOT_OPEN'),
        exitReason: slot.browserClosed ? (slot.exitReason || 'UNKNOWN_EXIT') : null,
        pid: info.pid != null ? info.pid : null, cdpPort: info.port != null ? info.port : null, userDataDir: info.userDataDir || null,
        cdpConnected: slot.cdpConnected, agentApplied: slot.agentApplied ? !!slot.agentApplied.ok : false,
        agent: slot.agent || null,
        error: slot.error || null,
      };
    }
    const reserves = {};
    for (const [k, r] of c.reserves) reserves[k] = { slot: k, profileId: r.profileId, deviceProfileId: r.browserProfileId || null, label: r.label || null, browserState: r.browserClosed ? exitReasonToBrowserState(r.exitReason) : (r.profileId ? 'OPEN' : 'NOT_OPEN'), error: r.error || null };
    return {
      clusterSessionId: c.clusterSessionId, clusterProfileId: c.clusterProfileId || null, stopped: c.stopped,
      reserves,
      browserClusterState: c.stopped ? 'CLOSED' : 'OPEN',
      openBrowserCount: SLOTS.filter((s) => c.slots.get(s).profileId && !c.slots.get(s).browserClosed).length,
      closedByUserCount: SLOTS.filter((s) => c.slots.get(s).browserClosed).length,
      hostProfileId: c.slots.get(c.hostSlot).profileId, hostSlot: c.hostSlot,
      selectedStake: c.selectedStake,
      profiles,
      connectedCount: SLOTS.filter((s) => c.slots.get(s).cdpConnected).length,
      agentAppliedCount: SLOTS.filter((s) => c.slots.get(s).agentApplied && c.slots.get(s).agentApplied.ok).length,
      errors: SLOTS.map((s) => c.slots.get(s).error).filter(Boolean),
    };
  }

  _slotForRun(runId) { if (!this._cluster) return null; for (const s of [...SLOTS, ...this._reserveKeys()]) { const slot = this._slot(s); if (slot.profileId === runId) return slot; } return null; }
  // Announce the cluster only when it really changed (N2): identical snapshots are not re-sent to the tool window.
  _emit() {
    const snap = this.getClusterSnapshot();
    let key = null; try { key = JSON.stringify(snap); } catch { key = null; }
    if (key != null && key === this._lastEmitKey) return;
    this._lastEmitKey = key;
    this.emit('update', snap);
  }
}

function safe(e) { return String((e && e.message) || e || '').slice(0, 200); }

// The launcher's typed exit reasons, normalized (unknown/absent ⇒ UNKNOWN_EXIT — never
// silently promoted to a user close).
const EXIT_REASONS = Object.freeze(['APP_REQUESTED_CLOSE', 'USER_CLOSED_WINDOW', 'CHROMIUM_CRASH', 'PROFILE_LOCK', 'TRACKED_PID_REPLACED', 'UNKNOWN_EXIT']);
function normalizeExitReason(reason) {
  const r = reason && typeof reason === 'object' ? reason.reason : reason;
  return EXIT_REASONS.includes(r) ? r : 'UNKNOWN_EXIT';
}
// Map an honest exit reason to the per-slot browserState the UI renders. Only a genuine
// window close is CLOSED_BY_USER; every other death is a DISTINCT, non-user state.
function exitReasonToBrowserState(reason) {
  switch (normalizeExitReason(reason)) {
    case 'USER_CLOSED_WINDOW': return 'CLOSED_BY_USER';
    case 'APP_REQUESTED_CLOSE': return 'CLOSED_BY_APP';
    case 'CHROMIUM_CRASH': return 'CRASHED';
    case 'PROFILE_LOCK': return 'PROFILE_LOCK';
    default: return 'EXITED_UNEXPECTEDLY';
  }
}

module.exports = { PhomClusterCdpManager, SLOTS, RESERVES, normalizeExitReason, exitReasonToBrowserState };
