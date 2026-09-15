'use strict';

// ---------------------------------------------------------------------------
// Cocos NewLobby ENTER — the GAME-NEUTRAL, live-proven in-engine entry mechanism.
//
// The NewLobby page runs Cocos; each game tile is a real scene node whose NAME equals the
// game's product id (Aviator "vgmn_221", Phỏm "vgcg_8", …). Firing that node's OWN wired
// cc.Button click drives the site's authenticated entry flow (its own game-act + lobby +
// game enter) — we transmit NOTHING ourselves. This module is game-agnostic: the ONLY
// per-game input is the gameId (== the node name). Aviator and Phỏm both consume it; neither
// owns it. No URL/deep-link, no DOM selector, no protocol frame, no coordinates.
//
//     node = cc.find('Canvas/MainUIParent/NewLobby/Main/ScrollView/view/Content/NodeSpines/'+GID)
//            (or a bounded live-scene search for a node named GID that has cc.Button)
//     btn  = node.getComponent(cc.Button)
//     cc.Component.EventHandler.emitEvents(btn.clickEvents, node);   // fire the wired handlers
//     node.emit('click', btn);                                       // + the node's click event
//
// RESOLVE-BEFORE-INVOKE: every attempt first runs READ-ONLY existence checks; if ANY fail it
// returns ENTRY_SITE_SEAM_UNAVAILABLE and invokes NOTHING. INVOKED != ENTERED — the caller
// confirms entry only from fresh authoritative SERVER evidence after the attempt.
// ---------------------------------------------------------------------------

// The live-proven NewLobby scene path to a game tile (the gameId is appended as the leaf name).
const COCOS_KNOWN_PATH_PREFIX = 'Canvas/MainUIParent/NewLobby/Main/ScrollView/view/Content/NodeSpines/';
const COCOS_MAX_DEPTH = 10;
const GAME_ID_RE = /^[A-Za-z0-9_]{1,40}$/;

function isValidGameId(id) { return typeof id === 'string' && GAME_ID_RE.test(id); }

// Build the SEALED, zero-argument page hook. Installs globalThis.__avEnterAviator() (name kept
// stable for existing importers/tests) which resolves the tile node named <gameId> and, ONLY if
// every read-only check passes, fires its OWN wired click. gameId (== node name) + path + depth
// are baked literals — callers cannot substitute a node path/name/component/function/coordinates.
function buildEnterGameHook(descriptor) {
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
        try { var p = cc.find(PATH); if (p && typeof p.getComponent === 'function' && p.getComponent(Button)) { node = p; by = 'path'; } } catch (e) {}
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
        if (!node) { try { console.log('[COCOS-CLICK page] node NOT found for tile', GID, '(scene=', (dir.getScene && dir.getScene() && dir.getScene().name), ')'); } catch(e){} return { ok:false, step:'node-not-found', resolve:r }; }
        r.nodeResolved = true; r.resolvedBy = by;
        var btn = node.getComponent(Button);
        if (!btn) { try { console.log('[COCOS-CLICK page] node found but no cc.Button', GID); } catch(e){} return { ok:false, step:'no-button', resolve:r }; }
        r.buttonResolved = true;
        if (!btn.clickEvents) { try { console.log('[COCOS-CLICK page] button has no clickEvents', GID); } catch(e){} return { ok:false, step:'no-clickevents', resolve:r }; }
        try { console.log('[COCOS-CLICK page] 👉 CLICKING tile', GID, 'resolvedBy=' + by); } catch(e){}
        cc.Component.EventHandler.emitEvents(btn.clickEvents, node);
        node.emit('click', btn);
        try { console.log('[COCOS-CLICK page] ✅ clicked tile', GID); } catch(e){}
        return { ok:true, invoked:true, resolve:r };
      } catch (e) { return { ok:false, step:'invoke-error', resolve:r }; }
    };
  } catch (e) {}
})();`;
}

// A lobby-level modal (the anti-phishing "CẢNH BÁO LỪA ĐẢO" warning, node PopupWarningPhishing) can
// sit ON TOP of the NewLobby and block the game scene transition — so firing the tile enters nothing
// (BUG #3, live-observed). This hook dismisses such KNOWN blocking popups by firing their OWN wired
// close button (same in-engine mechanism as the tile; RESOLVE-BEFORE-INVOKE; fires nothing if the
// popup / its close button is absent or inactive). It changes NOTHING about the tile-entry firing.
// Targets are (popupNodeName, closeButtonNodeName) proven from the live scene graph.
const BLOCKING_POPUPS = [['PopupWarningPhishing', 'btnClose']];
function buildDismissPopupsHook() {
  const TARGETS = JSON.stringify(BLOCKING_POPUPS);
  return `(() => { try {
  var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined') ? self : this; if (!g) return;
  var TARGETS = ${TARGETS};
  g.__phomDismissPopups = function () {
    var out = { ccAvailable:false, dismissed:[] };
    try {
      var cc = g.cc;
      if (!cc || typeof cc.director === 'undefined' || !cc.director || typeof cc.director.getScene !== 'function' || !cc.Button || !cc.Component || !cc.Component.EventHandler || typeof cc.Component.EventHandler.emitEvents !== 'function') return out;
      out.ccAvailable = true;
      var Button = cc.Button, scene = null; try { scene = cc.director.getScene(); } catch (e) {} if (!scene) return out;
      function findActive(root, name) { var res = null; (function w(n){ if(!n||res)return; try{ if((n.name||n._name)===name && n.activeInHierarchy){res=n;return;} }catch(e){} var ch=n.children||[]; for(var i=0;i<ch.length;i++) w(ch[i]); })(root); return res; }
      for (var t=0;t<TARGETS.length;t++){
        var pop = findActive(scene, TARGETS[t][0]); if (!pop) continue;
        // 1) try the popup's OWN close button (clean close), 2) then force-hide the popup node so the
        // NewLobby scene transition is unblocked even if the close is wired via a non-clickEvents path.
        var closeBtn = findActive(pop, TARGETS[t][1]);
        if (closeBtn && typeof closeBtn.getComponent === 'function') { var b = closeBtn.getComponent(Button); if (b && b.clickEvents) { try { cc.Component.EventHandler.emitEvents(b.clickEvents, closeBtn); closeBtn.emit('click', b); } catch (e) {} } }
        try { if (pop.activeInHierarchy) { pop.active = false; } } catch (e) {}
        out.dismissed.push(TARGETS[t][0]);
      }
    } catch (e) {}
    return out;
  };
  } catch (e) {} })();`;
}

// Best-effort: dismiss known blocking lobby popups through the target's own CDP session before entry.
async function runDismissBlockingPopups(client, sessionId, onDiag) {
  const diag = typeof onDiag === 'function' ? onDiag : () => {};
  if (!client || !client.Runtime || typeof client.Runtime.evaluate !== 'function') return { dismissed: [] };
  try { await client.Runtime.evaluate({ expression: buildDismissPopupsHook(), includeCommandLineAPI: false }, sessionId); } catch { /* worker/detached */ }
  try {
    const res = await client.Runtime.evaluate({ expression: "globalThis.__phomDismissPopups ? globalThis.__phomDismissPopups() : ({ dismissed:[] })", awaitPromise: true, returnByValue: true }, sessionId);
    const v = (res && res.result && res.result.value) || { dismissed: [] };
    if (Array.isArray(v.dismissed) && v.dismissed.length) {
      diag({ event: 'COCOS_POPUP_DISMISSED', popups: v.dismissed.slice() });
      // eslint-disable-next-line no-console
      console.log('[COCOS-CLICK] dismissed blocking popup(s):', v.dismissed.join(','));
    }
    return v;
  } catch (e) { return { dismissed: [] }; }
}

// Execute the sealed op through a target's OWN CDP client/session. Returns { ok:true } |
// { error:{ code, step? } }. Surfaces ONLY non-secret resolve booleans + resolvedBy to onDiag.
// `meta.fallbackGameId` is diag-only. INVOKED != ENTERED (caller confirms on server evidence).
async function runEnterGameViaSite(client, sessionId, gameId, onDiag, meta = {}) {
  const diag = typeof onDiag === 'function' ? onDiag : () => {};
  if (!client || !client.Runtime || typeof client.Runtime.evaluate !== 'function') {
    return { error: { code: 'ENTER_NO_CLIENT', message: 'Target connection is gone' } };
  }
  // BUG #3 — clear any blocking lobby popup (e.g. the anti-phishing warning) FIRST, so firing the tile
  // actually transitions into the game. Best-effort + resolve-before-invoke; never blocks entry.
  try { await runDismissBlockingPopups(client, sessionId, diag); } catch { /* best effort */ }
  let hook;
  try { hook = buildEnterGameHook({ gameId }); } catch (e) { return { error: { code: 'ENTER_NO_DESCRIPTOR', message: String(e && e.message || e) } }; }
  try { await client.Runtime.evaluate({ expression: hook, includeCommandLineAPI: false }, sessionId); } catch { /* worker/detached — the call below still reports */ }
  const expr = "globalThis.__avEnterAviator ? globalThis.__avEnterAviator() : ({ ok:false, step:'no-hook' })";
  let v;
  try {
    const res = await client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    v = res && res.result && res.result.value;
  } catch (e) {
    return { error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', message: String(e && e.message || e), step: 'evaluate-error' } };
  }
  const rf = (v && v.resolve) || {};
  diag({ event: 'COCOS_ENTRY_SEAM_RESOLVE', ccAvailable: !!rf.ccAvailable, directorAvailable: !!rf.directorAvailable, nodeResolved: !!rf.nodeResolved, buttonResolved: !!rf.buttonResolved, resolvedBy: rf.resolvedBy == null ? null : String(rf.resolvedBy), fallbackGameId: !!meta.fallbackGameId });
  // eslint-disable-next-line no-console
  console.log(`[COCOS-CLICK] gameId=${gameId} fallback=${!!meta.fallbackGameId} ok=${!!(v && v.ok)} step=${v && v.step || '-'} cc=${!!rf.ccAvailable} dir=${!!rf.directorAvailable} node=${!!rf.nodeResolved} btn=${!!rf.buttonResolved} by=${rf.resolvedBy || '-'}`);
  if (v && v.ok === true) {
    diag({ event: 'COCOS_ENTRY_INVOKED' });
    // eslint-disable-next-line no-console
    console.log(`[COCOS-CLICK] ✅ ĐÃ CLICK vào game (tile ${gameId})`);
    return { ok: true };
  }
  return { error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', message: 'game Cocos node did not resolve', step: v && v.step } };
}

module.exports = {
  COCOS_KNOWN_PATH_PREFIX, COCOS_MAX_DEPTH, GAME_ID_RE, isValidGameId,
  buildEnterGameHook, runEnterGameViaSite,
  BLOCKING_POPUPS, buildDismissPopupsHook, runDismissBlockingPopups,
};
