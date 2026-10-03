'use strict';

// ---------------------------------------------------------------------------
// ẨN DANH — the tool's on/off switch for the game's own "anonymous table" flag (default OFF).
//
// Ground truth (game JS, Code Cache 2026-10-03): module `GameConfigManager` holds `isAnDanh` (default true;
// the remote config turns it FALSE whenever it carries an `isAnDanh` key — the check is inverted). Every card
// game controller copies it in initDefaultData() into isGameAnDanh / isGameAnDanhCheck, which then
//   - shows the table id as rand(1..7)+roomID+rand(1..7) (or "Chống Vây"),
//   - hides chat, turn/win/money effects, other players' cards,
//   - Phỏm: draws a FAKE 4th player (uid "ddasdsadsadaszzzz12a091") at seat 1.
// So the switch forces GameConfigManager.isAnDanh to the wanted value and keeps forcing it (the config load
// can overwrite it after we set it), and also flips the live table controllers so the current table follows
// without waiting for the next initDefaultData. Pure client display — nothing is sent to the server.
// ---------------------------------------------------------------------------

const MANAGERS = ['GameConfigManager'];

// Self-contained page script: installs window.__phomAnDanh once per document, sets the wanted value, keeps it.
function buildAnDanhScript(on) {
  const want = on ? 'true' : 'false';
  return `(() => { try {
  var g = globalThis, MANAGERS = ${JSON.stringify(MANAGERS)};
  if (!g.__phomAnDanh) {
    var st = g.__phomAnDanh = { want: ${want}, timer: null };
    var managers = function () {
      var out = []; if (typeof g.__require !== 'function') return out;
      for (var i = 0; i < MANAGERS.length; i++) { try { var m = g.__require(MANAGERS[i]); var c = m && (m.default || m); var inst = c && typeof c.getInstance === 'function' ? c.getInstance() : null; if (inst && 'isAnDanh' in inst) out.push(inst); } catch (e) {} }
      return out;
    };
    var controllers = function () {
      var out = [], cc = g.cc, scene = null;
      try { scene = cc && cc.director && cc.director.getScene(); } catch (e) {} if (!scene) return out;
      (function walk(n) { if (!n) return; var cs = n._components || []; for (var i = 0; i < cs.length; i++) { var c = cs[i]; if (c && 'isGameAnDanhCheck' in c) out.push(c); } var ch = n.children || []; for (var j = 0; j < ch.length; j++) walk(ch[j]); })(scene);
      return out;
    };
    st.apply = function (live) {
      var ms = managers(), n = 0;
      for (var i = 0; i < ms.length; i++) if (ms[i].isAnDanh !== st.want) { ms[i].isAnDanh = st.want; n++; }
      // ON only takes effect from the next table (initDefaultData); flipping a live hand INTO anonymous mode
      // would skip changeTurn mid-game. OFF is safe live: the table just stops hiding things.
      var cs = live && !st.want ? controllers() : [];
      for (var k = 0; k < cs.length; k++) {
        var c = cs[k]; c.isGameAnDanh = false; c.isGameAnDanhCheck = false;
        try { if (typeof c.showHideuserAnDanh4 === 'function') c.showHideuserAnDanh4(false); } catch (e) {}
        try { var t = c.cardGameTableController; if (t && typeof t.setGameId === 'function') t.setGameId(true); } catch (e) {}
      }
      return { want: st.want, managers: ms.length, changed: n, controllers: cs.length };
    };
    st.timer = setInterval(function () { try { st.apply(false); } catch (e) {} }, 1000);
  }
  g.__phomAnDanh.want = ${want};
  return g.__phomAnDanh.apply(true);
} catch (e) { return { error: String(e && e.message || e) }; } })()`;
}

// Apply on one run's CDP client: now (current document) + every new document (reload / F5 / VÀO GAME).
// The new-document script is replaced on each call so a reload always gets the CURRENT value.
async function applyAnDanh(client, on) {
  if (!client || !client.Runtime) return { ok: false, error: 'NO_CLIENT' };
  const source = buildAnDanhScript(!!on);
  if (client.Page) {
    try {
      if (client.__phomAnDanhScriptId) { await client.Page.removeScriptToEvaluateOnNewDocument({ identifier: client.__phomAnDanhScriptId }).catch(() => {}); client.__phomAnDanhScriptId = null; }
      const r = await client.Page.addScriptToEvaluateOnNewDocument({ source });
      client.__phomAnDanhScriptId = r && r.identifier ? r.identifier : null;
    } catch { /* the evaluate below still applies to the current document */ }
  }
  try {
    const res = await client.Runtime.evaluate({ expression: source, returnByValue: true });
    return { ok: true, result: (res && res.result && res.result.value) || null };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

module.exports = { buildAnDanhScript, applyAnDanh, MANAGERS };
