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

// The Cocos NewLobby ENTER mechanism is GAME-NEUTRAL and lives in a shared module; Aviator (here)
// and Phỏm both consume it. Neither game owns it.
const { COCOS_KNOWN_PATH_PREFIX, COCOS_MAX_DEPTH, GAME_ID_RE, isValidGameId, buildEnterGameHook, runEnterGameViaSite } = require('./cocos-lobby-entry.cjs');
// Backward-compatible alias: the hook builder is game-neutral now (installs the same page fn).
const buildEnterAviatorHook = buildEnterGameHook;

// Reference-only: the frames the SITE itself emits during entry. We NEVER send these — they are
// kept for recognition/provenance/tests only (the sealed re-entry no longer transmits any frame).
const LOBBY_ENVELOPE = ['6', 'MiniGame', 'lobbyPlugin', { cmd: 10002 }];
const ENTER_ENVELOPE = ['6', 'MiniGame', 'aviatorPlugin', { cmd: 100000 }];
const LOBBY_FRAME = JSON.stringify(LOBBY_ENVELOPE);
const ENTER_FRAME = JSON.stringify(ENTER_ENVELOPE);

// Observed game-act endpoint path suffix; host/version vary per deployment so we retain the full
// learned URL and match by suffix. game_id is a short opaque product token (observed "vgmn_221").
const GAME_ACT_PATH = '/game-act';

// The LIVE-PROVEN Aviator scene-node name for this product/site (== the Aviator gameId). Used as a
// BAKED fallback so the very FIRST entry-from-Lobby works before any /game-act has been observed
// (chicken-and-egg: the descriptor is normally learned from the site's own game-act, which only
// fires once Aviator is entered). This is NOT a caller-supplied value and does NOT widen the seam
// into a generic node-clicker: it is the single known Aviator tile, still gated by the SAME
// read-only resolve-before-invoke checks (a node named this that carries a cc.Button, else nothing
// is fired). A genuinely learned game-act gameId always takes priority over this constant.
const KNOWN_AVIATOR_GAME_ID = 'vgmn_221';

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

// Aviator wrapper: prefer a genuinely LEARNED game-act descriptor; otherwise fall back to the baked
// known Aviator gameId so a FIRST entry-from-Lobby works before any /game-act was observed. Behaviour
// is preserved verbatim — it just delegates to the shared game-agnostic core.
async function runEnterAviatorViaSite(client, sessionId, descriptor, onDiag) {
  const learned = isValidDescriptor(descriptor);
  const gameId = learned ? descriptor.gameId : KNOWN_AVIATOR_GAME_ID;
  return runEnterGameViaSite(client, sessionId, gameId, onDiag, { fallbackGameId: !learned });
}

// ---------------------------------------------------------------------------
// READ-ONLY Cocos scene probe — the OBSERVE sibling of buildEnterAviatorHook.
//
// Root-cause insight (live-confirmed by screenshots): a game-server WebSocket drop makes the game
// show its OWN "Bị mất kết nối tới máy chủ / Đang kết nối lại" banner, reconnect, and land back at
// the NewLobby instead of auto-rejoining Aviator. The round ODD broadcast keeps flowing, so any
// "am I in Aviator?" answer inferred from WS/ODD traffic is WRONG. The authoritative answer is the
// game's OWN Cocos UI state, which we can read directly and passively.
//
// This probe RESOLVES (never invokes) three non-secret facts:
//   - sceneName            cc.director.getScene().name (which scene is live)
//   - lobbyTile{Present,Active}  the Aviator tile node under NewLobby (present + activeInHierarchy
//                          ⇒ the lobby is on screen ⇒ we were kicked out)
//   - reconnectBanner      any ACTIVE cc.Label whose text matches the game's reconnect/disconnect
//                          banner keywords (⇒ the socket dropped and the game is reconnecting)
// It clicks nothing, sends no frame, reads no balance/token/text wholesale (only a keyword test),
// and is bounded (depth + node cap). The gameId (== tile node name) + path prefix + depth are baked.
// ---------------------------------------------------------------------------

// Lowercased banner keywords the game itself renders in a cc.Label when the game socket drops.
const RECONNECT_BANNER_KEYWORDS = ['kết nối lại', 'mất kết nối', 'đang kết nối', 'reconnect', 'connecting', 'disconnected'];

function buildProbeSceneHook(descriptor) {
  const gid = descriptor && isValidGameId(descriptor.gameId) ? descriptor.gameId : KNOWN_AVIATOR_GAME_ID;
  const GID = JSON.stringify(gid);
  const PATH = JSON.stringify(COCOS_KNOWN_PATH_PREFIX + gid);
  const MAXD = String(COCOS_MAX_DEPTH | 0);
  const KW = JSON.stringify(RECONNECT_BANNER_KEYWORDS);
  return `(() => {
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : this;
    if (!g) return;
    var GID = ${GID}, PATH = ${PATH}, MAXD = ${MAXD}, KW = ${KW};
    g.__avProbeScene = function () {
      var r = { ok:false, ccAvailable:false, directorAvailable:false, sceneName:null,
                lobbyTilePresent:false, lobbyTileActive:false, reconnectBanner:false,
                nodesScanned:0, resolvedBy:null };
      try {
        var cc = g.cc;
        if (!cc || typeof cc.find !== 'function') return r;
        r.ccAvailable = true;
        var dir = cc.director;
        if (!dir || typeof dir.getScene !== 'function') return r;
        r.directorAvailable = true;
        var Label = cc.Label || null;
        var sc = null; try { sc = dir.getScene(); } catch (e) { sc = null; }
        try { r.sceneName = (sc && sc.name != null) ? String(sc.name) : null; } catch (e) {}
        // Primary tile resolve: the live-proven known NewLobby path.
        var tile = null, by = null;
        try { var p = cc.find(PATH); if (p) { tile = p; by = 'path'; } } catch (e) {}
        // Bounded traversal: (a) tile-by-name fallback, (b) ACTIVE reconnect-banner Label scan.
        var scanned = 0;
        (function w(n, d) {
          if (!n || d > MAXD || scanned > 6000) return;
          var ch = n.children || [];
          for (var i = 0; i < ch.length; i++) {
            var c = ch[i]; if (!c) continue; scanned++;
            try {
              if (!tile && c.name === GID) { tile = c; by = 'scene'; }
              if (!r.reconnectBanner && Label && typeof c.getComponent === 'function' && c.activeInHierarchy !== false) {
                var lb = c.getComponent(Label);
                if (lb && lb.string) {
                  var t = String(lb.string).toLowerCase();
                  for (var k = 0; k < KW.length; k++) { if (t.indexOf(KW[k]) !== -1) { r.reconnectBanner = true; break; } }
                }
              }
            } catch (e) {}
            w(c, d + 1);
          }
        })(sc, 0);
        r.nodesScanned = scanned;
        if (tile) {
          r.lobbyTilePresent = true; r.resolvedBy = by;
          try { r.lobbyTileActive = (tile.activeInHierarchy === true); } catch (e) { r.lobbyTileActive = false; }
        }
        r.ok = true;
        return r;
      } catch (e) { return r; }
    };
  } catch (e) {}
})();`;
}

// Execute the read-only probe through a target's OWN CDP client/session (same seam as entry).
// Returns { ok:true, facts:{...} } | { error:{ code } }. Never clicks, never sends.
async function runProbeAviatorSceneViaSite(client, sessionId, descriptor, onDiag) {
  const diag = typeof onDiag === 'function' ? onDiag : () => {};
  if (!client || !client.Runtime || typeof client.Runtime.evaluate !== 'function') {
    return { error: { code: 'PROBE_NO_CLIENT' } };
  }
  let hook;
  try { hook = buildProbeSceneHook(descriptor || {}); } catch (e) { return { error: { code: 'PROBE_BUILD_FAILED', message: String(e && e.message || e) } }; }
  try { await client.Runtime.evaluate({ expression: hook, includeCommandLineAPI: false }, sessionId); } catch { /* worker/detached — the call below still reports */ }
  const expr = "globalThis.__avProbeScene ? globalThis.__avProbeScene() : ({ ok:false, step:'no-hook' })";
  let v;
  try {
    const res = await client.Runtime.evaluate({ expression: expr, returnByValue: true }, sessionId);
    v = res && res.result && res.result.value;
  } catch (e) {
    return { error: { code: 'PROBE_EVAL_FAILED', message: String(e && e.message || e) } };
  }
  if (!v) return { error: { code: 'PROBE_NO_RESULT' } };
  const facts = {
    ok: !!v.ok,
    ccAvailable: !!v.ccAvailable,
    directorAvailable: !!v.directorAvailable,
    sceneName: v.sceneName == null ? null : String(v.sceneName),
    lobbyTilePresent: !!v.lobbyTilePresent,
    lobbyTileActive: !!v.lobbyTileActive,
    reconnectBanner: !!v.reconnectBanner,
    nodesScanned: Number(v.nodesScanned) || 0,
    resolvedBy: v.resolvedBy == null ? null : String(v.resolvedBy),
  };
  diag({ event: 'COCOS_SCENE_PROBE', ...facts });
  return { ok: true, facts };
}

module.exports = {
  COCOS_KNOWN_PATH_PREFIX, COCOS_MAX_DEPTH, RECONNECT_BANNER_KEYWORDS,
  LOBBY_ENVELOPE, ENTER_ENVELOPE, LOBBY_FRAME, ENTER_FRAME,
  GAME_ACT_PATH, GAME_ID_RE, KNOWN_AVIATOR_GAME_ID, isGameActUrl,
  parseGameActDescriptor, isValidDescriptor, isValidGameId, buildEnterAviatorHook, runEnterAviatorViaSite, runEnterGameViaSite,
  buildProbeSceneHook, runProbeAviatorSceneViaSite,
};
