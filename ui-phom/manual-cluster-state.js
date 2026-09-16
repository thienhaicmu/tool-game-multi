/* PHASE 6.1 — MANUAL CLUSTER UI STATE (pure, no DOM, no IPC). The search lock + shared Room/RID logic
 * for the 3-browser manual control. Dual-mode: attaches to window.ManualClusterState in the renderer
 * and exports via CommonJS for node unit tests. It NEVER talks to the backend — the renderer applies
 * its decisions by calling phomQA.manualFind / manualJoin. No Host/Follower role; browsers are 1/2/3.
 *
 * State: { searchingBrowserId, sharedRid, sharedRidOwner }
 *   searchingBrowserId = the browser currently running a REAL find (cluster is locked while set)
 *   sharedRid          = the RID the FIRST successful finder landed in (authoritative ps[] only)
 *   sharedRidOwner     = that finder's browserId
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ManualClusterState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BUSY = ['SEARCHING', 'JOINING', 'RECONNECTING', 'LEAVING'];
  const sid = (v) => (v == null ? null : String(v));

  function create() { return { searchingBrowserId: null, sharedRid: null, sharedRidOwner: null, sharedStake: null }; }

  // Decide what a FIND click does for a browser (§8/§10/§31). If a shared RID already exists the click
  // JOINs it — never a second matchmaking. Otherwise it starts a REAL search and locks the cluster,
  // unless another browser is already searching (§4).
  function onFindStart(state, browserId) {
    const id = sid(browserId);
    if (state.sharedRid != null) return { state: { ...state }, action: 'JOIN_SHARED', rid: state.sharedRid };
    if (state.searchingBrowserId != null && state.searchingBrowserId !== id) return { state: { ...state }, action: 'BLOCKED', reason: 'ANOTHER_BROWSER_SEARCHING' };
    return { state: { ...state, searchingBrowserId: id }, action: 'SEARCH' };
  }

  // Apply the result of a REAL search. Success (authoritative ok+rid) publishes the shared RID ONCE
  // (§7/§12); the lock is always cleared for the searcher (§13 — never stuck).
  function onFindResult(state, browserId, result) {
    const id = sid(browserId);
    const next = { ...state };
    if (next.searchingBrowserId === id) next.searchingBrowserId = null;
    if (result && result.ok && result.rid != null && next.sharedRid == null) { next.sharedRid = result.rid; next.sharedRidOwner = id; if (result.stake != null) next.sharedStake = result.stake; }
    return next;
  }

  // Apply the result of a JOIN (shared or manual). Never changes ownership (§15); only clears a lock.
  function onJoinResult(state, browserId, _result) {
    const id = sid(browserId);
    const next = { ...state };
    if (next.searchingBrowserId === id) next.searchingBrowserId = null;
    return next;
  }

  // Reconcile against the authoritative per-browser snapshot (manualBrowserSnapshot):
  //  - unstick a search lock whose owner is no longer busy (terminal FOUND/FAILED/TIMEOUT/CANCELLED §13)
  //  - keep the shared RID only while at least one browser is JOINED on it; clear when ALL have left (§18)
  function reconcile(state, browsers) {
    const next = { ...state };
    const list = Array.isArray(browsers) ? browsers : [];
    if (next.searchingBrowserId != null) {
      const b = list.find((x) => sid(x.profileId) === next.searchingBrowserId);
      if (!b || !BUSY.includes(b.manualState)) next.searchingBrowserId = null;
    }
    if (next.sharedRid != null && list.length) {
      const anyJoined = list.some((x) => x.manualState === 'JOINED' && Number(x.rid) === Number(next.sharedRid));
      if (!anyJoined) { next.sharedRid = null; next.sharedRidOwner = null; next.sharedStake = null; }
    }
    return next;
  }

  // ---- button-enable derivations (§27/§32) ----
  function isBusy(b) { return !!b && BUSY.includes(b.manualState); }
  // TÌM BÀN disabled whenever ANY browser is searching (§27), or this browser is busy.
  function canFind(state, b) { if (!b) return false; if (state.searchingBrowserId != null) return false; return !isBusy(b); }
  function canJoin(state, b, ridInput) { if (!b || b.manualState === 'JOINING') return false; return ridInput != null && String(ridInput).trim() !== ''; }
  function canRejoin(state, b) { return !!(b && b.canRejoin) && !['JOINING', 'RECONNECTING'].includes(b.manualState); }
  function canLeave(state, b) { return !!b && b.manualState === 'JOINED'; }

  // PHASE 6.2.2 — the ONE business action for a browser card, from authoritative state (§2/§3/§5/§13):
  //   chromium closed            → MỞ CHROMIUM
  //   not in game (entering)     → ĐANG VÀO GAME…  (busy)
  //   not in game                → VÀO GAME
  //   in game, joined shared RID → THOÁT GAME
  //   in game, joining/searching → ĐANG VÀO BÀN… / ĐANG TÌM…  (busy)
  //   in game, shared RID exists → VÀO BÀN        (JOIN the shared RID — NEVER a new discovery, §3)
  //   in game, no shared RID     → TÌM BÀN        (real discovery)
  // ctx = { opened, inGame, entering }.
  function browserAction(state, b, ctx) {
    ctx = ctx || {};
    if (!ctx.opened) return { action: 'CLOSED', label: 'MỞ CHROMIUM' };
    if (ctx.entering) return { action: 'ENTERING', label: 'ĐANG VÀO GAME…', busy: true };
    if (!ctx.inGame) return { action: 'ENTER_GAME', label: 'VÀO GAME' };
    const s = b && b.manualState;
    const joinedShared = state.sharedRid != null && s === 'JOINED' && Number(b && b.rid) === Number(state.sharedRid);
    if (joinedShared) return { action: 'LEAVE', label: 'THOÁT GAME' };
    if (s === 'JOINING' || s === 'RECONNECTING') return { action: 'JOINING', label: 'ĐANG VÀO BÀN…', busy: true };
    if (s === 'SEARCHING') return { action: 'SEARCHING', label: '🔍 ĐANG TÌM…', busy: true };
    if (state.sharedRid != null) return { action: 'JOIN_SHARED', label: 'VÀO BÀN', rid: state.sharedRid };
    return { action: 'FIND', label: 'TÌM BÀN' };
  }

  // The FIND button label reflects the cluster state (§10/§28/§30): searching / join-shared / find.
  function findLabel(state, b) {
    if (b && b.manualState === 'SEARCHING') return '🔍 ĐANG TÌM BÀN…';
    if (state.sharedRid != null) return 'VÀO BÀN ' + state.sharedRid;
    return 'TÌM BÀN';
  }
  // The prefill RID for a browser's Room/RID input: its own rid, else the shared rid (§14).
  function prefillRid(state, b) { if (b && b.rid != null) return String(b.rid); if (state.sharedRid != null) return String(state.sharedRid); return ''; }

  return { create, onFindStart, onFindResult, onJoinResult, reconcile, canFind, canJoin, canRejoin, canLeave, findLabel, prefillRid, browserAction, BUSY };
});
