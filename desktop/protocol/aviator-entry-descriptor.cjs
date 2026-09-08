'use strict';

// ---------------------------------------------------------------------------
// Aviator ENTER via the SITE's OWN semantic tile-open — the sealed re-entry seam.
//
// Live acceptance proved a hand-crafted game-act fetch cannot re-enter: the site's game-act
// is authenticated by site-injected headers (X-FG-ID, X-TOKEN=session_id) that we must never
// reconstruct or store. Manual-click GROUND TRUTH (CDP initiator capture) proved the site's own
// lobby entry for Aviator is the game-icon click path (NOT the minigame strip):
//
//     __require("LobbyViewController").default.Instance.onClickIConGame(null, gameId)
//
// (first arg is unused by the site; second is the game id). It resolves the game via
// gameLaunchHandler.mapClickLobby — a CUSTOM map with .get/.set but NO .has/.size, so membership
// is `mapClickLobby.get(id) != null`. This drives the SITE's authenticated flow end-to-end:
//     game-act (with the site's own X-FG-ID/X-TOKEN)  →  lobbyPlugin 10002  →  aviatorPlugin 100000
//     →  fresh authoritative SERVER Aviator frames  →  ACTIVE
//
// This module is a CAPABILITY BOUNDARY, not a convenience API:
//   - It invokes exactly ONE site routine (onClickIConGame) with the LEARNED, validated Aviator
//     gameId. No caller supplies a function name, module name, JS source, URL, body, frame, cmd or
//     arbitrary argument. The module + method + gameId are baked/validated here.
//   - RESOLVE-BEFORE-INVOKE: every attempt first runs READ-ONLY existence checks (require, module,
//     default, instance, method, tile registered). If ANY fails it returns ENTRY_SITE_SEAM_UNAVAILABLE
//     and invokes NOTHING — no fallback to a hand-crafted game-act, no direct 10002/100000 send.
//   - We perform NO fetch and send NO WS frame ourselves; the site's own code owns game-act, 10002
//     and 100000, using the site's own authenticated session. We never touch X-TOKEN/X-FG-ID.
//
// game_id lifecycle (see the runtimes): learned per-BrowserRun from the site's own game-act POST,
// validated, kept in memory, refreshed by any later genuine game-act, never persisted, never
// accepted from a renderer/IPC caller, gone when the run closes. If none learned yet, entry fails
// safe (ENTRY_NO_DESCRIPTOR) rather than inventing one.
// ---------------------------------------------------------------------------

// The Cocos module + method that own the site's authenticated lobby game entry (ground-truthed
// live via CDP initiator capture on a real Aviator tile click). The live singleton is `.Instance`
// (capital I) on the module default; the game-registration map is on `.gameLaunchHandler`.
const ENTRY_MODULE = 'LobbyViewController';
const ENTRY_METHOD = 'onClickIConGame';

// Reference-only: the frames the SITE itself emits during entry. We NEVER send these — they are
// kept for recognition/provenance/tests only (the sealed re-entry no longer transmits any frame).
const LOBBY_ENVELOPE = ['6', 'MiniGame', 'lobbyPlugin', { cmd: 10002 }];
const ENTER_ENVELOPE = ['6', 'MiniGame', 'aviatorPlugin', { cmd: 100000 }];
const LOBBY_FRAME = JSON.stringify(LOBBY_ENVELOPE);
const ENTER_FRAME = JSON.stringify(ENTER_ENVELOPE);

// Observed game-act endpoint path suffix; host/version vary per deployment so we retain the full
// learned URL and match by suffix. game_id is a short opaque product token (observed "vgmn_221").
const GAME_ACT_PATH = '/game-act';
const GAME_ID_RE = /^[A-Za-z0-9_]{1,40}$/;

function isGameActUrl(url) {
  try { return new URL(String(url)).pathname.endsWith(GAME_ACT_PATH); } catch { return false; }
}

// Learn the minimal validated entry descriptor from a genuine website game-act POST.
// Returns { gameActUrl, gameId } or null. Retains ONLY those two fields (no headers/cookies/auth).
function parseGameActDescriptor(url, rawBody) {
  if (!isGameActUrl(url)) return null;
  let gameId = null;
  try {
    const b = JSON.parse(String(rawBody == null ? '' : rawBody));
    if (b && typeof b.game_id === 'string') gameId = b.game_id;
  } catch { return null; }
  if (!gameId || !GAME_ID_RE.test(gameId)) return null;
  return { gameActUrl: String(url), gameId };
}

function isValidDescriptor(d) {
  return !!(d && typeof d.gameActUrl === 'string' && isGameActUrl(d.gameActUrl)
    && typeof d.gameId === 'string' && GAME_ID_RE.test(d.gameId));
}

// Build the SEALED, zero-argument page hook. It installs globalThis.__avEnterAviator() which:
//   1. runs READ-ONLY resolution of the site's own entry accessor, and
//   2. ONLY if every check passes, invokes onClickBaseMiniGameNode(<baked gameId>, null).
// It returns non-secret facts only: { ok, step?, resolve:{requireAvailable, moduleResolved,
// instanceResolved, methodResolved, tileRegistered}, invoked }. It performs no fetch and sends
// no WS frame. The gameId + module + method are baked literals — callers cannot substitute them.
function buildEnterAviatorHook(descriptor) {
  if (!isValidDescriptor(descriptor)) throw new Error('invalid entry descriptor');
  const GID = JSON.stringify(descriptor.gameId);
  const MOD = JSON.stringify(ENTRY_MODULE);
  return `(() => {
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : this;
    if (!g) return;
    var GID = ${GID}, MOD = ${MOD};
    g.__avEnterAviator = function () {
      var r = { requireAvailable:false, moduleResolved:false, instanceResolved:false, methodResolved:false, tileRegistered:null };
      try {
        if (typeof g.__require !== 'function') return { ok:false, step:'no-require', resolve:r };
        r.requireAvailable = true;
        var m; try { m = g.__require(MOD); } catch (e) { return { ok:false, step:'no-module', resolve:r }; }
        if (!m || !m.default) return { ok:false, step:'no-default', resolve:r };
        r.moduleResolved = true;
        var inst; try { inst = m.default.Instance; } catch (e) { return { ok:false, step:'no-instance', resolve:r }; }
        if (!inst) return { ok:false, step:'no-instance', resolve:r };
        r.instanceResolved = true;
        if (typeof inst.${ENTRY_METHOD} !== 'function') return { ok:false, step:'no-method', resolve:r };
        r.methodResolved = true;
        var glh = inst.gameLaunchHandler, kvp = glh && glh.mapClickLobby;
        r.tileRegistered = (kvp && typeof kvp.get === 'function') ? (kvp.get(GID) != null) : null;
        if (r.tileRegistered !== true) return { ok:false, step:'tile-not-registered', resolve:r };
        // All read-only checks passed — invoke the site's OWN lobby entry; it owns everything downstream.
        inst.${ENTRY_METHOD}(null, GID);
        return { ok:true, invoked:true, resolve:r };
      } catch (e) { return { ok:false, step:'invoke-error', resolve:r }; }
    };
  } catch (e) {}
})();`;
}

// Non-secret resolve facts are surfaced to onDiag ONLY (booleans + tileRegistered). The returned
// page value is NOT logged wholesale. Executes through a target's OWN CDP client (the BrowserRun
// game session). Returns { ok:true } | { error:{ code:'ENTRY_SITE_SEAM_UNAVAILABLE'|..., step? } }.
// SENT != ENTERED: a successful invoke does not confirm entry — the caller (gate) confirms only on
// fresh authoritative SERVER Aviator evidence after the attempt boundary.
async function runEnterAviatorViaSite(client, sessionId, descriptor, onDiag) {
  const diag = typeof onDiag === 'function' ? onDiag : () => {};
  if (!client || !client.Runtime || typeof client.Runtime.evaluate !== 'function') {
    return { error: { code: 'ENTER_NO_CLIENT', message: 'Target connection is gone' } };
  }
  if (!isValidDescriptor(descriptor)) {
    return { error: { code: 'ENTER_NO_DESCRIPTOR', message: 'No validated Aviator game id learned yet — enter Aviator once so it can be observed.' } };
  }
  let hook;
  try { hook = buildEnterAviatorHook(descriptor); } catch (e) { return { error: { code: 'ENTER_NO_DESCRIPTOR', message: String(e && e.message || e) } }; }
  try { await client.Runtime.evaluate({ expression: hook, includeCommandLineAPI: false }, sessionId); } catch { /* worker/detached — the call below still reports */ }
  const expr = "globalThis.__avEnterAviator ? globalThis.__avEnterAviator() : ({ ok:false, step:'no-hook' })";
  let v;
  try {
    const res = await client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    v = res && res.result && res.result.value;
  } catch (e) {
    return { error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', message: String(e && e.message || e), step: 'evaluate-error' } };
  }
  // Surface ONLY non-secret booleans (never the returned object wholesale / never page state).
  const rf = (v && v.resolve) || {};
  diag({ event: 'SITE_ENTRY_SEAM_RESOLVE', requireAvailable: !!rf.requireAvailable, moduleResolved: !!rf.moduleResolved, instanceResolved: !!rf.instanceResolved, methodResolved: !!rf.methodResolved, tileRegistered: rf.tileRegistered == null ? null : !!rf.tileRegistered });
  if (v && v.ok === true) {
    diag({ event: 'SITE_ENTRY_INVOKED' });
    return { ok: true };
  }
  return { error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', message: 'Site entry accessor did not resolve', step: v && v.step } };
}

module.exports = {
  ENTRY_MODULE, ENTRY_METHOD,
  LOBBY_ENVELOPE, ENTER_ENVELOPE, LOBBY_FRAME, ENTER_FRAME,
  GAME_ACT_PATH, GAME_ID_RE, isGameActUrl,
  parseGameActDescriptor, isValidDescriptor, buildEnterAviatorHook, runEnterAviatorViaSite,
};
