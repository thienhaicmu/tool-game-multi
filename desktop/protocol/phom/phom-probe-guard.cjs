'use strict';

// TẠO, as the reference tool does it (capture 2026-10-02): the tool asks 313 "a table of this stake?" and the GAME
// CLIENT answers by joining the named table itself — [3,"Simms",<rid>,""] — which seats the account at a stranger's
// table, where the client's own auto-ready readies it and the round starts. The reference tool rewrites exactly that
// frame to the invisible password U+200B, [3,"Simms",<rid>,"​"], so the server refuses it (103 "Sai mật khẩu
// phòng") and the account never sits anywhere it did not choose.
//
// The rewrite is armed for a short window before each 313 (armExpression) and touches nothing else: Dò Key's
// quick-play [3,"Simms",<channel>,"",true] has a 5th element, and every join the tool means is op 8.

const PROBE_PASSWORD = '​';
const ARM_MS = 2500;

// Pure: the frame to send instead, or the same frame. Exported for the tests; the page runs the same rule.
function rewriteOutgoing(data, armedUntil, now) {
  if (typeof data !== 'string' || !(Number(armedUntil) > Number(now))) return data;
  const m = /^\[3,"Simms",(\d+),""\]$/.exec(data);
  return m ? JSON.stringify([3, 'Simms', Number(m[1]), PROBE_PASSWORD]) : data;
}

// Installs the filter once per page (chained after any other) and arms it for `ms`.
function armExpression(ms = ARM_MS) {
  return `(() => { var g = globalThis;
    if (!g.__phomProbeGuard) {
      g.__phomProbeGuard = 1;
      var prev = g.__wsoOutFilter;
      var rewrite = ${rewriteOutgoing.toString()};
      g.__wsoOutFilter = function(d){
        if (typeof prev === 'function') { try { var p = prev(d); if (typeof p === 'string') d = p; } catch(e){} }
        return rewrite(d, g.__phomProbeArm || 0, Date.now());
      };
    }
    g.__phomProbeArm = Date.now() + ${Number(ms) || ARM_MS};
    return true; })()`.replace('PROBE_PASSWORD', JSON.stringify(PROBE_PASSWORD));
}

module.exports = { rewriteOutgoing, armExpression, ARM_MS, PROBE_PASSWORD };
