'use strict';

// NO AUTO-READY (ported from D:\meta-game games/phom/protocol/auto-ready-guard.cjs, 2026-10-10). The game's own
// "Tự sẵn sàng" is the page sending [6,"Simms","channelPlugin",{cmd:363,aRd:"true"}] a few ms after every TABLE_STATE —
// which readies the account at once. The tool decides who readies and when (SẴN SÀNG once CHƯA SS sits; CHƯA SS only
// after a stranger did — table-group-full-table.cjs), and its own 363 "false" after each join is not enough: the
// page's "true" comes right after it (meta-game live 2026-10-10: an account ready 106 ms after sitting, no stranger).
// The accounts used so far had the game's switch off already; VÒNG TỰ ĐÁNH swaps reserves in, so any account must work.
// Installed in every page / worker through the send hook's chained filter (cdp/ws-replay.cjs __wsoOutFilter): the
// page's 363 goes out as "false". The tool never sends "true"; its SẴN SÀNG / BẮT ĐẦU is cmd 5, untouched.

const { ZONE } = require('./phom-frame-classify.cjs');

// Pure: the frame to send instead, or the same frame. Self-contained — its source is injected as text.
function rewriteAutoReady(data, zone) {
  if (typeof data !== 'string' || data.charCodeAt(0) !== 91 || data.indexOf('363') === -1) return data;
  var a;
  try { a = JSON.parse(data); } catch (e) { return data; }
  if (!Array.isArray(a) || a[0] !== 6 || a[1] !== (zone || 'Simms') || a[2] !== 'channelPlugin') return data;
  var p = a[3];
  if (!p || typeof p !== 'object' || p.cmd !== 363 || (p.aRd !== 'true' && p.aRd !== true)) return data;
  var q = {};
  for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) q[k] = p[k];
  q.aRd = 'false';
  var out = a.slice();
  out[3] = q;
  return JSON.stringify(out);
}

// Installs the filter once per page, chained after any filter already there (the TẠO probe guard).
function autoReadyGuardScript(zone = ZONE) {
  return `(() => { try { var g = globalThis;
    if (g.__phomNoAutoReady) return;
    g.__phomNoAutoReady = { zone: ${JSON.stringify(zone)}, rewritten: 0 };
    var prev = g.__wsoOutFilter;
    var rewrite = ${rewriteAutoReady.toString()};
    g.__wsoOutFilter = function (d) {
      if (typeof prev === 'function') { try { var p = prev(d); if (typeof p === 'string') d = p; } catch (e) {} }
      var r = rewrite(d, g.__phomNoAutoReady.zone);
      if (r !== d) g.__phomNoAutoReady.rewritten++;
      return r;
    };
  } catch (e) {} })()`;
}

// Every later document (Page) + the current one (page or worker).
async function applyAutoReadyGuard(client) {
  if (!client || !client.Runtime) return { ok: false, error: 'NO_CLIENT' };
  const source = autoReadyGuardScript();
  if (client.Page && !client.__phomNoAutoReadyScript) {
    try { const r = await client.Page.addScriptToEvaluateOnNewDocument({ source }); client.__phomNoAutoReadyScript = (r && r.identifier) || true; } catch { /* the evaluate below still covers this document */ }
  }
  try { await client.Runtime.evaluate({ expression: source }); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = { rewriteAutoReady, autoReadyGuardScript, applyAutoReadyGuard };
