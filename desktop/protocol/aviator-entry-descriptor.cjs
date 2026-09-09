'use strict';

// ---------------------------------------------------------------------------
// Aviator ENTER via the live NewLobby's OWN Cocos scene node — the sealed re-entry seam.
//
// LIVE-PROVEN (end-to-end): the NewLobby page runs Cocos, and the Aviator tile is a real scene
// node whose name equals the game_id ("vgmn_221"). Firing that node's OWN wired Cocos Button
// click drives the site's authenticated flow (its own game-act with X-FG-ID/X-TOKEN → lobby 10002
// → aviator 100000 → fresh authoritative SERVER Aviator frames → ACTIVE). The proven operation is:
//
//     node = cc.find('Canvas/MainUIParent/NewLobby/Main/ScrollView/view/Content/NodeSpines/'+GID)
//            (or a bounded live-scene search for a node named GID that has cc.Button)
//     btn  = node.getComponent(cc.Button)
//     cc.Component.EventHandler.emitEvents(btn.clickEvents, node);   // fire the wired handlers
//     node.emit('click', btn);                                       // + the node's click event
//
// Live result: CLICKED vgmn_221 → fresh SERVER cmd:100009 → Aviator entered. Both event calls are
// the proven invocation and are preserved verbatim (no A/B trimming, no simplification).
//
// This module is a CAPABILITY BOUNDARY, not a convenience API:
//   - It fires exactly ONE thing: the Aviator scene node's OWN cc.Button, resolved by the LEARNED,
//     validated Aviator gameId (== the node name). No caller supplies a node path/name, function,
//     module, JS source, URL, body, frame, cmd, coordinates or arbitrary argument — all baked here.
//   - RESOLVE-BEFORE-INVOKE: every attempt first runs READ-ONLY existence checks (cc, cc.director,
//     the emitter, node resolved by path OR bounded scene search, cc.Button, btn.clickEvents). If ANY
//     fails it returns ENTRY_SITE_SEAM_UNAVAILABLE and invokes NOTHING — no hand-crafted game-act,
//     no direct 10002/100000 send, no pixel-coordinate click.
//   - We perform NO fetch and send NO WS frame ourselves; the site's own click handlers own game-act,
//     10002 and 100000, using the site's own authenticated session. We never touch X-TOKEN/X-FG-ID.
//
// game_id lifecycle (see the runtimes): learned per-BrowserRun from the site's own game-act POST,
// validated, kept in memory, refreshed by any later genuine game-act, never persisted, never
// accepted from a renderer/IPC caller, gone when the run closes. If none learned yet, entry fails
// safe (ENTER_NO_DESCRIPTOR) rather than inventing one. The learned game_id is also the Aviator
// scene node's name, so it drives both the known path and the bounded scene fallback.
// ---------------------------------------------------------------------------

// The live-proven NewLobby scene path to the Aviator node (the learned game_id is appended as the
// leaf name). If this exact path is absent in a given build, a bounded scene search is the fallback.
const COCOS_KNOWN_PATH_PREFIX = 'Canvas/MainUIParent/NewLobby/Main/ScrollView/view/Content/NodeSpines/';
// Bounded max traversal depth for the live-scene fallback (matches the proven operation's cap).
const COCOS_MAX_DEPTH = 10;

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

// The LIVE-PROVEN Aviator scene-node name for this product/site (== the Aviator gameId). Used as a
// BAKED fallback so the very FIRST entry-from-Lobby works before any /game-act has been observed
// (chicken-and-egg: the descriptor is normally learned from the site's own game-act, which only
// fires once Aviator is entered). This is NOT a caller-supplied value and does NOT widen the seam
// into a generic node-clicker: it is the single known Aviator tile, still gated by the SAME
// read-only resolve-before-invoke checks (a node named this that carries a cc.Button, else nothing
// is fired). A genuinely learned game-act gameId always takes priority over this constant.
const KNOWN_AVIATOR_GAME_ID = 'vgmn_221';

function isValidGameId(id) { return typeof id === 'string' && GAME_ID_RE.test(id); }

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
//   1. runs READ-ONLY resolution of the Aviator Cocos node (known path, else a bounded scene
//      search for a node named <gameId> that carries a cc.Button), and
//   2. ONLY if every check passes, fires the node's OWN wired click (the LIVE-PROVEN operation).
// It returns non-secret facts only: { ok, step?, resolve:{ccAvailable, directorAvailable,
// nodeResolved, buttonResolved, resolvedBy}, invoked }. It performs no fetch, sends no WS frame,
// and does no coordinate clicking. The gameId (== node name) + path prefix + depth cap are baked
// literals — callers cannot substitute a node path, name, component, function or coordinates.
function buildEnterAviatorHook(descriptor) {
  // The hook only ever uses the gameId (== node name); the gameActUrl is provenance for LEARNING,
  // not for the click. So the hook requires only a valid gameId — a learned descriptor supplies it,
  // and the baked KNOWN_AVIATOR_GAME_ID fallback supplies it for a first entry. An empty/garbage
  // gameId is still rejected (no arbitrary/unnamed node is ever searched for).
  if (!descriptor || !isValidGameId(descriptor.gameId)) throw new Error('invalid entry gameId');
  const GID = JSON.stringify(descriptor.gameId);
  const PATH = JSON.stringify(COCOS_KNOWN_PATH_PREFIX + descriptor.gameId);
  const MAXD = String(COCOS_MAX_DEPTH | 0);
  return `(() => {
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : this;
    if (!g) return;
    var GID = ${GID}, PATH = ${PATH}, MAXD = ${MAXD};
    g.__avEnterAviator = function () {
      var r = { ccAvailable:false, directorAvailable:false, nodeResolved:false, buttonResolved:false, resolvedBy:null };
      try {
        var cc = g.cc;
        if (!cc || typeof cc.find !== 'function' || !cc.Component || !cc.Component.EventHandler
            || typeof cc.Component.EventHandler.emitEvents !== 'function' || !cc.Button) return { ok:false, step:'no-cc', resolve:r };
        r.ccAvailable = true;
        var dir = cc.director;
        if (!dir || typeof dir.getScene !== 'function') return { ok:false, step:'no-director', resolve:r };
        r.directorAvailable = true;
        var Button = cc.Button;
        var node = null, by = null;
        // Primary: the live-proven known NewLobby scene path (must itself carry a cc.Button).
        try { var p = cc.find(PATH); if (p && typeof p.getComponent === 'function' && p.getComponent(Button)) { node = p; by = 'path'; } } catch (e) {}
        // Fallback: bounded (<= MAXD) live-scene traversal for a node named GID that has a cc.Button.
        if (!node) {
          var sc = null; try { sc = dir.getScene(); } catch (e) { sc = null; }
          var found = null;
          (function w(n, d) {
            if (!n || d > MAXD || found) return;
            var ch = n.children || [];
            for (var i = 0; i < ch.length; i++) {
              var c = ch[i];
              try { if (c && c.name === GID && typeof c.getComponent === 'function' && c.getComponent(Button)) { found = c; return; } } catch (e) {}
              w(c, d + 1);
            }
          })(sc, 0);
          if (found) { node = found; by = 'scene'; }
        }
        if (!node) return { ok:false, step:'node-not-found', resolve:r };
        r.nodeResolved = true; r.resolvedBy = by;
        var btn = node.getComponent(Button);
        if (!btn) return { ok:false, step:'no-button', resolve:r };
        r.buttonResolved = true;
        if (!btn.clickEvents) return { ok:false, step:'no-clickevents', resolve:r };
        // All read-only checks passed — fire the node's OWN wired click (LIVE-PROVEN, both calls).
        cc.Component.EventHandler.emitEvents(btn.clickEvents, node);
        node.emit('click', btn);
        return { ok:true, invoked:true, resolve:r };
      } catch (e) { return { ok:false, step:'invoke-error', resolve:r }; }
    };
  } catch (e) {}
})();`;
}

// Non-secret resolve facts are surfaced to onDiag ONLY (booleans + resolvedBy). The returned page
// value is NOT logged wholesale. Executes through a target's OWN CDP client (the BrowserRun game
// session). Returns { ok:true } | { error:{ code:'ENTRY_SITE_SEAM_UNAVAILABLE'|..., step? } }.
// INVOKED != ENTERED: a successful click does not confirm entry — the caller (gate) confirms only on
// fresh authoritative SERVER Aviator evidence after the attempt boundary.
async function runEnterAviatorViaSite(client, sessionId, descriptor, onDiag) {
  const diag = typeof onDiag === 'function' ? onDiag : () => {};
  if (!client || !client.Runtime || typeof client.Runtime.evaluate !== 'function') {
    return { error: { code: 'ENTER_NO_CLIENT', message: 'Target connection is gone' } };
  }
  // Prefer a genuinely LEARNED game-act descriptor; otherwise fall back to the baked known Aviator
  // gameId so a FIRST entry-from-Lobby works before any /game-act has been observed. The click is
  // still fully gated by the read-only resolve checks below — an absent Aviator node fires nothing.
  const learned = isValidDescriptor(descriptor);
  const gameId = learned ? descriptor.gameId : KNOWN_AVIATOR_GAME_ID;
  const usedFallbackGameId = !learned;
  let hook;
  try { hook = buildEnterAviatorHook({ gameId }); } catch (e) { return { error: { code: 'ENTER_NO_DESCRIPTOR', message: String(e && e.message || e) } }; }
  try { await client.Runtime.evaluate({ expression: hook, includeCommandLineAPI: false }, sessionId); } catch { /* worker/detached — the call below still reports */ }
  const expr = "globalThis.__avEnterAviator ? globalThis.__avEnterAviator() : ({ ok:false, step:'no-hook' })";
  let v;
  try {
    const res = await client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    v = res && res.result && res.result.value;
  } catch (e) {
    return { error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', message: String(e && e.message || e), step: 'evaluate-error' } };
  }
  // Surface ONLY non-secret booleans + resolvedBy (never the returned object wholesale / page state).
  const rf = (v && v.resolve) || {};
  diag({ event: 'COCOS_ENTRY_SEAM_RESOLVE', ccAvailable: !!rf.ccAvailable, directorAvailable: !!rf.directorAvailable, nodeResolved: !!rf.nodeResolved, buttonResolved: !!rf.buttonResolved, resolvedBy: rf.resolvedBy == null ? null : String(rf.resolvedBy), fallbackGameId: usedFallbackGameId });
  if (v && v.ok === true) {
    diag({ event: 'COCOS_ENTRY_INVOKED' });
    return { ok: true };
  }
  return { error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', message: 'Aviator Cocos node did not resolve', step: v && v.step } };
}

module.exports = {
  COCOS_KNOWN_PATH_PREFIX, COCOS_MAX_DEPTH,
  LOBBY_ENVELOPE, ENTER_ENVELOPE, LOBBY_FRAME, ENTER_FRAME,
  GAME_ACT_PATH, GAME_ID_RE, KNOWN_AVIATOR_GAME_ID, isGameActUrl,
  parseGameActDescriptor, isValidDescriptor, isValidGameId, buildEnterAviatorHook, runEnterAviatorViaSite,
};
